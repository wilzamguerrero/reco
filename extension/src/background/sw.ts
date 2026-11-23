/**
 * Service Worker de RECO (MV3).
 *
 * Coordina:
 * - Estado global de Dictado (Cian) y Grabación/Subida a Notion (Rojo / Verde).
 * - Atajos globales (`Alt+Shift+D`, `Alt+Shift+R`, `Alt+Shift+P`).
 * - Inserción universal en Chrome (`all_frames: true` + Shadow DOM + auto-inyección
 *   en pestañas ya abiertas) y en apps de escritorio externas vía Native Messaging
 *   (`com.reco.typer`) cuando Chrome no tiene el foco.
 */

import { getConfig, upsertDictationNote, upsertRecording } from "../shared/storage";
import type {
  AgentBatchStep,
  BrowserActionPayload,
  ExtMessage,
  LiveState,
  PageActionPayload,
  RecordingItem,
} from "../shared/types";

const OFFSCREEN_URL = "offscreen.html";
const BRIDGE_URL = chrome.runtime.getURL("bridge.html");
const PERMISSIONS_URL = chrome.runtime.getURL("permissions.html");
const NATIVE_HOST_NAME = "com.reco.typer";

// Kyutai labels its streamed PCM as a downloadable WAV. Remove only that
// header for RECO's own synthesis requests, including the local server.
function installPocketAudioRule() {
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        responseHeaders: [{
          header: "content-disposition",
          operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
        }],
      },
      condition: {
        regexFilter: "^https?://(127[.]0[.]0[.]1:8766/tts|pocket-tts-api[.]kyutai[.]org/(spanish|english)/tts)$",
        initiatorDomains: [chrome.runtime.id],
        requestMethods: [chrome.declarativeNetRequest.RequestMethod.POST],
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
      },
    }],
  });
}

// The Wispr Web demo backend returns 403 unless the request looks like it comes
// from wisprflow.ai (Origin/Referer), as the original web demo does.
function installWisprWebRule() {
  const H = chrome.declarativeNetRequest.HeaderOperation.SET;
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [2],
    addRules: [{
      id: 2,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          { header: "origin", operation: H, value: "https://wisprflow.ai" },
          { header: "referer", operation: H, value: "https://wisprflow.ai/" },
        ],
      },
      condition: {
        regexFilter: "^(https|wss)://api[.]wisprflow[.]ai/",
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.WEBSOCKET,
        ],
      },
    }],
  });
}

chrome.runtime.onInstalled.addListener(installPocketAudioRule);
chrome.runtime.onInstalled.addListener(installWisprWebRule);
installWisprWebRule().catch(() => {});

let state: LiveState = {
  dictationPhase: "idle",
  dictationStartedAt: null,
  dictationInterim: "",
  dictationTranscript: "",
  dictationStatus: null,
  dictationError: null,
  dictationLevel: 0,
  dictationHostTabId: null,
  nativeHostConnected: false,

  aiVoicePhase: "idle",
  aiVoiceLevel: 0,
  aiVoiceStatus: null,

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
let bridgeReady = false;
let bridgeWakeTimer: ReturnType<typeof setTimeout> | null = null;
let lastTargetTabId: number | null = null;
const lastFocusedFrameByTab = new Map<number, number>();
let offscreenCreating: Promise<void> | null = null;
let nativePort: chrome.runtime.Port | null = null;
let lastCommandAt = 0;
let lastLiveHandledInPage = false;
let currentDictationSessionId: string | null = null;
let lastCapturedScreenDataUrl: string | null = null;
let lastCroppedImageDataUrl: string | null = null;

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

async function cropDataUrlRegion(
  dataUrl: string,
  xPct: number,
  yPct: number,
  wPct: number,
  hPct: number,
): Promise<string> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  try {
    const x = Math.max(0, Math.min(99, xPct));
    const y = Math.max(0, Math.min(99, yPct));
    const w = Math.max(2, Math.min(100 - x, wPct));
    const h = Math.max(2, Math.min(100 - y, hPct));
    const sx = Math.round((x / 100) * bmp.width);
    const sy = Math.round((y / 100) * bmp.height);
    const sw = Math.max(16, Math.min(bmp.width - sx, Math.round((w / 100) * bmp.width)));
    const sh = Math.max(16, Math.min(bmp.height - sy, Math.round((h / 100) * bmp.height)));
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo inicializar el lienzo de recorte.");
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return await blobToDataUrl(outBlob);
  } finally {
    bmp.close();
  }
}

function allowShortcutCommand(): boolean {
  const now = Date.now();
  if (now - lastCommandAt < 350) return false;
  lastCommandAt = now;
  return true;
}

