/**
 * Bridge en segundo plano de RECO (`chrome-extension://<id>/bridge.html`):
 *  - Modo normal: dictado continuo al cursor (Chrome Speech o Whisper local).
 *  - Modo `?mode=ai`: conversación fluida manos libres con RECO IA (sin abrir ventana
 *    de chat!), con visión automática, ejecución de herramientas de RECO y respuesta
 *    en voz natural (Kokoro / Piper / MOSS / Sistema).
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { runRecoAgentTurn } from "../shared/aiAgent";
import { speakReply, stopSpeaking } from "../shared/kokoroTts";
import { createSpeechEngine, type SpeechEngineHandle } from "../shared/speechEngine";
import { getConfig } from "../shared/storage";
import type { ExtMessage } from "../shared/types";
import { createWhisperEngine } from "../shared/whisperEngine";
import { Orb } from "../ui/components/Orb";
import "../ui/styles/global.css";

const IS_AI_MODE = new URLSearchParams(window.location.search).get("mode") === "ai";

function BridgeApp() {
  const [status, setStatus] = useState(
    IS_AI_MODE ? "Iniciando conversación con RECO IA…" : "Iniciando micrófono…",
  );
  const [rms, setRms] = useState(0);
  const [lastLine, setLastLine] = useState("");

  useEffect(() => {
    let engine: SpeechEngineHandle | null = null;
    let disposed = false;
    let aiBusy = false;
    let pendingTranscript = "";
    let turnTimer: number | null = null;
    let abortCtrl: AbortController | null = null;
    let bargeStop: (() => void) | null = null;

    const sendAiPhase = (phase: "idle" | "listening" | "thinking" | "speaking", st?: string | null) => {
      void chrome.runtime.sendMessage({
        type: "AI_VOICE_PHASE",
        phase,
        status: st,
      } satisfies ExtMessage);
    };

    /**
     * Monitor ligero de interrupción natural (barge-in):
     * Mientras RECO está hablando, escucha el micrófono con cancelación de eco
     * del navegador (`echoCancellation: true`). Si el usuario empieza a hablar
     * (~200ms por encima del umbral), detiene la voz de RECO al instante para
     * escuchar lo nuevo como una conversación natural.
     */
    function startBargeInMonitor(onInterrupt: () => void): () => void {
      let stopped = false;
      let stream: MediaStream | null = null;
      let ctx: AudioContext | null = null;
      let timer: number | null = null;

      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) clearInterval(timer);
        timer = null;
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
        if (ctx) {
          void ctx.close().catch(() => {});
          ctx = null;
        }
      };

      void navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        .then((s) => {
          if (stopped) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = s;
          ctx = new AudioContext();
          const source = ctx.createMediaStreamSource(s);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const data = new Float32Array(analyser.fftSize);
          const startedAt = performance.now();
          let hotFrames = 0;

          timer = window.setInterval(() => {
            if (stopped) return;
            // Grace period so initial TTS audio doesn't false-trigger
            if (performance.now() - startedAt < 400) return;
            analyser.getFloatTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
            const level = Math.sqrt(sum / data.length);
            if (level > 0.058) {
              hotFrames += 1;
              if (hotFrames >= 4) {
                cleanup();
                onInterrupt();
              }
            } else {
              hotFrames = Math.max(0, hotFrames - 1);
            }
          }, 50);
        })
        .catch(() => {
          // If mic cannot be opened concurrently, just skip barge-in silently
        });

      return cleanup;
    }

    async function runAiVoiceTurn(spokenText: string) {
      if (disposed || aiBusy || !spokenText.trim()) return;
      aiBusy = true;
      engine?.stop();
      setLastLine(spokenText);
      setStatus("Pensando…");
      sendAiPhase("thinking", "RECO pensando…");

      abortCtrl = new AbortController();
      let interrupted = false;
      try {
        const cfg = await getConfig();
        const res = await runRecoAgentTurn({
          userText: spokenText,
          signal: abortCtrl.signal,
        });
        if (disposed) return;

        setLastLine(res.text);
        if (res.text && cfg.ai.ttsMode !== "off") {
          setStatus("Respondiendo por voz… (habla para interrumpir)");
          sendAiPhase("speaking", null);

          bargeStop?.();
          bargeStop = startBargeInMonitor(() => {
            interrupted = true;
            stopSpeaking();
            abortCtrl?.abort();
          });

          try {
            await speakReply({
              text: res.text,
              mode: cfg.ai.ttsMode,
              voice: cfg.ai.ttsVoice,
              speed: cfg.ai.ttsSpeed,
              onStatus(s) {
                if (interrupted || disposed) return;
                setStatus(s || "Respondiendo por voz…");
                sendAiPhase("speaking", s);
              },
            });
          } finally {
            bargeStop?.();
            bargeStop = null;
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(msg);
          void chrome.runtime.sendMessage({
            type: "DICTATION_ERROR",
            message: msg,
            fatal: false,
          } satisfies ExtMessage);
        }
      } finally {
        bargeStop?.();
        bargeStop = null;
        aiBusy = false;
        if (!disposed) {
          setStatus(interrupted ? "Te escucho…" : "Escuchando… habla con RECO IA");
          sendAiPhase("listening", null);
          void engine?.start().catch(() => {});
        }
      }
    }

    async function boot() {
      void chrome.runtime.sendMessage({ type: "DICTATION_BRIDGE_READY" } satisfies ExtMessage);
      const cfg = await getConfig();
      if (disposed) return;

      if (IS_AI_MODE) {
        const aiCallbacks = {
          language: cfg.dictation.language,
          polish: cfg.dictation.polish,
          autoCapitalize: true,
          onReady() {
            setStatus("Escuchando… habla con RECO IA");
            sendAiPhase("listening", null);
          },
          onLevel(level: number) {
            setRms(level);
            if (!aiBusy) {
              void chrome.runtime.sendMessage({ type: "AI_VOICE_LEVEL", rms: level } satisfies ExtMessage);
            }
          },
          onInterim(text: string) {
            if (text.trim() && turnTimer !== null) {
              clearTimeout(turnTimer);
              turnTimer = null;
            }
          },
          onFinal(text: string) {
            if (aiBusy || !text.trim()) return;
            pendingTranscript = pendingTranscript ? `${pendingTranscript} ${text}` : text;
            if (turnTimer !== null) clearTimeout(turnTimer);
            // Small pause to let user finish multi-clause thought before RECO replies
            turnTimer = window.setTimeout(() => {
              const phrase = pendingTranscript.trim();
              pendingTranscript = "";
              turnTimer = null;
              if (phrase) void runAiVoiceTurn(phrase);
            }, cfg.dictation.engine === "chrome" ? 850 : 250);
          },
          onError(message: string, fatal: boolean) {
            setStatus(message);
            void chrome.runtime.sendMessage({
              type: "DICTATION_ERROR",
              message,
              fatal,
            } satisfies ExtMessage);
          },
        };

        engine =
          cfg.dictation.engine === "chrome"
            ? createSpeechEngine(aiCallbacks)
            : createWhisperEngine({
                ...aiCallbacks,
                model: cfg.dictation.engine,
                onStatus(s) {
                  setStatus(s);
                  sendAiPhase("thinking", s || null);
                },
              });

        try {
          await engine.start();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(msg);
          void chrome.runtime.sendMessage({
            type: "DICTATION_ERROR",
            message: msg,
            fatal: true,
          } satisfies ExtMessage);
          void chrome.runtime.sendMessage({ type: "AI_VOICE_STOP" } satisfies ExtMessage);
        }
        return;
      }

      // Normal cursor dictation mode
      const engineCallbacks = {
        language: cfg.dictation.language,
        polish: cfg.dictation.polish,
        autoCapitalize: cfg.dictation.autoCapitalize,
        onReady() {
          setStatus(
            cfg.dictation.engine === "chrome"
              ? "Escuchando (Chrome) · Coloca el cursor donde quieras escribir"
              : "Escuchando (Whisper local) · Habla y haz micro-pausas",
          );
          void chrome.runtime.sendMessage({ type: "DICTATION_STATUS", status: null } satisfies ExtMessage);
          void chrome.runtime.sendMessage({ type: "DICTATION_BRIDGE_READY" } satisfies ExtMessage);
        },
        onLevel(level: number) {
          setRms(level);
          void chrome.runtime.sendMessage({ type: "DICTATION_LEVEL", rms: level } satisfies ExtMessage);
        },
        onInterim(text: string) {
          void chrome.runtime.sendMessage({ type: "DICTATION_INTERIM", text } satisfies ExtMessage);
        },
        onLive(payload: Parameters<NonNullable<Parameters<typeof createSpeechEngine>[0]["onLive"]>>[0]) {
          void chrome.runtime.sendMessage({ type: "DICTATION_LIVE", payload } satisfies ExtMessage);
        },
        onFinal(text: string) {
          setLastLine(text);
          void chrome.runtime.sendMessage({ type: "DICTATION_FINAL", text } satisfies ExtMessage);
        },
        onError(message: string, fatal: boolean) {
          setStatus(message);
          void chrome.runtime.sendMessage({
            type: "DICTATION_ERROR",
            message,
            fatal,
          } satisfies ExtMessage);
        },
        onStop() {
          void chrome.runtime.sendMessage({ type: "DICTATION_ENDED" } satisfies ExtMessage);
        },
      };

      engine =
        cfg.dictation.engine === "chrome"
          ? createSpeechEngine(engineCallbacks)
          : createWhisperEngine({
              ...engineCallbacks,
              model: cfg.dictation.engine,
              onStatus(s) {
                setStatus(s);
                void chrome.runtime.sendMessage({
                  type: "DICTATION_STATUS",
                  status: s || null,
                } satisfies ExtMessage);
              },
            });

      try {
        await engine.start();
        setStatus("Conectando reconocimiento de voz…");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(msg);
        void chrome.runtime.sendMessage({
          type: "DICTATION_ERROR",
          message: msg,
          fatal: true,
        } satisfies ExtMessage);
      }
    }

    const listener = (msg: ExtMessage) => {
      if (msg.type === "DICTATION_STOP" && !IS_AI_MODE) {
        engine?.stop();
      } else if (msg.type === "AI_VOICE_STOP" && IS_AI_MODE) {
        disposed = true;
        if (turnTimer !== null) clearTimeout(turnTimer);
        bargeStop?.();
        bargeStop = null;
        abortCtrl?.abort();
        stopSpeaking();
        engine?.stop();
      } else if (msg.type === "CONFIG_UPDATED") {
        engine?.updateOptions({
          language: msg.config.dictation.language,
          polish: msg.config.dictation.polish,
          autoCapitalize: msg.config.dictation.autoCapitalize,
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    void boot();

    return () => {
      disposed = true;
      if (turnTimer !== null) clearTimeout(turnTimer);
      bargeStop?.();
      bargeStop = null;
      abortCtrl?.abort();
      stopSpeaking();
      chrome.runtime.onMessage.removeListener(listener);
      engine?.stop();
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#08080a",
        color: "#eae5d9",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          padding: 20,
          borderRadius: 4,
          border: "1.5px solid #2a2a32",
          background: "#111114",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          textAlign: "center",
        }}
      >
        <Orb size={56} state={IS_AI_MODE ? "ai_listening" : "dictation"} level={rms} />
        <div style={{ fontWeight: 800, letterSpacing: "0.1em", fontSize: 12, fontFamily: "var(--mono)" }}>
          {IS_AI_MODE ? "RECO · VOZ IA ACTIVA" : "RECO · DICTADO ACTIVO"}
        </div>
        <div style={{ fontSize: 12, color: "#9a958d" }}>{status}</div>
        {lastLine && (
          <div
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 3,
              background: "#050507",
              border: "1.5px solid #1d1d23",
              fontSize: 11.5,
            }}
          >
            {lastLine}
          </div>
        )}
        <button
          type="button"
          onClick={() =>
            void chrome.runtime.sendMessage({
              type: IS_AI_MODE ? "AI_VOICE_STOP" : "DICTATION_STOP",
            } satisfies ExtMessage)
          }
        >
          Detener
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<BridgeApp />);
