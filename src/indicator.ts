/**
 * Orbe del dictado.
 *
 * Ventana aparte del panel principal: se muestra al empezar a dictar y se
 * oculta al terminar. Solo reacciona a eventos; no invoca comandos.
 *
 * El dibujo lo pone `orbRenderer`, el mismo que usa la cabecera del panel: así
 * el indicador flotante y la interfaz no se pueden desincronizar.
 */

import { mountOrb, type OrbState } from "./components/orbRenderer";
import { onCoreEvent } from "./services/ipc";

const SIZE = 64; // coincide con la ventana de tauri.conf.json

const canvas = document.getElementById("orb") as HTMLCanvasElement;
const orb = mountOrb(canvas, SIZE, "listening");

void onCoreEvent<{ state: OrbState }>("dictation:state", (p) => orb.setState(p.state));
void onCoreEvent<{ rms: number }>("dictation:level", (p) => orb.setLevel(p.rms));
