/**
 * Estado del dictado para el panel.
 *
 * El núcleo manda el estado por eventos; la UI solo refleja. Se centraliza aquí
 * porque el panel y el orbe de la cabecera necesitan lo mismo y no conviene
 * repetir las suscripciones.
 */

import { useCallback, useEffect, useState } from "react";

import { ipc, onCoreEvent, toMessage } from "../../services/ipc";
import type { DictationState } from "../../types/ipc";

export interface DictationControl {
  state: DictationState;
  /** Último texto dictado, para mostrarlo y poder copiarlo. */
  text: string;
  /** Aviso del núcleo (por ejemplo, «no se detectó voz»). */
  notice: string | null;
  error: string | null;
  busy: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  clearNotice: () => void;
}

export function useDictation(): DictationControl {
  const [state, setState] = useState<DictationState>("idle");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const offs = [
      onCoreEvent<{ state: DictationState }>("dictation:state", (p) => {
        setState(p.state);
        if (p.state === "listening") setNotice(null);
      }),
      onCoreEvent<{ text: string }>("dictation:result", (p) => setText(p.text)),
      onCoreEvent<{ message: string }>("dictation:notice", (p) => setNotice(p.message)),
      onCoreEvent<{ scope: string; message: string }>("app:error", (p) => {
        if (p.scope === "dictation") setError(p.message);
      }),
    ];

    return () => {
      for (const off of offs) void off.then((fn) => fn());
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await ipc.dictation.start("push_to_talk");
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await ipc.dictation.stop();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await ipc.dictation.cancel();
    } catch (e) {
      setError(toMessage(e));
    }
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
    setError(null);
  }, []);

  return { state, text, notice, error, busy, start, stop, cancel, clearNotice };
}
