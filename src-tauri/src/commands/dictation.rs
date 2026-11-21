//! Comandos de dictado.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, State};

use crate::dictation::inject::{self, InjectionReport};
use crate::dictation::session::DictationSession;
use crate::dictation::transcriber;
use crate::error::Result;
use crate::state::AppState;

/// Sesiones activas, indexadas por id. Solo puede haber una a la vez, pero se
/// guarda como mapa para que un `stop` tardío no cierre una sesión nueva.
pub struct ActiveDictation(pub Mutex<Option<DictationSession>>);

impl Default for ActiveDictation {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Marca que hay una transcripción en curso.
///
/// Al soltar el atajo la sesión sale del mutex enseguida, pero el modelo sigue
/// trabajando en su hilo. Sin esta marca, pulsar otra vez crearía una segunda
/// sesión y su transcripción se quedaría esperando el contexto de Whisper, que
/// está tomado: el orbe giraría sin fin y el equipo acabaría con todos los
/// núcleos ocupados. Se usa para rechazar el arranque y avisar por qué.
pub struct TranscribingGuard(pub AtomicBool);

impl Default for TranscribingGuard {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

impl TranscribingGuard {
    /// Reserva la transcripción. `false` si ya había una en curso.
    pub fn acquire(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    pub fn is_active(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResponse {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: u64,
    pub model_id: String,
    pub polish_applied: bool,
}

#[tauri::command]
pub fn dictation_start(
    state: State<'_, AppState>,
    _active: State<'_, ActiveDictation>,
    mode: Option<String>,
) -> Result<StartResponse> {
    crate::dictation::controller::start(&state.app_handle)?;

    let _ = state.app_handle.emit(
        "dictation:state",
        serde_json::json!({ "state": "listening", "mode": mode }),
    );

    Ok(StartResponse {
        session_id: String::new(),
    })
}

#[tauri::command]
pub async fn dictation_stop(
    state: State<'_, AppState>,
    _active: State<'_, ActiveDictation>,
) -> Result<StopResponse> {
    let config = state.config_snapshot();
    let model_id = config.dictation.model_id.clone();

    crate::dictation::controller::stop(&state.app_handle)?;

    // El texto llega por `dictation:result` cuando termina la transcripción.
    Ok(StopResponse {
        text: String::new(),
        language: None,
        duration_ms: 0,
        model_id,
        polish_applied: config.dictation.polish,
    })
}

#[tauri::command]
pub fn dictation_cancel(
    state: State<'_, AppState>,
    _active: State<'_, ActiveDictation>,
) -> Result<()> {
    crate::dictation::controller::cancel(&state.app_handle)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectResponse {
    pub method: String,
    pub ok: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn dictation_inject(
    state: State<'_, AppState>,
    text: String,
    clipboard_only: Option<bool>,
) -> Result<InjectResponse> {
    let config = state.config_snapshot();
    let force_clipboard = clipboard_only.unwrap_or(config.dictation.clipboard_only);

    let report: InjectionReport = if force_clipboard {
        inject::write_clipboard(&text)?;
        InjectionReport {
            method: inject::InjectionMethod::Clipboard,
            ok: true,
            reason: None,
        }
    } else {
        // El handle de la ventana se captura al empezar a dictar; aquí se usa el
        // que esté en primer plano si no lo tenemos.
        inject::inject(&text, inject::foreground_window())?
    };

    Ok(InjectResponse {
        method: report.method.as_str().to_string(),
        ok: report.ok,
        reason: report.reason,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub installed: bool,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn models_status() -> Vec<ModelStatus> {
    transcriber::MODELS
        .iter()
        .map(|m| ModelStatus {
            id: m.id.to_string(),
            installed: transcriber::is_installed(m.id),
            size_bytes: m.size_bytes,
        })
        .collect()
}

/// Descarga un modelo emitiendo `models:progress` y `models:state`.
///
/// La descarga corre en el runtime de Tokio; el comando devuelve cuando el
/// archivo ya está verificado y renombrado.
#[tauri::command]
pub async fn models_install(state: State<'_, AppState>, id: String) -> Result<()> {
    let handle = state.app_handle.clone();

    let _ = handle.emit(
        "models:state",
        serde_json::json!({ "id": id, "state": "downloading" }),
    );

    let handle_for_progress = handle.clone();
    let id_for_progress = id.clone();
    let result = crate::dictation::download::download_model(&id, move |p| {
        let _ = handle_for_progress.emit(
            "models:progress",
            serde_json::json!({
                "id": id_for_progress,
                "downloaded": p.downloaded,
                "total": p.total,
                "percent": p.percent()
            }),
        );
    })
    .await;

    match &result {
        Ok(()) => {
            let _ = handle.emit(
                "models:state",
                serde_json::json!({ "id": id, "state": "installed" }),
            );
        }
        Err(e) => {
            let _ = handle.emit(
                "models:state",
                serde_json::json!({
                    "id": id,
                    "state": "failed",
                    "error": e.to_string()
                }),
            );
        }
    }

    result
}

/// Borra un modelo descargado para liberar espacio.
///
/// También suelta el modelo cargado en memoria: en Windows un archivo con el
/// motor abierto no se puede borrar.
#[tauri::command]
pub fn models_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    state.transcribers.clear();
    crate::dictation::download::remove_model(&id)
}
