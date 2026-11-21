//! Comandos de configuración y secretos.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::config::{AppConfig, ConfigPatch};
use crate::error::Result;
use crate::secrets::{self, SecretKey};
use crate::shortcuts::ShortcutManager;
use crate::state::AppState;

#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> AppConfig {
    state.config_snapshot()
}

/// Aplica un parche y hace efectivo lo que haya cambiado.
///
/// Guardar el JSON no basta: el atajo global hay que re-registrarlo y, si el
/// modelo cambió, hay que soltar el que estaba cargado en memoria.
#[tauri::command]
pub fn config_set(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: ConfigPatch,
) -> Result<AppConfig> {
    let before = state.config_snapshot();

    let after = {
        let mut config = state.config.write().expect("config lock envenenado");
        config.apply_patch(patch);
        config.clone()
    };

    // El atajo se prueba antes de guardar: si el sistema no lo acepta, se deja
    // el anterior puesto y no se toca el archivo. Guardar un atajo que no
    // funciona dejaría al usuario sin dictado y sin saber por qué.
    if before.dictation.shortcut != after.dictation.shortcut {
        if let Some(manager) = app.try_state::<ShortcutManager>() {
            if let Err(e) = manager.register(&app, &after.dictation.shortcut) {
                // Restaurar el anterior para no quedarnos sin ninguno.
                let _ = manager.register(&app, &before.dictation.shortcut);
                state
                    .config
                    .write()
                    .expect("config lock envenenado")
                    .dictation
                    .shortcut = before.dictation.shortcut.clone();
                return Err(e);
            }
        }
    }

    let saved = state.save_config()?;

    if before.dictation.model_id != after.dictation.model_id {
        // El modelo anterior deja de usarse: liberar varios cientos de MB.
        state.transcribers.clear();
    }

    Ok(saved)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatus {
    pub notion_token: bool,
    pub proxy_token: bool,
}

#[tauri::command]
pub fn secrets_status() -> SecretsStatus {
    SecretsStatus {
        notion_token: secrets::is_set(SecretKey::NotionToken),
        proxy_token: secrets::is_set(SecretKey::ProxyToken),
    }
}

#[tauri::command]
pub fn secrets_set(key: String, value: String) -> Result<()> {
    let key = SecretKey::parse(&key)?;
    secrets::set(key, &value)
}

#[tauri::command]
pub fn secrets_clear(key: String) -> Result<()> {
    let key = SecretKey::parse(&key)?;
    secrets::clear(key)
}

/// Comprueba si un atajo se puede registrar en este sistema, sin dejarlo puesto.
///
/// Se usa mientras el usuario escribe: si la combinación está ocupada por otra
/// aplicación, se le avisa antes de guardar.
#[tauri::command]
pub fn shortcut_validate(app: AppHandle, spec: String) -> Result<bool> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let parsed = crate::shortcuts::parse_shortcut(&spec)?;
    let manager = app.state::<ShortcutManager>();
    let current = manager.current_spec();

    // Probar el que ya está registrado daría un falso negativo.
    if current.as_deref() == Some(spec.as_str()) {
        return Ok(true);
    }

    match app.global_shortcut().register(parsed) {
        Ok(()) => {
            // Si el registro de prueba funciona, se libera enseguida.
            let _ = app.global_shortcut().unregister(parsed);
            Ok(true)
        }
        Err(e) => Err(crate::error::Error::Config(format!(
            "no se puede usar «{spec}»: {e}"
        ))),
    }
}
