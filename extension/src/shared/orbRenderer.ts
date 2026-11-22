/**
 * Emblema geométrico dinámico plano estilo Bauhaus / Neo-Brutalist para RECO (Canvas 2D).
 *
 * Cero degradados, cero blur: placa cuadrada plana con borde nítido y figuras
 * geométricas dinámicas inspiradas en el diseño Bauhaus / brutalista y Claude:
 *  - idle:      obsidiana (#09090B) con borde menta (#2EE6C5) + marca Bauhaus (semicírculo/cuadro)
 *  - dictation: menta (#2EE6C5) con morphing cinético entre 3 figuras geométricas reactivas a la voz:
 *               (1) Sunburst radial de 12 rayos, (2) Cuadrados concéntricos rotatorios,
 *               (3) Reloj de arena / triángulos opuestos
 *  - inserting: hueso (#F5F1E8) con cruz/estrella Bauhaus expansiva al insertar texto
 *  - recording: bermellón (#F05A28) con cuadrados concéntricos pulsantes + visor REC
 *  - paused:    ocre (#F4B41A) con dos monolitos/arcos verticales Bauhaus
 *  - uploading: violeta (#8B6EFF) con triángulos apilados ascendentes en bucle
 */

export type OrbVisualState =
  | "idle"
  | "menu"
  | "starting"
  | "dictation"
  | "speaking"
  | "inserting"
  | "error"
  | "recording"
  | "paused"
  | "uploading";

export interface OrbHandle {
  setState(state: OrbVisualState): void;
  setLevel(level: number): void;
  dispose(): void;
}

type Rgb = [number, number, number];

interface FlatPalette {
  bg: Rgb;
  fg: Rgb;
  border: Rgb;
  accent: Rgb;
}

