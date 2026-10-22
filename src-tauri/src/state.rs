//! Estado global compartido por los comandos.

use std::sync::{Arc, RwLock};

use tauri::AppHandle;

use crate::config::AppConfig;
use crate::dictation::engine::TranscriberCache;
use crate::error::Result;
use crate::storage::{paths, Database};

pub struct AppState {
    pub config: RwLock<AppConfig>,
    pub db: Arc<Database>,
    pub app_handle: AppHandle,
    /// Modelos de transcripción ya cargados, para no recargarlos en cada dictado.
    /// Va en `Arc` porque el hilo de transcripción la usa fuera del estado.
    pub transcribers: Arc<TranscriberCache>,
}

impl AppState {
    pub fn initialize(app_handle: &AppHandle) -> Result<Self> {
        paths::ensure_dirs()?;

        let config = load_config().unwrap_or_default();
        let db = Database::open(&paths::database_file()?)?;

        tracing::info!(?config.dictation.mode, "configuración cargada");

        Ok(Self {
            config: RwLock::new(config),
            db: Arc::new(db),
            app_handle: app_handle.clone(),
            transcribers: Arc::new(TranscriberCache::default()),
        })
    }

    pub fn config_snapshot(&self) -> AppConfig {
        self.config.read().expect("config lock envenenado").clone()
    }

    pub fn save_config(&self) -> Result<AppConfig> {
        let snapshot = self.config_snapshot();
        write_config(&snapshot)?;
        Ok(snapshot)
    }
}

fn load_config() -> Result<AppConfig> {
    let path = paths::config_file()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn write_config(config: &AppConfig) -> Result<()> {
    let path = paths::config_file()?;
    let json = serde_json::to_string_pretty(config)?;

    // Escritura atómica: un corte de luz no debe dejar un config a medias.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
