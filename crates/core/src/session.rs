//! UI session snapshot at `<config-dir>/session.json`: what each open cluster
//! tab was showing (dock tabs, drawer, tray) so a restart can put it back.
//! The frontend owns the shape; Rust only stores it, bounded in size.

use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use serde_json::Value;
use tokio::fs;

/// Upper bound on a stored snapshot. YAML scratch buffers ride along, so this
/// is generous, but a runaway payload must not grow the file without bound.
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("session.json"))
}

/// A missing, unreadable or corrupt file is an empty session, never an error:
/// the app must always start.
pub async fn load_from(path: &Path) -> Value {
    match fs::metadata(path).await {
        Ok(m) if m.len() <= MAX_BYTES as u64 => {}
        _ => return Value::Null,
    }
    match fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

pub async fn save_to(path: &Path, session: &Value) -> std::io::Result<()> {
    let data = serde_json::to_vec(session)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if data.len() > MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "session snapshot is {} bytes (limit {MAX_BYTES})",
                data.len()
            ),
        ));
    }
    crate::atomic_write::atomic_write(path, &data).await
}

pub async fn load() -> Value {
    match config_path() {
        Some(p) => load_from(&p).await,
        None => Value::Null,
    }
}

pub async fn save(session: &Value) -> std::io::Result<()> {
    match config_path() {
        Some(p) => save_to(&p, session).await,
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let v = json!({ "version": 1, "tabs": { "t1": { "dock": [] } } });
        save_to(&path, &v).await.unwrap();
        assert_eq!(load_from(&path).await, v);
    }

    #[tokio::test]
    async fn missing_or_corrupt_is_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        assert_eq!(load_from(&path).await, Value::Null);
        tokio::fs::write(&path, b"{not json").await.unwrap();
        assert_eq!(load_from(&path).await, Value::Null);
    }

    #[tokio::test]
    async fn rejects_oversized_and_keeps_previous() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let small = json!({ "version": 1 });
        save_to(&path, &small).await.unwrap();
        let big = json!({ "blob": "x".repeat(MAX_BYTES) });
        assert!(save_to(&path, &big).await.is_err());
        assert_eq!(load_from(&path).await, small);
    }

    #[tokio::test]
    async fn oversized_file_loads_as_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let blob = format!("\"{}\"", "x".repeat(MAX_BYTES));
        tokio::fs::write(&path, blob).await.unwrap();
        assert_eq!(load_from(&path).await, Value::Null);
    }
}
