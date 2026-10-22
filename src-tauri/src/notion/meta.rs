//! Mapeo de nombre de archivo a nombre y MIME aceptados por Notion.
//!
//! Portado de `references/envi/functions/_shared/notion.ts::resolveUploadMeta`.
//! Notion rechaza extensiones desconocidas y tipos MIME que no coincidan con la
//! extensión, así que la tabla es explícita.

/// Extensiones que Notion acepta y su MIME canónico.
const ALLOWED: &[(&str, &str)] = &[
    ("aac", "audio/aac"),
    ("avi", "video/x-msvideo"),
    ("csv", "text/csv"),
    ("doc", "application/msword"),
    ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("gif", "image/gif"),
    ("heic", "image/heic"),
    ("html", "text/html"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("json", "application/json"),
    ("m4a", "audio/mp4"),
    ("m4v", "video/x-m4v"),
    ("md", "text/markdown"),
    ("mov", "video/quicktime"),
    ("mp3", "audio/mpeg"),
    ("mp4", "video/mp4"),
    ("mpeg", "video/mpeg"),
    ("mpg", "video/mpeg"),
    ("odt", "application/vnd.oasis.opendocument.text"),
    ("pdf", "application/pdf"),
    ("png", "image/png"),
    ("ppt", "application/vnd.ms-powerpoint"),
    ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ("rtf", "application/rtf"),
    ("svg", "image/svg+xml"),
    ("txt", "text/plain"),
    ("wav", "audio/wav"),
    ("webm", "video/webm"),
    ("webp", "image/webp"),
    ("xls", "application/vnd.ms-excel"),
    ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("xml", "application/xml"),
    ("zip", "application/zip"),
];

/// Devuelve `(nombre_para_notion, content_type)`.
///
/// Si la extensión no está soportada, el archivo se declara como ZIP: la UI debe
/// haberlo comprimido antes de llegar aquí (ver `ARCHITECTURE.md` §7.1).
pub fn resolve_upload_meta(filename: &str) -> (String, String) {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ALLOWED.iter().find(|(known, _)| *known == ext) {
        Some((_, mime)) => (filename.to_string(), (*mime).to_string()),
        None => (
            format!("{filename}.zip"),
            "application/zip".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conserva_mp4() {
        let (name, mime) = resolve_upload_meta("clase.mp4");
        assert_eq!(name, "clase.mp4");
        assert_eq!(mime, "video/mp4");
    }

    #[test]
    fn envuelve_desconocidos_como_zip() {
        let (name, mime) = resolve_upload_meta("datos.raro");
        assert_eq!(name, "datos.raro.zip");
        assert_eq!(mime, "application/zip");
    }

    #[test]
    fn ignorar_mayusculas() {
        let (_, mime) = resolve_upload_meta("VIDEO.MP4");
        assert_eq!(mime, "video/mp4");
    }
}
