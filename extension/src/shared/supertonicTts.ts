/**
 * Motor local Supertonic-3 ONNX Web para RECO:
 *  - Usa `thuongvv/Supertonic-3-ONNX-Web` (`vector_estimator.onnx` + `vector_estimator.q8`, ~65 MB)
 *    reconstruido en memoria una sola vez como `vector_estimator.data` (Float32 rápido en WASM).
 *  - Usa `Supertone/supertonic-3` para `duration_predictor.onnx`, `text_encoder.onnx`,
 *    `vocoder.onnx`, `tts.json`, `unicode_indexer.json` y estilos de voz (`F1`–`F5`, `M1`–`M5`).
 *  - Soporta español nativo (`<es>...</es>`), velocidad ajustable y caché persistente en Cache Storage.
 */

import * as ort from "onnxruntime-web/wasm";

const SUPERTONIC_BASE = "https://huggingface.co/Supertone/supertonic-3/resolve/main";
const WEB_VEC_BASE = "https://huggingface.co/thuongvv/Supertonic-3-ONNX-Web/resolve/main";
const CACHE_NAME = "reco-supertonic3-v1";

export const SUPERTONIC_VOICES = [
  { id: "F1", label: "F1 · Clara (ES)" },
  { id: "F2", label: "F2 · Sofía (ES)" },
  { id: "F3", label: "F3 · Elena (ES)" },
  { id: "F4", label: "F4 · Valeria (ES)" },
  { id: "F5", label: "F5 · Camila (ES)" },
  { id: "M1", label: "M1 · Mateo (ES)" },
  { id: "M2", label: "M2 · Lucas (ES)" },
  { id: "M3", label: "M3 · Diego (ES)" },
  { id: "M4", label: "M4 · Daniel (ES)" },
  { id: "M5", label: "M5 · Bruno (ES)" },
];

interface SupertonicCfg {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

interface VoiceStyleTensor {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

interface SupertonicEngine {
  cfg: SupertonicCfg;
  indexer: number[];
  dpOrt: ort.InferenceSession;
  textEncOrt: ort.InferenceSession;
  vectorEstOrt: ort.InferenceSession;
  vocoderOrt: ort.InferenceSession;
}

let enginePromise: Promise<SupertonicEngine> | null = null;
const styleCache = new Map<string, Promise<VoiceStyleTensor>>();

async function fetchCachedBytes(
  url: string,
  label: string,
  onStatus?: (s: string | null) => void,
): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    if (typeof caches !== "undefined") cache = await caches.open(CACHE_NAME);
  } catch {
    cache = null;
  }

  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        onStatus?.(`Supertonic-3 · cargando ${label} (caché)…`);
        return new Uint8Array(await hit.arrayBuffer());
      }
    } catch {
      // fall through
    }
  }

  onStatus?.(`Supertonic-3 · descargando ${label}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${label}`);
  const forCache = cache ? res.clone() : null;

  const total = Number(res.headers.get("content-length")) || 0;
  let bytes: Uint8Array;
  if (res.body && total > 0) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
        lastPct = pct;
        onStatus?.(`Supertonic-3 · ${label} ${pct}%`);
      }
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }

  if (cache && forCache) {
    void cache.put(url, forCache).catch(() => {});
  }
  return bytes;
}

/**
 * Reconstruye `vector_estimator.data` (Float32) desde el formato compacto `.q8`
 * de `thuongvv/Supertonic-3-ONNX-Web`:
 *   [uint32 LE headerLen][UTF-8 JSON header][payload]
 */
function unpackVectorEstimatorQ8(q8Bytes: Uint8Array): { dataPath: string; data: Uint8Array } {
  const view = new DataView(q8Bytes.buffer, q8Bytes.byteOffset, q8Bytes.byteLength);
  const headerLen = view.getUint32(0, true);
  const headerJson = new TextDecoder().decode(q8Bytes.subarray(4, 4 + headerLen));
  const header = JSON.parse(headerJson) as {
    dataPath: string;
    size: number;
    tensors: Array<{
      offset: number;
      length: number;
      kind: "raw" | "q8";
      shape?: number[];
      axis?: number;
      q: number;
      s?: number;
    }>;
  };

  const payloadOffset = 4 + headerLen;
  const out = new Uint8Array(header.size);
  const outFloatView = new DataView(out.buffer);
  const payloadInt8 = new Int8Array(q8Bytes.buffer, q8Bytes.byteOffset + payloadOffset);

  for (const t of header.tensors) {
    if (t.kind === "raw") {
      out.set(q8Bytes.subarray(payloadOffset + t.q, payloadOffset + t.q + t.length), t.offset);
      continue;
    }

    const shape = t.shape ?? [];
    const axis = t.axis ?? 0;
    const axisSize = shape[axis] ?? 1;
    let innerStride = 1;
    for (let d = axis + 1; d < shape.length; d++) innerStride *= shape[d];

    const scales = new Float32Array(axisSize);
    const scaleBase = payloadOffset + (t.s ?? 0);
    for (let c = 0; c < axisSize; c++) {
      scales[c] = view.getFloat32(scaleBase + c * 4, true);
    }

    const count = t.length / 4;
    const qBase = t.q;
    const outBase = t.offset;
    for (let i = 0; i < count; i++) {
      const ch = Math.floor(i / innerStride) % axisSize;
      const val = payloadInt8[qBase + i] * scales[ch];
      outFloatView.setFloat32(outBase + i * 4, val, true);
    }
  }

  return { dataPath: header.dataPath || "vector_estimator.data", data: out };
}

