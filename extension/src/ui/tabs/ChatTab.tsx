import { useEffect, useRef, useState } from "react";
import { runRecoAgentTurn } from "../../shared/aiAgent";
import {
  AI_PROVIDERS,
  ensureFreePiAd,
  fetchProviderModels,
  type FreePiModel,
} from "../../shared/freepiClient";
import { isPlaybackEcho, speakReply, stopSpeaking, updateSpeakingVoice } from "../../shared/kokoroTts";
import { createWisprEngine } from "../../shared/wisprEngine";
import { createSpeechEngine, type SpeechEngineHandle } from "../../shared/speechEngine";
import { clearChatMessages, getChatMessages } from "../../shared/storage";
import type {
  AiProviderId,
  AppConfig,
  ExtMessage,
  PersistedChatAttachment,
  PersistedChatMessage,
} from "../../shared/types";
import { Icon } from "../components/Icon";

/**
 * Ventana flotante ultra-minimalista de Chat IA.
 * Toda la configuración de proveedores, claves y voces vive en la pestaña IA del panel global;
 * aquí solo tienes selector rápido de modelo, audio ON/OFF, adjuntar/ver pantalla y chat.
 */
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
  const currentAi = useRef(ai);
  currentAi.current = ai;
  useEffect(() => {
    updateSpeakingVoice(ai);
    setTtsStatus(null);
  }, [ai.ttsMode, ai.ttsVoice, ai.ttsSpeed, ai.pocketWebLanguage]);
  const provider: AiProviderId = ai.provider || "freepi";
  const providerMeta = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const activeKey = provider === "freepi" ? ai.freepiToken : ai.keys?.[provider] ?? "";
  const activeModel = ai.models?.[provider] || ai.model || providerMeta.defaultModel;
  const hasCred =
    provider === "custom" ? Boolean(ai.customBaseUrl?.trim()) : Boolean(activeKey.trim());

  const [models, setModels] = useState<FreePiModel[]>([]);
  const [messages, setMessages] = useState<PersistedChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PersistedChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [liveReply, setLiveReply] = useState("");
  const [chatErr, setChatErr] = useState("");
  const [ttsStatus, setTtsStatus] = useState<string | null>(null);
  const [voiceListening, setVoiceListening] = useState(false);

  const chatAbortRef = useRef<AbortController | null>(null);
  const voiceEngineRef = useRef<SpeechEngineHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendCurrent = useRef(handleSend);
  sendCurrent.current = handleSend;
  const pendingVoice = useRef("");
  const voiceTimer = useRef<number | undefined>(undefined);
  const autoStartedRef = useRef(false);

  // Sync persisted chat history (shared with hands-free voice mode!)
  useEffect(() => {
    void getChatMessages().then(setMessages);
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.reco_ext_chat_messages_v1) {
        void getChatMessages().then(setMessages);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  // Load quick model selector + silent free-pi ads
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
    }

    if (hasCred || provider === "openrouter" || provider === "freepi") {
      void fetchProviderModels({
        provider,
        key: activeKey,
        customBaseUrl: ai.customBaseUrl,
      }).then((list) => {
        if (!cancelled) setModels(list);
      });
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
  }, [messages, liveReply, streaming]);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      const engine = voiceEngineRef.current;
      voiceEngineRef.current = null;
      clearTimeout(voiceTimer.current);
      engine?.stop();
      stopSpeaking();
    };
  }, []);

  async function handleCaptureScreen() {
    setChatErr("");
    const res = (await send({ type: "CAPTURE_TAB_SCREEN" })) as
      | { ok?: boolean; dataUrl?: string; title?: string; error?: string }
      | undefined;
    if (!res?.ok || !res.dataUrl) {
      setChatErr(res?.error || "No se pudo capturar la pantalla.");
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
    const added: PersistedChatAttachment[] = [];
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
    if ((!text && attachments.length === 0) || (streaming && !overrideText) || !hasCred) return;

    clearTimeout(voiceTimer.current);
    pendingVoice.current = "";
    chatAbortRef.current?.abort();
    const currentAttachments = [...attachments];
    setInput("");
    setAttachments([]);
    setChatErr("");
    setLiveReply("");
    stopSpeaking();
    setStreaming(true);

    const ctrl = new AbortController();
    chatAbortRef.current = ctrl;

    try {
      const result = await runRecoAgentTurn({
        userText: text,
        attachments: currentAttachments,
        signal: ctrl.signal,
        onDelta(cleanSoFar) {
          if (!ctrl.signal.aborted) setLiveReply(cleanSoFar);
        },
      });
      if (ctrl.signal.aborted) return;
      setLiveReply("");
      setStreaming(false);
      const ai = currentAi.current;
      if (result.text && ai.ttsMode !== "off") {
        await speakReply({
          text: result.text,
          mode: ai.ttsMode,
          voice: ai.ttsVoice,
          pocketWebLanguage: ai.pocketWebLanguage,
          speed: ai.ttsSpeed,
          onStatus: setTtsStatus,
        });
      }
    } catch (err) {
      if (!ctrl.signal.aborted && !(err instanceof DOMException && err.name === "AbortError")) {
        setChatErr(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (chatAbortRef.current === ctrl) {
        chatAbortRef.current = null;
        setStreaming(false);
        setLiveReply("");
      }
    }
  }

  function toggleVoiceChat() {
    if (voiceEngineRef.current) {
      voiceEngineRef.current.stop();
      return;
    }
    stopSpeaking();
    setChatErr("");
    pendingVoice.current = "";
    function sendPhrase() {
      clearTimeout(voiceTimer.current);
      const phrase = pendingVoice.current.trim();
      pendingVoice.current = "";
      if (phrase) void sendCurrent.current(phrase);
    }
    function interrupt() {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
      stopSpeaking();
      setStreaming(false);
      setLiveReply("");
      setTtsStatus(null);
    }
    let loudSince = 0;
    const makeEngine = config.dictation.engine === "wispr" ? createWisprEngine : createSpeechEngine;
    const eng = makeEngine({
      language: config.dictation.language,
      polish: config.dictation.polish,
      onLevel(level) {
        if (voiceEngineRef.current !== eng || !chatAbortRef.current || level < 0.05) {
          loudSince = 0;
          return;
        }
        const now = performance.now();
        if (!loudSince) loudSince = now;
        else if (now - loudSince >= 140) interrupt();
      },
      onInterim(t) {
        if (voiceEngineRef.current !== eng || !t.trim() || isPlaybackEcho(t)) return;
        clearTimeout(voiceTimer.current);
        interrupt();
        setInput([pendingVoice.current, t].filter(Boolean).join(" "));
      },
      onFinal(t) {
        if (voiceEngineRef.current !== eng || !t.trim() || isPlaybackEcho(t)) return;
        interrupt();
        pendingVoice.current = [pendingVoice.current, t].filter(Boolean).join(" ");
        setInput(pendingVoice.current);
        clearTimeout(voiceTimer.current);
        voiceTimer.current = window.setTimeout(sendPhrase, 550);
      },
      onError(msg, fatal) {
        if (voiceEngineRef.current !== eng || !fatal) return;
        clearTimeout(voiceTimer.current);
        pendingVoice.current = "";
        setChatErr(msg);
      },
      onStop() {
        if (voiceEngineRef.current !== eng) return;
        voiceEngineRef.current = null;
        setVoiceListening(false);
        sendPhrase();
      },
    });
    voiceEngineRef.current = eng;
    setVoiceListening(true);
    void eng.start().catch((err) => {
      if (voiceEngineRef.current !== eng) return;
      voiceEngineRef.current = null;
      setVoiceListening(false);
      setChatErr(err instanceof Error ? err.message : String(err));
    });
  }

  return (
    <div className="pane">
      {/* Ultra-minimal top bar: quick model picker + audio mute + clear + open global panel */}
      <div className="chat-toolbar">
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
          title={`Modelo rápido (${providerMeta.label})`}
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
          title={ai.ttsMode === "off" ? "Activar voz de respuesta" : "Silenciar voz"}
          onClick={() => {
            stopSpeaking();
            void updateConfig({
              ai: { ...ai, ttsMode: ai.ttsMode === "off" ? "piper" : "off" },
            });
          }}
        >
          <Icon name="audio" size={12} />
        </button>

        {messages.length > 0 && (
          <button
            type="button"
            className="btn-xs"
            title="Limpiar conversación"
            onClick={() => {
              stopSpeaking();
              void clearChatMessages();
            }}
          >
            <Icon name="trash" size={11} />
          </button>
        )}

        <button
          type="button"
          className="btn-xs"
          title="Configurar proveedor, claves y voces en el panel global"
          onClick={() => void send({ type: "OPEN_SIDEPANEL" })}
        >
          <Icon name="panel" size={11} />
        </button>
      </div>

      {!hasCred && (
        <button
          type="button"
          className="action-primary action-cyan"
          style={{ padding: "8px 10px" }}
          onClick={() => void send({ type: "OPEN_SIDEPANEL" })}
        >
          <Icon name="spark" size={14} />
          <span>Conectar proveedor IA en el panel →</span>
        </button>
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
            <Icon name="spark" size={20} style={{ color: "var(--violet)" }} />
            <span>
              Puedes hablarle sin abrir esta ventana (`Alt+Shift+A`) o escribir, adjuntar y compartir
              pantalla aquí.
            </span>
          </div>
        ) : (
          messages.map((m, idx) => {
            const isLastStreaming = streaming && idx === messages.length - 1 && m.role === "assistant";
            const shownText = isLastStreaming ? liveReply || "…" : m.text;
            return (
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
                <div className="chat-text">{shownText}</div>
                {m.role === "assistant" && shownText && !isLastStreaming && (
                  <div className="chat-msg-actions">
                    <button
                      type="button"
                      className="btn-xs"
                      title="Escuchar respuesta"
                      onClick={() =>
                        void speakReply({
                          text: shownText,
                          mode: ai.ttsMode === "off" ? "piper" : ai.ttsMode,
                          voice: ai.ttsVoice,
                          pocketWebLanguage: ai.pocketWebLanguage,
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
                      onClick={() => void navigator.clipboard.writeText(shownText)}
                    >
                      <Icon name="copy" size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

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
          title="Ver pantalla actual"
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
          title={voiceListening ? "Terminar conversaci?n por voz" : "Conversar por voz"}
          onClick={toggleVoiceChat}
        >
          <Icon name={voiceListening ? "stop" : "mic"} size={14} />
        </button>
        <input
          className="chat-input"
          placeholder={voiceListening ? "Escuchando…" : "Escribe a RECO…"}
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
            title="Detener"
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
