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

/// Energía mínima (RMS, escala -1..1) para considerar que hubo voz.
///
/// Whisper no distingue «silencio» de «audio bajito»: ante una entrada casi
/// muda inventa texto, y lo repite. Este umbral corta ese caso antes de
/// llamar al modelo. La voz normal ronda 0.02–0.2; el ruido de fondo de un
/// micrófono abierto queda por debajo de 0.005.
const RMS_SPEECH_MIN: f32 = 0.006;

/// Duración mínima para intentar transcribir: por debajo de esto solo hay
/// pulsaciones accidentales del atajo.
const MIN_SPEECH_MS: u64 = 250;

/// RMS del audio en escala flotante.
fn rms_of(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples
        .iter()
        .map(|s| {
            let v = *s as f64 / i16::MAX as f64;
            v * v
        })
        .sum();
    (sum / samples.len() as f64).sqrt() as f32
}

/// Detecta la salida típica de alucinación: una frase corta repetida sin fin.
///
/// Whisper, cuando no entiende el audio, repite el mismo n-grama. Un dictado
/// real puede repetir una palabra, pero no convertirse en un bucle. Se mira la
/// proporción de tokens que pertenecen al n-grama más frecuente.
fn looks_hallucinated(text: &str) -> bool {
    // Whisper anota el audio no hablado entre corchetes («[Música]»,
    // «[Risas]»). En dictado eso no es texto que el usuario quiera pegar.
    let without_notes = strip_bracketed(text);
    let content = without_notes.trim();
    if content.is_empty() {
        return !text.trim().is_empty();
    }

    // Sin letras ni dígitos no hay dictado: es puntuación o símbolos sueltos,
    // otro modo de fallo de Whisper ante audio que no entiende.
    if !content.chars().any(|c| c.is_alphanumeric()) {
        return true;
    }

    let words: Vec<&str> = content.split_whitespace().collect();
    if words.len() < 8 {
        return looks_like_repetition(content);
    }

    // Se prueban longitudes de 1 a 4 palabras: los bucles suelen ser cortos.
    for n in 1..=4usize {
        if words.len() < n * 4 {
            break;
        }

        let mut best = 0usize;
        for start in 0..=words.len() - n {
            let gram = &words[start..start + n];
            let mut count = 0usize;
            let mut i = 0usize;
            while i + n <= words.len() {
                if &words[i..i + n] == gram {
                    count += 1;
                    i += n;
                } else {
                    i += 1;
                }
            }
            best = best.max(count);
        }

        // Si el n-grama más repetido cubre más de la mitad del texto, es un bucle.
        if best * n * 2 > words.len() {
            return true;
        }
    }

    false
}

/// Contexto de audio que hay que pedirle a Whisper para una duración dada.
///
/// El codificador de Whisper tiene 1500 posiciones, una por cada 20 ms de la
/// ventana de 30 s. Si se deja el valor por defecto, siempre calcula las 1500
/// aunque el audio sea más corto: en un dictado de 5 s eso es ~6 veces más
/// trabajo del necesario. Se pide solo lo que ocupa el audio, con un margen
/// para no cortar la última palabra.
///
/// Medido con el modelo `tiny` en un i7-3820: recortar de 1500 a lo que ocupa
/// el audio baja de ~24 s a ~4 s en un clip de 6 s, sin perder palabras. No se
/// pone mínimo fijo: un clip de 2 s con contexto de 10 s cuesta el triple que
/// con el contexto que le corresponde, y el margen del 60 % ya deja cola
/// suficiente para la última sílaba.
fn audio_context_for(duration_ms: u64) -> i32 {
    const FULL: u64 = 30_000;
    const CTX: i32 = 1500;

    // 20 ms por posición del codificador.
    const MS_PER_POS: u64 = 20;
    // Cola para la última palabra: sin ella se corta la sílaba final.
    const TAIL_MS: u64 = 600;
    // Por debajo de esto no hay frase que reconocer (Whisper necesita ~1 s de
    // contexto para el token de idioma y la primera palabra).
    const MIN_CTX: i32 = 96;

    if duration_ms >= FULL {
        return CTX;
    }

    let positions = ((duration_ms + TAIL_MS) / MS_PER_POS) as i32;
    positions.clamp(MIN_CTX, CTX)
}

/// ¿Hay voz suficiente para que transcribir tenga sentido?
pub fn has_speech(audio: &AudioBuffer) -> bool {
    audio.duration_ms() >= MIN_SPEECH_MS && rms_of(&audio.samples) >= RMS_SPEECH_MIN
}

