import { createRoot } from "react-dom/client";
import { useRecoState } from "../hooks/useRecoState";
import { ChatTab } from "../tabs/ChatTab";
import "../styles/global.css";
import "../styles/app.css";

function FloatingChatApp() {
  const { config, updateConfig, send } = useRecoState();
  const params = new URLSearchParams(window.location.search);
  const autoVoice = params.get("voice") === "1";

  return (
    <div className="panel" style={{ padding: 8 }}>
      <ChatTab
        config={config}
        updateConfig={updateConfig}
        send={send}
        autoStartVoice={autoVoice}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<FloatingChatApp />);
