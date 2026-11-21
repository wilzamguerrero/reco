/**
 * Botones de ventana integrados.
 *
 * La ventana no tiene decoración del sistema: minimizar y cerrar viven dentro
 * del panel, alineados con su cabecera, para que no haya una franja encima del
 * diseño. El arrastre lo aporta la cabecera entera (`data-tauri-drag-region`),
 * así que aquí solo van los botones.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

import { Icon } from "../../components/Icon";

const appWindow = getCurrentWindow();

export function TitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-actions">
        <button
          type="button"
          className="win-btn"
          title="Minimizar"
          aria-label="Minimizar"
          onClick={() => void appWindow.minimize()}
        >
          <Icon name="minimize" size={12} />
        </button>
        <button
          type="button"
          className="win-btn win-btn-close"
          title="Cerrar"
          aria-label="Cerrar"
          onClick={() => void appWindow.close()}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}
