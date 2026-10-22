//! Caché de transcriptores por modelo.
//!
//! Cargar un modelo de Whisper cuesta entre 200 ms y varios segundos según el
//! tamaño. El usuario dicta en ráfagas, así que el contexto se guarda y se
//! reutiliza entre dictados; solo se reemplaza si cambia el modelo elegido.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::dictation::transcriber::{Transcriber, WhisperTranscriber};
use crate::error::Result;

#[derive(Default)]
pub struct TranscriberCache {
    inner: Mutex<HashMap<String, Arc<dyn Transcriber>>>,
}

impl TranscriberCache {
    /// Devuelve el transcriptor del modelo, creándolo la primera vez.
    ///
    /// Se mantiene un único modelo activo: al cambiar de modelo se vacía la
    /// caché para no retener varios GB en memoria.
    pub fn get(&self, model_id: &str) -> Result<Arc<dyn Transcriber>> {
        let mut guard = self.inner.lock().expect("caché envenenada");

        if let Some(existing) = guard.get(model_id) {
            return Ok(Arc::clone(existing));
        }

        let transcriber: Arc<dyn Transcriber> = Arc::new(WhisperTranscriber::new(model_id)?);
        guard.clear();
        guard.insert(model_id.to_string(), Arc::clone(&transcriber));

        Ok(transcriber)
    }

    /// Suelta el modelo cargado (por ejemplo, al borrarlo del disco).
    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.clear();
        }
    }
}
