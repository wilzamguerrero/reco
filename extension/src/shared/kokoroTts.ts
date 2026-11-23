/**
 * Motor unificado de voz natural (TTS) para RECO:
 *  - `supertonic`: Supertonic-3 ONNX Web local (thuongvv/Supertonic-3-ONNX-Web, español nativo)
 *  - `pocket`:     Pocket TTS local (vlapky/pocket-tts-js, español streaming + clonación de voz!)
 *  - `piper`:      Piper TTS local (WASM/ONNX, voces neuronales en español y caché OPFS)
 *  - `kokoro`:     Kokoro-82M local (WebGPU/WASM, voces verificadas de kokoro-js)
 *  - `moss`:       MOSS-TTS-Nano (Hugging Face Space OpenMOSS-Team/MOSS-TTS-Nano)
 *  - `system`:     Voces instaladas del sistema operativo (instantáneo)
 *  - `off`:        Solo texto
 */

import { getCustomVoicePcm } from "./storage";
import { SUPERTONIC_VOICES, synthesizeSupertonicSentence } from "./supertonicTts";
import type { TtsEngineMode } from "./types";

export { SUPERTONIC_VOICES };

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MOSS_SPACE_BASE = "https://openmoss-team-moss-tts-nano.hf.space";

export interface VoiceOption {
  id: string;
  label: string;
}

export const POCKET_VOICES: VoiceOption[] = [
  { id: "__custom__", label: "★ Mi voz clonada (Custom)" },
  { id: "alba", label: "Alba (ES)" },
  { id: "azelma", label: "Azelma (ES)" },
  { id: "cosette", label: "Cosette (ES)" },
  { id: "eponine", label: "Éponine (ES)" },
  { id: "fantine", label: "Fantine (ES)" },
  { id: "javert", label: "Javert (ES)" },
  { id: "jean", label: "Jean (ES)" },
  { id: "marius", label: "Marius (ES)" },
];

export const KOKORO_VOICES: VoiceOption[] = [
  { id: "af_heart", label: "Heart (Mujer)" },
  { id: "af_bella", label: "Bella (Mujer)" },
  { id: "af_nova", label: "Nova (Mujer)" },
  { id: "am_michael", label: "Michael (Hombre)" },
  { id: "am_fenrir", label: "Fenrir (Grave)" },
  { id: "bf_emma", label: "Emma (UK)" },
  { id: "bm_george", label: "George (UK)" },
];

export const PIPER_VOICES: VoiceOption[] = [
  { id: "es_MX-claude-high", label: "Claude (ES-MX)" },
  { id: "es_MX-ald-medium", label: "Ald (ES-MX)" },
  { id: "es_ES-davefx-medium", label: "Dave (ES-ES)" },
  { id: "es_ES-sharvard-medium", label: "Sharvard (ES-ES)" },
  { id: "en_US-lessac-medium", label: "Lessac (EN-US)" },
];

export const MOSS_VOICES: VoiceOption[] = [
  { id: "default", label: "MOSS Natural" },
];

