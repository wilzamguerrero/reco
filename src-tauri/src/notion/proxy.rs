//! Ruta proxy: delega en las Pages Functions de `envi`, que guardan el token.
//!
//! Contrato con el proxy (mismo que usa `envi` en su frontend):
//!   POST {base}/api/upload-init     { filename, mimeType, fileSize }
//!   POST {base}/api/upload-part?upload_id=<id>   multipart/form-data
//!   POST {base}/api/upload-complete { uploadId }

use std::future::Future;
use std::pin::Pin;

use bytes::Bytes;
use reqwest::multipart::{Form, Part};
use reqwest::Client;

use crate::error::{Error, Result};
use crate::notion::{CreatedUpload, NotionSink, UploadPlan};

pub struct ProxySink {
    http: Client,
    base: String,
    token: Option<String>,
}

impl ProxySink {
    pub fn new(http: Client, base: String, token: Option<String>) -> Self {
        Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            token,
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let builder = self.http.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }

    async fn ensure_ok(response: reqwest::Response) -> Result<serde_json::Value> {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if status.is_success() {
            return serde_json::from_str(&text).or_else(|_| Ok(serde_json::Value::Null));
        }

        let detail = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| status.to_string());

        Err(Error::Notion(format!("proxy: {status}: {detail}")))
    }
}

impl NotionSink for ProxySink {
    fn create_upload(
        &self,
        plan: &UploadPlan,
    ) -> Pin<Box<dyn Future<Output = Result<CreatedUpload>> + Send + '_>> {
        let body = serde_json::json!({
            "filename": plan.filename,
            "mimeType": plan.content_type,
            "fileSize": plan.file_size,
        });

        Box::pin(async move {
            let response = self
                .request(reqwest::Method::POST, "/api/upload-init")
                .json(&body)
                .send()
                .await?;

            let value = Self::ensure_ok(response).await?;

            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| Error::Notion("el proxy no devolvió un id de upload".into()))?
                .to_string();

            Ok(CreatedUpload {
                id,
                upload_url: None,
                status: value
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
        })
    }

    fn send_part(
        &self,
        upload_id: &str,
        part_number: u32,
        bytes: Bytes,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let path = format!("/api/upload-part?upload_id={}", urlencode(upload_id));

        Box::pin(async move {
            let part = Part::bytes(bytes.to_vec())
                .file_name("chunk")
                .mime_str("application/octet-stream")
                .map_err(|e| Error::Notion(e.to_string()))?;

            let form = Form::new()
                .text("part_number", part_number.to_string())
                .part("file", part);

            let response = self
                .request(reqwest::Method::POST, &path)
                .multipart(form)
                .send()
                .await?;

            Self::ensure_ok(response).await.map(|_| ())
        })
    }

    fn complete_upload(
        &self,
        upload_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let body = serde_json::json!({ "uploadId": upload_id });

        Box::pin(async move {
            let response = self
                .request(reqwest::Method::POST, "/api/upload-complete")
                .json(&body)
                .send()
                .await?;

            Self::ensure_ok(response).await.map(|_| ())
        })
    }

    fn attach_to_page(
        &self,
        _upload_id: &str,
        _title: &str,
        _duration_ms: i64,
        _size_bytes: i64,
    ) -> Pin<Box<dyn Future<Output = Result<(String, Option<String>)>> + Send + '_>> {
        Box::pin(async {
            Err(Error::NotImplemented(
                "el proxy de envi no expone aún la creación de páginas (Fase 4)",
            ))
        })
    }
}

/// Codificación mínima para un id de upload (UUID: solo ASCII seguro).
fn urlencode(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            other => other
                .to_string()
                .bytes()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect()
}
