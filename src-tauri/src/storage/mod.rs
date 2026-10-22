//! Persistencia: rutas de datos y base de datos SQLite.

pub mod db;
pub mod paths;

pub use db::{Database, RecordingRow, UploadJobRow, UploadState};
