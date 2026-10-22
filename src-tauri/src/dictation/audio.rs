//! Captura de micrófono.
//!
//! La entrada del dispositivo suele venir a 44.1/48 kHz; se remuestrea a 16 kHz
//! mono porque es lo que espera Whisper y reduce el coste del modelo.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::dictation::{AudioBuffer, SAMPLE_RATE};
use crate::error::{Error, Result};

/// Grabador de micrófono activo.
pub struct MicrophoneRecorder {
    stop_flag: Arc<AtomicBool>,
    buffer: Arc<Mutex<Vec<i16>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl MicrophoneRecorder {
    /// Crea el grabador. Los argumentos de captura se configuran aquí porque
    /// algunos backends no permiten cambiar el dispositivo a mitad de captura.
    pub fn new(device_id: Option<&str>) -> Result<Self> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let buffer = Arc::new(Mutex::new(Vec::new()));

        let device = pick_device(device_id)?;
        let config = pick_config(&device)?;

        let stop = Arc::clone(&stop_flag);
        let sink = Arc::clone(&buffer);

        let handle = std::thread::Builder::new()
            .name("reco-mic".into())
            .spawn(move || {

                let err_fn = |err| tracing::error!(%err, "error en el flujo de micrófono");

                let stream = match device.build_input_stream(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut out = sink.lock().expect("buffer envenenado");
                        resample_and_push(&mut out, data, config.sample_rate.0, config.channels);
                    },
                    err_fn,
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!(%e, "no se pudo abrir el micrófono");
                        return;
                    }
                };

                if let Err(e) = stream.play() {
                    tracing::error!(%e, "no se pudo iniciar el micrófono");
                    return;
                }

                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }

                drop(stream);
                tracing::debug!("micrófono cerrado");
            })
            .map_err(|e| Error::Other(format!("no se pudo crear el hilo de audio: {e}")))?;

        Ok(Self {
            stop_flag,
            buffer,
            handle: Some(handle),
        })
    }

    /// Detiene la captura y devuelve el audio en 16 kHz mono.
    pub fn stop(mut self) -> AudioBuffer {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }

        let samples = self
            .buffer
            .lock()
            .expect("buffer envenenado")
            .clone();

        AudioBuffer {
            samples,
            sample_rate: SAMPLE_RATE,
        }
    }
}

fn pick_device(device_id: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();

    if let Some(id) = device_id {
        let devices = host
            .input_devices()
            .map_err(|e| Error::Other(format!("no se pudo enumerar micrófonos: {e}")))?;

        for device in devices {
            if device.name().map(|n| n == id).unwrap_or(false) {
                return Ok(device);
            }
        }
        tracing::warn!(id, "micrófono configurado no encontrado; se usa el predeterminado");
    }

    host.default_input_device()
        .ok_or_else(|| Error::Other("no hay micrófono disponible".into()))
}

fn pick_config(device: &cpal::Device) -> Result<cpal::StreamConfig> {
    let supported = device
        .default_input_config()
        .map_err(|e| Error::Other(format!("micrófono sin configuración válida: {e}")))?;

    Ok(supported.config())
}

/// Remuestrea (por decimación lineal) y mezcla a mono.
///
/// Es suficiente para voz: Whisper vuelve a normalizar internamente y el error
/// de un diezmado lineal a 16 kHz es despreciable para STT.
fn resample_and_push(out: &mut Vec<i16>, data: &[f32], rate: u32, channels: u16) {
    if channels == 0 || rate == 0 {
        return;
    }

    let channels = channels as usize;
    let frames = data.len() / channels;
    let ratio = rate as f32 / SAMPLE_RATE as f32;

    let step = ratio.max(1.0);
    let output_frames = (frames as f32 / step) as usize;
    out.reserve(output_frames);

    for i in 0..output_frames {
        let src = (i as f32 * step) as usize;
        if src >= frames {
            break;
        }

        // Media de los canales del frame → mono.
        let start = src * channels;
        let sum: f32 = data[start..start + channels].iter().sum();
        let mono = sum / channels as f32;

        out.push((mono.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decima_de_48k_a_16k() {
        let mut out = Vec::new();
        let data = vec![0.5f32; 48_000]; // 1 s a 48 kHz mono
        resample_and_push(&mut out, &data, 48_000, 1);
        // ~16 000 muestras de salida
        assert!((out.len() as i64 - 16_000).abs() < 20, "len = {}", out.len());
    }

    #[test]
    fn mezcla_estereo_a_mono() {
        let mut out = Vec::new();
        let data = vec![1.0f32, 0.0]; // L=1.0, R=0.0
        resample_and_push(&mut out, &data, 16_000, 2);
        assert_eq!(out.len(), 1);
        assert!((out[0] as i32 - 16_383).abs() < 10);
    }
}
