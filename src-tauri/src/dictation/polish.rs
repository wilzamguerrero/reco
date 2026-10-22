//! Limpieza posterior del texto dictado.
//!
//! Todo son reglas deterministas, sin red ni modelo: es la parte que más se nota
//! en la calidad percibida y la más barata de calcular.

/// Muletillas que se eliminan al inicio de frase o entre comas.
const FILLERS: &[&str] = &[
    "eh", "ehh", "em", "emm", "uh", "uhh", "mmm", "este", "esto es", "o sea",
    "pues", "bueno",
];

/// Aplica limpieza conservadora al texto transcrito.
///
/// Criterio: nunca cambiar el significado. Si una regla es dudosa, no se aplica.
pub fn polish(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = remove_fillers(trimmed);
    out = collapse_whitespace(&out);
    out = fix_spacing_before_punctuation(&out);
    out = capitalize_sentences(&out);
    out = ensure_final_punctuation(&out);
    out
}

fn remove_fillers(text: &str) -> String {
    let mut result = text.to_string();

    for filler in FILLERS {
        // Solo al principio de una frase y seguida de coma o espacio.
        for pattern in [format!("{filler}, "), format!("{filler} ")] {
            result = strip_sentence_initial(&result, &pattern);
        }
    }
    result
}

/// Quita `pattern` cuando aparece al inicio del texto o tras un terminador.
///
/// Ojo: los bytes que no coinciden con el patrón se copian **íntegros**, incluidos
/// los espacios. Si no, «hola , mundo» perdería el espacio antes de la coma.
fn strip_sentence_initial(text: &str, pattern: &str) -> String {
    let lower = text.to_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut at_sentence_start = true;
    let mut i = 0usize;

    while i < text.len() {
        // Solo se intenta el patrón cuando estamos al principio de una frase; el
        // espacio inicial se conserva para no pegar palabras.
        if at_sentence_start && lower[i..].starts_with(pattern) {
            i += pattern.len();
            at_sentence_start = false;
            continue;
        }

        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();

        at_sentence_start = matches!(ch, '.' | '!' | '?' | '\n' | ',');
    }
    out
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = false;

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

fn fix_spacing_before_punctuation(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == ' ' {
            // No dejar espacio antes de , . ; : ! ?
            if let Some(&next) = chars.peek() {
                if matches!(next, ',' | '.' | ';' | ':' | '!' | '?') {
                    continue;
                }
            }
        }
        out.push(ch);
    }
    out
}

fn capitalize_sentences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut capitalize_next = true;

    for ch in text.chars() {
        if capitalize_next && ch.is_alphabetic() {
            out.extend(ch.to_uppercase());
            capitalize_next = false;
            continue;
        }
        out.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\n') {
            capitalize_next = true;
        }
    }
    out
}

fn ensure_final_punctuation(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    if matches!(trimmed.chars().last(), Some('.' | '!' | '?' | ':' | '…')) {
        trimmed.to_string()
    } else {
        format!("{trimmed}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quita_muletilla_inicial() {
        assert_eq!(polish("eh, vamos a empezar"), "Vamos a empezar.");
    }

    #[test]
    fn arregla_espacios_antes_de_coma() {
        assert_eq!(polish("hola , mundo"), "Hola, mundo.");
    }

    #[test]
    fn respeta_mayusculas_existentes() {
        assert_eq!(polish("RECO funciona."), "RECO funciona.");
    }

    #[test]
    fn texto_vacio() {
        assert_eq!(polish("   "), "");
    }

    #[test]
    fn no_duplica_punto_final() {
        assert_eq!(polish("listo."), "Listo.");
    }
}