function ensureNativePort(): Promise<boolean> {
  if (nativePort) return Promise.resolve(true);

  return new Promise((resolve) => {
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      let settled = false;

      port.onMessage.addListener((msg: unknown) => {
        const data = msg as { ok?: boolean; pong?: boolean } | null;
        if (data?.pong || data?.ok) {
          state.nativeHostConnected = true;
          if (!settled) {
            settled = true;
            resolve(true);
          }
          void broadcastState();
        }
      });

      port.onDisconnect.addListener(() => {
        nativePort = null;
        state.nativeHostConnected = false;
        if (!settled) {
          settled = true;
          resolve(false);
        }
        void broadcastState();
      });

      nativePort = port;
      port.postMessage({ action: "ping" });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(Boolean(nativePort));
        }
      }, 2500);
    } catch {
      nativePort = null;
      state.nativeHostConnected = false;
      resolve(false);
    }
  });
}

async function typeViaNativeHost(text: string): Promise<boolean> {
  const ready = await ensureNativePort();
  if (!ready || !nativePort) return false;
  try {
    nativePort.postMessage({ action: "type", text: `${text} ` });
    return true;
  } catch {
    return false;
  }
}

let lastActionIconState: string | null = null;

function updateActionBadge() {
  let iconKey: "idle" | "dictation" | "recording" | "paused" | "uploading" = "idle";

  if (state.recordingPhase === "recording") {
    iconKey = "recording";
    void chrome.action.setBadgeText({ text: "REC" });
    void chrome.action.setBadgeBackgroundColor({ color: "#F05A28" });
    void chrome.action.setBadgeTextColor?.({ color: "#09090B" });
  } else if (state.recordingPhase === "paused") {
    iconKey = "paused";
    void chrome.action.setBadgeText({ text: "II" });
    void chrome.action.setBadgeBackgroundColor({ color: "#F4B41A" });
    void chrome.action.setBadgeTextColor?.({ color: "#09090B" });
  } else if (state.recordingPhase === "uploading" || state.uploadActiveId) {
    iconKey = "uploading";
    void chrome.action.setBadgeText({ text: `${state.uploadProgress}%` });
    void chrome.action.setBadgeBackgroundColor({ color: "#8B6EFF" });
    void chrome.action.setBadgeTextColor?.({ color: "#09090B" });
  } else if (state.dictationPhase === "listening") {
    iconKey = "dictation";
    void chrome.action.setBadgeText({ text: "" });
  } else {
    iconKey = "idle";
    void chrome.action.setBadgeText({ text: "" });
  }

  if (iconKey !== lastActionIconState) {
    lastActionIconState = iconKey;
    const path =
      iconKey === "idle"
        ? { 16: "icons/icon16.png", 32: "icons/icon32.png" }
        : { 16: `icons/${iconKey}-16.png`, 32: `icons/${iconKey}-32.png` };
    void chrome.action.setIcon({ path }).catch(() => {});
  }
}

function broadcastStateFast() {
  void chrome.runtime.sendMessage({ type: "STATE_SYNC", state } satisfies ExtMessage).catch(() => {});
  if (lastTargetTabId !== null) {
    void chrome.tabs
      .sendMessage(lastTargetTabId, { type: "STATE_SYNC", state } satisfies ExtMessage, { frameId: 0 })
      .catch(() => {});
  }
}

async function broadcastState() {
  updateActionBadge();
  void chrome.runtime.sendMessage({ type: "STATE_SYNC", state } satisfies ExtMessage).catch(() => {});

  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      continue;
    }
    if (tab.active) {
      void chrome.tabs
        .sendMessage(tab.id, { type: "STATE_SYNC", state } satisfies ExtMessage, { frameId: 0 })
        .catch(() => {});
    }
  }
}

async function getActiveWebTab(): Promise<chrome.tabs.Tab | null> {
  const wins = await chrome.windows
    .getAll({ populate: true, windowTypes: ["normal"] })
    .catch(() => []);
  const ordered = [...wins].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));

  for (const w of ordered) {
    const active = w.tabs?.find((t) => t.active);
    if (
      active?.id &&
      active.url &&
      !active.url.startsWith("chrome-extension://") &&
      !active.url.startsWith("chrome://")
    ) {
      return active;
    }
  }

  if (lastTargetTabId !== null) {
    const fallback = await chrome.tabs.get(lastTargetTabId).catch(() => null);
    if (
      fallback?.id &&
      fallback.url &&
      !fallback.url.startsWith("chrome-extension://") &&
      !fallback.url.startsWith("chrome://")
    ) {
      return fallback;
    }
  }
  return null;
}

