/**
 * Orbe de estado como componente.
 *
 * El dibujo vive en `orb.ts`; esto solo lo monta y le pasa estado y nivel.
 * Se mantiene aparte para que el panel y la ventana flotante usen el mismo
 * código sin duplicar el renderizador.
 */

import { useEffect, useRef } from "react";

import { mountOrb, type OrbHandle, type OrbState } from "./orbRenderer";
import { onCoreEvent } from "../services/ipc";

export function Orb({
  size,
  state = "idle",
  listenLevel = false,
  zoom = 1,
  className,
}: {
  size: number;
  state?: OrbState;
  /** Se suscribe a `dictation:level` y mueve el orbe con la voz. */
  listenLevel?: boolean;
  /** Agranda el orbe dentro de su caja; útil en huecos pequeños. */
  zoom?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<OrbHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handle = mountOrb(canvas, size, state, zoom);
    handleRef.current = handle;

    return () => {
      handle.dispose();
      handleRef.current = null;
    };
    // `state` solo importa para el arranque; los cambios llegan por el efecto
    // siguiente y no deben remontar el canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, zoom]);

  useEffect(() => {
    handleRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    if (!listenLevel) return;

    let off: (() => void) | undefined;
    let cancelled = false;

    void onCoreEvent<{ rms: number }>("dictation:level", (p) => {
      handleRef.current?.setLevel(p.rms);
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });

    return () => {
      cancelled = true;
      off?.();
    };
  }, [listenLevel]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden="true"
    />
  );
}
