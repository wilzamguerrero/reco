/**
 * Cerebro agéntico de RECO:
 *  - Conoce todas las herramientas del entorno de RECO (grabar pantalla, pausar,
 *    pizarra de dibujo, dictado, cambiar motor de voz/TTS/modelo, abrir chat/panel).
 *  - Detecta automáticamente cuándo el usuario pide "mirar" la pantalla y captura
 *    la pestaña activa sin necesidad de abrir ninguna ventana.
 *  - Ejecuta las etiquetas `[[ACTION:...]]` emitidas por el modelo y devuelve texto
 *    limpio listo para leer o sintetizar en voz natural.
 */

import {
  AI_PROVIDERS,
  fetchProviderModels,
  streamProviderChat,
  type ChatMessagePart,
  type FreePiChatMessage,
  type FreePiModel,
} from "./freepiClient";
import { clearChatMessages, getChatMessages, getConfig, patchConfig, saveChatMessages } from "./storage";
import type {
  AiProviderId,
  AppConfig,
  ExtMessage,
  PageActionPayload,
  PersistedChatAttachment,
  PersistedChatMessage,
  SpeechEngineType,
  TtsEngineMode,
} from "./types";

const VISION_INTENT_RE =
  /\b(mira|míra|mirar|observa|ver|ves|veo|viendo|puedes ver|qué ves|que ves|qué hay|que hay|revisa|pantalla|página|pagina|estoy haciendo|hago|estoy viendo|dibuj\w*|trazo|trazos|pizarra|bosquejo|esquema|analiza esto|mira esto|captura|imagen|foto|aquí|aqui|esto que)\b/i;

const PAGE_INTERACT_INTENT_RE =
  /\b(abre|abrir|abrí|abri|clic|click|pulsa|pulsar|presiona|presionar|toca|tocar|dale|selecciona|elige|escribe|escribir|redacta|redactar|pon|ponle|llena|rellena|borra|busca|buscar|envia|envía|enviar|manda|mandar|responde|responder|baja|sube|scroll|desplaza|entra|ve a|ir a|navega|pestaña|correo|correos|email|mail|mensaje|botón|boton|campo|enlace|link|formulario|asunto|destinatario)\b/i;

const catalogCache = new Map<string, { at: number; models: FreePiModel[] }>();

async function resolveVisionModel(
  provider: AiProviderId,
  key: string,
  customBaseUrl: string | undefined,
  currentModel: string,
): Promise<string> {
  if (/gpt-4o|gpt-4\.1|claude-3|claude-sonnet|claude-opus|gemini|vision|vl|pixtral|llama-3\.2-.*vision|qwen.*vl/i.test(currentModel)) {
    return currentModel;
  }

  const cacheKey = `${provider}:${customBaseUrl ?? ""}`;
  let models: FreePiModel[] = [];
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    models = cached.models;
  } else {
    models = await fetchProviderModels({ provider, key, customBaseUrl }).catch(() => []);
    if (models.length > 0) {
      catalogCache.set(cacheKey, { at: Date.now(), models });
    }
  }

  const activeEntry = models.find((m) => m.id === currentModel);
  if (activeEntry?.vision) return currentModel;

  const visionFree = models.find((m) => m.vision && m.free);
  if (visionFree) return visionFree.id;
  const visionAny = models.find((m) => m.vision);
  if (visionAny) return visionAny.id;

  return currentModel;
}

