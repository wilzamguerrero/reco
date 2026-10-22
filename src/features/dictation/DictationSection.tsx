/**
 * Sección Dictado.
 *
 * Panel de prueba del atajo y del motor de transcripción. El uso normal es
 * pulsar el atajo global desde cualquier aplicación; este panel sirve para
 * comprobarlo sin salir de RECO.
 */

import { useCallback, useEffect, useState } from "react";

import { ipc, onCoreEvent, toMessage } from "../../services/ipc";
import type { DictationState, ModelStatus } from "../../types/ipc";

const STATE_LABEL: Record<DictationState, string> = {
  idle: "En espera",
  listening: "Escuchando",
  transcribing: "Transcribiendo",
  inserting: "Insertando",
};

export function DictationSection() {
  const [state, setState] = useState<DictationState>("idle");
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<
    Record<string, { percent: number; state: string }>
  >({});

  const refreshModels = useCallback(() => {
    ipc.dictation.models().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    refreshModels();

    const offState = onCoreEvent<{ state: DictationState }>("dictation:state", (p) =>
      setState(p.state),
    );
    const offResult = onCoreEvent<{ text: string }>("dictation:result", (p) =>
      setText(p.text),
    );
    const offError = onCoreEvent<{ scope: string; message: string }>(
      "app:error",
      (p) => {
        if (p.scope === "dictation") setError(p.message);
      },
    );
    const offProgress = onCoreEvent<{
      id: string;
      downloaded: number;
      total: number;
      percent: number;
    }>("models:progress", (p) => {
      setDownloads((prev) => ({
        ...prev,
        [p.id]: { percent: p.percent, state: "downloading" },
      }));
    });
    const offModelState = onCoreEvent<{
      id: string;
      state: string;
      error?: string;
    }>("models:state", (p) => {
      if (p.state === "downloading") {
        setDownloads((prev) => ({
          ...prev,
          [p.id]: { percent: prev[p.id]?.percent ?? 0, state: "downloading" },
        }));
        return;
      }

      setDownloads((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });

      if (p.state === "failed") {
        setError(p.error ?? "La descarga del modelo falló.");
      } else {
        refreshModels();
      }
    });

    return () => {
      void offState.then((fn) => fn());
      void offResult.then((fn) => fn());
      void offError.then((fn) => fn());
      void offProgress.then((fn) => fn());
      void offModelState.then((fn) => fn());
    };
  }, [refreshModels]);

  async function startSession() {
    setError(null);
    setBusy(true);
    try {
      await ipc.dictation.start("push_to_talk");
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopSession() {
    setError(null);
    setBusy(true);
    try {
      const result = await ipc.dictation.stop();
      setText(result.text);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function installModel(id: string) {
    setError(null);
    setDownloads((prev) => ({ ...prev, [id]: { percent: 0, state: "downloading" } }));
    try {
      await ipc.dictation.installModel(id);
    } catch (e) {
      setError(toMessage(e));
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  const installed = models.filter((m) => m.installed);

  return (
    <section className="section">
      <header className="section-header">
        <h1>Dictado</h1>
        <p>Habla y el texto aparece en la aplicación que estés usando.</p>
      </header>

      <div className="card">
        <h2>Estado</h2>
        <div className="row">
          <span className={`badge ${state === "idle" ? "" : "is-ok"}`}>
            {STATE_LABEL[state]}
          </span>
          <div className="row-actions">
            <button type="button" onClick={startSession} disabled={busy || state !== "idle"}>
              Probar
            </button>
            <button
              type="button"
              className="primary"
              onClick={stopSession}
              disabled={busy || state !== "listening"}
            >
              Detener
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Motores disponibles</h2>
        {models.length === 0 && <p className="muted">No se pudo consultar.</p>}
        <ul className="check-list">
          {models.map((model) => {
            const download = downloads[model.id];
            const active = download?.state === "downloading";

            return (
              <li className="check-item" key={model.id}>
                <span>{model.installed ? "✓" : "—"}</span>
                <span className="check-detail">
                  <span>
                    {model.id} · {(model.sizeBytes / 1024 / 1024).toFixed(0)} MB
                  </span>

                  {active ? (
                    <span className="model-progress">
                      <span className="model-bar">
                        <span style={{ width: `${Math.round(download.percent)}%` }} />
                      </span>
                      <small>
                        {Math.round(download.percent)} % · descargando…
                      </small>
                    </span>
                  ) : (
                    <span className="model-row">
                      <small>{model.installed ? "Instalado" : "Sin descargar"}</small>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          model.installed
                            ? void ipc.dictation
                                .removeModel(model.id)
                                .then(refreshModels)
                                .catch((e) => setError(toMessage(e)))
                            : void installModel(model.id)
                        }
                      >
                        {model.installed ? "Borrar" : "Descargar"}
                      </button>
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {installed.length === 0 && (
          <p className="muted">
            Descarga un modelo para activar la transcripción local.
          </p>
        )}
      </div>

      {text && (
        <div className="card">
          <h2>Último dictado</h2>
          <p data-selectable>{text}</p>
        </div>
      )}

      {error && (
        <div className="card error-card">
          <h2>Error</h2>
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}
