/**
 * Motor unificado de voz natural (TTS) para RECO:
 *  - `kokoro`: Kokoro-82M local (WebGPU/WASM, voces verificadas de kokoro-js)
 *  - `piper`:  Piper TTS local (WASM/ONNX, voces neuronales en ESPAÑOL y caché OPFS)
 *  - `moss`:   MOSS-TTS-Nano (Hugging Face Space OpenMOSS-Team/MOSS-TTS-Nano)
 *  - `system`: Voces instaladas del sistema operativo (instantáneo)
 *  - `off`:    Solo texto
 */

import type { TtsEngineMode } from "./types";

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MOSS_SPACE_BASE = "https://openmoss-team-moss-tts-nano.hf.space";

export interface VoiceOption {
  id: string;
  label: string;
}

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
let activeCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let activeAudioEl: HTMLAudioElement | null = null;
let speakSeq = 0;

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
    const defaults = piper.TtsSession.WASM_LOCATIONS;
    const session = await piper.TtsSession.create({
      voiceId: validVoice,
      wasmPaths: {
        onnxWasm: chrome.runtime.getURL("ort/"),
        piperData: defaults.piperData,
        piperWasm: defaults.piperWasm,
      },
      progress: (p) => {
        if (p.total > 0) {
          const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
          onStatus?.(`Descargando voz Piper · ${pct}%`);
        }
      },
    });
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

async function synthesizeMossAudioUrl(
  text: string,
  onStatus?: (s: string | null) => void,
): Promise<string> {
  onStatus?.("Sintetizando con MOSS-TTS-Nano…");
  // Discover endpoint from Gradio Space API
  const infoRes = await fetch(`${MOSS_SPACE_BASE}/gradio_api/info`);
  if (!infoRes.ok) throw new Error(`MOSS Space HTTP ${infoRes.status}`);
  const info = (await infoRes.json()) as {
    named_endpoints?: Record<string, { parameters?: Array<{ parameter_name?: string }> }>;
  };

  const endpoints = Object.keys(info.named_endpoints ?? {});
  const ep =
    endpoints.find((k) => /generate|tts|synthesize|predict/i.test(k)) ??
    endpoints[0] ??
    "/predict";
  const epClean = ep.startsWith("/") ? ep.slice(1) : ep;
  const params = info.named_endpoints?.[ep]?.parameters ?? [];
  const dataPayload = params.length <= 1 ? [text] : [text, ...params.slice(1).map(() => null)];

  const callRes = await fetch(`${MOSS_SPACE_BASE}/gradio_api/call/${epClean}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: dataPayload }),
  });
  if (!callRes.ok) throw new Error(`MOSS call HTTP ${callRes.status}`);
  const { event_id } = (await callRes.json()) as { event_id?: string };
  if (!event_id) throw new Error("MOSS no devolvió event_id");

  const sseRes = await fetch(`${MOSS_SPACE_BASE}/gradio_api/call/${epClean}/${event_id}`);
  if (!sseRes.ok) throw new Error(`MOSS stream HTTP ${sseRes.status}`);
  const bodyText = await sseRes.text();
  const dataLine = bodyText
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("data:"));
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

function speakSystem(text: string, voiceUri?: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
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
    u.rate = 1.04;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export async function speakReply(opts: {
  text: string;
  mode: TtsEngineMode;
  voice: string;
  onStatus?: (status: string | null) => void;
}): Promise<void> {
  if (opts.mode === "off") return;
  const clean = stripMarkdownForSpeech(opts.text);
  if (!clean) return;

  stopSpeaking();
  const seq = speakSeq;

  if (opts.mode === "system") {
    await speakSystem(clean, opts.voice);
    return;
  }

  if (opts.mode === "piper") {
    try {
      const session = await loadPiper(opts.voice, opts.onStatus);
      if (seq !== speakSeq) return;
      const sentences = splitIntoSentences(clean);
      for (const sentence of sentences) {
        if (seq !== speakSeq) break;
        const blob = await session.predict(sentence);
        if (seq !== speakSeq) break;
        await playAudioUrl(URL.createObjectURL(blob), true, seq);
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.(`Piper respaldo voz sistema (${msg.slice(0, 50)})`);
      window.setTimeout(() => opts.onStatus?.(null), 2400);
      if (seq === speakSeq) await speakSystem(clean);
      return;
    }
  }

  if (opts.mode === "moss") {
    try {
      const url = await synthesizeMossAudioUrl(clean.slice(0, 450), opts.onStatus);
      if (seq !== speakSeq) return;
      await playAudioUrl(url, false, seq);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.(`MOSS ocupado, usando respaldo (${msg.slice(0, 45)})`);
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
        speed: 1.02,
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
