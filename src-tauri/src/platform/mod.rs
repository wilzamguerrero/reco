//! Abstracción de plataforma.
//!
//! Cada SO implementa sus capacidades en su propio módulo. El resto del núcleo
//! solo consulta `capabilities()` y usa los traits definidos en los módulos de
//! captura/dictado, nunca APIs del sistema directamente.

#[cfg(windows)]
pub mod windows;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;

#[cfg(windows)]
pub use windows::capabilities;
#[cfg(target_os = "macos")]
pub use macos::capabilities;
#[cfg(target_os = "linux")]
pub use linux::capabilities;

/// Implementación de reserva para plataformas no soportadas: todo desactivado.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn capabilities() -> crate::commands::diagnostics::Capabilities {
    crate::commands::diagnostics::Capabilities {
        screen_capture: false,
        system_audio: false,
        global_shortcuts: false,
        text_injection: false,
        secure_storage: false,
        local_transcription: cfg!(feature = "whisper"),
    }
}
