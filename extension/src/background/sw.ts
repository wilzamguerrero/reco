/**
 * Service Worker de RECO (MV3).
 *
 * Coordina:
 * - Estado global de Dictado (Cian) y Grabación/Subida a Notion (Rojo / Verde).
 * - Atajos globales (`Alt+Shift+D`, `Alt+Shift+R`, `Alt+Shift+P`).
 * - Menú contextual del navegador ("Dictar aquí", "Grabar pantalla hacia Notion").
 * - Ciclo de vida del `offscreen.html` para grabación y del `bridge.html` para
 *   dictado continuo sin perder el foco en el cursor del usuario.
 */

import { getConfig, upsertRecording } from "../shared/storage";
import type { ExtMessage, LiveState, RecordingItem } from "../shared/types";

const OFFSCREEN_URL = "offscreen.html";
const BRIDGE_URL = chrome.runtime.getURL("bridge.html");
const PERMISSIONS_URL = chrome.runtime.getURL("permissions.html");

let state: LiveState = {
  dictationPhase: "idle",
  dictationStartedAt: null,
  dictationInterim: "",
  dictationTranscript: "",
  dictationError: null,
  dictationLevel: 0,
  dictationHostTabId: null,

  recordingPhase: "idle",
  recordingId: null,
  recordingStartedAt: null,
  recordingElapsedMs: 0,
  recordingLevel: 0,
  recordingBytes: 0,
  recordingChaptersUploaded: 0,
  recordingError: null,

  uploadActiveId: null,
  uploadProgress: 0,
  uploadStep: "",
  lastNotionUrl: null,
};

let bridgeTabId: number | null = null;
let lastTargetTabId: number | null = null;
let offscreenCreating: Promise<void> | null = null;

function updateActionBadge() {
  if (state.recordingPhase === "recording") {
    void chrome.action.setBadgeText({ text: "REC" });
    void chrome.action.setBadgeBackgroundColor({ color: "#ff4a3d" });
  } else if (state.recordingPhase === "paused") {
    void chrome.action.setBadgeText({ text: "PAU" });
    void chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  } else if (state.recordingPhase === "uploading" || state.uploadActiveId) {
    void chrome.action.setBadgeText({ text: "UP" });
    void chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  } else if (state.dictationPhase === "listening") {
    void chrome.action.setBadgeText({ text: "VOZ" });
    void chrome.action.setBadgeBackgroundColor({ color: "#06b6d4" });
  } else {
    void chrome.action.setBadgeText({ text: "" });
  }
}

async function broadcastState() {
  updateActionBadge();
  // Broadcast a páginas internas de la extensión (popup, sidepanel)
  void chrome.runtime.sendMessage({ type: "STATE_SYNC", state } satisfies ExtMessage).catch(() => {});

  // Broadcast a la pestaña activa y a las pestañas visibles
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      continue;
    }
    if (tab.active) {
      void chrome.tabs
        .sendMessage(tab.id, { type: "STATE_SYNC", state } satisfies ExtMessage)
        .catch(() => {});
    }
  }
}

async function getActiveWebTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab?.id && tab.url && !tab.url.startsWith("chrome-extension://")) {
    return tab;
  }
  if (lastTargetTabId !== null) {
    const fallback = await chrome.tabs.get(lastTargetTabId).catch(() => null);
    if (fallback?.id) return fallback;
  }
  return null;
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime
    .getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    })
    .catch(() => []);

  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        chrome.offscreen.Reason.DISPLAY_MEDIA,
      ],
      justification: "Grabar pantalla/audio y subir video en segundo plano a Notion.",
    })
    .finally(() => {
      offscreenCreating = null;
    });

  await offscreenCreating;
}

async function openPermissionsTab(afterAction?: "dictation" | "recording") {
  const url = afterAction ? `${PERMISSIONS_URL}?after=${afterAction}` : PERMISSIONS_URL;
  await chrome.tabs.create({ url, active: true });
}

/* ------------------------------------------------------------------ DICTADO */