type KokoroInstance = {
  generate(
    text: string,
    opts?: { voice?: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

let kokoroPromise: Promise<KokoroInstance> | null = null;
const piperSessions = new Map<string, Promise<{ predict(text: string): Promise<Blob> }>>();
type PocketInstance = {
  sampleRate: number;
  load(onProgress?: (p: { label?: string; loaded?: number; total?: number; status?: string }) => void): Promise<unknown>;
  loadVoice(name: string): Promise<string>;
  cloneVoice(audio: Float32Array, opts?: { inputSampleRate?: number; name?: string }): Promise<string>;
  generate(
    text: string,
    opts: { voice: string; onChunk?: (audio: Float32Array, meta?: unknown) => void },
  ): Promise<unknown>;
  stop(): Promise<void>;
  destroy(): void;
};
type PocketPlayer = {
  resume(): Promise<void>;
  play(audio: Float32Array, meta?: unknown): void;
  flush(): void;
  stop(): void;
};
let pocketPromise: Promise<{ tts: PocketInstance }> | null = null;
let pocketHasCloning = false;
let activePocketTts: PocketInstance | null = null;
let activePocketPlayer: PocketPlayer | null = null;
let cachedPocketCustomVoiceRef: string | null = null;
const cachedPocketBuiltInVoices = new Map<string, string>();
let activeCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let activeAudioEl: HTMLAudioElement | null = null;
let activeAbort: AbortController | null = null;
let speakSeq = 0;

export function invalidateCustomPocketVoice(): void {
  cachedPocketCustomVoiceRef = null;
}

async function loadPocket(needsCloning: boolean, onStatus?: (s: string | null) => void) {
  // Reuse already-loaded worker! Only recreate if user switches to cloned voice
  // and current worker was initialized without mimi_encoder.
  if (pocketPromise && (!needsCloning || pocketHasCloning)) {
    return pocketPromise;
  }
  if (activePocketTts) {
    try {
      activePocketTts.destroy();
    } catch {
      // ignore
    }
    activePocketTts = null;
    pocketPromise = null;
    cachedPocketBuiltInVoices.clear();
    cachedPocketCustomVoiceRef = null;
  }

  pocketHasCloning = needsCloning;
  pocketPromise = (async () => {
    onStatus?.(needsCloning ? "Preparando Pocket TTS + clonación…" : "Preparando Pocket TTS (español)…");
    const mod = (await import("pocket-tts-js")) as unknown as {
      PocketTTS: new (opts: Record<string, unknown>) => PocketInstance;
    };
    const tts = new mod.PocketTTS({
      language: "spanish",
      quantized: true,
      voiceCloning: needsCloning,
      ortBaseUrl: chrome.runtime.getURL("ort/"),
      maxThreads: 1,
      cache: true,
    });
    activePocketTts = tts;
    await tts.load((p) => {
      if (p.total && p.total > 0 && p.loaded !== undefined) {
        const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
        onStatus?.(`Pocket TTS · ${p.label || "modelo"} ${pct}%`);
      } else if (p.status) {
        onStatus?.(`Pocket TTS · ${p.status}…`);
      }
    });
    onStatus?.(null);
    return { tts };
  })();

  try {
    return await pocketPromise;
  } catch (err) {
    pocketPromise = null;
    pocketHasCloning = false;
    activePocketTts = null;
    onStatus?.(null);
    throw err;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Tiempo agotado (${label})`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function makeTimedSignal(parent: AbortSignal | undefined, ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(new Error("Timeout")), ms);
  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function stripMarkdownForSpeech(raw: string): string {
  return raw
    .replace(/\[\[ACTION:[^\]]+\]\]/g, " ")
    .replace(/```[\s\S]*?```/g, " bloque de código ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoSentences(text: string): string[] {
  const parts = text.match(/[^.!?…\n]+[.!?…]?/g) ?? [text];
  const merged: string[] = [];
  let cur = "";
  for (const p of parts) {
    const clean = p.trim();
    if (!clean) continue;
    if ((cur + " " + clean).length < 180) {
      cur = cur ? `${cur} ${clean}` : clean;
    } else {
      if (cur) merged.push(cur);
      cur = clean;
    }
  }
  if (cur) merged.push(cur);
  return merged;
}

async function loadKokoro(onStatus?: (s: string | null) => void): Promise<KokoroInstance> {
  if (kokoroPromise) return kokoroPromise;

  kokoroPromise = (async () => {
    onStatus?.("Cargando Kokoro-82M local (1 sola vez)…");
    const kokoroMod = await import("kokoro-js");
    const { KokoroTTS, env: kokoroEnv } = kokoroMod;

    const kokoroEnvObj = kokoroEnv as unknown as {
      allowLocalModels?: boolean;
      useBrowserCache?: boolean;
      backends?: { onnx?: { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } };
    };
    if (kokoroEnvObj) {
      kokoroEnvObj.allowLocalModels = false;
      kokoroEnvObj.useBrowserCache = true;
      const wasmCfg = kokoroEnvObj.backends?.onnx?.wasm;
      if (wasmCfg) {
        wasmCfg.wasmPaths = chrome.runtime.getURL("ort/");
        wasmCfg.numThreads = 1;
        wasmCfg.proxy = false;
      }
    }

    const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    try {
      const inst = (await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: "q8",
        device: hasWebGpu ? "webgpu" : "wasm",
      })) as unknown as KokoroInstance;
      onStatus?.(null);
      return inst;
    } catch {
      const inst = (await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: "q8",
        device: "wasm",
      })) as unknown as KokoroInstance;
      onStatus?.(null);
      return inst;
    }
  })();

  try {
    return await kokoroPromise;
  } catch (err) {
    kokoroPromise = null;
    onStatus?.(null);
    throw err;
  }
}

let cachedPiperPhonemizeUrls: Promise<{ piperWasm: string; piperData: string }> | null = null;

async function getCachedPiperPhonemizeUrls(
  defaultWasm: string,
  defaultData: string,
  onStatus?: (s: string | null) => void,
): Promise<{ piperWasm: string; piperData: string }> {
  if (cachedPiperPhonemizeUrls) return cachedPiperPhonemizeUrls;

  cachedPiperPhonemizeUrls = (async () => {
    const fetchAsBlobUrl = async (url: string, mime: string, label: string) => {
      let cache: Cache | null = null;
      try {
        if (typeof caches !== "undefined") cache = await caches.open("reco-piper-assets-v1");
      } catch {
        cache = null;
      }
      if (cache) {
        const hit = await cache.match(url).catch(() => undefined);
        if (hit) {
          const buf = await hit.arrayBuffer();
          return URL.createObjectURL(new Blob([buf], { type: mime }));
        }
      }
      onStatus?.(`Descargando ${label} (1 sola vez)…`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} (${label})`);
      if (cache) void cache.put(url, res.clone()).catch(() => {});
      const buf = await res.arrayBuffer();
      return URL.createObjectURL(new Blob([buf], { type: mime }));
    };

    const [piperWasm, piperData] = await Promise.all([
      fetchAsBlobUrl(defaultWasm, "application/wasm", "Piper WASM"),
      fetchAsBlobUrl(defaultData, "application/octet-stream", "Piper fonemas"),
    ]);
    return { piperWasm, piperData };
  })();

  try {
    return await cachedPiperPhonemizeUrls;
  } catch (err) {
    cachedPiperPhonemizeUrls = null;
    throw err;
  }
}

