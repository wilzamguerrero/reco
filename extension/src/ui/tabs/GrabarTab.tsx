import type { AppConfig, ExtMessage, LiveState, VideoQuality } from "../../shared/types";
import { Icon } from "../components/Icon";

const QUALITIES: { id: VideoQuality; label: string }[] = [
  { id: "low", label: "720p" },
  { id: "medium", label: "1080p" },
  { id: "high", label: "1440p" },
];

const FPS: (15 | 30 | 60)[] = [15, 30, 60];

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function GrabarTab({
  live,
  config,
  shortcut,
  updateConfig,
  send,
  onGoNotion,
}: {
  live: LiveState;
  config: AppConfig;
  shortcut: string;
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>;
  send: (msg: ExtMessage) => Promise<unknown>;
  onGoNotion: () => void;
}) {
  const r = config.recording;
  const phase = live.recordingPhase;
  const idle = phase === "idle";
  const paused = phase === "paused";
  const uploading = phase === "uploading";

  const hasNotionTarget = Boolean(
    (config.notion.token && config.notion.targetPageId) ||
      (config.notion.authMode === "envi_proxy" && config.notion.enviProxyUrl),
  );

  return (
    <div className="pane pane-scroll">
      {idle ? (
        <button
          type="button"
          className="action-primary action-red"
          onClick={() => void send({ type: "RECORDING_START" })}
        >
          <Icon name="monitor" size={15} />
          <span>Grabar</span>
          <kbd className="kbd">{shortcut || "Sin atajo"}</kbd>
        </button>
      ) : uploading ? (
        <button type="button" className="action-primary" disabled>
          <span>Subiendo · {live.uploadProgress}%</span>
        </button>
      ) : (
        <div className="action-row">
          <button
            type="button"
            className="action-primary"
            onClick={() => void send({ type: "RECORDING_PAUSE_TOGGLE" })}
          >
            <Icon name={paused ? "play" : "pause"} size={14} />
            <span>{paused ? "Seguir" : "Pausa"}</span>
          </button>
          <button
            type="button"
            className="action-primary action-red"
            onClick={() => void send({ type: "RECORDING_STOP" })}
          >
            <Icon name="stop" size={14} />
            <span>Detener</span>
          </button>
        </div>
      )}

      {(phase === "recording" || paused) && (
        <div className="pane-row" style={{ borderColor: "var(--accent)" }}>
          <span style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11.5, color: paused ? "var(--ochre)" : "var(--accent)" }}>
            {formatDuration(live.recordingElapsedMs)} · {(live.recordingBytes / (1024 * 1024)).toFixed(1)} MB
          </span>
          <button
            type="button"
            className="btn-xs"
            style={{ marginLeft: "auto" }}
            title="Descartar grabación"
            onClick={() => void send({ type: "RECORDING_DISCARD" })}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      )}

      {uploading && (
        <div className="pane-col" style={{ borderColor: "var(--violet)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "var(--mono)" }}>
            <span>{live.uploadStep}</span>
            <span>{live.uploadProgress}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${live.uploadProgress}%` }} />
          </div>
        </div>
      )}

      <div className="icon-tiles icon-tiles-2">
        <button
          type="button"
          role="switch"
          disabled={!idle}
          aria-checked={r.includeMic}
          title="Incluir micrófono"
          className={`icon-tile is-red ${r.includeMic ? "is-on" : ""}`}
          onClick={() => void updateConfig({ recording: { ...r, includeMic: !r.includeMic } })}
        >
          <Icon name="mic" size={19} />
          <span>Mic</span>
        </button>

        <button
          type="button"
          role="switch"
          disabled={!idle}
          aria-checked={r.systemAudio}
          title="Audio del sistema"
          className={`icon-tile is-red ${r.systemAudio ? "is-on" : ""}`}
          onClick={() => void updateConfig({ recording: { ...r, systemAudio: !r.systemAudio } })}
        >
          <Icon name="audio" size={19} />
          <span>Audio</span>
        </button>
      </div>

      <div className="pane-row">
        <span className="pane-label">Res</span>
        <div className="chips">
          {QUALITIES.map((q) => (
            <button
              key={q.id}
              type="button"
              disabled={!idle}
              className={`chip is-red ${r.quality === q.id ? "is-active" : ""}`}
              onClick={() => void updateConfig({ recording: { ...r, quality: q.id } })}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-row">
        <span className="pane-label">FPS</span>
        <div className="chips">
          {FPS.map((f) => (
            <button
              key={f}
              type="button"
              disabled={!idle}
              className={`chip is-red ${r.fps === f ? "is-active" : ""}`}
              onClick={() => void updateConfig({ recording: { ...r, fps: f } })}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-row">
        <span className="pane-label">Subida</span>
        <div className="chips">
          <button
            type="button"
            disabled={!idle}
            className={`chip is-red ${r.uploadStrategy === "immediate_single" ? "is-active" : ""}`}
            title="Video único rápido (AIMD)"
            onClick={() =>
              void updateConfig({ recording: { ...r, uploadStrategy: "immediate_single" } })
            }
          >
            AIMD
          </button>
          <button
            type="button"
            disabled={!idle}
            className={`chip is-red ${r.uploadStrategy === "live_chapters" ? "is-active" : ""}`}
            title="En vivo mientras grabas (Loom)"
            onClick={() =>
              void updateConfig({ recording: { ...r, uploadStrategy: "live_chapters" } })
            }
          >
            LIVE
          </button>
        </div>
      </div>

      <div className="pane-row">
        <Icon name="notion" size={14} style={{ color: "var(--fg-muted)" }} />
        <button
          type="button"
          className="btn-xs"
          style={{
            marginLeft: "auto",
            color: hasNotionTarget ? "var(--mint)" : "var(--ochre)",
            borderColor: hasNotionTarget ? "var(--mint)" : "var(--ochre)",
          }}
          onClick={onGoNotion}
        >
          {hasNotionTarget
            ? config.notion.targetPageTitle || "Proxy envi"
            : "Elegir página →"}
        </button>
      </div>

      {live.recordingError && <div className="alert-box">{live.recordingError}</div>}
    </div>
  );
}
