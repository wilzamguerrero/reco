//! Comandos de grabación.
//!
//! La lógica está en funciones libres que reciben `&AppHandle`, y los comandos
//! Tauri solo las envuelven. Así la bandeja puede grabar y detener sin pasar
//! por el WebView.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::recording::session::{RecordingSession, StartRecordingOptions};
use crate::recording::CaptureTarget;
use crate::state::AppState;
use crate::storage::paths;

/// Grabación en curso, si la hay.
pub struct ActiveRecording(pub Mutex<Option<RecordingSession>>);

impl Default for ActiveRecording {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInput {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInput {
    pub fps: u32,
    pub quality: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub target: TargetInput,
    pub video: VideoInput,
    pub system_audio: bool,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub session_id: String,
    pub dir: String,
}

#[tauri::command]
pub fn recording_start(
    state: State<'_, AppState>,
    active: State<'_, ActiveRecording>,
    options: StartInput,
) -> Result<StartResponse> {
    start_impl(state.inner(), active.inner(), options)
}

fn start_impl(
    state: &AppState,
    active: &ActiveRecording,
    options: StartInput,
) -> Result<StartResponse> {
    let mut guard = active.0.lock().expect("grabación envenenada");
    if guard.is_some() {
        return Err(Error::Config("ya hay una grabación en curso".into()));
    }

    let config = state.config_snapshot();

    let target = match options.target.kind.as_str() {
        "screen" => CaptureTarget::Screen {
            id: options.target.id,
        },
        "window" => CaptureTarget::Window {
            id: options.target.id,
        },
        other => {
            return Err(Error::Config(format!(
                "tipo de destino no soportado: {other}"
            )))
        }
    };

    let quality = match options.video.quality.as_str() {
        "low" => crate::config::VideoQuality::Low,
        "high" => crate::config::VideoQuality::High,
        _ => crate::config::VideoQuality::Medium,
    };

    let dir = paths::recordings_dir()?.join(uuid::Uuid::new_v4().to_string());

    let session = RecordingSession::start(
        StartRecordingOptions {
            target,
            width: options.width.max(2),
            height: options.height.max(2),
            fps: options.video.fps.clamp(15, 60),
            quality,
            capture_system_audio: options.system_audio && config.recording.system_audio,
        },
        dir.clone(),
    )?;

    let session_id = session.id.clone();
    *guard = Some(session);

    crate::tray::set_recording(true);

    let _ = state.app_handle.emit(
        "recording:started",
        serde_json::json!({ "sessionId": session_id }),
    );

    Ok(StartResponse {
        session_id,
        dir: dir.display().to_string(),
    })
}

#[tauri::command]
pub async fn recording_stop(
    state: State<'_, AppState>,
    active: State<'_, ActiveRecording>,
) -> Result<StopResponse> {
    stop_impl(state.inner(), active.inner()).await
}

async fn stop_impl(state: &AppState, active: &ActiveRecording) -> Result<StopResponse> {
    let session = {
        let mut guard = active.0.lock().expect("grabación envenenada");
        guard
            .take()
            .ok_or_else(|| Error::Config("no hay ninguna grabación en curso".into()))?
    };

    let duration_ms = session.elapsed_ms();
    let bytes = session
        .stats
        .bytes_written
        .load(std::sync::atomic::Ordering::Relaxed);

    let fragments = tauri::async_runtime::spawn_blocking(move || session.stop())
        .await
        .map_err(|e| Error::Other(format!("la grabación se interrumpió: {e}")))??;

    crate::tray::set_recording(false);

    let _ = state.app_handle.emit(
        "recording:stopped",
        serde_json::json!({ "fragments": fragments.len() }),
    );

    Ok(StopResponse {
        duration_ms,
        bytes,
        fragments: fragments.len() as u32,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResponse {
    pub duration_ms: u64,
    pub bytes: u64,
    pub fragments: u32,
}

#[tauri::command]
pub fn recording_cancel(
    state: State<'_, AppState>,
    active: State<'_, ActiveRecording>,
) -> Result<()> {
    cancel_impl(state.inner(), active.inner())
}

fn cancel_impl(state: &AppState, active: &ActiveRecording) -> Result<()> {
    let session = {
        let mut guard = active.0.lock().expect("grabación envenenada");
        guard.take()
    };

    if let Some(session) = session {
        // Descartar: se detiene y se borra el directorio temporal.
        let dir = session.dir.clone();
        let _ = session.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    crate::tray::set_recording(false);

    let _ = state.app_handle.emit(
        "recording:canceled",
        serde_json::json!({}),
    );
    Ok(())
}

// ------------------------------------------------------- llamadas desde la bandeja

/// Si hay una grabación activa.
pub fn is_recording(app: &AppHandle) -> bool {
    app.state::<ActiveRecording>()
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// Inicia una grabación con la configuración guardada, sin pasar por la UI.
///
/// Usa el monitor primario con el tamaño que reporta el sistema; si el backend
/// de captura aún no está listo devuelve el mismo error explícito que la UI.
pub fn start_from_tray(app: &AppHandle, width: u32, height: u32) -> Result<()> {
    let config = app.state::<AppState>().config_snapshot();
    let options = StartInput {
        target: TargetInput {
            kind: "screen".into(),
            id: "primary".into(),
        },
        video: VideoInput {
            fps: config.recording.fps.clamp(15, 60),
            quality: match config.recording.quality {
                crate::config::VideoQuality::Low => "low".to_string(),
                crate::config::VideoQuality::Medium => "medium".to_string(),
                crate::config::VideoQuality::High => "high".to_string(),
            },
        },
        system_audio: config.recording.system_audio,
        width,
        height,
    };

    let state = app.state::<AppState>();
    let active = app.state::<ActiveRecording>();
    start_impl(state.inner(), active.inner(), options).map(|_| ())
}

/// Detiene la grabación activa desde la bandeja.
pub fn stop_from_tray(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let active = app.state::<ActiveRecording>();
    tauri::async_runtime::block_on(stop_impl(state.inner(), active.inner())).map(|_| ())
}

/// Tamaño físico del monitor primario, o 1920×1080 si el sistema no lo reporta.
pub fn primary_screen_size(app: &AppHandle) -> (u32, u32) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size();
            (size.width.max(2), size.height.max(2))
        })
        .unwrap_or((1920, 1080))
}
