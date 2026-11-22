import { build as viteBuild } from "vite";
import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname);
const dist = resolve(root, "dist");

/** Generates a razor-sharp RGBA PNG with 4x4 supersampling anti-aliasing. */
function makePng(size, sampleFn) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const SS = 4; // 4x4 supersampling per pixel
  const invTotal = 1 / (SS * SS);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = ((x + (sx + 0.5) / SS) / size) * 2 - 1; // -1..1
          const ny = ((y + (sy + 0.5) / SS) / size) * 2 - 1; // -1..1
          const [r, g, b, a] = sampleFn(nx, ny);
          const af = a / 255;
          rAcc += r * af;
          gAcc += g * af;
          bAcc += b * af;
          aAcc += af;
        }
      }

      const avgA = aAcc * invTotal;
      const px = rowStart + 1 + x * 4;
      if (avgA > 0.001) {
        raw[px] = Math.round(Math.min(255, (rAcc * invTotal) / avgA));
        raw[px + 1] = Math.round(Math.min(255, (gAcc * invTotal) / avgA));
        raw[px + 2] = Math.round(Math.min(255, (bAcc * invTotal) / avgA));
        raw[px + 3] = Math.round(Math.min(255, avgA * 255));
      } else {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      }
    }
  }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const C_INK = [9, 9, 11, 255]; // #09090B
const C_BONE = [234, 229, 217, 255]; // #EAE5D9
const C_MINT = [46, 230, 197, 255]; // #2EE6C5
const C_VERMILION = [240, 90, 40, 255]; // #F05A28
const C_OCHRE = [244, 180, 26, 255]; // #F4B41A
const C_VIOLET = [139, 110, 255, 255]; // #8B6EFF
const C_TRANSPARENT = [0, 0, 0, 0];

