//! Enumeración de monitores para Windows.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// Enumera los monitores conectados.
///
/// La implementación con `EnumDisplayMonitors` llega en la Fase 3; hasta
/// entonces se devuelve una lista vacía para que la UI muestre el estado
/// "sin fuentes detectadas" en lugar de fallar.
pub fn list_monitors() -> Vec<MonitorInfo> {
    Vec::new()
}
