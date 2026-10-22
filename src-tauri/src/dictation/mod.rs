//! Motor de dictado: audio → texto → inserción.
//!
//! Los tres pasos están separados por traits para poder sustituir cualquiera sin
//! tocar los otros (ver `ARCHITECTURE.md` §5).

pub mod audio;
pub mod download;
pub mod engine;
pub mod hotkey;
pub mod inject;
pub mod polish;
pub mod session;
pub mod transcriber;

pub use session::DictationSession;

/// Tamaño de bloque que espera Whisper: 16 kHz, mono, i16.
pub const SAMPLE_RATE: u32 = 16_000;

/// Fragmento de audio ya convertido al formato del transcriptor.
#[derive(Debug, Clone, Default)]
pub struct AudioBuffer {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
}

impl AudioBuffer {
    pub fn duration_ms(&self) -> u64 {
        if self.sample_rate == 0 {
            return 0;
        }
        (self.samples.len() as u64 * 1000) / self.sample_rate as u64
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
}
