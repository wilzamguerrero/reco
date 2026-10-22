//! Modelo de configuración persistida.
//!
//! Los secretos **no** forman parte de este tipo: viven en el keyring del SO y solo
//! se consulta su existencia (ver `secrets_status`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub dictation: DictationConfig,
    pub recording: RecordingConfig,
    pub notion: NotionConfig,
    pub system: SystemConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            dictation: DictationConfig::default(),
            recording: RecordingConfig::default(),
            notion: NotionConfig::default(),
            system: SystemConfig::default(),
        }
    }
}

impl AppConfig {
    /// Aplica un parche parcial sin destruir el resto de la configuración.
    pub fn apply_patch(&mut self, patch: ConfigPatch) {
        if let Some(v) = patch.dictation {
            self.dictation = v;
        }
        if let Some(v) = patch.recording {
            self.recording = v;
        }
        if let Some(v) = patch.notion {
            self.notion = v;
        }
        if let Some(v) = patch.system {
            self.system = v;
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConfigPatch {
    pub dictation: Option<DictationConfig>,
    pub recording: Option<RecordingConfig>,
    pub notion: Option<NotionConfig>,
    pub system: Option<SystemConfig>,
}

// ---------------------------------------------------------------- dictado

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationConfig {
    pub enabled: bool,
    /// Identificador del atajo global, p. ej. `"CapsLock"` o `"CommandOrControl+Shift+Space"`.
    pub shortcut: String,
    pub mode: DictationMode,
    /// `"auto"` o un código BCP-47 (`"es"`, `"en"`…).
    pub language: String,
    /// Identificador del modelo instalado: `tiny` | `base` | `small` | `medium`.
    pub model_id: String,
    /// Aplica limpieza de muletillas y puntuación tras transcribir.
    pub polish: bool,
    /// Deja el texto en el portapapeles en vez de pegarlo en la ventana activa.
    pub clipboard_only: bool,
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: "CapsLock".into(),
            mode: DictationMode::PushToTalk,
            language: "auto".into(),
            model_id: "base".into(),
            polish: true,
            clipboard_only: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationMode {
    PushToTalk,
    Toggle,
}

// ---------------------------------------------------------------- grabación

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecordingConfig {
    pub fps: u32,
    pub quality: VideoQuality,
    pub system_audio: bool,
    pub microphone_id: Option<String>,
    /// Carpeta temporal; `None` = carpeta por defecto de la aplicación.
    pub save_dir: Option<PathBuf>,
    /// Borra el archivo local tras confirmar la subida. Desactivado por defecto.
    pub delete_local_after_upload: bool,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            quality: VideoQuality::Medium,
            system_audio: true,
            microphone_id: None,
            save_dir: None,
            delete_local_after_upload: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoQuality {
    Low,
    Medium,
    High,
}

// ---------------------------------------------------------------- notion

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotionConfig {
    pub route: NotionRoute,
    pub proxy_base_url: Option<String>,
    /// Base de datos de Notion donde se crea una página por grabación.
    pub database_id: Option<String>,
    /// Alternativa a `database_id`: página padre.
    pub page_id: Option<String>,
}

impl Default for NotionConfig {
    fn default() -> Self {
        Self {
            route: NotionRoute::Proxy,
            proxy_base_url: None,
            database_id: None,
            page_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotionRoute {
    /// A través del proxy de `envi`; el token nunca sale del servidor.
    Proxy,
    /// Directo contra `api.notion.com` con el token del keyring.
    Direct,
}

// ---------------------------------------------------------------- sistema

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SystemConfig {
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub indicator_position: Option<[i32; 2]>,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            launch_at_login: false,
            close_to_tray: true,
            indicator_position: None,
        }
    }
}
