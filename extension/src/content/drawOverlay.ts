/**
 * Pizarra de dibujo invisible (estilo Epic Pen + trazos orgánicos Excalidraw)
 * con 7 bloques cuadrados flotantes Bauhaus (`42×42`) que emergen directamente
 * del lanzador principal con animación escalonada y orientación inteligente.
 *
 * Bloques flotantes:
 *  1. Lápiz | 2. Formas (Resaltador/Flecha/Rect) | 3. Borrador | 4. Cursor
 *  5. Color + Grosor (slider vertical) | 6. Páginas (1/2) + Fondo sólido | 7. Deshacer
 *  (Clic en el lanzador Ocre o `Esc` cierra el modo dibujo).
 */

type DrawTool = "pen" | "highlighter" | "arrow" | "rect" | "eraser" | "cursor";
type ShapeTool = "highlighter" | "arrow" | "rect";

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

interface Stroke {
  tool: "pen" | "highlighter" | "arrow" | "rect";
  color: string;
  width: number;
  isPen: boolean;
  points: StrokePoint[];
}

interface PersistedDrawState {
  active: boolean;
  tool: DrawTool;
  color: string;
  strokeSize: number; // 1..10
  pages: Stroke[][];
  pageBackdrops?: boolean[];
  backdropColor?: string;
  pageIndex: number;
}

export interface DrawOverlayHandle {
  open(): void;
  close(): void;
  toggle(): boolean;
  isOpen(): boolean;
  syncAnchor(): void;
}

const DRAW_HOST_ID = "reco-draw-host";
const DRAW_STORAGE_KEY = "reco_ext_draw_state_v2";
const TILE_SIZE = 42;
const TILE_GAP = 6;
const TILE_STEP = TILE_SIZE + TILE_GAP;
const EDGE_MARGIN = 10;

const COLORS = [
  { hex: "#2EE6C5", label: "Menta" },
  { hex: "#F05A28", label: "Bermellón" },
  { hex: "#F4B41A", label: "Ocre" },
  { hex: "#8B6EFF", label: "Violeta" },
  { hex: "#EAE5D9", label: "Hueso" },
];

const BG_PRESETS = [
  { hex: "#09090B", label: "Negro puro" },
  { hex: "#141A18", label: "Pizarra oscura" },
  { hex: "#0B1220", label: "Azul noche" },
  { hex: "#EAE5D9", label: "Papel hueso" },
  { hex: "#FFFFFF", label: "Blanco" },
];

function isLightHex(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 155;
}

const SVG_PEN = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.5V21h3.5L18.4 9.1l-3.5-3.5L3 17.5ZM21 6.5 17.5 3l-1.8 1.8 3.5 3.5L21 6.5Z"/></svg>`;
const SVG_HL = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M4 15.5 14.5 5l4.5 4.5L8.5 20H4v-4.5Z"/><rect x="13" y="18" width="8" height="2.5"/></svg>`;
const SVG_ARROW = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><polygon points="6.2,19.4 4.6,17.8 14.4,8 9,8 9,5.5 18.5,5.5 18.5,15 16,15 16,9.6"/></svg>`;
const SVG_RECT = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3V5Zm2.4 2.4v9.2h13.2V7.4H5.4Z"/></svg>`;
const SVG_ERASER = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M16.2 3.8 20.2 7.8a1.5 1.5 0 0 1 0 2.1L11.6 18.5H6.2l-2.4-2.4a1.5 1.5 0 0 1 0-2.1l10.3-10.2a1.5 1.5 0 0 1 2.1 0ZM10.6 16.3l3.1-3.1-3.9-3.9-3.7 3.7 2.8 3.3h1.7Z"/><rect x="3" y="19.5" width="18" height="2"/></svg>`;
const SVG_CURSOR = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 5,19 9.8,14.6 13.4,21 15.8,19.7 12.2,13.4 18.5,13.4"/></svg>`;
const SVG_UNDO = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><polygon points="3.5,9.5 10.5,4 10.5,8 19.5,8 19.5,19 11,19 11,16.2 16.7,16.2 16.7,10.8 10.5,10.8 10.5,15"/></svg>`;
const SVG_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="8.5" y="3" width="7" height="2.2"/><rect x="3.5" y="6.2" width="17" height="2.2"/><path d="M5.5 9.5h13l-1.2 11.5H6.7L5.5 9.5Z"/></svg>`;
const SVG_PREV = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="15,4 7,12 15,20"/></svg>`;
const SVG_NEXT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="9,4 17,12 9,20"/></svg>`;
const SVG_PLUS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="10.5" y="4" width="3" height="16"/><rect x="4" y="10.5" width="16" height="3"/></svg>`;
const SVG_BOARD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18"/></svg>`;

const SHAPE_SVGS: Record<ShapeTool, string> = {
  highlighter: SVG_HL,
  arrow: SVG_ARROW,
  rect: SVG_RECT,
};

