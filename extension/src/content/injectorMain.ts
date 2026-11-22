/**
 * Injector Script de RECO (`all_frames: true`).
 *
 * NO contiene ningún elemento visual ni crea paneles/esferas.
 * Escucha `INJECT_LIVE` e `INJECT_TEXT` para ir escribiendo en tiempo real
 * exactamente donde el usuario tenga colocado el cursor.
 */

import type { ExtMessage } from "../shared/types";
import {
  applyLiveSpeech,
  hasActiveOrSavedCursor,
  initCursorTracker,
  injectTextAtCursor,
} from "./textInjector";

const GUARD_KEY = "__recoInjectorLoaded_v1";
const win = window as unknown as Record<string, unknown>;

if (!win[GUARD_KEY]) {
  win[GUARD_KEY] = true;
  initCursorTracker();

  // Respaldo directo de atajos dentro de cualquier página/iframe
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const code = e.code;
      if (code === "KeyD") {
        e.preventDefault();
        e.stopPropagation();
        void chrome.runtime.sendMessage({ type: "DICTATION_TOGGLE" } satisfies ExtMessage);
      } else if (code === "KeyR") {
        e.preventDefault();
        e.stopPropagation();
        void chrome.runtime.sendMessage({ type: "RECORDING_TOGGLE" } satisfies ExtMessage);
      } else if (code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        void chrome.runtime.sendMessage({ type: "RECORDING_PAUSE_TOGGLE" } satisfies ExtMessage);
      }
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
    if (msg.type === "INJECT_LIVE") {
      if (!hasActiveOrSavedCursor()) return;
      void applyLiveSpeech(msg.payload, msg.smartSpacing).then((res) => {
        if (res.inserted) {
          void chrome.runtime
            .sendMessage({ type: "INJECTION_FEEDBACK", ok: res.ok } satisfies ExtMessage)
            .catch(() => {});
        }
        sendResponse(res);
      });
      return true;
    }

    if (msg.type === "INJECT_TEXT") {
      if (!hasActiveOrSavedCursor()) return;
      void injectTextAtCursor(msg.text, msg.smartSpacing).then((res) => {
        void chrome.runtime
          .sendMessage({ type: "INJECTION_FEEDBACK", ok: res.ok } satisfies ExtMessage)
          .catch(() => {});
        sendResponse(res);
      });
      return true;
    }
  });
}
