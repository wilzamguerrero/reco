/**
 * Agente DOM de RECO:
 *  - Inspecciona los elementos interactivos visibles de la pestaña activa y los
 *    indexa en memoria (`#1`, `#2`, ...) para que el modelo pueda interactuar con
 *    la página con precisión sin depender de coordenadas de píxeles.
 *  - Ejecuta acciones reales en la página (clic, escribir en inputs/contenteditable,
 *    pulsar teclas, hacer scroll) con un breve pulso visual violeta sobre el elemento.
 */

import type { PageActionPayload } from "../shared/types";

export interface PageSnapshotResult {
  ok: boolean;
  title?: string;
  url?: string;
  summary?: string;
  count?: number;
  error?: string;
}

export interface PageActionResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

const IGNORED_HOST_IDS = new Set(["reco-ext-host", "reco-draw-host", "reco-chat-host"]);
const MAX_ELEMENTS = 90;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='option']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='row']",
  "[role='listitem']",
  "summary",
  "img",
  "h1",
  "h2",
  "h3",
].join(",");

const indexedElements = new Map<number, HTMLElement>();

interface ActiveHighlight {
  el: HTMLElement;
  box: HTMLDivElement;
  timer: number;
}

const activeHighlights: ActiveHighlight[] = [];
let highlightSyncAttached = false;

function syncHighlightPositions() {
  for (let i = activeHighlights.length - 1; i >= 0; i -= 1) {
    const h = activeHighlights[i];
    if (!h.el.isConnected) {
      clearTimeout(h.timer);
      h.box.remove();
      activeHighlights.splice(i, 1);
      continue;
    }
    const r = h.el.getBoundingClientRect();
    h.box.style.left = `${Math.round(r.left - 4)}px`;
    h.box.style.top = `${Math.round(r.top - 4)}px`;
    h.box.style.width = `${Math.max(12, Math.round(r.width + 8))}px`;
    h.box.style.height = `${Math.max(12, Math.round(r.height + 8))}px`;
  }
}

function ensureHighlightSync() {
  if (highlightSyncAttached) return;
  highlightSyncAttached = true;
  window.addEventListener("scroll", syncHighlightPositions, { passive: true, capture: true });
  window.addEventListener("resize", syncHighlightPositions, { passive: true });
}

function clearAllHighlights() {
  while (activeHighlights.length > 0) {
    const h = activeHighlights.pop()!;
    clearTimeout(h.timer);
    h.box.remove();
  }
}

function highlightElement(el: HTMLElement, label?: string) {
  ensureHighlightSync();
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });

  // Remove existing highlight on same element to avoid duplicates
  for (let i = activeHighlights.length - 1; i >= 0; i -= 1) {
    if (activeHighlights[i].el === el) {
      clearTimeout(activeHighlights[i].timer);
      activeHighlights[i].box.remove();
      activeHighlights.splice(i, 1);
    }
  }

  const box = document.createElement("div");
  box.dataset.recoHighlight = "1";
  box.style.position = "fixed";
  box.style.zIndex = "2147483644";
  box.style.pointerEvents = "none";
  box.style.border = "3px solid #2ee6c5";
  box.style.borderRadius = "5px";
  box.style.background = "rgba(46, 230, 197, 0.10)";
  box.style.boxShadow = "0 0 0 2px #09090b, 0 0 20px rgba(46, 230, 197, 0.55)";
  box.style.transition = "opacity 280ms ease";

  const tag = document.createElement("div");
  tag.textContent = label?.trim() ? `✦ ${cleanSnippet(label, 42)}` : "✦ AQUÍ";
  tag.style.position = "absolute";
  tag.style.top = "-26px";
  tag.style.left = "-3px";
  tag.style.padding = "3px 8px";
  tag.style.background = "#09090b";
  tag.style.color = "#2ee6c5";
  tag.style.border = "1.5px solid #2ee6c5";
  tag.style.borderRadius = "3px";
  tag.style.fontFamily = 'ui-monospace, "Cascadia Code", Consolas, monospace';
  tag.style.fontSize = "11px";
  tag.style.fontWeight = "800";
  tag.style.letterSpacing = "0.05em";
  tag.style.whiteSpace = "nowrap";
  tag.style.boxShadow = "2px 2px 0 #000000";
  box.appendChild(tag);

  document.documentElement.appendChild(box);

  const entry: ActiveHighlight = {
    el,
    box,
    timer: window.setTimeout(() => {
      box.style.opacity = "0";
      window.setTimeout(() => {
        box.remove();
        const idx = activeHighlights.indexOf(entry);
        if (idx >= 0) activeHighlights.splice(idx, 1);
      }, 300);
    }, 15_000),
  };
  activeHighlights.push(entry);

  // Sync now and after smooth scroll settles
  syncHighlightPositions();
  window.setTimeout(syncHighlightPositions, 160);
  window.setTimeout(syncHighlightPositions, 420);
}

