/**
 * Pizarra de dibujo invisible (estilo Epic Pen + trazos orgánicos tipo Excalidraw)
 * sobre cualquier pestaña web.
 *
 * Características del trazo:
 *  - Tableta / stylus (`pointerType === "pen"`): responde a la presión real de la pluma (`e.pressure`).
 *  - Mouse / trackpad: simula presión orgánica por velocidad + suavizado (streamline) +
 *    afinamiento asimétrico al iniciar y terminar el trazo (estilo Excalidraw / perfect-freehand).
 *  - Herramientas: Lápiz, Resaltador, Flecha, Rectángulo, Modo Cursor (click-through).
 *  - Atajos: Ctrl+Z (deshacer), Esc (salir de dibujo).
 */

type DrawTool = "pen" | "highlighter" | "arrow" | "rect" | "cursor";

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

interface Stroke {
  tool: Exclude<DrawTool, "cursor">;
  color: string;
  width: number;
  isPen: boolean;
  points: StrokePoint[];
}

export interface DrawOverlayHandle {
  open(): void;
  close(): void;
  toggle(): boolean;
  isOpen(): boolean;
}

const DRAW_HOST_ID = "reco-draw-host";

const COLORS = [
  { hex: "#2EE6C5", label: "Menta" },
  { hex: "#F05A28", label: "Bermellón" },
  { hex: "#F4B41A", label: "Ocre" },
  { hex: "#8B6EFF", label: "Violeta" },
  { hex: "#EAE5D9", label: "Hueso" },
];

const SVG_PEN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.5V21h3.5L18.4 9.1l-3.5-3.5L3 17.5ZM21 6.5 17.5 3l-1.8 1.8 3.5 3.5L21 6.5Z"/></svg>`;
const SVG_HL = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 15.5 14.5 5l4.5 4.5L8.5 20H4v-4.5Z"/><rect x="13" y="18" width="8" height="2.5"/></svg>`;
const SVG_ARROW = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M5 19 16.5 7.5V14H19V5h-9v2.5h6.5L5 19Z"/></svg>`;
const SVG_RECT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3V5Zm2.4 2.4v9.2h13.2V7.4H5.4Z"/></svg>`;
const SVG_CURSOR = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 5,19 9.8,14.6 13.4,21 15.8,19.7 12.2,13.4 18.5,13.4"/></svg>`;
const SVG_UNDO = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M9 7 4 12l5 5v-3.5h6a3.5 3.5 0 0 1 0 7h-2V23h2a6 6 0 0 0 0-12H9V7Z"/></svg>`;
const SVG_TRASH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="8.5" y="3" width="7" height="2.2"/><rect x="3.5" y="6.2" width="17" height="2.2"/><path d="M5.5 9.5h13l-1.2 11.5H6.7L5.5 9.5Z"/></svg>`;
const SVG_CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="19,6.4 17.6,5 12,10.6 6.4,5 5,6.4 10.6,12 5,17.6 6.4,19 12,13.4 17.6,19 19,17.6 13.4,12"/></svg>`;

/**
 * Generates an Excalidraw / perfect-freehand style variable-width filled ink path.
 * - Uses hardware stylus pressure when `isPen === true`.
 * - Simulates organic pressure from stroke velocity when using mouse/trackpad.
 * - Applies smooth streamlining and asymmetric start/end tapering so ends look natural.
 */
