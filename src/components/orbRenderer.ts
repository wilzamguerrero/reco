/**
 * Dibujo del orbe de energía.
 *
 * Vive en un módulo aparte porque lo usan dos sitios: la ventana flotante del
 * dictado y la cabecera del panel principal. Todo se escala a partir del lado
 * del canvas, así que el mismo código sirve para un orbe de 64 px y para uno
 * de 28 px sin tocar constantes.
 *
 * Se dibuja a mano en canvas porque el contorno irregular, el plasma interior
 * y el brillo de cristal no salen con CSS sin que se note el apaño.
 */

export type OrbState = "idle" | "listening" | "transcribing" | "inserting";

export interface OrbHandle {
  setState(state: OrbState): void;
  /** Energía de la voz, 0–1 (ya normalizada a partir del RMS). */
  setLevel(level: number): void;
  dispose(): void;
}

/** Parámetros de cada estado; el orbe se acerca a ellos suavemente. */
const TARGETS: Record<OrbState, { speed: number; wobble: number; heat: number; ring: number }> = {
  idle: { speed: 0.6, wobble: 0.55, heat: 0, ring: 0 },
  listening: { speed: 1, wobble: 1, heat: 0, ring: 0 },
  transcribing: { speed: 2.4, wobble: 1.5, heat: 1, ring: 1 },
  inserting: { speed: 1.4, wobble: 0.8, heat: 0.4, ring: 0 },
};

/**
 * Escala del dibujo respecto al canvas.
 *
 * Deja aire alrededor del halo: si el degradado llegara al borde del canvas se
 * cortaría en seco y se vería el cuadrado de la ventana en vez de una esfera.
 */
const DRAW_SCALE = 0.75;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Monta el orbe sobre un canvas y empieza a animar.
 *
 * `size` es el lado en píxeles CSS; el canvas se reescala por `devicePixelRatio`
 * para que no se vea borroso en pantallas HiDPI. `zoom` agranda el orbe dentro
 * de su caja: a 64 px el diseño base ya deja aire de sobra, pero en un hueco de
 * 34 px el mismo factor lo reduce a un punto.
 */