function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSnippet(s: string | null | undefined, max = 72): string {
  if (!s) return "";
  const compact = s.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function deepActiveElement(root: Document | ShadowRoot = document): HTMLElement | null {
  let el: Element | null = root.activeElement;
  while (el) {
    if (el instanceof HTMLIFrameElement) {
      try {
        if (el.contentDocument?.activeElement) {
          el = el.contentDocument.activeElement;
          continue;
        }
      } catch {
        break;
      }
    }
    if (el.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    break;
  }
  return el instanceof HTMLElement ? el : null;
}

function isEditableElement(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    const blocked = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden"]);
    return !blocked.has(el.type.toLowerCase()) && !el.disabled && !el.readOnly;
  }
  if (el.isContentEditable) return true;
  if (el.ownerDocument?.designMode === "on" && el.tagName.toLowerCase() === "body") return true;
  const role = el.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

function getViewportRect(el: HTMLElement): DOMRect {
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument?.defaultView;
  if (win && win !== window && win.frameElement instanceof HTMLElement) {
    const frameRect = win.frameElement.getBoundingClientRect();
    return new DOMRect(frameRect.left + rect.left, frameRect.top + rect.top, rect.width, rect.height);
  }
  return rect;
}

function isVisibleInViewport(el: HTMLElement): boolean {
  const win = el.ownerDocument?.defaultView ?? window;
  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }
  const rect = getViewportRect(el);
  if (rect.width < 6 || rect.height < 6) return false;
  const margin = 120;
  return (
    rect.bottom >= -margin &&
    rect.right >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.left <= window.innerWidth + margin
  );
}

function getElementLabel(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return cleanSnippet(aria);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument?.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim()) return cleanSnippet(text);
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels && el.labels.length > 0) {
      const lbl = Array.from(el.labels)
        .map((l) => l.textContent ?? "")
        .join(" ");
      if (lbl.trim()) return cleanSnippet(lbl);
    }
    if ("placeholder" in el && el.placeholder?.trim()) return cleanSnippet(el.placeholder);
    if (el.title?.trim()) return cleanSnippet(el.title);
    if (el.name?.trim()) return cleanSnippet(el.name);
  }

  const title = el.getAttribute("title");
  if (title?.trim()) return cleanSnippet(title);

  const placeholder =
    el.getAttribute("placeholder") ||
    el.getAttribute("data-placeholder") ||
    el.getAttribute("data-mce-placeholder");
  if (placeholder?.trim()) return cleanSnippet(placeholder);

  const inner = cleanSnippet(el.innerText || el.textContent);
  if (inner) return inner;

  if (el instanceof HTMLImageElement) {
    if (el.alt?.trim()) return cleanSnippet(el.alt);
    const fig = el.closest("figure")?.querySelector("figcaption")?.textContent;
    if (fig?.trim()) return cleanSnippet(fig);
    const parentLink = el.closest("a");
    if (parentLink) {
      const pLabel =
        parentLink.getAttribute("aria-label") ||
        parentLink.getAttribute("title") ||
        cleanSnippet(parentLink.innerText);
      if (pLabel?.trim()) return cleanSnippet(pLabel);
    }
    try {
      const fname = decodeURIComponent(new URL(el.src).pathname.split("/").pop() || "");
      if (fname) return cleanSnippet(fname, 48);
    } catch {
      // ignore
    }
  }

  const alt = el.querySelector("img[alt]")?.getAttribute("alt");
  if (alt?.trim()) return cleanSnippet(alt);

  return "";
}

