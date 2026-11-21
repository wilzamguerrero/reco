import { useState } from "react";
import type { AppConfig, ExtMessage, LiveState } from "../../shared/types";
import { Icon } from "../components/Icon";

const LANGS = [
  { id: "es-419", label: "ES" },
  { id: "es-ES", label: "ES-ES" },
  { id: "en-US", label: "EN" },
  { id: "pt-BR", label: "PT" },
  { id: "fr-FR", label: "FR" },
  { id: "auto", label: "Auto" },
];

export function DictadoTab({
  live,
  config,
  updateConfig,
  send,
}: {
  live: LiveState;
  config: AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>;
  send: (msg: ExtMessage) => Promise<unknown>;
}) {
  const [copied, setCopied] = useState(false);
  const d = config.dictation;
  const listening = live.dictationPhase === "listening";

  const copyTranscript = () => {
    if (!live.dictationTranscript) return;
    void navigator.clipboard.writeText(live.dictationTranscript).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="pane pane-scroll">
      <button
        type="button"
        className={`action-primary ${listening ? "action-red" : "action-cyan"}`}
        onClick={() => void send({ type: listening ? "DICTATION_STOP" : "DICTATION_START" })}
      >
        <Icon name={listening ? "stop" : "mic"} size={14} />
        {listening ? "Detener dictado" : "Iniciar dictado en el cursor"}
      </button>

      <div className="pane-row">
        <span className="pane-label">Atajo global</span>
        <span className="pane-value">
          <kbd className="kbd">Alt + Shift + D</kbd>
        </span>
      </div>

      <div className="pane-col">
        <span className="pane-label">Idioma de reconocimiento</span>
        <div className="chips">
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

      <div className="pane-row">
        <span className="pane-label">Limpiar muletillas y puntuación</span>
        <button
          type="button"
          role="switch"
          aria-checked={d.polish}
          className={`switch is-cyan ${d.polish ? "is-on" : ""}`}
          onClick={() => void updateConfig({ dictation: { ...d, polish: !d.polish } })}
        >
          <span />
        </button>
      </div>

      <div className="pane-row">
        <span className="pane-label">Esfera flotante en páginas</span>
        <button
          type="button"
          role="switch"
          aria-checked={d.showFloatingOrb}
          className={`switch is-cyan ${d.showFloatingOrb ? "is-on" : ""}`}
          onClick={() =>
            void updateConfig({ dictation: { ...d, showFloatingOrb: !d.showFloatingOrb } })
          }
        >
          <span />
        </button>
      </div>

      {live.dictationError && <div className="alert-box">{live.dictationError}</div>}

      <div className="transcript-box">
        {live.dictationTranscript || live.dictationInterim ? (
          <p className="transcript-text">
            {live.dictationTranscript}
            {live.dictationInterim && (
              <span className="transcript-interim">
                {live.dictationTranscript ? " " : ""}
                {live.dictationInterim}
              </span>
            )}
          </p>
        ) : (
          <p className="transcript-empty">
            Coloca el cursor en cualquier web (Notion, Gmail, Docs, WhatsApp…) y habla. El dictado
            continúa automáticamente en conversaciones largas hasta que lo detengas.
          </p>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            className="btn-xs"
            onClick={() => void send({ type: "OPEN_PERMISSIONS", afterAction: "dictation" })}
          >
            Permiso micrófono
          </button>
          {live.dictationTranscript && (
            <button type="button" className="btn-xs" onClick={copyTranscript}>
              <Icon name={copied ? "check" : "copy"} size={11} />{" "}
              {copied ? "Copiado" : "Copiar"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
