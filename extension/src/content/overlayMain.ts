/**
 * Overlay Script de RECO (`all_frames: false` — SOLO en el documento principal).
 *
 * Control flotante minimalista plano (estilo Bauhaus / Neo-Brutalist):
 *  - Sin cuadro de texto ni resumen al dictar: solo el control geométrico (`42×42`)
 *    que cambia de color e ícono central.
 *  - Al hacer clic en reposo, el ojo geométrico se abre y 3 botones cuadrados flotantes
 *    del mismo tamaño (`42×42`) emergen con animación escalonada hacia el lado con más
 *    espacio libre (arriba, abajo, izquierda o derecha), sin contenedor de panel.
 *  - Arrastre fluido con pointer capture que nunca se queda pegado ni salta.
 */

import { mountOrb, type OrbHandle, type OrbVisualState } from "../shared/orbRenderer";
import { getConfig, patchConfig } from "../shared/storage";
import type { AppConfig, ExtMessage, LiveState } from "../shared/types";

const HOST_ID = "reco-ext-host";
const GUARD_KEY = "__recoOverlayLoaded_v5";
const CONTROL_SIZE = 42;
const TILE_GAP = 8;
const TILE_STEP = CONTROL_SIZE + TILE_GAP;
const EDGE_MARGIN = 10;
const win = window as unknown as Record<string, unknown>;

// Bold flat Bauhaus geometric icons for the 3 floating action tiles
const SVG_DICTATE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <rect x="10.7" y="2" width="2.6" height="6.8"/>
  <rect x="10.7" y="15.2" width="2.6" height="6.8"/>
  <rect x="2" y="10.7" width="6.8" height="2.6"/>
  <rect x="15.2" y="10.7" width="6.8" height="2.6"/>
  <rect x="10.8" y="3.2" width="2.4" height="5.6" transform="rotate(45 12 12)"/>
  <rect x="10.8" y="15.2" width="2.4" height="5.6" transform="rotate(45 12 12)"/>
  <rect x="10.8" y="3.2" width="2.4" height="5.6" transform="rotate(-45 12 12)"/>
  <rect x="10.8" y="15.2" width="2.4" height="5.6" transform="rotate(-45 12 12)"/>
  <circle cx="12" cy="12" r="2.2"/>
</svg>`;

const SVG_RECORD = `<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M3 3h18v18H3V3Zm2.6 2.6v12.8h12.8V5.6H5.6Z"/>
  <rect x="8.8" y="8.8" width="6.4" height="6.4"/>
</svg>`;

const SVG_PANEL = `<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <rect x="3" y="3" width="8" height="8"/>
  <circle cx="17" cy="7" r="4"/>
  <polygon points="7,13 11,21 3,21"/>
  <path d="M13 17a4 4 0 0 1 8 0v4h-8v-4Z"/>
</svg>`;

const SVG_PAUSE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/></svg>`;
const SVG_PLAY = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>`;
const SVG_STOP = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14"/></svg>`;