function getElementKind(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  if (tag === "img") return "img";
  if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type || "text";
    return `input(${type})`;
  }
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (el.isContentEditable) return "editor";
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (role) return role;
  return tag;
}

function collectCandidates(root: Document | ShadowRoot, out: HTMLElement[]) {
  if (root instanceof Document && root.body) {
    if (root.body.isContentEditable || root.designMode === "on") {
      out.push(root.body);
    }
  }

  const nodes = root.querySelectorAll(INTERACTIVE_SELECTOR);
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (IGNORED_HOST_IDS.has(node.id)) continue;
    if (node.closest("#reco-ext-host, #reco-draw-host, #reco-chat-host")) continue;
    if ((node as HTMLButtonElement).disabled || node.getAttribute("aria-disabled") === "true") continue;
    out.push(node);
  }

  // Traverse open shadow roots & same-origin iframes (TinyMCE, CKEditor, etc.)
  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (IGNORED_HOST_IDS.has(el.id)) continue;
    if (el.shadowRoot) {
      collectCandidates(el.shadowRoot, out);
    }
    if (el instanceof HTMLIFrameElement) {
      try {
        if (el.contentDocument) collectCandidates(el.contentDocument, out);
      } catch {
        // cross-origin iframe
      }
    }
  }
}

function flashElement(el: HTMLElement) {
  try {
    const rect = getViewportRect(el);
    if (rect.width < 2 || rect.height < 2) return;
    const box = document.createElement("div");
    box.style.position = "fixed";
    box.style.left = `${Math.max(0, rect.left - 2)}px`;
    box.style.top = `${Math.max(0, rect.top - 2)}px`;
    box.style.width = `${rect.width + 4}px`;
    box.style.height = `${rect.height + 4}px`;
    box.style.border = "2px solid #8b6eff";
    box.style.background = "rgba(139, 110, 255, 0.14)";
    box.style.borderRadius = "4px";
    box.style.zIndex = "2147483644";
    box.style.pointerEvents = "none";
    box.style.transition = "opacity 320ms ease";
    document.documentElement.appendChild(box);
    window.setTimeout(() => {
      box.style.opacity = "0";
    }, 360);
    window.setTimeout(() => {
      box.remove();
    }, 700);
  } catch {
    // ignore visual highlight errors
  }
}

