//! Comandos de configuración y secretos.

use serde::Serialize;
use tauri::State;

use crate::config::{AppConfig, ConfigPatch};
use crate::error::Result;
use crate::secrets::{self, SecretKey};
use crate::state::AppState;

#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> AppConfig {
    state.config_snapshot()
}

#[tauri::command]
pub fn config_set(state: State<'_, AppState>, patch: ConfigPatch) -> Result<AppConfig> {
    {
        let mut config = state.config.write().expect("config lock envenenado");
        config.apply_patch(patch);
    }
    state.save_config()
}

#[derive(Debug, Serialize)]
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
