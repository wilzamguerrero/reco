/**
 * Motor de dictado 100% local con modelos open-source (@huggingface/transformers):
 *  - Whisper S (`Xenova/whisper-tiny`): multilingüe (ES/EN/PT/FR), rápido, ~40 MB.
 *  - Whisper M (`Xenova/whisper-base`): multilingüe (ES/EN/PT/FR), más preciso, ~75 MB.
 *  - Moonshine (`onnx-community/moonshine-tiny-ONNX`): ultra rápido en edge/navegador (~27 MB, EN).
 *
 * Carga los binarios ONNX/WASM localmente desde `chrome-extension://<id>/ort/` para
 * cumplir 100% con el CSP de Chrome Manifest V3 (cero scripts remotos en CDN).
 * Incluye pre-roll de 250 ms para no cortar nunca la primera sílaba y VAD rápido (620 ms).
 */

import { cleanDictatedChunk } from "./polish";
import type { SpeechEngineHandle, SpeechEngineOptions } from "./speechEngine";
import { getCachedModels, markModelCached } from "./storage";
import type { SpeechEngineType } from "./types";

export type LocalAsrModel = Exclude<SpeechEngineType, "chrome">;

interface ModelSpec {
  id: string;
  label: string;
}

const MODELS: Record<LocalAsrModel, ModelSpec> = {
  whisper_tiny: { id: "onnx-community/whisper-tiny", label: "Whisper S" },
  whisper_base: { id: "onnx-community/whisper-base", label: "Whisper M" },
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

async function loadLocalPipeline(
  modelKey: LocalAsrModel,
  onProgress?: (msg: string) => void,
): Promise<AsrPipeline> {
  const spec = MODELS[modelKey];
  const cached = pipelineCache.get(spec.id);
  if (cached) return cached;

  const loader = (async () => {
    const cachedMap = await getCachedModels().catch(() => ({} as Record<string, boolean>));
    const alreadyCached = Boolean(cachedMap[modelKey]);

    onProgress?.(
      alreadyCached
        ? `Cargando ${spec.label} desde caché…`
        : `Preparando descarga de ${spec.label}…`,
    );
    const { pipeline, env } = await import("@huggingface/transformers");

    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Crucial for Chrome MV3: load ONNX Runtime Web WASM/MJS from local extension bundle
    const wasmCfg = env.backends?.onnx?.wasm;
    if (wasmCfg) {
      wasmCfg.wasmPaths = chrome.runtime.getURL("ort/");
      wasmCfg.numThreads = 1;
      wasmCfg.proxy = false;
    }

    const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    let lastPct = -1;
    const progressCb = (info: { status?: string; progress?: number; file?: string }) => {
      if (alreadyCached) {
        if (info.status === "ready") {
          onProgress?.(`Iniciando ${spec.label} en ${hasWebGpu ? "GPU" : "CPU"}…`);
        }
        return;
      }
      if (info.status === "progress" && typeof info.progress === "number") {
        const pct = Math.round(info.progress);
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.(`Descargando ${spec.label} (1 sola vez) · ${pct}%`);
        }
      } else if (info.status === "ready") {
        onProgress?.(`Iniciando ${spec.label} en ${hasWebGpu ? "GPU" : "CPU"}…`);
      }
    };

    const tryCreate = async (
      device: "webgpu" | "wasm",
      dtype?: "q8" | "fp32" | Record<string, string>,
    ) => {
      const pipeOpts: Record<string, unknown> = {
        device,
        progress_callback: progressCb,
      };
      if (dtype) pipeOpts.dtype = dtype;
      return (await pipeline(
        "automatic-speech-recognition",
        spec.id,
        pipeOpts,
      )) as unknown as AsrPipeline;
    };

    let pipe: AsrPipeline | null = null;
    if (hasWebGpu) {
      try {
        pipe = await tryCreate("webgpu", {
          encoder_model: "fp32",
          decoder_model_merged: "q4",
        });
      } catch {
        try {
          pipe = await tryCreate("webgpu", "q8");
        } catch {
          // Fallback smoothly to local WASM
        }
      }
    }
    if (!pipe) {
      try {
        pipe = await tryCreate("wasm", "q8");
      } catch {
        pipe = await tryCreate("wasm");
      }
    }

    await markModelCached(modelKey).catch(() => {});
    return pipe;
  })();

  pipelineCache.set(spec.id, loader);
  try {
    return await loader;
  } catch (err) {
    pipelineCache.delete(spec.id);
    throw err;
  }
}

export interface WhisperEngineOptions extends SpeechEngineOptions {
  model: LocalAsrModel;
  onStatus?: (status: string) => void;
}

export function createWhisperEngine(opts: WhisperEngineOptions): SpeechEngineHandle {
  const spec = MODELS[opts.model];
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

  // 16kHz VAD with 250ms pre-roll ring buffer so first syllables are never clipped
  const TARGET_SR = 16000;
  const PRE_ROLL_CHUNKS = 3;
  let preRoll: Float32Array[] = [];
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
        const inferOpts = {
          task: "transcribe",
          ...(mapWhisperLang(lang) ? { language: mapWhisperLang(lang) } : {}),
          return_timestamps: false,
        };

        const result = await asr(audio, inferOpts);
        const raw = Array.isArray(result) ? result[0]?.text ?? "" : result?.text ?? "";
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
            utteranceId: `local-${utteranceSeq}`,
            text: cleaned,
            isFinal: true,
          });
          opts.onFinal?.(cleaned);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onError?.(`${spec.label}: ${msg}`, false);
    } finally {
      transcribing = false;
      if (!active) opts.onInterim?.("");
    }
  }

  function flushSegment() {
    if (totalSamples < TARGET_SR * 0.3) {
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
      preRoll = [];
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
        asr = await loadLocalPipeline(opts.model, (status) => {
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

        const down = downsampleTo16k(input, inputSr);
        const frameMs = (input.length / inputSr) * 1000;
        const VOICE_THRESHOLD = 0.015;

        if (rms >= VOICE_THRESHOLD) {
          if (!speechDetected) {
            speechDetected = true;
            opts.onInterim?.("…");
            // Prepend pre-roll so the opening syllable is preserved
            for (const pre of preRoll) {
              chunks.push(pre);
              totalSamples += pre.length;
            }
            preRoll = [];
          }
          silenceMs = 0;
          chunks.push(down);
          totalSamples += down.length;

          if (totalSamples >= TARGET_SR * 12) {
            flushSegment();
          }
        } else if (speechDetected) {
          silenceMs += frameMs;
          chunks.push(down);
          totalSamples += down.length;

          if (silenceMs >= 620) {
            flushSegment();
          }
        } else {
          preRoll.push(down);
          if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      opts.onReady?.();
    },

    stop() {
      if (!active) return;
      if (speechDetected && totalSamples >= TARGET_SR * 0.3) {
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
