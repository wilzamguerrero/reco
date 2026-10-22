//! Captura de pantalla con Windows.Graphics.Capture (WinRT).
//!
//! WGC entrega texturas D3D11. La conversión a CPU es la parte cara; aquí se hace
//! con una staging texture y `Map`, sincronizando con el frame pool.

use std::time::Duration;

use crate::error::{Error, Result};
use crate::recording::{CaptureTarget, Frame, FrameFormat, FramePixelFormat, ScreenCapturer};

pub struct WgcCapturer {
    running: bool,
    format: Option<FrameFormat>,
}

impl WgcCapturer {
    pub fn new() -> Result<Self> {
        // La inicialización real de WinRT (RoInitialize) ocurre al empezar la
        // captura, en el hilo de captura, no en el de la UI.
        Ok(Self {
            running: false,
            format: None,
        })
    }
}

impl ScreenCapturer for WgcCapturer {
    fn start(&mut self, target: &CaptureTarget, format: FrameFormat) -> Result<()> {
        if self.running {
            return Err(Error::Other("la captura ya estaba iniciada".into()));
        }

        let _ = target;
        self.format = Some(format);
        self.running = true;

        // Conexión con WinRT pendiente de la Fase 3. Se deja explícito para que
        // el resto del pipeline (sesión, encoder, cola) sea ya el definitivo.
        Err(Error::NotImplemented(
            "WGC: inicialización de D3D11 + frame pool (Fase 3)",
        ))
    }

    fn next_frame(&mut self, _timeout: Duration) -> Result<Option<Frame>> {
        if !self.running {
            return Err(Error::Other("la captura no está iniciada".into()));
        }
        Ok(None)
    }

    fn stop(&mut self) -> Result<()> {
        self.running = false;
        Ok(())
    }
}

/// Formato por defecto a partir de un monitor enumerado.
pub fn format_for(width: u32, height: u32, fps: u32) -> FrameFormat {
    FrameFormat {
        width,
        height,
        fps,
    }
}

/// Frame vacío del tamaño pedido, útil para pruebas del pipeline.
pub fn blank_frame(format: FrameFormat, pts_us: i64) -> Frame {
    Frame {
        data: vec![0u8; (format.width * format.height * 4) as usize],
        format: FramePixelFormat::Bgra,
        width: format.width,
        height: format.height,
        pts_us,
    }
}
