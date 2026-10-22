//! Modo Windows: captura (WGC), audio (WASAPI) y monitores.

pub mod audio;
pub mod capture;
pub mod display;

pub fn capabilities() -> crate::commands::diagnostics::Capabilities {
    crate::commands::diagnostics::Capabilities {
        // WGC y WASAPI loopback son la vía prevista, pero el backend todavía no
        // captura: se informa `false` para no prometer lo que no funciona.
        screen_capture: false,
        system_audio: false,
        global_shortcuts: true,
        text_injection: true,
        secure_storage: true,
        local_transcription: cfg!(feature = "whisper"),
    }
}
