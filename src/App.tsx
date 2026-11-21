/**
 * Punto de entrada de la ventana principal.
 *
 * Toda la interfaz es el panel: una sola superficie, sin barra lateral ni
 * secciones que se apilen. El enrutado interno lo resuelve `Panel`.
 */

import { Panel } from "./features/panel/Panel";

export function App() {
  return <Panel />;
}
