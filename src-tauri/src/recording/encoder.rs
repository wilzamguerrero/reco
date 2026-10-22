//! Codificación de video: H.264 en fragmentos MP4.
//!
//! La unidad de trabajo es el **fragmento** (~10 s). Cada fragmento cerrado se
//! entrega al escritor, que lo vuelca a disco y avisa a la cola de subida.
//! Esa es la pieza que permite que la subida no dependa de que termine la
//! grabación.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::recording::{Frame, FramePixelFormat};

/// Duración objetivo de cada fragmento. Debe ser menor que el `keyframe`
/// interval del encoder para que cada fragmento empiece en un I-frame.
pub const FRAGMENT_SECONDS: u32 = 10;

/// Configuración del codificador.
#[derive(Debug, Clone, Copy)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
    /// Fuerza un I-frame cada N frames. Igual a `fps * FRAGMENT_SECONDS`.
    pub keyframe_interval: u32,
}

impl EncoderConfig {
    pub fn for_quality(width: u32, height: u32, fps: u32, quality: crate::config::VideoQuality) -> Self {
        use crate::config::VideoQuality;

        // Bitrate como función de píxeles y fps; valores de partida razonables
        // para contenido de pantalla (no cámara), donde hay muchas zonas planas.
        let pixels_per_second = width as u64 * height as u64 * fps as u64;
        let factor = match quality {
            VideoQuality::Low => 0.06,
            VideoQuality::Medium => 0.11,
            VideoQuality::High => 0.20,
        };

        Self {
            width: width & !1,  // H.264 exige dimensiones pares
            height: height & !1,
            fps,
            bitrate_bps: ((pixels_per_second as f64 * factor) as u32)
                .clamp(500_000, 20_000_000),
            keyframe_interval: fps * FRAGMENT_SECONDS,
        }
    }
}

/// Escritor de fragmentos en disco.
///
/// En esta fase escribe los frames crudos de cada fragmento a un archivo
/// independiente; el muxer MP4 definitivo se conecta en la Fase 3, cuando el
/// encoder nativo esté disponible. Mantener el límite en esta interfaz evita
/// reescribir la sesión cuando se añada el muxer.
pub struct FragmentWriter {
    dir: PathBuf,
    fragment_index: u32,
    current: Option<std::fs::File>,
    bytes_in_fragment: u64,
    frames_in_fragment: u32,
    total_bytes: u64,
}

impl FragmentWriter {
    pub fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            fragment_index: 0,
            current: None,
            bytes_in_fragment: 0,
            frames_in_fragment: 0,
            total_bytes: 0,
        })
    }

    /// Escribe un frame y cierra el fragmento si corresponde.
    ///
    /// Devuelve `Some(ruta)` cuando un fragmento acaba de cerrarse.
    pub fn write_frame(&mut self, frame: &Frame, config: &EncoderConfig) -> Result<Option<PathBuf>> {
        if self.current.is_none() {
            let path = self.dir.join(format!("seg-{:05}.h264", self.fragment_index));
            self.current = Some(std::fs::File::create(&path)?);
            self.bytes_in_fragment = 0;
            self.frames_in_fragment = 0;
            tracing::debug!(fragment = self.fragment_index, "fragmento iniciado");
        }

        let file = self
            .current
            .as_mut()
            .ok_or_else(|| Error::Other("fragmento sin archivo abierto".into()))?;

        // Placeholder de tamaño hasta conectar el encoder real: se escribe el
        // tamaño del frame seguido de los píxeles.
        file.write_all(&(frame.data.len() as u32).to_le_bytes())?;
        file.write_all(&frame.data)?;
        file.write_all(&frame.pts_us.to_le_bytes())?;

        self.bytes_in_fragment += frame.data.len() as u64;
        self.total_bytes += frame.data.len() as u64;
        self.frames_in_fragment += 1;

        let should_rotate = frame.pts_us
            >= (self.fragment_index as i64 + 1) * FRAGMENT_SECONDS as i64 * 1_000_000
            && (frame.pts_us % (config.keyframe_interval as i64 * 1_000_000 / config.fps as i64)) == 0;

        if should_rotate {
            return self.finish_fragment().map(Some);
        }

        Ok(None)
    }

    /// Cierra el fragmento en curso, si lo hay.
    pub fn finish_fragment(&mut self) -> Result<PathBuf> {
        let file = self
            .current
            .take()
            .ok_or_else(|| Error::Other("no hay fragmento abierto".into()))?;
        file.sync_all()?;
        drop(file);

        let path = self
            .dir
            .join(format!("seg-{:05}.h264", self.fragment_index));
        tracing::debug!(
            fragment = self.fragment_index,
            bytes = self.bytes_in_fragment,
            frames = self.frames_in_fragment,
            "fragmento cerrado"
        );

        self.fragment_index += 1;
        Ok(path)
    }

    /// Cierra todo y devuelve las rutas de los fragmentos, en orden.
    pub fn finish(mut self) -> Result<Vec<PathBuf>> {
        if self.current.is_some() {
            self.finish_fragment()?;
        }

        let mut paths = Vec::with_capacity(self.fragment_index as usize);
        for i in 0..self.fragment_index {
            paths.push(self.dir.join(format!("seg-{i:05}.h264")));
        }
        Ok(paths)
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub fn fragment_index(&self) -> u32 {
        self.fragment_index
    }
}

