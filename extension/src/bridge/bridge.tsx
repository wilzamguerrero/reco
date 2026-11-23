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
import { isPlaybackEcho, speakReply, stopSpeaking } from "../shared/kokoroTts";
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
    let voiceSettings: Awaited<ReturnType<typeof getConfig>>["ai"] | undefined;
    let loudSince = 0;
    let speaking = false;

    const sendAiPhase = (phase: "idle" | "listening" | "thinking" | "speaking", st?: string | null) => {
      void chrome.runtime.sendMessage({
        type: "AI_VOICE_PHASE",
        phase,
        status: st,
      } satisfies ExtMessage);
    };

    function interruptTurn() {
      abortCtrl?.abort();
      abortCtrl = null;
      stopSpeaking();
      speaking = false;
      aiBusy = false;
      loudSince = 0;
      setStatus("Te escucho...");
      sendAiPhase("listening", null);
    }

    async function runAiVoiceTurn(spokenText: string) {
      if (disposed || aiBusy || !spokenText.trim()) return;
      aiBusy = true;
      loudSince = 0;
      setLastLine(spokenText);
      setStatus("Pensando…");
      sendAiPhase("thinking", "RECO pensando…");

      const turn = new AbortController();
      abortCtrl = turn;
      try {
        const initial = await getConfig();
        if (turn.signal.aborted || disposed) return;
        voiceSettings = initial.ai;
        let opening = "";
        let openingAudio: Promise<void> | undefined;
        const readAloud = (text: string, ai: typeof initial.ai) => {
          voiceSettings = ai;
          speaking = true;
          setStatus("Respondiendo por voz...");
          sendAiPhase("speaking", null);
          return speakReply({
            text, mode: ai.ttsMode, voice: ai.ttsVoice, speed: ai.ttsSpeed, pocketWebLanguage: ai.pocketWebLanguage,
            onStatus(s) {
              if (turn.signal.aborted || disposed) return;
              setStatus(s || "Respondiendo por voz...");
              sendAiPhase("speaking", s);
            },
          });
        };
        const res = await runRecoAgentTurn({
          userText: spokenText,
          signal: turn.signal,
          onDelta(text) {
            if (disposed || turn.signal.aborted || opening || voiceSettings?.ttsMode === "off") return;
            const sentence = text.match(/^(.+?[.!?\u2026])\s/u)?.[1];
            if (!sentence || /[`\[\]]/.test(sentence)) return;
            opening = sentence;
            openingAudio = readAloud(opening, voiceSettings ?? initial.ai);
          },
        });
        if (disposed || turn.signal.aborted) return;
        setLastLine(res.text);
        await openingAudio;
        const cfg = await getConfig();
        if (disposed || turn.signal.aborted || cfg.ai.ttsMode === "off") return;
        const rest = opening && res.text.startsWith(opening)
          ? res.text.slice(opening.length).trim() : res.text;
        if (rest) await readAloud(rest, cfg.ai);
      } catch (err) {
        if (abortCtrl === turn) stopSpeaking();
        if (!disposed && !turn.signal.aborted && !(err instanceof DOMException && err.name === "AbortError")) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(msg);
          void chrome.runtime.sendMessage({
            type: "DICTATION_ERROR",
            message: msg,
            fatal: false,
          } satisfies ExtMessage);
        }
      } finally {
        if (abortCtrl === turn && !disposed) {
          abortCtrl = null;
          aiBusy = false;
          speaking = false;
          loudSince = 0;
          setStatus("Te escucho...");
          sendAiPhase("listening", null);
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
            if (disposed) return;
            setRms(level);
            if (aiBusy && level > 0.05) {
              const now = performance.now();
              if (!loudSince) loudSince = now;
              else if (now - loudSince >= 140) interruptTurn();
            } else {
              loudSince = 0;
            }
            if (!aiBusy) {
              void chrome.runtime.sendMessage({ type: "AI_VOICE_LEVEL", rms: level } satisfies ExtMessage);
            }
          },
          onInterim(text: string) {
            if (disposed) return;
            if (aiBusy && text.trim() && text !== "\u2026" && !isPlaybackEcho(text)) interruptTurn();
            if (text.trim() && turnTimer !== null) {
              clearTimeout(turnTimer);
              turnTimer = null;
            }
          },
          onFinal(text: string) {
            if (disposed || !text.trim() || isPlaybackEcho(text)) return;
            if (aiBusy) interruptTurn();
            pendingTranscript = pendingTranscript ? `${pendingTranscript} ${text}` : text;
            if (turnTimer !== null) clearTimeout(turnTimer);
            // Small pause to let user finish multi-clause thought before RECO replies
            turnTimer = window.setTimeout(() => {
              const phrase = pendingTranscript.trim();
              pendingTranscript = "";
              turnTimer = null;
              if (phrase) void runAiVoiceTurn(phrase);
            }, cfg.dictation.engine === "chrome" ? 550 : 250);
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
        abortCtrl?.abort();
        stopSpeaking();
        engine?.stop();
      } else if (msg.type === "CONFIG_UPDATED") {
        if (speaking && voiceSettings && (
          voiceSettings.ttsMode !== msg.config.ai.ttsMode ||
          voiceSettings.ttsVoice !== msg.config.ai.ttsVoice ||
          voiceSettings.pocketWebLanguage !== msg.config.ai.pocketWebLanguage ||
          voiceSettings.ttsSpeed !== msg.config.ai.ttsSpeed
        )) interruptTurn();
        voiceSettings = msg.config.ai;
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
