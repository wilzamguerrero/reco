/**
 * Content Script de RECO:
 * 1) Rastrea el cursor activo para insertar dictado tipo Wispr Flow (`textInjector.ts`).
 * 2) Dibuja la esfera flotante RECO dentro de un Shadow DOM aislado para que
 *    ningún CSS de la página la rompa y el usuario sepa de inmediato por su
 *    color si está dictando (Cian), grabando pantalla (Rojo) o subiendo a Notion (Verde).
 */

import { mountOrb, type OrbHandle, type OrbVisualState } from "../shared/orbRenderer";
import { getConfig, patchConfig } from "../shared/storage";
import type { AppConfig, ExtMessage, LiveState } from "../shared/types";
import { initCursorTracker, injectTextAtCursor } from "./textInjector";

const HOST_ID = "reco-ext-host";

initCursorTracker();

let currentState: LiveState | null = null;
let currentConfig: AppConfig | null = null;
let menuOpen = false;
let toastText = "";
let toastTimer: number | null = null;
let insertFlashTimer: number | null = null;
let isFlashingInsert = false;

let hostEl: HTMLDivElement | null = null;
let orbHandle: OrbHandle | null = null;
let pillEl: HTMLDivElement | null = null;
let menuEl: HTMLDivElement | null = null;
let badgeEl: HTMLSpanElement | null = null;
let timerEl: HTMLSpanElement | null = null;
let interimEl: HTMLDivElement | null = null;
let actionBtnsEl: HTMLDivElement | null = null;
let toastEl: HTMLDivElement | null = null;
let uiTimerInterval: number | null = null;

function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function showToast(msg: string) {
  toastText = msg;
  if (toastTimer !== null) clearTimeout(toastTimer);
  renderState();
  toastTimer = window.setTimeout(() => {
    toastText = "";
    renderState();
  }, 2800);
}

function deriveOrbVisual(state: LiveState | null): OrbVisualState {
  if (!state) return "idle";
  if (isFlashingInsert) return "inserting";
  if (state.recordingPhase === "recording") return "recording";
  if (state.recordingPhase === "paused") return "paused";
  if (state.recordingPhase === "uploading" || state.uploadActiveId) return "uploading";
  if (state.dictationPhase === "listening") return "dictation";
  return "idle";
}

