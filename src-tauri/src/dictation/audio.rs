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
    ///
    /// `on_level` recibe el RMS de cada bloque (0..1) para el medidor visual.
    pub fn new<F>(device_id: Option<&str>, on_level: F) -> Result<Self>
    where
        F: Fn(f32) + Send + 'static,
    {
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
                        // Se remuestrea **fuera** del candado: el callback de
                        // audio corre en un hilo de tiempo real y no puede
                        // quedarse esperando a que otro hilo suelte el buffer.
                        let mono = resample(data, config.sample_rate.0, config.channels);
                        if let Ok(mut out) = sink.lock() {
                            out.extend_from_slice(&mono);
                        }

                        // Nivel para el indicador, a partir del bloque original.
                        if let Some(rms) = rms_of(data) {
                            on_level(rms);
                        }
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

        // `take` en vez de `clone`: el buffer puede ser de varios MB y ya no lo
        // necesita nadie más; copiarlo solo alarga el silencio tras soltar el
        // atajo.
        let samples = self
            .buffer
            .lock()
            .map(|mut b| std::mem::take(&mut *b))
            .unwrap_or_default();

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

/// Nivel eficaz (RMS) normalizado a 0..1. `None` si el bloque está vacío.
fn rms_of(data: &[f32]) -> Option<f32> {
    if data.is_empty() {
        return None;
    }
    let sum: f32 = data.iter().map(|s| s * s).sum();
    Some((sum / data.len() as f32).sqrt().clamp(0.0, 1.0))
}

/// Remuestrea (por promedio de ventana) y mezcla a mono.
///
/// No basta con tomar una muestra de cada N: al bajar de 48 a 16 kHz, todo lo
/// que haya por encima de 8 kHz se pliega sobre la banda de voz (aliasing) y
/// ensucia la transcripción. Promediar la ventana actúa de filtro paso bajo
/// barato y, en la práctica, se nota en las palabras que el modelo acierta.
///
/// Devuelve las muestras en lugar de escribirlas en el buffer del llamador: así
/// el callback de audio no tiene que retener el `Mutex` mientras remuestrea, que
/// es justo lo que provoca chasquidos y bloqueos cuando el modelo está ocupando
/// la CPU.
fn resample(data: &[f32], rate: u32, channels: u16) -> Vec<i16> {
    if channels == 0 || rate == 0 {
        return Vec::new();
    }

    let channels = channels as usize;
    let frames = data.len() / channels;
    if frames == 0 {
        return Vec::new();
    }

    // Media de los canales de un frame → mono.
    let mono_at = |frame: usize| -> f32 {
        let start = frame * channels;
        data[start..start + channels].iter().sum::<f32>() / channels as f32
    };

    let step = (rate as f32 / SAMPLE_RATE as f32).max(1.0);
    let output_frames = (frames as f32 / step) as usize;
    let mut out = Vec::with_capacity(output_frames);

    for i in 0..output_frames {
        let start = (i as f32 * step) as usize;
        let end = (((i + 1) as f32 * step) as usize).min(frames);
        if start >= frames {
            break;
        }

        let end = end.max(start + 1);
        let mut sum = 0.0f32;
        for frame in start..end {
            sum += mono_at(frame);
        }
        let mono = sum / (end - start) as f32;

        out.push((mono.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }

    out
}

/// Compatibilidad con las pruebas: remuestrea y anexa al buffer.
#[cfg(test)]
fn resample_and_push(out: &mut Vec<i16>, data: &[f32], rate: u32, channels: u16) {
    out.extend_from_slice(&resample(data, rate, channels));
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
