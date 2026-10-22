//! Ruta directa: RECO habla con `api.notion.com` usando el token del keyring.

use std::future::Future;
use std::pin::Pin;

use bytes::Bytes;
use reqwest::multipart::{Form, Part};
use reqwest::Client;

use crate::error::{Error, Result};
use crate::notion::{
    CreatedUpload, NotionErrorBody, NotionSink, UploadPlan, NOTION_BASE, NOTION_VERSION,
};

pub struct DirectSink {
    http: Client,
    token: String,
}

impl DirectSink {
    pub fn new(http: Client, token: String) -> Self {
        Self { http, token }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{NOTION_BASE}{path}"))
            .bearer_auth(&self.token)
            .header("Notion-Version", NOTION_VERSION)
    }

    async fn ensure_ok(response: reqwest::Response) -> Result<serde_json::Value> {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if status.is_success() {
            return serde_json::from_str(&text)
                .map_err(|e| Error::Notion(format!("respuesta inválida de Notion: {e}")));
        }

        // Se conserva el código de Notion pero nunca el cuerpo completo (puede
        // contener identificadores internos).
        let detail = serde_json::from_str::<NotionErrorBody>(&text)
            .ok()
            .and_then(|b| b.message.or(b.code))
            .unwrap_or_else(|| status.to_string());

        Err(Error::Notion(format!("{status}: {detail}")))
    }
}

impl NotionSink for DirectSink {
    fn create_upload(
        &self,
        plan: &UploadPlan,
    ) -> Pin<Box<dyn Future<Output = Result<CreatedUpload>> + Send + '_>> {
        let body = serde_json::json!({
            "filename": plan.filename,
            "content_type": plan.content_type,
            "mode": if plan.multi_part { "multi_part" } else { "single_part" },
            "number_of_parts": plan.number_of_parts,
        });

        Box::pin(async move {
            let response = self
                .request(reqwest::Method::POST, "/file_uploads")
                .json(&body)
                .send()
                .await?;

            let value = Self::ensure_ok(response).await?;

            serde_json::from_value(value)
                .map_err(|e| Error::Notion(format!("respuesta de create_upload inesperada: {e}")))
        })
    }

    fn send_part(
        &self,
        upload_id: &str,
        part_number: u32,
        bytes: Bytes,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let path = format!("/file_uploads/{upload_id}/send");

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
        let path = format!("/file_uploads/{upload_id}/complete");

        Box::pin(async move {
            let response = self
                .request(reqwest::Method::POST, &path)
                .json(&serde_json::json!({}))
                .send()
                .await?;

            Self::ensure_ok(response).await.map(|_| ())
        })
    }

    fn attach_to_page(
        &self,
        upload_id: &str,
        title: &str,
        duration_ms: i64,
        size_bytes: i64,
    ) -> Pin<Box<dyn Future<Output = Result<(String, Option<String>)>> + Send + '_>> {
        let title = title.to_string();
        let upload_id = upload_id.to_string();

        Box::pin(async move {
            let body = serde_json::json!({
                "parent": { "type": "page_id", "page_id": "" }, // se rellena abajo
                "properties": {
                    "title": {
                        "title": [{ "type": "text", "text": { "content": title } }]
                    }
                },
                "children": [
                    {
                        "object": "block",
                        "type": "video",
                        "video": {
                            "type": "file_upload",
                            "file_upload": { "id": upload_id }
                        }
                    },
                    {
                        "object": "block",
                        "type": "paragraph",
                        "paragraph": {
                            "rich_text": [{
                                "type": "text",
                                "text": {
                                    "content": format!(
                                        "Duración: {} s · Tamaño: {} MB",
                                        duration_ms / 1000,
                                        size_bytes / 1024 / 1024
                                    )
                                }
                            }]
                        }
                    }
                ]
            });

            let _ = (body, upload_id);
            Err(Error::NotImplemented(
                "attach_to_page requiere el parent configurado (Fase 4)",
            ))
        })
    }
}
