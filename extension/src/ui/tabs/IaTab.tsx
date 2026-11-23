import { useEffect, useRef, useState } from "react";
import {
  AI_PROVIDERS,
  ensureFreePiAd,
  fetchProviderModels,
  getFreePiMe,
  startFreePiDevice,
  waitForFreePiToken,
  type FreePiAccount,
  type FreePiDeviceStart,
  type FreePiModel,
} from "../../shared/freepiClient";
import {
  getSystemVoices,
  KOKORO_VOICES,
  MOSS_VOICES,
  PIPER_VOICES,
  speakReply,
  stopSpeaking,
  type VoiceOption,
} from "../../shared/kokoroTts";
import type { AiProviderId, AppConfig, TtsEngineMode } from "../../shared/types";
import { Icon } from "../components/Icon";

const TTS_ENGINES: { id: TtsEngineMode; label: string; tip: string }[] = [
  { id: "piper", label: "PIPER", tip: "Piper TTS local neuronal (español real, caché OPFS)" },
  { id: "kokoro", label: "KOKORO", tip: "Kokoro-82M local (WebGPU/WASM)" },
  { id: "moss", label: "MOSS", tip: "MOSS-TTS-Nano (Hugging Face Space)" },
  { id: "system", label: "VOZ", tip: "Voz del sistema (instantánea)" },
  { id: "off", label: "OFF", tip: "Solo texto" },
];

