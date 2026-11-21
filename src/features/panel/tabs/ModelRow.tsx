/**
 * Fila de descarga de un modelo.
 *
 * Escucha `models:progress` y `models:state` del núcleo: la descarga puede
 * tardar minutos, así que el progreso tiene que vivir en el evento y no en el
 * ciclo de la promesa del comando.
 */

import { useEffect, useState } from "react";

import { Icon } from "../../../components/Icon";
import { ipc, onCoreEvent, toMessage } from "../../../services/ipc";

export function ModelRow({
  id,
  installed,
  sizeMb,
  onDone,
}: {
  id: string;
  installed: boolean;
  sizeMb: string;
  onDone: () => void;
}) {
  const [percent, setPercent] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const offProgress = onCoreEvent<{ id: string; percent: number }>(
      "models:progress",
      (p) => {
        if (p.id === id) setPercent(p.percent);
      },
    );

    const offState = onCoreEvent<{ id: string; state: string; error?: string }>(
      "models:state",
      (p) => {
        if (p.id !== id) return;

        if (p.state === "downloading") {
          setWorking(true);
          setPercent((prev) => prev ?? 0);
          return;
        }

        setWorking(false);
        setPercent(null);

        if (p.state === "failed") {
          setError(p.error ?? "La descarga falló.");
        } else {
          setError(null);
          onDone();
        }
      },
    );

    return () => {
      void offProgress.then((fn) => fn());
      void offState.then((fn) => fn());
    };
  }, [id, onDone]);

  const download = () => {
    setError(null);
    setWorking(true);
    setPercent(0);
    ipc.dictation.installModel(id).catch((e) => {
      setError(toMessage(e));
      setWorking(false);
      setPercent(null);
    });
  };

  const remove = () => {
    setError(null);
    ipc.dictation
      .removeModel(id)
      .then(onDone)
      .catch((e) => setError(toMessage(e)));
  };

  return (
    <div className="model-line">
      <span className={`model-name ${installed ? "is-ok" : ""}`}>{id}</span>

      {working ? (
        <span className="model-progress">
          <span className="model-bar">
            <span style={{ width: `${Math.round(percent ?? 0)}%` }} />
          </span>
          <span className="model-pct">{Math.round(percent ?? 0)} %</span>
        </span>
      ) : (
        <>
          <span className="model-size">{sizeMb} MB</span>
          <button
            type="button"
            className="icon-btn"
            onClick={installed ? remove : download}
            title={installed ? `Borrar ${id}` : `Descargar ${id}`}
          >
            <Icon name={installed ? "close" : "download"} size={12} />
          </button>
        </>
      )}

      {error && <span className="model-error">{error}</span>}
    </div>
  );
}
