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

use std::net::IpAddr;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::fs;

/// Current on-disk schema version for `portforwards.json`. Bumped whenever the
/// persisted shape changes in a way that needs migration on load. v0 (the
/// implicit version of files written before this field existed) is the
/// single-`remote_port`, `localhost`-only `Simple` layout; v1 adds `mode` and
/// `local_ip`. Both load cleanly because every new field is `#[serde(default)]`,
/// so the version is informational for now — it exists so a *future* breaking
/// change has a hook (mirrors `prefs.rs`'s migration precedent).
pub const CURRENT_VERSION: u32 = 1;

/// Which forwarding tier a spec belongs to.
///
/// - `Simple` — today's behaviour: bind `127.0.0.1:<port>`, reachable as
///   `localhost:<port>`. No privilege required. The default for any spec that
///   predates this field.
/// - `Global` — bind a per-service loopback IP (`local_ip`,
///   somewhere in `127.0.0.0/8`) keeping the service's real port, addressable
///   by in-cluster DNS names. Requires the privileged helper.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardMode {
    #[default]
    Simple,
    Global,
}

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
    /// Forwarding tier. Absent in pre-v1 files → defaults to `Simple`.
    #[serde(default)]
    pub mode: ForwardMode,
    /// Loopback address to bind the local listener on. `None` means
    /// `127.0.0.1` (the only thing `Simple` ever uses). `Global` forwards set
    /// this to their allocated per-service IP somewhere in `127.0.0.0/8`.
    #[serde(default)]
    pub local_ip: Option<IpAddr>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardsFile {
    /// Schema version. Pre-v1 files omit it → `0` via the default, which is
    /// still load-compatible (all new fields default). See [`CURRENT_VERSION`].
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub specs: Vec<ForwardSpec>,
}

impl Default for PortForwardsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            specs: Vec::new(),
        }
    }
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

/// Stable id for a `Global` forward. Carries a `global::`
/// marker so a global forward of the same `(cluster, target, port)` triple does
/// **not** collide with a `Simple` forward of the same triple in the registry —
/// they bind different local addresses and must coexist.
#[must_use]
pub fn make_global_id(cluster_id: &str, target: &ForwardTarget, remote_port: u16) -> String {
    format!(
        "{cluster_id}::global::{kind}/{ns}/{name}:{port}",
        kind = target.kind,
        ns = target.namespace,
        name = target.name,
        port = remote_port,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn target() -> ForwardTarget {
        ForwardTarget {
            kind: "Service".into(),
            namespace: "default".into(),
            name: "api".into(),
        }
    }

    #[test]
    fn pre_v1_file_loads_as_simple_localhost() {
        // A file written before `version` / `mode` / `local_ip` existed.
        let legacy = r#"{
            "specs": [{
                "id": "ctx::Service/default/api:8080",
                "cluster_id": "ctx",
                "target": { "kind": "Service", "namespace": "default", "name": "api" },
                "remote_port": 8080,
                "requested_local_port": 8080,
                "autostart": true
            }]
        }"#;
        let file: PortForwardsFile = serde_json::from_str(legacy).unwrap();
        assert_eq!(file.version, 0, "missing version defaults to 0");
        assert_eq!(file.specs.len(), 1);
        let spec = &file.specs[0];
        assert_eq!(spec.mode, ForwardMode::Simple, "absent mode → Simple");
        assert_eq!(spec.local_ip, None, "absent local_ip → None (= localhost)");
        assert!(spec.autostart);
    }

    #[test]
    fn empty_object_loads() {
        // Even `{}` must deserialize (defensive: truncated/empty file).
        let file: PortForwardsFile = serde_json::from_str("{}").unwrap();
        assert_eq!(file.version, 0);
        assert!(file.specs.is_empty());
    }

    #[test]
    fn global_spec_round_trips_with_ip_and_mode() {
        let spec = ForwardSpec {
            id: make_global_id("ctx", &target(), 5432),
            cluster_id: "ctx".into(),
            target: target(),
            remote_port: 5432,
            requested_local_port: Some(5432),
            autostart: true,
            mode: ForwardMode::Global,
            local_ip: Some(IpAddr::V4(Ipv4Addr::new(127, 1, 27, 1))),
        };
        let file = PortForwardsFile {
            version: CURRENT_VERSION,
            specs: vec![spec.clone()],
        };
        let json = serde_json::to_string(&file).unwrap();
        let back: PortForwardsFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, CURRENT_VERSION);
        let got = &back.specs[0];
        assert_eq!(got.mode, ForwardMode::Global);
        assert_eq!(got.local_ip, Some(IpAddr::V4(Ipv4Addr::new(127, 1, 27, 1))));
        assert_eq!(got.remote_port, 5432);
    }

    #[test]
    fn default_file_carries_current_version() {
        assert_eq!(PortForwardsFile::default().version, CURRENT_VERSION);
    }

    #[test]
    fn simple_and_global_ids_do_not_collide() {
        let simple = make_id("ctx", &target(), 80);
        let global = make_global_id("ctx", &target(), 80);
        assert_ne!(simple, global);
        assert!(global.contains("::global::"));
    }
}
