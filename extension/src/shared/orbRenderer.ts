/**
 * Orbe de energía RECO (Canvas 2D).
 *
 * Mantiene la estética original de plasma en cristal de RECO pero incorpora
 * temas de color distintos para distinguir de un vistazo qué está haciendo:
 *  - idle:      reposo sutil oscuro/ámbar tenue
 *  - dictation: Cian / Azul eléctrico (#22d3ee -> #2563eb) mientras escucha/escribe
 *  - inserting: destello blanco-cian al insertar texto en el cursor
 *  - recording: Rojo incandescente (#ff4a3d -> #ff8a5c) mientras graba pantalla
 *  - paused:    Ámbar dorado (#f59e0b) en pausa
 *  - uploading: Verde esmeralda (#10b981 -> #34d399) con anillos giratorios al subir a Notion
 */

export type OrbVisualState =
  | "idle"
  | "dictation"
  | "inserting"
  | "recording"
  | "paused"
  | "uploading";

export interface OrbHandle {
  setState(state: OrbVisualState): void;
  setLevel(level: number): void;
  dispose(): void;
}

interface OrbPalette {
  haloRgb: [number, number, number];
  coreCenter: [number, number, number];
  bodyMid: [number, number, number];
  bodyDark: [number, number, number];
  bodyDeep: [number, number, number];
  lobeRgb: [number, number, number];
  shadeRgb: [number, number, number];
  bounceRgb: [number, number, number];
  rimBright: [number, number, number];
  ringRgb: [number, number, number];
}

const PALETTES: Record<OrbVisualState, OrbPalette> = {
  idle: {
    haloRgb: [160, 145, 165],
    coreCenter: [230, 225, 235],
    bodyMid: [110, 102, 118],
    bodyDark: [56, 52, 62],
    bodyDeep: [26, 24, 30],
    lobeRgb: [165, 155, 180],
    shadeRgb: [12, 10, 16],
    bounceRgb: [140, 130, 155],
    rimBright: [220, 215, 230],
    ringRgb: [180, 175, 195],
  },
  dictation: {
    haloRgb: [34, 211, 238],
    coreCenter: [232, 252, 255],
    bodyMid: [56, 189, 248],
    bodyDark: [14, 116, 210],
    bodyDeep: [8, 47, 115],
    lobeRgb: [103, 232, 249],
    shadeRgb: [4, 24, 62],
    bounceRgb: [56, 189, 248],
    rimBright: [207, 250, 254],
    ringRgb: [56, 189, 248],
  },
  inserting: {
    haloRgb: [125, 243, 255],
    coreCenter: [255, 255, 255],
    bodyMid: [103, 232, 249],
    bodyDark: [34, 211, 238],
    bodyDeep: [14, 116, 144],
    lobeRgb: [186, 230, 253],
    shadeRgb: [8, 47, 73],
    bounceRgb: [125, 211, 252],
    rimBright: [240, 253, 255],
    ringRgb: [165, 243, 252],
  },
  recording: {
    haloRgb: [255, 70, 35],
    coreCenter: [255, 250, 240],
    bodyMid: [255, 110, 52],
    bodyDark: [214, 28, 18],
    bodyDeep: [115, 8, 6],
    lobeRgb: [255, 150, 75],
    shadeRgb: [60, 0, 0],
    bounceRgb: [255, 130, 70],
    rimBright: [255, 235, 215],
    ringRgb: [255, 155, 95],
  },
  paused: {
    haloRgb: [245, 158, 11],
    coreCenter: [255, 248, 225],
    bodyMid: [251, 191, 36],
    bodyDark: [217, 119, 6],
    bodyDeep: [120, 53, 15],
    lobeRgb: [253, 224, 71],
    shadeRgb: [69, 26, 3],
    bounceRgb: [251, 191, 36],
    rimBright: [254, 243, 199],
    ringRgb: [251, 191, 36],
  },
  uploading: {
    haloRgb: [16, 185, 129],
    coreCenter: [236, 253, 245],
    bodyMid: [52, 211, 153],
    bodyDark: [5, 150, 105],
    bodyDeep: [6, 78, 59],
    lobeRgb: [110, 231, 183],
    shadeRgb: [2, 44, 34],
    bounceRgb: [52, 211, 153],
    rimBright: [209, 250, 229],
    ringRgb: [52, 211, 153],
  },
};

const TARGETS: Record<OrbVisualState, { speed: number; wobble: number; ring: number }> = {
  idle: { speed: 0.45, wobble: 0.35, ring: 0 },
  dictation: { speed: 1.35, wobble: 1.05, ring: 0.35 },
  inserting: { speed: 1.8, wobble: 0.85, ring: 0 },
  recording: { speed: 1.25, wobble: 1.1, ring: 0 },
  paused: { speed: 0.3, wobble: 0.25, ring: 0 },
  uploading: { speed: 2.3, wobble: 1.2, ring: 1 },
};