export function capturePageSnapshot(): PageSnapshotResult {
  try {
    indexedElements.clear();
    const raw: HTMLElement[] = [];
    collectCandidates(document, raw);

    // Prioritize editable fields/editors first so rich-text editors are never truncated by nav/toolbar buttons
    raw.sort((a, b) => Number(isEditableElement(b)) - Number(isEditableElement(a)));

    const active = deepActiveElement();
    const seen = new Set<HTMLElement>();
    const lines: string[] = [];
    let nextId = 1;

    for (const el of raw) {
      if (nextId > MAX_ELEMENTS) break;
      if (seen.has(el)) continue;
      seen.add(el);

      if (!isVisibleInViewport(el)) continue;

      // Ignore tiny decorative icons/avatars for <img>
      if (el instanceof HTMLImageElement) {
        const r = el.getBoundingClientRect();
        if (r.width < 48 || r.height < 48) continue;
      }

      const label = getElementLabel(el);
      const editable = isEditableElement(el);
      if (!label && !editable) continue;

      const kind = getElementKind(el);
      let valSnippet = "";
      if (el instanceof HTMLInputElement && el.type !== "password" && el.value.trim()) {
        valSnippet = ` valor="${cleanSnippet(el.value, 36)}"`;
      } else if (el instanceof HTMLTextAreaElement && el.value.trim()) {
        valSnippet = ` valor="${cleanSnippet(el.value, 36)}"`;
      } else if (el.isContentEditable && el.innerText.trim()) {
        valSnippet = ` texto="${cleanSnippet(el.innerText, 36)}"`;
      }

      const focusMark = el === active ? " (foco)" : "";
      const id = nextId++;
      indexedElements.set(id, el);
      lines.push(`[${id}] ${kind} "${label || "sin etiqueta"}"${valSnippet}${focusMark}`);
    }

    const header = `[Página activa: "${cleanSnippet(document.title, 80)}" (${location.href})]`;
    const body =
      lines.length > 0
        ? `Elementos visibles (usa el #id con PAGE_CLICK, PAGE_TYPE, PAGE_HIGHLIGHT o PAGE_SCROLL_TO):\n${lines.join("\n")}`
        : "No se detectaron elementos visibles en esta vista.";

    return {
      ok: true,
      title: document.title,
      url: location.href,
      count: lines.length,
      summary: `${header}\n${body}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function findElementByTarget(target: string, editableOnly = false): HTMLElement | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed.toLowerCase() === "active" || trimmed === "0") {
    const active = deepActiveElement();
    if (active && (!editableOnly || isEditableElement(active))) return active;
  }

  const numMatch = trimmed.match(/^#?(\d+)$/);
  if (numMatch) {
    const el = indexedElements.get(Number(numMatch[1]));
    if (el && el.isConnected) {
      if (!editableOnly || isEditableElement(el)) return el;
      const innerEditable = el.querySelector<HTMLElement>(
        "input, textarea, [contenteditable='true'], [contenteditable=''], [role='textbox']",
      );
      if (innerEditable) return innerEditable;
      return el;
    }
  }

  // Fuzzy fallback by visible label / aria-label / placeholder
  const needle = normalizeText(trimmed);
  if (!needle) return null;

  const candidates: HTMLElement[] = [];
  collectCandidates(document, candidates);

  let best: { el: HTMLElement; score: number } | null = null;
  for (const el of candidates) {
    if (!isVisibleInViewport(el)) continue;
    if (editableOnly && !isEditableElement(el)) continue;
    const lbl = normalizeText(getElementLabel(el));
    if (!lbl) continue;

    let score = 0;
    if (lbl === needle) score = 100;
    else if (lbl.startsWith(needle)) score = 80;
    else if (lbl.includes(needle)) score = 60;
    else {
      const words = needle.split(" ").filter((w) => w.length > 1);
      if (words.length > 0 && words.every((w) => lbl.includes(w))) score = 45;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { el, score };
    }
  }

  if (best) return best.el;

  // Smart fallback for typing: if user asked to write in "the editor" / "active" and focus was
  // in RECO's floating chat, pick the largest visible editable field/editor on the page!
  if (editableOnly) {
    let largest: { el: HTMLElement; area: number } | null = null;
    for (const el of candidates) {
      if (!isEditableElement(el) || !isVisibleInViewport(el)) continue;
      const r = getViewportRect(el);
      const area = r.width * r.height;
      if (!largest || area > largest.area) {
        largest = { el, area };
      }
    }
    return largest?.el ?? null;
  }

  return null;
}

function setNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

function typeIntoElement(el: HTMLElement, text: string, clear = false): boolean {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  flashElement(el);
  const doc = el.ownerDocument || document;
  doc.defaultView?.focus?.();
  el.click();
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const nextVal = clear || !el.value ? text : `${el.value}${text}`;
    setNativeInputValue(el, nextVal);
    el.selectionStart = el.selectionEnd = nextVal.length;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  const editable =
    el.isContentEditable || doc.designMode === "on"
      ? el
      : el.querySelector<HTMLElement>("[contenteditable='true'], [contenteditable='']") ?? el;

  doc.defaultView?.focus?.();
  editable.focus();

  const beforeText = (editable.innerText || editable.textContent || "").trim();
  const sel = doc.getSelection();
  if (sel) {
    const range = doc.createRange();
    range.selectNodeContents(editable);
    if (!clear) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let ok = false;
  try {
    if (clear) {
      doc.execCommand?.("selectAll", false);
      doc.execCommand?.("delete", false);
    }
    ok = Boolean(doc.execCommand?.("insertText", false, text));
  } catch {
    ok = false;
  }

  const afterText = (editable.innerText || editable.textContent || "").trim();
  if (!ok || (!clear && afterText === beforeText) || (clear && !afterText)) {
    if (clear) editable.innerHTML = "";
    const paragraphs = text.split(/\n+/);
    for (const para of paragraphs) {
      const p = doc.createElement("p");
      p.textContent = para;
      editable.appendChild(p);
    }
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    editable.dispatchEvent(new Event("change", { bubbles: true }));
    editable.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
  }
  return true;
}

function clickElement(el: HTMLElement) {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  flashElement(el);
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
  el.dispatchEvent(new PointerEvent("pointerdown", common));
  el.dispatchEvent(new MouseEvent("mousedown", common));
  el.focus?.();
  el.dispatchEvent(new PointerEvent("pointerup", common));
  el.dispatchEvent(new MouseEvent("mouseup", common));
  el.click();
}

export async function performPageAction(action: PageActionPayload): Promise<PageActionResult> {
  try {
    if (action.kind === "click") {
      const el = findElementByTarget(action.target, false);
      if (!el) return { ok: false, error: `No encontré el elemento "${action.target}".` };
      clickElement(el);
      return { ok: true, detail: `Clic en "${getElementLabel(el) || action.target}"` };
    }

    if (action.kind === "type") {
      const el = findElementByTarget(action.target, true) ?? findElementByTarget(action.target, false);
      if (!el) return { ok: false, error: `No encontré el campo "${action.target}".` };
      typeIntoElement(el, action.text, Boolean(action.clear));
      return { ok: true, detail: `Escrito en "${getElementLabel(el) || action.target}"` };
    }

    if (action.kind === "press") {
      const active = deepActiveElement() ?? document.body;
      const key = action.key || "Enter";
      const init: KeyboardEventInit = { key, code: key === "Enter" ? "Enter" : key, bubbles: true, cancelable: true };
      active.dispatchEvent(new KeyboardEvent("keydown", init));
      active.dispatchEvent(new KeyboardEvent("keypress", init));
      active.dispatchEvent(new KeyboardEvent("keyup", init));
      if (key === "Enter" && active instanceof HTMLInputElement && active.form) {
        active.form.requestSubmit?.();
      }
      return { ok: true, detail: `Tecla ${key}` };
    }

    if (action.kind === "scroll") {
      const step = Math.round(window.innerHeight * 0.72);
      if (action.direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
      else if (action.direction === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      else if (action.direction === "up") window.scrollBy({ top: -step, behavior: "smooth" });
      else window.scrollBy({ top: step, behavior: "smooth" });
      return { ok: true, detail: `Scroll ${action.direction}` };
    }

    if (action.kind === "scroll_to") {
      const el = findElementByTarget(action.target, false);
      if (!el) return { ok: false, error: `No encontré "${action.target}".` };
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      flashElement(el);
      return { ok: true, detail: `Desplazado a "${getElementLabel(el) || action.target}"` };
    }

    if (action.kind === "highlight") {
      const el = findElementByTarget(action.target, false);
      if (!el) return { ok: false, error: `No encontré "${action.target}" para resaltar.` };
      highlightElement(el, action.label);
      return { ok: true, detail: `Resaltado "${getElementLabel(el) || action.target}"` };
    }

    if (action.kind === "clear_highlights") {
      clearAllHighlights();
      return { ok: true, detail: "Resaltados limpiados" };
    }

    if (action.kind === "find_text") {
      const needle = normalizeText(action.query);
      if (!needle) return { ok: false, error: "Texto vacío." };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        if (parent.closest("#reco-ext-host, #reco-draw-host, #reco-chat-host, script, style, noscript")) continue;
        const txt = normalizeText(node.textContent || "");
        if (!txt || !txt.includes(needle)) continue;
        const r = parent.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        highlightElement(parent, action.query);
        return { ok: true, detail: `Texto encontrado: "${action.query}"` };
      }
      return { ok: false, error: `No encontré "${action.query}" en la página.` };
    }

    if (action.kind === "copy") {
      try {
        await navigator.clipboard.writeText(action.text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = action.text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      return { ok: true, detail: "Copiado al portapapeles" };
    }

    return { ok: false, error: "Acción de página no soportada." };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