const PALETTES: Record<OrbVisualState, FlatPalette> = {
  idle: {
    bg: [9, 9, 11], // #09090B obsidian
    fg: [234, 229, 217], // #EAE5D9 warm bone
    border: [46, 230, 197], // #2EE6C5 signature mint accent
    accent: [46, 230, 197],
  },
  menu: {
    bg: [234, 229, 217], // #EAE5D9 warm bone (high-contrast open-eye flip)
    fg: [9, 9, 11], // #09090B ink
    border: [9, 9, 11],
    accent: [46, 230, 197], // #2EE6C5 mint iris
  },
  starting: {
    bg: [9, 9, 11], // #09090B obsidian booting mic
    fg: [46, 230, 197], // #2EE6C5 mint loader
    border: [46, 230, 197],
    accent: [234, 229, 217],
  },
  dictation: {
    bg: [46, 230, 197], // #2EE6C5 vivid flat mint (listening / waiting for voice)
    fg: [9, 9, 11], // #09090B ink
    border: [9, 9, 11],
    accent: [245, 241, 232],
  },
  speaking: {
    bg: [46, 230, 197], // #2EE6C5 vivid flat mint (actively capturing speech)
    fg: [9, 9, 11], // #09090B ink
    border: [9, 9, 11],
    accent: [245, 241, 232],
  },
  inserting: {
    bg: [245, 241, 232], // #F5F1E8 bone paper flash
    fg: [9, 9, 11],
    border: [9, 9, 11],
    accent: [46, 230, 197],
  },
  error: {
    bg: [240, 90, 40], // #F05A28 signal vermilion alert
    fg: [9, 9, 11],
    border: [9, 9, 11],
    accent: [245, 241, 232],
  },
  recording: {
    bg: [240, 90, 40], // #F05A28 signal vermilion
    fg: [9, 9, 11],
    border: [9, 9, 11],
    accent: [245, 241, 232],
  },
  paused: {
    bg: [244, 180, 26], // #F4B41A bauhaus ochre
    fg: [9, 9, 11],
    border: [9, 9, 11],
    accent: [245, 241, 232],
  },
  uploading: {
    bg: [139, 110, 255], // #8B6EFF bauhaus violet
    fg: [9, 9, 11],
    border: [9, 9, 11],
    accent: [245, 241, 232],
  },
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function lerpAngle(cur: number, tgt: number, k: number): number {
  let diff = ((tgt - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return cur + diff * k;
}

function lerpRgb(cur: Rgb, tgt: Rgb, k: number): Rgb {
  return [lerp(cur[0], tgt[0], k), lerp(cur[1], tgt[1], k), lerp(cur[2], tgt[2], k)];
}

function rgbStr(c: Rgb, alpha?: number): string {
  const r = Math.round(c[0]);
  const g = Math.round(c[1]);
  const b = Math.round(c[2]);
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function mountOrb(
  canvas: HTMLCanvasElement,
  size: number,
  initial: OrbVisualState = "idle",
  zoom = 1,
): OrbHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { setState: () => {}, setLevel: () => {}, dispose: () => {} };
  }

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const C = size / 2;
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  let curPalette: FlatPalette = structuredClone(PALETTES[initial]);
  let targetPalette: FlatPalette = PALETTES[initial];

  let currentState: OrbVisualState = initial;
  let levelTarget = 0;
  let level = 0;
  let stateBlend = 1;
  let t = 0;
  let last = performance.now();
  let raf = 0;
  let alive = true;

  // 360° cursor gaze tracking for the idle & menu geometric eye
  let hasPointer = false;
  let targetGazeAngle = 0;
  let currentGazeAngle = 0;
  let targetGazePull = 0.55;
  let currentGazePull = 0.55;
  let targetLookX = 0;
  let targetLookY = 0;
  let currentLookX = 0;
  let currentLookY = 0;

  const updatePointerCoords = (clientX: number, clientY: number, exiting = false) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > 2) {
      hasPointer = true;
      const rawAngle = Math.atan2(dy, dx);
      // Local idle glyph points downward (+PI/2), so align +PI/2 with cursor angle
      targetGazeAngle = rawAngle - Math.PI / 2;
      const pull = exiting ? 1 : Math.min(1, dist / 140);
      targetGazePull = pull;
      targetLookX = Math.cos(rawAngle) * pull;
      targetLookY = Math.sin(rawAngle) * pull;
    } else if (!exiting) {
      targetGazePull = 0.15;
      targetLookX = 0;
      targetLookY = 0;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    updatePointerCoords(e.clientX, e.clientY, false);
  };

  const onMouseOut = (e: MouseEvent) => {
    if (!e.relatedTarget) {
      updatePointerCoords(e.clientX, e.clientY, true);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
    window.addEventListener("mouseout", onMouseOut, { passive: true });
  }

  function setState(state: OrbVisualState) {
    if (state === currentState) return;
    currentState = state;
    targetPalette = PALETTES[state] ?? PALETTES.idle;
    stateBlend = 0;
    if (state !== "dictation" && state !== "speaking" && state !== "recording") levelTarget = 0;
  }

  function setLevel(rms: number) {
    levelTarget = Math.min(1, Math.sqrt(Math.max(0, rms) * 4.5));
  }

  /**
   * IDLE: Bauhaus geometric eye (semicircle lid + bottom arc + mint pupil dot)
   * that rotates smoothly 360° to follow the cursor anywhere on screen.
   */
  function drawIdleGlyph(R: number, time: number, fg: string, accent: string) {
    const r = R * 0.58;
    const angle = hasPointer ? currentGazeAngle : Math.sin(time * 0.75) * 0.14;

    ctx!.save();
    ctx!.translate(C, C);
    ctx!.rotate(angle);

    // Upper semicircle lid in signature Mint accent
    ctx!.fillStyle = accent;
    ctx!.beginPath();
    ctx!.arc(0, 0, r, Math.PI, 0, false);
    ctx!.closePath();
    ctx!.fill();

    // Lower geometric eye arc in warm Bone
    ctx!.strokeStyle = fg;
    ctx!.lineWidth = Math.max(1.8, R * 0.14);
    ctx!.beginPath();
    ctx!.arc(0, 0, r * 0.85, 0.18, Math.PI - 0.18, false);
    ctx!.stroke();

    // Pupil dot that leans toward the cursor inside the eye
    const pupilY = r * (0.26 + 0.24 * currentGazePull);
    const dotR = R * (0.14 + 0.015 * Math.sin(time * 2.1));
    ctx!.fillStyle = accent;
    ctx!.beginPath();
    ctx!.arc(0, pupilY, dotR, 0, Math.PI * 2);
    ctx!.fill();

    ctx!.restore();
  }

  /**
   * MENU (Open Eye): When clicked to show options, the geometric eye snaps WIDE OPEN
   * into a crisp Bauhaus almond aperture with a Mint iris and an ink pupil that
   * tracks your cursor toward whichever option you hover.
   */
  function drawMenuGlyph(R: number, time: number, blend: number, fg: string, accent: string) {
    const open = easeOutBack(Math.min(1, blend));
    const eyeW = R * 0.84;
    const eyeH = R * 0.56 * Math.max(0.12, open);

    ctx!.save();
    ctx!.translate(C, C);

    // Crisp Bauhaus almond / vesica eye path
    const eyePath = () => {
      ctx!.beginPath();
      ctx!.moveTo(-eyeW, 0);
      ctx!.quadraticCurveTo(0, -eyeH * 1.45, eyeW, 0);
      ctx!.quadraticCurveTo(0, eyeH * 1.45, -eyeW, 0);
      ctx!.closePath();
    };

    // Clip interior of the open eye
    ctx!.save();
    eyePath();
    ctx!.clip();

    // Iris + pupil shift toward cursor
    const maxShiftX = R * 0.24;
    const maxShiftY = R * 0.16;
    const ix = currentLookX * maxShiftX;
    const iy = currentLookY * maxShiftY;

    // Mint iris circle
    const irisR = R * 0.38 * Math.min(1.08, open);
    ctx!.fillStyle = accent;
    ctx!.beginPath();
    ctx!.arc(ix, iy, irisR, 0, Math.PI * 2);
    ctx!.fill();

    // Subtle geometric iris ring border
    ctx!.strokeStyle = fg;
    ctx!.lineWidth = Math.max(1.4, R * 0.09);
    ctx!.stroke();

    // Ink pupil + tiny geometric catchlight square
    const pupilR = R * (0.17 + 0.015 * Math.sin(time * 3.5));
    ctx!.fillStyle = fg;
    ctx!.beginPath();
    ctx!.arc(ix, iy, pupilR, 0, Math.PI * 2);
    ctx!.fill();

    const glint = Math.max(1.5, R * 0.09);
    ctx!.fillStyle = accent;
    ctx!.fillRect(ix - pupilR * 0.55, iy - pupilR * 0.55, glint, glint);

    ctx!.restore();

    // Bold outer eye contour
    eyePath();
    ctx!.strokeStyle = fg;
    ctx!.lineWidth = Math.max(1.8, R * 0.13);
    ctx!.stroke();

    ctx!.restore();
  }

  /**
   * STARTING: Connecting / booting microphone before listening starts.
   * Stepped Bauhaus rotating quadrants + pulsing center diamond (crisp loader).
   */
  function drawStartingGlyph(R: number, time: number, fg: string, accent: string) {
    const step = Math.floor(time * 6) % 4;
    const rot = (step * Math.PI) / 2 + (time * 6 - Math.floor(time * 6)) * 0.35;
    const d = R * 0.44;
    const sq = R * 0.24;

    ctx!.save();
    ctx!.translate(C, C);
    ctx!.rotate(rot);

    // 2 opposing Mint squares + 2 opposing Bone dots
    ctx!.fillStyle = fg;
    ctx!.fillRect(-d - sq / 2, -d - sq / 2, sq, sq);
    ctx!.fillRect(d - sq / 2, d - sq / 2, sq, sq);

    ctx!.fillStyle = accent;
    ctx!.beginPath();
    ctx!.arc(d, -d, sq * 0.48, 0, Math.PI * 2);
    ctx!.arc(-d, d, sq * 0.48, 0, Math.PI * 2);
    ctx!.fill();

    ctx!.restore();
  }

  /**
   * DICTATION (Listening / waiting for voice in silence):
   * Calm, attentive breathing concentric Bauhaus squares + center dot (Image 3 row 1 col 1).
   * Clearly distinct from active speaking so you know it's ready & waiting.
   */
  function drawListeningGlyph(R: number, time: number, lv: number, fg: string) {
    const breath = Math.sin(time * 2.4) * 0.05;
    const outer = R * (0.68 + breath + lv * 0.08);
    const mid = R * (0.44 - breath * 0.6 + lv * 0.06);
    const core = R * (0.17 + breath * 0.3 + lv * 0.06);
    const lw = Math.max(1.75, R * 0.115);

    ctx!.save();
    ctx!.translate(C, C);

    ctx!.strokeStyle = fg;
    ctx!.lineWidth = lw;
    ctx!.strokeRect(-outer, -outer, outer * 2, outer * 2);
    ctx!.strokeRect(-mid, -mid, mid * 2, mid * 2);

    ctx!.fillStyle = fg;
    ctx!.beginPath();
    ctx!.arc(0, 0, core, 0, Math.PI * 2);
    ctx!.fill();

    ctx!.restore();
  }

  /**
   * SPEAKING (Actively capturing speech / transcribing live):
   * Energetic Bauhaus / Claude-style morphing between 3 audio-reactive geometric figures!
   *  Stage 0: 12-ray kinetic sunburst (Image 3 row 2 col 4 + Claude starburst)
   *  Stage 1: Nested counter-rotating squares (Image 3 row 3 col 2)
   *  Stage 2: Opposing bowtie / hourglass triangles (Image 2 row 4 col 2 & Image 3 row 4 col 1)
   */
  function drawSpeakingGlyph(R: number, time: number, lv: number, fg: string, bg: string) {
    const cycleDuration = 2.8;
    const rawStage = time / cycleDuration;
    const stageIdx = Math.floor(rawStage) % 3;
    const phase = rawStage - Math.floor(rawStage); // 0..1 within current figure

    // Crisp entry/exit morph envelope (0 -> 1 -> 0 at edges)
    let morphScale = 1;
    if (phase < 0.14) {
      morphScale = easeOutBack(phase / 0.14);
    } else if (phase > 0.88) {
      morphScale = Math.max(0.05, 1 - (phase - 0.88) / 0.12);
    }

    ctx!.save();
    ctx!.translate(C, C);
    ctx!.scale(morphScale, morphScale);

    if (stageIdx === 0) {
      // FIGURE 1: 12-Ray Kinetic Sunburst (Claude / Image 3 starburst)
      const rays = 12;
      const rot = time * 1.1;
      const innerR = R * (0.18 + lv * 0.06);
      const barW = Math.max(1.8, R * 0.115);
      ctx!.fillStyle = fg;

      for (let i = 0; i < rays; i += 1) {
        const a = rot + (i / rays) * Math.PI * 2;
        const wave = 0.5 + 0.5 * Math.sin(time * 6.5 + i * 1.25);
        const isMajor = i % 2 === 0;
        const outerR =
          R * (isMajor ? 0.68 : 0.5) +
          R * (0.12 * wave + lv * 0.22);

        ctx!.save();
        ctx!.rotate(a);
        ctx!.fillRect(innerR, -barW / 2, Math.max(2, outerR - innerR), barW);
        ctx!.restore();
      }

      // Crisp inner circle with cut-out
      ctx!.beginPath();
      ctx!.arc(0, 0, innerR * 0.92, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.fillStyle = bg;
      ctx!.beginPath();
      ctx!.arc(0, 0, innerR * 0.42, 0, Math.PI * 2);
      ctx!.fill();
    } else if (stageIdx === 1) {
      // FIGURE 2: Nested Counter-Rotating Geometric Squares (Image 3 row 3 col 2)
      const lw = Math.max(2, R * 0.125);
      const sizes = [0.78 + lv * 0.1, 0.54 + lv * 0.08, 0.3 + lv * 0.06];
      const dirs = [1, -1.5, 2.2];

      for (let i = 0; i < sizes.length; i += 1) {
        const s = R * sizes[i];
        ctx!.save();
        ctx!.rotate(time * 0.95 * dirs[i] + i * (Math.PI / 6));
        if (i === 2) {
          ctx!.fillStyle = fg;
          ctx!.fillRect(-s, -s, s * 2, s * 2);
        } else {
          ctx!.strokeStyle = fg;
          ctx!.lineWidth = lw;
          ctx!.strokeRect(-s, -s, s * 2, s * 2);
        }
        ctx!.restore();
      }
    } else {
      // FIGURE 3: Bauhaus Acoustic Hourglass / Opposing Triangles + Counter-Phase Dots
      // Crisp upright mechanical squash-and-stretch synced to voice (no plain spin)
      const beat = 0.5 + 0.5 * Math.sin(time * 7.2);
      const energy = Math.min(1, beat * 0.45 + lv * 0.85);

      // Triangles pinch inward toward center on speech peaks & widen slightly
      const tipGap = R * (0.04 + (1 - energy) * 0.16);
      const baseY = R * (0.76 - energy * 0.12);
      const halfW = R * (0.48 + energy * 0.16);

      ctx!.fillStyle = fg;

      // Top triangle pointing down
      ctx!.beginPath();
      ctx!.moveTo(-halfW, -baseY);
      ctx!.lineTo(halfW, -baseY);
      ctx!.lineTo(0, -tipGap);
      ctx!.closePath();
      ctx!.fill();

      // Bottom triangle pointing up
      ctx!.beginPath();
      ctx!.moveTo(-halfW, baseY);
      ctx!.lineTo(halfW, baseY);
      ctx!.lineTo(0, tipGap);
      ctx!.closePath();
      ctx!.fill();

      // Side dots move outward & pop in counter-phase when triangles compress
      const dotX = R * (0.46 + energy * 0.2);
      const dotY = Math.sin(time * 7.2 + Math.PI / 2) * (R * 0.08 * (0.4 + lv));
      const dotR = R * (0.13 + energy * 0.09);
      ctx!.beginPath();
      ctx!.arc(-dotX, dotY, dotR, 0, Math.PI * 2);
      ctx!.arc(dotX, -dotY, dotR, 0, Math.PI * 2);
      ctx!.fill();

      // Crisp geometric pulse spark at center when voice energy is high
      if (energy > 0.62) {
        const sparkR = R * (0.09 + (energy - 0.62) * 0.22);
        ctx!.beginPath();
        ctx!.moveTo(0, -sparkR);
        ctx!.lineTo(sparkR * 1.4, 0);
        ctx!.lineTo(0, sparkR);
        ctx!.lineTo(-sparkR * 1.4, 0);
        ctx!.closePath();
        ctx!.fill();
      }
    }

    ctx!.restore();
  }

  /**
   * INSERTING: Bauhaus bold geometric X / 4-point star snap (Image 2 row 5 col 4).
   */
  function drawInsertingGlyph(R: number, blend: number, fg: string) {
    const s = 0.7 + Math.sin(Math.min(1, blend) * Math.PI) * 0.45;
    const arm = R * 0.66 * s;
    const thick = Math.max(3, R * 0.24 * s);

    ctx!.save();
    ctx!.translate(C, C);
    ctx!.rotate(Math.PI / 4);
    ctx!.fillStyle = fg;
    ctx!.fillRect(-arm, -thick / 2, arm * 2, thick);
    ctx!.fillRect(-thick / 2, -arm, thick, arm * 2);
    ctx!.restore();
  }

  /**
   * ERROR: Sharp vibrating Bauhaus X alert on signal vermilion.
   */
  function drawErrorGlyph(R: number, time: number, blend: number, fg: string) {
    const shake = blend < 0.6 ? Math.sin(time * 48) * (R * 0.12) * (1 - blend / 0.6) : 0;
    const arm = R * 0.58;
    const thick = Math.max(2.6, R * 0.22);

    ctx!.save();
    ctx!.translate(C + shake, C);
    ctx!.rotate(Math.PI / 4);
    ctx!.fillStyle = fg;
    ctx!.fillRect(-arm, -thick / 2, arm * 2, thick);
    ctx!.fillRect(-thick / 2, -arm, thick, arm * 2);
    ctx!.restore();
  }

  /**
   * RECORDING: Concentric Bauhaus square frame + pulsing solid core + corner brackets (Image 3 row 1 col 1).
   */
  function drawRecordingGlyph(R: number, time: number, lv: number, fg: string) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 5.0);
    const core = R * (0.28 + lv * 0.1 + pulse * 0.06);
    const mid = R * (0.56 + pulse * 0.04);
    const outer = R * 0.76;
    const tick = R * 0.22;

    ctx!.save();
    ctx!.translate(C, C);

    // Solid core square
    ctx!.fillStyle = fg;
    ctx!.fillRect(-core, -core, core * 2, core * 2);

    // Middle crisp frame
    ctx!.strokeStyle = fg;
    ctx!.lineWidth = Math.max(1.8, R * 0.11);
    ctx!.strokeRect(-mid, -mid, mid * 2, mid * 2);

    // Outer corner viewfinder ticks
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [sx, sy] of corners) {
      ctx!.beginPath();
      ctx!.moveTo(sx * outer, sy * (outer - tick));
      ctx!.lineTo(sx * outer, sy * outer);
      ctx!.lineTo(sx * (outer - tick), sy * outer);
      ctx!.stroke();
    }

    ctx!.restore();
  }

  /**
   * PAUSED: Twin bold Bauhaus arch monoliths (Image 2 row 6 col 2 / Image 3 row 3 col 4).
   */
  function drawPausedGlyph(R: number, time: number, fg: string) {
    const breathe = 1 + Math.sin(time * 2.2) * 0.04;
    const bw = R * 0.25;
    const bh = R * 0.72 * breathe;
    const gap = R * 0.18;

    ctx!.save();
    ctx!.translate(C, C);
    ctx!.fillStyle = fg;

    // Left arch bar
    roundedRectPath(ctx!, -gap / 2 - bw, -bh / 2, bw, bh, bw / 2);
    ctx!.fill();
    // Right arch bar
    roundedRectPath(ctx!, gap / 2, -bh / 2, bw, bh, bw / 2);
    ctx!.fill();

    ctx!.restore();
  }

  /**
   * UPLOADING: Stacked marching upward Bauhaus triangles (Image 2 row 3 col 4).
   */
  function drawUploadingGlyph(R: number, time: number, fg: string) {
    const triW = R * 0.56;
    const triH = R * 0.34;
    const cycle = (time * 1.4) % 1;

    ctx!.save();
    ctx!.translate(C, C);

    // Clip inside inner square
    ctx!.beginPath();
    ctx!.rect(-R * 0.78, -R * 0.78, R * 1.56, R * 1.56);
    ctx!.clip();

    ctx!.fillStyle = fg;
    // Draw 3 stacked triangles marching smoothly upward
    for (let i = -1; i <= 1; i += 1) {
      const yOffset = (i - cycle + 0.5) * (R * 0.62);
      ctx!.beginPath();
      ctx!.moveTo(0, yOffset - triH);
      ctx!.lineTo(triW, yOffset + triH * 0.55);
      ctx!.lineTo(-triW, yOffset + triH * 0.55);
      ctx!.closePath();
      ctx!.fill();
    }

    ctx!.restore();
  }

  function frame(now: number) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const k = 1 - Math.exp(-dt * 15);
    curPalette.bg = lerpRgb(curPalette.bg, targetPalette.bg, k);
    curPalette.fg = lerpRgb(curPalette.fg, targetPalette.fg, k);
    curPalette.border = lerpRgb(curPalette.border, targetPalette.border, k);
    curPalette.accent = lerpRgb(curPalette.accent, targetPalette.accent, k);

    level = lerp(level, levelTarget, levelTarget > level ? 0.45 : 0.14);
    stateBlend = Math.min(1, stateBlend + dt * 4.5);
    const gazeK = 1 - Math.exp(-dt * 12);
    currentGazeAngle = lerpAngle(currentGazeAngle, targetGazeAngle, gazeK);
    currentGazePull = lerp(currentGazePull, targetGazePull, gazeK);
    currentLookX = lerp(currentLookX, targetLookX, gazeK);
    currentLookY = lerp(currentLookY, targetLookY, gazeK);
    t += dt * (reduceMotion ? 0.25 : 1);

    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, size, size);

    const pad = Math.max(1.5, size * 0.045);
    const boxSize = (size - pad * 2) * Math.min(1, 0.96 * zoom);
    const x0 = (size - boxSize) / 2;
    const y0 = (size - boxSize) / 2;
    const borderW = Math.max(1.75, size * 0.042);
    const cornerR = Math.max(2, size * 0.075);
    const innerR = (boxSize - borderW * 2) / 2;

    const bgStr = rgbStr(curPalette.bg);
    const fgStr = rgbStr(curPalette.fg);
    const borderStr = rgbStr(curPalette.border);
    const accentStr = rgbStr(curPalette.accent);

    // Solid flat brutalist tile plate
    roundedRectPath(ctx!, x0, y0, boxSize, boxSize, cornerR);
    ctx!.fillStyle = bgStr;
    ctx!.fill();

    // Crisp solid border
    ctx!.strokeStyle = borderStr;
    ctx!.lineWidth = borderW;
    ctx!.stroke();

    // Center dynamic geometric glyph per function
    switch (currentState) {
      case "menu":
        drawMenuGlyph(innerR, t, stateBlend, fgStr, accentStr);
        break;
      case "starting":
        drawStartingGlyph(innerR, t, fgStr, accentStr);
        break;
      case "dictation":
        drawListeningGlyph(innerR, t, level, fgStr);
        break;
      case "speaking":
        drawSpeakingGlyph(innerR, t, level, fgStr, bgStr);
        break;
      case "inserting":
        drawInsertingGlyph(innerR, stateBlend, fgStr);
        break;
      case "error":
        drawErrorGlyph(innerR, t, stateBlend, fgStr);
        break;
      case "recording":
        drawRecordingGlyph(innerR, t, level, fgStr);
        break;
      case "paused":
        drawPausedGlyph(innerR, t, fgStr);
        break;
      case "uploading":
        drawUploadingGlyph(innerR, t, fgStr);
        break;
      default:
        drawIdleGlyph(innerR, t, fgStr, accentStr);
        break;
    }

    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    setState,
    setLevel,
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      if (typeof window !== "undefined") {
        window.removeEventListener("pointermove", onPointerMove, { capture: true });
        window.removeEventListener("mouseout", onMouseOut);
      }
    },
  };
}