async function loadPiper(
  voiceId: string,
  onStatus?: (s: string | null) => void,
): Promise<{ predict(text: string): Promise<Blob> }> {
  const validVoice = PIPER_VOICES.some((v) => v.id === voiceId) ? voiceId : PIPER_VOICES[0].id;
  const cached = piperSessions.get(validVoice);
  if (cached) return cached;

  const loader = (async () => {
    onStatus?.(`Preparando Piper (${validVoice})…`);
    const piper = await import("@mintplex-labs/piper-tts-web");
    const localOrt = chrome.runtime.getURL("ort/");

    const TtsSessionAny = piper.TtsSession as unknown as {
      WASM_LOCATIONS: { onnxWasm: string; piperData: string; piperWasm: string };
      _instance: unknown;
    };
    const origWasm = TtsSessionAny.WASM_LOCATIONS.piperWasm;
    const origData = TtsSessionAny.WASM_LOCATIONS.piperData;
    const localAssets = await getCachedPiperPhonemizeUrls(origWasm, origData, onStatus);

    // Workaround for piper-tts-web@1.0.5 bug: constructor calls this.init() BEFORE
    // setting private #wasmPaths, so we must patch TtsSession.WASM_LOCATIONS first
    // AND clear the static _instance singleton when switching voices.
    TtsSessionAny.WASM_LOCATIONS.onnxWasm = localOrt;
    TtsSessionAny.WASM_LOCATIONS.piperWasm = localAssets.piperWasm;
    TtsSessionAny.WASM_LOCATIONS.piperData = localAssets.piperData;
    TtsSessionAny._instance = null;

    const session = await withTimeout(
      piper.TtsSession.create({
        voiceId: validVoice,
        wasmPaths: {
          onnxWasm: localOrt,
          piperData: localAssets.piperData,
          piperWasm: localAssets.piperWasm,
        },
        progress: (p) => {
          if (p.total > 0) {
            const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
            onStatus?.(pct >= 100 ? "Inicializando voz Piper…" : `Descargando voz Piper · ${pct}%`);
          }
        },
      }),
      40_000,
      "Piper init",
    );
    onStatus?.(null);
    return session;
  })();

  piperSessions.set(validVoice, loader);
  try {
    return await loader;
  } catch (err) {
    piperSessions.delete(validVoice);
    onStatus?.(null);
    throw err;
  }
}

let cachedMossPromptFile: unknown | null = null;

