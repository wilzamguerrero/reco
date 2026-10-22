//! Transcripción de audio a texto.
//!
//! Backend local (`whisper-rs`) por defecto. El trait permite añadir un backend
//! remoto sin tocar el resto del pipeline.

use std::path::{Path, PathBuf};
#[cfg(feature = "whisper")]
use std::sync::Mutex;

use crate::dictation::{AudioBuffer, Transcript};
use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct SttOptions {
    /// `None` = autodetección.
    pub language: Option<String>,
    /// Número de hilos; 0 = dejar que el backend decida.
    pub threads: usize,
}

impl Default for SttOptions {
    fn default() -> Self {
        Self {
            language: None,
            threads: 0,
        }
    }
}

pub trait Transcriber: Send + Sync {
    /// Transcribe el audio completo. Bloqueante: se llama desde un hilo de trabajo.
    fn transcribe(&self, audio: &AudioBuffer, opts: &SttOptions) -> Result<Transcript>;

    /// Identificador del modelo (para mostrar en la UI).
    fn model_id(&self) -> &str;
}

/// Metadata de los modelos descargables.
pub struct ModelInfo {
    pub id: &'static str,
    pub filename: &'static str,
    pub url: &'static str,
    pub size_bytes: u64,
}

/// Catálogo de modelos soportados. Los tamaños son aproximados y se usan solo
/// para la barra de progreso.
pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "tiny",
        filename: "ggml-tiny.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        size_bytes: 77_691_713,
    },
    ModelInfo {
        id: "base",
        filename: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        size_bytes: 147_951_465,
    },
    ModelInfo {
        id: "small",
        filename: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        size_bytes: 487_601_967,
    },
    ModelInfo {
        id: "medium",
        filename: "ggml-medium.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        size_bytes: 1_533_774_781,
    },
];

pub fn model_info(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

/// Ruta local de un modelo, exista o no.
pub fn model_path(id: &str) -> Result<PathBuf> {
    let info = model_info(id)
        .ok_or_else(|| Error::Config(format!("modelo desconocido: {id}")))?;
    Ok(crate::storage::paths::models_dir()?.join(info.filename))
}

pub fn is_installed(id: &str) -> bool {
    model_path(id)
        .map(|p| p.exists() && p.metadata().map(|m| m.len() > 0).unwrap_or(false))
        .unwrap_or(false)
}

/// Implementación con whisper.cpp (crate `whisper-rs`).
///
/// El modelo se carga de forma perezosa y se mantiene entre dictados: cargarlo
/// cuesta cientos de milisegundos y el usuario dicta en ráfagas.
///
/// Solo existe con la feature `whisper`; sin ella `WhisperTranscriber::new`
/// devuelve un error explicativo en vez de impedir la compilación.
pub struct WhisperTranscriber {
    model_id: String,
    #[cfg(feature = "whisper")]
    context: Mutex<Option<whisper_rs::WhisperContext>>,
}

impl WhisperTranscriber {
    pub fn new(model_id: &str) -> Result<Self> {
        if !is_installed(model_id) {
            return Err(Error::Config(format!(
                "el modelo «{model_id}» no está descargado"
            )));
        }

        #[cfg(not(feature = "whisper"))]
        {
            return Err(Error::NotImplemented(
                "el motor Whisper no está compilado en esta versión",
            ));
        }

        #[cfg(feature = "whisper")]
        Ok(Self {
            model_id: model_id.to_string(),
            context: Mutex::new(None),
        })
    }

    #[cfg(feature = "whisper")]
    fn context(&self) -> Result<std::sync::MutexGuard<'_, Option<whisper_rs::WhisperContext>>> {
        let mut guard = self.context.lock().expect("contexto envenenado");
        if guard.is_none() {
            let path = model_path(&self.model_id)?;
            let ctx = whisper_rs::WhisperContext::new_with_params(
                path.to_str()
                    .ok_or_else(|| Error::Other("ruta de modelo no válida".into()))?,
                whisper_rs::WhisperContextParameters::default(),
            )
            .map_err(|e| Error::Other(format!("no se pudo cargar el modelo: {e}")))?;
            *guard = Some(ctx);
        }
        Ok(guard)
    }
}

#[cfg(feature = "whisper")]
impl Transcriber for WhisperTranscriber {
    fn transcribe(&self, audio: &AudioBuffer, opts: &SttOptions) -> Result<Transcript> {
        if audio.is_empty() {
            return Ok(Transcript {
                text: String::new(),
                language: None,
            });
        }

        let mut guard = self.context()?;
        let ctx = guard
            .as_mut()
            .ok_or_else(|| Error::Other("modelo no cargado".into()))?;

        let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy {
            best_of: 1,
        });
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_n_threads(if opts.threads == 0 { 4 } else { opts.threads as i32 });
        params.set_language(opts.language.as_deref());

        // Whisper espera f32 normalizado entre -1 y 1.
        let pcm: Vec<f32> = audio
            .samples
            .iter()
            .map(|s| *s as f32 / i16::MAX as f32)
            .collect();

        let mut state = ctx
            .create_state()
            .map_err(|e| Error::Other(format!("no se pudo crear el estado: {e}")))?;

        state
            .full(params, &pcm)
            .map_err(|e| Error::Other(format!("fallo al transcribir: {e}")))?;

        let mut text = String::new();
        for segment in state.as_iter() {
            if let Ok(chunk) = segment.to_str() {
                text.push_str(chunk);
            }
        }

        Ok(Transcript {
            text: text.trim().to_string(),
            language: opts.language.clone(),
        })
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }
}

#[cfg(not(feature = "whisper"))]
impl Transcriber for WhisperTranscriber {
    fn transcribe(&self, _audio: &AudioBuffer, _opts: &SttOptions) -> Result<Transcript> {
        Err(Error::NotImplemented(
            "el motor Whisper no está compilado en esta versión",
        ))
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }
}

/// Comprueba que la ruta del modelo existe y tiene tamaño plausible.
pub fn validate_model_file(path: &Path, expected_min: u64) -> Result<()> {
    let meta = std::fs::metadata(path)
        .map_err(|e| Error::Config(format!("modelo no accesible: {e}")))?;
    if meta.len() < expected_min / 2 {
        return Err(Error::Config(
            "el archivo del modelo está incompleto; vuelve a descargarlo".into(),
        ));
    }
    Ok(())
}
