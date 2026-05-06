//! metrics-server + kubelet stats/summary access.
//!
//! Periodically lists `metrics.k8s.io/v1beta1/PodMetrics` and `NodeMetrics`,
//! plus core/v1/Node capacity, and broadcasts a snapshot of:
//!
//! * per-pod CPU (m) and memory (Mi), keyed by uid;
//! * cluster-wide CPU + memory used / capacity totals;
//! * per-pod and per-PVC volume usage (used / capacity / inodes), pulled
//!   directly from each kubelet's `/stats/summary` via the apiserver proxy
//!   so we don't need a metrics-server addon for storage observability.
//!
//! One service per cluster, started lazily on first subscribe and refcounted
//! by the app layer. Polls every [`REFRESH_SECS`] seconds — that's the same
//! rhythm `kubectl top` uses, and metrics-server caches results internally.
//!
//! If metrics-server isn't installed (404 on the API group), the service
//! stays alive and emits `available: false` snapshots so the UI can render
//! "—" instead of pretending values are loading. The volume side has its
//! own `volumes_available` flag because metrics-server and kubelet stats
//! fail independently — one common case is RBAC granting `metrics.k8s.io`
//! but not `nodes/proxy`.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{stream::FuturesUnordered, StreamExt};
use http::Request;
use k8s_openapi::api::core::v1::Node;
use kube::{
    api::{Api, DynamicObject, ListParams},
    core::{ApiResource, GroupVersionKind},
    Client,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{interval, MissedTickBehavior};

/// Cap on parallel kubelet stats/summary fetches per tick. The endpoint is
/// cheap (kubelet caches internally) but for a 500-node cluster we still
/// don't want 500 simultaneous proxied requests to the apiserver.
const KUBELET_FETCH_CONCURRENCY: usize = 16;

pub const REFRESH_SECS: u64 = 15;
const BROADCAST_CAP: usize = 16;

/// Hold the first metrics poll back this long after the service starts.
///
/// The metrics polling task is launched eagerly the moment the user picks a
/// cluster (App.tsx subscribes here so cluster-bar gauges + pod-table
/// CPU/Mem cells light up without per-component coordination). On clusters
/// that actually have metrics-server installed, the very first poll fires:
///
/// * `LIST PodMetrics` (cluster-wide),
/// * `LIST NodeMetrics`,
/// * `LIST Nodes` (capacity),
/// * `LIST Nodes` (for the kubelet `stats/summary` fan-out),
/// * up to [`KUBELET_FETCH_CONCURRENCY`] concurrent apiserver-proxy hits.
///
/// All on the same `kube::Client` the user's Pods/Deployments watcher is
/// about to use for its initial LIST — they share the apiserver's
/// flow-control bucket and (for exec-auth contexts) the credential refresh
/// path. Without this delay, opening Pods on a metrics-server-equipped
/// cluster takes visibly longer than on one without (the operator reports
/// a cluster *with* the stack feels noticeably slower than a bare one,
/// matching `kubectl get pods -A` only on the bare cluster).
///
/// The delay shifts only the *first* poll; the periodic cadence stays at
/// [`REFRESH_SECS`]. Subscribers that arrive before the first poll lands
/// see a `null` snapshot from `subscribe_metrics`, which the UI renders
/// as `—` rather than spinner — already the correct behaviour for
/// "metrics not yet ready".
const INITIAL_POLL_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize)]
pub struct PodMetric {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: u64,
    pub mem_mib: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClusterMetrics {
    pub cpu_used_milli: u64,
    pub cpu_capacity_milli: u64,
    pub mem_used_mib: u64,
    pub mem_capacity_mib: u64,
}

/// Per-mounted-volume usage as reported by kubelet `stats/summary`. Shared
/// shape between the per-pod and per-PVC indices in [`MetricsSnapshot`] —
/// the PVC-keyed map dedupes against `pvc_namespace + pvc_name` so a claim
/// mounted by N pods only appears once (kubelet reports the same numbers
/// from every mounter; we keep whichever one we see last).
#[derive(Clone, Debug, Serialize)]
pub struct VolumeMetric {
    pub pod_namespace: String,
    pub pod_name: String,
    pub volume_name: String,
    /// Set only for PVC-backed volumes — empty for emptyDir / projected /
    /// configMap / secret. The PVC-keyed index is built from this.
    pub pvc_namespace: Option<String>,
    pub pvc_name: Option<String>,
    pub used_bytes: u64,
    pub capacity_bytes: u64,
    pub available_bytes: u64,
    pub used_inodes: u64,
    pub capacity_inodes: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct MetricsSnapshot {
    /// Keyed by `"{namespace}/{name}"`. Pod uid would be cleaner but
    /// metrics-server doesn't always populate `metadata.uid` on its
    /// `PodMetrics` objects, so namespace+name is the only join key both sides
    /// reliably share.
    pub pods: HashMap<String, PodMetric>,
    pub cluster: Option<ClusterMetrics>,
    /// Pod volume stats, keyed by `"{namespace}/{name}"`. One entry per
    /// volume the pod mounts (PVC and ephemeral both included so the Pod
    /// detail panel can show emptyDir size too).
    #[serde(default)]
    pub pod_volumes: HashMap<String, Vec<VolumeMetric>>,
    /// PVC-aggregated, keyed by `"{namespace}/{claim}"`. Present whenever
    /// at least one pod has the claim mounted and kubelet reported on it.
    /// Unbound or unmounted claims won't appear — the UI keeps the row but
    /// renders "—" for usage.
    #[serde(default)]
    pub pvcs: HashMap<String, VolumeMetric>,
    /// false when metrics-server isn't available (e.g. not installed).
    pub available: bool,
    /// false when no kubelet `stats/summary` could be reached (RBAC denied
    /// `nodes/proxy`, every node refused, or the cluster has zero nodes).
    /// Independent of `available` — many clusters have one but not the other.
    #[serde(default)]
    pub volumes_available: bool,
    pub fetched_at_unix_ms: i64,
}

pub struct MetricsService {
    /// Broadcast carries `Arc<MetricsSnapshot>` so subscribers (and the
    /// `last` cache) share one allocation per tick instead of cloning the
    /// full HashMap-of-pods every time. On a 5000-pod cluster this is
    /// the difference between MBs of allocation per tick and a refcount
    /// bump per subscriber.
    tx: broadcast::Sender<Arc<MetricsSnapshot>>,
    last: Arc<Mutex<Option<Arc<MetricsSnapshot>>>>,
    task: JoinHandle<()>,
}

impl Drop for MetricsService {
    fn drop(&mut self) {
        // Aborts the polling loop the moment the last subscriber goes away.
        self.task.abort();
    }
}

impl MetricsService {
    #[must_use]
    pub fn start(client: Client) -> Arc<Self> {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let last: Arc<Mutex<Option<Arc<MetricsSnapshot>>>> = Arc::new(Mutex::new(None));

        let task = tokio::spawn({
            let tx = tx.clone();
            let last = last.clone();
            async move {
                // Hold off the first poll so the operator's first
                // `subscribe_resource` LIST (Pods etc.) wins the apiserver.
                // See [`INITIAL_POLL_DELAY`].
                tokio::time::sleep(INITIAL_POLL_DELAY).await;
                let mut tick = interval(Duration::from_secs(REFRESH_SECS));
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                loop {
                    tick.tick().await;
                    let snap = Arc::new(poll(&client).await);
                    *last.lock().await = Some(snap.clone());
                    // No subscribers is fine — broadcast::send returns Err
                    // but we don't care: the next subscriber will see the
                    // cached snapshot via .snapshot().
                    let _ = tx.send(snap);
                }
            }
        });

        Arc::new(Self { tx, last, task })
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<MetricsSnapshot>> {
        self.tx.subscribe()
    }

    pub async fn snapshot(&self) -> Option<Arc<MetricsSnapshot>> {
        self.last.lock().await.clone()
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum MetricsError {
    #[error(transparent)]
    Kube(#[from] kube::Error),
}

/// Single tick: fetch metrics-server data and kubelet stats/summary
/// concurrently, then assemble a snapshot. Each side fails independently —
/// missing metrics-server doesn't mask kubelet volume stats and vice versa,
/// because operators commonly have one but not both.
async fn poll(client: &Client) -> MetricsSnapshot {
    let metrics_fut = async {
        let pods = list_pod_metrics(client).await?;
        let nodes = list_node_metrics(client).await?;
        let caps = list_node_capacity(client).await?;
        Ok::<_, MetricsError>((pods, nodes, caps))
    };
    let volumes_fut = list_volume_stats(client);

    let (metrics_res, volumes_res) = tokio::join!(metrics_fut, volumes_fut);

    let (pods, cluster, available) = match metrics_res {
        Ok((pods, nodes, caps)) => (pods, Some(aggregate(&nodes, &caps)), true),
        Err(e) => {
            let absent = matches!(
                &e,
                MetricsError::Kube(kube::Error::Api(err)) if err.code == 404,
            );
            if !absent {
                tracing::warn!(error = %e, "metrics-server poll failed");
            }
            (HashMap::new(), None, false)
        }
    };

    let (pod_volumes, pvcs, volumes_available) = match volumes_res {
        Ok((p, v)) if !p.is_empty() || !v.is_empty() => (p, v, true),
        Ok((p, v)) => (p, v, false),
        Err(e) => {
            tracing::debug!(error = %e, "kubelet stats/summary poll failed");
            (HashMap::new(), HashMap::new(), false)
        }
    };

    MetricsSnapshot {
        pods,
        cluster,
        pod_volumes,
        pvcs,
        available,
        volumes_available,
        fetched_at_unix_ms: now_ms(),
    }
}

pub(crate) async fn list_pod_metrics(
    client: &Client,
) -> Result<HashMap<String, PodMetric>, MetricsError> {
    // metrics-server publishes these under the "pods.metrics.k8s.io" /
    // "nodes.metrics.k8s.io" resource names, so the plural is "pods" /
    // "nodes" — NOT the auto-derived "podmetricses". `from_gvk` silently
    // guesses, so we have to spell the plural out.
    let ar = ApiResource::from_gvk_with_plural(
        &GroupVersionKind {
            group: "metrics.k8s.io".into(),
            version: "v1beta1".into(),
            kind: "PodMetrics".into(),
        },
        "pods",
    );
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let list = api.list(&ListParams::default()).await?;

    let mut out = HashMap::new();
    for obj in list.items {
        let namespace = obj.metadata.namespace.clone().unwrap_or_default();
        let name = obj.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }

        let mut cpu = 0u64;
        let mut mem = 0u64;
        if let Some(containers) = obj.data.get("containers").and_then(|v| v.as_array()) {
            for c in containers {
                if let Some(usage) = c.get("usage") {
                    if let Some(s) = usage.get("cpu").and_then(|v| v.as_str()) {
                        cpu += cpu_milli(s);
                    }
                    if let Some(s) = usage.get("memory").and_then(|v| v.as_str()) {
                        mem += mem_mib(s);
                    }
                }
            }
        }
        let key = format!("{namespace}/{name}");
        out.insert(
            key,
            PodMetric {
                namespace,
                name,
                cpu_milli: cpu,
                mem_mib: mem,
            },
        );
    }
    Ok(out)
}

pub(crate) async fn list_node_metrics(
    client: &Client,
) -> Result<HashMap<String, (u64, u64)>, MetricsError> {
    // Returns name → (cpu_milli, mem_mib). Same plural caveat as pod metrics.
    let ar = ApiResource::from_gvk_with_plural(
        &GroupVersionKind {
            group: "metrics.k8s.io".into(),
            version: "v1beta1".into(),
            kind: "NodeMetrics".into(),
        },
        "nodes",
    );
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let list = api.list(&ListParams::default()).await?;

    let mut out = HashMap::new();
    for obj in list.items {
        let name = obj.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let usage = obj.data.get("usage");
        let cpu = usage
            .and_then(|u| u.get("cpu"))
            .and_then(|v| v.as_str())
            .map_or(0, cpu_milli);
        let mem = usage
            .and_then(|u| u.get("memory"))
            .and_then(|v| v.as_str())
            .map_or(0, mem_mib);
        out.insert(name, (cpu, mem));
    }
    Ok(out)
}

pub(crate) async fn list_node_capacity(
    client: &Client,
) -> Result<HashMap<String, (u64, u64)>, MetricsError> {
    let api: Api<Node> = Api::all(client.clone());
    let list = api.list(&ListParams::default()).await?;
    let mut out = HashMap::new();
    for n in list.items {
        let name = match n.metadata.name {
            Some(n) => n,
            None => continue,
        };
        let cap = n
            .status
            .as_ref()
            .and_then(|s| s.capacity.as_ref())
            .or_else(|| n.status.as_ref().and_then(|s| s.allocatable.as_ref()));
        let (mut cpu, mut mem) = (0u64, 0u64);
        if let Some(cap) = cap {
            if let Some(c) = cap.get("cpu") {
                cpu = cpu_milli(&c.0);
            }
            if let Some(m) = cap.get("memory") {
                mem = mem_mib(&m.0);
            }
        }
        out.insert(name, (cpu, mem));
    }
    Ok(out)
}

/// Pull volume usage from every node's kubelet `/stats/summary`, routed
/// through the apiserver proxy so we re-use the user's auth and don't need
/// any direct kubelet reachability.
///
/// Returns `(by_pod, by_pvc)`. The caller treats an empty result as
/// "`volumes_available` = false" — a common cause is RBAC denying
/// `nodes/proxy`, so we don't surface that as an error per se. Per-node
/// failures are logged at debug and skipped: one unreachable kubelet should
/// not prevent the rest of the cluster's volumes from showing up.
pub(crate) async fn list_volume_stats(
    client: &Client,
) -> Result<
    (
        HashMap<String, Vec<VolumeMetric>>,
        HashMap<String, VolumeMetric>,
    ),
    MetricsError,
> {
    let nodes_api: Api<Node> = Api::all(client.clone());
    let nodes = nodes_api.list(&ListParams::default()).await?;
    let names: Vec<String> = nodes
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect();
    if names.is_empty() {
        return Ok((HashMap::new(), HashMap::new()));
    }

    let mut tasks = FuturesUnordered::new();
    let mut iter = names.into_iter();
    // Seed up to KUBELET_FETCH_CONCURRENCY in flight, then refill as each
    // completes. Bounded so a giant cluster doesn't blast the apiserver.
    for _ in 0..KUBELET_FETCH_CONCURRENCY {
        if let Some(name) = iter.next() {
            tasks.push(fetch_node_summary(client.clone(), name));
        } else {
            break;
        }
    }

    let mut by_pod: HashMap<String, Vec<VolumeMetric>> = HashMap::new();
    let mut by_pvc: HashMap<String, VolumeMetric> = HashMap::new();
    while let Some(res) = tasks.next().await {
        if let Some(name) = iter.next() {
            tasks.push(fetch_node_summary(client.clone(), name));
        }
        let summary = match res {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(error = %e, "kubelet stats/summary fetch failed for a node");
                continue;
            }
        };
        parse_summary(&summary, &mut by_pod, &mut by_pvc);
    }
    Ok((by_pod, by_pvc))
}

async fn fetch_node_summary(client: Client, node: String) -> Result<Value, MetricsError> {
    let path = format!("/api/v1/nodes/{node}/proxy/stats/summary");
    let req = Request::builder()
        .method("GET")
        .uri(&path)
        .header("accept", "application/json")
        .body(Vec::new())
        .map_err(|e| {
            MetricsError::Kube(kube::Error::Service(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                e.to_string(),
            ))))
        })?;
    let resp: Value = client.request(req).await?;
    Ok(resp)
}

fn parse_summary(
    summary: &Value,
    by_pod: &mut HashMap<String, Vec<VolumeMetric>>,
    by_pvc: &mut HashMap<String, VolumeMetric>,
) {
    let Some(pods) = summary.get("pods").and_then(Value::as_array) else {
        return;
    };
    for pod in pods {
        let pod_ref = pod.get("podRef");
        let pod_namespace = pod_ref
            .and_then(|r| r.get("namespace"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let pod_name = pod_ref
            .and_then(|r| r.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if pod_name.is_empty() {
            continue;
        }
        let key = format!("{pod_namespace}/{pod_name}");

        let Some(vols) = pod.get("volume").and_then(Value::as_array) else {
            continue;
        };
        for vol in vols {
            let m = match parse_volume(vol, &pod_namespace, &pod_name) {
                Some(m) => m,
                None => continue,
            };
            if let (Some(ns), Some(name)) = (m.pvc_namespace.as_deref(), m.pvc_name.as_deref()) {
                by_pvc.insert(format!("{ns}/{name}"), m.clone());
            }
            by_pod.entry(key.clone()).or_default().push(m);
        }
    }
}

fn parse_volume(vol: &Value, pod_ns: &str, pod_name: &str) -> Option<VolumeMetric> {
    let volume_name = vol.get("name").and_then(Value::as_str)?.to_string();
    // kubelet emits all four fields when the volume is mounted; missing
    // fields mean the volume hasn't been measured yet (just-created pod).
    let used_bytes = vol.get("usedBytes").and_then(Value::as_u64).unwrap_or(0);
    let capacity_bytes = vol
        .get("capacityBytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let available_bytes = vol
        .get("availableBytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let used_inodes = vol.get("inodesUsed").and_then(Value::as_u64).unwrap_or(0);
    let capacity_inodes = vol.get("inodes").and_then(Value::as_u64).unwrap_or(0);

    let pvc_ref = vol.get("pvcRef");
    let pvc_namespace = pvc_ref
        .and_then(|r| r.get("namespace"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let pvc_name = pvc_ref
        .and_then(|r| r.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(VolumeMetric {
        pod_namespace: pod_ns.to_owned(),
        pod_name: pod_name.to_owned(),
        volume_name,
        pvc_namespace,
        pvc_name,
        used_bytes,
        capacity_bytes,
        available_bytes,
        used_inodes,
        capacity_inodes,
    })
}

fn aggregate(
    used: &HashMap<String, (u64, u64)>,
    caps: &HashMap<String, (u64, u64)>,
) -> ClusterMetrics {
    // Sum used over the nodes the metrics API reported on; sum capacity over
    // the nodes the apiserver reports — these can differ briefly when a node
    // joins (capacity but no metrics yet) but always converge.
    let cpu_used: u64 = used.values().map(|(c, _)| c).sum();
    let mem_used: u64 = used.values().map(|(_, m)| m).sum();
    let cpu_cap: u64 = caps.values().map(|(c, _)| c).sum();
    let mem_cap: u64 = caps.values().map(|(_, m)| m).sum();
    ClusterMetrics {
        cpu_used_milli: cpu_used,
        cpu_capacity_milli: cpu_cap,
        mem_used_mib: mem_used,
        mem_capacity_mib: mem_cap,
    }
}

// ── Quantity parsing ───────────────────────────────────────────────────────
// Kubernetes resource.Quantity uses either a decimal SI suffix (n, u, m, K,
// M, G, T, P, E) or a binary IEC suffix (Ki, Mi, Gi, Ti, Pi, Ei). We parse
// to base units (cores, bytes) and then convert to milli/Mi at the call site.

fn parse_quantity_base(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let split = s
        .char_indices()
        .find(|(_, c)| !matches!(c, '0'..='9' | '.' | '+' | '-' | 'e' | 'E'))
        .map_or(s.len(), |(i, _)| i);
    let (num, suf) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult: f64 = match suf {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "K" | "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024.0,
        "Mi" => 1024.0_f64.powi(2),
        "Gi" => 1024.0_f64.powi(3),
        "Ti" => 1024.0_f64.powi(4),
        "Pi" => 1024.0_f64.powi(5),
        "Ei" => 1024.0_f64.powi(6),
        _ => return None,
    };
    Some(n * mult)
}

fn cpu_milli(s: &str) -> u64 {
    parse_quantity_base(s).map_or(0, |c| (c * 1000.0).round().max(0.0) as u64)
}

fn mem_mib(s: &str) -> u64 {
    parse_quantity_base(s).map_or(0, |b| (b / (1024.0 * 1024.0)).round().max(0.0) as u64)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_quantities() {
        assert_eq!(cpu_milli("142m"), 142);
        assert_eq!(cpu_milli("1"), 1000);
        assert_eq!(cpu_milli("0.5"), 500);
        assert_eq!(cpu_milli("100u"), 0); // sub-milli rounds down
        assert_eq!(cpu_milli("2.5"), 2500);
    }

    #[test]
    fn cpu_nano_micro_units() {
        // metrics-server can emit nano-CPU on quiet pods. These are the
        // edge cases that historically rounded the wrong way.
        assert_eq!(cpu_milli("0"), 0);
        assert_eq!(cpu_milli("999999n"), 1); // 999999 * 1e-9 * 1000 ≈ 1.0
        assert_eq!(cpu_milli("500000u"), 500); // 500 milli
        assert_eq!(cpu_milli("1500m"), 1500);
        // Pathological large input doesn't panic.
        assert_eq!(cpu_milli("1000000000"), 1_000_000_000_000);
    }

    #[test]
    fn memory_quantities() {
        assert_eq!(mem_mib("384Mi"), 384);
        assert_eq!(mem_mib("2Gi"), 2048);
        // 1024 KiB = 1 MiB
        assert_eq!(mem_mib("1024Ki"), 1);
        // 2 MB = ~1.9 MiB
        assert_eq!(mem_mib("2M"), 2);
    }

    #[test]
    fn memory_unit_coverage() {
        // Each multiplier suffix Kubernetes accepts.
        assert_eq!(mem_mib("1Gi"), 1024);
        assert_eq!(mem_mib("1Ti"), 1024 * 1024);
        assert_eq!(mem_mib("1G"), 954); // 1e9 / 2^20 ≈ 953.67 → 954
        assert_eq!(mem_mib("1T"), 953_674);
        // Bare bytes — must round, not truncate.
        assert_eq!(mem_mib("1048576"), 1);
        assert_eq!(mem_mib("524287"), 0); // < 0.5 MiB rounds down
        assert_eq!(mem_mib("524288"), 1); // = 0.5 MiB rounds up
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(cpu_milli(""), 0);
        assert_eq!(cpu_milli("nope"), 0);
        assert_eq!(mem_mib("?"), 0);
        assert_eq!(mem_mib("Mi"), 0); // suffix without number
        assert_eq!(cpu_milli("--1"), 0);
        // Negative values clamp to 0 instead of underflowing.
        assert_eq!(cpu_milli("-1"), 0);
        assert_eq!(mem_mib("-1Gi"), 0);
    }

    #[test]
    fn snapshot_serializes_with_defaults() {
        // MetricsSnapshot needs to round-trip cleanly so subscribers can
        // tolerate both old (no volumes_available) and new shapes.
        let s = MetricsSnapshot {
            pods: HashMap::new(),
            cluster: None,
            pod_volumes: HashMap::new(),
            pvcs: HashMap::new(),
            available: false,
            volumes_available: false,
            fetched_at_unix_ms: 1_700_000_000_000,
        };
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["available"], false);
        assert_eq!(j["volumes_available"], false);
        assert_eq!(j["fetched_at_unix_ms"], 1_700_000_000_000_i64);
    }
}