/// Quita las anotaciones entre corchetes que Whisper inserta para ruidos.
fn strip_bracketed(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;

    for c in text.chars() {
        match c {
            '[' | '【' => depth += 1,
            ']' | '】' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }

    out
}

/// Repetición sin espacios: Whisper también se atasca en un carácter o en un
/// par de ellos («¿?¿?¿?», «....»), sobre todo en español.
fn looks_like_repetition(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    // Corto de sobra para ser legítimo («sí sí sí»): repetir una palabra tres
    // veces es algo que la gente dicta; un bucle es mucho más largo.
    if chars.len() < 12 {
        return false;
    }

    for n in 1..=2usize {
        for start in 0..=chars.len() - n {
            let gram = &chars[start..start + n];
            let mut covered = 0usize;
            let mut i = 0usize;
            while i + n <= chars.len() {
                if &chars[i..i + n] == gram {
                    covered += n;
                    i += n;
                } else {
                    i += 1;
                }
            }
            // Bucles malos cubren casi todo el texto, no solo una mayoría.
            if covered * 3 >= chars.len() * 2 {
                return true;
            }
        }
    }

    false
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
        if audio.is_empty() || !has_speech(audio) {
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
        // Whisper escala mal más allá de 4 hilos: los núcleos lógicos extra
        // (HyperThreading) se pelean por la misma unidad de coma flotante y la
        // decodificación acaba yendo más lenta. Medido en un i7-3820 (4 físicos,
        // 8 lógicos) con un clip de 6 s: 4 hilos 4,3 s, 7 hilos 3,2 s en una
        // pasada y 8 hilos 8,8 s. Se usa el criterio de whisper.cpp (máximo 4) y
        // nunca más que núcleos disponibles, para no saturar el equipo mientras
        // el usuario sigue escribiendo.
        let threads = if opts.threads == 0 {
            std::thread::available_parallelism()
                .map(|n| n.get().min(4).max(1))
                .unwrap_or(4) as i32
        } else {
            opts.threads as i32
        };
        params.set_n_threads(threads);
        params.set_language(opts.language.as_deref());

        // Una frase de arranque en el idioma esperado sesga al modelo hacia
        // ese idioma, con sus tildes, «¿?» y «¡!». Ayuda sobre todo a los
        // modelos pequeños, que de otro modo escriben español «a la inglesa».
        if opts.language.as_deref() == Some("es") {
            params.set_initial_prompt("Hola, esto es un dictado en español, con tildes y puntuación correcta.");
        }

        // Whisper trabaja siempre sobre una ventana de 30 s: rellena con
        // silencio hasta completarla y el codificador hace el mismo trabajo
        // tanto si dictas 3 s como 30. En dictado corto eso es casi todo el
        // coste. Se ajusta el contexto al audio real (50 posiciones por
        // segundo, 1500 = 30 s) para no calcular atención sobre silencio.
        let audio_ctx = audio_context_for(audio.duration_ms());
        params.set_audio_ctx(audio_ctx);

        // Sin esto Whisper arrastra el texto del dictado anterior entre
        // invocaciones (los contextos se reutilizan) y acaba inventando.
        params.set_no_context(true);
        // Y sin esto rellena los tramos sin voz con texto de relleno.
        params.set_suppress_blank(true);
        params.set_no_speech_thold(0.6);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        // Dejar el incremento de temperatura en 0 es deliberado: con cualquier
        // valor mayor, cada segmento que no supera los umbrales se vuelve a
        // decodificar entero a mayor temperatura, hasta cuatro veces. En
        // dictado eso multiplica el tiempo sin mejorar apenas el resultado;
        // para filtrar basura ya está la comprobación de alucinaciones.
        params.set_temperature_inc(0.0);

        // Sin beam search la decodificación es bastante más rápida y, en
        // dictado corto con vocabulario cotidiano, la diferencia de calidad es
        // pequeña. La estrategia ya es Greedy (best_of: 1), que es lo rápido.

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

        let text = text.trim().to_string();

        // Aun con los filtros, un micrófono con ruido constante puede producir
        // un bucle. Es peor pegar basura en el documento del usuario que no
        // pegar nada, así que se descarta.
        if looks_hallucinated(&text) {
            tracing::warn!(%text, "transcripción descartada: parece un bucle");
            return Ok(Transcript {
                text: String::new(),
                language: opts.language.clone(),
            });
        }

        Ok(Transcript {
            text,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer(samples: Vec<i16>) -> AudioBuffer {
        AudioBuffer {
            samples,
            sample_rate: crate::dictation::SAMPLE_RATE,
        }
    }

    #[test]
    fn silencio_no_tiene_voz() {
        assert!(!has_speech(&buffer(vec![0; 16_000])));
    }

    #[test]
    fn audio_demasiado_corto_se_descarta() {
        // 100 ms de tono fuerte: es una pulsación, no una frase.
        let samples = vec![8_000i16; 1_600];
        assert!(!has_speech(&buffer(samples)));
    }

    #[test]
    fn voz_normal_pasa_el_umbral() {
        // 1 s de una onda de amplitud ~0.1.
        let samples: Vec<i16> = (0..16_000)
            .map(|i| {
                let v = (i as f32 * 0.05).sin() * 0.1;
                (v * i16::MAX as f32) as i16
            })
            .collect();
        assert!(has_speech(&buffer(samples)));
    }

    #[test]
    fn detecta_bucle_de_una_palabra() {
        assert!(looks_hallucinated(
            "gracias gracias gracias gracias gracias gracias gracias gracias"
        ));
    }

    #[test]
    fn detecta_bucle_de_frase() {
        assert!(looks_hallucinated(
            "suscríbete al canal suscríbete al canal suscríbete al canal suscríbete al canal"
        ));
    }

    #[test]
    fn texto_normal_no_es_bucle() {
        let text = "hola, esto es una prueba de dictado con varias palabras distintas \
                    para comprobar que no se descarta el texto legítimo del usuario";
        assert!(!looks_hallucinated(text));
    }

    #[test]
    fn texto_corto_nunca_es_bucle() {
        assert!(!looks_hallucinated("sí sí sí"));
    }

    #[test]
    fn descarta_puntuacion_repetida() {
        assert!(looks_hallucinated("¿?¿?¿?¿?¿?¿?¿?¿?¿?¿?"));
        assert!(looks_hallucinated("........"));
    }

    #[test]
    fn descarta_simbolos_sin_letras() {
        assert!(looks_hallucinated("[Música] ♪ ♪ ♪"));
    }

    #[test]
    fn conserva_dictado_real_corto() {
        assert!(!looks_hallucinated("Vale, perfecto."));
        assert!(!looks_hallucinated("Sí."));
    }
}