async function loadSupertonic(onStatus?: (s: string | null) => void): Promise<SupertonicEngine> {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    if (ort.env?.wasm) {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    }

    const [cfgBytes, idxBytes] = await Promise.all([
      fetchCachedBytes(`${SUPERTONIC_BASE}/onnx/tts.json`, "config", onStatus),
      fetchCachedBytes(`${SUPERTONIC_BASE}/onnx/unicode_indexer.json`, "vocab", onStatus),
    ]);
    const cfg = JSON.parse(new TextDecoder().decode(cfgBytes)) as SupertonicCfg;
    const indexer = JSON.parse(new TextDecoder().decode(idxBytes)) as number[];

    const dpBytes = await fetchCachedBytes(`${SUPERTONIC_BASE}/onnx/duration_predictor.onnx`, "duración", onStatus);
    const textEncBytes = await fetchCachedBytes(`${SUPERTONIC_BASE}/onnx/text_encoder.onnx`, "texto", onStatus);
    const vecGraphBytes = await fetchCachedBytes(`${WEB_VEC_BASE}/vector_estimator.onnx`, "flujo (grafo)", onStatus);
    const vecQ8Bytes = await fetchCachedBytes(`${WEB_VEC_BASE}/vector_estimator.q8`, "flujo Q8 (65MB)", onStatus);
    const vocoderBytes = await fetchCachedBytes(`${SUPERTONIC_BASE}/onnx/vocoder.onnx`, "vocoder", onStatus);

    onStatus?.("Supertonic-3 · compilando motor local…");
    const { dataPath, data: vecExternalData } = unpackVectorEstimatorQ8(vecQ8Bytes);

    const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    const createSess = async (
      bytes: Uint8Array,
      extra?: Partial<ort.InferenceSession.SessionOptions>,
    ): Promise<ort.InferenceSession> => {
      if (hasWebGpu) {
        try {
          return await ort.InferenceSession.create(bytes, {
            ...extra,
            executionProviders: ["webgpu", "wasm"],
            graphOptimizationLevel: "all",
          });
        } catch {
          // Fall back cleanly to WASM
        }
      }
      return ort.InferenceSession.create(bytes, {
        ...extra,
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    };

    const dpOrt = await createSess(dpBytes);
    const textEncOrt = await createSess(textEncBytes);
    const vectorEstOrt = await createSess(vecGraphBytes, {
      externalData: [{ path: dataPath, data: vecExternalData }],
    });
    const vocoderOrt = await createSess(vocoderBytes);

    onStatus?.(null);
    return { cfg, indexer, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt };
  })();

  try {
    return await enginePromise;
  } catch (err) {
    enginePromise = null;
    onStatus?.(null);
    throw err;
  }
}

async function loadVoiceStyle(voiceId: string, onStatus?: (s: string | null) => void): Promise<VoiceStyleTensor> {
  const valid = SUPERTONIC_VOICES.some((v) => v.id === voiceId) ? voiceId : "F1";
  const cached = styleCache.get(valid);
  if (cached) return cached;

  const loader = (async () => {
    const bytes = await fetchCachedBytes(
      `${SUPERTONIC_BASE}/voice_styles/${valid}.json`,
      `voz ${valid}`,
      onStatus,
    );
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
      style_ttl: { dims: number[]; data: unknown[] };
      style_dp: { dims: number[]; data: unknown[] };
    };
    const ttlFlat = new Float32Array((raw.style_ttl.data as number[][][]).flat(Infinity) as number[]);
    const dpFlat = new Float32Array((raw.style_dp.data as number[][][]).flat(Infinity) as number[]);
    return {
      ttl: new ort.Tensor("float32", ttlFlat, raw.style_ttl.dims),
      dp: new ort.Tensor("float32", dpFlat, raw.style_dp.dims),
    };
  })();

  styleCache.set(valid, loader);
  try {
    return await loader;
  } catch (err) {
    styleCache.delete(valid);
    throw err;
  }
}

