/**
 * Pestaña Ajustes.
 *
 * Aquí vive todo lo que se configura una vez: atajo, modo, idioma, modelo,
 * muletillas y portapapeles. No se repite nada de lo que ya se ve en Dictado ni
 * en Grabar (el motor y el idioma se muestran allí como lectura, pero solo se
 * cambian aquí).
 */

import { Icon } from "../../../components/Icon";
import type { DictationMode } from "../../../types/ipc";
import { ShortcutPicker } from "./ShortcutPicker";
import { ModelRow } from "./ModelRow";
import type { ConfigState } from "../useConfig";

const MODES: { id: DictationMode; label: string; title: string }[] = [
  { id: "push_to_talk", label: "Mantener", title: "Sueltas la tecla y se inserta el texto" },
  { id: "toggle", label: "Doble", title: "Pulsas dos veces para empezar y dos para terminar" },
];

/** La autodetección va al final: con clips cortos confunde idiomas. */
const LANGUAGES = [
  { id: "es", label: "ES" },
  { id: "en", label: "EN" },
  { id: "pt", label: "PT" },
  { id: "fr", label: "FR" },
  { id: "it", label: "IT" },
  { id: "de", label: "DE" },
  { id: "auto", label: "Auto" },
];

export function AjustesTab({ cfg }: { cfg: ConfigState }) {
  const config = cfg.config;
  if (!config) {
    return (
      <div className="pane pane-center">
        <p className="pane-message">{cfg.error ?? "Cargando…"}</p>
      </div>
    );
  }

  const d = config.dictation;
  const installed = cfg.models.filter((m) => m.installed);
  const missing = !cfg.models.some((m) => m.id === d.modelId && m.installed);

  return (
    <div className="pane pane-scroll">
      <ShortcutPicker
        value={d.shortcut}
        onChange={(shortcut) => void cfg.patch({ dictation: { ...d, shortcut } })}
      />

      <div className="field">
        <span className="field-label">
          <Icon name="keyboard" size={13} /> Modo
        </span>
        <div className="chips" role="group" aria-label="Modo de dictado">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`chip ${d.mode === m.id ? "is-active" : ""}`}
              title={m.title}
              onClick={() => void cfg.patch({ dictation: { ...d, mode: m.id } })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">
          <Icon name="globe" size={13} /> Idioma
        </span>
        <div className="chips" role="group" aria-label="Idioma del dictado">
          {LANGUAGES.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip ${d.language === l.id ? "is-active" : ""}`}
              title={
                l.id === "auto"
                  ? "Detecta el idioma; falla a menudo con frases cortas"
                  : undefined
              }
              onClick={() => void cfg.patch({ dictation: { ...d, language: l.id } })}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">
          <Icon name="cpu" size={13} /> Modelo
        </span>
        <div className="chips" role="group" aria-label="Modelo de transcripción">
          {cfg.models.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`chip ${d.modelId === m.id ? "is-active" : ""} ${
                m.installed ? "" : "is-ghost"
              }`}
              disabled={!m.installed || cfg.saving}
              title={
                m.installed
                  ? `${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB`
                  : `${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB · sin descargar`
              }
              onClick={() => void cfg.patch({ dictation: { ...d, modelId: m.id } })}
            >
              {m.id}
              {m.installed && <span className="chip-ok" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
        {missing && (
          <span className="field-note is-warn">
            El modelo «{d.modelId}» no está descargado: el dictado fallará. Descárgalo
            abajo.
          </span>
        )}
      </div>

      <div className="field">
        <span className="field-label">
          <Icon name="download" size={13} /> Descargas
        </span>
        <div className="models">
          {cfg.models.map((m) => (
            <ModelRow
              key={m.id}
              id={m.id}
              installed={m.installed}
              sizeMb={(m.sizeBytes / 1024 / 1024).toFixed(0)}
              onDone={cfg.refresh}
            />
          ))}
        </div>
      </div>

      <div className="field field-switches">
        <button
          type="button"
          role="switch"
          aria-checked={d.polish}
          className={`toggle ${d.polish ? "is-on" : ""}`}
          onClick={() => void cfg.patch({ dictation: { ...d, polish: !d.polish } })}
        >
          <span />
          <span className="toggle-text">
            <Icon name="sparkle" size={13} /> Corregir muletillas y puntuación
          </span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={d.clipboard_only}
          className={`toggle ${d.clipboard_only ? "is-on" : ""}`}
          onClick={() =>
            void cfg.patch({ dictation: { ...d, clipboard_only: !d.clipboard_only } })
          }
        >
          <span />
          <span className="toggle-text">
            <Icon name="document" size={13} /> Solo portapapeles
          </span>
        </button>

        {/* `launch_at_login` existe en la configuración pero el núcleo todavía no
         * registra la app en el inicio del sistema: no se ofrece hasta que lo
         * haga. Un interruptor que no hace nada es peor que no tenerlo. */}
        <button
          type="button"
          role="switch"
          aria-checked={config.system.close_to_tray}
          className={`toggle ${config.system.close_to_tray ? "is-on" : ""}`}
          onClick={() =>
            void cfg.patch({
              system: {
                ...config.system,
                close_to_tray: !config.system.close_to_tray,
              },
            })
          }
        >
          <span />
          <span className="toggle-text">
            <Icon name="close" size={13} /> Cerrar a la bandeja
          </span>
        </button>
      </div>

      <StatusLine cfg={cfg} installedCount={installed.length} />

      {cfg.error && (
        <button type="button" className="pane-message is-alert" onClick={cfg.clearError}>
          <Icon name="alert" size={13} />
          <span>{cfg.error}</span>
        </button>
      )}
    </div>
  );
}

function StatusLine({ cfg, installedCount }: { cfg: ConfigState; installedCount: number }) {
  const diag = cfg.diagnostics;
  const notionOk = cfg.secrets?.notion_token;

  return (
    <div className="status-line">
      <span className="status-item" title={diag ? `${diag.os} · ${diag.arch}` : undefined}>
        <Icon name="cpu" size={12} /> {installedCount} modelos
      </span>
      <span className={`status-item ${notionOk ? "is-ok" : "is-warn"}`}>
        <Icon name="link" size={12} /> Notion {notionOk ? "listo" : "sin token"}
      </span>
    </div>
  );
}
