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
  updateConfig,
  send,
  onGoNotion,
}: {
  live: LiveState;
  config: AppConfig;
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
      <div className="pane-row">
        <span className="pane-label">Destino Notion</span>
        {hasNotionTarget ? (
          <button
            type="button"
            className="btn-xs"
            style={{ marginLeft: "auto", color: "#a7f3d0", borderColor: "rgba(52,211,153,0.35)" }}
            onClick={onGoNotion}
          >
            {config.notion.targetPageTitle || "Proxy envi"}
          </button>
        ) : (
          <button
            type="button"
            className="btn-xs"
            style={{ marginLeft: "auto", color: "#fcd34d", borderColor: "rgba(245,158,11,0.4)" }}
            onClick={onGoNotion}
          >
            Elegir página →
          </button>
        )}
      </div>

      <div className="pane-row">
        <span className="pane-label">Calidad</span>
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
        <span className="pane-label">Micrófono</span>
        <button
          type="button"
          role="switch"
          disabled={!idle}
          aria-checked={r.includeMic}
          className={`switch ${r.includeMic ? "is-on" : ""}`}
          onClick={() => void updateConfig({ recording: { ...r, includeMic: !r.includeMic } })}
        >
          <span />
        </button>
      </div>

      <div className="pane-row">
        <span className="pane-label">Audio del sistema</span>
        <button
          type="button"
          role="switch"
          disabled={!idle}
          aria-checked={r.systemAudio}
          className={`switch ${r.systemAudio ? "is-on" : ""}`}
          onClick={() => void updateConfig({ recording: { ...r, systemAudio: !r.systemAudio } })}
        >
          <span />
        </button>
      </div>

      <div className="pane-col">
        <span className="pane-label">Modo de subida a Notion</span>
        <div className="chips" style={{ marginLeft: 0 }}>
          <button
            type="button"
            disabled={!idle}
            className={`chip is-red ${r.uploadStrategy === "immediate_single" ? "is-active" : ""}`}
            onClick={() =>
              void updateConfig({ recording: { ...r, uploadStrategy: "immediate_single" } })
            }
          >
            Video único rápido (AIMD)
          </button>
          <button
            type="button"
            disabled={!idle}
            className={`chip is-red ${r.uploadStrategy === "live_chapters" ? "is-active" : ""}`}
            onClick={() =>
              void updateConfig({ recording: { ...r, uploadStrategy: "live_chapters" } })
            }
          >
            En vivo mientras grabas (Loom)
          </button>
        </div>
      </div>

      {(phase === "recording" || paused) && (
        <div className="pane-col" style={{ borderColor: "rgba(255,74,61,0.35)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 650, color: paused ? "#fcd34d" : "#ff8a5c" }}>
              {paused ? "En pausa" : "Grabando pantalla"}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              {formatDuration(live.recordingElapsedMs)} ·{" "}
              {(live.recordingBytes / (1024 * 1024)).toFixed(1)} MB
            </span>
          </div>
          {live.recordingChaptersUploaded > 0 && (
            <span className="pane-hint" style={{ color: "#34d399" }}>
              ✓ {live.recordingChaptersUploaded} capítulo(s) ya subidos a Notion mientras grabas
            </span>
          )}
        </div>
      )}

      {uploading && (
        <div className="pane-col" style={{ borderColor: "rgba(52,211,153,0.4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "#a7f3d0", fontWeight: 600 }}>{live.uploadStep}</span>
            <span>{live.uploadProgress}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${live.uploadProgress}%` }} />
          </div>
        </div>
      )}

      {live.recordingError && <div className="alert-box">{live.recordingError}</div>}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {idle ? (
          <button
            type="button"
            className="action-primary action-red"
            onClick={() => void send({ type: "RECORDING_START" })}
          >
            <Icon name="monitor" size={14} />
            Empezar a grabar (Alt + Shift + R)
          </button>
        ) : uploading ? (
          <button type="button" className="action-primary" disabled>
            Subiendo grabación a Notion…
          </button>
        ) : (
          <>
            <div className="action-row">
              <button
                type="button"
                className="action-primary"
                onClick={() => void send({ type: "RECORDING_PAUSE_TOGGLE" })}
              >
                <Icon name={paused ? "play" : "pause"} size={13} />
                {paused ? "Reanudar" : "Pausar"}
              </button>
              <button
                type="button"
                className="action-primary action-red"
                onClick={() => void send({ type: "RECORDING_STOP" })}
              >
                <Icon name="stop" size={13} />
                Detener y subir
              </button>
            </div>
            <button
              type="button"
              className="btn-xs"
              style={{ alignSelf: "center", color: "var(--fg-muted)" }}
              onClick={() => void send({ type: "RECORDING_DISCARD" })}
            >
              Descartar grabación
            </button>
          </>
        )}
      </div>
    </div>
  );
}
