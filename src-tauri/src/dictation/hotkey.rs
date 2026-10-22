//! Puente entre el atajo global y las sesiones de dictado.
//!
//! El atajo solo informa de pulsación/liberación; este módulo decide qué hacer
//! según el modo configurado y deja la transcripción en un hilo aparte.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::dictation::ActiveDictation;
use crate::config::DictationMode;
use crate::dictation::inject;
use crate::state::AppState;

/// Margen para considerar dos pulsaciones como una doble pulsación.
const DOUBLE_PRESS_WINDOW: Duration = Duration::from_millis(450);

/// Estado del atajo entre pulsaciones.
#[derive(Debug, Default)]
pub struct HotkeyTracker {
    last_press: std::sync::Mutex<Option<Instant>>,
}

/// Punto de entrada desde el plugin de atajos.
///
/// - **Mantener pulsado:** pulsar inicia, soltar detiene.
/// - **Doble pulsación:** doble toque inicia el dictado continuo; una pulsación
///   suelta estando activo lo detiene.
pub fn handle_hotkey(app: &AppHandle, pressed: bool) {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
    if !state.config_snapshot().dictation.enabled {
        return;
    }

    let running = app
        .try_state::<ActiveDictation>()
        .and_then(|a| a.0.lock().ok().map(|g| g.is_some()))
        .unwrap_or(false);

    match state.config_snapshot().dictation.mode {
        DictationMode::PushToTalk => {
            if pressed && !running {
                start(app);
            } else if !pressed && running {
                stop(app);
            }
        }
        DictationMode::Toggle => {
            // En toggle solo importa el momento de la pulsación, no el de soltar.
            if !pressed {
                return;
            }

            let tracker = app.state::<HotkeyTracker>();
            let now = Instant::now();
            let mut last = match tracker.last_press.lock() {
                Ok(g) => g,
                Err(_) => return,
            };

            if running {
                // Cualquier pulsación detiene una sesión activa.
                *last = None;
                drop(last);
                stop(app);
                return;
            }

            let is_double = last
                .map(|t| now.duration_since(t) < DOUBLE_PRESS_WINDOW)
                .unwrap_or(false);

            if is_double {
                *last = None;
                drop(last);
                start(app);
            } else {
                // Primera pulsación: se recuerda y se espera a la segunda.
                *last = Some(now);
            }
        }
    }
}

fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let active = app.state::<ActiveDictation>();
    let config = state.config_snapshot();

    let mut guard = match active.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_some() {
        return;
    }

    match crate::dictation::DictationSession::start(config.recording.microphone_id.as_deref()) {
        Ok(session) => {
            *guard = Some(session);
            drop(guard);
            let _ = app.emit("dictation:state", serde_json::json!({ "state": "listening" }));
        }
        Err(e) => {
            tracing::warn!(%e, "no se pudo iniciar el dictado");
            let _ = app.emit(
                "app:error",
                serde_json::json!({
                    "scope": "dictation",
                    "message": e.to_string(),
                    "recoverable": true
                }),
            );
        }
    }
}

fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let active = app.state::<ActiveDictation>();

    let session = match active.0.lock().map(|mut g| g.take()) {
        Ok(s) => s,
        Err(_) => return,
    };
    let Some(session) = session else { return };

    let config = state.config_snapshot();
    let model_id = config.dictation.model_id.clone();
    let language = if config.dictation.language == "auto" {
        None
    } else {
        Some(config.dictation.language.clone())
    };
    let apply_polish = config.dictation.polish;
    let clipboard_only = config.dictation.clipboard_only;
    let handle = app.clone();
    let cache = std::sync::Arc::clone(&state.transcribers);

    let _ = app.emit(
        "dictation:state",
        serde_json::json!({ "state": "transcribing" }),
    );

    std::thread::spawn(move || {
        let result =
            session.stop_and_transcribe(&cache, &model_id, language.as_deref(), apply_polish);

        match result {
            Ok(transcript) if !transcript.text.is_empty() => {
                let _ = handle.emit(
                    "dictation:state",
                    serde_json::json!({ "state": "inserting" }),
                );

                let outcome = if clipboard_only {
                    inject::write_clipboard(&transcript.text)
                } else {
                    inject::inject(&transcript.text, inject::foreground_window()).map(|_| ())
                };

                if let Err(e) = outcome {
                    tracing::warn!(%e, "no se pudo insertar el texto");
                }

                let _ = handle.emit(
                    "dictation:result",
                    serde_json::json!({
                        "text": transcript.text,
                        "language": transcript.language
                    }),
                );
            }
            Ok(_) => tracing::debug!("dictado vacío; no se inserta nada"),
            Err(e) => {
                tracing::warn!(%e, "fallo al transcribir");
                let _ = handle.emit(
                    "app:error",
                    serde_json::json!({
                        "scope": "dictation",
                        "message": e.to_string(),
                        "recoverable": true
                    }),
                );
            }
        }

        let _ = handle.emit("dictation:state", serde_json::json!({ "state": "idle" }));
    });
}
