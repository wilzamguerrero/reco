//! Diagnóstico de capacidades de la plataforma.
//!
//! Se ejecuta al arrancar y bajo demanda desde Ajustes → Sistema. Todo lo que
//! devuelve es información no sensible.
//!
//! Importante: las capacidades reflejan lo que **esta compilación** puede hacer
//! de verdad, no lo que el sistema operativo ofrece en teoría. Un Windows
//! soporta WGC, pero si el backend aún no está implementado aquí se informa
//! como no disponible para no prometer lo que la app no cumple.

use serde::Serialize;

use crate::error::Result;
use crate::storage::paths;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub os: String,
    pub arch: String,
    pub version: String,
    pub data_dir: String,
    pub capabilities: Capabilities,
    pub checks: Vec<Check>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Captura de pantalla nativa disponible.
    pub screen_capture: bool,
    /// Audio del sistema (loopback) disponible.
    pub system_audio: bool,
    /// Atajos globales disponibles (Wayland los bloquea).
    pub global_shortcuts: bool,
    /// Inserción de texto en otras aplicaciones.
    pub text_injection: bool,
    /// Keyring del sistema operativo accesible.
    pub secure_storage: bool,
    /// El motor Whisper está compilado en este binario.
    pub local_transcription: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub ok: bool,
    pub detail: String,
    /// Acción sugerida cuando `ok` es falso.
    pub hint: Option<String>,
}

#[tauri::command]
pub fn diagnostics_run() -> Result<Diagnostics> {
    let mut checks = Vec::new();

    let data_dir_ok = paths::ensure_dirs().is_ok();
    checks.push(Check {
        id: "data_dir".into(),
        ok: data_dir_ok,
        detail: paths::data_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|e| e.to_string()),
        hint: (!data_dir_ok).then(|| "Comprueba los permisos de la carpeta de datos.".into()),
    });

    let keyring_ok = crate::secrets::is_set(crate::secrets::SecretKey::NotionToken)
        || keyring_probe();
    checks.push(Check {
        id: "secure_storage".into(),
        ok: keyring_ok,
        detail: if keyring_ok {
            "keyring disponible".into()
        } else {
            "keyring no accesible".into()
        },
        hint: (!keyring_ok).then(|| {
            "En Linux instala gnome-keyring o kwallet; sin él los tokens no se pueden guardar."
                .into()
        }),
    });

    let caps = crate::platform::capabilities();

    checks.push(Check {
        id: "global_shortcuts".into(),
        ok: caps.global_shortcuts,
        detail: if caps.global_shortcuts {
            "atajos globales disponibles".into()
        } else {
            "la sesión no permite atajos globales".into()
        },
        hint: (!caps.global_shortcuts)
            .then(|| "En Linux, inicia una sesión X11 (Wayland no lo soporta en v1).".into()),
    });

    checks.push(Check {
        id: "screen_capture".into(),
        ok: caps.screen_capture,
        detail: if caps.screen_capture {
            "captura de pantalla disponible".into()
        } else {
            "captura de pantalla todavía no implementada".into()
        },
        hint: (!caps.screen_capture)
            .then(|| "Está prevista para la Fase 3; mientras tanto la grabación no produce vídeo.".into()),
    });

    checks.push(Check {
        id: "local_transcription".into(),
        ok: caps.local_transcription,
        detail: if caps.local_transcription {
            "motor de transcripción local incluido".into()
        } else {
            "motor de transcripción no incluido en esta compilación".into()
        },
        hint: (!caps.local_transcription)
            .then(|| "Compila con `cargo build --features whisper` para habilitarlo.".into()),
    });

    Ok(Diagnostics {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: paths::data_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        capabilities: caps,
        checks,
    })
}

/// Comprueba que el keyring responde sin escribir nada permanente.
fn keyring_probe() -> bool {
    // Leer un secreto inexistente devuelve `NoEntry`, que ya demuestra que el
    // backend responde. Un error de plataforma significa que no está disponible.
    crate::secrets::get(crate::secrets::SecretKey::ProxyToken).is_ok()
}