export function buildRecoSystemPrompt(cfg: AppConfig): string {
  return (
    "Eres RECO, un asistente de voz e interfaz inteligente integrado en el navegador del usuario. " +
    "Habla en el mismo idioma del usuario (español por defecto), de forma fluida, amena, concisa y natural para ser escuchada en voz alta (sin listas largas ni markdown pesado salvo que te pidan código).\n\n" +
    `Estado actual del entorno RECO:\n` +
    `- Proveedor IA: ${cfg.ai.provider} · Modelo: ${cfg.ai.models?.[cfg.ai.provider] || cfg.ai.model || "por defecto"}\n` +
    `- Motor de dictado: ${cfg.dictation.engine} · Voz TTS: ${cfg.ai.ttsMode}\n\n` +
    "Puedes controlar directamente las herramientas de RECO incluyendo al final de tu respuesta una o más etiquetas exactas (no las leas ni las expliques, el sistema las ejecuta automáticamente):\n" +
    "- [[ACTION:START_RECORDING]] -> iniciar grabación de pantalla\n" +
    "- [[ACTION:STOP_RECORDING]] -> detener grabación de pantalla\n" +
    "- [[ACTION:PAUSE_RECORDING]] -> pausar o reanudar grabación\n" +
    "- [[ACTION:OPEN_DRAW]] -> abrir pizarra de dibujo sobre la página\n" +
    "- [[ACTION:CLOSE_DRAW]] -> cerrar pizarra de dibujo\n" +
    "- [[ACTION:START_DICTATION]] -> activar dictado normal en el cursor\n" +
    "- [[ACTION:SET_SPEECH_ENGINE|chrome]] o wispr o wispr_web o whisper_tiny o whisper_base -> cambiar motor de dictado (wispr_web es la demo gratuita sin clave)\n" +
    "- [[ACTION:SET_TTS|supertonic]] o pocket o pocket-web o piper o kokoro o moss o system o off -> cambiar voz de respuesta\n" +
    "- [[ACTION:SET_AI_MODEL|<id_modelo>]] -> cambiar modelo de IA\n" +
    "- [[ACTION:NEW_CHAT]] -> limpiar el historial y empezar una conversación nueva con contexto vacío (úsalo cuando pidan nuevo chat, nueva conversación, borrar contexto o empezar de cero; NO abras la ventana de chat ni el panel al hacer esto)\n" +
    "- [[ACTION:OPEN_CHAT]] -> abrir ventana de chat flotante (solo si piden explícitamente ver o abrir la ventana; NO la uses para crear un nuevo chat)\n" +
    "- [[ACTION:OPEN_PANEL]] -> abrir panel lateral de configuración\n" +
    "- [[ACTION:PAGE_CLICK|<id_o_texto>]] -> hacer clic en un botón, enlace o correo de la página activa (usa el #id de la lista de elementos visibles, o su texto)\n" +
    "- [[ACTION:PAGE_TYPE|<id_o_active>|<texto>]] -> escribir texto en un campo o editor de la página (usa el #id del campo o `active` para el campo con foco)\n" +
    "- [[ACTION:PAGE_PRESS|<Enter|Escape|Tab>]] -> pulsar una tecla en el elemento activo\n" +
    "- [[ACTION:PAGE_SCROLL|<down|up|top|bottom>]] -> desplazar la página\n" +
    "- [[ACTION:PAGE_NAVIGATE|<url>]] -> abrir una URL en la pestaña actual\n" +
    "- [[ACTION:PAGE_OPEN_TAB|<url>]] -> abrir una URL en una pestaña nueva\n" +
    "SÍ tienes visión y SÍ puedes interactuar directamente con la página web activa (hacer clic, abrir correos o enlaces, escribir en campos, buscar, hacer scroll y navegar). " +
    "Cuando el usuario te pida ver o hacer algo en la página, recibirás la lista numerada de elementos visibles (y captura de pantalla cuando aplique). " +
    "Puedes encadenar varias acciones si los campos ya están visibles; si primero necesitas abrir un formulario (por ejemplo pulsar 'Redactar' o 'Correo nuevo'), haz clic primero y avisa que ya quedó abierto. " +
    "Por seguridad, nunca pulses botones de Enviar, Eliminar o Pagar a menos que el usuario te lo pida explícitamente."
  );
}

