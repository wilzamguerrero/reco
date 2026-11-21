/**
 * Estado de la grabación de pantalla para el panel.
 *
 * El reloj se deriva en local en vez de escuchar cada evento del núcleo: un
 * refresco cada 200 ms basta para un contador y ahorra IPC.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ipc, onCoreEvent, toMessage } from "../../services/ipc";
import type { RecordingStopResult, VideoQuality } from "../../types/ipc";

export type RecordingPhase = "idle" | "recording" | "saving";

export interface RecordingControl {
  phase: RecordingPhase;
  elapsedMs: number;
  result: RecordingStopResult | null;
  error: string | null;
  start: (opts: { fps: 15 | 30 | 60; quality: VideoQuality; systemAudio: boolean }) => void;
  stop: () => void;
  cancel: () => void;
}

export function useRecording(): RecordingControl {
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [elapsedMs, setElapsed] = useState(0);
  const [result, setResult] = useState<RecordingStopResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "recording") return;

    const timer = window.setInterval(() => {
      if (startedAt.current !== null) setElapsed(Date.now() - startedAt.current);
    }, 200);

    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const off = onCoreEvent<{ sessionId: string }>("recording:started", () => {
      startedAt.current = Date.now();
    });
    return () => {
      void off.then((fn) => fn());
    };
  }, []);

  const start = useCallback(
    (opts: { fps: 15 | 30 | 60; quality: VideoQuality; systemAudio: boolean }) => {
      setError(null);
      setResult(null);

      ipc
        .recording
        .start({
          target: { kind: "screen", id: "primary" },
          video: { fps: opts.fps, quality: opts.quality },
          systemAudio: opts.systemAudio,
          uploadImmediately: true,
          width: 1920,
          height: 1080,
        })
        .then(() => {
          startedAt.current = Date.now();
          setElapsed(0);
          setPhase("recording");
        })
        .catch((e) => {
          setError(toMessage(e));
          setPhase("idle");
        });
    },
    [],
  );

  const stop = useCallback(() => {
    setPhase("saving");
    ipc.recording
      .stop()
      .then(setResult)
      .catch((e) => setError(toMessage(e)))
      .finally(() => {
        startedAt.current = null;
        setPhase("idle");
      });
  }, []);

  const cancel = useCallback(() => {
    ipc.recording
      .cancel()
      .catch((e) => setError(toMessage(e)))
      .finally(() => {
        startedAt.current = null;
        setElapsed(0);
        setPhase("idle");
      });
  }, []);

  return { phase, elapsedMs, result, error, start, stop, cancel };
}
