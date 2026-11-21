//! Puente entre el atajo global y las sesiones de dictado.
//!
//! El atajo solo informa de pulsación/liberación; este módulo decide qué hacer
//! según el modo configurado. El arranque y la parada viven en `controller` para
//! que el atajo y la UI compartan exactamente el mismo camino.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::config::DictationMode;
use crate::dictation::controller;
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

    let config = state.config_snapshot();
    if !config.dictation.enabled {
        return;
    }

    let running = controller::is_running(app);

    match config.dictation.mode {
        DictationMode::PushToTalk => {
            if pressed && !running {
                report_if_failed(start(app));
            } else if !pressed && running {
                // Soltar durante la transcripción no hace nada: `stop` lo
                // ignora y el dictado sigue hasta insertar el texto.
                report_if_failed(stop(app));
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
                report_if_failed(stop(app));
                return;
            }

            let is_double = last
                .map(|t| now.duration_since(t) < DOUBLE_PRESS_WINDOW)
                .unwrap_or(false);

            if is_double {
                *last = None;
                drop(last);
                report_if_failed(start(app));
            } else {
                // Primera pulsación: se recuerda y se espera a la segunda.
                *last = Some(now);
            }
        }
    }
}

fn start(app: &AppHandle) -> crate::error::Result<()> {
    controller::start(app)
}

fn stop(app: &AppHandle) -> crate::error::Result<()> {
    controller::stop(app)
}

fn report_if_failed(result: crate::error::Result<()>) {
    if let Err(e) = result {
        tracing::warn!(%e, "acción de dictado fallida");
    }
}

/// Publica un aviso de error en la UI, si hace falta desde otro módulo.
pub fn emit_error(app: &AppHandle, message: String) {
    let _ = app.emit(
        "app:error",
        serde_json::json!({
            "scope": "dictation",
            "message": message,
            "recoverable": true
        }),
    );
}
