import { useEffect, useRef, useState } from "react";
import {
  AI_PROVIDERS,
  ensureFreePiAd,
  fetchProviderModels,
  getFreePiMe,
  startFreePiDevice,
  streamProviderChat,
  waitForFreePiToken,
  type ChatMessagePart,
  type FreePiAccount,
  type FreePiChatMessage,
  type FreePiDeviceStart,
  type FreePiModel,
} from "../../shared/freepiClient";
import {
  getSystemVoices,
  KOKORO_VOICES,
  speakReply,
  stopSpeaking,
  type VoiceOption,
} from "../../shared/kokoroTts";
import { createSpeechEngine, type SpeechEngineHandle } from "../../shared/speechEngine";
import type { AiProviderId, AppConfig, ExtMessage } from "../../shared/types";
import { Icon } from "../components/Icon";

interface ChatAttachment {
  id: string;
  kind: "image" | "doc";
  name: string;
  dataUrl?: string;
  textContent?: string;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  attachments?: ChatAttachment[];
}

const SYSTEM_PROMPT =
  "Eres RECO, un asistente inteligente minimalista integrado en el navegador. " +
  "Responde en el mismo idioma del usuario (español por defecto), de forma clara, directa y natural, " +
  "ideal tanto para leer como para escuchar en voz alta. Si recibes una captura de pantalla o documento, analízalo con precisión.";

