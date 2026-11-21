/**
 * Configuración viva del núcleo.
 *
 * Todo lo que se cambia en el panel se guarda al instante: el atajo se
 * re-registra en el núcleo y el modelo se recarga en el siguiente dictado, así
 * que no hay botón de «Guardar» ni estado pendiente que se pueda perder.
 */

import { useCallback, useEffect, useState } from "react";

import { ipc, toMessage } from "../../services/ipc";
import type {
  AppConfig,
  ConfigPatch,
  Diagnostics,
  ModelStatus,
  SecretsStatus,
} from "../../types/ipc";

export interface ConfigState {
  config: AppConfig | null;
  models: ModelStatus[];
  secrets: SecretsStatus | null;
  diagnostics: Diagnostics | null;
  saving: boolean;
  error: string | null;
  patch: (next: ConfigPatch) => Promise<void>;
  refresh: () => void;
  clearError: () => void;
}

export function useConfig(): ConfigState {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([ipc.config.get(), ipc.config.secretsStatus(), ipc.diagnostics.run()])
      .then(([cfg, sec, diag]) => {
        setConfig(cfg);
        setSecrets(sec);
        setDiagnostics(diag);
      })
      .catch((e) => setError(toMessage(e)));

    ipc.dictation.models().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(refresh, [refresh]);

  const patch = useCallback(
    async (next: ConfigPatch) => {
      setError(null);
      setSaving(true);
      try {
        setConfig(await ipc.config.set(next));
      } catch (e) {
        setError(toMessage(e));
        // Se recarga para no mostrar un estado que el núcleo no guardó.
        refresh();
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const clearError = useCallback(() => setError(null), []);

  return { config, models, secrets, diagnostics, saving, error, patch, refresh, clearError };
}
