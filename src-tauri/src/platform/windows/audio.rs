//! Audio del sistema en Windows mediante WASAPI en modo loopback.
//!
//! WASAPI entrega el audio del renderizador en modo compartido, ya mezclado con
//! lo que suene en el equipo. Es la única forma soportada de capturar "lo que se
//! oye" sin instalar un dispositivo virtual.

use crate::error::{Error, Result};
use crate::recording::AudioCapturer;

pub struct WasapiLoopback {
    running: bool,
    sample_rate: u32,
    channels: u16,
}

impl WasapiLoopback {
    pub fn new() -> Result<Self> {
        Ok(Self {
            running: false,
            sample_rate: 48_000,
            channels: 1,
        })
    }
}

impl AudioCapturer for WasapiLoopback {
    fn start(&mut self, _device: Option<&str>) -> Result<()> {
        if self.running {
            return Err(Error::Other("el audio del sistema ya estaba activo".into()));
        }

        // La inicialización de IAudioClient en modo loopback llega en la Fase 3.
        // Se falla de forma explícita para que la sesión no grabe video sin audio
        // creyendo que sí lo tiene.
        Err(Error::NotImplemented(
            "WASAPI loopback: inicialización de IAudioClient (Fase 3)",
        ))
    }

    fn read(&mut self) -> Result<Vec<f32>> {
        if !self.running {
            return Err(Error::Other("el audio no está iniciado".into()));
        }
        Ok(Vec::new())
    }

    fn stop(&mut self) -> Result<()> {
        self.running = false;
        Ok(())
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn channels(&self) -> u16 {
        self.channels
    }
}
