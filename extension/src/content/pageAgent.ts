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
const MAX_ELEMENTS = 75;

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
].join(",");

const indexedElements = new Map<number, HTMLElement>();

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
  const role = el.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

function isVisibleInViewport(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 6 || rect.height < 6) return false;
  const margin = 100;
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

  const placeholder = el.getAttribute("placeholder") || el.getAttribute("data-placeholder");
  if (placeholder?.trim()) return cleanSnippet(placeholder);

  const inner = cleanSnippet(el.innerText || el.textContent);
  if (inner) return inner;

  const alt = el.querySelector("img[alt]")?.getAttribute("alt");
  if (alt?.trim()) return cleanSnippet(alt);

  return "";
}

function getElementKind(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
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
  const nodes = root.querySelectorAll(INTERACTIVE_SELECTOR);
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (IGNORED_HOST_IDS.has(node.id)) continue;
    if (node.closest("#reco-ext-host, #reco-draw-host, #reco-chat-host")) continue;
    if ((node as HTMLButtonElement).disabled || node.getAttribute("aria-disabled") === "true") continue;
    out.push(node);
  }

  // Traverse open shadow roots & same-origin iframes
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
    const rect = el.getBoundingClientRect();
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

    const active = deepActiveElement();
    const seen = new Set<HTMLElement>();
    const lines: string[] = [];
    let nextId = 1;

    for (const el of raw) {
      if (nextId > MAX_ELEMENTS) break;
      if (seen.has(el)) continue;
      seen.add(el);

      if (!isVisibleInViewport(el)) continue;

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
        ? `Elementos interactivos visibles (usa el #id con PAGE_CLICK o PAGE_TYPE):\n${lines.join("\n")}`
        : "No se detectaron elementos interactivos visibles en esta vista.";

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

  return best?.el ?? null;
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

  const editable = el.isContentEditable
    ? el
    : el.querySelector<HTMLElement>("[contenteditable='true'], [contenteditable='']") ?? el;

  editable.focus();
  const doc = editable.ownerDocument || document;
  const sel = doc.getSelection();
  if (sel) {
    const range = doc.createRange();
    range.selectNodeContents(editable);
    if (!clear) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const inserted = doc.execCommand?.("insertText", false, text);
  if (!inserted) {
    if (clear) editable.textContent = text;
    else editable.appendChild(doc.createTextNode(text));
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
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

    return { ok: false, error: "Acción de página no soportada." };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
