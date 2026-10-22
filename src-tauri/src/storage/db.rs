//! Acceso a SQLite: grabaciones, cola de subidas y ajustes clave/valor.

use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::error::Result;

/// Conexión única protegida por mutex. Las llamadas son síncronas y cortas; los
/// trabajos largos (subida, transcripción) se ejecutan fuera del lock.
pub struct Database {
    conn: Mutex<Connection>,
}

/// Estado de una grabación, alineado con el contrato `Recording.uploadState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadState {
    Queued,
    Uploading,
    Retrying,
    Completed,
    Failed,
    Canceled,
}

impl UploadState {
    pub fn as_str(self) -> &'static str {
        match self {
            UploadState::Queued => "queued",
            UploadState::Uploading => "uploading",
            UploadState::Retrying => "retrying",
            UploadState::Completed => "completed",
            UploadState::Failed => "failed",
            UploadState::Canceled => "canceled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "queued" => UploadState::Queued,
            "uploading" => UploadState::Uploading,
            "retrying" => UploadState::Retrying,
            "completed" => UploadState::Completed,
            "failed" => UploadState::Failed,
            "canceled" => UploadState::Canceled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RecordingRow {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub local_path: String,
    pub thumbnail_path: Option<String>,
    pub notion_page_id: Option<String>,
    pub notion_file_url: Option<String>,
    pub state: UploadState,
}

#[derive(Debug, Clone)]
pub struct UploadJobRow {
    pub id: String,
    pub recording_id: String,
    pub state: UploadState,
    pub bytes_total: i64,
    pub bytes_sent: i64,
    pub parts_total: i64,
    pub parts_sent: i64,
    pub attempts: i64,
    pub notion_upload_id: Option<String>,
    pub last_error: Option<String>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS recordings (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL,
                created_at      TEXT NOT NULL,
                duration_ms     INTEGER NOT NULL,
                size_bytes      INTEGER NOT NULL,
                local_path      TEXT NOT NULL,
                thumbnail_path  TEXT,
                notion_page_id  TEXT,
                notion_file_url TEXT,
                state           TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS upload_jobs (
                id               TEXT PRIMARY KEY,
                recording_id     TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
                state            TEXT NOT NULL,
                bytes_total      INTEGER NOT NULL,
                bytes_sent       INTEGER NOT NULL DEFAULT 0,
                parts_total      INTEGER NOT NULL,
                parts_sent       INTEGER NOT NULL DEFAULT 0,
                attempts         INTEGER NOT NULL DEFAULT 0,
                notion_upload_id TEXT,
                last_error       TEXT,
                updated_at       TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_state ON upload_jobs(state);
            CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at DESC);

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ grabaciones

    pub fn insert_recording(&self, row: &RecordingRow) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO recordings
             (id, title, created_at, duration_ms, size_bytes, local_path,
              thumbnail_path, notion_page_id, notion_file_url, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.id,
                row.title,
                row.created_at,
                row.duration_ms,
                row.size_bytes,
                row.local_path,
                row.thumbnail_path,
                row.notion_page_id,
                row.notion_file_url,
                row.state.as_str(),
            ],
        )?;
        Ok(())
    }

    pub fn list_recordings(&self, limit: u32) -> Result<Vec<RecordingRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, duration_ms, size_bytes, local_path,
                    thumbnail_path, notion_page_id, notion_file_url, state
             FROM recordings ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(RecordingRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    created_at: r.get(2)?,
                    duration_ms: r.get(3)?,
                    size_bytes: r.get(4)?,
                    local_path: r.get(5)?,
                    thumbnail_path: r.get(6)?,
                    notion_page_id: r.get(7)?,
                    notion_file_url: r.get(8)?,
                    state: UploadState::parse(&r.get::<_, String>(9)?).unwrap_or(UploadState::Queued),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_recording(&self, id: &str) -> Result<Option<RecordingRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, duration_ms, size_bytes, local_path,
                    thumbnail_path, notion_page_id, notion_file_url, state
             FROM recordings WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(RecordingRow {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                duration_ms: r.get(3)?,
                size_bytes: r.get(4)?,
                local_path: r.get(5)?,
                thumbnail_path: r.get(6)?,
                notion_page_id: r.get(7)?,
                notion_file_url: r.get(8)?,
                state: UploadState::parse(&r.get::<_, String>(9)?).unwrap_or(UploadState::Queued),
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn set_recording_state(&self, id: &str, state: UploadState) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE recordings SET state = ?2 WHERE id = ?1",
            params![id, state.as_str()],
        )?;
        Ok(())
    }

    pub fn set_notion_link(&self, id: &str, page_id: &str, file_url: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE recordings SET notion_page_id = ?2, notion_file_url = ?3 WHERE id = ?1",
            params![id, page_id, file_url],
        )?;
        Ok(())
    }

    pub fn delete_recording(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------------------------------------------------------ cola

    pub fn enqueue_job(&self, recording_id: &str, bytes_total: i64, parts_total: i64) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO upload_jobs
             (id, recording_id, state, bytes_total, parts_total, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                recording_id,
                UploadState::Queued.as_str(),
                bytes_total,
                parts_total,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(id)
    }

    /// Trabajos pendientes o interrumpidos, en orden de creación. Se usa al arrancar
    /// para reencolar lo que quedó a medias.
    pub fn pending_jobs(&self) -> Result<Vec<UploadJobRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, recording_id, state, bytes_total, bytes_sent,
                    parts_total, parts_sent, attempts, notion_upload_id, last_error
             FROM upload_jobs
             WHERE state IN ('queued', 'uploading', 'retrying')
             ORDER BY updated_at ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(UploadJobRow {
                    id: r.get(0)?,
                    recording_id: r.get(1)?,
                    state: UploadState::parse(&r.get::<_, String>(2)?).unwrap_or(UploadState::Queued),
                    bytes_total: r.get(3)?,
                    bytes_sent: r.get(4)?,
                    parts_total: r.get(5)?,
                    parts_sent: r.get(6)?,
                    attempts: r.get(7)?,
                    notion_upload_id: r.get(8)?,
                    last_error: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn mark_job(
        &self,
        job_id: &str,
        state: UploadState,
        bytes_sent: i64,
        parts_sent: i64,
        notion_upload_id: Option<&str>,
        last_error: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE upload_jobs
             SET state = ?2, bytes_sent = ?3, parts_sent = ?4,
                 notion_upload_id = COALESCE(?5, notion_upload_id),
                 last_error = ?6, updated_at = ?7,
                 attempts = attempts + CASE WHEN ?2 = 'retrying' THEN 1 ELSE 0 END
             WHERE id = ?1",
            params![
                job_id,
                state.as_str(),
                bytes_sent,
                parts_sent,
                notion_upload_id,
                last_error,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ ajustes

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |r| r.get::<_, String>(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}
