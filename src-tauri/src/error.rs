//! Errores compartidos por todos los comandos.
//!
//! Todo comando devuelve `Result<T, Error>`; el `Display` se envía tal cual a la UI,
//! así que **nunca** debe contener secretos ni rutas completas del usuario.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("configuración inválida: {0}")]
    Config(String),

    #[error("error de base de datos: {0}")]
    Database(String),

    #[error("error de entrada/salida: {0}")]
    Io(String),

    #[error("error de red: {0}")]
    Network(String),

    #[error("Notion rechazó la operación: {0}")]
    Notion(String),

    #[error("no implementado todavía: {0}")]
    NotImplemented(&'static str),

    #[error("{0}")]
    Other(String),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Database(e.to_string())
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        // La URL puede contener parámetros; solo se conserva la descripción.
        Error::Network(e.without_url().to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Other(format!("json: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, Error>;