export function mountOrb(
  canvas: HTMLCanvasElement,
  size: number,
  initial: OrbState = "listening",
  zoom = 1,
): OrbHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { setState: () => {}, setLevel: () => {}, dispose: () => {} };
  }

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);

  const C = size / 2;
  // Todo el dibujo estaba pensado sobre un lienzo de 64 px: `u` lo reescala.
  const u = (size / 64) * zoom;
  const HALO_RADIUS = Math.min(C * 0.97, size * 0.453 * zoom);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const cur = { ...TARGETS[initial] };
  let target = TARGETS[initial];

  let levelTarget = 0;
  let level = 0;
  let flash = 0;
  let t = 0;
  let last = performance.now();
  let raf = 0;
  let alive = true;

  function setState(state: OrbState) {
    target = TARGETS[state] ?? TARGETS.idle;
    if (state === "inserting") flash = 1;
    if (state !== "listening") levelTarget = 0;
  }

  function setLevel(rms: number) {
    // El RMS de voz ronda 0.01–0.3: la raíz comprime para que se note también
    // al hablar bajo, sin que los picos deformen el orbe.
    levelTarget = Math.min(1, Math.sqrt(Math.max(0, rms) * 3.2));
  }

  /** Contorno irregular: suma de ondas de distinta frecuencia sobre el círculo. */
  function blobPath(radius: number, time: number, wobble: number) {
    const points = size < 40 ? 64 : 96;
    ctx!.beginPath();
    for (let i = 0; i <= points; i += 1) {
      const a = (i / points) * Math.PI * 2;
      const n =
        0.075 * Math.sin(2 * a + time * 1.3) +
        0.055 * Math.sin(3 * a - time * 1.9 + 1.7) +
        0.038 * Math.sin(5 * a + time * 2.7 + 0.6) +
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

    const k = 1 - Math.exp(-dt * 7);
    cur.speed = lerp(cur.speed, target.speed, k);
    cur.wobble = lerp(cur.wobble, target.wobble, k);
    cur.heat = lerp(cur.heat, target.heat, k);
    cur.ring = lerp(cur.ring, target.ring, k);

    // Sube rápido con la voz y baja despacio, como un medidor real.
    level = lerp(level, levelTarget, levelTarget > level ? 0.35 : 0.09);
    flash = Math.max(0, flash - dt * 2.2);

    t += dt * cur.speed * (reduceMotion ? 0.25 : 1);

    const R = (9.5 + level * 4.5 + Math.sin(t * 1.6) * 0.6) * u;
    const heat = cur.heat;

    // Se limpia con la transformación base y luego se encoge todo el dibujo
    // alrededor del centro: así el tamaño se ajusta en un solo sitio y el halo
    // sigue apagándose lejos del borde de la ventana.
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, size, size);
    ctx!.translate(C, C);
    ctx!.scale(DRAW_SCALE, DRAW_SCALE);
    ctx!.translate(-C, -C);

    // Halo: se apaga a alfa 0 antes del borde del canvas.
    const halo = ctx!.createRadialGradient(C, C, R * 0.8, C, C, HALO_RADIUS);
    const hv = 0.7 + level * 0.6;
    halo.addColorStop(0, `rgba(255, ${Math.round(70 + heat * 40)}, 35, ${0.5 * hv})`);
    halo.addColorStop(0.35, `rgba(255, ${Math.round(55 + heat * 35)}, 25, ${0.17 * hv})`);
    halo.addColorStop(0.7, "rgba(255, 45, 20, 0.04)");
    halo.addColorStop(1, "rgba(255, 45, 20, 0)");
    ctx!.fillStyle = halo;
    ctx!.beginPath();
    ctx!.arc(C, C, HALO_RADIUS, 0, Math.PI * 2);
    ctx!.fill();

    // Cuerpo.
    blobPath(R, t, cur.wobble);
    const body = ctx!.createRadialGradient(
      C - R * 0.3,
      C - R * 0.35,
      R * 0.1,
      C,
      C,
      R * 1.08,
    );
    body.addColorStop(0, `rgb(255, ${Math.round(215 + heat * 20)}, 175)`);
    body.addColorStop(0.3, `rgb(255, ${Math.round(90 + heat * 60)}, ${Math.round(45 + heat * 10)})`);
    body.addColorStop(0.7, "rgb(214, 28, 18)");
    body.addColorStop(1, "rgb(115, 8, 6)");
    ctx!.fillStyle = body;
    ctx!.fill();

    // Interior: todo lo que sigue queda recortado al contorno.
    ctx!.save();
    blobPath(R, t, cur.wobble);
    ctx!.clip();

    // Plasma: lóbulos de energía que orbitan y se suman.
    ctx!.globalCompositeOperation = "lighter";
    for (let i = 0; i < 4; i += 1) {
      const dir = i % 2 === 0 ? 1 : -1;
      const a = t * (0.9 + i * 0.35) * dir + i * 2.1;
      const d = R * (0.38 + 0.12 * Math.sin(t * 1.4 + i));
      const x = C + Math.cos(a) * d;
      const y = C + Math.sin(a) * d;
      const lobe = ctx!.createRadialGradient(x, y, 0, x, y, R * 0.62);
      lobe.addColorStop(0, `rgba(255, ${Math.round(140 + heat * 50)}, 70, 0.55)`);
      lobe.addColorStop(1, "rgba(255, 90, 40, 0)");
      ctx!.fillStyle = lobe;
      ctx!.fillRect(0, 0, size, size);
    }

    // Núcleo caliente que respira.
    const coreR = R * (0.5 + 0.08 * Math.sin(t * 3.1) + level * 0.18);
    const core = ctx!.createRadialGradient(C, C, 0, C, C, coreR);
    core.addColorStop(0, "rgba(255, 250, 240, 0.95)");
    core.addColorStop(0.5, "rgba(255, 190, 130, 0.5)");
    core.addColorStop(1, "rgba(255, 120, 60, 0)");
    ctx!.fillStyle = core;
    ctx!.fillRect(0, 0, size, size);

    ctx!.globalCompositeOperation = "source-over";

    // Volumen: oscurece el borde para que se lea como esfera, no como disco.
    const shade = ctx!.createRadialGradient(C, C, R * 0.45, C, C, R * 1.1);
    shade.addColorStop(0, "rgba(60, 0, 0, 0)");
    shade.addColorStop(1, "rgba(60, 0, 0, 0.55)");
    ctx!.fillStyle = shade;
    ctx!.fillRect(0, 0, size, size);

    // Luz rebotada abajo, típica del cristal.
    const bounce = ctx!.createRadialGradient(
      C,
      C + R * 0.85,
      0,
      C,
      C + R * 0.85,
      R * 0.7,
    );
    bounce.addColorStop(0, "rgba(255, 130, 70, 0.4)");
    bounce.addColorStop(1, "rgba(255, 130, 70, 0)");
    ctx!.fillStyle = bounce;
    ctx!.fillRect(0, 0, size, size);

    if (flash > 0) {
      ctx!.fillStyle = `rgba(255, 255, 255, ${flash * 0.6})`;
      ctx!.fillRect(0, 0, size, size);
    }
    ctx!.restore();

    // Borde luminoso.
    blobPath(R, t, cur.wobble);
    const rim = ctx!.createLinearGradient(C - R, C - R, C + R, C + R);
    rim.addColorStop(0, "rgba(255, 235, 215, 0.85)");
    rim.addColorStop(0.5, "rgba(255, 140, 90, 0.25)");
    rim.addColorStop(1, "rgba(255, 90, 50, 0.45)");
    ctx!.strokeStyle = rim;
    ctx!.lineWidth = Math.max(0.75, u);
    ctx!.stroke();

    // Reflejo especular.
    ctx!.save();
    ctx!.translate(C - R * 0.34, C - R * 0.5);
    ctx!.rotate(-0.45);
    const spec = ctx!.createRadialGradient(0, 0, 0, 0, 0, R * 0.4);
    spec.addColorStop(0, "rgba(255, 255, 255, 0.95)");
    spec.addColorStop(0.6, "rgba(255, 255, 255, 0.25)");
    spec.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx!.fillStyle = spec;
    ctx!.scale(1, 0.55);
    ctx!.beginPath();
    ctx!.arc(0, 0, R * 0.4, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.restore();

    // Transcribiendo: arcos de energía girando alrededor del orbe.
    if (cur.ring > 0.01) {
      ctx!.lineCap = "round";
      ctx!.lineWidth = 1.4 * u;
      for (let i = 0; i < 2; i += 1) {
        const a0 = t * 2.2 * (i === 0 ? 1 : -1) + i * Math.PI;
        ctx!.strokeStyle = `rgba(255, ${170 - i * 40}, ${100 - i * 20}, ${0.8 * cur.ring})`;
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
