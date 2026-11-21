/**
 * Panel principal de RECO.
 *
 * Una sola superficie cuadrada, sin barra lateral ni tarjetas apiladas: las
 * cuatro pestañas de iconos cambian el contenido del mismo marco, de modo que
 * el panel nunca crece ni se desplaza. El diseño sigue al orbe: fondo casi
 * negro, un único acento rojo incandescente y el orbe de estado como cabecera.
 *
 * Las opciones que aparecían en dos sitios (idioma y modelo estaban en Dictado
 * y en Ajustes; «Probar/Detener» duplicaba el atajo global) viven ahora en un
 * único lugar.
 */

import { useEffect, useMemo, useState } from "react";

import { Icon, type IconName } from "../../components/Icon";
import { Orb } from "../../components/Orb";
import type { OrbState } from "../../components/orbRenderer";
import { onCoreEvent } from "../../services/ipc";
import type { DictationState } from "../../types/ipc";
import { AjustesTab } from "./tabs/AjustesTab";
import { BibliotecaTab } from "./tabs/BibliotecaTab";
import { DictadoTab } from "./tabs/DictadoTab";
import { GrabarTab } from "./tabs/GrabarTab";
import { TitleBar } from "./TitleBar";
import { useConfig } from "./useConfig";
import { useDictation } from "./useDictation";
import { useRecording } from "./useRecording";

type Tab = "dictado" | "grabar" | "biblioteca" | "ajustes";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dictado", label: "Dictado", icon: "mic" },
  { id: "grabar", label: "Grabar", icon: "monitor" },
  { id: "biblioteca", label: "Biblioteca", icon: "grid" },
  { id: "ajustes", label: "Ajustes", icon: "sliders" },
];

/** El orbe del panel refleja el dictado; grabando, se queda quieto y apagado. */
function orbState(state: DictationState): OrbState {
  return state;
}
export function Panel() {
  const [tab, setTab] = useState<Tab>("dictado");
  const dictation = useDictation();
  const recording = useRecording();
  const cfg = useConfig();

  // La bandeja pide qué pestaña abrir al mostrar la ventana.
  useEffect(() => {
    const off = onCoreEvent<{ section: string }>("tray:navigate", ({ section }) => {
      const target = TABS.find((t) => t.id === section);
      if (target) setTab(target.id);
    });

    return () => {
      void off.then((fn) => fn());
    };
  }, []);

  const status = useMemo(() => {
    if (recording.phase === "recording") {
      return { tone: "rec" as const, label: "Grabando" };
    }
    switch (dictation.state) {
      case "listening":
        return { tone: "live" as const, label: "Escuchando" };
      case "transcribing":
        return { tone: "live" as const, label: "Transcribiendo" };
      case "inserting":
        return { tone: "live" as const, label: "Insertando" };
      default:
        return { tone: "idle" as const, label: "Listo" };
    }
  }, [dictation.state, recording.phase]);

  const shortcut = cfg.config?.dictation.shortcut ?? "…";

  return (
    <div className="panel">
      <TitleBar />

      <header className="panel-head" data-tauri-drag-region>
        <div className="head-orb" data-tauri-drag-region>
          <Orb
            size={40}
            zoom={1.28}
            state={orbState(dictation.state)}
            listenLevel={dictation.state === "listening"}
          />
        </div>

        <div className="head-text" data-tauri-drag-region>
          <span className="head-title" data-tauri-drag-region>
            RECO
            <span className={`dot dot-${status.tone}`} aria-hidden="true" />
          </span>
          <span className="head-status" data-tauri-drag-region>
            {status.label}
          </span>
        </div>

        {shortcut !== "…" && (
          <kbd className="head-shortcut" title="Atajo global para dictar">
            {shortcut}
          </kbd>
        )}
      </header>

      <nav className="tabs" aria-label="Secciones">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`tab ${tab === item.id ? "is-active" : ""}`}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
            title={item.label}
          >
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {tab === "dictado" && <DictadoTab dictation={dictation} cfg={cfg} />}
        {tab === "grabar" && <GrabarTab recording={recording} cfg={cfg} />}
        {tab === "biblioteca" && <BibliotecaTab />}
        {tab === "ajustes" && <AjustesTab cfg={cfg} />}
      </div>
    </div>
  );
}