function drawFreehandInk(
  ctx: CanvasRenderingContext2D,
  rawPoints: StrokePoint[],
  baseSize: number,
  isPen: boolean,
) {
  if (rawPoints.length === 0) return;

  // Single tap -> clean dot
  if (rawPoints.length === 1) {
    const p = rawPoints[0];
    const r = Math.max(1.2, baseSize * (isPen ? 0.3 + p.pressure * 0.6 : 0.48));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // 1. Streamline (exponential smoothing to eliminate jitter) & cumulative arc length
  const streamline = 0.56;
  const pts: { x: number; y: number; pressure: number; dist: number; cumDist: number }[] = [];
  let sx = rawPoints[0].x;
  let sy = rawPoints[0].y;
  let sp = isPen ? rawPoints[0].pressure : 0.5;
  let cumDist = 0;

  pts.push({ x: sx, y: sy, pressure: sp, dist: 0, cumDist: 0 });

  for (let i = 1; i < rawPoints.length; i += 1) {
    const cur = rawPoints[i];
    const prev = rawPoints[i - 1];
    sx = sx + (cur.x - sx) * (1 - streamline);
    sy = sy + (cur.y - sy) * (1 - streamline);

    const last = pts[pts.length - 1];
    const d = Math.hypot(sx - last.x, sy - last.y);
    if (d < 0.75 && i < rawPoints.length - 1) continue;

    let targetP: number;
    if (isPen) {
      targetP = Math.max(0.05, Math.min(1, cur.pressure));
    } else {
      // Simulate Excalidraw velocity-based pressure: faster -> thinner, slower -> fuller
      const dt = Math.max(4, cur.t - prev.t);
      const speed = Math.hypot(cur.x - prev.x, cur.y - prev.y) / dt; // px/ms
      const velNorm = Math.min(1, speed / 2.2);
      targetP = 0.78 - velNorm * 0.48;
    }
    sp = sp + (targetP - sp) * 0.32;
    cumDist += d;
    pts.push({ x: sx, y: sy, pressure: sp, dist: d, cumDist });
  }

  if (pts.length < 2) {
    const p = pts[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, baseSize * 0.45, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // 2. Compute left & right contour points with asymmetric Excalidraw start/end taper
  const totalLen = Math.max(1, cumDist);
  const taperStartLen = isPen ? Math.min(totalLen * 0.14, 14) : Math.min(totalLen * 0.24, 28);
  const taperEndLen = isPen ? Math.min(totalLen * 0.2, 22) : Math.min(totalLen * 0.36, 46);

  const leftPts: { x: number; y: number }[] = [];
  const rightPts: { x: number; y: number }[] = [];

  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];

    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const tLen = Math.hypot(tx, ty) || 1;
    tx /= tLen;
    ty /= tLen;

    // Perpendicular normal
    const nx = -ty;
    const ny = tx;

    // Asymmetric start taper (gentle ink touch) & end taper (natural lift-off)
    let taper = 1;
    if (p.cumDist < taperStartLen) {
      const k = p.cumDist / Math.max(1, taperStartLen);
      taper = Math.min(taper, 0.28 + 0.72 * Math.sin((k * Math.PI) / 2));
    }
    const distFromEnd = totalLen - p.cumDist;
    if (distFromEnd < taperEndLen) {
      const k = distFromEnd / Math.max(1, taperEndLen);
      // Sharper, sleeker tail taper at the end of the stroke
      taper = Math.min(taper, 0.08 + 0.92 * Math.pow(k, 0.65));
    }

    const pressureScale = isPen
      ? 0.22 + Math.pow(p.pressure, 0.85) * 1.15
      : 0.42 + p.pressure * 0.72;

    const radius = Math.max(0.45, (baseSize * 0.5) * pressureScale * taper);

    leftPts.push({ x: p.x + nx * radius, y: p.y + ny * radius });
    rightPts.push({ x: p.x - nx * radius, y: p.y - ny * radius });
  }

  // 3. Draw smooth closed polygon using quadratic midpoint curves
  const allPts = [...leftPts, ...rightPts.reverse()];
  if (allPts.length < 3) return;

  ctx.beginPath();
  const firstMidX = (allPts[allPts.length - 1].x + allPts[0].x) / 2;
  const firstMidY = (allPts[allPts.length - 1].y + allPts[0].y) / 2;
  ctx.moveTo(firstMidX, firstMidY);

  for (let i = 0; i < allPts.length; i += 1) {
    const cur = allPts[i];
    const nxt = allPts[(i + 1) % allPts.length];
    const midX = (cur.x + nxt.x) / 2;
    const midY = (cur.y + nxt.y) / 2;
    ctx.quadraticCurveTo(cur.x, cur.y, midX, midY);
  }
  ctx.closePath();
  ctx.fill();
}

export function createDrawOverlay(onStateChange?: (open: boolean) => void): DrawOverlayHandle {
  let active = false;
  let tool: DrawTool = "pen";
  let color = COLORS[0].hex;
  let strokes: Stroke[] = [];
  let currentStroke: Stroke | null = null;

  let hostEl: HTMLDivElement | null = null;
  let canvasEl: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let dockEl: HTMLDivElement | null = null;

  function resizeCanvas() {
    if (!canvasEl || !ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvasEl.width = Math.round(w * dpr);
    canvasEl.height = Math.round(h * dpr);
    canvasEl.style.width = `${w}px`;
    canvasEl.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function drawStroke(s: Stroke) {
    if (!ctx || s.points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = s.tool === "highlighter" ? "butt" : "round";
    ctx.lineJoin = "round";

    if (s.tool === "pen") {
      drawFreehandInk(ctx, s.points, s.width, s.isPen);
    } else if (s.tool === "highlighter") {
      ctx.globalAlpha = 0.34;
      ctx.beginPath();
      const pts = s.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x + 0.1, pts[0].y + 0.1);
      } else {
        for (let i = 1; i < pts.length - 1; i += 1) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
    } else if (s.tool === "rect" && s.points.length >= 2) {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (s.tool === "arrow" && s.points.length >= 2) {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const headLen = Math.max(12, s.width * 3.6);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x - Math.cos(angle) * (headLen * 0.55), b.y - Math.sin(angle) * (headLen * 0.55));
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(
        b.x - headLen * Math.cos(angle - Math.PI / 6),
        b.y - headLen * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        b.x - headLen * Math.cos(angle + Math.PI / 6),
        b.y - headLen * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  function redraw() {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of strokes) drawStroke(s);
    if (currentStroke) drawStroke(currentStroke);
  }

  function syncDockUI() {
    if (!dockEl || !canvasEl) return;
    canvasEl.style.pointerEvents = tool === "cursor" ? "none" : "auto";
    canvasEl.style.cursor = tool === "cursor" ? "default" : "crosshair";

    dockEl.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tool === tool);
    });
    dockEl.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.color === color);
    });
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (strokes.length > 0) {
        strokes.pop();
        redraw();
      }
    }
  };

  function ensureDom() {
    if (hostEl && hostEl.isConnected) return;
    document.querySelectorAll(`#${DRAW_HOST_ID}`).forEach((el) => el.remove());

    hostEl = document.createElement("div");
    hostEl.id = DRAW_HOST_ID;
    hostEl.style.position = "fixed";
    hostEl.style.inset = "0";
    hostEl.style.zIndex = "2147483645";
    hostEl.style.pointerEvents = "none";

    const shadow = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; font-family: ui-monospace, Consolas, monospace; }
      canvas {
        position: fixed;
        inset: 0;
        display: block;
        touch-action: none;
      }
      .dock {
        position: fixed;
        bottom: 18px;
        left: 50%;
        transform: translateX(-50%);
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 7px;
        border-radius: 4px;
        background: #09090b;
        border: 1.75px solid #eae5d9;
        box-shadow: 4px 4px 0 #000000;
        user-select: none;
      }
      .sep {
        width: 1.5px;
        height: 20px;
        background: #2a2a32;
        margin: 0 2px;
      }
      .tool-btn {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border-radius: 2px;
        border: 1.5px solid transparent;
        background: #141418;
        color: #eae5d9;
        cursor: pointer;
      }
      .tool-btn:hover { border-color: #eae5d9; background: #1f1f26; }
      .tool-btn.is-active {
        background: #f4b41a;
        border-color: #f4b41a;
        color: #09090b;
      }
      .tool-btn.is-close:hover {
        background: #f05a28;
        border-color: #f05a28;
        color: #09090b;
      }
      .swatch {
        width: 18px;
        height: 18px;
        padding: 0;
        border-radius: 2px;
        border: 1.5px solid #09090b;
        cursor: pointer;
        transition: transform 90ms ease;
      }
      .swatch:hover { transform: scale(1.12); }
      .swatch.is-active {
        outline: 2px solid #eae5d9;
        outline-offset: 1px;
      }
    `;

    canvasEl = document.createElement("canvas");
    ctx = canvasEl.getContext("2d");

    canvasEl.addEventListener("pointerdown", (e) => {
      if (tool === "cursor" || e.button !== 0 || !canvasEl) return;
      e.preventDefault();
      try {
        canvasEl.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      const isPen = e.pointerType === "pen";
      const width = tool === "highlighter" ? 18 : tool === "pen" ? 6.2 : 3.2;
      currentStroke = {
        tool,
        color,
        width,
        isPen,
        points: [
          {
            x: e.clientX,
            y: e.clientY,
            pressure: isPen ? e.pressure || 0.5 : 0.5,
            t: performance.now(),
          },
        ],
      };
      redraw();
    });

    canvasEl.addEventListener("pointermove", (e) => {
      if (!currentStroke) return;
      const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      const samples = evs.length > 0 ? evs : [e];

      if (currentStroke.tool === "pen" || currentStroke.tool === "highlighter") {
        for (const s of samples) {
          currentStroke.points.push({
            x: s.clientX,
            y: s.clientY,
            pressure: currentStroke.isPen ? s.pressure || 0.5 : 0.5,
            t: performance.now(),
          });
        }
      } else {
        const pt: StrokePoint = {
          x: e.clientX,
          y: e.clientY,
          pressure: 0.5,
          t: performance.now(),
        };
        if (currentStroke.points.length === 1) {
          currentStroke.points.push(pt);
        } else {
          currentStroke.points[1] = pt;
        }
      }
      redraw();
    });

    const endStroke = (e: PointerEvent) => {
      if (!currentStroke || !canvasEl) return;
      try {
        if (canvasEl.hasPointerCapture(e.pointerId)) {
          canvasEl.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignore
      }
      strokes.push(currentStroke);
      currentStroke = null;
      redraw();
    };

    canvasEl.addEventListener("pointerup", endStroke);
    canvasEl.addEventListener("pointercancel", endStroke);

    dockEl = document.createElement("div");
    dockEl.className = "dock";

    const tools: { id: DrawTool; title: string; svg: string }[] = [
      { id: "pen", title: "Lápiz orgánico (soporta presión de tableta)", svg: SVG_PEN },
      { id: "highlighter", title: "Resaltador", svg: SVG_HL },
      { id: "arrow", title: "Flecha", svg: SVG_ARROW },
      { id: "rect", title: "Rectángulo", svg: SVG_RECT },
      { id: "cursor", title: "Cursor (interactuar con la página manteniendo dibujos)", svg: SVG_CURSOR },
    ];

    for (const t of tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.tool = t.id;
      btn.title = t.title;
      btn.innerHTML = t.svg;
      btn.addEventListener("click", () => {
        tool = t.id;
        syncDockUI();
      });
      dockEl.appendChild(btn);
    }

    const sep1 = document.createElement("span");
    sep1.className = "sep";
    dockEl.appendChild(sep1);

    for (const c of COLORS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch";
      sw.dataset.color = c.hex;
      sw.title = c.label;
      sw.style.background = c.hex;
      sw.addEventListener("click", () => {
        color = c.hex;
        if (tool === "cursor") tool = "pen";
        syncDockUI();
      });
      dockEl.appendChild(sw);
    }

    const sep2 = document.createElement("span");
    sep2.className = "sep";
    dockEl.appendChild(sep2);

    const btnUndo = document.createElement("button");
    btnUndo.type = "button";
    btnUndo.className = "tool-btn";
    btnUndo.title = "Deshacer (Ctrl+Z)";
    btnUndo.innerHTML = SVG_UNDO;
    btnUndo.addEventListener("click", () => {
      if (strokes.length > 0) {
        strokes.pop();
        redraw();
      }
    });

    const btnClear = document.createElement("button");
    btnClear.type = "button";
    btnClear.className = "tool-btn";
    btnClear.title = "Borrar todos los trazos";
    btnClear.innerHTML = SVG_TRASH;
    btnClear.addEventListener("click", () => {
      strokes = [];
      redraw();
    });

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "tool-btn is-close";
    btnClose.title = "Salir de dibujo (Esc)";
    btnClose.innerHTML = SVG_CLOSE;
    btnClose.addEventListener("click", () => close());

    dockEl.append(btnUndo, btnClear, btnClose);

    shadow.append(style, canvasEl, dockEl);
    document.documentElement.appendChild(hostEl);
    resizeCanvas();
    syncDockUI();
  }

  function open() {
    if (active) return;
    active = true;
    tool = "pen";
    ensureDom();
    if (hostEl) hostEl.style.display = "block";
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("keydown", onKeyDown, true);
    resizeCanvas();
    syncDockUI();
    onStateChange?.(true);
  }

  function close() {
    if (!active) return;
    active = false;
    currentStroke = null;
    strokes = [];
    redraw();
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
      canvasEl = null;
      ctx = null;
      dockEl = null;
    }
    window.removeEventListener("resize", resizeCanvas);
    window.removeEventListener("keydown", onKeyDown, true);
    onStateChange?.(false);
  }

  return {
    open,
    close,
    toggle() {
      if (active) {
        close();
        return false;
      }
      open();
      return true;
    },
    isOpen() {
      return active;
    },
  };
}
