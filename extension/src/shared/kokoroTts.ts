/**
 * Motor de voz natural local 100% gratuito con Kokoro-82M (`kokoro-js`)
 * + respaldo instantáneo con Web Speech Synthesis (`speechSynthesis`).
 *
 * Usa los binarios ONNX/WASM locales de la extensión (`chrome-extension://<id>/ort/`)
 * para cumplir con Chrome MV3 CSP sin descargas de scripts remotos.
 */

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export interface KokoroVoiceOption {
  id: string;
  label: string;
}

export const KOKORO_VOICES: KokoroVoiceOption[] = [
  { id: "ef_dora", label: "Dora (ES)" },
  { id: "em_alex", label: "Alex (ES)" },
  { id: "af_heart", label: "Heart (EN)" },
  { id: "am_michael", label: "Michael (EN)" },
];

type KokoroInstance = {
  generate(
    text: string,
    opts?: { voice?: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

let kokoroPromise: Promise<KokoroInstance> | null = null;
let activeCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let speakSeq = 0;

function stripMarkdownForSpeech(raw: string): string {
  return raw
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
    onStatus?.("Cargando voz natural Kokoro-82M (1 sola vez)…");
    const [{ env }, { KokoroTTS }] = await Promise.all([
      import("@huggingface/transformers"),
      import("kokoro-js"),
    ]);

    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const wasmCfg = env.backends?.onnx?.wasm;
    if (wasmCfg) {
      wasmCfg.wasmPaths = chrome.runtime.getURL("ort/");
      wasmCfg.numThreads = 1;
      wasmCfg.proxy = false;
    }

    const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    try {
      const inst = (await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: hasWebGpu ? "fp32" : "q8",
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

export function stopSpeaking(): void {
  speakSeq += 1;
  try {
    activeSource?.stop();
  } catch {
    // ignore
  }
  activeSource = null;
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

function speakSystem(text: string, langHint = "es-ES"): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langHint;
    u.rate = 1.04;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export async function speakReply(opts: {
  text: string;
  mode: "kokoro" | "system" | "off";
  voice: string;
  onStatus?: (status: string | null) => void;
}): Promise<void> {
  if (opts.mode === "off") return;
  const clean = stripMarkdownForSpeech(opts.text);
  if (!clean) return;

  stopSpeaking();
  const seq = speakSeq;

  if (opts.mode === "system") {
    const lang = opts.voice.startsWith("e") ? "es-ES" : "en-US";
    await speakSystem(clean, lang);
    return;
  }

  try {
    const tts = await loadKokoro(opts.onStatus);
    if (seq !== speakSeq) return;
    const sentences = splitIntoSentences(clean);
    for (const sentence of sentences) {
      if (seq !== speakSeq) break;
      const result = await tts.generate(sentence, {
        voice: opts.voice || "ef_dora",
        speed: 1.02,
      });
      if (seq !== speakSeq) break;
      await playPcm(result.audio, result.sampling_rate, seq);
    }
  } catch {
    opts.onStatus?.(null);
    if (seq === speakSeq) {
      const lang = opts.voice.startsWith("e") ? "es-ES" : "en-US";
      await speakSystem(clean, lang);
    }
  }
}
