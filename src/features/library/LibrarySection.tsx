/**
 * Sección Biblioteca.
 *
 * Fase 0: estado vacío. La lista real y el portal de enlaces llegan en la Fase 5.
 */

export function LibrarySection() {
  return (
    <section className="section">
      <header className="section-header">
        <h1>Biblioteca</h1>
        <p>Aquí aparecerán tus grabaciones y sus enlaces de Notion.</p>
      </header>

      <div className="card">
        <h2>Todavía no hay grabaciones</h2>
        <p className="muted">
          Cuando grabes la primera pantalla, aparecerá aquí con su estado de subida
          y el enlace para compartir.
        </p>
      </div>
    </section>
  );
}
