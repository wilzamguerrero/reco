//! Ciclo de vida del dictado disparado por el atajo o por la UI.
//!
//! Comando y atajo comparten estas funciones para que el indicador, los eventos
//! y la inserción se comporten igual sin importar cómo se inició la sesión.

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::dictation::{ActiveDictation, TranscribingGuard};
use crate::dictation::inject;
use crate::dictation::session::DictationSession;
use crate::error::{Error, Result};
use crate::state::AppState;

/// Arranca una sesión de dictado si no hay otra en curso.
pub fn start(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let active = app.state::<ActiveDictation>();
    let guard_flag = app.state::<TranscribingGuard>();
    let config = state.config_snapshot();

    if !config.dictation.enabled {
        return Err(Error::Config("el dictado está desactivado".into()));
    }

    // Mientras el modelo trabaja no se puede empezar otra sesión: el contexto
    // de Whisper es único y la segunda transcripción se quedaría esperándolo.
    if guard_flag.is_active() {
        return Err(Error::Config(
            "todavía se está transcribiendo el dictado anterior".into(),
        ));
    }

    let mut guard = active.0.lock().expect("dictado envenenado");
    if guard.is_some() {
        return Err(Error::Config("ya hay un dictado en curso".into()));
    }

    // El nivel se emite desde el hilo de audio; se limita para no saturar el IPC.
    let handle = app.clone();
    let session = DictationSession::start(
        config.recording.microphone_id.as_deref(),
        move |rms| {
            let _ = handle.emit("dictation:level", serde_json::json!({ "rms": rms }));
        },
    )?;

    *guard = Some(session);
    drop(guard);

    crate::indicator::show(app);

    let _ = app.emit(
        "dictation:state",
        serde_json::json!({ "state": "listening" }),
    );

    Ok(())
}

/// Detiene la sesión, transcribe e inserta el texto.
///
/// La transcripción es CPU-intensiva, así que corre en su propio hilo y la
/// llamada devuelve enseguida. El resultado se comunica por eventos.
pub fn stop(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let active = app.state::<ActiveDictation>();
    let guard_flag = app.state::<TranscribingGuard>();

    // Si ya se está transcribiendo no hay nada que parar: el atajo se soltó
    // después de que el dictado anterior terminara. Devolver error aquí haría
    // que el manejador del atajo registrara un fallo en cada pulsación normal.
    if !guard_flag.acquire() {
        return Ok(());
    }

    let session = {
        let mut guard = active.0.lock().expect("dictado envenenado");
        match guard.take() {
            Some(session) => session,
            None => {
                // No había sesión: se devuelve el turno para no bloquear el
                // siguiente dictado.
                guard_flag.release();
                return Err(Error::Config("no hay ningún dictado en curso".into()));
            }
        }
    };

    let config = state.config_snapshot();
    let model_id = config.dictation.model_id.clone();
    let language = if config.dictation.language == "auto" {
        None
    } else {
        Some(config.dictation.language.clone())
    };
    let apply_polish = config.dictation.polish;
    let clipboard_only = config.dictation.clipboard_only;
    // La ventana de destino se fija **al empezar**, no al terminar: para cuando
    // la transcripción acaba han pasado segundos y el foco puede estar en
    // cualquier otro sitio (o en RECO). Pegar en la ventana equivocada es peor
    // que no pegar nada.
    let target_window = session.target_window;
    let handle = app.clone();
    let cache = std::sync::Arc::clone(&state.transcribers);

    let _ = app.emit(
        "dictation:state",
        serde_json::json!({ "state": "transcribing" }),
    );

    std::thread::Builder::new()
        .name("reco-transcribe".into())
        .spawn(move || {
            let result =
                session.stop_and_transcribe(&cache, &model_id, language.as_deref(), apply_polish);

            match result {
                Ok(transcript) if !transcript.text.is_empty() => {
                    let _ = handle.emit(
                        "dictation:state",
                        serde_json::json!({ "state": "inserting" }),
                    );

                    // Se devuelve el foco a la ventana que lo tenía al empezar.
                    let outcome = if clipboard_only {
                        inject::write_clipboard(&transcript.text)
                    } else {
                        inject::inject(&transcript.text, target_window).map(|_| ())
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
                Ok(_) => {
                    // Sin texto no hay nada que insertar, pero el usuario
                    // necesita saber por qué: micrófono mudo, silencio o una
                    // pulsación demasiado corta.
                    tracing::debug!("dictado vacío; no se inserta nada");
                    let _ = handle.emit(
                        "dictation:notice",
                        serde_json::json!({
                            "message": "No se detectó voz. Mantén el atajo mientras hablas."
                        }),
                    );
                }
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

            crate::indicator::hide(&handle);
            let _ = handle.emit("dictation:state", serde_json::json!({ "state": "idle" }));

            // Se libera el turno al final, pase lo que pase: si no, un fallo
            // dejaría el dictado bloqueado hasta reiniciar la aplicación.
            handle.state::<TranscribingGuard>().release();
        })
        .map_err(|e| {
            // El hilo no llegó a arrancar: el turno vuelve a estar libre.
            guard_flag.release();
            Error::Other(format!("no se pudo lanzar la transcripción: {e}"))
        })?;

    Ok(())
}

/// Cancela la sesión sin transcribir.
pub fn cancel(app: &AppHandle) -> Result<()> {
    let active = app.state::<ActiveDictation>();

    let session = {
        let mut guard = active.0.lock().expect("dictado envenenado");
        guard.take()
    };

    if let Some(session) = session {
        session.cancel();
    }

    crate::indicator::hide(app);
    let _ = app.emit("dictation:state", serde_json::json!({ "state": "idle" }));
    Ok(())
}

/// Si hay una sesión de grabación abierta (el micrófono está capturando).
pub fn is_recording(app: &AppHandle) -> bool {
    app.try_state::<ActiveDictation>()
        .and_then(|a| a.0.lock().ok().map(|g| g.is_some()))
        .unwrap_or(false)
}

/// Si el modelo está transcribiendo el dictado anterior.
pub fn is_transcribing(app: &AppHandle) -> bool {
    app.try_state::<TranscribingGuard>()
        .map(|g| g.is_active())
        .unwrap_or(false)
}

/// Si hay una sesión activa o una transcripción en curso.
///
/// Incluye la transcripción a propósito: mientras el modelo trabaja el atajo
/// debe seguir «ocupado», o una segunda pulsación arrancaría otra sesión y su
/// transcripción se quedaría esperando el contexto de Whisper.
pub fn is_running(app: &AppHandle) -> bool {
    is_recording(app) || is_transcribing(app)
}
