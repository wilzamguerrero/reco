/**
 * Shell de la aplicación: barra lateral + sección activa.
 *
 * En la Fase 0 solo existen las secciones vacías; cada fase posterior rellena
 * su módulo en `features/`.
 */

import { useEffect, useState } from "react";

import { DictationSection } from "./features/dictation/DictationSection";
import { LibrarySection } from "./features/library/LibrarySection";
import { RecordingSection } from "./features/recording/RecordingSection";
import { SettingsSection } from "./features/settings/SettingsSection";
import { onCoreEvent } from "./services/ipc";

type Section = "library" | "dictation" | "recording" | "settings";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "library", label: "Biblioteca", hint: "Tus grabaciones y enlaces" },
  { id: "dictation", label: "Dictado", hint: "Voz a texto local" },
  { id: "recording", label: "Grabar", hint: "Pantalla, micrófono y audio" },
  { id: "settings", label: "Ajustes", hint: "Atajos, Notion y sistema" },
];

export function App() {
  const [section, setSection] = useState<Section>("library");

  // La bandeja puede pedir que se abra una sección concreta.
  useEffect(() => {
    const unsubscribe = onCoreEvent<{ section: string }>("tray:navigate", ({ section: target }) => {
      if (SECTIONS.some((s) => s.id === target)) {
        setSection(target as Section);
      }
    });
    return () => {
      void unsubscribe.then((off) => off());
    };
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">RECO</span>
        </div>

        <nav className="nav" aria-label="Secciones">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${section === item.id ? "is-active" : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-label">{item.label}</span>
              <span className="nav-hint">{item.hint}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        {section === "library" && <LibrarySection />}
        {section === "dictation" && <DictationSection />}
        {section === "recording" && <RecordingSection />}
        {section === "settings" && <SettingsSection />}
      </main>
    </div>
  );
}
