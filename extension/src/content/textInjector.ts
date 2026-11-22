/**
 * Inserción universal y EN VIVO en el cursor activo (estilo Wispr Flow).
 *
 * Soporta actualización en tiempo real (`applyLiveSpeech`) palabra por palabra
 * mediante diferencia de prefijo común (`commonPrefix`) para escribir al instante
 * donde coloques el cursor sin esperar a terminar de hablar.
 */

import type { ExtMessage, LiveSpeechPayload } from "../shared/types";

type EditableTarget =
  | { kind: "input"; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: "ce"; el: HTMLElement; range: Range | null };

interface ActiveUtterance {
  id: string;
  insertedText: string;
  leadingSpace: string;
  mode: "live" | "final_only";
}

let savedTarget: EditableTarget | null = null;
let activeUtterance: ActiveUtterance | null = null;
let lastFocusedEl: Element | null = null;

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    const allowed = new Set(["text", "search", "email", "url", "tel", "password", ""]);
    return allowed.has(el.type.toLowerCase()) && !el.readOnly && !el.disabled;
  }
  return false;
}

function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let el: Element | null = root.activeElement;
  while (el && el.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

function getSelectionForElement(el: Element): Selection | null {
  const root = el.getRootNode();
  if (
    root instanceof ShadowRoot &&
    "getSelection" in root &&
    typeof (root as unknown as { getSelection?: () => Selection | null }).getSelection === "function"
  ) {
    return (root as unknown as { getSelection: () => Selection | null }).getSelection();
  }
  return window.getSelection();
}

function findEditable(node: Element | null): HTMLElement | null {
  let cur: Element | null = node;
  while (cur) {
    if (cur instanceof HTMLElement) {
      if (isTextInput(cur)) return cur;
      if (cur.isContentEditable) return cur;
    }
    cur = cur.parentElement;
  }
  if (document.designMode === "on" && document.body) {
    return document.body;
  }
  return null;
}

function captureCurrentTarget(hintEl?: Element | null): EditableTarget | null {
  const active = hintEl ?? deepActiveElement();
  if (!active || active.id === "reco-ext-host") return null;

  if (isTextInput(active)) {
    return {
      kind: "input",
      el: active,
      start: active.selectionStart ?? active.value.length,
      end: active.selectionEnd ?? active.value.length,
    };
  }

  const ce = findEditable(active);
  if (ce && (ce.isContentEditable || document.designMode === "on")) {
    const sel = getSelectionForElement(ce);
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    return { kind: "ce", el: ce, range };
  }

  return null;
}

function reportCursorFocused(target: EditableTarget) {
  // Si el usuario cambió de campo a mitad de una frase, cerramos el utterance activo
  if (lastFocusedEl !== target.el) {
    lastFocusedEl = target.el;
    activeUtterance = null;
  }
  void chrome.runtime.sendMessage({ type: "CURSOR_FOCUSED" } satisfies ExtMessage).catch(() => {});
}

export function initCursorTracker(): void {
  const save = (ev?: Event) => {
    const first =
      ev && "composedPath" in ev ? (ev.composedPath()[0] as Element | undefined) : undefined;
    const hint = first instanceof Element ? first : undefined;
    const cap = captureCurrentTarget(hint) ?? captureCurrentTarget();
    if (cap) {
      savedTarget = cap;
      reportCursorFocused(cap);
    }
  };

  const saveAsync = (ev?: Event) => {
    save(ev);
    window.setTimeout(() => save(), 0);
    window.setTimeout(() => save(), 45);
  };

  document.addEventListener("focusin", saveAsync, true);
  document.addEventListener("pointerup", saveAsync, true);
  document.addEventListener("keyup", save, true);
  document.addEventListener("selectionchange", () => {
    const active = deepActiveElement();
    if (active && active.id !== "reco-ext-host") {
      const cap = captureCurrentTarget(active);
      if (cap) {
        savedTarget = cap;
        reportCursorFocused(cap);
      }
    }
  });

  const initial = captureCurrentTarget();
  if (initial) {
    savedTarget = initial;
    reportCursorFocused(initial);
  }
}

export function hasActiveOrSavedCursor(): boolean {
  if (!document.hasFocus()) return false;
  const live = captureCurrentTarget();
  if (live) return true;
  return Boolean(savedTarget && savedTarget.el.isConnected);
}

function charBeforeCursor(target: EditableTarget): string {
  if (target.kind === "input") {
    const pos = target.el.selectionStart ?? target.start;
    return pos > 0 ? target.el.value.slice(pos - 1, pos) : "";
  }
  const sel = getSelectionForElement(target.el);
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
    return (node.textContent ?? "").slice(range.startOffset - 1, range.startOffset);
  }
  return "";
}

