/**
 * Motor de dictado 100% local con Whisper open-source (@huggingface/transformers).
 *
 * Corre en el navegador usando WebGPU (si está disponible) o WASM/ONNX sin enviar
 * audio a servidores externos. Descarga el modelo una única vez y queda en caché.
 *
 * Usa captura a 16 kHz + VAD (detección de actividad de voz) por energía para:
 *  - Enviar nivel RMS en vivo (`onLevel`) al control flotante Bauhaus.
 *  - Transcribir automáticamente cada frase tras una micro-pausa (~750 ms).
 */

import { cleanDictatedChunk } from "./polish";
import type { SpeechEngineHandle, SpeechEngineOptions } from "./speechEngine";
import type { SpeechEngineType } from "./types";

const MODEL_IDS: Record<Exclude<SpeechEngineType, "chrome">, string> = {
  whisper_tiny: "Xenova/whisper-tiny",
  whisper_base: "Xenova/whisper-base",
};

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | Array<{ text?: string }>>;

const pipelineCache = new Map<string, Promise<AsrPipeline>>();

function mapWhisperLang(lang?: string): string | undefined {
  if (!lang || lang === "auto") return undefined;
  const base = lang.toLowerCase().split("-")[0];
  const map: Record<string, string> = {
    es: "spanish",
    en: "english",
    pt: "portuguese",
    fr: "french",
  };
  return map[base] ?? undefined;
}

async function loadWhisperPipeline(
  modelKey: Exclude<SpeechEngineType, "chrome">,
  onProgress?: (msg: string) => void,
): Promise<AsrPipeline> {
  const modelId = MODEL_IDS[modelKey];
  const cached = pipelineCache.get(modelId);
  if (cached) return cached;

  const loader = (async () => {
    onProgress?.(`Cargando ${modelKey === "whisper_tiny" ? "Whisper S" : "Whisper M"} local…`);
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    const device = hasWebGpu ? "webgpu" : "wasm";

    const createPipe = async (dev: "webgpu" | "wasm") =>
      (await pipeline("automatic-speech-recognition", modelId, {
        device: dev,
        dtype: "q8",
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (info.status === "progress" && typeof info.progress === "number") {
            onProgress?.(`Descargando modelo local: ${Math.round(info.progress)}%`);
          }
        },
      })) as unknown as AsrPipeline;

    try {
      return await createPipe(device);
    } catch {
      if (device === "webgpu") {
        return await createPipe("wasm");
      }
      throw new Error("No se pudo inicializar el motor Whisper local.");
    }
  })();

  pipelineCache.set(modelId, loader);
  try {
    return await loader;
  } catch (err) {
    pipelineCache.delete(modelId);
    throw err;
  }
}

export interface WhisperEngineOptions extends SpeechEngineOptions {
  model: Exclude<SpeechEngineType, "chrome">;
  onStatus?: (status: string) => void;
}

