import { useState } from "react";
import { downloadWindowsNativeActivator } from "../../shared/nativeInstaller";
import type {
  AppConfig,
  DictationNote,
  ExtMessage,
  LiveState,
  SpeechEngineType,
} from "../../shared/types";
import { Icon } from "../components/Icon";

const ENGINES: { id: SpeechEngineType; label: string; tip: string }[] = [
  { id: "chrome", label: "CHROME", tip: "Web Speech en tiempo real (0 MB, requiere internet)" },
  { id: "whisper_tiny", label: "WHISPER S", tip: "Whisper Tiny local (multilingüe ES/EN, ~40 MB, offline)" },
  { id: "whisper_base", label: "WHISPER M", tip: "Whisper Base local (multilingüe ES/EN, ~75 MB, más preciso)" },
  { id: "moonshine_tiny", label: "MOONSHINE", tip: "Moonshine Tiny local (ultra rápido, ~27 MB, optimizado EN)" },
];

const LANGS = [
  { id: "es-419", label: "ES" },
  { id: "es-ES", label: "ES-ES" },
  { id: "en-US", label: "EN" },
  { id: "pt-BR", label: "PT" },
  { id: "fr-FR", label: "FR" },
  { id: "auto", label: "AUTO" },
];

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function DictadoTab({
  live,
  config,
  history,
  shortcut,
  onDeleteNote,
  onClearHistory,
  updateConfig,
  send,
}: {
  live: LiveState;
  config: AppConfig;
  history: DictationNote[];
  shortcut: string;
  onDeleteNote: (id: string) => Promise<void>;
  onClearHistory: () => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>;
  send: (msg: ExtMessage) => Promise<unknown>;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [nativeTesting, setNativeTesting] = useState(false);
  const [nativeStatusMsg, setNativeStatusMsg] = useState<string | null>(null);
  const d = config.dictation;
  const listening = live.dictationPhase === "listening";
  const extId = chrome.runtime.id;

  const copyNote = (id: string, text: string) => {
    const clean = text.trim();
    if (!clean) return;
    void navigator.clipboard.writeText(clean).then(() => {
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 1300);
    });
  };

  const startOrStopDictation = async () => {
    if (listening) {
      await send({ type: "DICTATION_STOP" });
      return;
    }
    try {
      const perm = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      if (perm.state !== "granted") {
        await send({ type: "OPEN_PERMISSIONS", afterAction: "dictation" });
        return;
      }
    } catch {
      // Fallback: let SW/bridge check
    }
    await send({ type: "DICTATION_START" });
  };

  const testNativeHost = () => {
    setNativeTesting(true);
    void chrome.runtime
      .sendMessage({ type: "TEST_NATIVE_HOST" } satisfies ExtMessage)
      .then((res) => {
        const ok = Boolean((res as { connected?: boolean } | undefined)?.connected);
        setNativeStatusMsg(ok ? "Conectado a apps y barra" : "Falta ejecutar el activador");
      })
      .finally(() => setNativeTesting(false));
  };

  const liveActiveId =
    listening && live.dictationStartedAt ? `dic-${live.dictationStartedAt}` : null;
  const hasLivePreview = Boolean(listening && live.dictationInterim.trim());
  const topNoteIsCurrent = Boolean(liveActiveId && history[0]?.id === liveActiveId);

  return (
    <div className="pane pane-scroll">
      <button
        type="button"
        className={`action-primary ${listening ? "action-red" : "action-cyan"}`}
        onClick={() => void startOrStopDictation()}
      >
        <Icon name={listening ? "stop" : "mic"} size={15} />
        <span>{listening ? "Detener" : "Dictar"}</span>
        <kbd className="kbd">{shortcut || "Sin atajo"}</kbd>
      </button>

      <div className="icon-tiles icon-tiles-3">
        <button
          type="button"
          role="switch"
          aria-checked={d.polish}
          title="Limpiar muletillas y puntuación"
          className={`icon-tile ${d.polish ? "is-on" : ""}`}
          onClick={() => void updateConfig({ dictation: { ...d, polish: !d.polish } })}
        >
          <Icon name="spark" size={20} />
          <span>Pulir</span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={d.showFloatingOrb}
          title="Control flotante en páginas"
          className={`icon-tile ${d.showFloatingOrb ? "is-on" : ""}`}
          onClick={() =>
            void updateConfig({ dictation: { ...d, showFloatingOrb: !d.showFloatingOrb } })
          }
        >
          <Icon name="target" size={20} />
          <span>Control</span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={d.desktopTyping}
          title={
            d.desktopTyping
              ? live.nativeHostConnected
                ? "Conectado: escribe en barra de direcciones y apps"
                : "Escribir en barra de direcciones y apps (requiere activador)"
              : "Activar escritura en barra de direcciones y apps"
          }
          className={`icon-tile ${d.desktopTyping ? "is-on" : ""}`}
          onClick={() =>
            void updateConfig({ dictation: { ...d, desktopTyping: !d.desktopTyping } })
          }
        >
          {d.desktopTyping && (
            <span
              className={`tile-dot ${live.nativeHostConnected ? "is-ok" : "is-warn"}`}
              aria-hidden="true"
            />
          )}
          <Icon name="desktop" size={20} />
          <span>Apps</span>
        </button>
      </div>

      {d.desktopTyping && (!live.nativeHostConnected || nativeStatusMsg) && (
        <div className="pane-row" style={{ gap: 6 }}>
          <span
            className="pane-hint"
            style={{
              flex: 1,
              color: live.nativeHostConnected ? "var(--mint)" : "var(--ochre)",
              fontSize: 10.5,
            }}
          >
            {nativeStatusMsg ?? "Activar escritura en Windows:"}
          </span>
          {!live.nativeHostConnected && (
            <button
              type="button"
              className="btn-xs"
              style={{ borderColor: "var(--mint)", color: "var(--mint)" }}
              onClick={() => {
                downloadWindowsNativeActivator(extId);
                setNativeStatusMsg("Abre RECO-Activar-Escritorio.cmd y prueba");
              }}
            >
              <Icon name="download" size={11} /> Activar
            </button>
          )}
          <button
            type="button"
            className="btn-xs"
            disabled={nativeTesting}
            onClick={testNativeHost}
            title="Probar conexión nativa"
          >
            <Icon name="refresh" size={11} />
          </button>
        </div>
      )}

      <div className="pane-row">
        <span className="pane-label">Motor</span>
        <div className="chips">
          {ENGINES.map((eng) => (
            <button
              key={eng.id}
              type="button"
              disabled={listening}
              title={eng.tip}
              className={`chip is-cyan ${d.engine === eng.id ? "is-active" : ""}`}
              onClick={() => void updateConfig({ dictation: { ...d, engine: eng.id } })}
            >
              {eng.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-row">
        <Icon name="globe" size={14} style={{ color: "var(--fg-muted)", flexShrink: 0 }} />
        <div className="chips" style={{ marginLeft: 0, flex: 1, justifyContent: "space-between" }}>
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip is-cyan ${d.language === l.id ? "is-active" : ""}`}
              onClick={() => void updateConfig({ dictation: { ...d, language: l.id } })}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="util-strip">
        <button
          type="button"
          className="util-btn"
          style={{ flex: 1 }}
          title="Configurar atajos en Chrome (Chrome / Global)"
          onClick={() => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}
        >
          <Icon name="bolt" size={13} />
          <span>{shortcut || "Atajo"}</span>
        </button>

        <button
          type="button"
          className="util-btn"
          style={{ flex: 1 }}
          title="Configurar permiso de micrófono"
          onClick={() => void send({ type: "OPEN_PERMISSIONS", afterAction: "dictation" })}
        >
          <Icon name="mic" size={13} />
          <span>Mic</span>
        </button>

        {d.desktopTyping && live.nativeHostConnected && (
          <button
            type="button"
            className="util-btn"
            disabled={nativeTesting}
            title="Probar conexión con apps de escritorio"
            onClick={testNativeHost}
          >
            <Icon name="refresh" size={13} />
          </button>
        )}
      </div>

      {live.dictationError && <div className="alert-box">{live.dictationError}</div>}

      {(history.length > 0 || hasLivePreview) && (
        <div className="history-section">
          <div className="history-head">
            <span className="pane-label">Historial · clic para copiar</span>
            {history.length > 0 && (
              <button
                type="button"
                className="btn-xs"
                onClick={() => void onClearHistory()}
                title="Limpiar historial"
              >
                <Icon name="trash" size={11} />
              </button>
            )}
          </div>

          <div className="history-list">
            {hasLivePreview && !topNoteIsCurrent && (
              <div className="note-card is-live">
                <div className="note-meta">
                  <span className="note-tag is-live">EN VIVO</span>
                </div>
                <p className="transcript-text">
                  <span className="transcript-interim">{live.dictationInterim}</span>
                </p>
              </div>
            )}

            {history.map((note) => {
              const isCurrent = note.id === liveActiveId;
              const isCopied = copiedId === note.id;
              return (
                <div
                  key={note.id}
                  role="button"
                  tabIndex={0}
                  className={`note-card ${isCurrent ? "is-live" : ""} ${isCopied ? "is-copied" : ""}`}
                  title="Clic para copiar al portapapeles"
                  onClick={() => copyNote(note.id, note.text)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      copyNote(note.id, note.text);
                    }
                  }}
                >
                  <div className="note-meta">
                    <span className={`note-tag ${isCopied ? "is-copied" : isCurrent ? "is-live" : ""}`}>
                      {isCopied ? "COPIADO ✓" : isCurrent ? "EN VIVO" : formatClock(note.createdAt)}
                    </span>
                    <button
                      type="button"
                      className="note-del"
                      title="Eliminar nota"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteNote(note.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <p className="transcript-text">
                    {note.text}
                    {isCurrent && live.dictationInterim && (
                      <span className="transcript-interim"> {live.dictationInterim}</span>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
