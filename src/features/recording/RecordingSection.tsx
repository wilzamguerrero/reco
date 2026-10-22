/**
 * Sección Grabación.
 *
 * Fase 3 en curso: la selección de fuente y los controles ya están conectados al
 * núcleo. La captura real devolverá un error explícito hasta que WGC/WASAPI
 * estén implementados, y la UI lo muestra tal cual en vez de fingir éxito.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ipc, onCoreEvent, toMessage } from "../../services/ipc";
import type { RecordingStopResult, VideoQuality } from "../../types/ipc";

type Phase = "idle" | "recording" | "saving";

export function RecordingSection() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [quality, setQuality] = useState<VideoQuality>("medium");
  const [fps, setFps] = useState<15 | 30 | 60>(30);
  const [systemAudio, setSystemAudio] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RecordingStopResult | null>(null);
  const startedAt = useRef<number | null>(null);

  // El núcleo emite el avance; aquí solo se deriva el reloj local para no
  // depender de la frecuencia de eventos.
  useEffect(() => {
    if (phase !== "recording") return;

    const timer = window.setInterval(() => {
      if (startedAt.current !== null) {
        setElapsed(Date.now() - startedAt.current);
      }
    }, 200);

    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const off = onCoreEvent<{ sessionId: string }>("recording:started", () => {
      startedAt.current = Date.now();
    });
    return () => {
      void off.then((fn) => fn());
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setLastResult(null);

    try {
      await ipc.recording.start({
        target: { kind: "screen", id: "primary" },
        video: { fps, quality },
        systemAudio,
        uploadImmediately: true,
        width: 1920,
        height: 1080,
      });
      startedAt.current = Date.now();
      setElapsed(0);
      setPhase("recording");
    } catch (e) {
      setError(toMessage(e));
      setPhase("idle");
    }
  }, [fps, quality, systemAudio]);

  const stop = useCallback(async () => {
    setPhase("saving");
    try {
      const result = await ipc.recording.stop();
      setLastResult(result);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      startedAt.current = null;
      setPhase("idle");
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await ipc.recording.cancel();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      startedAt.current = null;
      setElapsed(0);
      setPhase("idle");
    }
  }, []);

  return (
    <section className="section">
      <header className="section-header">
        <h1>Grabar</h1>
        <p>Captura de pantalla, micrófono y audio del sistema.</p>
      </header>

      <div className="card">
        <h2>Fuente</h2>

        <div className="stack">
          <div className="row">
            <span>Calidad</span>
            <div className="segmented" role="group" aria-label="Calidad de video">
              {(["low", "medium", "high"] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  className={quality === q ? "is-active" : ""}
                  onClick={() => setQuality(q)}
                  disabled={phase !== "idle"}
                >
                  {q === "low" ? "Baja" : q === "medium" ? "Media" : "Alta"}
                </button>
              ))}
            </div>
          </div>

          <div className="row">
            <span>Fotogramas</span>
            <div className="segmented" role="group" aria-label="Fotogramas por segundo">
              {([15, 30, 60] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={fps === f ? "is-active" : ""}
                  onClick={() => setFps(f)}
                  disabled={phase !== "idle"}
                >
                  {f} fps
                </button>
              ))}
            </div>
          </div>

          <div className="row">
            <label htmlFor="sysaudio">Audio del sistema</label>
            <input
              id="sysaudio"
              type="checkbox"
              checked={systemAudio}
              onChange={(e) => setSystemAudio(e.target.checked)}
              disabled={phase !== "idle"}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Grabación</h2>

        {phase === "idle" && (
          <div className="stack">
            <button type="button" className="primary" onClick={start}>
              Empezar a grabar
            </button>
            <p className="muted">
              La subida a Notion empezará automáticamente al detener.
            </p>
          </div>
        )}

        {phase === "recording" && (
          <div className="stack">
            <div className="recording-status">
              <span className="rec-dot" aria-hidden="true" />
              <span className="rec-time">{formatDuration(elapsed)}</span>
            </div>
            <div className="row">
              <button type="button" onClick={cancel}>
                Descartar
              </button>
              <button type="button" className="primary" onClick={stop}>
                Detener y guardar
              </button>
            </div>
          </div>
        )}

        {phase === "saving" && <p className="muted">Cerrando la grabación…</p>}

        {lastResult && (
          <p className="muted">
            Guardado: {formatDuration(lastResult.durationMs)} ·{" "}
            {formatBytes(lastResult.bytes)} · {lastResult.fragments} fragmentos
          </p>
        )}
      </div>

      {error && (
        <div className="card error-card">
          <h2>No se pudo grabar</h2>
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
