import { useMemo, useState } from "react";
import type { OrbVisualState } from "../shared/orbRenderer";
import { Icon, type IconName } from "./components/Icon";
import { Orb } from "./components/Orb";
import { useRecoState } from "./hooks/useRecoState";
import { BibliotecaTab } from "./tabs/BibliotecaTab";
import { ChatTab } from "./tabs/ChatTab";
import { DictadoTab } from "./tabs/DictadoTab";
import { GrabarTab } from "./tabs/GrabarTab";
import { NotionTab } from "./tabs/NotionTab";

type Tab = "dictado" | "chat" | "grabar" | "biblioteca" | "notion";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dictado", label: "Dictar", icon: "mic" },
  { id: "chat", label: "Chat", icon: "spark" },
  { id: "grabar", label: "Grabar", icon: "monitor" },
  { id: "biblioteca", label: "Clips", icon: "grid" },
  { id: "notion", label: "Notion", icon: "notion" },
];

export function PanelApp({ isSidePanel = false }: { isSidePanel?: boolean }) {
  const [tab, setTab] = useState<Tab>("dictado");
  const {
    live,
    config,
    recordings,
    setRecordings,
    dictationHistory,
    deleteDictationNote,
    clearHistory,
    shortcuts,
    updateConfig,
    send,
  } = useRecoState();

  const orbVisual = useMemo<OrbVisualState>(() => {
    if (live.recordingPhase === "recording") return "recording";
    if (live.recordingPhase === "paused") return "paused";
    if (live.recordingPhase === "uploading" || live.uploadActiveId) return "uploading";
    if (live.dictationPhase === "listening") {
      if (live.dictationInterim.trim().length > 0 || live.dictationLevel > 0.045) {
        return "speaking";
      }
      return "dictation";
    }
    return "idle";
  }, [
    live.recordingPhase,
    live.uploadActiveId,
    live.dictationPhase,
    live.dictationInterim,
    live.dictationLevel,
  ]);

  const orbLevel =
    live.recordingPhase === "recording"
      ? live.recordingLevel
      : live.dictationPhase === "listening"
        ? live.dictationLevel
        : 0;

  const statusInfo = useMemo(() => {
    if (live.recordingPhase === "recording") {
      return { dot: "dot-recording", label: "GRABANDO" };
    }
    if (live.recordingPhase === "paused") {
      return { dot: "dot-recording", label: "EN PAUSA" };
    }
    if (live.recordingPhase === "uploading" || live.uploadActiveId) {
      return { dot: "dot-uploading", label: `SUBIENDO · ${live.uploadProgress}%` };
    }
    if (live.dictationPhase === "listening") {
      return { dot: "dot-dictation", label: "TRANSCRIBIENDO" };
    }
    return {
      dot: "",
      label: config.notion.targetPageTitle
        ? `NOTION · ${config.notion.targetPageTitle}`
        : "LISTO",
    };
  }, [live, config.notion.targetPageTitle]);

  return (
    <div className="panel">
      <header className="panel-head">
        <div className="head-orb">
          <Orb size={38} zoom={1.08} state={orbVisual} level={orbLevel} />
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
              title="Abrir panel lateral fijo"
              onClick={() => {
                void send({ type: "OPEN_SIDEPANEL" });
                window.close();
              }}
            >
              <Icon name="panel" size={15} />
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
            title={t.label}
          >
            <Icon name={t.icon} size={16} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="panel-body">
        {tab === "dictado" && (
          <DictadoTab
            live={live}
            config={config}
            history={dictationHistory}
            shortcut={shortcuts.dictate}
            onDeleteNote={deleteDictationNote}
            onClearHistory={clearHistory}
            updateConfig={updateConfig}
            send={send}
          />
        )}
        {tab === "chat" && (
          <ChatTab config={config} updateConfig={updateConfig} send={send} />
        )}
        {tab === "grabar" && (
          <GrabarTab
            live={live}
            config={config}
            shortcut={shortcuts.record}
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
