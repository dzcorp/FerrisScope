//! Per-(cluster, kind) table view state — sort + column widths.
//!
//! One global JSON file at `<config-dir>/table_views.json`. Keyed by
//! `"<cluster_id>::<kind_id>"` so a single file covers every table the
//! operator has touched. Same on-disk shape and load/save dance as
//! `sources.rs` / `fleet.rs`.

use std::collections::HashMap;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortEntry {
    pub id: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableView {
    #[serde(default)]
    pub sorting: Vec<SortEntry>,
    #[serde(default)]
    pub column_sizing: HashMap<String, f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableViewsFile {
    #[serde(default)]
    pub views: HashMap<String, TableView>,
}

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("table_views.json"))
}

pub async fn load() -> TableViewsFile {
    let Some(path) = config_path() else {
        return TableViewsFile::default();
    };
    let data = match fs::read_to_string(&path).await {
        Ok(d) => d,
        Err(_) => return TableViewsFile::default(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

pub async fn save(file: &TableViewsFile) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let data = serde_json::to_string_pretty(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(&path, data).await?;
    Ok(())
}

#[must_use]
pub fn key(cluster_id: &str, kind_id: &str) -> String {
    format!("{cluster_id}::{kind_id}")
}
