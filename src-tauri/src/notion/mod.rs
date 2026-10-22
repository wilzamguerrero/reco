//! Cliente de Notion.
//!
//! Toda la API de archivos está aislada tras `NotionSink` para que un cambio en
//! la API (que sigue en beta) solo afecte a la implementación concreta.
//!
//! Parámetros portados de `references/envi` y verificados en §7.2 de
//! `ARCHITECTURE.md`.

pub mod direct;
pub mod meta;
pub mod proxy;

use bytes::Bytes;
use serde::{Deserialize, Serialize};

pub const NOTION_BASE: &str = "https://api.notion.com/v1";
pub const NOTION_VERSION: &str = "2026-03-11";

pub const CHUNK_SIZE: u64 = 10 * 1024 * 1024;
pub const MULTI_PART_THRESHOLD: u64 = 20 * 1024 * 1024;
pub const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024 * 1024;

/// Resultado de crear un upload remoto.
#[derive(Debug, Clone, Deserialize)]
pub struct CreatedUpload {
    pub id: String,
    /// URL de envío devuelta por Notion; si falta se compone con `NOTION_BASE`.
    pub upload_url: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UploadPlan {
    pub filename: String,
    pub content_type: String,
    pub file_size: u64,
    pub multi_part: bool,
    pub number_of_parts: u32,
}

impl UploadPlan {
    /// Calcula el plan de subida a partir del nombre y tamaño reales.
    ///
    /// Notion exige `number_of_parts` al crear el upload, así que el tamaño debe
    /// ser definitivo: no se puede empezar una grabación en multipart.
    pub fn new(filename: &str, file_size: u64) -> crate::error::Result<Self> {
        if file_size > MAX_FILE_SIZE {
            return Err(crate::error::Error::Notion(format!(
                "el archivo supera el límite de {} GiB de Notion",
                MAX_FILE_SIZE / 1024 / 1024 / 1024
            )));
        }

        let (upload_name, content_type) = meta::resolve_upload_meta(filename);

        let multi_part = file_size > MULTI_PART_THRESHOLD;
        let number_of_parts = if multi_part {
            file_size.div_ceil(CHUNK_SIZE) as u32
        } else {
            1
        };

        Ok(Self {
            filename: upload_name,
            content_type,
            file_size,
            multi_part,
            number_of_parts,
        })
    }
}

/// Interface común para las dos rutas de subida.
///
/// Se usa `async_trait` manual vía `dyn` para no añadir la dependencia: los
/// métodos devuelven `BoxFuture`.
pub trait NotionSink: Send + Sync {
    fn create_upload(
        &self,
        plan: &UploadPlan,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = crate::error::Result<CreatedUpload>> + Send + '_>>;

    fn send_part(
        &self,
        upload_id: &str,
        part_number: u32,
        bytes: Bytes,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = crate::error::Result<()>> + Send + '_>>;

    fn complete_upload(
        &self,
        upload_id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = crate::error::Result<()>> + Send + '_>>;

    /// Crea la página de Notion con el video adjunto y devuelve (page_id, url).
    fn attach_to_page(
        &self,
        upload_id: &str,
        title: &str,
        duration_ms: i64,
        size_bytes: i64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::error::Result<(String, Option<String>)>> + Send + '_>,
    >;
}

/// Construye el sink según la ruta configurada.
pub fn sink_from_config(
    config: &crate::config::NotionConfig,
    http: reqwest::Client,
) -> crate::error::Result<Box<dyn NotionSink>> {
    match config.route {
        crate::config::NotionRoute::Direct => {
            let token = crate::secrets::get(crate::secrets::SecretKey::NotionToken)?
                .ok_or_else(|| {
                    crate::error::Error::Config(
                        "falta el token de Notion en el almacén seguro".into(),
                    )
                })?;
            Ok(Box::new(direct::DirectSink::new(http, token)))
        }
        crate::config::NotionRoute::Proxy => {
            let base = config.proxy_base_url.clone().ok_or_else(|| {
                crate::error::Error::Config("falta la URL del proxy de Notion".into())
            })?;
            let token = crate::secrets::get(crate::secrets::SecretKey::ProxyToken)?;
            Ok(Box::new(proxy::ProxySink::new(http, base, token)))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotionErrorBody {
    pub code: Option<String>,
    pub message: Option<String>,
}