async function startDictation(explicitTabId?: number) {
  if (state.dictationPhase === "listening") return;

  const activeTab = explicitTabId
    ? await chrome.tabs.get(explicitTabId).catch(() => null)
    : await getActiveWebTab();
  if (activeTab?.id) {
    lastTargetTabId = activeTab.id;
  }

  state = {
    ...state,
    dictationPhase: "listening",
    dictationStartedAt: Date.now(),
    dictationInterim: "",
    dictationError: null,
    dictationLevel: 0,
  };
  await broadcastState();

  // Cerrar bridge previo si quedó colgado
  if (bridgeTabId !== null) {
    await chrome.tabs.remove(bridgeTabId).catch(() => {});
    bridgeTabId = null;
  }

  // Abrimos `bridge.html` como pestaña fijada en segundo plano (`active: false`)
  // para que el cursor del usuario en su editor NO pierda el foco.
  const tab = await chrome.tabs.create({
    url: BRIDGE_URL,
    pinned: true,
    active: false,
  });
  bridgeTabId = tab.id ?? null;
  state.dictationHostTabId = bridgeTabId;
}

async function stopDictation() {
  if (state.dictationPhase === "idle" && bridgeTabId === null) return;
  void chrome.runtime.sendMessage({ type: "DICTATION_STOP" } satisfies ExtMessage).catch(() => {});

  const tabToClose = bridgeTabId;
  bridgeTabId = null;
  state = {
    ...state,
    dictationPhase: "idle",
    dictationStartedAt: null,
    dictationInterim: "",
    dictationLevel: 0,
    dictationHostTabId: null,
  };
  await broadcastState();

  if (tabToClose !== null) {
    setTimeout(() => {
      void chrome.tabs.remove(tabToClose).catch(() => {});
    }, 350);
  }
}

/* ---------------------------------------------------------------- GRABACIÓN */

async function startRecording() {
  if (state.recordingPhase !== "idle") return;
  const config = await getConfig();
  const targetTab = await getActiveWebTab();

  // `desktopCapture.chooseDesktopMedia` necesita una pestaña válida; si el usuario
  // está en chrome://, abrimos una ventana/pestaña de contexto o pasamos la actual.
  const sources: Parameters<typeof chrome.desktopCapture.chooseDesktopMedia>[0] = [
    "screen",
    "window",
    "tab",
    "audio",
  ];

  const handlePicked = async (
    streamId: string,
    options?: { canRequestAudioTrack?: boolean },
  ) => {
    if (!streamId) return;
    await ensureOffscreenDocument();

    const recordingId = `rec_${Date.now()}`;
    const nowLabel = new Date().toLocaleString("es-ES", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    state = {
      ...state,
      recordingPhase: "recording",
      recordingId,
      recordingStartedAt: Date.now(),
      recordingElapsedMs: 0,
      recordingLevel: 0,
      recordingBytes: 0,
      recordingChaptersUploaded: 0,
      recordingError: null,
    };
    await broadcastState();

    void chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_RECORDING",
      recordingId,
      streamId,
      canRequestAudio: Boolean(options?.canRequestAudioTrack),
      config,
      title: `Grabación ${nowLabel}`,
    } satisfies ExtMessage);
  };

  if (targetTab?.id) {
    chrome.desktopCapture.chooseDesktopMedia(sources, targetTab, (streamId, options) => {
      void handlePicked(streamId, options);
    });
  } else {
    chrome.desktopCapture.chooseDesktopMedia(sources, (streamId, options) => {
      void handlePicked(streamId, options);
    });
  }
}

async function stopRecording() {
  if (state.recordingPhase !== "recording" && state.recordingPhase !== "paused") return;
  state = {
    ...state,
    recordingPhase: "uploading",
    uploadActiveId: state.recordingId,
    uploadProgress: 2,
    uploadStep: "Preparando subida a Notion…",
  };
  await broadcastState();
  void chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_RECORDING" } satisfies ExtMessage);
}

async function discardRecording() {
  if (state.recordingPhase !== "recording" && state.recordingPhase !== "paused") return;
  void chrome.runtime.sendMessage({ type: "OFFSCREEN_DISCARD_RECORDING" } satisfies ExtMessage);
  state = {
    ...state,
    recordingPhase: "idle",
    recordingId: null,
    recordingStartedAt: null,
    recordingElapsedMs: 0,
    recordingLevel: 0,
    recordingBytes: 0,
    recordingChaptersUploaded: 0,
  };
  await broadcastState();
}

