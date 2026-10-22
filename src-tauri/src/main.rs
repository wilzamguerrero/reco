//! Punto de entrada de RECO.
//!
//! Este binario solo delega en `reco_lib::run`; toda la lógica vive en la librería
//! para poder probarla sin levantar una ventana.

// En release, no mostrar la consola en Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    reco_lib::run()
}
