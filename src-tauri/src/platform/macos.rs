//! Capacidades en macOS.
//!
//! Los permisos reales (grabación de pantalla, accesibilidad, micrófono) se
//! comprueban en la Fase 6; aquí solo declaramos lo que la plataforma permite.

use crate::commands::diagnostics::Capabilities;

pub fn capabilities() -> Capabilities {
    Capabilities {
        // ScreenCaptureKit y la inserción con CGEvent llegan en la Fase 6.
        screen_capture: false,
        system_audio: false,
        global_shortcuts: true,
        text_injection: false,
        secure_storage: true,
        local_transcription: cfg!(feature = "whisper"),
    }
}
