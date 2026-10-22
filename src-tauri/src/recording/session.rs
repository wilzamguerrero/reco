//! Sesión de grabación: orquesta captura, encoder y cola de subida.
//!
//! El hilo de captura es el productor; la cola de subida consume fragmentos en
//! cuanto se cierran. Así la subida avanza en paralelo a la grabación (Fase 4).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::recording::encoder::{bgra_to_yuv420p, EncoderConfig, FragmentWriter};
use crate::recording::{create_screen_capturer, CaptureTarget, FrameFormat};

#[derive(Debug, Clone)]
pub struct StartRecordingOptions {
    pub target: CaptureTarget,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub quality: crate::config::VideoQuality,
    pub capture_system_audio: bool,
}

/// Contadores compartidos con la UI vía eventos.
#[derive(Debug, Default)]
pub struct RecordingStats {
    pub elapsed_ms: AtomicU64,
    pub bytes_written: AtomicU64,
    pub dropped_frames: AtomicU64,
    pub segments: AtomicU64,
}

pub struct RecordingSession {
    pub id: String,
    pub dir: PathBuf,
    pub stats: Arc<RecordingStats>,
    stop_flag: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<Result<Vec<PathBuf>>>>,
    started_at: Instant,
}

impl RecordingSession {
    /// Lanza la captura en un hilo propio.
    ///
    /// No devuelve hasta que el hilo confirma que el capturador arrancó de
    /// verdad. Sin esta espera un fallo de inicialización (por ejemplo, una
    /// plataforma sin backend) se perdería en el hilo y la UI mostraría una
    /// grabación fantasma con el cronómetro corriendo y cero frames.
    pub fn start(opts: StartRecordingOptions, dir: PathBuf) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(&dir)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(RecordingStats::default());
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();

        let thread_stop = Arc::clone(&stop_flag);
        let thread_stats = Arc::clone(&stats);
        let thread_dir = dir.clone();

        let handle = std::thread::Builder::new()
            .name("reco-capture".into())
            .spawn(move || capture_loop(opts, thread_dir, thread_stop, thread_stats, ready_tx))
            .map_err(|e| Error::Other(format!("no se pudo iniciar la captura: {e}")))?;

        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = handle.join();
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
            Err(_) => {
                stop_flag.store(true, Ordering::Relaxed);
                let _ = handle.join();
                let _ = std::fs::remove_dir_all(&dir);
                return Err(Error::Other(
                    "la captura no respondió al arrancar".into(),
                ));
            }
        }

        Ok(Self {
            id,
            dir,
            stats,
            stop_flag,
            handle: Some(handle),
            started_at: Instant::now(),
        })
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    /// Detiene la captura y devuelve los fragmentos generados.
    pub fn stop(mut self) -> Result<Vec<PathBuf>> {
        self.stop_flag.store(true, Ordering::Relaxed);
        match self.handle.take() {
            Some(handle) => handle
                .join()
                .map_err(|_| Error::Other("el hilo de captura terminó de forma anómala".into()))?,
            None => Ok(Vec::new()),
        }
    }
}

fn capture_loop(
    opts: StartRecordingOptions,
    dir: PathBuf,
    stop: Arc<AtomicBool>,
    stats: Arc<RecordingStats>,
    ready: std::sync::mpsc::Sender<Result<()>>,
) -> Result<Vec<PathBuf>> {
    let mut capturer = match create_screen_capturer() {
        Ok(c) => c,
        Err(e) => {
            // El llamador está esperando; hay que contarle el motivo real.
            let _ = ready.send(Err(e));
            return Err(Error::Other("captura no disponible".into()));
        }
    };
    let encoder = EncoderConfig::for_quality(opts.width, opts.height, opts.fps, opts.quality);

    let start_result = capturer.start(
        &opts.target,
        FrameFormat {
            width: encoder.width,
            height: encoder.height,
            fps: opts.fps,
        },
    );

    if let Err(e) = start_result {
        let _ = ready.send(Err(e));
        return Err(Error::Other("captura no disponible".into()));
    }

    let mut writer = match FragmentWriter::new(&dir) {
        Ok(w) => w,
        Err(e) => {
            let _ = ready.send(Err(e));
            return Err(Error::Other("no se pudo abrir el destino".into()));
        }
    };
    // La captura ya está viva: a partir de aquí `start` puede devolver OK.
    let _ = ready.send(Ok(()));

    let started = Instant::now();
    let frame_interval = Duration::from_millis(1000 / opts.fps.max(1) as u64);

    while !stop.load(Ordering::Relaxed) {
        let deadline = frame_interval;
        match capturer.next_frame(deadline) {
            Ok(Some(frame)) => {
                let yuv = bgra_to_yuv420p(&frame)?;
                if let Some(_closed) = writer.write_frame(&yuv, &encoder)? {
                    stats.segments.fetch_add(1, Ordering::Relaxed);
                }
                stats
                    .bytes_written
                    .fetch_add(yuv.data.len() as u64, Ordering::Relaxed);
                stats
                    .elapsed_ms
                    .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
            }
            Ok(None) => {
                // Sin frame en el intervalo: no es un error, la pantalla no cambió.
                stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                tracing::error!(%e, "error de captura; se detiene la grabación");
                capturer.stop().ok();
                return Err(e);
            }
        }
    }

    capturer.stop()?;
    writer.finish()
}
