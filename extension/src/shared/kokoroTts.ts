/**
 * Motor de voz natural local 100% gratuito con Kokoro-82M (`kokoro-js`)
 * + respaldo con voces instaladas del sistema (`speechSynthesis`).
 *
 * Configura `wasmPaths` directamente en el `env` propio de `kokoro-js` para usar
 * los binarios locales de `chrome-extension://<id>/ort/` y usar voces verificadas
 * de Kokoro-82M (así cada cambio de voz se escucha de verdad).
 */

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export interface VoiceOption {
  id: string;
  label: string;
}

/** Voces verificadas en kokoro-js v1.x (cambian realmente el timbre y género). */
export const KOKORO_VOICES: VoiceOption[] = [
  { id: "af_heart", label: "Heart (Mujer)" },
  { id: "af_bella", label: "Bella (Mujer)" },
  { id: "af_nova", label: "Nova (Mujer)" },
  { id: "am_michael", label: "Michael (Hombre)" },
  { id: "am_fenrir", label: "Fenrir (Grave)" },
  { id: "bf_emma", label: "Emma (UK)" },
  { id: "bm_george", label: "George (UK)" },
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
    onStatus?.("Cargando Kokoro-82M local (1 sola vez)…");
    const kokoroMod = await import("kokoro-js");
    const { KokoroTTS, env: kokoroEnv } = kokoroMod;

    // Crucial: configure kokoro-js's OWN env so ONNX loads from local extension bundle
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
    await speakSystem(clean, opts.voice);
    return;
  }

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
    opts.onStatus?.(`Kokoro respaldo voz sistema (${msg.slice(0, 60)})`);
    window.setTimeout(() => opts.onStatus?.(null), 2600);
    if (seq === speakSeq) {
      await speakSystem(clean);
    }
  }
}