async function synthesizeMossAudioUrl(
  text: string,
  parentSignal: AbortSignal | undefined,
  onStatus?: (s: string | null) => void,
): Promise<string> {
  onStatus?.("Sintetizando con MOSS-TTS-Nano…");

  if (!cachedMossPromptFile) {
    const tDemo = makeTimedSignal(parentSignal, 10_000);
    try {
      const r1 = await fetch(`${MOSS_SPACE_BASE}/gradio_api/call/apply_demo_case_selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: ["demo-1", null] }),
        signal: tDemo.signal,
      });
      if (r1.ok) {
        const { event_id } = (await r1.json()) as { event_id?: string };
        if (event_id) {
          const r2 = await fetch(
            `${MOSS_SPACE_BASE}/gradio_api/call/apply_demo_case_selection/${event_id}`,
            { signal: tDemo.signal },
          );
          if (r2.ok) {
            const txt = await r2.text();
            const line = txt.split("\n").reverse().find((l) => l.startsWith("data:") && l.slice(5).trim() !== "null");
            if (line) {
              const arr = JSON.parse(line.slice(5).trim()) as unknown[];
              cachedMossPromptFile = arr?.[1] ?? null;
            }
          }
        }
      }
    } finally {
      tDemo.cleanup();
    }
  }

  const dataPayload = [
    text,
    cachedMossPromptFile,
    true,
    true,
    250,
    75,
    true,
    1.0,
    1.0,
    50,
    0.8,
    0.95,
    25,
    1.2,
    0,
  ];

  const timedCall = makeTimedSignal(parentSignal, 10_000);
  let eventId = "";
  try {
    const callRes = await fetch(`${MOSS_SPACE_BASE}/gradio_api/call/run_inference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dataPayload }),
      signal: timedCall.signal,
    });
    if (!callRes.ok) throw new Error(`MOSS HTTP ${callRes.status}`);
    const payload = (await callRes.json()) as { event_id?: string };
    eventId = payload.event_id ?? "";
  } finally {
    timedCall.cleanup();
  }
  if (!eventId) throw new Error("MOSS no devolvió event_id");

  const timedSse = makeTimedSignal(parentSignal, 14_000);
  let bodyText = "";
  try {
    const sseRes = await fetch(`${MOSS_SPACE_BASE}/gradio_api/call/run_inference/${eventId}`, {
      signal: timedSse.signal,
    });
    if (!sseRes.ok) throw new Error(`MOSS stream HTTP ${sseRes.status}`);
    bodyText = await sseRes.text();
  } finally {
    timedSse.cleanup();
  }

  if (/\bevent:\s*error\b/i.test(bodyText)) {
    throw new Error("HF Space sin cuota ZeroGPU");
  }
  const dataLine = bodyText
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("data:") && l.slice(5).trim() !== "null");
  if (!dataLine) throw new Error("MOSS no devolvió audio");

  const parsed = JSON.parse(dataLine.slice(5).trim()) as unknown[];
  const first = parsed?.[0] as { url?: string; path?: string } | string | undefined;
  const url =
    typeof first === "string"
      ? first
      : first?.url || (first?.path ? `${MOSS_SPACE_BASE}/gradio_api/file=${first.path}` : "");
  onStatus?.(null);
  if (!url) throw new Error("MOSS no devolvió URL de audio");
  return url;
}

