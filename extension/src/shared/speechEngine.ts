/**
 * Motor de dictado continuo por voz (SpeechRecognition + medidor RMS).
 *
 * Emite actualizaciones EN VIVO (`onLive`) palabra por palabra mientras hablas
 * para escribir directamente en el cursor sin esperar a que termines de hablar,
 * además de confirmar cada frase al finalizar (`onFinal`).
 *
 * Se reanuda automáticamente tras silencios o cortes de Chrome (~60 s) y SOLO
 * se detiene cuando el usuario llama `stop()` o ante error fatal de permisos.
 */

import { cleanDictatedChunk } from "./polish";
import type { LiveSpeechPayload } from "./types";

interface SpeechRecognitionAlt {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlt | undefined;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecCtor = new () => SpeechRecognitionLike;

function getRecCtor(): RecCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecCtor;
    webkitSpeechRecognition?: RecCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechAvailable(): boolean {
  return getRecCtor() !== null;
}

function resolveLang(preferred?: string): string {
  if (preferred && preferred !== "auto") return preferred;
  return navigator.language || "es-419";
}

export interface SpeechEngineOptions {
  language?: string;
  polish?: boolean;
  autoCapitalize?: boolean;
  onReady?: () => void;
  onInterim?: (text: string) => void;
  onLive?: (payload: LiveSpeechPayload) => void;
  onFinal?: (text: string) => void;
  onLevel?: (rms: number) => void;
  onError?: (message: string, fatal: boolean) => void;
  onStop?: () => void;
}

export interface SpeechEngineHandle {
  start(): Promise<void>;
  stop(): void;
  updateOptions(
    patch: Partial<Pick<SpeechEngineOptions, "language" | "polish" | "autoCapitalize">>,
  ): void;
  isRunning(): boolean;
}

export function createSpeechEngine(opts: SpeechEngineOptions): SpeechEngineHandle {
  let lang = resolveLang(opts.language);
  let polish = opts.polish ?? true;
  let autoCapitalize = opts.autoCapitalize ?? true;

  let active = false;
  let userStopped = false;
  let rec: SpeechRecognitionLike | null = null;
  let restartTimer: number | null = null;
  let networkRetries = 0;
  let isNewSentence = true;
  let sessionSeq = 0;

  // AudioContext RMS meter
  let micStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let levelTimer: number | null = null;

  async function startMicMeter() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(micStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      levelTimer = window.setInterval(() => {
        if (!active) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          sum += buf[i] * buf[i];
        }
        opts.onLevel?.(Math.sqrt(sum / buf.length));
      }, 65);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const msg = err instanceof Error ? err.message : String(err);
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || /denied|permission/i.test(msg)) {
        throw new Error("MIC_PERMISSION_REQUIRED: Permiso de micrófono necesario para dictar.");
      }
      throw new Error(`No se pudo abrir el micrófono: ${msg}`);
    }
  }

  function stopMicMeter() {
    if (levelTimer !== null) {
      clearInterval(levelTimer);
      levelTimer = null;
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

  function clearRestartTimer() {
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function spawnRecogniser() {
    if (userStopped || !active) return;
    const Rec = getRecCtor();
    if (!Rec) {
      finishWithError("Este navegador no soporta SpeechRecognition.", true);
      return;
    }

    sessionSeq += 1;
    const seq = sessionSeq;
    const finalizedSlots = new Set<number>();

    const instance = new Rec();
    instance.lang = lang;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onstart = () => {
      opts.onReady?.();
    };

    instance.onresult = (event) => {
      networkRetries = 0;
      let interimAll = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (finalizedSlots.has(i)) continue;
        const res = event.results[i];
        const raw = res?.[0]?.transcript ?? "";
        if (!raw.trim()) continue;

        const utteranceId = `${seq}-${i}`;
        const cleaned = cleanDictatedChunk(raw, {
          polish: res?.isFinal ? polish : false,
          autoCapitalize,
          isNewSentence,
        });

        if (!cleaned) continue;

        if (res?.isFinal) {
          finalizedSlots.add(i);
          isNewSentence = /[.!?…]\s*$/.test(cleaned);
          opts.onLive?.({ utteranceId, text: cleaned, isFinal: true });
          opts.onFinal?.(cleaned);
        } else {
          interimAll += (interimAll ? " " : "") + cleaned;
          opts.onLive?.({ utteranceId, text: cleaned, isFinal: false });
        }
      }

      opts.onInterim?.(interimAll);
    };

    instance.onerror = (ev) => {
      const code = ev.error || "unknown";

      if (code === "no-speech" || code === "aborted") {
        return;
      }

      if (code === "language-not-supported" && lang === "es-419") {
        lang = "es-MX";
        return;
      }

      if (code === "not-allowed" || code === "service-not-allowed") {
        finishWithError(
          "MIC_PERMISSION_REQUIRED: Permiso de micrófono o servicio de voz denegado.",
          true,
        );
        return;
      }

      if (code === "audio-capture") {
        finishWithError("No se detectó ningún micrófono disponible.", true);
        return;
      }

      if (code === "network") {
        networkRetries += 1;
        if (networkRetries <= 4) {
          opts.onError?.(
            `Conexión inestable con el servicio de voz, reintentando (${networkRetries}/4)…`,
            false,
          );
          return;
        }
        finishWithError("El reconocimiento de voz requiere conexión a internet.", true);
        return;
      }

      opts.onError?.(`Aviso de dictado (${code}), reanudando…`, false);
    };

    instance.onend = () => {
      if (rec !== instance) return;
      rec = null;

      if (userStopped || !active) {
        cleanupAll();
        opts.onStop?.();
        return;
      }

      clearRestartTimer();
      const delay = networkRetries > 0 ? Math.min(2000, 350 * networkRetries) : 120;
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        spawnRecogniser();
      }, delay);
    };

    rec = instance;
    try {
      instance.start();
    } catch {
      if (!userStopped && active) {
        clearRestartTimer();
        restartTimer = window.setTimeout(() => {
          restartTimer = null;
          spawnRecogniser();
        }, 250);
      }
    }
  }

  function cleanupAll() {
    active = false;
    clearRestartTimer();
    stopMicMeter();
    if (rec) {
      const target = rec;
      rec = null;
      try {
        target.abort();
      } catch {
        // ignore
      }
    }
  }

  function finishWithError(message: string, fatal: boolean) {
    if (fatal) {
      userStopped = true;
      cleanupAll();
      opts.onError?.(message, true);
      opts.onStop?.();
    } else {
      opts.onError?.(message, false);
    }
  }

  return {
    async start() {
      if (active) return;
      if (!getRecCtor()) {
        throw new Error("Este navegador no soporta Web Speech API (usa Chrome o Edge).");
      }
      userStopped = false;
      active = true;
      networkRetries = 0;
      isNewSentence = true;

      await startMicMeter();
      spawnRecogniser();
    },

    stop() {
      if (!active && !rec) return;
      userStopped = true;
      clearRestartTimer();

      if (rec) {
        const target = rec;
        try {
          target.stop();
        } catch {
          cleanupAll();
          opts.onStop?.();
        }
      } else {
        cleanupAll();
        opts.onStop?.();
      }
    },

    updateOptions(patch) {
      if (patch.language !== undefined) lang = resolveLang(patch.language);
      if (patch.polish !== undefined) polish = patch.polish;
      if (patch.autoCapitalize !== undefined) autoCapitalize = patch.autoCapitalize;
    },

    isRunning() {
      return active;
    },
  };
}
