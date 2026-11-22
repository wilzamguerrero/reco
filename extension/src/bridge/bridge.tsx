/**
 * Bridge de dictado continuo en segundo plano (pestaña fijada discreta).
 *
 * Corre en el origen propio de la extensión (`chrome-extension://<id>/`) para:
 *  - Usar un único permiso de micrófono permanente sin molestar en cada web.
 *  - Mantener el dictado vivo aunque el usuario cambie de pestaña o converse largo rato.
 *  - Enviar nivel RMS en tiempo real y frases finalizadas al Service Worker.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSpeechEngine, type SpeechEngineHandle } from "../shared/speechEngine";
import { getConfig } from "../shared/storage";
import type { ExtMessage } from "../shared/types";
import { createWhisperEngine } from "../shared/whisperEngine";
import { Orb } from "../ui/components/Orb";
import "../ui/styles/global.css";

function BridgeApp() {
  const [status, setStatus] = useState("Iniciando micrófono…");
  const [rms, setRms] = useState(0);
  const [lastLine, setLastLine] = useState("");

  useEffect(() => {
    let engine: SpeechEngineHandle | null = null;
    let disposed = false;

    async function boot() {
      const cfg = await getConfig();
      if (disposed) return;

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
          void chrome.runtime.sendMessage({
            type: "DICTATION_LIVE",
            payload,
          } satisfies ExtMessage);
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
      if (msg.type === "DICTATION_STOP") {
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
        background: "#000",
        color: "#f2ecec",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          padding: 20,
          borderRadius: 14,
          border: "1px solid #232025",
          background: "#0a0a0b",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          textAlign: "center",
        }}
      >
        <Orb size={64} state="dictation" level={rms} />
        <div style={{ fontWeight: 650, letterSpacing: "0.08em", fontSize: 13 }}>
          RECO · DICTADO ACTIVO
        </div>
        <div style={{ fontSize: 12, color: "#968d92" }}>{status}</div>
        {lastLine && (
          <div
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 9,
              background: "#060607",
              border: "1px solid #171416",
              fontSize: 12,
              color: "#a5f3fc",
            }}
          >
            {lastLine}
          </div>
        )}
        <button
          type="button"
          onClick={() =>
            void chrome.runtime.sendMessage({ type: "DICTATION_STOP" } satisfies ExtMessage)
          }
          style={{
            borderColor: "rgba(34,211,238,0.45)",
            background: "rgba(34,211,238,0.14)",
            color: "#a5f3fc",
          }}
        >
          Detener dictado
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<BridgeApp />);
