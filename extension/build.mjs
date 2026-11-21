import { build as viteBuild } from "vite";
import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname);
const dist = resolve(root, "dist");

/** Generates a clean RGBA PNG buffer without external native dependencies. */
function makePng(size, drawPixel) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawPixel(x, y, size);
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
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

/** Draws the RECO glowing sphere icon on a dark rounded square. */
function drawRecoIcon(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const nx = (x + 0.5 - cx) / (size / 2);
  const ny = (y + 0.5 - cy) / (size / 2);

  // Rounded square mask
  const corner = 0.55;
  const ax = Math.max(0, Math.abs(nx) - (1 - corner));
  const ay = Math.max(0, Math.abs(ny) - (1 - corner));
  const boxDist = Math.hypot(ax, ay) - corner;
  if (boxDist > 0.02) return [0, 0, 0, 0];

  const aa = boxDist > -0.04 ? Math.max(0, Math.min(1, (-boxDist + 0.02) / 0.06)) : 1;

  // Background
  let r = 10;
  let g = 10;
  let b = 12;

  const dist = Math.hypot(nx, ny);
  // Subtle outer halo
  if (dist < 0.85) {
    const halo = Math.pow(Math.max(0, 1 - dist / 0.85), 2.2) * 0.45;
    r = Math.min(255, r + 255 * halo);
    g = Math.min(255, g + 74 * halo);
    b = Math.min(255, b + 61 * halo);
  }

  // Sphere core
  const sphereR = 0.54;
  if (dist <= sphereR) {
    const hlx = nx + 0.16;
    const hly = ny + 0.18;
    const hd = Math.hypot(hlx, hly) / sphereR;
    const t = Math.max(0, 1 - hd * 0.85);
    const rim = Math.max(0, Math.min(1, (sphereR - dist) / 0.07));
    const sr = 120 + 135 * t;
    const sg = 15 + 170 * Math.pow(t, 1.8);
    const sb = 12 + 145 * Math.pow(t, 2.5);
    r = r * (1 - rim) + sr * rim;
    g = g * (1 - rim) + sg * rim;
    b = b * (1 - rim) + sb * rim;
  }

  return [Math.round(r), Math.round(g), Math.round(b), Math.round(255 * aa)];
}

async function run() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(resolve(dist, "icons"), { recursive: true });

  // 1. Build HTML/React UI pages with Vite
  await viteBuild();

  // 2. Bundle Service Worker & Content Script with esbuild
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
      entryPoints: [resolve(root, "src/content/content.ts")],
      outfile: resolve(dist, "content.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: false,
      sourcemap: false,
    }),
  ]);

  // 3. Copy manifest & generate PNG icons
  copyFileSync(resolve(root, "public/manifest.json"), resolve(dist, "manifest.json"));
  for (const s of [16, 32, 48, 128]) {
    writeFileSync(resolve(dist, `icons/icon${s}.png`), makePng(s, drawRecoIcon));
  }

  console.log("RECO Chrome Extension built successfully -> dist/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
