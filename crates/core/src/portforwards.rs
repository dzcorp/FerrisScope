//! Persisted port-forward specs.
//!
//! Single hand-rolled JSON file at `<config-dir>/portforwards.json`. Same
//! shape and load/save dance as `sources.rs` / `prefs.rs` / `table_views.rs`.
//!
//! Only specs the operator has explicitly *pinned* (`autostart: true`) end up
//! here — ephemeral forwards opened from a detail panel live in memory only
//! and disappear on app exit. Pinned forwards re-bind their listener at the
//! next app launch (and reconnect their underlying pod stream lazily as
//! their cluster comes online).

use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::fs;

/// What the forward is pointing at. Service / Deployment / `StatefulSet` /
/// `DaemonSet` / `ReplicaSet` / Job all resolve to a backing pod per-connection
/// (matching `kubectl port-forward` semantics) so the listener survives pod
/// restarts. Pod is direct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ForwardTarget {
    /// Kubernetes kind name as the apiserver reports it: "Pod", "Service",
    /// "Deployment", "`StatefulSet`", "`DaemonSet`", "`ReplicaSet`", "Job".
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

/// One forward listener. `id` is deterministic
/// `"<cluster>::<kind>/<ns>/<name>:<remote_port>"` so a duplicate start is
/// dedup'd to the existing entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub id: String,
    pub cluster_id: String,
    pub target: ForwardTarget,
    /// Container port on the resolved pod (numeric — Service named ports get
    /// resolved through targetPort at start time and stored as the resolved
    /// number when persisted).
    pub remote_port: u16,
    /// Operator-requested local port. `None` means "any free port"; the
    /// runtime captures the actual bound port and surfaces it in the entry.
    #[serde(default)]
    pub requested_local_port: Option<u16>,
    /// Persist across app restarts. Ephemeral forwards (chip-opened, "for 5
    /// minutes" usage) keep this `false` and never make it to disk.
    #[serde(default)]
    pub autostart: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PortForwardsFile {
    #[serde(default)]
    pub specs: Vec<ForwardSpec>,
}

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("portforwards.json"))
}

pub async fn load() -> PortForwardsFile {
    let Some(path) = config_path() else {
        return PortForwardsFile::default();
    };
    let data = match fs::read_to_string(&path).await {
        Ok(d) => d,
        Err(_) => return PortForwardsFile::default(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

pub async fn save(file: &PortForwardsFile) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    let data = serde_json::to_string_pretty(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    crate::atomic_write::atomic_write(&path, data.as_bytes()).await
}

/// Stable id for a `(cluster, target, remote_port)` triple. Two starts with
/// the same triple share an entry — the registry returns the existing handle
/// rather than binding a second listener.
#[must_use]
pub fn make_id(cluster_id: &str, target: &ForwardTarget, remote_port: u16) -> String {
    format!(
        "{cluster_id}::{kind}/{ns}/{name}:{port}",
        kind = target.kind,
        ns = target.namespace,
        name = target.name,
        port = remote_port,
    )
}