export function IaTab({
  config,
  updateConfig,
}: {
  config: AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>;
}) {
  const ai = config.ai;
  const provider: AiProviderId = ai.provider || "freepi";
  const meta = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const activeKey = provider === "freepi" ? ai.freepiToken : ai.keys?.[provider] ?? "";
  const activeModel = ai.models?.[provider] || ai.model || meta.defaultModel;

  const [keyDraft, setKeyDraft] = useState(activeKey);
  const [baseDraft, setBaseDraft] = useState(ai.customBaseUrl || "http://localhost:11434/v1");
  const [loginFlow, setLoginFlow] = useState<FreePiDeviceStart | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [account, setAccount] = useState<FreePiAccount | null>(null);
  const [models, setModels] = useState<FreePiModel[]>([]);
  const [sysVoices, setSysVoices] = useState<VoiceOption[]>([]);
  const [ttsStatus, setTtsStatus] = useState<string | null>(null);
  const loginAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setKeyDraft(activeKey);
  }, [provider, activeKey]);

  useEffect(() => {
    const loadSys = () => setSysVoices(getSystemVoices());
    loadSys();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener?.("voiceschanged", loadSys);
      return () => window.speechSynthesis.removeEventListener?.("voiceschanged", loadSys);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (provider === "freepi" && ai.freepiToken) {
      void getFreePiMe(ai.freepiToken).then((me) => {
        if (!cancelled) setAccount(me);
      });
    } else {
      setAccount(null);
    }

    void fetchProviderModels({
      provider,
      key: activeKey,
      customBaseUrl: ai.customBaseUrl,
    }).then((list) => {
      if (!cancelled) setModels(list);
    });

    return () => {
      cancelled = true;
    };
  }, [provider, activeKey, ai.customBaseUrl]);

  useEffect(() => {
    return () => {
      loginAbortRef.current?.abort();
      stopSpeaking();
    };
  }, []);

  async function handleConnectGitHub() {
    setLoginBusy(true);
    setLoginErr("");
    loginAbortRef.current?.abort();
    const ctrl = new AbortController();
    loginAbortRef.current = ctrl;

    try {
      const start = await startFreePiDevice();
      setLoginFlow(start);
      void navigator.clipboard.writeText(start.userCode).catch(() => {});
      void chrome.tabs.create({ url: start.verificationUriComplete || start.verificationUri });

      const { token } = await waitForFreePiToken(start, ctrl.signal);
      const me = await getFreePiMe(token);
      await updateConfig({
        ai: {
          ...ai,
          provider: "freepi",
          freepiToken: token,
          freepiHandle: me?.handle || "",
        },
      });
      setLoginFlow(null);
      void ensureFreePiAd(token, true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setLoginErr(err instanceof Error ? err.message : String(err));
      }
      setLoginFlow(null);
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleSaveKey() {
    const nextKeys = { ...(ai.keys ?? {}) };
    if (keyDraft.trim()) nextKeys[provider] = keyDraft.trim();
    else delete nextKeys[provider];

    await updateConfig({
      ai: {
        ...ai,
        keys: nextKeys,
        customBaseUrl:
          provider === "custom" ? baseDraft.trim() || "http://localhost:11434/v1" : ai.customBaseUrl,
      },
    });
  }

  const voiceList: VoiceOption[] =
    ai.ttsMode === "piper"
      ? PIPER_VOICES
      : ai.ttsMode === "kokoro"
        ? KOKORO_VOICES
        : ai.ttsMode === "moss"
          ? MOSS_VOICES
          : ai.ttsMode === "system"
            ? sysVoices
            : [];

  function switchTtsMode(next: TtsEngineMode) {
    stopSpeaking();
    const nextVoice =
      next === "piper"
        ? PIPER_VOICES[0].id
        : next === "kokoro"
          ? KOKORO_VOICES[0].id
          : next === "moss"
            ? MOSS_VOICES[0].id
            : next === "system"
              ? sysVoices[0]?.id ?? ""
              : ai.ttsVoice;
    void updateConfig({ ai: { ...ai, ttsMode: next, ttsVoice: nextVoice } });
  }

  return (
    <div className="pane pane-scroll">
      <div className="pane-col">
        <span className="pane-label">Proveedor de IA</span>
        <div className="chips" style={{ marginLeft: 0 }}>
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip is-cyan ${provider === p.id ? "is-active" : ""}`}
              onClick={() => void updateConfig({ ai: { ...ai, provider: p.id } })}
            >
              {p.label.split(" ")[0]}
            </button>
          ))}
        </div>

        {provider === "freepi" ? (
          ai.freepiToken ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span className="pane-hint" style={{ color: "var(--mint)" }}>
                ✓ Conectado ({account?.handle || ai.freepiHandle || "GitHub"})
              </span>
              <button
                type="button"
                className="btn-xs"
                onClick={() =>
                  void updateConfig({ ai: { ...ai, freepiToken: "", freepiHandle: "" } })
                }
              >
                Desconectar
              </button>
            </div>
          ) : loginFlow ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
              <span className="pane-hint">Código copiado · Pégalo en GitHub:</span>
              <code style={{ fontFamily: "var(--mono)", fontSize: 17, fontWeight: 800, color: "var(--mint)" }}>
                {loginFlow.userCode}
              </code>
              <button
                type="button"
                className="btn-xs"
                onClick={() => {
                  loginAbortRef.current?.abort();
                  setLoginFlow(null);
                  setLoginBusy(false);
                }}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={loginBusy}
              className="action-primary action-cyan"
              onClick={() => void handleConnectGitHub()}
            >
              <Icon name="spark" size={14} />
              <span>{loginBusy ? "Conectando…" : "Conectar free-pi con GitHub"}</span>
            </button>
          )
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {provider === "custom" && (
              <input
                placeholder="http://localhost:11434/v1 o URL OpenAI-compatible"
                value={baseDraft}
                onChange={(e) => setBaseDraft(e.target.value)}
              />
            )}
            <div style={{ display: "flex", gap: 5 }}>
              <input
                type="password"
                style={{ flex: 1 }}
                placeholder={meta.placeholder || "API Key"}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button type="button" className="btn-xs is-mint-btn" onClick={() => void handleSaveKey()}>
                Guardar
              </button>
            </div>
          </div>
        )}
        {loginErr && <div className="alert-box">{loginErr}</div>}
      </div>

      <div className="pane-row">
        <span className="pane-label">Modelo</span>
        <select
          className="chat-select"
          style={{ maxWidth: 215 }}
          value={activeModel}
          onChange={(e) =>
            void updateConfig({
              ai: {
                ...ai,
                model: e.target.value,
                models: { ...(ai.models ?? {}), [provider]: e.target.value },
              },
            })
          }
        >
          {models.length === 0 && <option value={activeModel}>{activeModel}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.vision ? "👁 " : ""}
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="pane-col">
        <span className="pane-label">Motor de voz de respuesta (TTS)</span>
        <div className="chips" style={{ marginLeft: 0 }}>
          {TTS_ENGINES.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.tip}
              className={`chip is-cyan ${ai.ttsMode === t.id ? "is-active" : ""}`}
              onClick={() => switchTtsMode(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {ai.ttsMode !== "off" && voiceList.length > 0 && (
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <select
              className="chat-select"
              value={ai.ttsVoice}
              onChange={(e) => {
                stopSpeaking();
                void updateConfig({ ai: { ...ai, ttsVoice: e.target.value } });
              }}
            >
              {voiceList.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-xs is-mint-btn"
              title="Escuchar prueba de voz"
              onClick={() =>
                void speakReply({
                  text: "Hola, soy RECO. Así suena esta voz.",
                  mode: ai.ttsMode,
                  voice: ai.ttsVoice,
                  onStatus: setTtsStatus,
                })
              }
            >
              <Icon name="audio" size={12} /> Probar
            </button>
          </div>
        )}
        {ttsStatus && (
          <div className="ok-box" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
            {ttsStatus}
          </div>
        )}
      </div>
    </div>
  );
}