function runOverlay() {
  if (window.self !== window.top) return;
  if (win[GUARD_KEY]) return;
  win[GUARD_KEY] = true;

  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
      if (e.code === "KeyD") {
        e.preventDefault();
        e.stopPropagation();
        if (currentState?.dictationPhase !== "listening") {
          triggerStartingPulse();
        }
        void chrome.runtime.sendMessage({ type: "DICTATION_TOGGLE" } satisfies ExtMessage);
      } else if (e.code === "KeyR") {
        e.preventDefault();
        e.stopPropagation();
        void chrome.runtime.sendMessage({ type: "RECORDING_TOGGLE" } satisfies ExtMessage);
      } else if (e.code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        void chrome.runtime.sendMessage({ type: "RECORDING_PAUSE_TOGGLE" } satisfies ExtMessage);
      }
    },
    true,
  );

  let currentState: LiveState | null = null;
  let currentConfig: AppConfig | null = null;
  let menuOpen = false;
  let toastText = "";
  let toastTimer: number | null = null;
  let insertFlashTimer: number | null = null;
  let isFlashingInsert = false;
  let isStartingDictation = false;
  let startingTimeout: number | null = null;
  let isErrorFlash = false;
  let errorFlashTimer: number | null = null;
  let lastSpeechAt = 0;
  let speechDecayTimer: number | null = null;

  // Drag state (isolated so STATE_SYNC never hijacks or sticks the control)
  let isDragging = false;
  let activePointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let startRight = 22;
  let startBottom = 22;
  let dragMoved = false;
  let suppressNextClick = false;
  let localPosition: { x: number; y: number } | null = null;

  let hostEl: HTMLDivElement | null = null;
  let orbHandle: OrbHandle | null = null;
  let recBarEl: HTMLDivElement | null = null;
  let recTimerEl: HTMLSpanElement | null = null;
  let recActionsEl: HTMLDivElement | null = null;
  let fabGroupEl: HTMLDivElement | null = null;
  let fabButtons: HTMLButtonElement[] = [];
  let toastEl: HTMLDivElement | null = null;
  let uiTimerInterval: number | null = null;

  function formatTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }

  function clampPosition(x: number, y: number): { x: number; y: number } {
    const maxRight = Math.max(EDGE_MARGIN, window.innerWidth - CONTROL_SIZE - EDGE_MARGIN);
    const maxBottom = Math.max(EDGE_MARGIN, window.innerHeight - CONTROL_SIZE - EDGE_MARGIN);
    return {
      x: Math.min(maxRight, Math.max(EDGE_MARGIN, Math.round(x))),
      y: Math.min(maxBottom, Math.max(EDGE_MARGIN, Math.round(y))),
    };
  }

  function showToast(msg: string) {
    toastText = msg;
    if (toastTimer !== null) clearTimeout(toastTimer);
    renderState();
    toastTimer = window.setTimeout(() => {
      toastText = "";
      renderState();
    }, 2600);
  }

  function triggerStartingPulse() {
    isStartingDictation = true;
    if (startingTimeout !== null) clearTimeout(startingTimeout);
    startingTimeout = window.setTimeout(() => {
      isStartingDictation = false;
      renderState();
    }, 3000);
    renderState();
  }

  function triggerErrorFlash() {
    isErrorFlash = true;
    if (errorFlashTimer !== null) clearTimeout(errorFlashTimer);
    errorFlashTimer = window.setTimeout(() => {
      isErrorFlash = false;
      renderState();
    }, 1400);
    renderState();
  }

  function deriveOrbVisual(state: LiveState | null): OrbVisualState {
    if (isFlashingInsert) return "inserting";
    if (isErrorFlash) return "error";
    if (!state) return isStartingDictation ? "starting" : menuOpen ? "menu" : "idle";
    if (state.recordingPhase === "recording") return "recording";
    if (state.recordingPhase === "paused") return "paused";
    if (state.recordingPhase === "uploading" || state.uploadActiveId) return "uploading";
    if (state.dictationPhase === "listening") {
      const hasInterim = state.dictationInterim.trim().length > 0;
      const hasVoice = state.dictationLevel > 0.045;
      const recentlySpoke = Date.now() - lastSpeechAt < 600;
      if (hasInterim || hasVoice || recentlySpoke) return "speaking";
      return "dictation";
    }
    if (isStartingDictation) return "starting";
    if (menuOpen) return "menu";
    return "idle";
  }

  function isIdleState(state: LiveState | null): boolean {
    if (!state) return true;
    return (
      state.dictationPhase === "idle" &&
      state.recordingPhase === "idle" &&
      !state.uploadActiveId
    );
  }

  /**
   * Inteligently chooses the best direction (up, down, left, right) for the 3 floating
   * square action tiles so they never clip off-screen or get blocked near any edge/corner.
   */
  function updateSmartLayout() {
    if (!hostEl) return;
    const rect = hostEl.getBoundingClientRect();
    const spaceTop = rect.top;
    const spaceBottom = window.innerHeight - rect.bottom;
    const spaceLeft = rect.left;
    const spaceRight = window.innerWidth - rect.right;

    const needed = TILE_STEP * 3 + EDGE_MARGIN;
    type Dir = "up" | "down" | "left" | "right";
    let dir: Dir = "up";

    if (spaceTop >= needed || spaceBottom >= needed) {
      // Prefer vertical stacking into whichever vertical side has more room
      dir = spaceTop >= spaceBottom ? "up" : "down";
    } else if (spaceLeft >= needed || spaceRight >= needed) {
      // Fallback to horizontal if viewport is very short
      dir = spaceLeft >= spaceRight ? "left" : "right";
    } else {
      // Pick absolute maximum free space
      const candidates: [Dir, number][] = [
        ["up", spaceTop],
        ["down", spaceBottom],
        ["left", spaceLeft],
        ["right", spaceRight],
      ];
      candidates.sort((a, b) => b[1] - a[1]);
      dir = candidates[0][0];
    }

    const tipSide =
      dir === "up" || dir === "down"
        ? spaceLeft >= spaceRight
          ? "left"
          : "right"
        : spaceTop >= spaceBottom
          ? "top"
          : "bottom";

    fabButtons.forEach((btn, idx) => {
      const dist = TILE_STEP * (idx + 1);
      let tx = 0;
      let ty = 0;
      if (dir === "up") ty = -dist;
      else if (dir === "down") ty = dist;
      else if (dir === "left") tx = -dist;
      else tx = dist;

      // Hard clamp each tile inside viewport so it can never be cut off
      const absLeft = rect.left + tx;
      const absTop = rect.top + ty;
      const clampedLeft = Math.min(
        window.innerWidth - CONTROL_SIZE - EDGE_MARGIN,
        Math.max(EDGE_MARGIN, absLeft),
      );
      const clampedTop = Math.min(
        window.innerHeight - CONTROL_SIZE - EDGE_MARGIN,
        Math.max(EDGE_MARGIN, absTop),
      );
      tx = Math.round(clampedLeft - rect.left);
      ty = Math.round(clampedTop - rect.top);

      btn.style.setProperty("--tx", `${tx}px`);
      btn.style.setProperty("--ty", `${ty}px`);
      btn.dataset.tipSide = tipSide;
    });

    const openDown = spaceTop < 110;
    const openRight = spaceLeft < 180;
    recBarEl?.classList.toggle("open-right", openRight);
    toastEl?.classList.toggle("open-down", openDown);
    toastEl?.classList.toggle("open-right", openRight);
  }

  function ensureOverlay() {
    if (hostEl && hostEl.isConnected) return;
    if (!document.body && !document.documentElement) return;

    document.querySelectorAll(`#${HOST_ID}`).forEach((el) => el.remove());

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    hostEl.style.position = "fixed";
    hostEl.style.zIndex = "2147483647";
    hostEl.style.right = "22px";
    hostEl.style.bottom = "22px";
    hostEl.style.width = `${CONTROL_SIZE}px`;
    hostEl.style.height = `${CONTROL_SIZE}px`;
    hostEl.style.pointerEvents = "none";

    const shadow = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
      }
      .wrap {
        position: relative;
        width: ${CONTROL_SIZE}px;
        height: ${CONTROL_SIZE}px;
        pointer-events: none;
      }
      .orb-btn {
        position: relative;
        z-index: 3;
        pointer-events: auto;
        width: ${CONTROL_SIZE}px;
        height: ${CONTROL_SIZE}px;
        padding: 0;
        margin: 0;
        border: none;
        background: transparent;
        border-radius: 4px;
        cursor: grab;
        display: grid;
        place-items: center;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        filter: drop-shadow(3px 3px 0 #000000);
        transition: transform 100ms ease, opacity 140ms ease, filter 100ms ease;
      }
      .orb-btn:hover {
        transform: translate(-1px, -1px);
        filter: drop-shadow(4px 4px 0 #000000);
      }
      .orb-btn.is-dragging {
        cursor: grabbing;
        transform: translate(1px, 1px);
        filter: drop-shadow(2px 2px 0 #000000);
        transition: none;
      }
      .orb-btn.is-idle { opacity: 0.92; }
      .orb-btn.is-idle:hover,
      .orb-btn.is-dragging { opacity: 1; }
      canvas {
        display: block;
        width: ${CONTROL_SIZE}px;
        height: ${CONTROL_SIZE}px;
        pointer-events: none;
      }

      /* 3 individual floating square Bauhaus action tiles (no panel box!) */
      .fab-group {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
      }
      .fab-tile {
        position: absolute;
        top: 0;
        left: 0;
        width: ${CONTROL_SIZE}px;
        height: ${CONTROL_SIZE}px;
        padding: 0;
        margin: 0;
        border-radius: 4px;
        border: 1.75px solid #09090b;
        color: #09090b;
        display: grid;
        place-items: center;
        cursor: pointer;
        pointer-events: none;
        opacity: 0;
        box-shadow: 3px 3px 0 #000000;
        transform: translate(0px, 0px) scale(0.45) rotate(-14deg);
        transition:
          transform 220ms cubic-bezier(0.22, 1.35, 0.36, 1),
          opacity 150ms ease,
          box-shadow 100ms ease;
      }
      .fab-group.is-open .fab-tile {
        pointer-events: auto;
        opacity: 1;
        transform: translate(var(--tx, 0px), var(--ty, 0px)) scale(1) rotate(0deg);
      }
      .fab-group.is-open .fab-tile:nth-child(1) { transition-delay: 0ms; }
      .fab-group.is-open .fab-tile:nth-child(2) { transition-delay: 42ms; }
      .fab-group.is-open .fab-tile:nth-child(3) { transition-delay: 84ms; }

      .fab-tile:hover {
        transform: translate(calc(var(--tx, 0px) - 1px), calc(var(--ty, 0px) - 1px)) scale(1.06) rotate(0deg);
        box-shadow: 4px 4px 0 #000000;
        z-index: 4;
      }
      .fab-tile:active {
        transform: translate(calc(var(--tx, 0px) + 1px), calc(var(--ty, 0px) + 1px)) scale(0.96);
        box-shadow: 1px 1px 0 #000000;
      }

      .fab-dictate { background: #2ee6c5; }
      .fab-record { background: #f05a28; }
      .fab-panel { background: #eae5d9; }

      /* Micro brutalist tooltip tag on hover, smartly placed away from edges */
      .fab-tip {
        position: absolute;
        pointer-events: none;
        opacity: 0;
        padding: 3px 6px;
        border-radius: 2px;
        background: #09090b;
        border: 1.5px solid #eae5d9;
        color: #eae5d9;
        font-size: 9.5px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        white-space: nowrap;
        box-shadow: 2px 2px 0 #000000;
        transition: opacity 110ms ease, transform 110ms ease;
      }
      .fab-tile[data-tip-side="left"] .fab-tip {
        right: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%) translateX(4px);
      }
      .fab-tile[data-tip-side="left"]:hover .fab-tip {
        opacity: 1;
        transform: translateY(-50%) translateX(0);
      }
      .fab-tile[data-tip-side="right"] .fab-tip {
        left: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%) translateX(-4px);
      }
      .fab-tile[data-tip-side="right"]:hover .fab-tip {
        opacity: 1;
        transform: translateY(-50%) translateX(0);
      }
      .fab-tile[data-tip-side="top"] .fab-tip {
        bottom: calc(100% + 7px);
        left: 50%;
        transform: translateX(-50%) translateY(4px);
      }
      .fab-tile[data-tip-side="top"]:hover .fab-tip {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .fab-tile[data-tip-side="bottom"] .fab-tip {
        top: calc(100% + 7px);
        left: 50%;
        transform: translateX(-50%) translateY(-4px);
      }
      .fab-tile[data-tip-side="bottom"]:hover .fab-tip {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      /* Compact flat brutalist bar ONLY for screen recording / upload */
      .rec-bar {
        pointer-events: auto;
        position: absolute;
        top: 50%;
        right: ${CONTROL_SIZE + 10}px;
        transform: translateY(-50%);
        display: none;
        align-items: center;
        gap: 6px;
        padding: 5px 7px;
        border-radius: 3px;
        background: #09090b;
        border: 1.5px solid #eae5d9;
        color: #eae5d9;
        box-shadow: 3px 3px 0 #000000;
        white-space: nowrap;
      }
      .rec-bar.open-right {
        right: auto;
        left: ${CONTROL_SIZE + 10}px;
      }
      .rec-bar.is-visible { display: flex; }
      .rec-timer {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 0 3px;
      }
      .rec-actions { display: flex; align-items: center; gap: 4px; }
      .ico-btn {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border-radius: 2px;
        border: 1.5px solid #2e2e36;
        background: #141418;
        color: #eae5d9;
        cursor: pointer;
      }
      .ico-btn:hover { background: #222228; border-color: #eae5d9; }
      .ico-btn.is-stop {
        background: #f05a28;
        border-color: #f05a28;
        color: #09090b;
      }
      .ico-btn.is-stop:hover { background: #ff7142; border-color: #ff7142; }

      .toast {
        pointer-events: auto;
        position: absolute;
        bottom: ${CONTROL_SIZE + 10}px;
        right: 0;
        display: none;
        padding: 6px 9px;
        border-radius: 3px;
        background: #09090b;
        border: 1.5px solid #eae5d9;
        color: #eae5d9;
        font-size: 11px;
        white-space: nowrap;
        box-shadow: 3px 3px 0 #000000;
      }
      .toast.open-down { bottom: auto; top: ${CONTROL_SIZE + 10}px; }
      .toast.open-right { right: auto; left: 0; }
      .toast.is-visible { display: block; }
    `;

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const orbBtn = document.createElement("button");
    orbBtn.type = "button";
    orbBtn.className = "orb-btn is-idle";
    orbBtn.title = "RECO · Arrastra para mover · Clic para acciones";

    const canvas = document.createElement("canvas");
    orbBtn.appendChild(canvas);

    recBarEl = document.createElement("div");
    recBarEl.className = "rec-bar";

    recTimerEl = document.createElement("span");
    recTimerEl.className = "rec-timer";

    recActionsEl = document.createElement("div");
    recActionsEl.className = "rec-actions";

    recBarEl.append(recTimerEl, recActionsEl);

    fabGroupEl = document.createElement("div");
    fabGroupEl.className = "fab-group";

    const btnDictate = document.createElement("button");
    btnDictate.type = "button";
    btnDictate.className = "fab-tile fab-dictate";
    btnDictate.title = "Dictar (Alt+Shift+D)";
    btnDictate.innerHTML = `${SVG_DICTATE}<span class="fab-tip">Dictar</span>`;
    btnDictate.addEventListener("mousedown", (e) => e.preventDefault());
    btnDictate.addEventListener("click", () => {
      menuOpen = false;
      triggerStartingPulse();
      void chrome.runtime.sendMessage({ type: "DICTATION_TOGGLE" } satisfies ExtMessage);
    });

    const btnRecord = document.createElement("button");
    btnRecord.type = "button";
    btnRecord.className = "fab-tile fab-record";
    btnRecord.title = "Grabar pantalla (Alt+Shift+R)";
    btnRecord.innerHTML = `${SVG_RECORD}<span class="fab-tip">Grabar</span>`;
    btnRecord.addEventListener("mousedown", (e) => e.preventDefault());
    btnRecord.addEventListener("click", () => {
      menuOpen = false;
      renderState();
      void chrome.runtime.sendMessage({ type: "RECORDING_START" } satisfies ExtMessage);
    });

    const btnPanel = document.createElement("button");
    btnPanel.type = "button";
    btnPanel.className = "fab-tile fab-panel";
    btnPanel.title = "Abrir panel lateral";
    btnPanel.innerHTML = `${SVG_PANEL}<span class="fab-tip">Panel</span>`;
    btnPanel.addEventListener("click", () => {
      menuOpen = false;
      renderState();
      void chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL" } satisfies ExtMessage);
    });

    fabButtons = [btnDictate, btnRecord, btnPanel];
    fabGroupEl.append(btnDictate, btnRecord, btnPanel);

    toastEl = document.createElement("div");
    toastEl.className = "toast";

    wrap.append(fabGroupEl, orbBtn, recBarEl, toastEl);
    shadow.append(style, wrap);
    document.documentElement.appendChild(hostEl);

    orbHandle = mountOrb(canvas, CONTROL_SIZE, "idle", 1.04);

    // Prevent stealing focus from text inputs when clicking the control
    orbBtn.addEventListener("mousedown", (e) => e.preventDefault());

    orbBtn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !hostEl) return;
      e.preventDefault();
      e.stopPropagation();

      activePointerId = e.pointerId;
      isDragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const rect = hostEl.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;

      try {
        orbBtn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture isn't supported on synthetic event
      }
      orbBtn.classList.add("is-dragging");
    });

    orbBtn.addEventListener("pointermove", (e) => {
      if (!isDragging || e.pointerId !== activePointerId || !hostEl) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      if (!dragMoved && Math.hypot(dx, dy) > 4) {
        dragMoved = true;
        if (menuOpen) {
          menuOpen = false;
          fabGroupEl?.classList.remove("is-open");
          orbHandle?.setState(deriveOrbVisual(currentState));
        }
      }
      if (!dragMoved) return;

      const clamped = clampPosition(startRight - dx, startBottom - dy);
      hostEl.style.right = `${clamped.x}px`;
      hostEl.style.bottom = `${clamped.y}px`;
      localPosition = clamped;
      updateSmartLayout();
    });

    const finishDrag = (e: PointerEvent) => {
      if (!isDragging || e.pointerId !== activePointerId) return;
      try {
        if (orbBtn.hasPointerCapture(e.pointerId)) {
          orbBtn.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }
      isDragging = false;
      activePointerId = null;
      orbBtn.classList.remove("is-dragging");

      if (dragMoved && localPosition) {
        suppressNextClick = true;
        if (currentConfig) {
          currentConfig = { ...currentConfig, orbPosition: localPosition };
        }
        void patchConfig({ orbPosition: localPosition });
        window.setTimeout(() => {
          suppressNextClick = false;
        }, 60);
      }
    };

    orbBtn.addEventListener("pointerup", finishDrag);
    orbBtn.addEventListener("pointercancel", finishDrag);

    orbBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (suppressNextClick || dragMoved) {
        suppressNextClick = false;
        dragMoved = false;
        return;
      }
      if (currentState?.dictationPhase === "listening") {
        void chrome.runtime.sendMessage({ type: "DICTATION_STOP" } satisfies ExtMessage);
        return;
      }
      if (
        currentState?.recordingPhase === "recording" ||
        currentState?.recordingPhase === "paused"
      ) {
        void chrome.runtime.sendMessage({ type: "RECORDING_STOP" } satisfies ExtMessage);
        return;
      }
      menuOpen = !menuOpen;
      updateSmartLayout();
      renderState();
    });

    // Close floating buttons when clicking outside
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (!menuOpen || !hostEl) return;
        const path = e.composedPath();
        if (!path.includes(hostEl)) {
          menuOpen = false;
          renderState();
        }
      },
      true,
    );

    window.addEventListener("resize", () => {
      if (!isDragging) applyPosition();
    });

    if (uiTimerInterval === null) {
      uiTimerInterval = window.setInterval(() => updateTimers(), 500);
    }
  }

  function applyPosition() {
    if (!hostEl || !currentConfig) return;

    if (currentConfig.dictation.showFloatingOrb === false && isIdleState(currentState)) {
      hostEl.style.display = "none";
    } else {
      hostEl.style.display = "block";
    }

    // Never overwrite position while user is actively dragging
    if (isDragging) return;

    const pos = localPosition ?? currentConfig.orbPosition;
    if (pos) {
      const clamped = clampPosition(pos.x, pos.y);
      hostEl.style.right = `${clamped.x}px`;
      hostEl.style.bottom = `${clamped.y}px`;
    }
    updateSmartLayout();
  }

  function updateTimers() {
    if (!recTimerEl || !currentState) return;
    if (currentState.recordingPhase === "recording" && currentState.recordingStartedAt) {
      recTimerEl.textContent = formatTime(currentState.recordingElapsedMs);
    }
  }

  function renderState() {
    if (!hostEl || !orbHandle || !recBarEl || !recTimerEl || !recActionsEl || !fabGroupEl || !toastEl) {
      return;
    }

    applyPosition();

    const orbBtn = hostEl.shadowRoot?.querySelector(".orb-btn") as HTMLButtonElement | null;
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
    orbBtn?.classList.toggle("is-idle", idle && !menuOpen);
    if (orbBtn) {
      orbBtn.title =
        visual === "starting"
          ? "RECO · Conectando micrófono…"
          : visual === "speaking"
            ? "RECO · Transcribiendo tu voz (clic para detener)"
            : visual === "dictation"
              ? "RECO · Escuchando, habla ahora (clic para detener)"
              : visual === "inserting"
                ? "RECO · Texto insertado"
                : visual === "error"
                  ? "RECO · Revisa el micrófono o portapapeles"
                  : visual === "recording"
                    ? "RECO · Grabando pantalla (clic para detener)"
                    : visual === "paused"
                      ? "RECO · Grabación en pausa"
                      : visual === "uploading"
                        ? `RECO · Subiendo a Notion (${currentState?.uploadProgress ?? 0}%)`
                        : menuOpen
                          ? "RECO · Cerrar opciones"
                          : "RECO · Arrastra para mover · Clic para acciones";
    }

    fabGroupEl.classList.toggle("is-open", menuOpen && idle);

    if (toastText) {
      toastEl.textContent = toastText;
      toastEl.classList.add("is-visible");
    } else {
      toastEl.classList.remove("is-visible");
    }

    recActionsEl.innerHTML = "";

    // Dictation: pure floating control ONLY — no text box or summary pill!
    if (!currentState || idle || currentState.dictationPhase === "listening") {
      recBarEl.classList.remove("is-visible");
      if (!idle) {
        menuOpen = false;
        fabGroupEl.classList.remove("is-open");
      }
      return;
    }

    menuOpen = false;
    fabGroupEl.classList.remove("is-open");

    if (
      currentState.recordingPhase === "recording" ||
      currentState.recordingPhase === "paused"
    ) {
      const paused = currentState.recordingPhase === "paused";
      recBarEl.classList.add("is-visible");
      recTimerEl.textContent = formatTime(currentState.recordingElapsedMs);

      const pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "ico-btn";
      pauseBtn.title = paused ? "Reanudar" : "Pausar";
      pauseBtn.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
      pauseBtn.addEventListener("click", () => {
        void chrome.runtime.sendMessage({ type: "RECORDING_PAUSE_TOGGLE" } satisfies ExtMessage);
      });

      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "ico-btn is-stop";
      stopBtn.title = "Detener y subir";
      stopBtn.innerHTML = SVG_STOP;
      stopBtn.addEventListener("click", () => {
        void chrome.runtime.sendMessage({ type: "RECORDING_STOP" } satisfies ExtMessage);
      });

      recActionsEl.append(pauseBtn, stopBtn);
      return;
    }

    if (currentState.recordingPhase === "uploading" || currentState.uploadActiveId) {
      recBarEl.classList.add("is-visible");
      recTimerEl.textContent = `${currentState.uploadProgress}%`;
      return;
    }

    recBarEl.classList.remove("is-visible");
  }

  chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
    if (msg.type === "PING_OVERLAY") {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "STATE_SYNC") {
      currentState = msg.state;
      if (msg.state.dictationPhase === "listening") {
        isStartingDictation = false;
        if (startingTimeout !== null) {
          clearTimeout(startingTimeout);
          startingTimeout = null;
        }
        if (msg.state.dictationInterim.trim().length > 0 || msg.state.dictationLevel > 0.045) {
          lastSpeechAt = Date.now();
          if (speechDecayTimer !== null) clearTimeout(speechDecayTimer);
          speechDecayTimer = window.setTimeout(() => {
            renderState();
          }, 640);
        }
      }
      ensureOverlay();
      renderState();
      return;
    }

    if (msg.type === "CONFIG_UPDATED") {
      currentConfig = msg.config;
      if (!isDragging && msg.config.orbPosition) {
        localPosition = msg.config.orbPosition;
      }
      ensureOverlay();
      renderState();
      return;
    }

    if (msg.type === "OVERLAY_FEEDBACK") {
      isFlashingInsert = true;
      renderState();
      if (insertFlashTimer !== null) clearTimeout(insertFlashTimer);
      insertFlashTimer = window.setTimeout(() => {
        isFlashingInsert = false;
        renderState();
      }, 240);
      if (!msg.ok) {
        showToast("Copiado al portapapeles (Ctrl+V)");
      }
      return;
    }

    if (msg.type === "DICTATION_ERROR") {
      isStartingDictation = false;
      triggerErrorFlash();
      showToast(msg.message);
    }
  });

  async function bootstrap() {
    currentConfig = await getConfig();
    if (currentConfig.orbPosition) {
      localPosition = currentConfig.orbPosition;
    }
    ensureOverlay();
    const state = (await chrome.runtime
      .sendMessage({ type: "GET_STATE" } satisfies ExtMessage)
      .catch(() => null)) as LiveState | null;
    if (state) currentState = state;
    renderState();
  }

  void bootstrap();
}

runOverlay();
