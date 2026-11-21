/**
 * Limpieza determinista de texto dictado (portada de RECO src-tauri/src/dictation/polish.rs).
 *
 * Para frases en streaming continuo:
 * - Elimina muletillas iniciales seguras ("eh", "ehh", "em", "uh", "mmm").
 * - Colapsa espacios múltiples y quita espacios antes de , . ; : ! ?
 * - Capitaliza inicio de frase tras . ! ? o salto de línea (si está habilitado).
 */

const FILLERS = ["eh", "ehh", "em", "emm", "uh", "uhh", "mmm"];

function stripSentenceInitialFillers(text: string): string {
  let out = text;
  for (const filler of FILLERS) {
    const re = new RegExp(`(^|[.!?\\n]\\s*)${filler}(?:,\\s+|\\s+)`, "gi");
    out = out.replace(re, "$1");
  }
  return out;
}

export function cleanDictatedChunk(
  raw: string,
  opts: { polish?: boolean; autoCapitalize?: boolean; isNewSentence?: boolean } = {},
): string {
  const { polish = true, autoCapitalize = true, isNewSentence = false } = opts;
  let out = raw.trim();
  if (!out) return "";

  if (polish) {
    out = stripSentenceInitialFillers(out);
  }

  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(/\s+([,.;:!?])/g, "$1");

  if (autoCapitalize) {
    // Capitalize after sentence-ending punctuation
    out = out.replace(/([.!?]\s+)(\p{L})/gu, (_m, p1: string, ch: string) => p1 + ch.toUpperCase());
    if (isNewSentence) {
      out = out.replace(/^(\p{L})/u, (ch) => ch.toUpperCase());
    }
  }

  return out;
}