async function ensureContentInjected(tabId: number): Promise<void> {
  try {
    const ping = (await chrome.tabs
      .sendMessage(tabId, { type: "PING_OVERLAY" } satisfies ExtMessage, { frameId: 0 })
      .catch(() => null)) as { ok?: boolean } | null;

    if (!ping?.ok) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ["overlay.js"],
      });
    }

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["injector.js"],
    });
  } catch {
    // chrome:// u origen restringido
  }
}

async function injectIntoActiveTab(
  tabId: number,
  msg: ExtMessage,
): Promise<boolean> {
  const frameId = lastFocusedFrameByTab.get(tabId);

  const trySend = async (targetFrameId?: number): Promise<boolean> => {
    try {
      const res = (
        targetFrameId !== undefined
          ? await chrome.tabs.sendMessage(tabId, msg, { frameId: targetFrameId })
          : await chrome.tabs.sendMessage(tabId, msg)
      ) as { ok?: boolean; skipped?: boolean } | undefined;
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  };

  if (frameId !== undefined && (await trySend(frameId))) {
    return true;
  }
  if (await trySend(undefined)) {
    return true;
  }

  // Si la pestaña ya estaba abierta antes de cargar la extensión, inyectamos y reintentamos
  await ensureContentInjected(tabId);
  if (frameId !== undefined && (await trySend(frameId))) {
    return true;
  }
  return await trySend(undefined);
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

let wisprDictation = false;
let stoppingDictation: Promise<void> | undefined;

async function startDictation(explicitTabId?: number) {
  if (state.dictationPhase === "listening") return;

  const activeTab = explicitTabId
    ? await chrome.tabs.get(explicitTabId).catch(() => null)
    : await getActiveWebTab();
  if (activeTab?.id) {
    lastTargetTabId = activeTab.id;
    // Asegurar content script en pestañas abiertas antes de instalar la extensión
    void ensureContentInjected(activeTab.id);
  }

  // Intentar conectar host nativo en silencio por si el usuario dicta fuera de Chrome
  const cfg = await getConfig();
  wisprDictation = cfg.dictation.engine === "wispr" || cfg.dictation.engine === "wispr_web";
  if (cfg.dictation.desktopTyping) {
    void ensureNativePort();
  }

  const startedAt = Date.now();
  currentDictationSessionId = `dic-${startedAt}`;

  state = {
    ...state,
    dictationPhase: "listening",
    dictationStartedAt: startedAt,
    dictationInterim: "",
    dictationTranscript: "",
    dictationStatus:
      cfg.dictation.engine === "wispr" ? "Conectando con Wispr Flow" : cfg.dictation.engine === "wispr_web" ? "Conectando con Wispr Web…" : cfg.dictation.engine === "chrome" ? null : "Preparando modelo local…",
    dictationError: null,
    dictationLevel: 0,
  };
  await broadcastState();

  if (bridgeTabId !== null) {
    await chrome.tabs.remove(bridgeTabId).catch(() => {});
    bridgeTabId = null;
  }

  bridgeReady = false;
  if (bridgeWakeTimer) {
    clearTimeout(bridgeWakeTimer);
    bridgeWakeTimer = null;
  }

  const tab = await chrome.tabs.create({
    url: BRIDGE_URL,
    pinned: true,
    active: false,
  });
  bridgeTabId = tab.id ?? null;
  state.dictationHostTabId = bridgeTabId;
}

function stopDictation() {
  if (!stoppingDictation) stoppingDictation = finishDictation().finally(() => { stoppingDictation = undefined; });
  return stoppingDictation;
}

async function finishDictation() {
  if (state.dictationPhase === "idle" && bridgeTabId === null) return;
  if (wisprDictation && bridgeTabId !== null) {
    await chrome.runtime.sendMessage({ type: "DICTATION_FLUSH" } satisfies ExtMessage).catch(() => {});
  } else {
    void chrome.runtime.sendMessage({ type: "DICTATION_STOP" } satisfies ExtMessage).catch(() => {});
  }
  wisprDictation = false;

  const tabToClose = bridgeTabId;
  bridgeTabId = null;
  state = {
    ...state,
    dictationPhase: "idle",
    dictationStartedAt: null,
    dictationInterim: "",
    dictationStatus: null,
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

/* ----------------------------------------------------------- VOZ IA LIBRE */

async function startAiVoice(explicitTabId?: number) {
  if (state.aiVoicePhase !== "idle") return;
  if (state.dictationPhase === "listening") {
    await stopDictation();
  }

  const activeTab = explicitTabId
    ? await chrome.tabs.get(explicitTabId).catch(() => null)
    : await getActiveWebTab();
  if (activeTab?.id) {
    lastTargetTabId = activeTab.id;
    void ensureContentInjected(activeTab.id);
  }

  state = {
    ...state,
    aiVoicePhase: "listening",
    aiVoiceLevel: 0,
    aiVoiceStatus: null,
  };
  await broadcastState();

  if (bridgeTabId !== null) {
    await chrome.tabs.remove(bridgeTabId).catch(() => {});
    bridgeTabId = null;
  }

  const tab = await chrome.tabs.create({
    url: `${BRIDGE_URL}?mode=ai`,
    pinned: true,
    active: false,
  });
  bridgeTabId = tab.id ?? null;
}

async function stopAiVoice() {
  if (state.aiVoicePhase === "idle" && bridgeTabId === null) return;
  void chrome.runtime.sendMessage({ type: "AI_VOICE_STOP" } satisfies ExtMessage).catch(() => {});

  const tabToClose = bridgeTabId;
  bridgeTabId = null;
  state = {
    ...state,
    aiVoicePhase: "idle",
    aiVoiceLevel: 0,
    aiVoiceStatus: null,
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
  if (!allowShortcutCommand()) return;
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
  } else if (command === "toggle-ai-voice") {
    if (state.aiVoicePhase !== "idle") void stopAiVoice();
    else void startAiVoice();
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(async (tab) => {
    if (!tab.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("chrome://")) {
      return;
    }
    lastTargetTabId = tabId;
    if (state.dictationPhase === "listening" || state.recordingPhase !== "idle") {
      await ensureContentInjected(tabId);
    }
    void chrome.tabs
      .sendMessage(tabId, { type: "STATE_SYNC", state } satisfies ExtMessage, { frameId: 0 })
      .catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  if (!tab.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("chrome://")) {
    return;
  }
  lastTargetTabId = tabId;
  if (state.dictationPhase === "listening" || state.recordingPhase !== "idle") {
    void ensureContentInjected(tabId).then(() => {
      void chrome.tabs
        .sendMessage(tabId, { type: "STATE_SYNC", state } satisfies ExtMessage, { frameId: 0 })
        .catch(() => {});
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastFocusedFrameByTab.delete(tabId);
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

  if (msg.type === "CURSOR_FOCUSED") {
    if (sender.tab?.id !== undefined && sender.frameId !== undefined) {
      lastTargetTabId = sender.tab.id;
      lastFocusedFrameByTab.set(sender.tab.id, sender.frameId);
    }
    return;
  }

  if (msg.type === "INJECTION_FEEDBACK") {
    if (sender.tab?.id !== undefined) {
      void chrome.tabs
        .sendMessage(
          sender.tab.id,
          { type: "OVERLAY_FEEDBACK", ok: msg.ok } satisfies ExtMessage,
          { frameId: 0 },
        )
        .catch(() => {});
    }
    return;
  }

  if (msg.type === "TEST_NATIVE_HOST") {
    void ensureNativePort().then((ok) => {
      sendResponse({ connected: ok });
    });
    return true;
  }

  if (msg.type === "DICTATION_TOGGLE") {
    if (sender.tab?.id && !allowShortcutCommand()) return;
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

  if (msg.type === "DICTATION_BRIDGE_READY") {
    bridgeReady = true;
    if (bridgeWakeTimer) {
      clearTimeout(bridgeWakeTimer);
      bridgeWakeTimer = null;
    }
    return;
  }

  if (msg.type === "DICTATION_STATUS") {
    state.dictationStatus = msg.status;
    broadcastStateFast();
    return;
  }

  if (msg.type === "DICTATION_LEVEL") {
    state.dictationLevel = msg.rms;
    broadcastStateFast();
    return;
  }

  if (msg.type === "DICTATION_INTERIM") {
    state.dictationInterim = msg.text;
    broadcastStateFast();
    return;
  }

  if (msg.type === "DICTATION_LIVE") {
    void (async () => {
      const cfg = await getConfig();
      const lastWin = await chrome.windows.getLastFocused().catch(() => null);
      const chromeFocused = Boolean(lastWin?.focused);
      if (!chromeFocused) {
        lastLiveHandledInPage = false;
        return;
      }

      const tab = await getActiveWebTab();
      if (tab?.id) {
        const ok = await injectIntoActiveTab(tab.id, {
          type: "INJECT_LIVE",
          payload: msg.payload,
          smartSpacing: cfg.dictation.smartSpacing,
        });
        lastLiveHandledInPage = ok;
      } else {
        lastLiveHandledInPage = false;
      }
    })();
    return;
  }

  if (msg.type === "DICTATION_FINAL") {
    state.dictationInterim = "";
    state.dictationTranscript = state.dictationTranscript
      ? `${state.dictationTranscript} ${msg.text}`
      : msg.text;

    const sessionId = currentDictationSessionId ?? `dic-${Date.now()}`;
    currentDictationSessionId = sessionId;
    void upsertDictationNote({
      id: sessionId,
      text: state.dictationTranscript,
      createdAt: state.dictationStartedAt ?? Date.now(),
    });

    void (async () => {
      const cfg = await getConfig();
      const lastWin = await chrome.windows.getLastFocused().catch(() => null);
      const chromeFocused = Boolean(lastWin?.focused);

      // Si Chrome NO tiene foco (Word, Notepad, VS Code) o si el cursor está en la
      // barra de direcciones / pestaña chrome:// (donde la página no tiene foco DOM),
      // usamos el host nativo para escribir directamente donde esté el cursor.
      const needsSystemTyper = !chromeFocused || !lastLiveHandledInPage;
      lastLiveHandledInPage = false;

      if (needsSystemTyper && cfg.dictation.desktopTyping) {
        const typed = await typeViaNativeHost(msg.text);
        if (!typed && lastTargetTabId !== null) {
          void chrome.tabs
            .sendMessage(
              lastTargetTabId,
              {
                type: "DICTATION_ERROR",
                message:
                  "Para escribir en la barra de direcciones o apps de escritorio, ejecuta native-host/Instalar_Dictado_Escritorio.bat",
              } satisfies ExtMessage,
              { frameId: 0 },
            )
            .catch(() => {});
        }
      }

      await broadcastState();
    })();
    return;
  }

  if (msg.type === "DICTATION_ERROR") {
    state.dictationError = msg.message;
    if (msg.fatal) {
      const lower = msg.message.toLowerCase();
      if (
        lower.includes("mic_permission_required") ||
        lower.includes("permission") ||
        lower.includes("permiso") ||
        lower.includes("denegado") ||
        lower.includes("denied") ||
        lower.includes("notallowed")
      ) {
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

  if (msg.type === "RECORDING_TOGGLE") {
    if (sender.tab?.id && !allowShortcutCommand()) return;
    if (state.recordingPhase === "recording" || state.recordingPhase === "paused") {
      void stopRecording();
    } else {
      void startRecording();
    }
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

  if (msg.type === "CAPTURE_TAB_SCREEN") {
    void (async () => {
      try {
        const tab = await getActiveWebTab();
        if (!tab?.windowId) {
          sendResponse({ ok: false, error: "No hay pestaña web activa para mirar." });
          return;
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 72,
        });
        lastCapturedScreenDataUrl = dataUrl;
        sendResponse({ ok: true, dataUrl, title: tab.title || "Pantalla" });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "No se pudo capturar la pantalla.",
        });
      }
    })();
    return true;
  }

  if (msg.type === "GET_PAGE_SNAPSHOT") {
    void (async () => {
      try {
        const tab = await getActiveWebTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: "No hay pestaña web activa." });
          return;
        }
        await ensureContentInjected(tab.id);
        const res = await chrome.tabs
          .sendMessage(tab.id, { type: "GET_PAGE_SNAPSHOT" } satisfies ExtMessage, { frameId: 0 })
          .catch(() => null);
        sendResponse(res ?? { ok: false, error: "No se pudo leer la página." });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "No se pudo leer la página.",
        });
      }
    })();
    return true;
  }

async function waitForTabReady(tabId: number, maxMs = 4500): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const info = await chrome.tabs.get(tabId).catch(() => null);
    if (!info) return;
    if (info.status === "complete") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await ensureContentInjected(tabId);
}

function showCropBoxOnTab(
  tabId: number,
  xPct: number,
  yPct: number,
  wPct: number,
  hPct: number,
  label?: string,
) {
  void chrome.tabs
    .sendMessage(
      tabId,
      {
        type: "EXECUTE_PAGE_ACTION",
        action: { kind: "show_crop_box", xPct, yPct, wPct, hPct, label },
      } satisfies ExtMessage,
      { frameId: 0 },
    )
    .catch(() => {});
}

async function executePageActionInSw(action: PageActionPayload): Promise<{ ok: boolean; detail?: string; error?: string }> {
  try {
    if (action.kind === "navigate") {
      let url = action.url.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "URL no permitida." };
      }
      let targetTabId: number | undefined;
      if (action.newTab) {
        const created = await chrome.tabs.create({ url, active: true });
        targetTabId = created.id;
      } else {
        const tab = await getActiveWebTab();
        if (tab?.id) {
          await chrome.tabs.update(tab.id, { url });
          targetTabId = tab.id;
        } else {
          const created = await chrome.tabs.create({ url, active: true });
          targetTabId = created.id;
        }
      }
      if (targetTabId !== undefined) {
        lastTargetTabId = targetTabId;
        await waitForTabReady(targetTabId);
      }
      return { ok: true, detail: `Navegando a ${url}` };
    }

    if (action.kind === "history") {
      const tab = await getActiveWebTab();
      if (!tab?.id) return { ok: false, error: "No hay pestaña web activa." };
      if (action.direction === "back") await chrome.tabs.goBack(tab.id).catch(() => {});
      else if (action.direction === "forward") await chrome.tabs.goForward(tab.id).catch(() => {});
      else await chrome.tabs.reload(tab.id).catch(() => {});
      await waitForTabReady(tab.id);
      return { ok: true, detail: `Historial: ${action.direction}` };
    }

    const tab = await getActiveWebTab();
    if (!tab?.id) return { ok: false, error: "No hay pestaña web activa." };
    await ensureContentInjected(tab.id);

    let outboundAction = action;
    if (action.kind === "paste_image") {
      const imgUrl = action.dataUrl || lastCroppedImageDataUrl || lastCapturedScreenDataUrl;
      if (!imgUrl) {
        return { ok: false, error: "No hay ninguna imagen capturada o recortada para pegar." };
      }
      outboundAction = { ...action, dataUrl: imgUrl };
    }

    const msgOut: ExtMessage = { type: "EXECUTE_PAGE_ACTION", action: outboundAction };
    let res = (await chrome.tabs.sendMessage(tab.id, msgOut, { frameId: 0 }).catch(() => null)) as
      | { ok?: boolean; detail?: string; error?: string }
      | null;

    // One automatic retry for paste/type/click right after a tab switch or SPA mount
    if (!res?.ok && (outboundAction.kind === "paste_image" || outboundAction.kind === "type" || outboundAction.kind === "click")) {
      await new Promise((r) => setTimeout(r, 320));
      await ensureContentInjected(tab.id);
      res = (await chrome.tabs.sendMessage(tab.id, msgOut, { frameId: 0 }).catch(() => null)) as
        | { ok?: boolean; detail?: string; error?: string }
        | null;
    }

    return res?.ok
      ? { ok: true, detail: res.detail }
      : { ok: false, error: res?.error || "No se pudo ejecutar la acción en la página." };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Error ejecutando acción en la página.",
    };
  }
}

async function executeBrowserActionInSw(act: BrowserActionPayload): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  const trigrams = (s: string) => {
    const padded = `  ${s} `;
    const set = new Set<string>();
    for (let i = 0; i <= padded.length - 3; i += 1) set.add(padded.slice(i, i + 3));
    return set;
  };

  const diceScore = (a: string, b: string) => {
    const ta = trigrams(a);
    const tb = trigrams(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let hit = 0;
    for (const g of ta) if (tb.has(g)) hit += 1;
    return (2 * hit) / (ta.size + tb.size);
  };

  const findTab = async (target?: string): Promise<chrome.tabs.Tab | null> => {
    const all = (await chrome.tabs.query({ windowType: "normal" }).catch(() => [])).filter(
      (t) => t.id && t.url && !t.url.startsWith("chrome-extension://"),
    );
    const q = (target ?? "").trim();
    if (!q || /^(current|actual|esta|activa)$/i.test(q)) {
      return (await getActiveWebTab()) ?? all.find((t) => t.active) ?? null;
    }
    const idMatch = q.match(/^(?:tab)?#?(\d+)$/i);
    if (idMatch) {
      const byId = all.find((t) => t.id === Number(idMatch[1]));
      if (byId) return byId;
    }
    const needle = norm(q);
    const direct = all.find(
      (t) => norm(t.title || "").includes(needle) || norm(t.url || "").includes(needle),
    );
    if (direct) return direct;

    let best: { tab: chrome.tabs.Tab; score: number } | null = null;
    for (const t of all) {
      const hay = `${norm(t.title || "")} ${norm(t.url || "")}`;
      const tokens = hay.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      let score = diceScore(needle, norm(t.title || ""));
      for (const tok of tokens) {
        score = Math.max(score, diceScore(needle, tok));
      }
      if (score >= 0.34 && (!best || score > best.score)) {
        best = { tab: t, score };
      }
    }
    return best?.tab ?? null;
  };

  try {
    if (act.kind === "switch_tab") {
      const tab = await findTab(act.target);
      if (!tab?.id) return { ok: false, error: `No encontré la pestaña "${act.target}".` };
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(tab.id, { active: true });
      lastTargetTabId = tab.id;
      await waitForTabReady(tab.id, 2500);
      return { ok: true, detail: `Cambiado a "${tab.title}"` };
    }

    if (act.kind === "close_tab") {
      const tab = await findTab(act.target);
      if (!tab?.id) return { ok: false, error: "No encontré la pestaña para cerrar." };
      await chrome.tabs.remove(tab.id);
      return { ok: true, detail: `Pestaña cerrada: "${tab.title}"` };
    }

    if (act.kind === "new_tab") {
      const raw = (act.urlOrQuery ?? "").trim();
      let created: chrome.tabs.Tab;
      if (!raw) {
        created = await chrome.tabs.create({ active: true });
      } else if (/^(https?:\/\/|[\w-]+\.[a-z]{2,}(\/|$))/i.test(raw) && !raw.includes(" ")) {
        const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        created = await chrome.tabs.create({ url, active: true });
      } else {
        created = await chrome.tabs.create({
          url: `https://www.google.com/search?q=${encodeURIComponent(raw)}`,
          active: true,
        });
      }
      if (created.id !== undefined) {
        lastTargetTabId = created.id;
        await waitForTabReady(created.id);
      }
      return { ok: true, detail: "Nueva pestaña abierta" };
    }

    if (act.kind === "duplicate_tab") {
      const tab = await getActiveWebTab();
      if (tab?.id) {
        const dup = await chrome.tabs.duplicate(tab.id);
        if (dup?.id !== undefined) lastTargetTabId = dup.id;
      }
      return { ok: true, detail: "Pestaña duplicada" };
    }

    if (act.kind === "pin_tab") {
      const tab = await getActiveWebTab();
      if (tab?.id) await chrome.tabs.update(tab.id, { pinned: !tab.pinned });
      return { ok: true, detail: "Fijado de pestaña alternado" };
    }

    if (act.kind === "mute_tab") {
      const tab = await findTab(act.target);
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
      }
      return { ok: true, detail: "Audio de pestaña alternado" };
    }

    if (act.kind === "search_web") {
      const url = `https://www.google.com/search?q=${encodeURIComponent(act.query)}`;
      const created = await chrome.tabs.create({ url, active: true });
      if (created.id !== undefined) {
        lastTargetTabId = created.id;
        await waitForTabReady(created.id);
      }
      return { ok: true, detail: `Buscando "${act.query}"` };
    }

    if (act.kind === "bookmark_current") {
      const tab = await getActiveWebTab();
      if (tab?.url && chrome.bookmarks?.create) {
        await chrome.bookmarks.create({ title: tab.title || tab.url, url: tab.url });
        return { ok: true, detail: "Guardado en marcadores" };
      }
      return { ok: false, error: "No se pudo guardar marcador." };
    }

    if (act.kind === "crop_element") {
      const tab = await getActiveWebTab();
      if (!tab?.id || !tab.windowId) return { ok: false, error: "No hay pestaña web activa para recortar." };
      await ensureContentInjected(tab.id);
      const rectRes = (await chrome.tabs
        .sendMessage(
          tab.id,
          { type: "EXECUTE_PAGE_ACTION", action: { kind: "get_rect", target: act.target } } satisfies ExtMessage,
          { frameId: 0 },
        )
        .catch(() => null)) as { ok?: boolean; rect?: { xPct: number; yPct: number; wPct: number; hPct: number }; error?: string } | null;

      if (!rectRes?.ok || !rectRes.rect) {
        return { ok: false, error: rectRes?.error || `No encontré "${act.target}" para recortar.` };
      }

      const fullPng = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      lastCapturedScreenDataUrl = fullPng;
      const cropped = await cropDataUrlRegion(
        fullPng,
        rectRes.rect.xPct,
        rectRes.rect.yPct,
        rectRes.rect.wPct,
        rectRes.rect.hPct,
      );
      lastCroppedImageDataUrl = cropped;
      showCropBoxOnTab(
        tab.id,
        rectRes.rect.xPct,
        rectRes.rect.yPct,
        rectRes.rect.wPct,
        rectRes.rect.hPct,
        "CAPTURADO",
      );
      return { ok: true, detail: `Elemento "${act.target}" recortado con precisión` };
    }

    if (act.kind === "crop_image") {
      const tab = await getActiveWebTab();
      let sourceUrl = act.captureFresh ? null : lastCapturedScreenDataUrl;
      if (!sourceUrl) {
        if (!tab?.windowId) return { ok: false, error: "No hay pestaña web activa para recortar." };
        sourceUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        lastCapturedScreenDataUrl = sourceUrl;
      }
      const cropped = await cropDataUrlRegion(
        sourceUrl,
        act.xPct,
        act.yPct,
        act.wPct,
        act.hPct,
      );
      lastCroppedImageDataUrl = cropped;
      if (tab?.id) {
        showCropBoxOnTab(tab.id, act.xPct, act.yPct, act.wPct, act.hPct, "CAPTURADO");
      }
      return { ok: true, detail: "Imagen recortada lista para pegar" };
    }

    if (act.kind === "open_history") {
      if (chrome.history?.search) {
        const items = await chrome.history.search({ text: act.query, maxResults: 5 });
        const hit = items.find((i) => i.url);
        if (hit?.url) {
          const created = await chrome.tabs.create({ url: hit.url, active: true });
          if (created.id !== undefined) {
            lastTargetTabId = created.id;
            await waitForTabReady(created.id);
          }
          return { ok: true, detail: `Abierto del historial: ${hit.title || hit.url}` };
        }
      }
      return { ok: false, error: `No encontré "${act.query}" en el historial.` };
    }

    return { ok: false, error: "Acción de navegador no soportada." };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Error ejecutando acción del navegador.",
    };
  }
}

async function runActionBatchInSw(steps: AgentBatchStep[]) {
  const results: Array<{ label: string; ok: boolean; detail?: string; error?: string }> = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const res =
      step.scope === "browser"
        ? await executeBrowserActionInSw(step.action)
        : await executePageActionInSw(step.action);
    results.push({ label: step.label, ...res });

    // Brief settle between chained steps so paste previews, modals, or clicks take effect cleanly
    if (i < steps.length - 1) {
      const waitMs =
        step.scope === "page" && step.action.kind === "paste_image"
          ? 280
          : step.scope === "page" && (step.action.kind === "click" || step.action.kind === "click_xy")
            ? 200
            : 120;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return { ok: true, results };
}

  if (msg.type === "EXECUTE_PAGE_ACTION") {
    void executePageActionInSw(msg.action).then(sendResponse);
    return true;
  }

  if (msg.type === "GET_BROWSER_TABS") {
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({ windowType: "normal" }).catch(() => []);
        const visible = tabs.filter(
          (t) =>
            t.id &&
            t.url &&
            !t.url.startsWith("chrome-extension://"),
        );
        const lines = visible.slice(0, 35).map((t) => {
          const flags = [
            t.active ? "activa" : "",
            t.pinned ? "fijada" : "",
            t.audible ? "audio" : "",
            t.mutedInfo?.muted ? "silenciada" : "",
          ]
            .filter(Boolean)
            .join(", ");
          const flagStr = flags ? ` (${flags})` : "";
          const title = (t.title || "Sin título").replace(/\s+/g, " ").trim().slice(0, 70);
          return `- tab#${t.id}${flagStr} "${title}" (${t.url})`;
        });
        sendResponse({
          ok: true,
          summary:
            lines.length > 0
              ? `[Pestañas abiertas en el navegador (${visible.length}):]\n${lines.join("\n")}`
              : "",
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "No se pudieron listar las pestañas.",
        });
      }
    })();
    return true;
  }

  if (msg.type === "EXECUTE_BROWSER_ACTION") {
    void executeBrowserActionInSw(msg.action).then(sendResponse);
    return true;
  }

  if (msg.type === "RUN_ACTION_BATCH") {
    void runActionBatchInSw(msg.steps).then(sendResponse);
    return true;
  }

  if (msg.type === "OPEN_FLOATING_CHAT") {
    void (async () => {
      const tab = await getActiveWebTab();
      if (!tab?.id) return;
      await ensureContentInjected(tab.id);
      void chrome.tabs
        .sendMessage(
          tab.id,
          { type: "OPEN_FLOATING_CHAT", autoVoice: Boolean(msg.autoVoice) } satisfies ExtMessage,
          { frameId: 0 },
        )
        .catch(() => {});
    })();
    return;
  }

  if (msg.type === "AI_VOICE_TOGGLE") {
    if (state.aiVoicePhase !== "idle") void stopAiVoice();
    else void startAiVoice(msg.targetTabId ?? sender.tab?.id);
    return;
  }

  if (msg.type === "AI_VOICE_START") {
    void startAiVoice(msg.targetTabId ?? sender.tab?.id);
    return;
  }

  if (msg.type === "AI_VOICE_STOP") {
    void stopAiVoice();
    return;
  }

  if (msg.type === "AI_VOICE_PHASE") {
    state.aiVoicePhase = msg.phase;
    if (msg.status !== undefined) state.aiVoiceStatus = msg.status;
    broadcastStateFast();
    return;
  }

  if (msg.type === "AI_VOICE_LEVEL") {
    state.aiVoiceLevel = msg.rms;
    broadcastStateFast();
    return;
  }

  if (msg.type === "DRAW_CONTROL") {
    void (async () => {
      const tab = await getActiveWebTab();
      if (!tab?.id) return;
      await ensureContentInjected(tab.id);
      void chrome.tabs
        .sendMessage(tab.id, msg, { frameId: 0 })
        .catch(() => {});
    })();
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