/* --------------------------------------------------------- EVENTOS CHROME */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "reco-dictate",
      title: "RECO: Dictar en el cursor",
      contexts: ["editable", "page"],
    });
    chrome.contextMenus.create({
      id: "reco-record",
      title: "RECO: Grabar pantalla hacia Notion",
      contexts: ["all"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "reco-dictate") {
    if (state.dictationPhase === "listening") {
      void stopDictation();
    } else {
      void startDictation(tab?.id);
    }
  } else if (info.menuItemId === "reco-record") {
    if (state.recordingPhase === "recording" || state.recordingPhase === "paused") {
      void stopRecording();
    } else {
      void startRecording();
    }
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-dictation") {
    if (state.dictationPhase === "listening") void stopDictation();
    else void startDictation();
  } else if (command === "toggle-recording") {
    if (state.recordingPhase === "recording" || state.recordingPhase === "paused") {
      void stopRecording();
    } else {
      void startRecording();
    }
  } else if (command === "pause-recording") {
    if (state.recordingPhase === "recording" || state.recordingPhase === "paused") {
      void chrome.runtime.sendMessage({ type: "OFFSCREEN_PAUSE_TOGGLE" } satisfies ExtMessage);
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then((tab) => {
    if (tab.url && !tab.url.startsWith("chrome-extension://") && !tab.url.startsWith("chrome://")) {
      lastTargetTabId = tabId;
    }
    void chrome.tabs
      .sendMessage(tabId, { type: "STATE_SYNC", state } satisfies ExtMessage)
      .catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === bridgeTabId) {
    bridgeTabId = null;
    if (state.dictationPhase === "listening") {
      state = {
        ...state,
        dictationPhase: "idle",
        dictationStartedAt: null,
        dictationInterim: "",
        dictationLevel: 0,
        dictationHostTabId: null,
      };
      void broadcastState();
    }
  }
});

chrome.runtime.onMessage.addListener((msg: ExtMessage, sender, sendResponse) => {
  if (msg.type === "GET_STATE") {
    sendResponse(state);
    return;
  }

  if (msg.type === "DICTATION_TOGGLE") {
    if (state.dictationPhase === "listening") void stopDictation();
    else void startDictation(msg.targetTabId ?? sender.tab?.id);
    return;
  }

  if (msg.type === "DICTATION_START") {
    void startDictation(msg.targetTabId ?? sender.tab?.id);
    return;
  }

  if (msg.type === "DICTATION_STOP") {
    void stopDictation();
    return;
  }

  if (msg.type === "DICTATION_LEVEL") {
    state.dictationLevel = msg.rms;
    void broadcastState();
    return;
  }

  if (msg.type === "DICTATION_INTERIM") {
    state.dictationInterim = msg.text;
    void broadcastState();
    return;
  }

  if (msg.type === "DICTATION_FINAL") {
    state.dictationInterim = "";
    state.dictationTranscript = state.dictationTranscript
      ? `${state.dictationTranscript} ${msg.text}`
      : msg.text;

    void (async () => {
      const cfg = await getConfig();
      const tab = await getActiveWebTab();
      if (tab?.id) {
        await chrome.tabs
          .sendMessage(tab.id, {
            type: "INJECT_TEXT",
            text: msg.text,
            smartSpacing: cfg.dictation.smartSpacing,
          } satisfies ExtMessage)
          .catch(() => {});
      }
      await broadcastState();
    })();
    return;
  }

  if (msg.type === "DICTATION_ERROR") {
    state.dictationError = msg.message;
    if (msg.fatal) {
      const lower = msg.message.toLowerCase();
      if (lower.includes("permiso") || lower.includes("denegado") || lower.includes("notallowed")) {
        void openPermissionsTab("dictation");
      }
      void stopDictation();
    } else {
      void broadcastState();
    }
    return;
  }

  if (msg.type === "DICTATION_ENDED") {
    if (state.dictationPhase === "listening") {
      void stopDictation();
    }
    return;
  }

  if (msg.type === "RECORDING_START") {
    void startRecording();
    return;
  }

  if (msg.type === "RECORDING_PAUSE_TOGGLE") {
    void chrome.runtime.sendMessage({ type: "OFFSCREEN_PAUSE_TOGGLE" } satisfies ExtMessage);
    return;
  }

  if (msg.type === "RECORDING_STOP") {
    void stopRecording();
    return;
  }

  if (msg.type === "RECORDING_DISCARD") {
    void discardRecording();
    return;
  }

  if (msg.type === "RECORDING_RETRY_UPLOAD") {
    void (async () => {
      const config = await getConfig();
      const { getRecordings } = await import("../shared/storage");
      const list = await getRecordings();
      const rec = list.find((r) => r.id === msg.recordingId);
      if (!rec) return;
      await ensureOffscreenDocument();
      state = {
        ...state,
        uploadActiveId: rec.id,
        uploadProgress: 2,
        uploadStep: "Reintentando subida…",
      };
      await broadcastState();
      void chrome.runtime.sendMessage({
        type: "OFFSCREEN_RETRY_UPLOAD",
        recording: rec,
        config,
      } satisfies ExtMessage);
    })();
    return;
  }

  if (msg.type === "OFFSCREEN_RECORDING_TICK") {
    state.recordingElapsedMs = msg.elapsedMs;
    state.recordingBytes = msg.bytes;
    state.recordingLevel = msg.rms;
    void broadcastState();
    return;
  }

  if (msg.type === "OFFSCREEN_RECORDING_PAUSED") {
    state.recordingPhase = msg.paused ? "paused" : "recording";
    void broadcastState();
    return;
  }

  if (msg.type === "OFFSCREEN_CHAPTER_UPLOADED") {
    state.recordingChaptersUploaded = msg.chaptersUploaded;
    void broadcastState();
    return;
  }

  if (msg.type === "OFFSCREEN_UPLOAD_PROGRESS") {
    state.uploadActiveId = msg.recordingId;
    state.uploadProgress = msg.progress;
    state.uploadStep = msg.step;
    void broadcastState();
    return;
  }

  if (msg.type === "OFFSCREEN_RECORDING_DONE") {
    const rec: RecordingItem = msg.recording;
    void (async () => {
      await upsertRecording(rec);
      state = {
        ...state,
        recordingPhase: "idle",
        recordingId: null,
        recordingStartedAt: null,
        recordingElapsedMs: 0,
        recordingLevel: 0,
        recordingBytes: 0,
        recordingChaptersUploaded: 0,
        recordingError: rec.uploadState === "failed" ? rec.error ?? null : null,
        uploadActiveId: null,
        uploadProgress: rec.uploadProgress,
        uploadStep: rec.uploadStep,
        lastNotionUrl: rec.notionPageUrl ?? state.lastNotionUrl,
      };
      await broadcastState();
    })();
    return;
  }

  if (msg.type === "OFFSCREEN_RECORDING_ERROR") {
    state = {
      ...state,
      recordingPhase: "idle",
      recordingId: null,
      recordingStartedAt: null,
      recordingElapsedMs: 0,
      recordingLevel: 0,
      recordingError: msg.message,
      uploadActiveId: null,
    };
    void broadcastState();
    return;
  }

  if (msg.type === "OPEN_PERMISSIONS") {
    void openPermissionsTab(msg.afterAction);
    return;
  }

  if (msg.type === "OPEN_SIDEPANEL") {
    void (async () => {
      const tab = sender.tab ?? (await getActiveWebTab());
      if (tab?.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
      }
    })();
    return;
  }

  if (msg.type === "PERMISSIONS_GRANTED") {
    if (msg.afterAction === "dictation") {
      void startDictation();
    } else if (msg.afterAction === "recording") {
      void startRecording();
    }
    return;
  }

  if (msg.type === "CONFIG_UPDATED") {
    void (async () => {
      const tabs = await chrome.tabs.query({}).catch(() => []);
      for (const tab of tabs) {
        if (tab.id && tab.url && !tab.url.startsWith("chrome://")) {
          void chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
    })();
  }
});
