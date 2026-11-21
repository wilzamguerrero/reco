import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ExtMessage } from "../shared/types";
import { Orb } from "../ui/components/Orb";
import "../ui/styles/global.css";

function PermissionsPage() {
  const [state, setState] = useState<"idle" | "granted" | "denied">("idle");
  const [error, setError] = useState("");

  const params = new URLSearchParams(window.location.search);
  const after = params.get("after") as "dictation" | "recording" | null;

  async function requestMic() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setState("granted");
      await chrome.runtime.sendMessage({
        type: "PERMISSIONS_GRANTED",
        afterAction: after ?? undefined,
      } satisfies ExtMessage);
      window.setTimeout(() => window.close(), 900);
    } catch (err) {
      setState("denied");
      setError(
        err instanceof Error
          ? err.message
          : "Permiso denegado. Haz clic en el candado de la barra de direcciones para permitir el micrófono.",
      );
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#000",
        color: "#f2ecec",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          padding: 24,
          borderRadius: 14,
          border: "1px solid #232025",
          background: "#0a0a0b",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          textAlign: "center",
        }}
      >
        <Orb size={64} state={state === "granted" ? "dictation" : "idle"} />
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>
          Activa el micrófono para RECO
        </h1>
        <p style={{ margin: 0, fontSize: 12.5, color: "#968d92", lineHeight: 1.5 }}>
          Solo necesitas conceder permiso una vez. Así podrás dictar en cualquier página web sin
          volver a ver avisos ni interrupciones.
        </p>

        {state === "granted" ? (
          <div style={{ color: "#45c07a", fontSize: 13, fontWeight: 600 }}>
            ✓ Micrófono listo. Volviendo…
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void requestMic()}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 9,
              borderColor: "rgba(34,211,238,0.5)",
              background: "rgba(34,211,238,0.16)",
              color: "#a5f3fc",
              fontWeight: 600,
            }}
          >
            Permitir micrófono ahora
          </button>
        )}

        {error && <div style={{ color: "#ff8a5c", fontSize: 12 }}>{error}</div>}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PermissionsPage />);
