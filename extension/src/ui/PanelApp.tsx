import { useMemo, useState } from "react";
import type { OrbVisualState } from "../shared/orbRenderer";
import { Icon, type IconName } from "./components/Icon";
import { Orb } from "./components/Orb";
import { useRecoState } from "./hooks/useRecoState";
import { BibliotecaTab } from "./tabs/BibliotecaTab";
import { DictadoTab } from "./tabs/DictadoTab";
import { GrabarTab } from "./tabs/GrabarTab";
import { NotionTab } from "./tabs/NotionTab";

type Tab = "dictado" | "grabar" | "biblioteca" | "notion";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dictado", label: "Dictado", icon: "mic" },
  { id: "grabar", label: "Grabar", icon: "monitor" },
  { id: "biblioteca", label: "Biblioteca", icon: "grid" },
  { id: "notion", label: "Notion", icon: "notion" },
];

export function PanelApp({ isSidePanel = false }: { isSidePanel?: boolean }) {
  const [tab, setTab] = useState<Tab>("dictado");
  const { live, config, recordings, setRecordings, updateConfig, send } = useRecoState();

  const orbVisual = useMemo<OrbVisualState>(() => {
    if (live.recordingPhase === "recording") return "recording";
    if (live.recordingPhase === "paused") return "paused";
    if (live.recordingPhase === "uploading" || live.uploadActiveId) return "uploading";
    if (live.dictationPhase === "listening") return "dictation";
    return "idle";
  }, [live.recordingPhase, live.uploadActiveId, live.dictationPhase]);

  const orbLevel =
    live.recordingPhase === "recording"
      ? live.recordingLevel
      : live.dictationPhase === "listening"
        ? live.dictationLevel
        : 0;

  const statusInfo = useMemo(() => {
    if (live.recordingPhase === "recording") {
      return { dot: "dot-recording", label: "Grabando pantalla (Rojo)" };
    }
    if (live.recordingPhase === "paused") {
      return { dot: "dot-recording", label: "Grabación en pausa" };
    }
    if (live.recordingPhase === "uploading" || live.uploadActiveId) {
      return { dot: "dot-uploading", label: `Subiendo a Notion · ${live.uploadProgress}%` };
    }
    if (live.dictationPhase === "listening") {
      return { dot: "dot-dictation", label: "Dictando en el cursor (Cian)" };
    }
    return {
      dot: "",
      label: config.notion.targetPageTitle
        ? `Notion: ${config.notion.targetPageTitle}`
        : "Listo · Elige página en Notion",
    };
  }, [live, config.notion.targetPageTitle]);

  return (
    <div className="panel">
      <header className="panel-head">
        <div className="head-orb">
          <Orb size={42} zoom={1.2} state={orbVisual} level={orbLevel} />
        </div>

        <div className="head-text">
          <span className="head-title">
            RECO
            <span className={`dot ${statusInfo.dot}`} aria-hidden="true" />
          </span>
          <span className="head-status">{statusInfo.label}</span>
        </div>

        <div className="head-actions">
          {!isSidePanel && (
            <button
              type="button"
              className="icon-btn"
              title="Abrir como panel lateral fijo"
              onClick={() => {
                void send({ type: "OPEN_SIDEPANEL" });
                window.close();
              }}
            >
              <Icon name="panel" size={14} />
            </button>
          )}
        </div>
      </header>

      <nav className="tabs" aria-label="Secciones">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab tab-${t.id} ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="panel-body">
        {tab === "dictado" && (
          <DictadoTab live={live} config={config} updateConfig={updateConfig} send={send} />
        )}
        {tab === "grabar" && (
          <GrabarTab
            live={live}
            config={config}
            updateConfig={updateConfig}
            send={send}
            onGoNotion={() => setTab("notion")}
          />
        )}
        {tab === "biblioteca" && (
          <BibliotecaTab
            recordings={recordings}
            live={live}
            send={send}
            onRemoved={setRecordings}
          />
        )}
        {tab === "notion" && <NotionTab config={config} updateConfig={updateConfig} />}
      </main>
    </div>
  );
}
