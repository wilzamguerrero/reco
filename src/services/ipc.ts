/**
 * Wrapper tipado sobre `invoke` y `listen` de Tauri.
 *
 * Centralizar aquí las llamadas permite:
 *  - cambiar nombres de comando en un solo sitio,
 *  - aplicar el mismo manejo de errores,
 *  - mantener la UI sin importar `@tauri-apps/api` directamente.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppConfig,
  ConfigPatch,
  Diagnostics,
  DictationResult,
  InjectionReport,
  ModelStatus,
  RecordingStartResult,
  RecordingStopResult,
  SecretsStatus,
  StartRecordingOptions,
} from "../types/ipc";

type SecretName = "notionToken" | "proxyToken";

/** Comandos del núcleo, agrupados por módulo. */
export const ipc = {
  config: {
    get: () => tauriInvoke<AppConfig>("config_get"),
    set: (patch: ConfigPatch) => tauriInvoke<AppConfig>("config_set", { patch }),
    secretsStatus: () => tauriInvoke<SecretsStatus>("secrets_status"),
    secretsSet: (key: SecretName, value: string) =>
      tauriInvoke<void>("secrets_set", { key, value }),
    secretsClear: (key: SecretName) =>
      tauriInvoke<void>("secrets_clear", { key }),
  },

  diagnostics: {
    run: () => tauriInvoke<Diagnostics>("diagnostics_run"),
  },

  dictation: {
    start: (mode?: "push_to_talk" | "toggle") =>
      tauriInvoke<{ sessionId: string }>("dictation_start", { mode }),
    stop: () => tauriInvoke<DictationResult>("dictation_stop"),
    cancel: () => tauriInvoke<void>("dictation_cancel"),
    inject: (text: string, clipboardOnly?: boolean) =>
      tauriInvoke<InjectionReport>("dictation_inject", { text, clipboardOnly }),
    models: () => tauriInvoke<ModelStatus[]>("models_status"),
    installModel: (id: string) => tauriInvoke<void>("models_install", { id }),
    removeModel: (id: string) => tauriInvoke<void>("models_remove", { id }),
  },

  recording: {
    start: (options: StartRecordingOptions) =>
      tauriInvoke<RecordingStartResult>("recording_start", { options }),
    stop: () => tauriInvoke<RecordingStopResult>("recording_stop"),
    cancel: () => tauriInvoke<void>("recording_cancel"),
  },
} as const;

/** Suscripción tipada a un evento del núcleo. */
export function onCoreEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/** Convierte cualquier error del núcleo en un string legible. */
export function toMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