export function ChatTab({
  config,
  updateConfig,
  send,
  autoStartVoice = false,
}: {
  config: AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>;
  send: (msg: ExtMessage) => Promise<unknown>;
  autoStartVoice?: boolean;
}) {
  const ai = config.ai;
  const provider: AiProviderId = ai.provider || "freepi";
  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const activeKey = provider === "freepi" ? ai.freepiToken : ai.keys?.[provider] ?? "";
  const activeModel = ai.models?.[provider] || ai.model || providerMeta.defaultModel;
  const hasCred =
    provider === "custom" ? Boolean(ai.customBaseUrl?.trim()) : Boolean(activeKey.trim());

  const [showConfig, setShowConfig] = useState(!hasCred);
  const [keyDraft, setKeyDraft] = useState(activeKey);
  const [baseDraft, setBaseDraft] = useState(ai.customBaseUrl || "http://localhost:11434/v1");

  // Device login state (free-pi)
  const [loginFlow, setLoginFlow] = useState<FreePiDeviceStart | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const loginAbortRef = useRef<AbortController | null>(null);

  // Account, models & voices
  const [account, setAccount] = useState<FreePiAccount | null>(null);
  const [models, setModels] = useState<FreePiModel[]>([]);
  const [sysVoices, setSysVoices] = useState<VoiceOption[]>([]);
  const [ttsStatus, setTtsStatus] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [chatErr, setChatErr] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);

  const chatAbortRef = useRef<AbortController | null>(null);
  const voiceEngineRef = useRef<SpeechEngineHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    setKeyDraft(activeKey);
    if (!hasCred) setShowConfig(true);
  }, [provider, activeKey]);

  useEffect(() => {
    const loadSys = () => setSysVoices(getSystemVoices());
    loadSys();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener?.("voiceschanged", loadSys);
      return () => window.speechSynthesis.removeEventListener?.("voiceschanged", loadSys);
    }
  }, []);

  // Load models + silent free-pi ads keep-alive
  useEffect(() => {
    let cancelled = false;
    let adTimer: number | null = null;

    if (provider === "freepi" && ai.freepiToken) {
      void ensureFreePiAd(ai.freepiToken, false);
      adTimer = window.setInterval(() => {
        if (document.visibilityState !== "hidden") {
          void ensureFreePiAd(ai.freepiToken, false);
        }
      }, 60_000);

      void getFreePiMe(ai.freepiToken).then((me) => {
        if (cancelled || !me) return;
        setAccount(me);
        if (me.handle && me.handle !== ai.freepiHandle) {
          void updateConfig({ ai: { ...ai, freepiHandle: me.handle } });
        }
      });
    } else {
      setAccount(null);
    }

    if (hasCred || provider === "openrouter" || provider === "freepi") {
      void fetchProviderModels({
        provider,
        key: activeKey,
        customBaseUrl: ai.customBaseUrl,
      }).then((list) => {
        if (cancelled) return;
        setModels(list);
        if (list.length > 0 && !list.some((m) => m.id === activeModel)) {
          const preferred =
            list.find((m) => m.vision && m.free) ?? list.find((m) => m.free) ?? list[0];
          if (preferred) {
            void updateConfig({
              ai: {
                ...ai,
                model: preferred.id,
                models: { ...(ai.models ?? {}), [provider]: preferred.id },
              },
            });
          }
        }
      });
    } else {
      setModels([]);
    }

    return () => {
      cancelled = true;
      if (adTimer !== null) window.clearInterval(adTimer);
    };
  }, [provider, activeKey, ai.customBaseUrl]);

  useEffect(() => {
    if (autoStartVoice && hasCred && !autoStartedRef.current) {
      autoStartedRef.current = true;
      toggleVoiceChat();
    }
  }, [autoStartVoice, hasCred]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  useEffect(() => {
    return () => {
      loginAbortRef.current?.abort();
      chatAbortRef.current?.abort();
      voiceEngineRef.current?.stop();
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
      setShowConfig(false);
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

  async function handleSaveProviderKey() {
    const nextKeys = { ...(ai.keys ?? {}) };
    if (keyDraft.trim()) nextKeys[provider] = keyDraft.trim();
    else delete nextKeys[provider];

    await updateConfig({
      ai: {
        ...ai,
        keys: nextKeys,
        customBaseUrl: provider === "custom" ? baseDraft.trim() || "http://localhost:11434/v1" : ai.customBaseUrl,
      },
    });
    setShowConfig(false);
  }

  async function handleCaptureScreen() {
    setChatErr("");
    const res = (await send({ type: "CAPTURE_TAB_SCREEN" })) as
      | { ok?: boolean; dataUrl?: string; title?: string; error?: string }
      | undefined;
    if (!res?.ok || !res.dataUrl) {
      setChatErr(res?.error || "No se pudo capturar la pantalla actual.");
      return;
    }
    setAttachments((prev) => [
      ...prev,
      {
        id: `scr-${Date.now()}`,
        kind: "image",
        name: res.title ? `Pantalla · ${res.title.slice(0, 16)}` : "Pantalla",
        dataUrl: res.dataUrl,
      },
    ]);
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const added: ChatAttachment[] = [];
    for (const file of Array.from(files).slice(0, 4)) {
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.readAsDataURL(file);
        });
        if (dataUrl) {
          added.push({
            id: `img-${Date.now()}-${Math.random()}`,
            kind: "image",
            name: file.name,
            dataUrl,
          });
        }
      } else {
        const textContent = (await file.text()).slice(0, 24_000);
        added.push({
          id: `doc-${Date.now()}-${Math.random()}`,
          kind: "doc",
          name: file.name,
          textContent,
        });
      }
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if ((!text && attachments.length === 0) || streaming || !hasCred) return;

    const currentAttachments = [...attachments];
    setInput("");
    setAttachments([]);
    setChatErr("");
    stopSpeaking();

    const userMsg: UiMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: text || "Analiza el contenido adjunto.",
      attachments: currentAttachments,
    };
    const assistantId = `a-${Date.now() + 1}`;
    const nextHistory = [...messages, userMsg];
    setMessages([...nextHistory, { id: assistantId, role: "assistant", text: "", reasoning: "" }]);
    setStreaming(true);

    const buildWireMessages = (): FreePiChatMessage[] => {
      const out: FreePiChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
      for (const m of nextHistory.slice(-12)) {
        if (m.role === "assistant") {
          out.push({ role: "assistant", content: m.text });
          continue;
        }
        const docs = (m.attachments ?? []).filter((a) => a.kind === "doc" && a.textContent);
        const imgs = (m.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
        const docPrefix = docs
          .map((d) => `[Documento: ${d.name}]\n${d.textContent}`)
          .join("\n\n");
        const combinedText = docPrefix ? `${docPrefix}\n\n${m.text}` : m.text;

        if (imgs.length > 0) {
          const parts: ChatMessagePart[] = [{ type: "text", text: combinedText }];
          for (const img of imgs) {
            parts.push({ type: "image_url", image_url: { url: img.dataUrl! } });
          }
          out.push({ role: "user", content: parts });
        } else {
          out.push({ role: "user", content: combinedText });
        }
      }
      return out;
    };

    const ctrl = new AbortController();
    chatAbortRef.current = ctrl;

    try {
      const result = await streamProviderChat({
        provider,
        key: activeKey,
        customBaseUrl: ai.customBaseUrl,
        model: activeModel,
        messages: buildWireMessages(),
        signal: ctrl.signal,
        onDelta(chunk) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + chunk } : m)),
          );
        },
        onReasoning(chunk) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, reasoning: (m.reasoning ?? "") + chunk } : m,
            ),
          );
        },
      });

      if (result.text && ai.ttsMode !== "off") {
        void speakReply({
          text: result.text,
          mode: ai.ttsMode,
          voice: ai.ttsVoice,
          onStatus: setTtsStatus,
        });
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        const msg = err instanceof Error ? err.message : String(err);
        setChatErr(msg);
      }
    } finally {
      setStreaming(false);
    }
  }

  function toggleVoiceChat() {
    if (voiceListening) {
      voiceEngineRef.current?.stop();
      voiceEngineRef.current = null;
      setVoiceListening(false);
      return;
    }

    stopSpeaking();
    setChatErr("");
    let collected = "";
    const eng = createSpeechEngine({
      language: config.dictation.language,
      polish: config.dictation.polish,
      onInterim(t) {
        setInput(collected ? `${collected} ${t}` : t);
      },
      onFinal(t) {
        collected = collected ? `${collected} ${t}` : t;
        setInput(collected);
      },
      onError(msg, fatal) {
        if (fatal) {
          setChatErr(msg);
          setVoiceListening(false);
        }
      },
      onStop() {
        setVoiceListening(false);
        if (collected.trim()) {
          void handleSend(collected.trim());
        }
      },
    });
    voiceEngineRef.current = eng;
    setVoiceListening(true);
    void eng.start().catch((err) => {
      setVoiceListening(false);
      setChatErr(err instanceof Error ? err.message : String(err));
    });
  }

  const voiceList = ai.ttsMode === "kokoro" ? KOKORO_VOICES : sysVoices;

  return (
    <div className="pane">
      {/* Compact top bar: provider/config toggle + model + TTS */}
      <div className="chat-toolbar">
        <button
          type="button"
          className={`btn-xs ${showConfig ? "is-mint-btn" : ""}`}
          title="Cambiar proveedor o clave API"
          onClick={() => setShowConfig((v) => !v)}
        >
          {providerMeta.label.split(" ")[0]}
        </button>

        <select
          className="chat-select"
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
          title="Modelo activo"
        >
          {models.length === 0 && <option value={activeModel}>{activeModel}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.vision ? "👁 " : ""}
              {m.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`btn-xs ${ai.ttsMode !== "off" ? "is-mint-btn" : ""}`}
          title="Cambiar motor de voz (Kokoro natural / Voz sistema / Silencio)"
          onClick={() => {
            stopSpeaking();
            const next =
              ai.ttsMode === "kokoro" ? "system" : ai.ttsMode === "system" ? "off" : "kokoro";
            const nextVoice =
              next === "kokoro"
                ? KOKORO_VOICES[0].id
                : next === "system"
                  ? sysVoices[0]?.id ?? ""
                  : ai.ttsVoice;
            void updateConfig({ ai: { ...ai, ttsMode: next, ttsVoice: nextVoice } });
          }}
        >
          <Icon name="audio" size={11} />
          <span>{ai.ttsMode === "kokoro" ? "KOKORO" : ai.ttsMode === "system" ? "VOZ" : "OFF"}</span>
        </button>

        {ai.ttsMode !== "off" && voiceList.length > 0 && (
          <select
            className="chat-select"
            style={{ maxWidth: 88 }}
            value={ai.ttsVoice}
            onChange={(e) => {
              stopSpeaking();
              void updateConfig({ ai: { ...ai, ttsVoice: e.target.value } });
            }}
            title="Elegir voz"
          >
            {voiceList.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Collapsible Multi-Provider Configuration */}
      {showConfig && (
        <div className="pane-col" style={{ borderColor: "var(--mint)", gap: 6 }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
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
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <span className="pane-hint">Código copiado · Pégalo en GitHub:</span>
                <code style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 800, color: "var(--mint)" }}>
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
                style={{ padding: "8px 10px" }}
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
                  placeholder="https://api.groq.com/openai/v1 o http://localhost:11434/v1"
                  value={baseDraft}
                  onChange={(e) => setBaseDraft(e.target.value)}
                />
              )}
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  type="password"
                  style={{ flex: 1 }}
                  placeholder={providerMeta.placeholder || "API Key"}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-xs is-mint-btn"
                  onClick={() => void handleSaveProviderKey()}
                >
                  Guardar
                </button>
              </div>
            </div>
          )}

          {loginErr && <div className="alert-box">{loginErr}</div>}
        </div>
      )}

      {ttsStatus && (
        <div className="ok-box" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
          {ttsStatus}
        </div>
      )}
      {chatErr && <div className="alert-box">{chatErr}</div>}

      {/* Messages */}
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Icon name="spark" size={20} style={{ color: "var(--mint)" }} />
            <span>
              {hasCred
                ? "Habla, escribe, comparte tu pantalla (👁) o adjunta documentos."
                : "Selecciona tu proveedor arriba y conecta para empezar."}
            </span>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat-bubble is-${m.role}`}>
              {m.attachments && m.attachments.length > 0 && (
                <div className="chat-atts">
                  {m.attachments.map((att) =>
                    att.kind === "image" && att.dataUrl ? (
                      <img key={att.id} src={att.dataUrl} alt={att.name} className="chat-thumb" />
                    ) : (
                      <span key={att.id} className="chat-att-tag">
                        {att.name}
                      </span>
                    ),
                  )}
                </div>
              )}
              {m.reasoning && (
                <details className="chat-reason">
                  <summary>Razonamiento</summary>
                  <div>{m.reasoning}</div>
                </details>
              )}
              <div className="chat-text">{m.text || (streaming ? "…" : "")}</div>
              {m.role === "assistant" && m.text && (
                <div className="chat-msg-actions">
                  <button
                    type="button"
                    className="btn-xs"
                    title="Escuchar respuesta"
                    onClick={() =>
                      void speakReply({
                        text: m.text,
                        mode: ai.ttsMode === "off" ? "kokoro" : ai.ttsMode,
                        voice: ai.ttsVoice,
                        onStatus: setTtsStatus,
                      })
                    }
                  >
                    <Icon name="audio" size={11} />
                  </button>
                  <button
                    type="button"
                    className="btn-xs"
                    title="Copiar respuesta"
                    onClick={() => void navigator.clipboard.writeText(m.text)}
                  >
                    <Icon name="copy" size={11} />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Pending attachments */}
      {attachments.length > 0 && (
        <div className="chat-pending-atts">
          {attachments.map((att) => (
            <span key={att.id} className="chat-att-tag">
              {att.name}
              <button
                type="button"
                className="note-del"
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="chat-composer">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.csv,.js,.ts,.tsx,.py,.html,.css,.xml"
          style={{ display: "none" }}
          onChange={(e) => void handleFilesSelected(e.target.files)}
        />
        <button
          type="button"
          className="icon-btn"
          title="Ver pantalla actual (captura la pestaña)"
          onClick={() => void handleCaptureScreen()}
        >
          <Icon name="eye" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Adjuntar imagen o documento"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="clip" size={14} />
        </button>
        <button
          type="button"
          className={`icon-btn ${voiceListening ? "is-listening-btn" : ""}`}
          title={voiceListening ? "Detener voz y enviar" : "Hablar con RECO IA"}
          onClick={toggleVoiceChat}
        >
          <Icon name={voiceListening ? "stop" : "mic"} size={14} />
        </button>
        <input
          className="chat-input"
          placeholder={voiceListening ? "Escuchando…" : "Pregunta a RECO…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        {streaming ? (
          <button
            type="button"
            className="icon-btn is-stop-btn"
            title="Detener respuesta"
            onClick={() => {
              chatAbortRef.current?.abort();
              stopSpeaking();
            }}
          >
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn is-send-btn"
            title="Enviar"
            onClick={() => void handleSend()}
          >
            <Icon name="send" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
