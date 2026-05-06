//! Lightweight per-cluster probes for the fleet landing screen.
//!
//! For every kubeconfig context we want a small "card" of facts: server
//! version, node count, pod count, CPU/Mem load. Probing is on-demand and
//! refreshed at most once per [`STALE_AFTER_MS`] (one hour by default).
//! Results are cached to disk so a fresh app start renders immediately
//! from the last known state instead of going dark while ten clusters
//! are probed.
//!
//! Every read is best-effort. A probe that fails (cluster unreachable,
//! creds expired, metrics-server missing) does *not* clear cached data —
//! we keep showing the last known good values.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use directories::ProjectDirs;
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::time::timeout;

use crate::cluster::Cluster;
use crate::metrics::{list_node_capacity, list_node_metrics};
use crate::sources::SshSourceConfig;

/// Optional SSH descriptor passed alongside a probe. `None` for file-based
/// sources; `Some` for SSH sources, where the probe also opens a tunnel.
#[derive(Debug, Clone)]
pub struct ProbeSsh {
    pub source_id: String,
    pub cfg: SshSourceConfig,
}

/// Re-probe entries older than this. One hour is intentionally generous —
/// the fleet view is a "where am I" snapshot, not a live dashboard.
pub const STALE_AFTER_MS: i64 = 60 * 60 * 1000;

/// Per-probe wall-clock budget. Long enough for slow apiservers, short
/// enough that an unreachable cluster doesn't stall the UI.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClusterProbe {
    pub context_name: String,
    pub server_version: Option<String>,
    pub nodes: Option<u32>,
    pub pods: Option<u32>,
    pub cpu_used_milli: Option<u64>,
    pub cpu_capacity_milli: Option<u64>,
    pub mem_used_mib: Option<u64>,
    pub mem_capacity_mib: Option<u64>,
    /// `Some(true)` if we got at least the apiserver version; `Some(false)`
    /// if the connect/probe errored entirely; `None` only on a fresh entry
    /// that hasn't been probed yet.
    pub healthy: Option<bool>,
    pub fetched_at_unix_ms: i64,
    /// Last error message — kept human-readable for the cards' tooltip.
    pub last_error: Option<String>,
}

#[must_use]
pub fn cache_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope").map(|p| p.cache_dir().join("fleet.json"))
}

pub async fn load_cache() -> HashMap<String, ClusterProbe> {
    let Some(path) = cache_path() else {
        return HashMap::new();
    };
    let data = match fs::read_to_string(&path).await {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

pub async fn save_cache(map: &HashMap<String, ClusterProbe>) {
    let Some(path) = cache_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    if let Ok(data) = serde_json::to_string_pretty(map) {
        let _ = fs::write(&path, data).await;
    }
}

#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[must_use]
pub fn is_stale(probe: &ClusterProbe) -> bool {
    now_ms() - probe.fetched_at_unix_ms > STALE_AFTER_MS
}

/// Connect to `context_name`, fetch a few summary numbers, and return them.
/// Wrapped in a wall-clock timeout so a hung apiserver doesn't pin the
/// concurrency budget. Always returns Some — the caller decides whether to
/// merge fields (we never overwrite known values with None).
pub async fn probe(
    context_name: &str,
    source_path: Option<&Path>,
    ssh: Option<&ProbeSsh>,
) -> ClusterProbe {
    match timeout(PROBE_TIMEOUT, probe_inner(context_name, source_path, ssh)).await {
        Ok(p) => p,
        Err(_) => ClusterProbe {
            context_name: context_name.to_owned(),
            healthy: Some(false),
            fetched_at_unix_ms: now_ms(),
            last_error: Some(format!("timed out after {}s", PROBE_TIMEOUT.as_secs())),
            ..Default::default()
        },
    }
}

async fn probe_inner(
    context_name: &str,
    source_path: Option<&Path>,
    ssh: Option<&ProbeSsh>,
) -> ClusterProbe {
    let mut probe = ClusterProbe {
        context_name: context_name.to_owned(),
        fetched_at_unix_ms: now_ms(),
        ..Default::default()
    };

    let connect_result = if let Some(s) = ssh {
        Cluster::connect_ssh(context_name, &s.cfg, &s.source_id).await
    } else {
        Cluster::connect(context_name, source_path).await
    };
    let cluster = match connect_result {
        Ok(c) => c,
        Err(e) => {
            probe.healthy = Some(false);
            probe.last_error = Some(e.to_string());
            return probe;
        }
    };
    let client = cluster.client();

    match client.apiserver_version().await {
        Ok(v) => {
            probe.server_version = Some(v.git_version);
            probe.healthy = Some(true);
        }
        Err(e) => {
            probe.healthy = Some(false);
            probe.last_error = Some(e.to_string());
            return probe;
        }
    }

    if let Ok(list) = Api::<Node>::all(client.clone())
        .list(&ListParams::default())
        .await
    {
        probe.nodes = Some(list.items.len() as u32);
    }

    if let Ok(list) = Api::<Pod>::all(client.clone())
        .list(&ListParams::default())
        .await
    {
        probe.pods = Some(list.items.len() as u32);
    }

    if let Ok(node_metrics) = list_node_metrics(&client).await {
        let cpu_used: u64 = node_metrics.values().map(|(c, _)| c).sum();
        let mem_used: u64 = node_metrics.values().map(|(_, m)| m).sum();
        probe.cpu_used_milli = Some(cpu_used);
        probe.mem_used_mib = Some(mem_used);
    }
    if let Ok(node_caps) = list_node_capacity(&client).await {
        let cpu_cap: u64 = node_caps.values().map(|(c, _)| c).sum();
        let mem_cap: u64 = node_caps.values().map(|(_, m)| m).sum();
        if cpu_cap > 0 {
            probe.cpu_capacity_milli = Some(cpu_cap);
        }
        if mem_cap > 0 {
            probe.mem_capacity_mib = Some(mem_cap);
        }
    }

    probe
}
