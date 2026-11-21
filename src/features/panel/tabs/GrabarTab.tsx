/**
 * Pestaña Grabar.
 *
 * Los ajustes de calidad, fotogramas y audio del sistema son los mismos que
 * guarda la configuración: aquí se editan en el núcleo, no en estado local, así
 * que la siguiente grabación —también la que se lanza desde la bandeja— usa lo
 * que se ve en pantalla.
 */

import { Icon } from "../../../components/Icon";
import type { VideoQuality } from "../../../types/ipc";
import type { ConfigState } from "../useConfig";
import type { RecordingControl } from "../useRecording";

const QUALITIES: { id: VideoQuality; label: string }[] = [
  { id: "low", label: "Baja" },
  { id: "medium", label: "Media" },
  { id: "high", label: "Alta" },
];

const FPS: (15 | 30 | 60)[] = [15, 30, 60];

export function GrabarTab({
  recording,
  cfg,
}: {
  recording: RecordingControl;
  cfg: ConfigState;
}) {
  const { phase } = recording;
  const idle = phase === "idle";
  const rec = cfg.config?.recording;
  const quality = rec?.quality ?? "medium";
  const fps = (rec?.fps ?? 30) as 15 | 30 | 60;
  const systemAudio = rec?.system_audio ?? true;

  return (
    <div className="pane">
      <div className="pane-row">
        <Icon name="monitor" size={14} className="pane-icon" />
        <span className="pane-label">Pantalla</span>
        <span className="pane-value">completa</span>
      </div>

      <div className="pane-row">
        <Icon name="sparkle" size={14} className="pane-icon" />
        <span className="pane-label">Calidad</span>
        <div className="chips" role="group" aria-label="Calidad de vídeo">
          {QUALITIES.map((q) => (
            <button
              key={q.id}
              type="button"
              className={`chip ${quality === q.id ? "is-active" : ""}`}
              disabled={!idle}
              onClick={() => {
                if (!cfg.config) return;
                void cfg.patch({
                  recording: { ...cfg.config.recording, quality: q.id },
                });
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-row">
        <Icon name="grid" size={14} className="pane-icon" />
        <span className="pane-label">FPS</span>
        <div className="chips" role="group" aria-label="Fotogramas por segundo">
          {FPS.map((f) => (
            <button
              key={f}
              type="button"
              className={`chip ${fps === f ? "is-active" : ""}`}
              disabled={!idle}
              onClick={() => {
                if (!cfg.config) return;
                void cfg.patch({
                  recording: { ...cfg.config.recording, fps: f },
                });
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-row">
        <Icon name="speaker" size={14} className="pane-icon" />
        <span className="pane-label">Audio del sistema</span>
        <button
          type="button"
          role="switch"
          aria-checked={systemAudio}
          className={`switch ${systemAudio ? "is-on" : ""}`}
          disabled={!idle}
          onClick={() => {
            if (!cfg.config) return;
            void cfg.patch({
              recording: { ...cfg.config.recording, system_audio: !systemAudio },
            });
          }}
        >
          <span />
        </button>
      </div>

      {phase === "recording" && (
        <div className="rec-bar">
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time">{formatDuration(recording.elapsedMs)}</span>
          <span className="rec-hint">en marcha</span>
        </div>
      )}

      <div className="pane-actions">
        {idle ? (
          <button
            type="button"
            className="action action-record"
            onClick={() => recording.start({ fps, quality, systemAudio })}
          >
            <span className="action-dot" aria-hidden="true" />
            Empezar a grabar
          </button>
        ) : (
          <>
            <button
              type="button"
              className="action action-ghost"
              onClick={recording.cancel}
              disabled={phase !== "recording"}
            >
              Descartar
            </button>
            <button
              type="button"
              className="action action-stop"
              onClick={recording.stop}
              disabled={phase !== "recording"}
            >
              <Icon name="stop" size={13} />
              Detener
            </button>
          </>
        )}
      </div>

      {phase === "saving" && <p className="pane-message">Cerrando la grabación…</p>}

      {recording.result && (
        <p className="pane-message">
          Guardado · {formatDuration(recording.result.durationMs)} ·{" "}
          {formatBytes(recording.result.bytes)}
        </p>
      )}

      {recording.error && (
        <p className="pane-message is-alert">
          <Icon name="alert" size={13} />
          <span>{recording.error}</span>
        </p>
      )}
    </div>
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
