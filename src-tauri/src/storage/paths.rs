//! Rutas de datos de la aplicación.
//!
//! Todo se resuelve bajo el directorio de datos del usuario; ningún comando acepta
//! rutas arbitrarias sin pasar por `ensure_within`.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

pub const APP_DIR: &str = "RECO";

/// `%APPDATA%\RECO` · `~/Library/Application Support/RECO` · `~/.config/RECO`.
pub fn data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| Error::Config("no se pudo resolver el directorio de datos".into()))?;
    Ok(base.join(APP_DIR))
}

/// Directorio de grabaciones temporales.
pub fn recordings_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("recordings"))
}

/// Directorio de modelos de transcripción descargados.
pub fn models_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("models"))
}

/// Ruta del archivo de configuración.
pub fn config_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("config.json"))
}

/// Ruta de la base de datos SQLite.
pub fn database_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("reco.db"))
}

/// Crea los directorios que la aplicación necesita al arrancar.
pub fn ensure_dirs() -> Result<()> {
    for dir in [data_dir()?, recordings_dir()?, models_dir()?] {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(())
}

/// Verifica que `candidate` está dentro de `base` tras normalizarlo.
///
/// Se usa en cualquier comando que reciba una ruta del frontend para impedir
/// que una ruta manipulada escriba fuera del área de la aplicación.
pub fn ensure_within(base: &Path, candidate: &Path) -> Result<PathBuf> {
    let base = normalize(base)?;
    let candidate = normalize(candidate)?;

    if candidate.starts_with(&base) {
        Ok(candidate)
    } else {
        Err(Error::Config(
            "la ruta indicada está fuera de la carpeta de RECO".into(),
        ))
    }
}

/// Normaliza una ruta sin exigir que exista (resuelve `..` de forma lógica).
fn normalize(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };

    let mut out = PathBuf::new();
    for component in absolute.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn rechaza_escaparse_del_directorio_base() {
        let base = Path::new("/home/u/RECO");
        let inside = Path::new("/home/u/RECO/recordings/a.mp4");
        let outside = Path::new("/home/u/RECO/../secreto.txt");

        assert!(ensure_within(base, inside).is_ok());
        assert!(ensure_within(base, outside).is_err());
    }
}