const DRAW_SCALE = 0.76;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function lerpRgb(
  cur: [number, number, number],
  tgt: [number, number, number],
  k: number,
): [number, number, number] {
  return [lerp(cur[0], tgt[0], k), lerp(cur[1], tgt[1], k), lerp(cur[2], tgt[2], k)];
}

function rgbStr(c: [number, number, number], alpha?: number): string {
  const r = Math.round(c[0]);
  const g = Math.round(c[1]);
  const b = Math.round(c[2]);
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  const u = (size / 64) * zoom;
  const HALO_RADIUS = Math.min(C * 0.97, size * 0.453 * zoom);
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const curMotion = { ...TARGETS[initial] };
  let targetMotion = TARGETS[initial];

  let curPalette: OrbPalette = structuredClone(PALETTES[initial]);
  let targetPalette: OrbPalette = PALETTES[initial];

  let currentState: OrbVisualState = initial;
  let levelTarget = 0;
  let level = 0;
  let flash = 0;
  let t = 0;
  let last = performance.now();
  let raf = 0;
  let alive = true;

  function setState(state: OrbVisualState) {
    if (state === currentState) return;
    currentState = state;
    targetMotion = TARGETS[state] ?? TARGETS.idle;
    targetPalette = PALETTES[state] ?? PALETTES.idle;
    if (state === "inserting") flash = 1;
    if (state !== "dictation" && state !== "recording") levelTarget = 0;
  }

  function setLevel(rms: number) {
    levelTarget = Math.min(1, Math.sqrt(Math.max(0, rms) * 3.8));
  }

  function blobPath(radius: number, time: number, wobble: number) {
    const points = size < 40 ? 64 : 96;
    ctx!.beginPath();
    for (let i = 0; i <= points; i += 1) {
      const a = (i / points) * Math.PI * 2;
      const n =
        0.072 * Math.sin(2 * a + time * 1.3) +
        0.052 * Math.sin(3 * a - time * 1.9 + 1.7) +
        0.036 * Math.sin(5 * a + time * 2.7 + 0.6) +
        0.02 * Math.sin(7 * a - time * 3.4 + 2.4);
      const r = radius * (1 + wobble * n);
      const x = C + Math.cos(a) * r;
      const y = C + Math.sin(a) * r;
      if (i === 0) ctx!.moveTo(x, y);
      else ctx!.lineTo(x, y);
    }
    ctx!.closePath();
  }

  function frame(now: number) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const k = 1 - Math.exp(-dt * 8);
    curMotion.speed = lerp(curMotion.speed, targetMotion.speed, k);
    curMotion.wobble = lerp(curMotion.wobble, targetMotion.wobble, k);
    curMotion.ring = lerp(curMotion.ring, targetMotion.ring, k);

    curPalette.haloRgb = lerpRgb(curPalette.haloRgb, targetPalette.haloRgb, k);
    curPalette.coreCenter = lerpRgb(curPalette.coreCenter, targetPalette.coreCenter, k);
    curPalette.bodyMid = lerpRgb(curPalette.bodyMid, targetPalette.bodyMid, k);
    curPalette.bodyDark = lerpRgb(curPalette.bodyDark, targetPalette.bodyDark, k);
    curPalette.bodyDeep = lerpRgb(curPalette.bodyDeep, targetPalette.bodyDeep, k);
    curPalette.lobeRgb = lerpRgb(curPalette.lobeRgb, targetPalette.lobeRgb, k);
    curPalette.shadeRgb = lerpRgb(curPalette.shadeRgb, targetPalette.shadeRgb, k);
    curPalette.bounceRgb = lerpRgb(curPalette.bounceRgb, targetPalette.bounceRgb, k);
    curPalette.rimBright = lerpRgb(curPalette.rimBright, targetPalette.rimBright, k);
    curPalette.ringRgb = lerpRgb(curPalette.ringRgb, targetPalette.ringRgb, k);

    level = lerp(level, levelTarget, levelTarget > level ? 0.38 : 0.1);
    flash = Math.max(0, flash - dt * 2.4);
    t += dt * curMotion.speed * (reduceMotion ? 0.25 : 1);

    const idleScale = currentState === "idle" ? 0.88 : 1;
    const R = (9.6 + level * 4.5 + Math.sin(t * 1.6) * 0.55) * u * idleScale;

    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, size, size);
    ctx!.translate(C, C);
    ctx!.scale(DRAW_SCALE, DRAW_SCALE);
    ctx!.translate(-C, -C);

    // Halo
    const halo = ctx!.createRadialGradient(C, C, R * 0.78, C, C, HALO_RADIUS);
    const hv = (currentState === "idle" ? 0.45 : 0.8) + level * 0.65;
    halo.addColorStop(0, rgbStr(curPalette.haloRgb, 0.52 * hv));
    halo.addColorStop(0.38, rgbStr(curPalette.haloRgb, 0.18 * hv));
    halo.addColorStop(0.72, rgbStr(curPalette.haloRgb, 0.04));
    halo.addColorStop(1, rgbStr(curPalette.haloRgb, 0));
    ctx!.fillStyle = halo;
    ctx!.beginPath();
    ctx!.arc(C, C, HALO_RADIUS, 0, Math.PI * 2);
    ctx!.fill();

    // Body
    blobPath(R, t, curMotion.wobble);
    const body = ctx!.createRadialGradient(
      C - R * 0.3,
      C - R * 0.35,
      R * 0.1,
      C,
      C,
      R * 1.08,
    );
    body.addColorStop(0, rgbStr(curPalette.coreCenter));
    body.addColorStop(0.32, rgbStr(curPalette.bodyMid));
    body.addColorStop(0.72, rgbStr(curPalette.bodyDark));
    body.addColorStop(1, rgbStr(curPalette.bodyDeep));
    ctx!.fillStyle = body;
    ctx!.fill();

    // Inner plasma clipped
    ctx!.save();
    blobPath(R, t, curMotion.wobble);
    ctx!.clip();

    ctx!.globalCompositeOperation = "lighter";
    for (let i = 0; i < 4; i += 1) {
      const dir = i % 2 === 0 ? 1 : -1;
      const a = t * (0.9 + i * 0.35) * dir + i * 2.1;
      const d = R * (0.38 + 0.12 * Math.sin(t * 1.4 + i));
      const x = C + Math.cos(a) * d;
      const y = C + Math.sin(a) * d;
      const lobe = ctx!.createRadialGradient(x, y, 0, x, y, R * 0.62);
      lobe.addColorStop(0, rgbStr(curPalette.lobeRgb, 0.55));
      lobe.addColorStop(1, rgbStr(curPalette.lobeRgb, 0));
      ctx!.fillStyle = lobe;
      ctx!.fillRect(0, 0, size, size);
    }

    const coreR = R * (0.5 + 0.08 * Math.sin(t * 3.1) + level * 0.18);
    const core = ctx!.createRadialGradient(C, C, 0, C, C, coreR);
    core.addColorStop(0, rgbStr(curPalette.coreCenter, 0.95));
    core.addColorStop(0.5, rgbStr(curPalette.lobeRgb, 0.45));
    core.addColorStop(1, rgbStr(curPalette.bodyMid, 0));
    ctx!.fillStyle = core;
    ctx!.fillRect(0, 0, size, size);

    ctx!.globalCompositeOperation = "source-over";

    const shade = ctx!.createRadialGradient(C, C, R * 0.45, C, C, R * 1.1);
    shade.addColorStop(0, rgbStr(curPalette.shadeRgb, 0));
    shade.addColorStop(1, rgbStr(curPalette.shadeRgb, 0.55));
    ctx!.fillStyle = shade;
    ctx!.fillRect(0, 0, size, size);

    const bounce = ctx!.createRadialGradient(C, C + R * 0.85, 0, C, C + R * 0.85, R * 0.7);
    bounce.addColorStop(0, rgbStr(curPalette.bounceRgb, 0.4));
    bounce.addColorStop(1, rgbStr(curPalette.bounceRgb, 0));
    ctx!.fillStyle = bounce;
    ctx!.fillRect(0, 0, size, size);

    if (flash > 0) {
      ctx!.fillStyle = `rgba(255, 255, 255, ${flash * 0.65})`;
      ctx!.fillRect(0, 0, size, size);
    }
    ctx!.restore();

    // Rim
    blobPath(R, t, curMotion.wobble);
    const rim = ctx!.createLinearGradient(C - R, C - R, C + R, C + R);
    rim.addColorStop(0, rgbStr(curPalette.rimBright, 0.85));
    rim.addColorStop(0.5, rgbStr(curPalette.bodyMid, 0.3));
    rim.addColorStop(1, rgbStr(curPalette.bodyDark, 0.5));
    ctx!.strokeStyle = rim;
    ctx!.lineWidth = Math.max(0.75, u);
    ctx!.stroke();

    // Specular
    ctx!.save();
    ctx!.translate(C - R * 0.34, C - R * 0.5);
    ctx!.rotate(-0.45);
    const spec = ctx!.createRadialGradient(0, 0, 0, 0, 0, R * 0.4);
    spec.addColorStop(0, "rgba(255, 255, 255, 0.92)");
    spec.addColorStop(0.6, "rgba(255, 255, 255, 0.22)");
    spec.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx!.fillStyle = spec;
    ctx!.scale(1, 0.55);
    ctx!.beginPath();
    ctx!.arc(0, 0, R * 0.4, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.restore();

    // Energy arcs for dictation / uploading
    if (curMotion.ring > 0.02) {
      ctx!.lineCap = "round";
      ctx!.lineWidth = 1.35 * u;
      for (let i = 0; i < 2; i += 1) {
        const a0 = t * 2.2 * (i === 0 ? 1 : -1) + i * Math.PI;
        ctx!.strokeStyle = rgbStr(curPalette.ringRgb, 0.82 * curMotion.ring);
        ctx!.beginPath();
        ctx!.arc(C, C, R + (4.5 + i * 2.5) * u, a0, a0 + 1.3);
        ctx!.stroke();
      }
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
    },
  };
}
