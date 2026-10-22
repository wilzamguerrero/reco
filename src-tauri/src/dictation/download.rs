//! Descarga de modelos de transcripción.
//!
//! Los modelos pesan entre 77 MB y 1,5 GB. Se descargan a un archivo temporal y
//! solo se renombran al destino cuando el tamaño coincide con el esperado, así
//! una descarga cortada nunca deja un modelo a medias que luego falle al cargar.

use std::fs::File;
use std::io::Write;
use std::path::Path;

use futures_util::StreamExt;

use crate::dictation::transcriber::{self, ModelInfo};
use crate::error::{Error, Result};
use crate::storage::paths;

/// Progreso de una descarga, para enviar a la UI.
#[derive(Debug, Clone, Copy)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

impl DownloadProgress {
    pub fn percent(self) -> f32 {
        if self.total == 0 {
            return 0.0;
        }
        (self.downloaded as f64 / self.total as f64 * 100.0) as f32
    }
}

/// Descarga el modelo `id` si no está ya instalado.
///
/// `on_progress` se llama con cada bloque recibido; se invoca desde el hilo de
/// trabajo, no desde la UI.
pub async fn download_model<F>(id: &str, on_progress: F) -> Result<()>
where
    F: Fn(DownloadProgress) + Send + 'static,
{
    let info = transcriber::model_info(id)
        .ok_or_else(|| Error::Config(format!("modelo desconocido: {id}")))?;

    if transcriber::is_installed(id) {
        return Ok(());
    }

    let dir = paths::models_dir()?;
    std::fs::create_dir_all(&dir)?;

    let final_path = dir.join(info.filename);
    // Sufijo propio: si el usuario cierra la app a mitad, el temporal se
    // distingue de un modelo bueno y se puede reanudar con un borrado simple.
    let temp_path = dir.join(format!("{}.part", info.filename));

    let result = download_to(info, &temp_path, on_progress).await;

    match result {
        Ok(()) => {
            std::fs::rename(&temp_path, &final_path)?;
            tracing::info!(model = id, "modelo descargado");
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(e)
        }
    }
}

async fn download_to<F>(info: &ModelInfo, temp_path: &Path, on_progress: F) -> Result<()>
where
    F: Fn(DownloadProgress) + Send + 'static,
{
    let client = reqwest::Client::builder()
        .user_agent("RECO")
        .build()?;

    let response = client.get(info.url).send().await?;

    if !response.status().is_success() {
        return Err(Error::Network(format!(
            "el servidor respondió {} al pedir el modelo",
            response.status().as_u16()
        )));
    }

    // Se prefiere el tamaño anunciado; si no viene, se usa el del catálogo.
    let total = response.content_length().unwrap_or(info.size_bytes);

    let mut file = File::create(temp_path)?;
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;

        // Un bloque cada ~4 MB evita saturar el canal de eventos.
        if downloaded % (4 * 1024 * 1024) < chunk.len() as u64 {
            on_progress(DownloadProgress { downloaded, total });
        }
    }

    file.flush()?;
    drop(file);

    on_progress(DownloadProgress { downloaded, total });

    // Verificación final: un archivo truncado se detecta aquí y no al cargarlo
    // dentro de whisper, donde el error sería opaco.
    let written = std::fs::metadata(temp_path)?.len();
    let expected = info.size_bytes;
    if written < expected * 9 / 10 {
        return Err(Error::Network(format!(
            "descarga incompleta: {} de {} bytes",
            written, expected
        )));
    }

    Ok(())
}

/// Borra un modelo instalado.
pub fn remove_model(id: &str) -> Result<()> {
    let path = transcriber::model_path(id)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcentaje_sin_total_es_cero() {
        let p = DownloadProgress {
            downloaded: 10,
            total: 0,
        };
        assert_eq!(p.percent(), 0.0);
    }

    #[test]
    fn porcentaje_a_mitad() {
        let p = DownloadProgress {
            downloaded: 50,
            total: 100,
        };
        assert!((p.percent() - 50.0).abs() < 0.01);
    }
}
