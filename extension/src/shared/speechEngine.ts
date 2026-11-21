/**
 * Motor de dictado continuo por voz (SpeechRecognition + medidor RMS).
 *
 * Basado en `iii/src/core/voice/dictate.ts` y `inre/FloatingAiAssistant.tsx`,
 * mejorado para conversaciones largas:
 * - Usa `continuous = true` y `interimResults = true` (el texto provisional
 *   solo se muestra en la píldora flotante, mientras que las frases finalizadas
 *   se insertan limpiamente en el cursor sin parpadeos).
 * - Si Chrome corta la sesión por silencio (`no-speech`) o por límite de ~60s,
 *   se reanuda automáticamente creando una nueva instancia tras un breve respiro.
 * - SOLO se detiene cuando el usuario llama `stop()` o ante un error fatal
 *   de permisos/hardware (`not-allowed`, `audio-capture`, `language-not-supported`).
 */

import { cleanDictatedChunk } from "./polish";

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
  const nav = navigator.language || "es-419";
  return nav;
}

export interface SpeechEngineOptions {
  language?: string;
  polish?: boolean;
  autoCapitalize?: boolean;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onLevel?: (rms: number) => void;
  onError?: (message: string, fatal: boolean) => void;
  onStop?: () => void;
}

export interface SpeechEngineHandle {
  start(): Promise<void>;
  stop(): void;
  updateOptions(patch: Partial<Pick<SpeechEngineOptions, "language" | "polish" | "autoCapitalize">>): void;
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
        const rms = Math.sqrt(sum / buf.length);
        opts.onLevel?.(rms);
      }, 65);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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

    const instance = new Rec();
    instance.lang = lang;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      networkRetries = 0;
      let interim = "";
      let finalRaw = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const transcript = res?.[0]?.transcript ?? "";
        if (!transcript) continue;
        if (res?.isFinal) {
          finalRaw += (finalRaw ? " " : "") + transcript;
        } else {
          interim += (interim ? " " : "") + transcript;
        }
      }

      if (interim.trim()) {
        opts.onInterim?.(interim.trim());
      } else if (finalRaw.trim()) {
        opts.onInterim?.("");
      }

      if (finalRaw.trim()) {
        const cleaned = cleanDictatedChunk(finalRaw, {
          polish,
          autoCapitalize,
          isNewSentence,
        });
        if (cleaned) {
          isNewSentence = /[.!?…]\s*$/.test(cleaned);
          opts.onFinal?.(cleaned);
        }
      }
    };

    instance.onerror = (ev) => {
      const code = ev.error || "unknown";

      if (code === "no-speech" || code === "aborted") {
        // Silencio o corte interno: `onend` reanudará automáticamente si el usuario no detuvo.
        return;
      }

      if (code === "language-not-supported" && lang === "es-419") {
        lang = "es-MX";
        return;
      }

      if (code === "not-allowed" || code === "service-not-allowed") {
        finishWithError(
          "Permiso de micrófono o servicio de voz denegado. Activa el micrófono en RECO.",
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

      // Otros errores transitorios: reintentar mientras el usuario no detenga.
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

      // Conversación larga o pausa: reanudar automáticamente hasta que el usuario lo detenga.
      clearRestartTimer();
      const delay = networkRetries > 0 ? Math.min(2000, 350 * networkRetries) : 140;
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        spawnRecogniser();
      }, delay);
    };

    rec = instance;
    try {
      instance.start();
    } catch {
      // Si falla por transición rápida, reintentar brevemente
      if (!userStopped && active) {
        clearRestartTimer();
        restartTimer = window.setTimeout(() => {
          restartTimer = null;
          spawnRecogniser();
        }, 300);
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
        // `stop()` vacía la última frase en curso como `isFinal` antes de disparar `onend`.
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
