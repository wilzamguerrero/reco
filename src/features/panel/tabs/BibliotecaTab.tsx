/**
 * Pestaña Biblioteca.
 *
 * La lista real llega en la fase de subida a Notion; de momento el estado vacío
 * ocupa el alto disponible para que el panel no salte de tamaño.
 */

import { Icon } from "../../../components/Icon";

export function BibliotecaTab() {
  return (
    <div className="pane pane-center">
      <div className="empty">
        <span className="empty-mark" aria-hidden="true">
          <Icon name="grid" size={18} />
        </span>
        <p className="empty-title">Sin grabaciones todavía</p>
        <p className="empty-hint">
          Graba una pantalla y aparecerá aquí con su enlace de Notion.
        </p>
      </div>
    </div>
  );
}
