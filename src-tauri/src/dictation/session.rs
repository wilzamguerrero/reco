//! Ciclo de vida de una sesión de dictado.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::dictation::audio::MicrophoneRecorder;
use crate::dictation::engine::TranscriberCache;
use crate::dictation::inject::{self, WindowHandle};
use crate::dictation::polish;
use crate::dictation::transcriber::SttOptions;
use crate::dictation::{AudioBuffer, Transcript};
use crate::error::Result;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Recording,
    Transcribing,
    Inserting,
    Done,
}

pub struct DictationSession {
    pub id: u64,
    recorder: Option<MicrophoneRecorder>,
    /// Ventana que tenía el foco al empezar; se usa para pegar el resultado.
    pub target_window: Option<WindowHandle>,
    started_at: std::time::Instant,
    pub phase: SessionPhase,
}

impl DictationSession {
    pub fn start(microphone_id: Option<&str>) -> Result<Self> {
        let target_window = inject::foreground_window();
        let recorder = MicrophoneRecorder::new(microphone_id)?;

        Ok(Self {
            id: SESSION_COUNTER.fetch_add(1, Ordering::Relaxed),
            recorder: Some(recorder),
            target_window,
            started_at: std::time::Instant::now(),
            phase: SessionPhase::Recording,
        })
    }

    /// Detiene la captura y transcribe en el hilo actual.
    ///
    /// Se llama desde un hilo de trabajo (`spawn_blocking`) porque la
    /// transcripción es CPU-intensiva. `cache` conserva el modelo cargado
    /// entre dictados.
    pub fn stop_and_transcribe(
        mut self,
        cache: &TranscriberCache,
        model_id: &str,
        language: Option<&str>,
        apply_polish: bool,
    ) -> Result<Transcript> {
        let recorder = self
            .recorder
            .take()
            .ok_or_else(|| crate::error::Error::Other("sesión sin grabador".into()))?;

        let audio: AudioBuffer = recorder.stop();
        self.phase = SessionPhase::Transcribing;

        let transcriber = cache.get(model_id)?;
        let opts = SttOptions {
            language: language.map(str::to_string),
            threads: 0,
        };

        let mut transcript = transcriber.transcribe(&audio, &opts)?;

        if apply_polish {
            transcript.text = polish::polish(&transcript.text);
        }

        self.phase = SessionPhase::Done;
        Ok(transcript)
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    /// Cancela sin transcribir: detiene el micrófono y descarta el audio.
    pub fn cancel(mut self) {
        if let Some(recorder) = self.recorder.take() {
            let _ = recorder.stop();
        }
    }
}
