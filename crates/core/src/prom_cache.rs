//! Per-cluster Prometheus target cache.
//!
//! On the first connect to a cluster we run [`crate::prometheus::discover`]
//! and stash the result here so subsequent connects can skip discovery
//! entirely. The cache also remembers whether the entry was picked
//! manually by the operator (Settings → Use) or auto-detected, which
//! matters for the validation flow:
//!
//! * `Auto` entries are *replaced* if validation fails on next connect —
//!   the Prometheus may have been redeployed under a new Service.
//! * `User` entries are *kept* even if validation fails — the operator
//!   was explicit, so we surface a warning instead of silently swapping.
//!
//! Disk path: `<config>/prometheus.json`. Same file shape and
//! load-on-startup / overwrite-on-mutation pattern as `fleet.json` /
//! `portforwards.json`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::prometheus::PromTarget;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PromSource {
    /// Picked manually by the operator in Settings. Never auto-replaced.
    User,
    /// Auto-detected on cluster connect. Replaced on the next connect if
    /// validation fails.
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromCacheEntry {
    pub target: PromTarget,
    pub source: PromSource,
    /// Wall-clock when we last successfully ran `up` against this target.
    /// 0 = never validated (entry was just written manually). Refreshed
    /// every successful detect-on-connect cycle.
    #[serde(default)]
    pub last_validated_at_unix_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct PromCacheFile {
    #[serde(default)]
    pub entries: HashMap<String, PromCacheEntry>,
}

fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("prometheus.json"))
}

pub async fn load() -> PromCacheFile {
    let Some(path) = config_path() else {
        return PromCacheFile::default();
    };
    let data = match fs::read_to_string(&path).await {
        Ok(d) => d,
        Err(_) => return PromCacheFile::default(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

pub async fn save(file: &PromCacheFile) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    let data = serde_json::to_string_pretty(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    crate::atomic_write::atomic_write(&path, data.as_bytes()).await
}

pub async fn get(cluster_id: &str) -> Option<PromCacheEntry> {
    load().await.entries.get(cluster_id).cloned()
}

pub async fn set(cluster_id: &str, entry: PromCacheEntry) -> std::io::Result<()> {
    let mut f = load().await;
    f.entries.insert(cluster_id.to_owned(), entry);
    save(&f).await
}

pub async fn clear(cluster_id: &str) -> std::io::Result<()> {
    let mut f = load().await;
    f.entries.remove(cluster_id);
    save(&f).await
}

#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
