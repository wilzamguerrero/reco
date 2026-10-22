//! Captura de pantalla y audio.
//!
//! La implementación concreta vive en `platform/`; aquí solo están los traits y
//! los tipos que comparten todos los backends.

pub mod encoder;
pub mod session;

use crate::error::Result;

/// Origen de la captura.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureTarget {
    /// Monitor completo.
    Screen { id: String },
    /// Ventana concreta.
    Window { id: String },
    /// Región rectangular en coordenadas físicas.
    Region {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct FrameFormat {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// Frame de video en formato YUV420p o BGRA listo para el encoder.
#[derive(Debug, Clone)]
pub struct Frame {
    pub data: Vec<u8>,
    pub format: FramePixelFormat,
    pub width: u32,
    pub height: u32,
    /// Marca de tiempo en microsegundos desde el inicio de la sesión.
    pub pts_us: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePixelFormat {
    Bgra,
    Yuv420p,
}

/// Capturador de video.
pub trait ScreenCapturer: Send {
    fn start(&mut self, target: &CaptureTarget, format: FrameFormat) -> Result<()>;
    fn next_frame(&mut self, timeout: std::time::Duration) -> Result<Option<Frame>>;
    fn stop(&mut self) -> Result<()>;
}

/// Capturador de audio. Devuelve f32 entrelazado.
pub trait AudioCapturer: Send {
    fn start(&mut self, device: Option<&str>) -> Result<()>;
    /// Lee lo disponible sin bloquear; puede devolver un vector vacío.
    fn read(&mut self) -> Result<Vec<f32>>;
    fn stop(&mut self) -> Result<()>;
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u16;
}

/// Crea el capturador de pantalla de la plataforma actual.
pub fn create_screen_capturer() -> Result<Box<dyn ScreenCapturer>> {
    #[cfg(windows)]
    {
        Ok(Box::new(crate::platform::windows::capture::WgcCapturer::new()?))
    }
    #[cfg(target_os = "macos")]
    {
        Err(crate::error::Error::NotImplemented(
            "captura en macOS (Fase 6)",
        ))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Err(crate::error::Error::NotImplemented(
            "captura en Linux (Fase 6)",
        ))
    }
}

/// Crea el capturador de audio del sistema (loopback).
pub fn create_system_audio_capturer() -> Result<Box<dyn AudioCapturer>> {
    #[cfg(windows)]
    {
        Ok(Box::new(crate::platform::windows::audio::WasapiLoopback::new()?))
    }
    #[cfg(not(windows))]
    {
        Err(crate::error::Error::NotImplemented(
            "audio del sistema fuera de Windows (Fase 6)",
        ))
    }
}
