/**
 * Pestaña Dictado.
 *
 * La acción real es el atajo global; aquí hay un botón para probarlo sin salir
 * de RECO y el último texto, que es lo que el usuario quiere revisar. El idioma
 * y el modelo solo se muestran: se cambian en Ajustes y no se duplican.
 */

import { useState } from "react";

import { Icon } from "../../../components/Icon";
import type { ConfigState } from "../useConfig";
import type { DictationControl } from "../useDictation";

const STATE_HINT: Partial<Record<string, string>> = {
  listening: "Habla ahora. Suelta el atajo para terminar.",
  transcribing: "Convirtiendo la voz en texto…",
  inserting: "Pegando el texto en la ventana activa…",
};

export function DictadoTab({
  dictation,
  cfg,
}: {
  dictation: DictationControl;
  cfg: ConfigState;
}) {
  const [copied, setCopied] = useState(false);

  const modelId = cfg.config?.dictation.modelId;
  const model = cfg.models.find((m) => m.id === modelId);
  const missing = !!modelId && !model?.installed;
  const notice = dictation.notice ?? dictation.error;

  const isListening = dictation.state === "listening";
  const isBusy = dictation.state === "transcribing" || dictation.state === "inserting";
  const hint = STATE_HINT[dictation.state];

  const copy = () => {
    if (!dictation.text) return;
    void navigator.clipboard.writeText(dictation.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="pane">
      <div className="pane-row">
        <Icon name="mic" size={14} className="pane-icon" />
        <button
          type="button"
          className={`act ${isListening ? "act-live" : ""}`}
          onClick={() => (isListening ? dictation.cancel() : dictation.start())}
          disabled={dictation.busy || isBusy}
        >
          <Icon name={isListening ? "close" : "play"} size={12} />
          {isListening ? "Cancelar prueba" : "Probar aquí"}
        </button>
        <span className="pane-hint">
          o mantén <b>{cfg.config?.dictation.shortcut ?? "—"}</b> en cualquier app
        </span>
      </div>

      <div className="pane-row">
        <Icon name="cpu" size={14} className="pane-icon" />
        <span className="pane-label">Motor</span>
        <span className={`pane-value ${missing ? "is-warn" : ""}`}>
          {modelId ?? "—"}
          {model && <small> · {(model.sizeBytes / 1024 / 1024).toFixed(0)} MB</small>}
        </span>
        {missing && (
          <span className="pane-note is-warn" title="Descárgalo en Ajustes">
            falta
          </span>
        )}
      </div>

      <div className="pane-row">
        <Icon name="globe" size={14} className="pane-icon" />
        <span className="pane-label">Idioma</span>
        <span className="pane-value">{languageLabel(cfg.config?.dictation.language)}</span>
      </div>

      {hint && !notice && <p className="pane-message">{hint}</p>}

      {notice && (
        <button type="button" className="pane-message is-alert" onClick={dictation.clearNotice}>
          <Icon name="alert" size={13} />
          <span>{notice}</span>
        </button>
      )}

      <div className="pane-output" data-selectable>
        {dictation.text ? (
          <p className="output-text">{dictation.text}</p>
        ) : (
          <p className="output-empty">El último dictado aparecerá aquí.</p>
        )}

        {dictation.text && (
          <button type="button" className="output-copy" onClick={copy} title="Copiar el texto">
            <Icon name={copied ? "check" : "document"} size={12} />
            {copied ? "Copiado" : "Copiar"}
          </button>
        )}
      </div>
    </div>
  );
}

function languageLabel(id: string | undefined): string {
  switch (id) {
    case "es":
      return "Español";
    case "en":
      return "Inglés";
    case "pt":
      return "Portugués";
    case "fr":
      return "Francés";
    case "it":
      return "Italiano";
    case "de":
      return "Alemán";
    case "auto":
      return "Detectar";
    default:
      return id ?? "—";
  }
}