/// Convierte un frame BGRA a YUV420p (lo que necesita H.264).
///
/// Coeficientes BT.709, que es lo que asume la mayoría de reproductores para HD.
pub fn bgra_to_yuv420p(frame: &Frame) -> Result<Frame> {
    if frame.format == FramePixelFormat::Yuv420p {
        return Ok(frame.clone());
    }

    let width = frame.width as usize;
    let height = frame.height as usize;
    if frame.data.len() < width * height * 4 {
        return Err(Error::Other("frame BGRA incompleto".into()));
    }

    let y_size = width * height;
    let uv_size = y_size / 4;
    let mut out = vec![0u8; y_size + uv_size * 2];

    let (y_plane, uv_plane) = out.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_plane.split_at_mut(uv_size);

    for row in 0..height {
        for col in 0..width {
            let src = (row * width + col) * 4;
            let b = frame.data[src] as f32;
            let g = frame.data[src + 1] as f32;
            let r = frame.data[src + 2] as f32;

            let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            y_plane[row * width + col] = y.clamp(0.0, 255.0) as u8;

            // Submuestreo 2x2: solo se calcula en las posiciones pares.
            if row % 2 == 0 && col % 2 == 0 {
                let uv_index = (row / 2) * (width / 2) + (col / 2);
                u_plane[uv_index] = (-0.1146 * r - 0.3854 * g + 0.5 * b + 128.0)
                    .clamp(0.0, 255.0) as u8;
                v_plane[uv_index] = (0.5 * r - 0.4542 * g - 0.0458 * b + 128.0)
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }

    Ok(Frame {
        data: out,
        format: FramePixelFormat::Yuv420p,
        width: frame.width,
        height: frame.height,
        pts_us: frame.pts_us,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensiones_pares() {
        let cfg = EncoderConfig::for_quality(1367, 769, 30, crate::config::VideoQuality::Medium);
        assert_eq!(cfg.width % 2, 0);
        assert_eq!(cfg.height % 2, 0);
    }

    #[test]
    fn conversion_yuv_tiene_tamano_correcto() {
        let frame = Frame {
            data: vec![128u8; 4 * 4 * 4],
            format: FramePixelFormat::Bgra,
            width: 4,
            height: 4,
            pts_us: 0,
        };
        let yuv = bgra_to_yuv420p(&frame).unwrap();
        assert_eq!(yuv.data.len(), 16 + 4 + 4);
    }

    #[test]
    fn gris_neutro_da_y_aproximado() {
        let frame = Frame {
            data: vec![128u8; 4 * 4 * 4],
            format: FramePixelFormat::Bgra,
            width: 4,
            height: 4,
            pts_us: 0,
        };
        let yuv = bgra_to_yuv420p(&frame).unwrap();
        // Y ≈ 128, U ≈ 128, V ≈ 128
        assert!((yuv.data[0] as i32 - 128).abs() <= 2);
    }
}
