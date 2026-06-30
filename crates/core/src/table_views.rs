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
    /// Label keys (`metadata.labels` keys) the operator promoted to custom
    /// columns for this `(cluster/scope, kind)`. Rendered as extra text
    /// columns reading from the watcher-injected `__labels` map. Empty for
    /// legacy files thanks to `serde(default)`.
    #[serde(default)]
    pub label_columns: Vec<String>,
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
    let data = serde_json::to_string_pretty(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    crate::atomic_write::atomic_write(&path, data.as_bytes()).await
}

#[must_use]
pub fn key(cluster_id: &str, kind_id: &str) -> String {
    format!("{cluster_id}::{kind_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_view_without_label_columns_defaults_empty() {
        // Files written before `label_columns` landed must still parse,
        // yielding an empty custom-column list rather than failing.
        let legacy = r#"{ "sorting": [], "column_sizing": {} }"#;
        let view: TableView = serde_json::from_str(legacy).expect("legacy view parses");
        assert!(view.label_columns.is_empty());
    }

    #[test]
    fn label_columns_round_trip() {
        let view = TableView {
            sorting: vec![SortEntry {
                id: "name".into(),
                desc: false,
            }],
            column_sizing: HashMap::new(),
            label_columns: vec![
                "topology.kubernetes.io/zone".into(),
                "node-role.kubernetes.io/control-plane".into(),
            ],
        };
        let json = serde_json::to_string(&view).expect("serialize");
        let back: TableView = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.label_columns, view.label_columns);
    }

    #[test]
    fn views_file_round_trip_keyed() {
        let mut file = TableViewsFile::default();
        let k = key("default::minikube", "nodes");
        file.views.insert(
            k.clone(),
            TableView {
                label_columns: vec!["kubernetes.io/arch".into()],
                ..TableView::default()
            },
        );
        let json = serde_json::to_string(&file).expect("serialize file");
        let back: TableViewsFile = serde_json::from_str(&json).expect("deserialize file");
        assert_eq!(
            back.views.get(&k).map(|v| v.label_columns.clone()),
            Some(vec!["kubernetes.io/arch".to_string()])
        );
    }
}
