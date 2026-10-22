/**
 * Sección Ajustes.
 *
 * Fase 0: lectura de configuración, secretos y diagnóstico del sistema.
 * Las demás secciones (dictado, grabación, Notion) se añaden en sus fases.
 */

import { useEffect, useState } from "react";

import { ipc, toMessage } from "../../services/ipc";
import type { AppConfig, Diagnostics, SecretsStatus } from "../../types/ipc";

export function SettingsSection() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      ipc.config.get(),
      ipc.config.secretsStatus(),
      ipc.diagnostics.run(),
    ])
      .then(([cfg, sec, diag]) => {
        if (cancelled) return;
        setConfig(cfg);
        setSecrets(sec);
        setDiagnostics(diag);
      })
      .catch((e) => {
        if (!cancelled) setError(toMessage(e));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="section">
      <header className="section-header">
        <h1>Ajustes</h1>
        <p>Dictado, grabación, Notion y sistema.</p>
      </header>

      {error && (
        <div className="card">
          <h2>No se pudo leer la configuración</h2>
          <p className="muted">{error}</p>
        </div>
      )}

      {config && (
        <div className="card">
          <h2>Dictado</h2>
          <div className="stack">
            <div className="row">
              <span>Atajo global</span>
              <code>{config.dictation.shortcut}</code>
            </div>
            <div className="row">
              <span>Modo</span>
              <span className="muted">
                {config.dictation.mode === "push_to_talk"
                  ? "Mantener pulsado"
                  : "Doble pulsación"}
              </span>
            </div>
            <div className="row">
              <span>Modelo</span>
              <code>{config.dictation.modelId}</code>
            </div>
            <div className="row">
              <span>Idioma</span>
              <span className="muted">{config.dictation.language}</span>
            </div>
          </div>
        </div>
      )}

      {config && (
        <div className="card">
          <h2>Notion</h2>
          <div className="stack">
            <div className="row">
              <span>Ruta</span>
              <span className="muted">
                {config.notion.route === "proxy"
                  ? "Proxy (recomendado)"
                  : "Directa"}
              </span>
            </div>
            <div className="row">
              <span>Token de Notion</span>
              <span className={`badge ${secrets?.notion_token ? "is-ok" : "is-warn"}`}>
                {secrets?.notion_token ? "guardado" : "sin configurar"}
              </span>
            </div>
            <div className="row">
              <span>Token del proxy</span>
              <span className={`badge ${secrets?.proxy_token ? "is-ok" : ""}`}>
                {secrets?.proxy_token ? "guardado" : "no necesario"}
              </span>
            </div>
          </div>
        </div>
      )}

      {diagnostics && (
        <div className="card">
          <h2>Sistema</h2>
          <div className="stack">
            <div className="row">
              <span>
                {diagnostics.os} · {diagnostics.arch}
              </span>
              <span className="muted">v{diagnostics.version}</span>
            </div>
            <ul className="check-list">
              {diagnostics.checks.map((check) => (
                <li className="check-item" key={check.id}>
                  <span>{check.ok ? "✓" : "✕"}</span>
                  <span className="check-detail">
                    <span>
                      {check.id} — {check.detail}
                    </span>
                    {check.hint && <small>{check.hint}</small>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
