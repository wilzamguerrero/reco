//! Registro del atajo global de dictado.
//!
//! El plugin de Tauri notifica pulsación y liberación por separado en Windows y
//! macOS, que es justo lo que necesita el modo push-to-talk. En Linux/X11
//! también, salvo combinaciones reservadas por el escritorio.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::error::{Error, Result};

pub struct ShortcutManager {
    current: Mutex<Option<Shortcut>>,
}

impl Default for ShortcutManager {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

impl ShortcutManager {
    /// Sustituye el atajo registrado por uno nuevo descrito en texto.
    ///
    /// Formatos aceptados: `"CapsLock"`, `"F9"`, `"CommandOrControl+Shift+Space"`.
    pub fn register(&self, app: &AppHandle, spec: &str) -> Result<()> {
        let shortcut = parse_shortcut(spec)?;

        // Dar de baja el anterior antes de registrar el nuevo.
        {
            let mut guard = self.current.lock().expect("shortcut lock envenenado");
            if let Some(previous) = guard.take() {
                let _ = app.global_shortcut().unregister(previous);
            }
        }

        app.global_shortcut()
            .register(shortcut)
            .map_err(|e| Error::Config(format!("no se pudo registrar «{spec}»: {e}")))?;

        let app_handle = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                let pressed = event.state() == ShortcutState::Pressed;
                let _ = app_handle.emit(
                    "dictation:hotkey",
                    serde_json::json!({ "pressed": pressed }),
                );
            })
            .map_err(|e| Error::Other(format!("no se pudo suscribir al atajo: {e}")))?;

        *self.current.lock().expect("shortcut lock envenenado") = Some(shortcut);
        tracing::info!(spec, "atajo global registrado");
        Ok(())
    }

    pub fn unregister_all(&self, app: &AppHandle) {
        let _ = app.global_shortcut().unregister_all();
        *self.current.lock().expect("shortcut lock envenenado") = None;
    }
}

/// Traduce un texto de atajo a `Shortcut`.
fn parse_shortcut(spec: &str) -> Result<Shortcut> {
    let mut modifiers = Modifiers::empty();
    let mut key: Option<Code> = None;

    for raw in spec.split('+') {
        let part = raw.trim();
        match part.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "shift" => modifiers |= Modifiers::SHIFT,
            "super" | "meta" | "cmd" | "command" => modifiers |= Modifiers::SUPER,
            other => {
                key = Some(
                    code_from_name(other)
                        .ok_or_else(|| Error::Config(format!("tecla desconocida: {other}")))?,
                );
            }
        }
    }

    let code = key.ok_or_else(|| Error::Config("el atajo no incluye una tecla".into()))?;
    Ok(Shortcut::new(Some(modifiers), code))
}

fn code_from_name(name: &str) -> Option<Code> {
    Some(match name {
        "capslock" => Code::CapsLock,
        "space" => Code::Space,
        "tab" => Code::Tab,
        "enter" | "return" => Code::Enter,
        "escape" | "esc" => Code::Escape,
        "backquote" => Code::Backquote,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        other => code_from_letter_or_digit(other)?,
    })
}

fn code_from_letter_or_digit(name: &str) -> Option<Code> {
    if name.len() != 1 {
        return None;
    }
    let ch = name.chars().next()?;
    match ch {
        'a'..='z' => Some(match ch {
            'a' => Code::KeyA,
            'b' => Code::KeyB,
            'c' => Code::KeyC,
            'd' => Code::KeyD,
            'e' => Code::KeyE,
            'f' => Code::KeyF,
            'g' => Code::KeyG,
            'h' => Code::KeyH,
            'i' => Code::KeyI,
            'j' => Code::KeyJ,
            'k' => Code::KeyK,
            'l' => Code::KeyL,
            'm' => Code::KeyM,
            'n' => Code::KeyN,
            'o' => Code::KeyO,
            'p' => Code::KeyP,
            'q' => Code::KeyQ,
            'r' => Code::KeyR,
            's' => Code::KeyS,
            't' => Code::KeyT,
            'u' => Code::KeyU,
            'v' => Code::KeyV,
            'w' => Code::KeyW,
            'x' => Code::KeyX,
            'y' => Code::KeyY,
            'z' => Code::KeyZ,
            _ => return None,
        }),
        '0'..='9' => Some(match ch {
            '0' => Code::Digit0,
            '1' => Code::Digit1,
            '2' => Code::Digit2,
            '3' => Code::Digit3,
            '4' => Code::Digit4,
            '5' => Code::Digit5,
            '6' => Code::Digit6,
            '7' => Code::Digit7,
            '8' => Code::Digit8,
            '9' => Code::Digit9,
            _ => return None,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_capslock_solo() {
        let s = parse_shortcut("CapsLock").expect("CapsLock debería ser válido");
        assert_eq!(s.key, Code::CapsLock);
    }

    #[test]
    fn acepta_combinacion() {
        let s = parse_shortcut("Ctrl+Shift+Space").expect("combinación válida");
        assert!(s.mods.contains(Modifiers::CONTROL));
        assert!(s.mods.contains(Modifiers::SHIFT));
        assert_eq!(s.key, Code::Space);
    }

    #[test]
    fn rechaza_tecla_desconocida() {
        assert!(parse_shortcut("Ctrl+TeclaInventada").is_err());
    }
}
