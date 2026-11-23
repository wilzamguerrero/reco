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
import { hasKyutaiServer, pocketLanguage, pocketWebVoices, streamKyutai, type PocketWebLanguage } from "./kyutaiPocket";
import { SUPERTONIC_VOICES, synthesizeSupertonicSentence } from "./supertonicTts";
import type { AiAssistantConfig, TtsEngineMode } from "./types";

export { SUPERTONIC_VOICES };

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MOSS_SPACE_BASE = "https://openmoss-team-moss-tts-nano.hf.space";

export interface VoiceOption {
  id: string;
  label: string;
}

export const POCKET_VOICES: VoiceOption[] = [
  { id: "__custom__", label: "★ Mi voz clonada (Custom)" },
  { id: "lola", label: "Lola (Kyutai ES)" },
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
let pocketPromise: Promise<{ tts: PocketInstance }> | null = null;
let pocketHasCloning = false;
let activePocketTts: PocketInstance | null = null;
let generatingPocket: PocketInstance | null = null;
let cachedPocketCustomVoiceRef: string | null = null;
const cachedPocketBuiltInVoices = new Map<string, string>();
let activeCtx: AudioContext | null = null;
const sources = new Set<AudioBufferSourceNode>();
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

function splitIntoSentences(text: string, limit = 180): string[] {
  const segments: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + word.length + 1 > limit) {
      segments.push(current);
      current = "";
    }
    current = current ? `${current} ${word}` : word;
    if ((limit <= 180 && /[.!?\u2026]["\u00bb\u201d)]?$/.test(word)) || (!segments.length && current.length >= 55 && /[,;:]$/.test(word))) {
      segments.push(current);
      current = "";
    }
  }
  if (current) segments.push(current);
  return segments;
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

    const initializing = piper.TtsSession.create({
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
    });
    const session = await withTimeout(initializing, 120_000, "Piper init");
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

// Gradio keeps the selected demo reference in session state. Its preview URL
// is an output file, which should not be submitted as a new upload.
let mossSession: string | null = null;
let mossRetryAfter = 0;

async function readMossResult(response: Response): Promise<unknown[]> {
  if (!response.ok || !response.body) throw new Error(`MOSS HTTP ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += value ?? "";
      const frames = pending.split(/\r?\n\r?\n/);
      pending = done ? "" : frames.pop() ?? "";
      for (const frame of frames) {
        const event = frame.match(/^event:\s*(\w+)/m)?.[1];
        if (event === "error") throw new Error("Error de inferencia en el servicio MOSS");
        if (event === "complete") {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trim()).join("\n");
          const result: unknown = JSON.parse(data);
          if (Array.isArray(result)) return result;
        }
      }
      if (done) throw new Error("MOSS finalizó sin devolver audio");
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function synthesizeMossAudioUrl(
  text: string,
  parentSignal: AbortSignal | undefined,
  onStatus?: (s: string | null) => void,
): Promise<string> {
  onStatus?.("Sintetizando con MOSS-TTS-Nano…");

  if (!mossSession) {
    const session = crypto.randomUUID();
    const timed = makeTimedSignal(parentSignal, 15_000);
    try {
      const endpoint = `${MOSS_SPACE_BASE}/gradio_api/call/apply_demo_case_selection`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: ["demo-1", null], session_hash: session }),
        signal: timed.signal,
      });
      if (!response.ok) throw new Error(`MOSS HTTP ${response.status}`);
      const { event_id } = await response.json();
      if (!event_id) throw new Error("MOSS no pudo preparar la voz");
      const preview = await fetch(`${endpoint}/${event_id}`, { signal: timed.signal });
      await readMossResult(preview);
      mossSession = session;
    } finally {
      timed.cleanup();
    }
  }

  const dataPayload = [
    text,
    null,
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
      body: JSON.stringify({ data: dataPayload, session_hash: mossSession }),
      signal: timedCall.signal,
    });
    if (!callRes.ok) throw new Error(`MOSS HTTP ${callRes.status}`);
    const payload = (await callRes.json()) as { event_id?: string };
    eventId = payload.event_id ?? "";
  } finally {
    timedCall.cleanup();
  }
  if (!eventId) throw new Error("MOSS no devolvió event_id");

  const timedSse = makeTimedSignal(parentSignal, 60_000);
  let parsed: unknown[];
  try {
    const response = await fetch(`${MOSS_SPACE_BASE}/gradio_api/call/run_inference/${eventId}`, {
      signal: timedSse.signal,
    });
    parsed = await readMossResult(response);
  } catch (err) {
    mossSession = null;
    throw err;
  } finally {
    timedSse.cleanup();
  }
  const first = parsed?.[0] as { url?: string; path?: string } | string | undefined;
  const url =
    typeof first === "string"
      ? first
      : first?.url || (first?.path ? `${MOSS_SPACE_BASE}/gradio_api/file=${first.path}` : "");
  onStatus?.(null);
  if (!url) throw new Error("MOSS no devolvió URL de audio");
  return url;
}

let spokenWords = "";
let echoUntil = 0;

function normalizeWords(text: string): string {
  return text.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function isPlaybackEcho(text: string): boolean {
  const words = normalizeWords(text);
  return Boolean(performance.now() <= echoUntil && words && spokenWords.includes(` ${words} `));
}

export function stopSpeaking(): void {
  activeReply = null;
  cancelPlayback();
}

function cancelPlayback(): void {
  spokenWords = "";
  speakSeq += 1;
  try {
    activeAbort?.abort();
  } catch {
    // ignore
  }
  activeAbort = null;
  if (generatingPocket) void generatingPocket.stop().catch(() => {});
  for (const source of sources) source.stop();
  sources.clear();
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function pcmContext() {
  if (!activeCtx || activeCtx.state === "closed") activeCtx = new AudioContext();
  return activeCtx;
}

function schedulePcm(samples: Float32Array, rate: number, when = 0): Promise<void> {
  const ctx = pcmContext();
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.getChannelData(0).set(samples);
  return playBuffer(ctx, buf, when, 1);
}

function playBuffer(ctx: AudioContext, buf: AudioBuffer, when: number, speed: number): Promise<void> {
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.playbackRate.value = speed;
  source.connect(ctx.destination);
  sources.add(source);
  return new Promise((resolve) => {
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
      resolve();
    };
    source.start(when);
  });
}

async function prepareAudio(bytes: ArrayBuffer, signal: AbortSignal, speed: number) {
  signal.throwIfAborted();
  const ctx = pcmContext();
  await ctx.resume();
  const buffer = await ctx.decodeAudioData(bytes);
  return () => {
    signal.throwIfAborted();
    return playBuffer(ctx, buffer, 0, speed);
  };
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
    const signal = activeAbort?.signal;
    const finish = () => {
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    u.onend = u.onerror = finish;
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

type SpeechOptions = {
  text: string;
  mode: TtsEngineMode;
  pocketWebLanguage?: PocketWebLanguage;
  voice: string;
  speed?: number;
  onStatus?: (status: string | null) => void;
};

// Each model may finish an in-flight ONNX call after cancellation. Serialize
// access to that model while allowing a different model to start immediately.
const modelJobs = new Map<TtsEngineMode, Promise<void>>();

type ActiveReply = { options: SpeechOptions; remaining: string };
let activeReply: ActiveReply | null = null;

export function updateSpeakingVoice(ai: AiAssistantConfig): void {
  const reply = activeReply;
  if (!reply) return;
  const old = reply.options;
  if (old.mode === ai.ttsMode && old.voice === ai.ttsVoice &&
      old.speed === ai.ttsSpeed && old.pocketWebLanguage === ai.pocketWebLanguage) return;
  if (ai.ttsMode === "off") { stopSpeaking(); return; }
  reply.options = {
    ...old, mode: ai.ttsMode, voice: ai.ttsVoice,
    speed: ai.ttsSpeed, pocketWebLanguage: ai.pocketWebLanguage,
  };
  cancelPlayback();
}

export async function speakReply(opts: SpeechOptions): Promise<void> {
  stopSpeaking();
  const text = stripMarkdownForSpeech(opts.text);
  if (!text || opts.mode === "off") return;
  const reply: ActiveReply = { options: opts, remaining: text };
  activeReply = reply;
  try {
    while (activeReply === reply && reply.remaining) {
      const options = reply.options;
      // These engines take a whole passage without word timing. Bound their
      // restart point while preserving the native players' sentence lookahead.
      const passage = options.mode === "system" || options.mode === "pocket"
        ? splitIntoSentences(reply.remaining, 320)[0] : reply.remaining;
      const afterPassage = reply.remaining.slice(passage.length).trimStart();
      const commit = (part: string) => {
        if (activeReply !== reply || reply.options !== options) return;
        reply.remaining = reply.remaining.slice(part.length).trimStart();
      };
      await playReply(options, passage, commit);
      if (activeReply === reply && reply.options === options) reply.remaining = afterPassage;
    }
  } finally {
    if (activeReply === reply) activeReply = null;
  }
}

async function playReply(opts: SpeechOptions, text: string, commit: (part: string) => void): Promise<void> {
  spokenWords = ` ${normalizeWords(text)} `;
  echoUntil = Infinity;
  const seq = speakSeq;
  const controller = new AbortController();
  activeAbort = controller;
  const { signal } = controller;
  const speed = Math.max(0.75, Math.min(1.4, opts.speed ?? 1.05));
  const status = (message: string | null) => {
    if (seq === speakSeq) opts.onStatus?.(message);
  };
  const sentences = splitIntoSentences(text, opts.mode === "moss" ? 450 : 180);
  let spokenLength = 0;
  const played = (part: string) => {
    if (signal.aborted) return;
    spokenLength += part.length + 1;
    commit(part);
  };
  async function run() {
    signal.throwIfAborted();
    if (opts.mode === "system") return speakSystem(text, opts.voice, speed);

    if (opts.mode === "pocket" || opts.mode === "pocket-web") {
      const web = opts.mode === "pocket-web";
      const needsCloning = opts.voice === "__custom__";
      if (web || (!needsCloning && await hasKyutaiServer(signal))) {
        const ctx = pcmContext();
        await ctx.resume();
        const voices = web ? pocketWebVoices : POCKET_VOICES;
        const selected = voices.find(v => v.id === opts.voice)?.id ?? "lola";
        let end = 0;
        let drained = Promise.resolve();
        const scheduled: { until: number; done: Promise<void> }[] = [];
        try {
          const sections = web ? sentences : [text];
          for (const section of sections) {
            signal.throwIfAborted();
            for await (const { pcm, rate } of streamKyutai(section, selected, signal, web ? pocketLanguage(opts.pocketWebLanguage, selected) : undefined)) {
              signal.throwIfAborted();
              if (end <= ctx.currentTime) end = ctx.currentTime + 0.18;
              drained = schedulePcm(pcm, rate * speed, end);
              end += pcm.length / (rate * speed);
              scheduled.push({ until: end, done: drained });
              while (scheduled.length && scheduled[0].until <= ctx.currentTime) scheduled.shift();
              if (end - ctx.currentTime > 5) await scheduled.find(chunk => chunk.until >= end - 3)?.done;
            }
            // Commit only when this passage actually finishes playing.
            drained = drained.then(() => played(section));
          }
          await drained;
          return;
        } catch (err) {
          signal.throwIfAborted();
          if (end) {
            await drained;
            throw err;
          }
          if (web) throw err;
          status("Preparando Pocket en el navegador…");
        }
      }
      signal.throwIfAborted();
      const { tts } = await loadPocket(needsCloning, status);
      signal.throwIfAborted();
      let voiceRef: string;
      if (needsCloning) {
        if (cachedPocketCustomVoiceRef) {
          voiceRef = cachedPocketCustomVoiceRef;
        } else {
          const saved = await getCustomVoicePcm();
          if (saved) {
            status(`Clonando voz (${saved.name})…`);
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
        const chosen = POCKET_VOICES.some((v) => v.id === opts.voice && v.id !== "__custom__" && v.id !== "lola")
          ? opts.voice
          : "alba";
        voiceRef =
          cachedPocketBuiltInVoices.get(chosen) ?? (await tts.loadVoice(chosen));
        cachedPocketBuiltInVoices.set(chosen, voiceRef);
      }

      signal.throwIfAborted();

      const ctx = pcmContext();
      await ctx.resume();
      let end = ctx.currentTime;
      let drained = Promise.resolve();
      generatingPocket = tts;
      try {
        // The worker already groups text by token budget and punctuation.
        // Keep its audio continuous and rebuild a larger cushion after underruns.
        const chunks: Float32Array[] = [];
        let count = 0;
        let cushion = 0.75;
        let started = false;
        const flush = () => {
          if (!count || signal.aborted) return;
          const pcm = concatFloat32(chunks);
          chunks.length = 0;
          count = 0;
          end = Math.max(ctx.currentTime + 0.04, end);
          drained = schedulePcm(pcm, tts.sampleRate * speed, end);
          end += pcm.length / (tts.sampleRate * speed);
          started = true;
        };
        await tts.generate(text, {
          voice: voiceRef,
          onChunk(audio) {
            if (signal.aborted || !audio.length) return;
            if (started && end <= ctx.currentTime) {
              started = false;
              cushion = Math.min(2, cushion * 1.5);
            }
            chunks.push(new Float32Array(audio));
            count += audio.length;
            if (count >= tts.sampleRate * speed * (started ? 0.12 : cushion)) flush();
          },
        });
        flush();
        await drained;
      } catch (err) {
        await drained;
        throw err;
      } finally {
        generatingPocket = null;
      }
      return;
    }

    async function prepare(sentence: string): Promise<() => Promise<void>> {
      signal.throwIfAborted();
      if (opts.mode === "moss") {
        if (Date.now() < mossRetryAfter) throw new Error("Servicio MOSS ocupado");
        let url: string;
        try {
          url = await synthesizeMossAudioUrl(sentence, signal, status);
        } catch (err) {
          if (!signal.aborted) mossRetryAfter = Date.now() + 20_000;
          throw err;
        }
        const response = await fetch(url, { signal, cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`MOSS audio HTTP ${response.status}`);
        return prepareAudio(await response.arrayBuffer(), signal, speed);
      }
      if (opts.mode === "piper") {
        const session = await loadPiper(opts.voice, status);
        signal.throwIfAborted();
        const blob = await withTimeout(session.predict(sentence), 30_000, "Piper voz");
        return prepareAudio(await blob.arrayBuffer(), signal, speed);
      }
      await pcmContext().resume();
      if (opts.mode === "supertonic") {
        const result = await synthesizeSupertonicSentence({
          text: sentence, voice: opts.voice, speed, steps: 3, onStatus: status, signal,
        });
        return () => schedulePcm(result.audio, result.sampleRate);
      }
      const tts = await loadKokoro(status);
      signal.throwIfAborted();
      const voice = KOKORO_VOICES.find((v) => v.id === opts.voice) ?? KOKORO_VOICES[0];
      const result = await tts.generate(sentence, { voice: voice.id, speed });
      return () => schedulePcm(result.audio, result.sampling_rate);
    }

    let play = await prepare(sentences[0]);
    for (let i = 0; i < sentences.length; i++) {
      signal.throwIfAborted();
      const playback = play().then(() => played(sentences[i]));
      const [audio, next] = await Promise.allSettled([
        playback, i + 1 < sentences.length ? prepare(sentences[i + 1]) : undefined,
      ] as const);
      if (audio.status === "rejected") throw audio.reason;
      if (next.status === "rejected") throw next.reason;
      if (next.value) play = next.value;
    }
  }

  const previous = opts.mode === "pocket-web" || opts.mode === "system" ? undefined : modelJobs.get(opts.mode);
  const job = (previous ?? Promise.resolve()).then(run).catch(async (err) => {
    if (signal.aborted) return;
    status(`${opts.mode}: usando voz del sistema (${String(err).slice(0, 65)})`);
    const remaining = text.slice(spokenLength);
    if (remaining) await speakSystem(remaining, undefined, speed);
  });
  modelJobs.set(opts.mode, job);
  const finished = job.finally(() => {
    if (modelJobs.get(opts.mode) === job) modelJobs.delete(opts.mode);
    status(null);
  });
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  signal.addEventListener("abort", cancel, { once: true });
  try { await Promise.race([finished, cancelled]); }
  finally {
    signal.removeEventListener("abort", cancel);
    if (seq === speakSeq) echoUntil = performance.now() + 450;
  }
}
