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
import {
  clearChatMessages,
  getChatMessages,
  getChatSummary,
  getConfig,
  patchConfig,
  rotateFreePiSessionId,
  saveChatMessages,
  saveChatSummary,
} from "./storage";
import type {
  AiProviderId,
  AppConfig,
  BrowserActionPayload,
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
  /\b(abr\w*|clic\w*|click\w*|puls\w*|presion\w*|toc\w*|dale|seleccion\w*|elig\w*|escrib\w*|redact\w*|edit\w*|modific\w*|reemplaz\w*|pon\w*|llen\w*|rellen\w*|borr\w*|peg\w*|aplic\w*|hazlo|haz|hagas|busc\w*|encuentr\w*|envi\w*|enví\w*|mand\w*|respond\w*|baj\w*|sub\w*|scroll|desplaz\w*|entr\w*|ve a|ir a|naveg\w*|pestañ\w*|tab|tabs|cambi\w*|pásat\w*|pasat\w*|salt\w*|regres\w*|vuelv\w*|cierr\w*|duplic\w*|fij\w*|silenci\w*|mute\w*|marcador\w*|favorit\w*|historial|google|correo\w*|email|mail|mensaje\w*|botón|boton\w*|campo\w*|editor|texto|párrafo|parrafo|documento|enlace\w*|link\w*|formulario|asunto|destinatario|resalt\w*|señal\w*|senal\w*|marc\w*|subray\w*|encuadr\w*|recuadro\w*|apunt\w*|indic\w*|muestr\w*|dónde está|donde esta|dónde dice|donde dice|copi\w*|atrás|atras|adelante|recarg\w*|refresc\w*|quit\w*|limpi\w*)/i;

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
    "- [[ACTION:PAGE_CLICK|<id_o_texto>]] -> hacer clic en un botón, interruptor, muestra de color, enlace, imagen o correo de la página activa (usa preferiblemente el #id exacto de la lista)\n" +
    "- [[ACTION:PAGE_CLICK_XY|<x_pct>|<y_pct>]] -> hacer clic exacto por coordenadas porcentuales (0-100) del viewport cuando un control visual no esté en la lista\n" +
    "- [[ACTION:PAGE_TYPE|<id_o_active>|<texto>]] -> escribir/añadir texto en un campo o editor de la página (usa el #id del campo/editor o `active`)\n" +
    "- [[ACTION:PAGE_REPLACE|<id_o_active>|<texto>]] -> reemplazar todo el contenido de un campo o editor por el nuevo texto (ideal para editar/parafrasear)\n" +
    "- [[ACTION:PAGE_PRESS|<Enter|Escape|Tab>]] -> pulsar una tecla en el elemento activo\n" +
    "- [[ACTION:PAGE_HIGHLIGHT|<id_o_texto>|<etiqueta_opcional>]] -> señalar/resaltar con un recuadro brillante cualquier imagen, botón, enlace o sección de la página (puedes resaltar varios a la vez)\n" +
    "- [[ACTION:PAGE_CLEAR_HIGHLIGHTS]] -> quitar los recuadros de resaltado de la página\n" +
    "- [[ACTION:PAGE_FIND|<texto>]] -> buscar un texto en la página, desplazarse hasta él y encerrarlo en un recuadro\n" +
    "- [[ACTION:PAGE_SCROLL|<down|up|top|bottom>]] -> desplazar la página\n" +
    "- [[ACTION:PAGE_SCROLL_TO|<id_o_texto>]] -> desplazar la vista directamente hasta un elemento o sección\n" +
    "- [[ACTION:PAGE_COPY|<texto>]] -> copiar un texto o enlace al portapapeles del usuario\n" +
    "- [[ACTION:PAGE_BACK]] / [[ACTION:PAGE_FORWARD]] / [[ACTION:PAGE_RELOAD]] -> volver atrás, ir adelante o recargar la pestaña\n" +
    "- [[ACTION:PAGE_NAVIGATE|<url>]] -> abrir una URL en la pestaña actual\n" +
    "- [[ACTION:PAGE_OPEN_TAB|<url>]] -> abrir una URL en una pestaña nueva\n" +
    "- [[ACTION:TAB_SWITCH|<tabId_o_nombre>]] -> cambiar/saltar a otra pestaña abierta del navegador (usa el tabId de la lista de pestañas abiertas o su nombre)\n" +
    "- [[ACTION:TAB_CLOSE|<tabId_o_nombre_o_current>]] -> cerrar una pestaña abierta (o `current` para la actual)\n" +
    "- [[ACTION:TAB_NEW|<url_o_consulta_opcional>]] -> abrir una pestaña nueva (vacía, con URL o con búsqueda)\n" +
    "- [[ACTION:TAB_DUPLICATE]] -> duplicar la pestaña actual\n" +
    "- [[ACTION:TAB_PIN]] -> fijar o desfijar la pestaña actual\n" +
    "- [[ACTION:TAB_MUTE|<tabId_o_current>]] -> silenciar o activar el audio de una pestaña\n" +
    "- [[ACTION:BROWSER_SEARCH|<consulta>]] -> buscar en Google en una pestaña nueva\n" +
    "- [[ACTION:BROWSER_BOOKMARK]] -> guardar la página actual en marcadores/favoritos\n" +
    "- [[ACTION:BROWSER_HISTORY|<consulta>]] -> buscar y abrir una página del historial del navegador\n" +
    "SÍ tienes visión y SÍ tienes control completo del navegador y de la página activa: puedes cambiar entre pestañas abiertas (`TAB_SWITCH`), cerrar/abrir/fijar/silenciar/duplicar pestañas, buscar en Google, guardar marcadores, abrir del historial, encerrar imágenes o textos en un recuadro brillante (`PAGE_HIGHLIGHT` / `PAGE_FIND`), hacer clic, abrir correos o enlaces, escribir en campos, copiar al portapapeles, hacer scroll y navegar. " +
    "Cuando el usuario te pida ver, cambiar de pestaña, señalar o hacer algo, recibirás la lista de pestañas abiertas del navegador, los elementos visibles de la página activa (incluidas imágenes y títulos) y captura de pantalla cuando aplique. " +
    "Puedes encadenar varias acciones si los elementos ya están visibles; si primero necesitas abrir un formulario (por ejemplo pulsar 'Redactar' o 'Correo nuevo'), haz clic primero y avisa que ya quedó abierto. " +
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
      await new Promise((r) => setTimeout(r, 120));
    }
    hadPageAction = true;
    await chrome.runtime
      .sendMessage({ type: "EXECUTE_PAGE_ACTION", action } satisfies ExtMessage)
      .catch(() => {});
    executed.push(label);
  };

  const runBrowserAction = async (action: BrowserActionPayload, label: string) => {
    if (hadPageAction) {
      await new Promise((r) => setTimeout(r, 120));
    }
    hadPageAction = true;
    await chrome.runtime
      .sendMessage({ type: "EXECUTE_BROWSER_ACTION", action } satisfies ExtMessage)
      .catch(() => {});
    executed.push(label);
  };

  for (const m of matches) {
    const cmd = m[1];
    const arg = (m[2] ?? "").trim();

    if (cmd === "TAB_SWITCH" && arg) {
      await runBrowserAction({ kind: "switch_tab", target: arg }, `pestaña: ${arg}`);
    } else if (cmd === "TAB_CLOSE") {
      await runBrowserAction({ kind: "close_tab", target: arg || "current" }, "pestaña cerrada");
    } else if (cmd === "TAB_NEW") {
      await runBrowserAction({ kind: "new_tab", urlOrQuery: arg || undefined }, "nueva pestaña");
    } else if (cmd === "TAB_DUPLICATE") {
      await runBrowserAction({ kind: "duplicate_tab" }, "pestaña duplicada");
    } else if (cmd === "TAB_PIN") {
      await runBrowserAction({ kind: "pin_tab" }, "pestaña fijada");
    } else if (cmd === "TAB_MUTE") {
      await runBrowserAction({ kind: "mute_tab", target: arg || "current" }, "audio pestaña");
    } else if (cmd === "BROWSER_SEARCH" && arg) {
      await runBrowserAction({ kind: "search_web", query: arg }, `buscar: ${arg}`);
    } else if (cmd === "BROWSER_BOOKMARK") {
      await runBrowserAction({ kind: "bookmark_current" }, "marcador guardado");
    } else if (cmd === "BROWSER_HISTORY" && arg) {
      await runBrowserAction({ kind: "open_history", query: arg }, `historial: ${arg}`);
    } else if (cmd === "PAGE_CLICK" && arg) {
      await runPageAction({ kind: "click", target: arg }, `clic: ${arg}`);
    } else if (cmd === "PAGE_CLICK_XY" && arg) {
      const parts = arg.split("|").map((s) => Number(s.trim().replace("%", "")));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        await runPageAction({ kind: "click_xy", xPct: parts[0], yPct: parts[1] }, `clic XY: ${parts[0]}%,${parts[1]}%`);
      }
    } else if ((cmd === "PAGE_TYPE" || cmd === "PAGE_REPLACE") && arg) {
      const sep = arg.indexOf("|");
      const target = sep >= 0 ? arg.slice(0, sep).trim() : "active";
      const text = sep >= 0 ? arg.slice(sep + 1) : arg;
      if (text) {
        await runPageAction(
          { kind: "type", target: target || "active", text, clear: cmd === "PAGE_REPLACE" },
          `${cmd === "PAGE_REPLACE" ? "reemplazar" : "escribir"}: ${target || "active"}`,
        );
      }
    } else if (cmd === "PAGE_PRESS" && arg) {
      await runPageAction({ kind: "press", key: arg }, `tecla: ${arg}`);
    } else if (cmd === "PAGE_HIGHLIGHT" && arg) {
      const sep = arg.indexOf("|");
      const target = sep >= 0 ? arg.slice(0, sep).trim() : arg;
      const label = sep >= 0 ? arg.slice(sep + 1).trim() : undefined;
      if (target) {
        await runPageAction({ kind: "highlight", target, label }, `resaltar: ${target}`);
      }
    } else if (cmd === "PAGE_CLEAR_HIGHLIGHTS") {
      await runPageAction({ kind: "clear_highlights" }, "limpiar resaltados");
    } else if (cmd === "PAGE_FIND" && arg) {
      await runPageAction({ kind: "find_text", query: arg }, `buscar texto: ${arg}`);
    } else if (cmd === "PAGE_SCROLL_TO" && arg) {
      await runPageAction({ kind: "scroll_to", target: arg }, `ir al elemento: ${arg}`);
    } else if (cmd === "PAGE_COPY" && arg) {
      await runPageAction({ kind: "copy", text: arg }, "copiado al portapapeles");
    } else if (cmd === "PAGE_BACK") {
      await runPageAction({ kind: "history", direction: "back" }, "atrás");
    } else if (cmd === "PAGE_FORWARD") {
      await runPageAction({ kind: "history", direction: "forward" }, "adelante");
    } else if (cmd === "PAGE_RELOAD") {
      await runPageAction({ kind: "history", direction: "reload" }, "recargar");
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

const PROACTIVE_COMPACT_MSGS = 12;
const PROACTIVE_COMPACT_CHARS = 12_000;
const KEEP_RECENT_AFTER_COMPACT = 4;

function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /too long|\/compact|\/new|context.?length|max.*token|token.?limit|payload too large|request too large|entity too large|413|exceeds.*limit|prompt is too long/i.test(
    msg,
  );
}

