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
  invalidateCustomPocketVoice,
  KOKORO_VOICES,
  MOSS_VOICES,
  PIPER_VOICES,
  POCKET_VOICES,
  speakReply,
  stopSpeaking,
  SUPERTONIC_VOICES,
  type VoiceOption,
} from "../../shared/kokoroTts";
import { clearCustomVoicePcm, saveCustomVoicePcm } from "../../shared/storage";
import type { AiProviderId, AppConfig, TtsEngineMode } from "../../shared/types";
import { Icon } from "../components/Icon";

const TTS_ENGINES: { id: TtsEngineMode; label: string; tip: string }[] = [
  { id: "supertonic", label: "SUPERTONIC", tip: "Supertonic-3 ONNX Web local (español nativo, 10 voces)" },
  { id: "pocket", label: "POCKET", tip: "Pocket TTS local (español streaming + clonación de voz)" },
  { id: "piper", label: "PIPER", tip: "Piper TTS local neuronal (español real, caché OPFS)" },
  { id: "kokoro", label: "KOKORO", tip: "Kokoro-82M local (WebGPU/WASM)" },
  { id: "moss", label: "MOSS", tip: "MOSS-TTS-Nano (Hugging Face Space)" },
  { id: "system", label: "VOZ", tip: "Voz del sistema (instantánea)" },
  { id: "off", label: "OFF", tip: "Solo texto" },
];

async function decodeToMono24k(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const src = decoded.getChannelData(0);
    const targetRate = 24000;
    if (decoded.sampleRate === targetRate) return new Float32Array(src);
    const ratio = decoded.sampleRate / targetRate;
    const outLen = Math.max(1, Math.floor(src.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[idx] ?? 0;
      const b = src[Math.min(idx + 1, src.length - 1)] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}

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
  const [cloningBusy, setCloningBusy] = useState(false);
  const [recordingSample, setRecordingSample] = useState(false);
  const loginAbortRef = useRef<AbortController | null>(null);
  const voiceFileInputRef = useRef<HTMLInputElement | null>(null);

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
    ai.ttsMode === "supertonic"
      ? SUPERTONIC_VOICES
      : ai.ttsMode === "pocket"
        ? POCKET_VOICES
        : ai.ttsMode === "piper"
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
      next === "supertonic"
        ? SUPERTONIC_VOICES[0].id
        : next === "pocket"
          ? ai.customVoiceName
            ? "__custom__"
            : "alba"
          : next === "piper"
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

  async function handleUploadVoiceSample(file: File) {
    setCloningBusy(true);
    setTtsStatus("Procesando muestra de voz…");
    try {
      const buf = await file.arrayBuffer();
      const pcm24k = await decodeToMono24k(buf);
      const label = file.name.replace(/\.[^.]+$/, "").slice(0, 22) || "Mi voz";
      await saveCustomVoicePcm(pcm24k, label);
      invalidateCustomPocketVoice();
      await updateConfig({
        ai: { ...ai, ttsMode: "pocket", ttsVoice: "__custom__", customVoiceName: label },
      });
      setTtsStatus(`Voz clonada guardada: ${label}`);
      window.setTimeout(() => setTtsStatus(null), 2400);
    } catch (err) {
      setTtsStatus(`Error audio: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCloningBusy(false);
    }
  }

  async function handleRecordVoiceSample() {
    if (recordingSample || cloningBusy) return;
    setRecordingSample(true);
    setTtsStatus("Grabando muestra de tu voz (5s)… habla natural");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const done = new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      });
      rec.start();
      await new Promise((r) => window.setTimeout(r, 5000));
      if (rec.state !== "inactive") rec.stop();
      stream.getTracks().forEach((t) => t.stop());

      setRecordingSample(false);
      setCloningBusy(true);
      setTtsStatus("Guardando tu voz clonada…");
      const blob = await done;
      const pcm24k = await decodeToMono24k(await blob.arrayBuffer());
      const label = "Mi voz (mic)";
      await saveCustomVoicePcm(pcm24k, label);
      invalidateCustomPocketVoice();
      await updateConfig({
        ai: { ...ai, ttsMode: "pocket", ttsVoice: "__custom__", customVoiceName: label },
      });
      setTtsStatus("✓ Voz clonada lista para usar");
      window.setTimeout(() => setTtsStatus(null), 2400);
    } catch (err) {
      setTtsStatus(`Micrófono: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRecordingSample(false);
      setCloningBusy(false);
    }
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
                  {v.id === "__custom__" && ai.customVoiceName
                    ? `★ ${ai.customVoiceName}`
                    : v.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-xs is-mint-btn"
              title="Escuchar prueba de voz"
              onClick={() =>
                void speakReply({
                  text: "Hola, soy RECO. Así suena esta voz en español.",
                  mode: ai.ttsMode,
                  voice: ai.ttsVoice,
                  speed: ai.ttsSpeed,
                  onStatus: setTtsStatus,
                })
              }
            >
              <Icon name="audio" size={12} /> Probar
            </button>
          </div>
        )}

        {ai.ttsMode !== "off" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="pane-hint" style={{ minWidth: 62 }}>
              Velocidad
            </span>
            <input
              type="range"
              min={0.85}
              max={1.3}
              step={0.05}
              value={ai.ttsSpeed ?? 1.05}
              style={{ flex: 1, accentColor: "var(--mint)" }}
              onChange={(e) =>
                void updateConfig({
                  ai: { ...ai, ttsSpeed: Number.parseFloat(e.target.value) || 1.05 },
                })
              }
            />
            <span className="pane-hint" style={{ fontFamily: "var(--mono)", minWidth: 34, textAlign: "right" }}>
              {(ai.ttsSpeed ?? 1.05).toFixed(2)}×
            </span>
          </div>
        )}

        {ai.ttsMode === "pocket" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 7,
              border: "1.5px solid var(--border-hi)",
              background: "var(--bg-0)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span className="pane-label" style={{ fontSize: 9.5 }}>
                Personalizar / Clonar voz (Pocket)
              </span>
              {ai.customVoiceName && (
                <button
                  type="button"
                  className="btn-xs"
                  title="Eliminar voz clonada"
                  onClick={() => {
                    void clearCustomVoicePcm();
                    invalidateCustomPocketVoice();
                    void updateConfig({
                      ai: {
                        ...ai,
                        customVoiceName: "",
                        ttsVoice: ai.ttsVoice === "__custom__" ? "alba" : ai.ttsVoice,
                      },
                    });
                  }}
                >
                  ✕ {ai.customVoiceName}
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 5 }}>
              <button
                type="button"
                className={`btn-xs ${recordingSample ? "is-mint-btn" : ""}`}
                disabled={cloningBusy || recordingSample}
                style={{ flex: 1 }}
                onClick={() => void handleRecordVoiceSample()}
              >
                {recordingSample ? "Grabando 5s…" : "🎙 Grabar 5s"}
              </button>
              <button
                type="button"
                className="btn-xs"
                disabled={cloningBusy || recordingSample}
                style={{ flex: 1 }}
                onClick={() => voiceFileInputRef.current?.click()}
              >
                📁 Subir audio
              </button>
              <input
                ref={voiceFileInputRef}
                type="file"
                accept="audio/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleUploadVoiceSample(f);
                }}
              />
            </div>
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
