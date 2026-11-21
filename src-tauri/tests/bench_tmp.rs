//! Banco temporal: mide coste real de la transcripción. Se borra tras usarlo.

#![cfg(feature = "whisper")]

use std::path::Path;
use std::time::{Duration, Instant};

use reco_lib::dictation::AudioBuffer;

fn read_wav(path: &Path) -> AudioBuffer {
    let bytes = std::fs::read(path).expect("wav");
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
            b"data" => data = Some(&bytes[pos + 8..(pos + 8 + size).min(bytes.len())]),
            _ => {}
        }
        pos += 8 + size + (size % 2);
    }

    let data = data.expect("data chunk");
    let interleaved: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    let channels = channels.max(1) as usize;
    let frames: Vec<i16> = interleaved
        .chunks_exact(channels)
        .map(|f| (f.iter().map(|&s| s as i32).sum::<i32>() / channels as i32) as i16)
        .collect();

    let samples = if rate == 16_000 {
        frames
    } else {
        let step = rate as f32 / 16_000f32;
        let out_len = (frames.len() as f32 / step) as usize;
        (0..out_len)
            .map(|i| frames[((i as f32 * step) as usize).min(frames.len() - 1)])
            .collect()
    };

    AudioBuffer {
        samples,
        sample_rate: 16_000,
    }
}

/// Regla candidata: contexto ajustado a la duración real, con cola de 0,6 s.
fn tight_ctx(ms: u64) -> i32 {
    let positions = ((ms + 600) / 20) as i32;
    positions.clamp(64, 1500)
}

fn padded(ctx: i32) -> i32 {
    (ctx + 255) / 256 * 256
}

fn pcm_of(audio: &AudioBuffer) -> Vec<f32> {
    audio
        .samples
        .iter()
        .map(|s| *s as f32 / i16::MAX as f32)
        .collect()
}

fn best_of(
    ctx: &whisper_rs::WhisperContext,
    pcm: &[f32],
    threads: i32,
    audio_ctx: i32,
    n: usize,
) -> (Duration, String) {
    let mut best = Duration::from_secs(999);
    let mut text = String::new();
    for _ in 0..n {
        let (d, t) = run(ctx, pcm, threads, audio_ctx);
        if d < best {
            best = d;
        }
        text = t;
    }
    (best, text)
}

#[test]
#[ignore = "banco manual"]
fn bench() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("test-audio");
    let path = reco_lib::dictation::transcriber::model_path("tiny").unwrap();
    let ctx = whisper_rs::WhisperContext::new_with_params(
        path.to_str().unwrap(),
        whisper_rs::WhisperContextParameters::default(),
    )
    .expect("cargar modelo");

    let bench = read_wav(&dir.join("bench.wav"));
    let pcm = pcm_of(&bench);
    let _ = run(&ctx, &pcm, 4, 512);

    println!("== 6 s, ctx ajustado ({}) ==", tight_ctx(bench.duration_ms()));
    for threads in [3i32, 4, 5, 6, 7] {
        let (d, t) = best_of(&ctx, &pcm, threads, tight_ctx(bench.duration_ms()), 2);
        println!("  hilos={threads:<2} {d:>12?}  {t:?}");
    }

    println!("== duración, 4 hilos ==");
    for name in ["short2000.wav", "short3000.wav", "bench.wav"] {
        let audio = read_wav(&dir.join(name));
        let pcm = pcm_of(&audio);
        let ms = audio.duration_ms();
        let tight = tight_ctx(ms);
        let (pa, pb) = (padded(512), padded(tight));
        let (a, ta) = best_of(&ctx, &pcm, 4, 512, 2);
        let (b, tb) = best_of(&ctx, &pcm, 4, tight, 2);
        println!("  {name:<15} {ms:>5} ms | ctx=512 (pad {pa}) {a:>12?} {ta:?}");
        println!("  {:<15} {:>5} ms | ctx={tight:<4}(pad {pb}) {b:>12?} {tb:?}", "", "");
    }
}

fn run(
    ctx: &whisper_rs::WhisperContext,
    pcm: &[f32],
    threads: i32,
    audio_ctx: i32,
) -> (std::time::Duration, String) {
    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(threads);
    params.set_language(Some("es"));
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_no_speech_thold(0.6);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_temperature_inc(0.0);
    params.set_audio_ctx(audio_ctx);
    params.set_initial_prompt(
        "Hola, esto es un dictado en español, con tildes y puntuación correcta.",
    );

    let mut state = ctx.create_state().expect("estado");
    let t = Instant::now();
    state.full(params, pcm).expect("full");
    let elapsed = t.elapsed();

    let mut text = String::new();
    for seg in state.as_iter() {
        if let Ok(s) = seg.to_str() {
            text.push_str(s);
        }
    }
    (elapsed, text.trim().to_string())
}