function computeLeadingSpace(rawText: string, prevChar: string): string {
  if (!rawText) return "";
  if (!prevChar || /\s/.test(prevChar) || /[\(\[\{“"¿¡]/.test(prevChar)) {
    return "";
  }
  if (/^[,.;:!?…\)\]\}]/.test(rawText)) {
    return "";
  }
  return " ";
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function tryPasteDispatch(el: HTMLElement, text: string): boolean {
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = el.dispatchEvent(ev);
    return !notCanceled;
  } catch {
    return false;
  }
}

function replaceInputSlice(
  el: HTMLInputElement | HTMLTextAreaElement,
  delCount: number,
  insertStr: string,
): boolean {
  const pos = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? pos;
  const replaceStart = Math.max(0, pos - delCount);
  const nextValue = el.value.slice(0, replaceStart) + insertStr + el.value.slice(end);

  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, nextValue);
  } else {
    el.value = nextValue;
  }

  const newPos = replaceStart + insertStr.length;
  el.setSelectionRange(newPos, newPos);
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      cancelable: true,
      inputType: "insertText",
      data: insertStr,
    }),
  );
  el.dispatchEvent(new Event("change", { bubbles: true }));
  savedTarget = { kind: "input", el, start: newPos, end: newPos };
  return true;
}

function replaceContentEditableTail(
  el: HTMLElement,
  oldTail: string,
  newTail: string,
): boolean {
  const sel = getSelectionForElement(el);
  if (!sel) return false;

  if (oldTail.length > 0) {
    if (sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE || offset < oldTail.length) {
      return false;
    }
    const textBefore = (node.textContent ?? "").slice(offset - oldTail.length, offset);
    if (textBefore !== oldTail) {
      return false;
    }
    const replaceRange = document.createRange();
    replaceRange.setStart(node, offset - oldTail.length);
    replaceRange.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(replaceRange);
  }

  if (newTail.length === 0) {
    try {
      const ok = document.execCommand("delete", false);
      if (ok) {
        const cap = captureCurrentTarget(el);
        if (cap) savedTarget = cap;
        return true;
      }
    } catch {
      // fallthrough
    }
    if (sel.rangeCount > 0) {
      sel.getRangeAt(0).deleteContents();
      return true;
    }
    return false;
  }

  try {
    const ok = document.execCommand("insertText", false, newTail);
    if (ok) {
      const cap = captureCurrentTarget(el);
      if (cap) savedTarget = cap;
      return true;
    }
  } catch {
    // fallthrough
  }

  if (tryPasteDispatch(el, newTail)) {
    return true;
  }

  if (sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tn = document.createTextNode(newTail);
    r.insertNode(tn);
    r.setStartAfter(tn);
    r.setEndAfter(tn);
    sel.removeAllRanges();
    sel.addRange(r);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType: "insertText",
        data: newTail,
      }),
    );
    savedTarget = { kind: "ce", el, range: r.cloneRange() };
    return true;
  }

  return false;
}

