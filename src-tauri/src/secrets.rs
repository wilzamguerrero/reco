//! Secretos en el keyring del sistema operativo.
//!
//! El valor **nunca** se devuelve al frontend: solo se consulta si existe.

use crate::error::{Error, Result};

const SERVICE: &str = "app.reco.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKey {
    NotionToken,
    ProxyToken,
}

impl SecretKey {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "notionToken" => Ok(SecretKey::NotionToken),
            "proxyToken" => Ok(SecretKey::ProxyToken),
            other => Err(Error::Config(format!("secreto desconocido: {other}"))),
        }
    }

    fn account(self) -> &'static str {
        match self {
            SecretKey::NotionToken => "notion-token",
            SecretKey::ProxyToken => "proxy-token",
        }
    }
}

fn entry(key: SecretKey) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, key.account())
        .map_err(|e| Error::Other(format!("keyring no disponible: {e}")))
}

pub fn is_set(key: SecretKey) -> bool {
    entry(key)
        .and_then(|e| e.get_password().map_err(|e| Error::Other(e.to_string())))
        .is_ok()
}

pub fn set(key: SecretKey, value: &str) -> Result<()> {
    entry(key)?
        .set_password(value)
        .map_err(|e| Error::Other(format!("no se pudo guardar el secreto: {e}")))
}

pub fn clear(key: SecretKey) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        // Borrar algo que no existe es un éxito idempotente.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Other(format!("no se pudo borrar el secreto: {e}"))),
    }
}

/// Lee un secreto para uso interno del núcleo (nunca se serializa hacia la UI).
pub fn get(key: SecretKey) -> Result<Option<String>> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::Other(format!("no se pudo leer el secreto: {e}"))),
    }
}