/** Signed distance to a rounded square centered at 0 with half-extent `h` and corner radius `r`. */
function sdRoundBox(x, y, h, r) {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Point-in-triangle check for upward triangle centered at (cx, cy). */
function inUpTriangle(x, y, cx, cy, halfW, height) {
  const dy = y - cy;
  if (dy < -height * 0.5 || dy > height * 0.5) return false;
  const t = (dy + height * 0.5) / height; // 0 at apex, 1 at base
  return Math.abs(x - cx) <= halfW * t;
}

/**
 * 1. IDLE (Default Extension Icon):
 * Flat obsidian brutalist tile with crisp Mint (#2EE6C5) border + Bauhaus split-circle emblem.
 */
function drawIconIdle(x, y) {
  const dBox = sdRoundBox(x, y, 0.94, 0.14);
  if (dBox > 0) return C_TRANSPARENT;

  // Crisp Mint outer border
  if (dBox > -0.11) return C_MINT;

  const dist = Math.hypot(x, y);
  // Top Mint semicircle
  if (y <= 0 && dist <= 0.54) return C_MINT;
  // Bottom Bone semicircle ring
  if (y > 0.04 && dist <= 0.54 && dist >= 0.37) return C_BONE;
  // Center lower Mint geometric dot
  if (Math.hypot(x, y - 0.24) <= 0.13) return C_MINT;

  return C_INK;
}

/**
 * 2. DICTATION (Transcribing):
 * Solid flat Mint (#2EE6C5) tile with obsidian 8-ray Claude-inspired geometric starburst.
 */
function drawIconDictation(x, y) {
  const dBox = sdRoundBox(x, y, 0.94, 0.14);
  if (dBox > 0) return C_TRANSPARENT;
  if (dBox > -0.09) return C_INK;

  const dist = Math.hypot(x, y);
  // Inner hub cut-out
  if (dist <= 0.11) return C_MINT;
  if (dist <= 0.24) return C_INK;

  // 8 crisp radial rays (cardinal + diagonal)
  if (dist <= 0.68) {
    const thickness = 0.11;
    // Cardinal rays
    if (Math.abs(x) <= thickness || Math.abs(y) <= thickness) return C_INK;
    // Diagonal rays (rotated 45 deg, slightly shorter)
    if (dist <= 0.58) {
      const rx = (x + y) * 0.7071;
      const ry = (y - x) * 0.7071;
      if (Math.abs(rx) <= thickness * 0.92 || Math.abs(ry) <= thickness * 0.92) return C_INK;
    }
  }

  return C_MINT;
}

/**
 * 3. RECORDING (Screen Capture):
 * Solid flat Vermilion (#F05A28) tile with obsidian concentric geometric square frame + core.
 */
function drawIconRecording(x, y) {
  const dBox = sdRoundBox(x, y, 0.94, 0.14);
  if (dBox > 0) return C_TRANSPARENT;
  if (dBox > -0.09) return C_INK;

  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const m = Math.max(ax, ay);

  // Solid center square
  if (m <= 0.27) return C_INK;
  // Concentric outer geometric frame
  if (m >= 0.48 && m <= 0.63) return C_INK;

  return C_VERMILION;
}

/**
 * 4. PAUSED:
 * Solid flat Ochre (#F4B41A) tile with twin obsidian Bauhaus vertical monolith bars.
 */
function drawIconPaused(x, y) {
  const dBox = sdRoundBox(x, y, 0.94, 0.14);
  if (dBox > 0) return C_TRANSPARENT;
  if (dBox > -0.09) return C_INK;

  if (Math.abs(y) <= 0.54) {
    if ((x >= -0.44 && x <= -0.14) || (x >= 0.14 && x <= 0.44)) {
      return C_INK;
    }
  }

  return C_OCHRE;
}

/**
 * 5. UPLOADING (Notion):
 * Solid flat Violet (#8B6EFF) tile with stacked upward Bauhaus triangles.
 */
function drawIconUploading(x, y) {
  const dBox = sdRoundBox(x, y, 0.94, 0.14);
  if (dBox > 0) return C_TRANSPARENT;
  if (dBox > -0.09) return C_INK;

  if (inUpTriangle(x, y, 0, -0.22, 0.54, 0.46) || inUpTriangle(x, y, 0, 0.28, 0.54, 0.46)) {
    return C_INK;
  }

  return C_VIOLET;
}

async function run() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(resolve(dist, "icons"), { recursive: true });

  // 1. Build HTML/React UI pages with Vite
  await viteBuild();

  // 2. Bundle Service Worker, Overlay & Injector scripts with esbuild
  await Promise.all([
    esbuild.build({
      entryPoints: [resolve(root, "src/background/sw.ts")],
      outfile: resolve(dist, "sw.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: false,
      sourcemap: false,
    }),
    esbuild.build({
      entryPoints: [resolve(root, "src/content/overlayMain.ts")],
      outfile: resolve(dist, "overlay.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: false,
      sourcemap: false,
    }),
    esbuild.build({
      entryPoints: [resolve(root, "src/content/injectorMain.ts")],
      outfile: resolve(dist, "injector.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: false,
      sourcemap: false,
    }),
  ]);

  // 3. Copy manifest & generate flat Bauhaus PNG icons (default + per-function dynamic states)
  copyFileSync(resolve(root, "public/manifest.json"), resolve(dist, "manifest.json"));

  for (const s of [16, 32, 48, 128]) {
    writeFileSync(resolve(dist, `icons/icon${s}.png`), makePng(s, drawIconIdle));
  }

  const stateDrawers = {
    dictation: drawIconDictation,
    recording: drawIconRecording,
    paused: drawIconPaused,
    uploading: drawIconUploading,
  };

  for (const [name, drawer] of Object.entries(stateDrawers)) {
    for (const s of [16, 32]) {
      writeFileSync(resolve(dist, `icons/${name}-${s}.png`), makePng(s, drawer));
    }
  }

  console.log("RECO Chrome Extension built successfully -> dist/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