function estimateHistoryChars(msgs: PersistedChatMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += m.text.length;
    for (const a of m.attachments ?? []) {
      if (a.kind === "doc" && a.textContent) total += a.textContent.length;
    }
  }
  return total;
}

function buildExtractiveSummary(prevSummary: string, msgs: PersistedChatMessage[]): string {
  const lines: string[] = [];
  if (prevSummary.trim()) lines.push(prevSummary.trim());
  for (const m of msgs) {
    const clean = m.text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const who = m.role === "user" ? "Usuario" : "RECO";
    const imgNote = (m.attachments ?? []).some((a) => a.kind === "image") ? " [con captura]" : "";
    lines.push(`- ${who}${imgNote}: ${clean.slice(0, 180)}${clean.length > 180 ? "…" : ""}`);
  }
  const joined = lines.join("\n");
  return joined.length > 2600 ? joined.slice(-2600) : joined;
}

async function summarizeMessages(opts: {
  provider: AiProviderId;
  key: string;
  customBaseUrl?: string;
  model: string;
  prevSummary: string;
  dropped: PersistedChatMessage[];
}): Promise<string> {
  const fallback = buildExtractiveSummary(opts.prevSummary, opts.dropped);
  if (opts.dropped.length === 0) return opts.prevSummary;

  const transcript = opts.dropped
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === "user" ? "Usuario" : "RECO"}: ${m.text.trim().slice(0, 400)}`)
    .join("\n")
    .slice(0, 8000);

  if (!transcript) return fallback;

  // Rotate FreePi session before summarizing so the summary request starts on a clean session
  if (opts.provider === "freepi") {
    await rotateFreePiSessionId();
  }

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await streamProviderChat({
      provider: opts.provider,
      key: opts.key,
      customBaseUrl: opts.customBaseUrl,
      model: opts.model,
      signal: ctrl.signal,
      messages: [
        {
          role: "system",
          content:
            "Resume de forma ultra-concisa (máximo 6 viñetas breves en español) los hechos clave, preferencias, páginas visitadas y tareas pendientes de esta conversación para mantener memoria de contexto. Sin introducción ni despedida.",
        },
        {
          role: "user",
          content: `${opts.prevSummary ? `Resumen anterior:\n${opts.prevSummary}\n\n` : ""}Nuevos mensajes a compactar:\n${transcript}`,
        },
      ],
    });
    const out = res.text.trim();
    return out ? out.slice(0, 2600) : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function buildWireMessages(opts: {
  cfg: AppConfig;
  summary: string;
  history: PersistedChatMessage[];
  pageContextNote: string;
}): FreePiChatMessage[] {
  const systemBase = buildRecoSystemPrompt(opts.cfg);
  const systemContent = opts.summary.trim()
    ? `${systemBase}\n\nMemoria compactada de la conversación previa:\n${opts.summary.trim()}`
    : systemBase;

  const wireMessages: FreePiChatMessage[] = [{ role: "system", content: systemContent }];

  // Keep only non-empty messages and drop trailing empty assistant placeholder
  const clean = opts.history.filter((m) => m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0);
  const turnSlice = clean.slice(-10);

  for (let idx = 0; idx < turnSlice.length; idx += 1) {
    const m = turnSlice[idx];
    if (m.role === "assistant") {
      if (m.text.trim()) {
        wireMessages.push({ role: "assistant", content: m.text });
      }
      continue;
    }

    const isCurrentTurn = idx === turnSlice.length - 1;
    const docs = (m.attachments ?? []).filter((a) => a.kind === "doc" && a.textContent);
    const imgs = (m.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
    const docPrefix = docs
      .map((d) => `[Documento: ${d.name}]\n${(d.textContent ?? "").slice(0, isCurrentTurn ? 12_000 : 1200)}`)
      .join("\n\n");
    const pagePrefix = isCurrentTurn && opts.pageContextNote ? `${opts.pageContextNote}\n\n` : "";

    // Only attach full base64 images on the current turn to avoid blowing context/payload limits
    if (isCurrentTurn && imgs.length > 0) {
      const combinedText = `${pagePrefix}${docPrefix ? `${docPrefix}\n\n` : ""}${m.text}`;
      const parts: ChatMessagePart[] = [{ type: "text", text: combinedText }];
      for (const img of imgs.slice(0, 2)) {
        parts.push({ type: "image_url", image_url: { url: img.dataUrl! } });
      }
      wireMessages.push({ role: "user", content: parts });
    } else {
      const imgNote =
        imgs.length > 0
          ? `[Imagen previa adjunta: ${imgs.map((i) => i.name).join(", ")}]\n`
          : "";
      const combinedText = `${pagePrefix}${imgNote}${docPrefix ? `${docPrefix}\n\n` : ""}${m.text}`;
      wireMessages.push({ role: "user", content: combinedText });
    }
  }

  return wireMessages;
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

  const trimmedInput = opts.userText.trim();

  // Support explicit slash commands `/new` and `/compact`
  if (/^\/new$/i.test(trimmedInput)) {
    await clearChatMessages();
    return { text: "Listo, inicié una conversación nueva con contexto limpio.", reasoning: "", actions: ["nuevo chat"] };
  }

  if (/^\/compact$/i.test(trimmedInput)) {
    const existing = (await getChatMessages()).filter((m) => m.text.trim());
    const prevSum = await getChatSummary();
    const newSum = await summarizeMessages({
      provider,
      key,
      customBaseUrl: cfg.ai.customBaseUrl,
      model,
      prevSummary: prevSum,
      dropped: existing,
    });
    await saveChatSummary(newSum);
    await saveChatMessages(existing.slice(-2));
    if (provider === "freepi") await rotateFreePiSessionId();
    return {
      text: "Contexto compactado automáticamente. Podemos seguir sin problema.",
      reasoning: "",
      actions: ["contexto compactado"],
    };
  }

  const atts: PersistedChatAttachment[] = [...(opts.attachments ?? [])];
  const wantsVision = VISION_INTENT_RE.test(trimmedInput);
  const wantsPageInteract = PAGE_INTERACT_INTENT_RE.test(trimmedInput);

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

  // DOM snapshot + open browser tabs so RECO can switch tabs and interact with the active page
  let pageContextNote = "";
  if (wantsPageInteract || wantsVision) {
    const [snap, tabsSnap] = await Promise.all([
      chrome.runtime
        .sendMessage({ type: "GET_PAGE_SNAPSHOT" } satisfies ExtMessage)
        .catch(() => null) as Promise<{ ok?: boolean; summary?: string } | null>,
      chrome.runtime
        .sendMessage({ type: "GET_BROWSER_TABS" } satisfies ExtMessage)
        .catch(() => null) as Promise<{ ok?: boolean; summary?: string } | null>,
    ]);
    const parts: string[] = [];
    if (tabsSnap?.ok && tabsSnap.summary) parts.push(tabsSnap.summary);
    if (snap?.ok && snap.summary) parts.push(snap.summary);
    pageContextNote = parts.join("\n\n");
  }

  // Sanitize prior history (drop any empty/stuck assistant bubbles from previous failed turns)
  const rawPrevHistory = await getChatMessages();
  let prevHistory = rawPrevHistory.filter(
    (m) => m.role === "user" || m.text.trim().length > 0,
  );
  let rollingSummary = await getChatSummary();

  // Proactive auto-compaction before context grows too long
  if (
    prevHistory.length >= PROACTIVE_COMPACT_MSGS ||
    estimateHistoryChars(prevHistory) > PROACTIVE_COMPACT_CHARS
  ) {
    const splitAt = Math.max(0, prevHistory.length - KEEP_RECENT_AFTER_COMPACT);
    const toCompact = prevHistory.slice(0, splitAt);
    const recent = prevHistory.slice(splitAt);
    if (toCompact.length > 0) {
      rollingSummary = await summarizeMessages({
        provider,
        key,
        customBaseUrl: cfg.ai.customBaseUrl,
        model,
        prevSummary: rollingSummary,
        dropped: toCompact,
      });
      await saveChatSummary(rollingSummary);
      prevHistory = recent;
      if (provider === "freepi") await rotateFreePiSessionId();
    }
  }

  const userMsg: PersistedChatMessage = {
    id: `u-${Date.now()}`,
    role: "user",
    text: trimmedInput || "Analiza lo adjunto.",
    attachments: atts.length > 0 ? atts : undefined,
    createdAt: Date.now(),
  };
  const assistantId = `a-${Date.now() + 1}`;
  let workingHistory: PersistedChatMessage[] = [
    ...prevHistory,
    userMsg,
    { id: assistantId, role: "assistant", text: "", reasoning: "", createdAt: Date.now() },
  ];
  opts.signal?.throwIfAborted();
  await saveChatMessages(workingHistory);

  const hasImageInTurn = atts.some((a) => a.kind === "image" && a.dataUrl);
  const effectiveModel = hasImageInTurn
    ? await resolveVisionModel(provider, key, cfg.ai.customBaseUrl, model)
    : model;

  const invokeModel = async (summary: string, historyForWire: PersistedChatMessage[]) => {
    let rawText = "";
    let reasoningText = "";
    const wireMessages = buildWireMessages({
      cfg,
      summary,
      history: historyForWire,
      pageContextNote,
    });
    const res = await streamProviderChat({
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
    return {
      finalRaw: res.text || rawText,
      reasoning: res.reasoning || reasoningText,
    };
  };

  let finalRaw = "";
  let finalReasoning = "";

  try {
    try {
      const r = await invokeModel(rollingSummary, [...prevHistory, userMsg]);
      finalRaw = r.finalRaw;
      finalReasoning = r.reasoning;
    } catch (firstErr) {
      // Reactive auto-compaction + session rotation + automatic retry on context overflow!
      if (!opts.signal?.aborted && isContextOverflowError(firstErr)) {
        rollingSummary = buildExtractiveSummary(rollingSummary, prevHistory);
        await saveChatSummary(rollingSummary);
        if (provider === "freepi") await rotateFreePiSessionId();
        prevHistory = [];
        workingHistory = [
          userMsg,
          { id: assistantId, role: "assistant", text: "", reasoning: "", createdAt: Date.now() },
        ];
        await saveChatMessages(workingHistory);

        const retry = await invokeModel(rollingSummary, [userMsg]);
        finalRaw = retry.finalRaw;
        finalReasoning = retry.reasoning;
      } else {
        throw firstErr;
      }
    }
  } catch (err) {
    // Never leave an empty assistant placeholder stuck in chat history on error/abort
    const cleaned = workingHistory.filter((m) => m.id !== assistantId);
    await saveChatMessages(cleaned).catch(() => {});
    throw err;
  }

  const cleanText = stripActionTags(finalRaw);
  opts.signal?.throwIfAborted();
  const actions = await executeActionTags(finalRaw);

  if (!actions.includes("nuevo chat")) {
    const updated = workingHistory.map((m) =>
      m.id === assistantId ? { ...m, text: cleanText, reasoning: finalReasoning } : m,
    );
    opts.signal?.throwIfAborted();
    await saveChatMessages(updated);
  }

  return { text: cleanText, reasoning: finalReasoning, actions };
}