function ensureOverlay() {
  if (hostEl) return;
  if (!document.body) return;

  hostEl = document.createElement("div");
  hostEl.id = HOST_ID;
  hostEl.style.position = "fixed";
  hostEl.style.zIndex = "2147483647";
  hostEl.style.right = "22px";
  hostEl.style.bottom = "22px";
  hostEl.style.width = "auto";
  hostEl.style.height = "auto";
  hostEl.style.pointerEvents = "none";

  const shadow = hostEl.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .wrap {
      display: flex;
      flex-direction: row-reverse;
      align-items: center;
      gap: 10px;
      pointer-events: none;
      position: relative;
    }
    .orb-btn {
      pointer-events: auto;
      width: 58px;
      height: 58px;
      padding: 0;
      margin: 0;
      border: none;
      background: transparent;
      border-radius: 50%;
      cursor: grab;
      display: grid;
      place-items: center;
      touch-action: none;
      transition: transform 140ms ease, opacity 180ms ease;
    }
    .orb-btn:active { cursor: grabbing; transform: scale(0.95); }
    .orb-btn.is-idle { opacity: 0.72; }
    .orb-btn.is-idle:hover { opacity: 1; transform: scale(1.06); }
    canvas { display: block; width: 58px; height: 58px; pointer-events: none; }

    .pill {
      pointer-events: auto;
      display: none;
      align-items: center;
      gap: 9px;
      padding: 7px 11px;
      border-radius: 12px;
      background: rgba(10, 10, 12, 0.94);
      border: 1px solid #28242b;
      color: #f2ecec;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(10px);
      max-width: 310px;
    }
    .pill.is-visible { display: flex; }
    .pill-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .pill-dot.is-dictation { background: #22d3ee; box-shadow: 0 0 8px #22d3ee; }
    .pill-dot.is-recording { background: #ff4a3d; box-shadow: 0 0 8px #ff4a3d; }
    .pill-dot.is-paused { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
    .pill-dot.is-uploading { background: #10b981; box-shadow: 0 0 8px #10b981; }

    .pill-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 1px;
    }
    .pill-top {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #f2ecec;
      white-space: nowrap;
    }
    .pill-timer {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      color: #9e959a;
    }
    .pill-interim {
      font-size: 12px;
      color: #cbd5e1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 190px;
    }
    .pill-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .btn {
      border: 1px solid #2e2a32;
      background: #17161b;
      color: #f2ecec;
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn:hover { background: #242129; border-color: #463f4d; }
    .btn-stop {
      border-color: rgba(255, 74, 61, 0.45);
      background: rgba(255, 74, 61, 0.16);
      color: #ff9c94;
    }
    .btn-stop:hover { background: rgba(255, 74, 61, 0.28); }
    .btn-cyan {
      border-color: rgba(34, 211, 238, 0.45);
      background: rgba(34, 211, 238, 0.14);
      color: #a5f3fc;
    }
    .btn-cyan:hover { background: rgba(34, 211, 238, 0.24); }

    .menu {
      pointer-events: auto;
      position: absolute;
      bottom: 66px;
      right: 0;
      display: none;
      flex-direction: column;
      gap: 4px;
      min-width: 175px;
      padding: 6px;
      border-radius: 12px;
      background: rgba(10, 10, 12, 0.96);
      border: 1px solid #262229;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6);
    }
    .menu.is-open { display: flex; }
    .menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: #f2ecec;
      font-size: 12px;
      font-weight: 550;
      cursor: pointer;
      text-align: left;
    }
    .menu-item:hover { background: #19181d; border-color: #2e2932; }
    .menu-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .menu-left { display: flex; align-items: center; gap: 8px; }
    .menu-kbd { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: #7e757b; }

    .toast {
      pointer-events: auto;
      position: absolute;
      bottom: 66px;
      right: 0;
      display: none;
      padding: 7px 11px;
      border-radius: 10px;
      background: rgba(12, 12, 15, 0.95);
      border: 1px solid #2c2730;
      color: #f2ecec;
      font-size: 11.5px;
      white-space: nowrap;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
    }
    .toast.is-visible { display: block; }
  `;

  const wrap = document.createElement("div");
  wrap.className = "wrap";

  const orbBtn = document.createElement("button");
  orbBtn.type = "button";
  orbBtn.className = "orb-btn is-idle";
  orbBtn.title = "RECO · Arrastra para mover · Clic para Dictar o Grabar";

  const canvas = document.createElement("canvas");
  orbBtn.appendChild(canvas);

  pillEl = document.createElement("div");
  pillEl.className = "pill";

  badgeEl = document.createElement("span");
  badgeEl.className = "pill-dot";

  const info = document.createElement("div");
  info.className = "pill-info";

  const top = document.createElement("div");
  top.className = "pill-top";

  const titleLabel = document.createElement("span");
  titleLabel.className = "pill-title";
  timerEl = document.createElement("span");
  timerEl.className = "pill-timer";
  top.append(titleLabel, timerEl);

  interimEl = document.createElement("div");
  interimEl.className = "pill-interim";
  info.append(top, interimEl);

  actionBtnsEl = document.createElement("div");
  actionBtnsEl.className = "pill-actions";

  pillEl.append(badgeEl, info, actionBtnsEl);

  menuEl = document.createElement("div");
  menuEl.className = "menu";

  const btnDictate = document.createElement("button");
  btnDictate.type = "button";
  btnDictate.className = "menu-item";
  btnDictate.innerHTML = `<span class="menu-left"><span class="menu-dot" style="background:#22d3ee"></span>Dictar aquí</span><span class="menu-kbd">Alt+Shift+D</span>`;
  btnDictate.addEventListener("mousedown", (e) => e.preventDefault());
  btnDictate.addEventListener("click", () => {
    menuOpen = false;
    renderState();
    void chrome.runtime.sendMessage({ type: "DICTATION_TOGGLE" } satisfies ExtMessage);
  });

  const btnRecord = document.createElement("button");
  btnRecord.type = "button";
  btnRecord.className = "menu-item";
  btnRecord.innerHTML = `<span class="menu-left"><span class="menu-dot" style="background:#ff4a3d"></span>Grabar pantalla</span><span class="menu-kbd">Alt+Shift+R</span>`;
  btnRecord.addEventListener("mousedown", (e) => e.preventDefault());
  btnRecord.addEventListener("click", () => {
    menuOpen = false;
    renderState();
    void chrome.runtime.sendMessage({ type: "RECORDING_START" } satisfies ExtMessage);
  });

  const btnPanel = document.createElement("button");
  btnPanel.type = "button";
  btnPanel.className = "menu-item";
  btnPanel.innerHTML = `<span class="menu-left"><span class="menu-dot" style="background:#94a3b8"></span>Abrir panel lateral</span>`;
  btnPanel.addEventListener("click", () => {
    menuOpen = false;
    renderState();
    void chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL" } satisfies ExtMessage);
  });

  menuEl.append(btnDictate, btnRecord, btnPanel);

  toastEl = document.createElement("div");
  toastEl.className = "toast";

  wrap.append(orbBtn, pillEl, menuEl, toastEl);
  shadow.append(style, wrap);
  document.documentElement.appendChild(hostEl);

  orbHandle = mountOrb(canvas, 58, "idle", 1);

  // Dragging without losing text focus
  let dragStartX = 0;
  let dragStartY = 0;
  let startRight = 22;
  let startBottom = 22;
  let moved = false;

  orbBtn.addEventListener("mousedown", (e) => {
    // Crucial: prevent stealing focus from the user's text cursor!
    e.preventDefault();
  });

  orbBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    moved = false;
    const rect = hostEl!.getBoundingClientRect();
    startRight = Math.max(8, window.innerWidth - rect.right);
    startBottom = Math.max(8, window.innerHeight - rect.bottom);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - dragStartX;
      const dy = ev.clientY - dragStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved || !hostEl) return;
      const nextRight = Math.min(window.innerWidth - 70, Math.max(8, startRight - dx));
      const nextBottom = Math.min(window.innerHeight - 70, Math.max(8, startBottom - dy));
      hostEl.style.right = `${nextRight}px`;
      hostEl.style.bottom = `${nextBottom}px`;
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved && hostEl) {
        const right = parseFloat(hostEl.style.right) || 22;
        const bottom = parseFloat(hostEl.style.bottom) || 22;
        void patchConfig({ orbPosition: { x: right, y: bottom } });
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  orbBtn.addEventListener("click", () => {
    if (moved) return;
    if (currentState?.dictationPhase === "listening") {
      void chrome.runtime.sendMessage({ type: "DICTATION_STOP" } satisfies ExtMessage);
      return;
    }
    if (currentState?.recordingPhase === "recording" || currentState?.recordingPhase === "paused") {
      void chrome.runtime.sendMessage({ type: "RECORDING_STOP" } satisfies ExtMessage);
      return;
    }
    menuOpen = !menuOpen;
    renderState();
  });

  if (uiTimerInterval === null) {
    uiTimerInterval = window.setInterval(() => {
      updateTimers();
    }, 500);
  }
}

function applyPosition() {
  if (!hostEl || !currentConfig) return;
  if (currentConfig.dictation.showFloatingOrb === false && isIdleState(currentState)) {
    hostEl.style.display = "none";
  } else {
    hostEl.style.display = "block";
  }
  if (currentConfig.orbPosition) {
    const x = Math.min(window.innerWidth - 70, Math.max(8, currentConfig.orbPosition.x));
    const y = Math.min(window.innerHeight - 70, Math.max(8, currentConfig.orbPosition.y));
    hostEl.style.right = `${x}px`;
    hostEl.style.bottom = `${y}px`;
  }
}

function isIdleState(state: LiveState | null): boolean {
  if (!state) return true;
  return (
    state.dictationPhase === "idle" &&
    state.recordingPhase === "idle" &&
    !state.uploadActiveId
  );
}

function updateTimers() {
  if (!timerEl || !currentState) return;
  if (currentState.recordingPhase === "recording" && currentState.recordingStartedAt) {
    timerEl.textContent = formatTime(currentState.recordingElapsedMs);
  } else if (currentState.dictationPhase === "listening" && currentState.dictationStartedAt) {
    timerEl.textContent = formatTime(Date.now() - currentState.dictationStartedAt);
  }
}

function renderState() {
  if (!hostEl || !orbHandle || !pillEl || !badgeEl || !timerEl || !interimEl || !actionBtnsEl || !menuEl || !toastEl) {
    return;
  }

  applyPosition();

  const orbBtn = hostEl.shadowRoot?.querySelector(".orb-btn");
  const visual = deriveOrbVisual(currentState);
  orbHandle.setState(visual);

  if (currentState?.dictationPhase === "listening") {
    orbHandle.setLevel(currentState.dictationLevel);
  } else if (currentState?.recordingPhase === "recording") {
    orbHandle.setLevel(currentState.recordingLevel);
  } else {
    orbHandle.setLevel(0);
  }

  const idle = isIdleState(currentState);
  orbBtn?.classList.toggle("is-idle", idle);
  menuEl.classList.toggle("is-open", menuOpen && idle);

  if (toastText) {
    toastEl.textContent = toastText;
    toastEl.classList.add("is-visible");
  } else {
    toastEl.classList.remove("is-visible");
  }

  const titleEl = pillEl.querySelector(".pill-title") as HTMLSpanElement | null;
  actionBtnsEl.innerHTML = "";

  if (!currentState || idle) {
    pillEl.classList.remove("is-visible");
    return;
  }

  menuOpen = false;
  menuEl.classList.remove("is-open");
  pillEl.classList.add("is-visible");

  if (currentState.recordingPhase === "recording" || currentState.recordingPhase === "paused") {
    const paused = currentState.recordingPhase === "paused";
    badgeEl.className = `pill-dot ${paused ? "is-paused" : "is-recording"}`;
    if (titleEl) titleEl.textContent = paused ? "Pausa" : "Grabando";
    timerEl.textContent = formatTime(currentState.recordingElapsedMs);
    interimEl.textContent =
      currentState.recordingChaptersUploaded > 0
        ? `Subidos ${currentState.recordingChaptersUploaded} cap. a Notion`
        : "Captura de pantalla activa";

    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "btn";
    pauseBtn.textContent = paused ? "Reanudar" : "Pausar";
    pauseBtn.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "RECORDING_PAUSE_TOGGLE" } satisfies ExtMessage);
    });

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "btn btn-stop";
    stopBtn.textContent = "Detener";
    stopBtn.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "RECORDING_STOP" } satisfies ExtMessage);
    });

    actionBtnsEl.append(pauseBtn, stopBtn);
    return;
  }

  if (currentState.recordingPhase === "uploading" || currentState.uploadActiveId) {
    badgeEl.className = "pill-dot is-uploading";
    if (titleEl) titleEl.textContent = "Subiendo a Notion";
    timerEl.textContent = `${currentState.uploadProgress}%`;
    interimEl.textContent = currentState.uploadStep || "Enviando video…";
    return;
  }

  if (currentState.dictationPhase === "listening") {
    badgeEl.className = "pill-dot is-dictation";
    if (titleEl) titleEl.textContent = "Dictando";
    timerEl.textContent = currentState.dictationStartedAt
      ? formatTime(Date.now() - currentState.dictationStartedAt)
      : "00:00";
    interimEl.textContent = currentState.dictationInterim || "Habla ahora…";

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "btn btn-cyan";
    stopBtn.addEventListener("mousedown", (e) => e.preventDefault());
    stopBtn.textContent = "Detener";
    stopBtn.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "DICTATION_STOP" } satisfies ExtMessage);
    });
    actionBtnsEl.append(stopBtn);
  }
}

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  if (msg.type === "STATE_SYNC") {
    currentState = msg.state;
    ensureOverlay();
    renderState();
    return;
  }

  if (msg.type === "CONFIG_UPDATED") {
    currentConfig = msg.config;
    ensureOverlay();
    renderState();
    return;
  }

  if (msg.type === "INJECT_TEXT") {
    void injectTextAtCursor(msg.text, msg.smartSpacing).then((res) => {
      isFlashingInsert = true;
      renderState();
      if (insertFlashTimer !== null) clearTimeout(insertFlashTimer);
      insertFlashTimer = window.setTimeout(() => {
        isFlashingInsert = false;
        renderState();
      }, 260);
      if (!res.ok) {
        showToast("Sin campo activo: texto copiado al portapapeles (Ctrl+V)");
      }
      sendResponse(res);
    });
    return true;
  }

  if (msg.type === "DICTATION_ERROR") {
    showToast(msg.message);
  }
});

async function bootstrap() {
  currentConfig = await getConfig();
  ensureOverlay();
  const state = (await chrome.runtime
    .sendMessage({ type: "GET_STATE" } satisfies ExtMessage)
    .catch(() => null)) as LiveState | null;
  if (state) {
    currentState = state;
  }
  renderState();
}

void bootstrap();