function widthForTool(tool: DrawTool, level: number): number {
  const n = Math.max(1, Math.min(10, level));
  switch (tool) {
    case "pen":
      return 2.2 + n * 1.45;
    case "highlighter":
      return 8 + n * 3.2;
    case "arrow":
      return 1.6 + n * 0.78;
    case "rect":
      return 1.4 + n * 0.72;
    case "eraser":
      return 10 + n * 3.4;
    default:
      return 4;
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHitByEraser(s: Stroke, ex: number, ey: number, radius: number): boolean {
  const hitR = radius + s.width * 0.5;
  const pts = s.points;
  if (pts.length === 0) return false;

  if (s.tool === "rect" && pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    return (
      distToSegment(ex, ey, x1, y1, x2, y1) <= hitR ||
      distToSegment(ex, ey, x2, y1, x2, y2) <= hitR ||
      distToSegment(ex, ey, x2, y2, x1, y2) <= hitR ||
      distToSegment(ex, ey, x1, y2, x1, y1) <= hitR
    );
  }

  if (s.tool === "arrow" && pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    return distToSegment(ex, ey, a.x, a.y, b.x, b.y) <= hitR + 4;
  }

  if (pts.length === 1) {
    return Math.hypot(ex - pts[0].x, ey - pts[0].y) <= hitR;
  }

  for (let i = 1; i < pts.length; i += 1) {
    if (distToSegment(ex, ey, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= hitR) {
      return true;
    }
  }
  return false;
}

function drawFreehandInk(
  ctx: CanvasRenderingContext2D,
  rawPoints: StrokePoint[],
  baseSize: number,
  isPen: boolean,
) {
  if (rawPoints.length === 0) return;

  if (rawPoints.length === 1) {
    const p = rawPoints[0];
    const r = Math.max(1.2, baseSize * (isPen ? 0.3 + p.pressure * 0.6 : 0.48));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

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
      const dt = Math.max(4, cur.t - prev.t);
      const speed = Math.hypot(cur.x - prev.x, cur.y - prev.y) / dt;
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

    const nx = -ty;
    const ny = tx;

    let taper = 1;
    if (p.cumDist < taperStartLen) {
      const k = p.cumDist / Math.max(1, taperStartLen);
      taper = Math.min(taper, 0.28 + 0.72 * Math.sin((k * Math.PI) / 2));
    }
    const distFromEnd = totalLen - p.cumDist;
    if (distFromEnd < taperEndLen) {
      const k = distFromEnd / Math.max(1, taperEndLen);
      taper = Math.min(taper, 0.08 + 0.92 * Math.pow(k, 0.65));
    }

    const pressureScale = isPen
      ? 0.22 + Math.pow(p.pressure, 0.85) * 1.15
      : 0.42 + p.pressure * 0.72;

    const radius = Math.max(0.45, baseSize * 0.5 * pressureScale * taper);

    leftPts.push({ x: p.x + nx * radius, y: p.y + ny * radius });
    rightPts.push({ x: p.x - nx * radius, y: p.y - ny * radius });
  }

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

export function createDrawOverlay(
  onStateChange?: (open: boolean) => void,
  getAnchorRect?: () => DOMRect | null,
): DrawOverlayHandle {
  let active = false;
  let tool: DrawTool = "pen";
  let lastShapeTool: ShapeTool = "arrow";
  let color = COLORS[0].hex;
  let strokeSize = 4; // 1..10
  let pages: Stroke[][] = [[]];
  let pageBackdrops: boolean[] = [false];
  let backdropColor = "#09090B";
  let pageIndex = 0;
  let undoStacks: Stroke[][][] = [[]];

  let currentStroke: Stroke | null = null;
  let isErasing = false;
  let eraserSnapshotSaved = false;
  let eraserCursor: { x: number; y: number } | null = null;
  let openPopover: "shapes" | "style" | "page" | null = null;
  let ignoreStorageWrite = false;

  let hostEl: HTMLDivElement | null = null;
  let canvasEl: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let anchorWrapEl: HTMLDivElement | null = null;
  let tileSlots: HTMLDivElement[] = [];

  let shapeBtnEl: HTMLButtonElement | null = null;
  let shapesPopEl: HTMLDivElement | null = null;

  let stylePopEl: HTMLDivElement | null = null;
  let styleDotEl: HTMLSpanElement | null = null;
  let sizeValEl: HTMLSpanElement | null = null;
  let sizeFillEl: HTMLDivElement | null = null;
  let sizeThumbEl: HTMLDivElement | null = null;

  let pagePopEl: HTMLDivElement | null = null;
  let pageBtnEl: HTMLButtonElement | null = null;
  let pageLabelEl: HTMLSpanElement | null = null;
  let popPageLabelEl: HTMLSpanElement | null = null;
  let prevPageBtn: HTMLButtonElement | null = null;
  let nextPageBtn: HTMLButtonElement | null = null;
  let bgToggleBtn: HTMLButtonElement | null = null;
  let bgCustomInput: HTMLInputElement | null = null;
  let inkCustomInput: HTMLInputElement | null = null;

  function currentStrokes(): Stroke[] {
    if (!pages[pageIndex]) pages[pageIndex] = [];
    return pages[pageIndex];
  }

  function pushUndoSnapshot() {
    if (!undoStacks[pageIndex]) undoStacks[pageIndex] = [];
    const snap = currentStrokes().map((s) => ({ ...s, points: [...s.points] }));
    undoStacks[pageIndex].push(snap);
    if (undoStacks[pageIndex].length > 35) undoStacks[pageIndex].shift();
  }

  function performUndo() {
    const stack = undoStacks[pageIndex];
    if (stack && stack.length > 0) {
      pages[pageIndex] = stack.pop()!;
      redraw();
      persistState();
    } else if (currentStrokes().length > 0) {
      currentStrokes().pop();
      redraw();
      persistState();
    }
  }

  function persistState() {
    if (ignoreStorageWrite) return;
    const cappedPages = pages.slice(0, 20).map((p) => p.slice(-120));
    const cappedBgs = cappedPages.map((_, i) => Boolean(pageBackdrops[i]));
    const payload: PersistedDrawState = {
      active,
      tool,
      color,
      strokeSize,
      pages: cappedPages,
      pageBackdrops: cappedBgs,
      backdropColor,
      pageIndex: Math.min(Math.max(0, pageIndex), Math.max(0, cappedPages.length - 1)),
    };
    void chrome.storage.local.set({ [DRAW_STORAGE_KEY]: payload }).catch(() => {});
  }

  function applyPersistedState(saved: PersistedDrawState | undefined) {
    if (!saved) return;
    ignoreStorageWrite = true;
    try {
      tool = saved.tool || "pen";
      if (tool === "highlighter" || tool === "arrow" || tool === "rect") {
        lastShapeTool = tool;
      }
      color = saved.color || COLORS[0].hex;
      strokeSize = typeof saved.strokeSize === "number" ? Math.max(1, Math.min(10, saved.strokeSize)) : 4;
      pages = Array.isArray(saved.pages) && saved.pages.length > 0 ? saved.pages : [[]];
      backdropColor = typeof saved.backdropColor === "string" && saved.backdropColor ? saved.backdropColor : "#09090B";
      pageBackdrops = pages.map((_, i) => Boolean(saved.pageBackdrops?.[i]));
      pageIndex = Math.min(Math.max(0, saved.pageIndex || 0), pages.length - 1);
      while (undoStacks.length < pages.length) undoStacks.push([]);

      if (saved.active && !active) {
        open(true);
      } else if (!saved.active && active) {
        close(true);
      } else if (active) {
        syncAnchor();
        syncDockUI();
        redraw();
      }
    } finally {
      ignoreStorageWrite = false;
    }
  }

  function syncAnchor() {
    if (!anchorWrapEl || tileSlots.length === 0) return;
    const rect = getAnchorRect?.();
    const anchorLeft = rect ? rect.left : window.innerWidth - TILE_SIZE - 22;
    const anchorTop = rect ? rect.top : window.innerHeight - TILE_SIZE - 22;

    anchorWrapEl.style.left = `${Math.round(anchorLeft)}px`;
    anchorWrapEl.style.top = `${Math.round(anchorTop)}px`;

    const spaceTop = anchorTop;
    const spaceBottom = window.innerHeight - (anchorTop + TILE_SIZE);
    const spaceLeft = anchorLeft;
    const spaceRight = window.innerWidth - (anchorLeft + TILE_SIZE);

    const needed = TILE_STEP * tileSlots.length + EDGE_MARGIN;
    type Dir = "up" | "down" | "left" | "right";
    let dir: Dir = "up";

    if (spaceTop >= needed || spaceBottom >= needed) {
      dir = spaceTop >= spaceBottom ? "up" : "down";
    } else if (spaceLeft >= needed || spaceRight >= needed) {
      dir = spaceLeft >= spaceRight ? "left" : "right";
    } else {
      const candidates: [Dir, number][] = [
        ["up", spaceTop],
        ["down", spaceBottom],
        ["left", spaceLeft],
        ["right", spaceRight],
      ];
      candidates.sort((a, b) => b[1] - a[1]);
      dir = candidates[0][0];
    }

    const popSide =
      dir === "up" || dir === "down"
        ? spaceLeft >= spaceRight
          ? "left"
          : "right"
        : spaceTop >= spaceBottom
          ? "top"
          : "bottom";

    tileSlots.forEach((slot, idx) => {
      const dist = TILE_STEP * (idx + 1);
      let tx = 0;
      let ty = 0;
      if (dir === "up") ty = -dist;
      else if (dir === "down") ty = dist;
      else if (dir === "left") tx = -dist;
      else tx = dist;

      const absLeft = anchorLeft + tx;
      const absTop = anchorTop + ty;
      const clampedLeft = Math.min(
        window.innerWidth - TILE_SIZE - EDGE_MARGIN,
        Math.max(EDGE_MARGIN, absLeft),
      );
      const clampedTop = Math.min(
        window.innerHeight - TILE_SIZE - EDGE_MARGIN,
        Math.max(EDGE_MARGIN, absTop),
      );
      tx = Math.round(clampedLeft - anchorLeft);
      ty = Math.round(clampedTop - anchorTop);

      slot.style.setProperty("--tx", `${tx}px`);
      slot.style.setProperty("--ty", `${ty}px`);
      slot.dataset.popSide = popSide;
    });
  }

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
    syncAnchor();
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
      const headLen = Math.max(11, s.width * 3.4);

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

    const hasBackdrop = Boolean(pageBackdrops[pageIndex]);
    if (hasBackdrop) {
      ctx.save();
      ctx.fillStyle = backdropColor;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.restore();
    }

    for (const s of currentStrokes()) drawStroke(s);
    if (currentStroke) drawStroke(currentStroke);

    if (tool === "eraser" && eraserCursor) {
      const r = widthForTool("eraser", strokeSize);
      ctx.save();
      ctx.strokeStyle = hasBackdrop && isLightHex(backdropColor) ? "#09090B" : "#EAE5D9";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(eraserCursor.x, eraserCursor.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function syncDockUI() {
    if (!anchorWrapEl || !canvasEl) return;
    canvasEl.style.pointerEvents = tool === "cursor" ? "none" : "auto";
    canvasEl.style.cursor =
      tool === "cursor" ? "default" : tool === "eraser" ? "none" : "crosshair";

    const isShapeActive = tool === "highlighter" || tool === "arrow" || tool === "rect";

    anchorWrapEl.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tool === tool);
    });

    if (shapeBtnEl) {
      shapeBtnEl.innerHTML = `${SHAPE_SVGS[lastShapeTool]}<span class="sub-caret"></span>`;
      shapeBtnEl.classList.toggle("is-active", isShapeActive);
    }

    shapesPopEl?.classList.toggle("is-open", openPopover === "shapes");
    stylePopEl?.classList.toggle("is-open", openPopover === "style");
    pagePopEl?.classList.toggle("is-open", openPopover === "page");

    // Elevate slot with open popover above sibling tiles
    tileSlots.forEach((slot) => {
      const pop = slot.querySelector(".pop");
      slot.classList.toggle("has-open-pop", Boolean(pop?.classList.contains("is-open")));
    });

    const pct = ((strokeSize - 1) / 9) * 100;
    if (sizeFillEl) {
      sizeFillEl.style.height = `${pct}%`;
      sizeFillEl.style.background = color;
    }
    if (sizeThumbEl) sizeThumbEl.style.bottom = `calc(${pct}% - 5px)`;
    if (sizeValEl) sizeValEl.textContent = String(strokeSize);
    if (styleDotEl) {
      const px = Math.round(7 + (strokeSize - 1) * 1.45);
      styleDotEl.style.width = `${px}px`;
      styleDotEl.style.height = `${px}px`;
      styleDotEl.style.background = color;
    }

    stylePopEl?.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.color?.toLowerCase() === color.toLowerCase());
    });
    if (inkCustomInput) inkCustomInput.value = color;

    const pgText = `${pageIndex + 1}/${pages.length}`;
    if (pageLabelEl) pageLabelEl.textContent = pgText;
    if (popPageLabelEl) popPageLabelEl.textContent = `${pageIndex + 1} / ${pages.length}`;
    if (prevPageBtn) prevPageBtn.disabled = pageIndex <= 0;
    if (nextPageBtn) nextPageBtn.disabled = pageIndex >= pages.length - 1;

    const bgOn = Boolean(pageBackdrops[pageIndex]);
    if (pageBtnEl) pageBtnEl.classList.toggle("has-bg", bgOn);
    if (bgToggleBtn) {
      bgToggleBtn.classList.toggle("is-active", bgOn);
      bgToggleBtn.innerHTML = `${SVG_BOARD}<span>${bgOn ? "Fondo ON" : "Fondo OFF"}</span>`;
    }
    pagePopEl?.querySelectorAll<HTMLButtonElement>("[data-bg]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.bg?.toLowerCase() === backdropColor.toLowerCase());
    });
    if (bgCustomInput) bgCustomInput.value = backdropColor;
  }

  function eraseAt(x: number, y: number) {
    const radius = widthForTool("eraser", strokeSize);
    const list = currentStrokes();
    const kept = list.filter((s) => !strokeHitByEraser(s, x, y, radius));
    if (kept.length !== list.length) {
      if (!eraserSnapshotSaved) {
        pushUndoSnapshot();
        eraserSnapshotSaved = true;
      }
      pages[pageIndex] = kept;
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (openPopover) {
        openPopover = null;
        syncDockUI();
      } else {
        close(false);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      performUndo();
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
      :host { all: initial; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
      canvas {
        position: fixed;
        inset: 0;
        display: block;
        touch-action: none;
      }

      /* Floating 42x42 Bauhaus square tiles anchored directly to the launcher */
      .anchor-wrap {
        position: fixed;
        width: ${TILE_SIZE}px;
        height: ${TILE_SIZE}px;
        pointer-events: none;
      }
      .tile-slot {
        position: absolute;
        top: 0;
        left: 0;
        width: ${TILE_SIZE}px;
        height: ${TILE_SIZE}px;
        pointer-events: none;
        opacity: 0;
        transform: translate(0px, 0px) scale(0.45) rotate(-10deg);
        transition:
          transform 220ms cubic-bezier(0.22, 1.32, 0.36, 1),
          opacity 140ms ease;
      }
      .anchor-wrap.is-open .tile-slot {
        opacity: 1;
        transform: translate(var(--tx, 0px), var(--ty, 0px)) scale(1) rotate(0deg);
      }
      .tile-slot.has-open-pop { z-index: 20; }

      .anchor-wrap.is-open .tile-slot:nth-child(1) { transition-delay: 0ms; }
      .anchor-wrap.is-open .tile-slot:nth-child(2) { transition-delay: 28ms; }
      .anchor-wrap.is-open .tile-slot:nth-child(3) { transition-delay: 56ms; }
      .anchor-wrap.is-open .tile-slot:nth-child(4) { transition-delay: 84ms; }
      .anchor-wrap.is-open .tile-slot:nth-child(5) { transition-delay: 112ms; }
      .anchor-wrap.is-open .tile-slot:nth-child(6) { transition-delay: 140ms; }
      .anchor-wrap.is-open .tile-slot:nth-child(7) { transition-delay: 168ms; }

      .tile-btn {
        position: relative;
        pointer-events: auto;
        width: ${TILE_SIZE}px;
        height: ${TILE_SIZE}px;
        padding: 0;
        margin: 0;
        border-radius: 4px;
        border: 1.75px solid #eae5d9;
        background: #09090b;
        color: #eae5d9;
        display: grid;
        place-items: center;
        cursor: pointer;
        box-shadow: 3px 3px 0 #000000;
        user-select: none;
        transition: transform 90ms ease, background 100ms ease, border-color 100ms ease, box-shadow 90ms ease;
      }
      .tile-btn:hover {
        transform: translate(-1px, -1px);
        box-shadow: 4px 4px 0 #000000;
        background: #17171d;
      }
      .tile-btn:active {
        transform: translate(1px, 1px);
        box-shadow: 1px 1px 0 #000000;
      }
      .tile-btn.is-active {
        background: #f4b41a;
        border-color: #09090b;
        color: #09090b;
      }
      .tile-btn.has-bg {
        border-color: #2ee6c5;
      }
      .sub-caret {
        position: absolute;
        right: 3px;
        bottom: 3px;
        width: 0;
        height: 0;
        border-left: 5px solid transparent;
        border-bottom: 5px solid currentColor;
        opacity: 0.72;
      }
      .style-dot {
        display: block;
        border-radius: 50%;
        border: 1.5px solid #09090b;
      }
      .pg-tile-inner {
        display: grid;
        place-items: center;
        font-size: 11.5px;
        font-weight: 800;
        letter-spacing: 0.03em;
        line-height: 1;
      }

      /* Smartly positioned Brutalist Popovers */
      .pop {
        position: absolute;
        pointer-events: none;
        opacity: 0;
        padding: 7px;
        border-radius: 3px;
        background: #09090b;
        border: 1.75px solid #eae5d9;
        box-shadow: 3px 3px 0 #000000;
        transition: opacity 110ms ease, transform 110ms ease;
      }
      .tile-slot[data-pop-side="left"] .pop {
        right: calc(100% + 10px);
        top: 50%;
        transform: translateY(-50%) scale(0.92);
      }
      .tile-slot[data-pop-side="left"] .pop.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(-50%) scale(1);
      }
      .tile-slot[data-pop-side="right"] .pop {
        left: calc(100% + 10px);
        top: 50%;
        transform: translateY(-50%) scale(0.92);
      }
      .tile-slot[data-pop-side="right"] .pop.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(-50%) scale(1);
      }
      .tile-slot[data-pop-side="top"] .pop {
        bottom: calc(100% + 10px);
        left: 50%;
        transform: translateX(-50%) scale(0.92);
      }
      .tile-slot[data-pop-side="top"] .pop.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateX(-50%) scale(1);
      }
      .tile-slot[data-pop-side="bottom"] .pop {
        top: calc(100% + 10px);
        left: 50%;
        transform: translateX(-50%) scale(0.92);
      }
      .tile-slot[data-pop-side="bottom"] .pop.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateX(-50%) scale(1);
      }

      .shapes-pop {
        display: flex;
        gap: 5px;
      }
      .mini-btn {
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 2px;
        border: 1.5px solid #262630;
        background: #141418;
        color: #eae5d9;
        cursor: pointer;
      }
      .mini-btn:hover:not(:disabled) { border-color: #eae5d9; background: #1f1f26; }
      .mini-btn:disabled { opacity: 0.3; cursor: not-allowed; }
      .mini-btn.is-active { background: #f4b41a; border-color: #f4b41a; color: #09090b; }

      .style-pop {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 8px 9px;
      }
      .slider-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
      }
      .size-track {
        position: relative;
        width: 16px;
        height: 118px;
        display: flex;
        justify-content: center;
        cursor: pointer;
        touch-action: none;
      }
      .size-rail {
        position: relative;
        width: 4px;
        height: 100%;
        background: #24242c;
        border: 1px solid #383844;
      }
      .size-fill {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: #2ee6c5;
      }
      .size-thumb {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: 14px;
        height: 10px;
        background: #eae5d9;
        border: 1.5px solid #09090b;
        box-shadow: 1px 1px 0 #000;
        pointer-events: none;
      }
      .size-val {
        font-size: 9.5px;
        font-weight: 800;
        color: #eae5d9;
      }
      .colors-col {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .swatch {
        width: 19px;
        height: 19px;
        padding: 0;
        border-radius: 2px;
        border: 1.5px solid #32323c;
        cursor: pointer;
        transition: transform 90ms ease;
      }
      .swatch:hover { transform: scale(1.12); }
      .swatch.is-active {
        outline: 2px solid #eae5d9;
        outline-offset: 1px;
      }

      .page-pop {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 152px;
      }
      .pop-row {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .pop-pg-num {
        flex: 1;
        text-align: center;
        font-size: 11.5px;
        font-weight: 800;
        color: #eae5d9;
        letter-spacing: 0.06em;
        white-space: nowrap;
      }
      .mini-btn.is-mint {
        border-color: #2ee6c5;
        color: #2ee6c5;
      }
      .mini-btn.is-mint:hover {
        background: #2ee6c5;
        border-color: #2ee6c5;
        color: #09090b;
      }
      .pop-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 5px 7px;
        border-radius: 2px;
        border: 1.5px solid #2c2c36;
        background: #141418;
        color: #eae5d9;
        font-family: inherit;
        font-size: 9.5px;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        cursor: pointer;
        white-space: nowrap;
      }
      .pop-btn:hover:not(:disabled) { border-color: #eae5d9; background: #1f1f26; }
      .pop-btn:disabled { opacity: 0.3; cursor: not-allowed; }
      .pop-btn.is-mint { border-color: #2ee6c5; color: #2ee6c5; }
      .pop-btn.is-mint:hover { background: #2ee6c5; color: #09090b; }
      .pop-btn.is-active { background: #f4b41a; border-color: #f4b41a; color: #09090b; }
      .pop-btn.is-danger:hover { background: #f05a28; border-color: #f05a28; color: #09090b; }
      .bg-custom-label {
        position: relative;
        display: grid;
        place-items: center;
        width: 19px;
        height: 19px;
        border-radius: 2px;
        border: 1.5px solid #eae5d9;
        background: #1a1a22;
        color: #eae5d9;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
        overflow: hidden;
      }
      .bg-custom-label input {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
        width: 100%;
        height: 100%;
        padding: 0;
        border: none;
      }
    `;

    canvasEl = document.createElement("canvas");
    ctx = canvasEl.getContext("2d");

    canvasEl.addEventListener("pointerdown", (e) => {
      if (openPopover) {
        openPopover = null;
        syncDockUI();
      }
      if (tool === "cursor" || e.button !== 0 || !canvasEl) return;
      e.preventDefault();
      try {
        canvasEl.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (tool === "eraser") {
        isErasing = true;
        eraserSnapshotSaved = false;
        eraserCursor = { x: e.clientX, y: e.clientY };
        eraseAt(e.clientX, e.clientY);
        redraw();
        return;
      }

      const isPen = e.pointerType === "pen";
      const width = widthForTool(tool, strokeSize);
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
      if (tool === "eraser") {
        eraserCursor = { x: e.clientX, y: e.clientY };
        if (isErasing) eraseAt(e.clientX, e.clientY);
        redraw();
        return;
      }
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
        if (currentStroke.points.length === 1) currentStroke.points.push(pt);
        else currentStroke.points[1] = pt;
      }
      redraw();
    });

    canvasEl.addEventListener("pointerleave", () => {
      if (tool === "eraser" && !isErasing) {
        eraserCursor = null;
        redraw();
      }
    });

    const endPointer = (e: PointerEvent) => {
      if (!canvasEl) return;
      try {
        if (canvasEl.hasPointerCapture(e.pointerId)) canvasEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (isErasing) {
        isErasing = false;
        if (eraserSnapshotSaved) persistState();
        eraserSnapshotSaved = false;
        redraw();
        return;
      }
      if (!currentStroke) return;
      pushUndoSnapshot();
      currentStrokes().push(currentStroke);
      currentStroke = null;
      redraw();
      persistState();
    };

    canvasEl.addEventListener("pointerup", endPointer);
    canvasEl.addEventListener("pointercancel", endPointer);

    anchorWrapEl = document.createElement("div");
    anchorWrapEl.className = "anchor-wrap";

    const makeSlot = (...children: HTMLElement[]) => {
      const slot = document.createElement("div");
      slot.className = "tile-slot";
      slot.append(...children);
      return slot;
    };

    // 1. Pen tile
    const penBtn = document.createElement("button");
    penBtn.type = "button";
    penBtn.className = "tile-btn";
    penBtn.dataset.tool = "pen";
    penBtn.title = "Lápiz orgánico";
    penBtn.innerHTML = SVG_PEN;
    penBtn.addEventListener("click", () => {
      tool = "pen";
      eraserCursor = null;
      openPopover = null;
      syncDockUI();
      redraw();
      persistState();
    });

    // 2. Shapes / Highlighter tile + popover
    shapeBtnEl = document.createElement("button");
    shapeBtnEl.type = "button";
    shapeBtnEl.className = "tile-btn";
    shapeBtnEl.title = "Formas y marcador (Resaltador / Flecha / Rectángulo)";
    shapeBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tool !== lastShapeTool) {
        tool = lastShapeTool;
        eraserCursor = null;
        openPopover = "shapes";
        persistState();
      } else {
        openPopover = openPopover === "shapes" ? null : "shapes";
      }
      syncDockUI();
      redraw();
    });

    shapesPopEl = document.createElement("div");
    shapesPopEl.className = "pop shapes-pop";
    const shapeDefs: { id: ShapeTool; title: string; svg: string }[] = [
      { id: "highlighter", title: "Resaltador", svg: SVG_HL },
      { id: "arrow", title: "Flecha", svg: SVG_ARROW },
      { id: "rect", title: "Rectángulo", svg: SVG_RECT },
    ];
    for (const sd of shapeDefs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mini-btn";
      b.dataset.tool = sd.id;
      b.title = sd.title;
      b.innerHTML = sd.svg;
      b.addEventListener("click", () => {
        tool = sd.id;
        lastShapeTool = sd.id;
        eraserCursor = null;
        openPopover = null;
        syncDockUI();
        redraw();
        persistState();
      });
      shapesPopEl.appendChild(b);
    }

    // 3. Eraser tile
    const eraserBtn = document.createElement("button");
    eraserBtn.type = "button";
    eraserBtn.className = "tile-btn";
    eraserBtn.dataset.tool = "eraser";
    eraserBtn.title = "Borrador";
    eraserBtn.innerHTML = SVG_ERASER;
    eraserBtn.addEventListener("click", () => {
      tool = "eraser";
      openPopover = null;
      syncDockUI();
      redraw();
      persistState();
    });

    // 4. Cursor tile (click-through)
    const cursorBtn = document.createElement("button");
    cursorBtn.type = "button";
    cursorBtn.className = "tile-btn";
    cursorBtn.dataset.tool = "cursor";
    cursorBtn.title = "Cursor (interactuar con la página)";
    cursorBtn.innerHTML = SVG_CURSOR;
    cursorBtn.addEventListener("click", () => {
      tool = "cursor";
      eraserCursor = null;
      openPopover = null;
      syncDockUI();
      redraw();
      persistState();
    });

    // 5. Color + Vertical Thickness tile + popover
    const styleBtn = document.createElement("button");
    styleBtn.type = "button";
    styleBtn.className = "tile-btn";
    styleBtn.title = "Color y grosor del trazo";
    styleDotEl = document.createElement("span");
    styleDotEl.className = "style-dot";
    styleBtn.appendChild(styleDotEl);
    styleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPopover = openPopover === "style" ? null : "style";
      syncDockUI();
    });

    stylePopEl = document.createElement("div");
    stylePopEl.className = "pop style-pop";

    const sliderCol = document.createElement("div");
    sliderCol.className = "slider-col";
    const sizeTrack = document.createElement("div");
    sizeTrack.className = "size-track";
    const sizeRail = document.createElement("div");
    sizeRail.className = "size-rail";
    sizeFillEl = document.createElement("div");
    sizeFillEl.className = "size-fill";
    sizeRail.appendChild(sizeFillEl);
    sizeThumbEl = document.createElement("div");
    sizeThumbEl.className = "size-thumb";
    sizeTrack.append(sizeRail, sizeThumbEl);
    sizeValEl = document.createElement("span");
    sizeValEl.className = "size-val";
    sliderCol.append(sizeTrack, sizeValEl);

    const updateSizeFromClientY = (clientY: number) => {
      const rect = sizeTrack.getBoundingClientRect();
      const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const next = Math.max(1, Math.min(10, Math.round(1 + ratio * 9)));
      if (next !== strokeSize) {
        strokeSize = next;
        syncDockUI();
        redraw();
      }
    };

    let draggingSize = false;
    sizeTrack.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggingSize = true;
      try {
        sizeTrack.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      updateSizeFromClientY(e.clientY);
    });
    sizeTrack.addEventListener("pointermove", (e) => {
      if (draggingSize) updateSizeFromClientY(e.clientY);
    });
    const endSizeDrag = (e: PointerEvent) => {
      if (!draggingSize) return;
      draggingSize = false;
      try {
        if (sizeTrack.hasPointerCapture(e.pointerId)) sizeTrack.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      persistState();
    };
    sizeTrack.addEventListener("pointerup", endSizeDrag);
    sizeTrack.addEventListener("pointercancel", endSizeDrag);

    const colorsCol = document.createElement("div");
    colorsCol.className = "colors-col";
    for (const c of COLORS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch";
      sw.dataset.color = c.hex;
      sw.title = c.label;
      sw.style.background = c.hex;
      sw.addEventListener("click", () => {
        color = c.hex;
        if (tool === "cursor" || tool === "eraser") tool = "pen";
        syncDockUI();
        persistState();
      });
      colorsCol.appendChild(sw);
    }

    const inkCustomLabel = document.createElement("label");
    inkCustomLabel.className = "bg-custom-label";
    inkCustomLabel.title = "Color personalizado de trazo";
    inkCustomLabel.textContent = "+";
    inkCustomInput = document.createElement("input");
    inkCustomInput.type = "color";
    inkCustomInput.value = color;
    inkCustomInput.addEventListener("input", () => {
      color = inkCustomInput!.value;
      if (tool === "cursor" || tool === "eraser") tool = "pen";
      syncDockUI();
    });
    inkCustomInput.addEventListener("change", () => persistState());
    inkCustomLabel.appendChild(inkCustomInput);
    colorsCol.appendChild(inkCustomLabel);

    stylePopEl.append(sliderCol, colorsCol);

    // 6. Pages + Canvas Backdrop tile + popover (mouse wheel switches pages too!)
    pageBtnEl = document.createElement("button");
    pageBtnEl.type = "button";
    pageBtnEl.className = "tile-btn";
    pageBtnEl.title = "Páginas de trazos y fondo sólido (rueda del mouse cambia de página)";
    const pgInner = document.createElement("span");
    pgInner.className = "pg-tile-inner";
    pageLabelEl = document.createElement("span");
    pgInner.appendChild(pageLabelEl);
    pageBtnEl.appendChild(pgInner);
    pageBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      openPopover = openPopover === "page" ? null : "page";
      syncDockUI();
    });
    pageBtnEl.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.deltaY > 0 && pageIndex < pages.length - 1) {
          pageIndex += 1;
          syncDockUI();
          redraw();
          persistState();
        } else if (e.deltaY < 0 && pageIndex > 0) {
          pageIndex -= 1;
          syncDockUI();
          redraw();
          persistState();
        }
      },
      { passive: false },
    );

    pagePopEl = document.createElement("div");
    pagePopEl.className = "pop page-pop";

    const rowNav = document.createElement("div");
    rowNav.className = "pop-row";

    prevPageBtn = document.createElement("button");
    prevPageBtn.type = "button";
    prevPageBtn.className = "mini-btn";
    prevPageBtn.title = "Página anterior";
    prevPageBtn.innerHTML = SVG_PREV;
    prevPageBtn.addEventListener("click", () => {
      if (pageIndex > 0) {
        pageIndex -= 1;
        syncDockUI();
        redraw();
        persistState();
      }
    });

    popPageLabelEl = document.createElement("span");
    popPageLabelEl.className = "pop-pg-num";
    popPageLabelEl.title = "Página actual";

    nextPageBtn = document.createElement("button");
    nextPageBtn.type = "button";
    nextPageBtn.className = "mini-btn";
    nextPageBtn.title = "Página siguiente";
    nextPageBtn.innerHTML = SVG_NEXT;
    nextPageBtn.addEventListener("click", () => {
      if (pageIndex < pages.length - 1) {
        pageIndex += 1;
        syncDockUI();
        redraw();
        persistState();
      }
    });

    const addPgBtn = document.createElement("button");
    addPgBtn.type = "button";
    addPgBtn.className = "mini-btn is-mint";
    addPgBtn.title = "Nueva página en blanco";
    addPgBtn.innerHTML = SVG_PLUS;
    addPgBtn.addEventListener("click", () => {
      if (pages.length >= 20) return;
      pages.splice(pageIndex + 1, 0, []);
      pageBackdrops.splice(pageIndex + 1, 0, false);
      undoStacks.splice(pageIndex + 1, 0, []);
      pageIndex += 1;
      syncDockUI();
      redraw();
      persistState();
    });

    rowNav.append(prevPageBtn, popPageLabelEl, nextPageBtn, addPgBtn);

    const rowBgToggle = document.createElement("div");
    rowBgToggle.className = "pop-row";

    bgToggleBtn = document.createElement("button");
    bgToggleBtn.type = "button";
    bgToggleBtn.className = "pop-btn";
    bgToggleBtn.addEventListener("click", () => {
      pageBackdrops[pageIndex] = !pageBackdrops[pageIndex];
      syncDockUI();
      redraw();
      persistState();
    });

    const clearPgBtn = document.createElement("button");
    clearPgBtn.type = "button";
    clearPgBtn.className = "mini-btn";
    clearPgBtn.title = "Limpiar página (si está vacía la elimina)";
    clearPgBtn.innerHTML = SVG_TRASH;
    clearPgBtn.addEventListener("click", () => {
      if (currentStrokes().length > 0) {
        pushUndoSnapshot();
        pages[pageIndex] = [];
      } else if (pages.length > 1) {
        pages.splice(pageIndex, 1);
        pageBackdrops.splice(pageIndex, 1);
        undoStacks.splice(pageIndex, 1);
        pageIndex = Math.max(0, pageIndex - 1);
      }
      syncDockUI();
      redraw();
      persistState();
    });

    rowBgToggle.append(bgToggleBtn, clearPgBtn);

    const rowBgColors = document.createElement("div");
    rowBgColors.className = "pop-row";
    rowBgColors.style.justifyContent = "space-between";
    for (const preset of BG_PRESETS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch";
      sw.dataset.bg = preset.hex;
      sw.title = preset.label;
      sw.style.background = preset.hex;
      sw.addEventListener("click", () => {
        backdropColor = preset.hex;
        pageBackdrops[pageIndex] = true;
        syncDockUI();
        redraw();
        persistState();
      });
      rowBgColors.appendChild(sw);
    }

    const customLabel = document.createElement("label");
    customLabel.className = "bg-custom-label";
    customLabel.title = "Color personalizado de fondo";
    customLabel.textContent = "+";
    bgCustomInput = document.createElement("input");
    bgCustomInput.type = "color";
    bgCustomInput.value = backdropColor;
    bgCustomInput.addEventListener("input", () => {
      backdropColor = bgCustomInput!.value;
      pageBackdrops[pageIndex] = true;
      syncDockUI();
      redraw();
    });
    bgCustomInput.addEventListener("change", () => persistState());
    customLabel.appendChild(bgCustomInput);
    rowBgColors.appendChild(customLabel);

    pagePopEl.append(rowNav, rowBgToggle, rowBgColors);

    // 7. Undo tile
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "tile-btn";
    undoBtn.title = "Deshacer (Ctrl+Z)";
    undoBtn.innerHTML = SVG_UNDO;
    undoBtn.addEventListener("click", () => performUndo());

    tileSlots = [
      makeSlot(penBtn),
      makeSlot(shapeBtnEl, shapesPopEl),
      makeSlot(eraserBtn),
      makeSlot(cursorBtn),
      makeSlot(styleBtn, stylePopEl),
      makeSlot(pageBtnEl, pagePopEl),
      makeSlot(undoBtn),
    ];

    anchorWrapEl.append(...tileSlots);
    shadow.append(style, canvasEl, anchorWrapEl);
    document.documentElement.appendChild(hostEl);
    resizeCanvas();
    syncDockUI();

    // Trigger staggered spring-out animation on next frame
    requestAnimationFrame(() => {
      anchorWrapEl?.classList.add("is-open");
    });
  }

  function open(fromSync = false) {
    if (active) return;
    active = true;
    if (!fromSync && tool === "cursor") tool = "pen";
    ensureDom();
    if (hostEl) hostEl.style.display = "block";
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("keydown", onKeyDown, true);
    resizeCanvas();
    syncDockUI();
    onStateChange?.(true);
    if (!fromSync) persistState();
  }

  function close(fromSync = false) {
    if (!active) return;
    active = false;
    openPopover = null;
    currentStroke = null;
    isErasing = false;
    eraserCursor = null;
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
      canvasEl = null;
      ctx = null;
      anchorWrapEl = null;
      tileSlots = [];
      shapesPopEl = null;
      stylePopEl = null;
      pagePopEl = null;
    }
    window.removeEventListener("resize", resizeCanvas);
    window.removeEventListener("keydown", onKeyDown, true);
    onStateChange?.(false);
    if (!fromSync) persistState();
  }

  void chrome.storage.local
    .get(DRAW_STORAGE_KEY)
    .then((data) => {
      applyPersistedState(data[DRAW_STORAGE_KEY] as PersistedDrawState | undefined);
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[DRAW_STORAGE_KEY]) return;
    if (currentStroke || isErasing) return;
    applyPersistedState(changes[DRAW_STORAGE_KEY].newValue as PersistedDrawState | undefined);
  });

  return {
    open: () => open(false),
    close: () => close(false),
    toggle() {
      if (active) {
        close(false);
        return false;
      }
      open(false);
      return true;
    },
    isOpen() {
      return active;
    },
    syncAnchor,
  };
}