function restoreFocus(target: EditableTarget) {
  if (deepActiveElement() !== target.el) {
    target.el.focus({ preventScroll: true });
  }
  if (target.kind === "input") {
    const start = target.el.selectionStart ?? target.start;
    const end = target.el.selectionEnd ?? target.end;
    target.el.setSelectionRange(start, end);
  } else if (target.range) {
    const sel = getSelectionForElement(target.el);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(target.range);
    }
  }
}

/**
 * Inserta o actualiza EN VIVO lo que estás dictando directamente en el cursor.
 */
export async function applyLiveSpeech(
  payload: LiveSpeechPayload,
  smartSpacing = true,
): Promise<{ ok: boolean; inserted: boolean }> {
  const live = captureCurrentTarget();
  const target = live ?? savedTarget;

  if (!target || !target.el.isConnected) {
    // No copiamos en interim para no ensuciar portapapeles; solo si es final
    if (payload.isFinal) {
      try {
        await navigator.clipboard.writeText(payload.text);
      } catch {
        // ignore
      }
      return { ok: false, inserted: false };
    }
    return { ok: false, inserted: false };
  }

  restoreFocus(target);

  // Nuevo utterance
  if (!activeUtterance || activeUtterance.id !== payload.utteranceId) {
    const prevChar = smartSpacing ? charBeforeCursor(target) : "";
    const leadingSpace = smartSpacing ? computeLeadingSpace(payload.text, prevChar) : "";
    activeUtterance = {
      id: payload.utteranceId,
      insertedText: "",
      leadingSpace,
      mode: "live",
    };
  }

  // Si un editor complejo no permitió edición parcial en vivo,
  // esperamos al resultado final y añadimos solo lo que faltó.
  if (activeUtterance.mode === "final_only" && !payload.isFinal) {
    return { ok: true, inserted: false };
  }

  const desired = `${activeUtterance.leadingSpace}${payload.text}`;
  const prev = activeUtterance.insertedText;
  const prefix = commonPrefixLen(prev, desired);
  const oldTail = prev.slice(prefix);
  const newTail = desired.slice(prefix);

  if (oldTail === newTail && !payload.isFinal) {
    return { ok: true, inserted: false };
  }

  let ok = false;
  if (target.kind === "input") {
    ok = replaceInputSlice(target.el, oldTail.length, newTail);
  } else {
    if (activeUtterance.mode === "final_only" && payload.isFinal && prev.length > 0) {
      // Ya habíamos escrito `prev` antes de pasar a final_only: si podemos extender,
      // extendemos; si no, añadimos un espacio + la diferencia nueva sin borrar texto del usuario.
      const suffix = desired.toLowerCase().startsWith(prev.toLowerCase())
        ? desired.slice(prev.length)
        : newTail;
      ok = suffix ? replaceContentEditableTail(target.el, "", suffix) : true;
    } else {
      ok = replaceContentEditableTail(target.el, oldTail, newTail);
      if (!ok && !payload.isFinal) {
        activeUtterance.mode = "final_only";
        return { ok: true, inserted: false };
      }
      if (!ok && payload.isFinal && oldTail.length > 0) {
        // Fallback seguro: insertar solo la parte nueva sin fallar
        ok = replaceContentEditableTail(target.el, "", newTail || desired);
      }
    }
  }

  if (ok) {
    activeUtterance.insertedText = desired;
    if (payload.isFinal) {
      activeUtterance = null;
    }
    return { ok: true, inserted: true };
  }

  if (payload.isFinal) {
    activeUtterance = null;
    try {
      await navigator.clipboard.writeText(desired.trimStart());
    } catch {
      // ignore
    }
    return { ok: false, inserted: false };
  }

  return { ok: false, inserted: false };
}

export async function injectTextAtCursor(
  rawText: string,
  smartSpacing = true,
): Promise<{ ok: boolean; method: string }> {
  const res = await applyLiveSpeech(
    { utteranceId: `single-${Date.now()}`, text: rawText, isFinal: true },
    smartSpacing,
  );
  return { ok: res.ok, method: res.ok ? "live" : "clipboard" };
}
