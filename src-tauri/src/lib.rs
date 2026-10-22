//! RECO — núcleo de la aplicación.
//!
//! Arquitectura (ver `ARCHITECTURE.md`):
//! - La UI React nunca toca red, disco ni APIs del sistema: solo invoca comandos.
//! - Los secretos viven en el keyring del sistema operativo, nunca en el WebView.
//! - Cada módulo expone sus comandos en `commands/` y su lógica en su carpeta.

pub mod commands;
pub mod config;
pub mod dictation;
pub mod error;
pub mod notion;
pub mod platform;
pub mod recording;
pub mod secrets;
pub mod shortcuts;
pub mod state;
pub mod storage;
pub mod tray;

use tauri::Manager;

use crate::commands::dictation::ActiveDictation;
use crate::commands::recording::ActiveRecording;
use crate::dictation::hotkey::HotkeyTracker;
use crate::shortcuts::ShortcutManager;
use crate::state::AppState;

pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let state = AppState::initialize(app.handle())
                .map_err(|e| format!("no se pudo inicializar RECO: {e}"))?;

            // El atajo se registra con la configuración ya cargada.
            let shortcut_spec = state.config_snapshot().dictation.shortcut;
            let manager = ShortcutManager::default();
            if let Err(e) = manager.register(app.handle(), &shortcut_spec) {
                // Un atajo ocupado no debe impedir arrancar: se avisa y se sigue.
                tracing::warn!(%e, spec = %shortcut_spec, "no se pudo registrar el atajo global");
            }

            app.manage(state);
            app.manage(ActiveDictation::default());
            app.manage(ActiveRecording::default());
            app.manage(HotkeyTracker::default());
            app.manage(manager);

            // El plugin emite `dictation:hotkey`; aquí se traduce a acciones.
            {
                use tauri::Listener;
                let handle = app.handle().clone();
                app.listen("dictation:hotkey", move |event| {
                    let pressed = serde_json::from_str::<serde_json::Value>(event.payload())
                        .ok()
                        .and_then(|v| v.get("pressed").and_then(|p| p.as_bool()))
                        .unwrap_or(false);
                    crate::dictation::hotkey::handle_hotkey(&handle, pressed);
                });
            }

            tray::install(app.handle())?;

            tracing::info!("RECO iniciado");
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cerrar la ventana principal la oculta en la bandeja en vez de salir.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let state = window.state::<AppState>();
                    if state
                        .config
                        .read()
                        .map(|c| c.system.close_to_tray)
                        .unwrap_or(true)
                    {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // configuración
            commands::config::config_get,
            commands::config::config_set,
            commands::config::secrets_status,
            commands::config::secrets_set,
            commands::config::secrets_clear,
            // diagnóstico
            commands::diagnostics::diagnostics_run,
            // dictado
            commands::dictation::dictation_start,
            commands::dictation::dictation_stop,
            commands::dictation::dictation_cancel,
            commands::dictation::dictation_inject,
            commands::dictation::models_status,
            commands::dictation::models_install,
            commands::dictation::models_remove,
            // grabación
            commands::recording::recording_start,
            commands::recording::recording_stop,
            commands::recording::recording_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error fatal al ejecutar RECO");
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("reco_lib=info,warn"));

    let _ = fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}