export function createWhisperEngine(opts: WhisperEngineOptions): SpeechEngineHandle {
  let lang = opts.language ?? "es-419";
  let polish = opts.polish ?? true;
  let autoCapitalize = opts.autoCapitalize ?? true;

  let active = false;
  let isNewSentence = true;
  let utteranceSeq = 0;

  let micStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let asr: AsrPipeline | null = null;

  // VAD & 16kHz buffer state
  const TARGET_SR = 16000;
  let chunks: Float32Array[] = [];
  let totalSamples = 0;
  let speechDetected = false;
  let silenceMs = 0;
  let transcribing = false;
  let pendingQueue: Float32Array[] = [];

  function downsampleTo16k(input: Float32Array, inputSr: number): Float32Array {
    if (inputSr === TARGET_SR) return new Float32Array(input);
    const ratio = inputSr / TARGET_SR;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j += 1) {
        sum += input[j];
        count += 1;
      }
      out[i] = count > 0 ? sum / count : 0;
    }
    return out;
  }

  function concatBuffers(list: Float32Array[], total: number): Float32Array {
    const out = new Float32Array(total);
    let offset = 0;
    for (const arr of list) {
      out.set(arr, offset);
      offset += arr.length;
    }
    return out;
  }

  async function processQueue() {
    if (transcribing || !asr || pendingQueue.length === 0) return;
    transcribing = true;
    try {
      while (pendingQueue.length > 0 && active) {
        const audio = pendingQueue.shift()!;
        const whisperLang = mapWhisperLang(lang);
        const result = await asr(audio, {
          task: "transcribe",
          ...(whisperLang ? { language: whisperLang } : {}),
          chunk_length_s: 30,
          stride_length_s: 5,
        });

        const raw = Array.isArray(result) ? result[0]?.text ?? "" : result?.text ?? "";
        // Filter Whisper hallucination tags like [Música], (risas), etc.
        const stripped = raw
          .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (!stripped) {
          opts.onInterim?.("");
          continue;
        }

        const cleaned = cleanDictatedChunk(stripped, {
          polish,
          autoCapitalize,
          isNewSentence,
        });

        opts.onInterim?.("");
        if (cleaned) {
          utteranceSeq += 1;
          isNewSentence = /[.!?…]\s*$/.test(cleaned);
          opts.onLive?.({
            utteranceId: `whisper-${utteranceSeq}`,
            text: cleaned,
            isFinal: true,
          });
          opts.onFinal?.(cleaned);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onError?.(`Whisper local: ${msg}`, false);
    } finally {
      transcribing = false;
      if (!active) opts.onInterim?.("");
    }
  }

  function flushSegment() {
    if (totalSamples < TARGET_SR * 0.35) {
      chunks = [];
      totalSamples = 0;
      speechDetected = false;
      silenceMs = 0;
      opts.onInterim?.("");
      return;
    }
    const audio = concatBuffers(chunks, totalSamples);
    chunks = [];
    totalSamples = 0;
    speechDetected = false;
    silenceMs = 0;
    pendingQueue.push(audio);
    void processQueue();
  }

  function cleanupAudio() {
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      void audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    opts.onLevel?.(0);
  }

  return {
    async start() {
      if (active) return;
      active = true;
      isNewSentence = true;
      chunks = [];
      totalSamples = 0;
      speechDetected = false;
      silenceMs = 0;
      pendingQueue = [];

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        active = false;
        const name = err instanceof Error ? err.name : "";
        const msg = err instanceof Error ? err.message : String(err);
        if (name === "NotAllowedError" || name === "PermissionDeniedError" || /denied|permission/i.test(msg)) {
          throw new Error("MIC_PERMISSION_REQUIRED: Permiso de micrófono necesario para dictar.");
        }
        throw new Error(`No se pudo abrir el micrófono: ${msg}`);
      }

      try {
        asr = await loadWhisperPipeline(opts.model, (status) => {
          opts.onStatus?.(status);
        });
      } catch (err) {
        active = false;
        cleanupAudio();
        throw err;
      }

      if (!active) {
        cleanupAudio();
        return;
      }

      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(micStream);
      const inputSr = audioCtx.sampleRate;
      processor = audioCtx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (ev) => {
        if (!active) return;
        const input = ev.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);
        opts.onLevel?.(rms);

        const frameMs = (input.length / inputSr) * 1000;
        const VOICE_THRESHOLD = 0.017;

        if (rms >= VOICE_THRESHOLD) {
          if (!speechDetected) {
            speechDetected = true;
            opts.onInterim?.("…");
          }
          silenceMs = 0;
          const down = downsampleTo16k(input, inputSr);
          chunks.push(down);
          totalSamples += down.length;

          // Cap max utterance length at 14s for low latency
          if (totalSamples >= TARGET_SR * 14) {
            flushSegment();
          }
        } else if (speechDetected) {
          silenceMs += frameMs;
          const down = downsampleTo16k(input, inputSr);
          chunks.push(down);
          totalSamples += down.length;

          if (silenceMs >= 750) {
            flushSegment();
          }
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      opts.onReady?.();
    },

    stop() {
      if (!active) return;
      if (speechDetected && totalSamples >= TARGET_SR * 0.35) {
        flushSegment();
      }
      active = false;
      cleanupAudio();
      opts.onInterim?.("");
      opts.onStop?.();
    },

    updateOptions(patch) {
      if (patch.language !== undefined) lang = patch.language;
      if (patch.polish !== undefined) polish = patch.polish;
      if (patch.autoCapitalize !== undefined) autoCapitalize = patch.autoCapitalize;
    },

    isRunning() {
      return active;
    },
  };
}
