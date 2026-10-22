//! Capacidades en Linux.
//!
//! Wayland bloquea los atajos globales y la captura sin portal, así que v1 exige
//! una sesión X11. La detección se hace por variables de entorno.

use crate::commands::diagnostics::Capabilities;

pub fn capabilities() -> Capabilities {
    let wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some();

    Capabilities {
        // La captura en Linux (XShm / portal PipeWire) llega en la Fase 6.
        screen_capture: false,
        system_audio: false,
        global_shortcuts: !wayland,
        text_injection: !wayland,
        secure_storage: true,
        local_transcription: cfg!(feature = "whisper"),
    }
}