export function stopSpeaking(): void {
  speakSeq += 1;
  try {
    activeAbort?.abort();
  } catch {
    // ignore
  }
  activeAbort = null;
  try {
    activePocketPlayer?.stop();
  } catch {
    // ignore
  }
  activePocketPlayer = null;
  if (activePocketTts) {
    void activePocketTts.stop().catch(() => {});
  }
  try {
    activeSource?.stop();
  } catch {
    // ignore
  }
  activeSource = null;
  if (activeAudioEl) {
    try {
      activeAudioEl.pause();
      activeAudioEl.src = "";
    } catch {
      // ignore
    }
    activeAudioEl = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function playPcm(samples: Float32Array, sampleRate: number, seq: number): Promise<void> {
  return new Promise((resolve) => {
    if (seq !== speakSeq) {
      resolve();
      return;
    }
    if (!activeCtx || activeCtx.state === "closed") {
      activeCtx = new AudioContext();
    }
    const buf = activeCtx.createBuffer(1, samples.length, sampleRate);
    buf.getChannelData(0).set(samples);
    const src = activeCtx.createBufferSource();
    src.buffer = buf;
    src.connect(activeCtx.destination);
    activeSource = src;
    src.onended = () => {
      if (activeSource === src) activeSource = null;
      resolve();
    };
    src.start();
  });
}

function playAudioUrl(url: string, revokeAfter: boolean, seq: number): Promise<void> {
  return new Promise((resolve) => {
    if (seq !== speakSeq) {
      if (revokeAfter) URL.revokeObjectURL(url);
      resolve();
      return;
    }
    const audio = new Audio(url);
    activeAudioEl = audio;
    const finish = () => {
      if (activeAudioEl === audio) activeAudioEl = null;
      if (revokeAfter) URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = finish;
    audio.onerror = finish;
    void audio.play().catch(finish);
  });
}

export function getSystemVoices(): VoiceOption[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.filter((v) => /^(es|en)/i.test(v.lang));
  const list = preferred.length > 0 ? preferred : voices;
  return list.slice(0, 20).map((v) => ({
    id: v.voiceURI,
    label: `${v.name.replace(/Microsoft |Google /g, "").slice(0, 18)} (${v.lang.slice(0, 2).toUpperCase()})`,
  }));
}

function speakSystem(text: string, voiceUri?: string, speed?: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const match =
      (voiceUri ? voices.find((v) => v.voiceURI === voiceUri) : undefined) ??
      voices.find((v) => v.lang.toLowerCase().startsWith("es"));
    if (match) {
      u.voice = match;
      u.lang = match.lang;
    } else {
      u.lang = "es-ES";
    }
    u.rate = Math.max(0.75, Math.min(1.4, speed ?? 1.05));
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function speakReply(opts: {
  text: string;
  mode: TtsEngineMode;
  voice: string;
  speed?: number;
  onStatus?: (status: string | null) => void;
}): Promise<void> {
  if (opts.mode === "off") return;
  const clean = stripMarkdownForSpeech(opts.text);
  if (!clean) return;

  stopSpeaking();
  const seq = speakSeq;
  const localAbort = new AbortController();
  activeAbort = localAbort;
  const speed = Math.max(0.75, Math.min(1.4, opts.speed ?? 1.05));

  if (opts.mode === "system") {
    await speakSystem(clean, opts.voice, speed);
    return;
  }

  if (opts.mode === "supertonic") {
    try {
      const sentences = splitIntoSentences(clean);
      // Pipeline lookahead: synthesize next sentence while current sentence plays!
      let nextSynth: Promise<{ audio: Float32Array; sampleRate: number }> | null =
        sentences.length > 0
          ? synthesizeSupertonicSentence({
              text: sentences[0],
              voice: opts.voice,
              speed,
              steps: 3,
              onStatus: opts.onStatus,
            })
          : null;

      for (let i = 0; i < sentences.length; i++) {
        if (seq !== speakSeq || !nextSynth) break;
        const { audio, sampleRate } = await nextSynth;
        if (seq !== speakSeq) break;
        opts.onStatus?.(null);

        nextSynth =
          i + 1 < sentences.length
            ? synthesizeSupertonicSentence({
                text: sentences[i + 1],
                voice: opts.voice,
                speed,
                steps: 3,
              })
            : null;

        await playPcm(audio, sampleRate, seq);
      }
      opts.onStatus?.(null);
      return;
    } catch (err) {
      if (seq !== speakSeq) {
        opts.onStatus?.(null);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.(`Supertonic respaldo voz sistema (${msg.slice(0, 44)})`);
      window.setTimeout(() => opts.onStatus?.(null), 2600);
      if (seq === speakSeq) await speakSystem(clean, undefined, speed);
      return;
    }
  }

  if (opts.mode === "pocket") {
    try {
      const needsCloning = opts.voice === "__custom__";
      const { tts } = await loadPocket(needsCloning, opts.onStatus);
      if (seq !== speakSeq) return;

      let voiceRef: string;
      if (needsCloning) {
        if (cachedPocketCustomVoiceRef) {
          voiceRef = cachedPocketCustomVoiceRef;
        } else {
          const saved = await getCustomVoicePcm();
          if (saved) {
            opts.onStatus?.(`Clonando voz (${saved.name})…`);
            voiceRef = await tts.cloneVoice(saved.pcm, {
              inputSampleRate: saved.sampleRate,
              name: "reco_custom",
            });
            cachedPocketCustomVoiceRef = voiceRef;
          } else {
            const fallback = "alba";
            voiceRef =
              cachedPocketBuiltInVoices.get(fallback) ?? (await tts.loadVoice(fallback));
            cachedPocketBuiltInVoices.set(fallback, voiceRef);
          }
        }
      } else {
        const chosen = POCKET_VOICES.some((v) => v.id === opts.voice && v.id !== "__custom__")
          ? opts.voice
          : "alba";
        voiceRef =
          cachedPocketBuiltInVoices.get(chosen) ?? (await tts.loadVoice(chosen));
        cachedPocketBuiltInVoices.set(chosen, voiceRef);
      }

      if (seq !== speakSeq) return;

      // Buffer each sentence into a single seamless Float32Array to eliminate
      // choppy underrun cuts on single-threaded WASM!
      const sentences = splitIntoSentences(clean);
      for (const sentence of sentences) {
        if (seq !== speakSeq) break;
        const chunks: Float32Array[] = [];
        await tts.generate(sentence, {
          voice: voiceRef,
          onChunk: (audio) => {
            if (seq === speakSeq && audio && audio.length > 0) {
              chunks.push(new Float32Array(audio));
            }
          },
        });
        if (seq !== speakSeq) break;
        opts.onStatus?.(null);
        if (chunks.length > 0) {
          await playPcm(concatFloat32(chunks), tts.sampleRate, seq);
        }
      }
      opts.onStatus?.(null);
      return;
    } catch (err) {
      if (seq !== speakSeq) {
        opts.onStatus?.(null);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.(`Pocket respaldo voz sistema (${msg.slice(0, 44)})`);
      window.setTimeout(() => opts.onStatus?.(null), 2600);
      if (seq === speakSeq) await speakSystem(clean, undefined, speed);
      return;
    }
  }

  if (opts.mode === "piper") {
    try {
      const session = await loadPiper(opts.voice, opts.onStatus);
      if (seq !== speakSeq) return;
      const sentences = splitIntoSentences(clean);
      for (const sentence of sentences) {
        if (seq !== speakSeq) break;
        const blob = await withTimeout(session.predict(sentence), 15_000, "Piper voz");
        if (seq !== speakSeq) break;
        await playAudioUrl(URL.createObjectURL(blob), true, seq);
      }
      opts.onStatus?.(null);
      return;
    } catch (err) {
      if (seq !== speakSeq) {
        opts.onStatus?.(null);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.(`Piper respaldo voz sistema (${msg.slice(0, 48)})`);
      window.setTimeout(() => opts.onStatus?.(null), 2400);
      if (seq === speakSeq) await speakSystem(clean);
      return;
    }
  }

  if (opts.mode === "moss") {
    try {
      const url = await synthesizeMossAudioUrl(clean.slice(0, 450), localAbort.signal, opts.onStatus);
      if (seq !== speakSeq) return;
      await playAudioUrl(url, false, seq);
      opts.onStatus?.(null);
      return;
    } catch (err) {
      if (seq !== speakSeq) {
        opts.onStatus?.(null);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.(`MOSS ocupado, usando respaldo (${msg.slice(0, 44)})`);
      window.setTimeout(() => opts.onStatus?.(null), 2400);
      if (seq === speakSeq) await speakSystem(clean);
      return;
    }
  }

  // Kokoro-82M
  const validVoice = KOKORO_VOICES.some((v) => v.id === opts.voice)
    ? opts.voice
    : KOKORO_VOICES[0].id;

  try {
    const tts = await loadKokoro(opts.onStatus);
    if (seq !== speakSeq) return;
    const sentences = splitIntoSentences(clean);
    for (const sentence of sentences) {
      if (seq !== speakSeq) break;
      const result = await tts.generate(sentence, {
        voice: validVoice,
        speed,
      });
      if (seq !== speakSeq) break;
      await playPcm(result.audio, result.sampling_rate, seq);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onStatus?.(`Kokoro respaldo voz sistema (${msg.slice(0, 50)})`);
    window.setTimeout(() => opts.onStatus?.(null), 2400);
    if (seq === speakSeq) {
      await speakSystem(clean);
    }
  }
}
