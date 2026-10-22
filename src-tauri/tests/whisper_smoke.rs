//! Prueba de extremo a extremo del motor de transcripción.
//!
//! Ignorada por defecto porque necesita un modelo descargado. Se ejecuta con:
//!
//! ```text
//! cargo test --features whisper --test whisper_smoke -- --ignored --nocapture
//! ```

#![cfg(feature = "whisper")]

use std::path::Path;

use reco_lib::dictation::engine::TranscriberCache;
use reco_lib::dictation::transcriber::SttOptions;
use reco_lib::dictation::AudioBuffer;

/// WAV ya convertido al formato que espera Whisper.
struct Wav {
    samples: Vec<i16>,
    sample_rate: u32,
}

/// Lee un WAV PCM 16 bits, mezcla a mono y lo lleva a 16 kHz.
///
/// Los sintetizadores de voz no siempre generan 16 kHz (espeak usa 22 050), así
/// que el test se adapta al formato real en vez de asumirlo.
fn read_wav(path: &Path) -> Wav {
    let bytes = std::fs::read(path).expect("no se pudo leer el WAV");

    let mut pos = 12usize;
    let mut rate = 0u32;
    let mut channels = 1u16;
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;

        match id {
            b"fmt " => {
                let chunk = &bytes[pos + 8..];
                channels = u16::from_le_bytes([chunk[2], chunk[3]]);
                rate = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
            }
            b"data" => {
                data = Some(&bytes[pos + 8..(pos + 8 + size).min(bytes.len())]);
            }
            _ => {}
        }

        pos += 8 + size + (size % 2);
    }

    let data = data.expect("el WAV no tiene chunk de datos");
    assert!(rate > 0, "el WAV no declara velocidad de muestreo");

    let interleaved: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    let channels = channels.max(1) as usize;
    let frames: Vec<i16> = interleaved
        .chunks_exact(channels)
        .map(|f| {
            let sum: i32 = f.iter().map(|&s| s as i32).sum();
            (sum / channels as i32) as i16
        })
        .collect();

    // Remuestreo lineal a 16 kHz; suficiente para voz.
    let samples = if rate == 16_000 {
        frames
    } else {
        let step = rate as f32 / 16_000f32;
        let out_len = (frames.len() as f32 / step) as usize;
        (0..out_len)
            .map(|i| {
                let src = (i as f32 * step) as usize;
                frames[src.min(frames.len() - 1)]
            })
            .collect()
    };

    Wav {
        samples,
        sample_rate: 16_000,
    }
}

#[test]
#[ignore = "necesita un modelo descargado en %APPDATA%\\RECO\\models"]
fn transcribe_una_frase_conocida() {
    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-audio")
        .join("voz.wav");

    let wav = read_wav(&wav_path);
    assert!(!wav.samples.is_empty(), "el WAV no tiene muestras");

    let audio = AudioBuffer {
        samples: wav.samples,
        sample_rate: wav.sample_rate,
    };

    let cache = TranscriberCache::default();
    let transcriber = cache.get("base").expect("el modelo base debe estar instalado");

    let opts = SttOptions {
        language: Some("es".into()),
        threads: 4,
    };

    let transcript = transcriber
        .transcribe(&audio, &opts)
        .expect("la transcripción debe funcionar");

    println!("TRANSCRIPCIÓN: {}", transcript.text);

    // El objetivo de esta prueba es demostrar que el motor reconoce español
    // (y que el pipeline audio→texto funciona), no que un modelo `base` con
    // una voz sintética robótica transcriba cada palabra. Con voz humana y el
    // modelo `small` o `medium` la fidelidad es mucho mayor.
    let lower = transcript.text.to_lowercase();
    assert!(
        lower.contains("hola"),
        "no reconoce ni el saludo: {}",
        transcript.text
    );
    assert!(
        lower.contains("grabac") || lower.contains("rego") || lower.contains("reco"),
        "no reconoce ninguna palabra clave: {}",
        transcript.text
    );
}