export function stripActionTags(raw: string): string {
  return raw.replace(/\[\[ACTION:[^\]]+\]\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export async function executeActionTags(raw: string): Promise<string[]> {
  const executed: string[] = [];
  const matches = Array.from(raw.matchAll(/\[\[ACTION:([A-Z_]+)(?:\|([^\]]+))?\]\]/g));
  let hadPageAction = false;

  const runPageAction = async (action: PageActionPayload, label: string) => {
    if (hadPageAction) {
      await new Promise((r) => setTimeout(r, 220));
    }
    hadPageAction = true;
    await chrome.runtime
      .sendMessage({ type: "EXECUTE_PAGE_ACTION", action } satisfies ExtMessage)
      .catch(() => {});
    executed.push(label);
  };

  for (const m of matches) {
    const cmd = m[1];
    const arg = (m[2] ?? "").trim();

    if (cmd === "PAGE_CLICK" && arg) {
      await runPageAction({ kind: "click", target: arg }, `clic: ${arg}`);
    } else if (cmd === "PAGE_TYPE" && arg) {
      const sep = arg.indexOf("|");
      const target = sep >= 0 ? arg.slice(0, sep).trim() : "active";
      const text = sep >= 0 ? arg.slice(sep + 1) : arg;
      if (text) {
        await runPageAction({ kind: "type", target: target || "active", text }, `escribir: ${target || "active"}`);
      }
    } else if (cmd === "PAGE_PRESS" && arg) {
      await runPageAction({ kind: "press", key: arg }, `tecla: ${arg}`);
    } else if (cmd === "PAGE_SCROLL" && (arg === "up" || arg === "down" || arg === "top" || arg === "bottom")) {
      await runPageAction({ kind: "scroll", direction: arg }, `scroll: ${arg}`);
    } else if (cmd === "PAGE_NAVIGATE" && arg) {
      await runPageAction({ kind: "navigate", url: arg, newTab: false }, `ir a: ${arg}`);
    } else if (cmd === "PAGE_OPEN_TAB" && arg) {
      await runPageAction({ kind: "navigate", url: arg, newTab: true }, `nueva pestaña: ${arg}`);
    } else if (cmd === "START_RECORDING") {
      await chrome.runtime.sendMessage({ type: "RECORDING_START" } satisfies ExtMessage).catch(() => {});
      executed.push("grabación iniciada");
    } else if (cmd === "STOP_RECORDING") {
      await chrome.runtime.sendMessage({ type: "RECORDING_STOP" } satisfies ExtMessage).catch(() => {});
      executed.push("grabación detenida");
    } else if (cmd === "PAUSE_RECORDING") {
      await chrome.runtime.sendMessage({ type: "RECORDING_PAUSE_TOGGLE" } satisfies ExtMessage).catch(() => {});
      executed.push("pausa alternada");
    } else if (cmd === "OPEN_DRAW") {
      await chrome.runtime.sendMessage({ type: "DRAW_CONTROL", action: "open" } satisfies ExtMessage).catch(() => {});
      executed.push("pizarra abierta");
    } else if (cmd === "CLOSE_DRAW") {
      await chrome.runtime.sendMessage({ type: "DRAW_CONTROL", action: "close" } satisfies ExtMessage).catch(() => {});
      executed.push("pizarra cerrada");
    } else if (cmd === "START_DICTATION") {
      await chrome.runtime.sendMessage({ type: "DICTATION_START" } satisfies ExtMessage).catch(() => {});
      executed.push("dictado activado");
    } else if (cmd === "NEW_CHAT" || cmd === "CLEAR_CHAT" || cmd === "RESET_CHAT") {
      await clearChatMessages();
      executed.push("nuevo chat");
    } else if (cmd === "OPEN_CHAT") {
      await chrome.runtime.sendMessage({ type: "OPEN_FLOATING_CHAT", autoVoice: false } satisfies ExtMessage).catch(() => {});
      executed.push("chat abierto");
    } else if (cmd === "OPEN_PANEL") {
      await chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL" } satisfies ExtMessage).catch(() => {});
      executed.push("panel abierto");
    } else if (cmd === "SET_SPEECH_ENGINE" && (arg === "wispr" || arg === "wispr_web" || arg === "chrome" || arg === "whisper_tiny" || arg === "whisper_base")) {
      const cfg = await getConfig();
      const next = await patchConfig({ dictation: { ...cfg.dictation, engine: arg as SpeechEngineType } });
      await chrome.runtime.sendMessage({ type: "CONFIG_UPDATED", config: next } satisfies ExtMessage).catch(() => {});
      executed.push(`dictado: ${arg}`);
    } else if (
      cmd === "SET_TTS" &&
      (arg === "supertonic" ||
        arg === "pocket" ||
        arg === "pocket-web" ||
        arg === "kokoro" ||
        arg === "piper" ||
        arg === "moss" ||
        arg === "system" ||
        arg === "off")
    ) {
      const cfg = await getConfig();
      const next = await patchConfig({ ai: { ...cfg.ai, ttsMode: arg as TtsEngineMode } });
      await chrome.runtime.sendMessage({ type: "CONFIG_UPDATED", config: next } satisfies ExtMessage).catch(() => {});
      executed.push(`voz: ${arg}`);
    } else if (cmd === "SET_AI_MODEL" && arg) {
      const cfg = await getConfig();
      const next = await patchConfig({
        ai: {
          ...cfg.ai,
          model: arg,
          models: { ...(cfg.ai.models ?? {}), [cfg.ai.provider]: arg },
        },
      });
      await chrome.runtime.sendMessage({ type: "CONFIG_UPDATED", config: next } satisfies ExtMessage).catch(() => {});
      executed.push(`modelo: ${arg}`);
    }
  }

  return executed;
}

export async function runRecoAgentTurn(opts: {
  userText: string;
  attachments?: PersistedChatAttachment[];
  signal?: AbortSignal;
  onDelta?: (cleanSoFar: string) => void;
  onReasoning?: (reasoningSoFar: string) => void;
}): Promise<{ text: string; reasoning: string; actions: string[] }> {
  const cfg = await getConfig();
  const provider = cfg.ai.provider || "freepi";
  const meta = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const key = provider === "freepi" ? cfg.ai.freepiToken : cfg.ai.keys?.[provider] ?? "";
  const model = cfg.ai.models?.[provider] || cfg.ai.model || meta.defaultModel;

  if (provider !== "custom" && !key.trim()) {
    throw new Error("Conecta un proveedor de IA en el panel lateral (pestaña IA).");
  }

  const atts: PersistedChatAttachment[] = [...(opts.attachments ?? [])];
  const wantsVision = VISION_INTENT_RE.test(opts.userText);
  const wantsPageInteract = PAGE_INTERACT_INTENT_RE.test(opts.userText);

  // Auto-vision: if user asks RECO to look at screen and no image is attached, capture automatically!
  if (atts.every((a) => a.kind !== "image") && wantsVision) {
    const cap = (await chrome.runtime
      .sendMessage({ type: "CAPTURE_TAB_SCREEN" } satisfies ExtMessage)
      .catch(() => null)) as { ok?: boolean; dataUrl?: string; title?: string } | null;
    if (cap?.ok && cap.dataUrl) {
      atts.push({
        id: `auto-scr-${Date.now()}`,
        kind: "image",
        name: cap.title ? `Pantalla · ${cap.title.slice(0, 16)}` : "Pantalla",
        dataUrl: cap.dataUrl,
      });
    }
  }

  // DOM snapshot of visible interactive elements so RECO can click/type/open on the active page
  let pageContextNote = "";
  if (wantsPageInteract || wantsVision) {
    const snap = (await chrome.runtime
      .sendMessage({ type: "GET_PAGE_SNAPSHOT" } satisfies ExtMessage)
      .catch(() => null)) as { ok?: boolean; summary?: string } | null;
    if (snap?.ok && snap.summary) {
      pageContextNote = snap.summary;
    }
  }

  const prevHistory = await getChatMessages();
  const userMsg: PersistedChatMessage = {
    id: `u-${Date.now()}`,
    role: "user",
    text: opts.userText.trim() || "Analiza lo adjunto.",
    attachments: atts.length > 0 ? atts : undefined,
    createdAt: Date.now(),
  };
  const assistantId = `a-${Date.now() + 1}`;
  const workingHistory: PersistedChatMessage[] = [
    ...prevHistory,
    userMsg,
    { id: assistantId, role: "assistant", text: "", reasoning: "", createdAt: Date.now() },
  ];
  opts.signal?.throwIfAborted();
  await saveChatMessages(workingHistory);

  const wireMessages: FreePiChatMessage[] = [
    { role: "system", content: buildRecoSystemPrompt(cfg) },
  ];

  const turnSlice = workingHistory.slice(-13, -1);
  for (let idx = 0; idx < turnSlice.length; idx += 1) {
    const m = turnSlice[idx];
    if (m.role === "assistant") {
      wireMessages.push({ role: "assistant", content: m.text });
      continue;
    }
    const isCurrentTurn = idx === turnSlice.length - 1;
    const docs = (m.attachments ?? []).filter((a) => a.kind === "doc" && a.textContent);
    const imgs = (m.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
    const docPrefix = docs.map((d) => `[Documento: ${d.name}]\n${d.textContent}`).join("\n\n");
    const pagePrefix = isCurrentTurn && pageContextNote ? `${pageContextNote}\n\n` : "";
    const combinedText = `${pagePrefix}${docPrefix ? `${docPrefix}\n\n` : ""}${m.text}`;

    if (imgs.length > 0) {
      const parts: ChatMessagePart[] = [{ type: "text", text: combinedText }];
      for (const img of imgs) {
        parts.push({ type: "image_url", image_url: { url: img.dataUrl! } });
      }
      wireMessages.push({ role: "user", content: parts });
    } else {
      wireMessages.push({ role: "user", content: combinedText });
    }
  }

  let rawText = "";
  let reasoningText = "";

  const hasImageInTurn = atts.some((a) => a.kind === "image" && a.dataUrl);
  const effectiveModel = hasImageInTurn
    ? await resolveVisionModel(provider, key, cfg.ai.customBaseUrl, model)
    : model;

  const result = await streamProviderChat({
    provider,
    key,
    customBaseUrl: cfg.ai.customBaseUrl,
    model: effectiveModel,
    messages: wireMessages,
    signal: opts.signal,
    onDelta(chunk) {
      rawText += chunk;
      opts.onDelta?.(stripActionTags(rawText));
    },
    onReasoning(chunk) {
      reasoningText += chunk;
      opts.onReasoning?.(reasoningText);
    },
  });

  const finalRaw = result.text || rawText;
  const cleanText = stripActionTags(finalRaw);
  opts.signal?.throwIfAborted();
  const actions = await executeActionTags(finalRaw);

  if (!actions.includes("nuevo chat")) {
    const updated = workingHistory.map((m) =>
      m.id === assistantId ? { ...m, text: cleanText, reasoning: result.reasoning || reasoningText } : m,
    );
    opts.signal?.throwIfAborted();
    await saveChatMessages(updated);
  }

  return { text: cleanText, reasoning: result.reasoning || reasoningText, actions };
}
