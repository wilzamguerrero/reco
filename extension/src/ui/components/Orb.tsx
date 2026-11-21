import { useEffect, useRef } from "react";
import { mountOrb, type OrbHandle, type OrbVisualState } from "../../shared/orbRenderer";

export function Orb({
  size = 44,
  zoom = 1.18,
  state = "idle",
  level = 0,
}: {
  size?: number;
  zoom?: number;
  state?: OrbVisualState;
  level?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
  }, [size, zoom]);

  useEffect(() => {
    handleRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    handleRef.current?.setLevel(level);
  }, [level]);

  return <canvas ref={canvasRef} aria-hidden="true" style={{ display: "block" }} />;
}
