/**
 * Inserción de texto en el cursor activo (estilo Wispr Flow).
 *
 * Recuerda el último elemento editable y su selección/Range (porque el usuario
 * puede hacer clic en la esfera flotante sin querer perder el foco), restaura
 * el cursor e inserta mediante:
 *  1) `document.execCommand("insertText")` (funciona en inputs, textareas y
 *     editores ricos como Notion, Gmail, Slack, ProseMirror, TipTap, Lexical,
 *     además de mantener Ctrl+Z).
 *  2) Prototype value setter + `setSelectionRange` + `InputEvent` para React/Vue.
 *  3) `Range.insertNode` para `contenteditable` si `execCommand` fue ignorado.
 *  4) Portapapeles como último recurso en páginas especiales.
 */

type EditableTarget =
  | { kind: "input"; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: "ce"; el: HTMLElement; range: Range | null };

let savedTarget: EditableTarget | null = null;

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    const allowed = new Set(["text", "search", "email", "url", "tel", "password", ""]);
    return allowed.has(el.type.toLowerCase()) && !el.readOnly && !el.disabled;
  }
  return false;
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
  return null;
}

function captureCurrentTarget(): EditableTarget | null {
  const active = document.activeElement;
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
  if (ce && ce.isContentEditable) {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    return { kind: "ce", el: ce, range };
  }

  return null;
}

export function initCursorTracker(): void {
  const save = () => {
    const cap = captureCurrentTarget();
    if (cap) savedTarget = cap;
  };

  document.addEventListener("focusin", save, true);
  document.addEventListener("mouseup", save, true);
  document.addEventListener("keyup", save, true);
  document.addEventListener("selectionchange", () => {
    const active = document.activeElement;
    if (active && active.id !== "reco-ext-host") {
      save();
    }
  });
}

function charBeforeCursor(target: EditableTarget): string {
  if (target.kind === "input") {
    const pos = target.el.selectionStart ?? target.start;
    return pos > 0 ? target.el.value.slice(pos - 1, pos) : "";
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
    return (node.textContent ?? "").slice(range.startOffset - 1, range.startOffset);
  }
  return "";
}

function applySmartSpacing(rawText: string, prevChar: string): string {
  if (!rawText) return "";
  if (!prevChar || /\s/.test(prevChar) || /[\(\[\{“"¿¡]/.test(prevChar)) {
    return rawText;
  }
  if (/^[,.;:!?…\)\]\}]/.test(rawText)) {
    return rawText;
  }
  return ` ${rawText}`;
}

export async function injectTextAtCursor(
  rawText: string,
  smartSpacing = true,
): Promise<{ ok: boolean; method: "execCommand" | "setter" | "range" | "clipboard" }> {
  const live = captureCurrentTarget();
  const target = live ?? savedTarget;

  if (!target || !target.el.isConnected) {
    try {
      await navigator.clipboard.writeText(rawText);
    } catch {
      // ignore
    }
    return { ok: false, method: "clipboard" };
  }

  // Restaurar foco y selección si el foco no estaba ya dentro
  if (document.activeElement !== target.el) {
    target.el.focus({ preventScroll: true });
  }

  if (target.kind === "input") {
    const start = target.el.selectionStart ?? target.start;
    const end = target.el.selectionEnd ?? target.end;
    target.el.setSelectionRange(start, end);
  } else if (target.range) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(target.range);
    }
  }

  const prevChar = smartSpacing ? charBeforeCursor(target) : "";
  const textToInsert = smartSpacing ? applySmartSpacing(rawText, prevChar) : rawText;

  // 1. Vía preferida: execCommand('insertText') — actualiza React/Notion/ProseMirror + Ctrl+Z
  try {
    const did = document.execCommand("insertText", false, textToInsert);
    if (did) {
      const updated = captureCurrentTarget();
      if (updated) savedTarget = updated;
      return { ok: true, method: "execCommand" };
    }
  } catch {
    // fallback below
  }

  // 2. Fallback para <input> / <textarea>
  if (target.kind === "input") {
    const el = target.el;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const nextValue = el.value.slice(0, start) + textToInsert + el.value.slice(end);

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

    const newPos = start + textToInsert.length;
    el.setSelectionRange(newPos, newPos);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: textToInsert,
      }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    savedTarget = { kind: "input", el, start: newPos, end: newPos };
    return { ok: true, method: "setter" };
  }

  // 3. Fallback para contenteditable
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(textToInsert);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    sel.removeAllRanges();
    sel.addRange(range);
    target.el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: textToInsert,
      }),
    );
    savedTarget = { kind: "ce", el: target.el, range: range.cloneRange() };
    return { ok: true, method: "range" };
  }

  try {
    await navigator.clipboard.writeText(textToInsert);
  } catch {
    // ignore
  }
  return { ok: false, method: "clipboard" };
}
