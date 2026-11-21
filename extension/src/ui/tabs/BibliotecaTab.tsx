import { useState } from "react";
import { deleteOpfsFile, readOpfsFile } from "../../shared/opfs";
import { removeRecording } from "../../shared/storage";
import type { ExtMessage, LiveState, RecordingItem } from "../../shared/types";
import { Icon } from "../components/Icon";

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function BibliotecaTab({
  recordings,
  live,
  send,
  onRemoved,
}: {
  recordings: RecordingItem[];
  live: LiveState;
  send: (msg: ExtMessage) => Promise<unknown>;
  onRemoved: (next: RecordingItem[]) => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function downloadLocal(rec: RecordingItem) {
    if (!rec.opfsFileName) return;
    const file = await readOpfsFile(rec.opfsFileName);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rec.title.replace(/[^\w\- ]+/g, "_")}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function handleDelete(rec: RecordingItem) {
    if (rec.opfsFileName) {
      await deleteOpfsFile(rec.opfsFileName);
    }
    const next = await removeRecording(rec.id);
    onRemoved(next);
  }

  function copyLink(rec: RecordingItem) {
    if (!rec.notionPageUrl) return;
    void navigator.clipboard.writeText(rec.notionPageUrl).then(() => {
      setCopiedId(rec.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  if (recordings.length === 0) {
    return (
      <div
        className="pane"
        style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 20 }}
      >
        <Icon name="grid" size={24} style={{ color: "var(--fg-dim)" }} />
        <div style={{ fontWeight: 600 }}>Sin grabaciones todavía</div>
        <div className="pane-hint">
          Graba tu pantalla y se subirá automáticamente a la página de Notion que hayas elegido.
        </div>
      </div>
    );
  }

  return (
    <div className="pane pane-scroll">
      {recordings.map((rec) => {
        const isUploadingThis = live.uploadActiveId === rec.id;
        const pct = isUploadingThis ? live.uploadProgress : rec.uploadProgress;
        const step = isUploadingThis ? live.uploadStep : rec.uploadStep;

        return (
          <div key={rec.id} className="rec-card">
            <div className="rec-card-head">
              <span className="rec-card-title" title={rec.title}>
                {rec.title}
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color:
                    rec.uploadState === "completed"
                      ? "#34d399"
                      : rec.uploadState === "failed"
                        ? "#ff8a5c"
                        : "#67e8f9",
                }}
              >
                {rec.uploadState === "completed"
                  ? "En Notion"
                  : rec.uploadState === "failed"
                    ? "Falló"
                    : `${pct}%`}
              </span>
            </div>

            <div className="rec-card-meta">
              <span>{formatDuration(rec.durationMs)}</span>
              <span>·</span>
              <span>{(rec.sizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
              {rec.chaptersUploaded ? (
                <>
                  <span>·</span>
                  <span>{rec.chaptersUploaded} cap.</span>
                </>
              ) : null}
            </div>

            {(isUploadingThis || rec.uploadState === "uploading") && (
              <>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="pane-hint">{step}</div>
              </>
            )}

            {rec.error && <div className="alert-box">{rec.error}</div>}

            <div className="rec-card-actions">
              {rec.notionPageUrl && (
                <>
                  <button
                    type="button"
                    className="btn-xs"
                    style={{ borderColor: "rgba(52,211,153,0.4)", color: "#a7f3d0" }}
                    onClick={() => window.open(rec.notionPageUrl, "_blank", "noopener")}
                  >
                    <Icon name="external" size={11} /> Abrir en Notion
                  </button>
                  <button type="button" className="btn-xs" onClick={() => copyLink(rec)}>
                    <Icon name={copiedId === rec.id ? "check" : "copy"} size={11} />{" "}
                    {copiedId === rec.id ? "Copiado" : "Enlace"}
                  </button>
                </>
              )}

              {rec.uploadState === "failed" && rec.opfsFileName && (
                <button
                  type="button"
                  className="btn-xs"
                  style={{ borderColor: "rgba(255,74,61,0.4)", color: "#ffb2aa" }}
                  onClick={() => void send({ type: "RECORDING_RETRY_UPLOAD", recordingId: rec.id })}
                >
                  <Icon name="refresh" size={11} /> Reintentar
                </button>
              )}

              {rec.opfsFileName && (
                <button type="button" className="btn-xs" onClick={() => void downloadLocal(rec)}>
                  <Icon name="download" size={11} /> WebM
                </button>
              )}

              <button
                type="button"
                className="btn-xs"
                style={{ marginLeft: "auto", color: "var(--fg-muted)" }}
                onClick={() => void handleDelete(rec)}
                title="Eliminar de la lista y copia local"
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