function preprocessText(raw: string, lang: "es" | "en"): string {
  let text = raw.normalize("NFKD");
  text = text.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu,
    "",
  );
  const replacements: Record<string, string> = {
    "–": "-",
    "‑": "-",
    "—": "-",
    _: " ",
    "\u201C": '"',
    "\u201D": '"',
    "\u2018": "'",
    "\u2019": "'",
    "´": "'",
    "`": "'",
    "[": " ",
    "]": " ",
    "|": " ",
    "/": " ",
    "#": " ",
    "→": " ",
    "←": " ",
  };
  for (const [k, v] of Object.entries(replacements)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'"'\])\}…]$/.test(text)) text += ".";
  return `<${lang}>${text}</${lang}>`;
}

function detectLang(text: string): "es" | "en" {
  if (/[áéíóúñ¿¡]/i.test(text)) return "es";
  const esHits = (text.match(/\b(el|la|los|las|que|de|por|para|con|una|como|hola|esto|esta|puedo|tengo)\b/gi) ?? []).length;
  const enHits = (text.match(/\b(the|and|that|with|from|this|have|your|what|hello|here|about)\b/gi) ?? []).length;
  return enHits > esHits + 1 ? "en" : "es";
}

export async function synthesizeSupertonicSentence(opts: {
  text: string;
  voice: string;
  speed?: number;
  steps?: number;
  onStatus?: (s: string | null) => void;
}): Promise<{ audio: Float32Array; sampleRate: number }> {
  const engine = await loadSupertonic(opts.onStatus);
  const style = await loadVoiceStyle(opts.voice, opts.onStatus);
  const lang = detectLang(opts.text);
  const processed = preprocessText(opts.text, lang);

  const ids = new BigInt64Array(processed.length);
  const mask = new Float32Array(processed.length);
  for (let i = 0; i < processed.length; i++) {
    const cp = processed.codePointAt(i) ?? 0;
    const mapped = cp < engine.indexer.length ? engine.indexer[cp] : -1;
    ids[i] = BigInt(mapped);
    mask[i] = 1.0;
  }

  const textIdsTensor = new ort.Tensor("int64", ids, [1, processed.length]);
  const textMaskTensor = new ort.Tensor("float32", mask, [1, 1, processed.length]);

  const dpOut = await engine.dpOrt.run({
    text_ids: textIdsTensor,
    style_dp: style.dp,
    text_mask: textMaskTensor,
  });
  const speed = Math.max(0.75, Math.min(1.4, opts.speed ?? 1.05));
  const rawDur = (dpOut.duration.data as Float32Array)[0] ?? 1.5;
  const durSec = Math.max(0.3, rawDur / speed);

  const textEncOut = await engine.textEncOrt.run({
    text_ids: textIdsTensor,
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  });

  const sr = engine.cfg.ae.sample_rate;
  const chunkSize = engine.cfg.ae.base_chunk_size * engine.cfg.ttl.chunk_compress_factor;
  const wavLen = Math.floor(durSec * sr);
  const latentLen = Math.max(1, Math.floor((wavLen + chunkSize - 1) / chunkSize));
  const latentDimVal = engine.cfg.ttl.latent_dim * engine.cfg.ttl.chunk_compress_factor;

  let xt = new Float32Array(latentDimVal * latentLen);
  for (let i = 0; i < xt.length; i++) {
    const u1 = Math.max(0.0001, Math.random());
    const u2 = Math.random();
    xt[i] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  const latentMask = new Float32Array(latentLen).fill(1.0);
  const latentMaskTensor = new ort.Tensor("float32", latentMask, [1, 1, latentLen]);
  const totalSteps = opts.steps ?? 3;
  const totalStepTensor = new ort.Tensor("float32", new Float32Array([totalSteps]), [1]);

  for (let step = 0; step < totalSteps; step++) {
    // Yield briefly so the browser UI stays fluid during WASM fallback
    await new Promise((r) => window.setTimeout(r, 0));
    const vecOut = await engine.vectorEstOrt.run({
      noisy_latent: new ort.Tensor("float32", xt, [1, latentDimVal, latentLen]),
      text_emb: textEncOut.text_emb,
      style_ttl: style.ttl,
      latent_mask: latentMaskTensor,
      text_mask: textMaskTensor,
      current_step: new ort.Tensor("float32", new Float32Array([step]), [1]),
      total_step: totalStepTensor,
    });
    xt = new Float32Array(vecOut.denoised_latent.data as Float32Array);
  }

  const vocOut = await engine.vocoderOrt.run({
    latent: new ort.Tensor("float32", xt, [1, latentDimVal, latentLen]),
  });

  const wav = new Float32Array(vocOut.wav_tts.data as Float32Array);
  return { audio: wav, sampleRate: sr };
}
