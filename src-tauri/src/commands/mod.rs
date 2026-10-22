//! Comandos expuestos al frontend.
//!
//! Cada sub-módulo corresponde a una sección de los contratos IPC de
//! `ARCHITECTURE.md` §4. Si se añade un comando, se registra en `lib.rs`.

pub mod config;
pub mod diagnostics;
pub mod dictation;
pub mod recording;
