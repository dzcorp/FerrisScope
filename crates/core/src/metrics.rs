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
//! Subscribers declare a [`MetricsNeed`]: the per-pod map and kubelet volume
//! stats are the expensive parts (a 2.6k-pod `PodMetrics` list; one proxied
//! request per node), so each is polled only while someone needs it.
//!
//! One service per cluster, started lazily on first subscribe and refcounted
//! by the app layer. Polls every [`REFRESH_SECS`] seconds — metrics-server
//! re-scrapes about that often, so a faster poll mostly re-fetches the same
//! readings — and skips broadcasting a snapshot whose readings didn't move.
//!
//! If metrics-server isn't installed (404 on the API group), the service
//! stays alive and emits `available: false` snapshots so the UI can render
//! "—" instead of pretending values are loading. The volume side has its
//! own `volumes_available` flag because metrics-server and kubelet stats
//! fail independently — one common case is RBAC granting `metrics.k8s.io`
//! but not `nodes/proxy`.
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::{stream::FuturesUnordered, StreamExt};
use http::Request;
use kube::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex, Notify};
use tokio::task::JoinHandle;
use tokio::time::{interval, MissedTickBehavior};

/// Cap on parallel kubelet stats/summary fetches per tick. The endpoint is
/// cheap (kubelet caches internally) but for a 500-node cluster we still
/// don't want 500 simultaneous proxied requests to the apiserver.
const KUBELET_FETCH_CONCURRENCY: usize = 16;

pub const REFRESH_SECS: u64 = 30;
const BROADCAST_CAP: usize = 16;

/// A full Node LIST is ~23 KB per node (mostly `status.images`) and capacity
/// only moves when nodes join, leave or resize. A node reported by
/// NodeMetrics but missing here forces an early refresh.
const CAPACITY_TTL: Duration = Duration::from_mins(5);

/// Kubelet volume stats cost one proxied request per node; volume usage
/// drifts slowly, so fan out every Nth tick and reuse the result between.
const VOLUME_EVERY_TICKS: u32 = 2;

/// Hold the first metrics poll back this long after the service starts.
///
/// The metrics polling task is launched eagerly the moment the user picks a
/// cluster (App.tsx subscribes here so cluster-bar gauges + pod-table
/// CPU/Mem cells light up without per-component coordination). On clusters
/// that actually have metrics-server installed, the very first poll fires:
///
/// * `LIST PodMetrics` (cluster-wide),
/// * `LIST NodeMetrics`,
/// * `LIST Nodes` (capacity + the kubelet fan-out's node names),
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PodMetric {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: u64,
    pub mem_mib: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize)]
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
    /// `None` while no subscriber wants volumes (or before the first volume
    /// poll); `Some(false)` when no kubelet `stats/summary` could be reached
    /// (RBAC denied `nodes/proxy`, every node refused, or zero nodes).
    /// Independent of `available` — many clusters have one but not the other.
    pub volumes_available: Option<bool>,
    pub fetched_at_unix_ms: i64,
}

impl MetricsSnapshot {
    /// Same readings, ignoring when they were fetched.
    fn same_readings(&self, other: &Self) -> bool {
        self.available == other.available
            && self.volumes_available == other.volumes_available
            && self.cluster == other.cluster
            && self.pods == other.pods
            && self.pod_volumes == other.pod_volumes
            && self.pvcs == other.pvcs
    }
}

pub struct MetricsService {
    /// Broadcast carries `Arc<MetricsSnapshot>` so subscribers (and the
    /// `last` cache) share one allocation per tick instead of cloning the
    /// full HashMap-of-pods every time. On a 5000-pod cluster this is
    /// the difference between MBs of allocation per tick and a refcount
    /// bump per subscriber.
    tx: broadcast::Sender<Arc<MetricsSnapshot>>,
    last: Arc<Mutex<Option<Arc<MetricsSnapshot>>>>,
    demand: Arc<Demand>,
    task: JoinHandle<()>,
}

/// What a subscriber reads from snapshots. Cluster totals are always polled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricsNeed {
    Cluster,
    Pods,
    Volumes,
}

#[derive(Default)]
struct Demand {
    pods: AtomicUsize,
    volumes: AtomicUsize,
    /// Wakes the poll loop when a part is first needed, so the view doesn't
    /// wait up to a full tick.
    wake: Notify,
}

impl Demand {
    fn counter(&self, need: MetricsNeed) -> Option<&AtomicUsize> {
        match need {
            MetricsNeed::Cluster => None,
            MetricsNeed::Pods => Some(&self.pods),
            MetricsNeed::Volumes => Some(&self.volumes),
        }
    }

    fn wants(&self) -> Wants {
        Wants {
            pods: self.pods.load(Ordering::SeqCst) > 0,
            volumes: self.volumes.load(Ordering::SeqCst) > 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Wants {
    pods: bool,
    volumes: bool,
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
        let demand = Arc::new(Demand::default());

        let task = tokio::spawn({
            let tx = tx.clone();
            let last = last.clone();
            let demand = demand.clone();
            async move {
                // Hold off the first poll so the operator's first
                // `subscribe_resource` LIST (Pods etc.) wins the apiserver.
                // See [`INITIAL_POLL_DELAY`].
                tokio::time::sleep(INITIAL_POLL_DELAY).await;
                let mut tick = interval(Duration::from_secs(REFRESH_SECS));
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                let mut cache = PollCache::default();
                loop {
                    tokio::select! {
                        _ = tick.tick() => {}
                        () = demand.wake.notified() => {}
                    }
                    let snap = Arc::new(poll(&client, &mut cache, demand.wants()).await);
                    let mut last_guard = last.lock().await;
                    let unchanged = last_guard
                        .as_deref()
                        .is_some_and(|p| p.same_readings(&snap));
                    *last_guard = Some(snap.clone());
                    drop(last_guard);
                    if unchanged {
                        continue;
                    }
                    // No subscribers is fine — broadcast::send returns Err
                    // but we don't care: the next subscriber will see the
                    // cached snapshot via .snapshot().
                    let _ = tx.send(snap);
                }
            }
        });

        Arc::new(Self {
            tx,
            last,
            demand,
            task,
        })
    }

    /// Poll what `need` reads until the matching [`Self::release`].
    pub fn want(&self, need: MetricsNeed) {
        if let Some(n) = self.demand.counter(need) {
            if n.fetch_add(1, Ordering::SeqCst) == 0 {
                self.demand.wake.notify_one();
            }
        }
    }

    pub fn release(&self, need: MetricsNeed) {
        if let Some(n) = self.demand.counter(need) {
            let _ = n.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        }
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

type NodeCaps = HashMap<String, (u64, u64)>;
type VolumeStats = (
    HashMap<String, Vec<VolumeMetric>>,
    HashMap<String, VolumeMetric>,
);

/// State carried between ticks of one cluster's polling loop.
#[derive(Default)]
struct PollCache {
    caps: Option<(Instant, Arc<NodeCaps>)>,
    /// `None` until polled, and again whenever nobody wants volumes.
    volumes: Option<VolumeStats>,
    tick: u32,
}

impl PollCache {
    fn fresh_caps(&self) -> Option<Arc<NodeCaps>> {
        self.caps
            .as_ref()
            .filter(|(at, _)| at.elapsed() < CAPACITY_TTL)
            .map(|(_, c)| c.clone())
    }

    /// `true` when volumes are wanted and either unpolled or last polled
    /// [`VOLUME_EVERY_TICKS`] ticks ago. Unwanted drops the cached stats.
    fn volumes_due(&mut self, wanted: bool) -> bool {
        if !wanted {
            self.volumes = None;
            return false;
        }
        let due = self.volumes.is_none() || self.tick >= VOLUME_EVERY_TICKS;
        if due {
            self.tick = 0;
        }
        self.tick += 1;
        due
    }
}

/// A node NodeMetrics reports that the cached capacity map lacks — the
/// cluster scaled up since the last Node LIST.
fn has_unknown_node(used: &NodeCaps, caps: &NodeCaps) -> bool {
    used.keys().any(|n| !caps.contains_key(n))
}

/// Single tick: fetch metrics-server data and kubelet stats/summary, then
/// assemble a snapshot. Each side fails independently — missing
/// metrics-server doesn't mask kubelet volume stats and vice versa, because
/// operators commonly have one but not both.
async fn poll(client: &Client, cache: &mut PollCache, wants: Wants) -> MetricsSnapshot {
    // Resolve the metrics-server / capacity calls independently so a failure
    // in one doesn't mask the others. Operators commonly run partial setups
    // (metrics-server serving PodMetrics but NodeMetrics RBAC-denied, or node
    // capacity readable while metrics-server is absent).
    let cached = cache.fresh_caps();
    let (pods_res, nodes_res, caps_res) = tokio::join!(
        async {
            if wants.pods {
                Some(list_pod_metrics(client).await)
            } else {
                None
            }
        },
        list_node_metrics(client),
        async {
            match cached {
                Some(c) => Ok((c, false)),
                None => list_node_capacity(client)
                    .await
                    .map(|c| (Arc::new(c), true)),
            }
        },
    );
    let caps_res = match caps_res {
        Ok((c, false)) if nodes_res.as_ref().is_ok_and(|n| has_unknown_node(n, &c)) => {
            list_node_capacity(client)
                .await
                .map(|c| (Arc::new(c), true))
        }
        other => other,
    };
    let caps_res = caps_res.map(|(c, fetched)| {
        if fetched {
            cache.caps = Some((Instant::now(), c.clone()));
        }
        c
    });

    // Warn on genuine failures; stay quiet on 404 (the API / metrics-server
    // simply isn't installed — an expected, common state).
    fn note(label: &str, e: &MetricsError) {
        let absent = matches!(e, MetricsError::Kube(kube::Error::Api(err)) if err.code == 404);
        if !absent {
            tracing::warn!(error = %e, "{label} poll failed");
        }
    }

    // Node names for the kubelet fan-out come from the capacity map; without
    // it (RBAC denies listing nodes) volume stats are unavailable, as before.
    if cache.volumes_due(wants.volumes) {
        cache.volumes = Some(match &caps_res {
            Ok(caps) => list_volume_stats(client, caps.keys().cloned().collect()).await,
            Err(_) => VolumeStats::default(),
        });
    }

    // `available` tracks the per-pod list when it was polled (the table joins
    // on it), else NodeMetrics. (ClusterBar gates its gauge on
    // `available && cluster`, and `cluster` requires both node calls below.)
    let (available, pods) = match pods_res {
        Some(Ok(p)) => (true, p),
        Some(Err(e)) => {
            note("pod metrics", &e);
            (false, HashMap::new())
        }
        None => (nodes_res.is_ok(), HashMap::new()),
    };

    let nodes = match nodes_res {
        Ok(n) => Some(n),
        Err(e) => {
            note("node metrics", &e);
            None
        }
    };
    let caps = match caps_res {
        Ok(c) => Some(c),
        Err(e) => {
            note("node capacity", &e);
            None
        }
    };
    let cluster = cluster_aggregate(nodes.as_ref(), caps.as_deref());

    let (pod_volumes, pvcs) = cache.volumes.clone().unwrap_or_default();
    let volumes_available = cache
        .volumes
        .as_ref()
        .map(|_| !pod_volumes.is_empty() || !pvcs.is_empty());

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

// ── Wire shapes ────────────────────────────────────────────────────────────
// Only the fields we read. Deserialising straight into these skips the rest
// of each payload (container/network stats, node images, managedFields)
// without building a `Value` tree for it. Every field is optional so shape
// drift degrades to zeros instead of failing the whole list.

#[derive(Deserialize)]
struct ListWire<T> {
    items: Option<Vec<T>>,
}

#[derive(Deserialize)]
struct MetaWire {
    name: Option<String>,
    namespace: Option<String>,
}

#[derive(Deserialize)]
struct UsageWire {
    cpu: Option<String>,
    memory: Option<String>,
}

#[derive(Deserialize)]
struct PodMetricsWire {
    metadata: Option<MetaWire>,
    containers: Option<Vec<ContainerMetricsWire>>,
}

#[derive(Deserialize)]
struct ContainerMetricsWire {
    usage: Option<UsageWire>,
}

#[derive(Deserialize)]
struct NodeMetricsWire {
    metadata: Option<MetaWire>,
    usage: Option<UsageWire>,
}

#[derive(Deserialize)]
struct NodeWire {
    metadata: Option<MetaWire>,
    status: Option<NodeStatusWire>,
}

#[derive(Deserialize)]
struct NodeStatusWire {
    capacity: Option<HashMap<String, String>>,
    allocatable: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct SummaryWire {
    pods: Option<Vec<PodStatsWire>>,
}

#[derive(Deserialize)]
struct PodStatsWire {
    #[serde(rename = "podRef")]
    pod_ref: Option<MetaWire>,
    volume: Option<Vec<VolumeWire>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VolumeWire {
    name: Option<String>,
    used_bytes: Option<u64>,
    capacity_bytes: Option<u64>,
    available_bytes: Option<u64>,
    inodes_used: Option<u64>,
    inodes: Option<u64>,
    pvc_ref: Option<MetaWire>,
}

fn builder_error(e: &http::Error) -> MetricsError {
    MetricsError::Kube(kube::Error::Service(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        e.to_string(),
    ))))
}

async fn get_json<T: DeserializeOwned>(client: &Client, path: &str) -> Result<T, MetricsError> {
    let req = Request::get(path)
        .header("accept", "application/json")
        .body(Vec::new())
        .map_err(|e| builder_error(&e))?;
    Ok(client.request::<T>(req).await?)
}

// metrics-server publishes these under the "pods" / "nodes" resource names —
// NOT the auto-derived "podmetricses".
const POD_METRICS_PATH: &str = "/apis/metrics.k8s.io/v1beta1/pods";
const NODE_METRICS_PATH: &str = "/apis/metrics.k8s.io/v1beta1/nodes";
const NODES_PATH: &str = "/api/v1/nodes";

pub(crate) async fn list_pod_metrics(
    client: &Client,
) -> Result<HashMap<String, PodMetric>, MetricsError> {
    Ok(pod_metrics_from(get_json(client, POD_METRICS_PATH).await?))
}

fn pod_metrics_from(list: ListWire<PodMetricsWire>) -> HashMap<String, PodMetric> {
    let items = list.items.unwrap_or_default();
    let mut out = HashMap::with_capacity(items.len());
    for obj in items {
        let (namespace, name) = obj
            .metadata
            .map(|m| (m.namespace.unwrap_or_default(), m.name.unwrap_or_default()))
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let (mut cpu, mut mem) = (0u64, 0u64);
        for usage in obj.containers.into_iter().flatten().filter_map(|c| c.usage) {
            cpu += usage.cpu.as_deref().map_or(0, cpu_milli);
            mem += usage.memory.as_deref().map_or(0, mem_mib);
        }
        out.insert(
            format!("{namespace}/{name}"),
            PodMetric {
                namespace,
                name,
                cpu_milli: cpu,
                mem_mib: mem,
            },
        );
    }
    out
}

/// Returns name → (cpu_milli, mem_mib).
pub(crate) async fn list_node_metrics(client: &Client) -> Result<NodeCaps, MetricsError> {
    Ok(node_metrics_from(
        get_json(client, NODE_METRICS_PATH).await?,
    ))
}

fn node_metrics_from(list: ListWire<NodeMetricsWire>) -> NodeCaps {
    list.items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|obj| {
            let name = obj.metadata?.name.filter(|n| !n.is_empty())?;
            let usage = obj.usage;
            let cpu = usage
                .as_ref()
                .and_then(|u| u.cpu.as_deref())
                .map_or(0, cpu_milli);
            let mem = usage
                .as_ref()
                .and_then(|u| u.memory.as_deref())
                .map_or(0, mem_mib);
            Some((name, (cpu, mem)))
        })
        .collect()
}

pub(crate) async fn list_node_capacity(client: &Client) -> Result<NodeCaps, MetricsError> {
    Ok(node_capacity_from(get_json(client, NODES_PATH).await?))
}

fn node_capacity_from(list: ListWire<NodeWire>) -> NodeCaps {
    list.items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|n| {
            let name = n.metadata?.name.filter(|n| !n.is_empty())?;
            let cap = n.status.and_then(|s| s.capacity.or(s.allocatable));
            let get = |k: &str| cap.as_ref().and_then(|c| c.get(k)).map(String::as_str);
            Some((
                name,
                (
                    get("cpu").map_or(0, cpu_milli),
                    get("memory").map_or(0, mem_mib),
                ),
            ))
        })
        .collect()
}

/// Pull volume usage from each named node's kubelet `/stats/summary`, routed
/// through the apiserver proxy so we re-use the user's auth and don't need
/// any direct kubelet reachability.
///
/// Returns `(by_pod, by_pvc)`. The caller treats an empty result as
/// "`volumes_available` = false" — a common cause is RBAC denying
/// `nodes/proxy`. Per-node failures are logged at debug and skipped: one
/// unreachable kubelet should not hide the rest of the cluster's volumes.
async fn list_volume_stats(client: &Client, names: Vec<String>) -> VolumeStats {
    let mut tasks = FuturesUnordered::new();
    let mut iter = names.into_iter();
    // Seed up to KUBELET_FETCH_CONCURRENCY in flight, then refill as each
    // completes. Bounded so a giant cluster doesn't blast the apiserver.
    for name in iter.by_ref().take(KUBELET_FETCH_CONCURRENCY) {
        tasks.push(fetch_node_summary(client, name));
    }

    let mut out = VolumeStats::default();
    while let Some(res) = tasks.next().await {
        if let Some(name) = iter.next() {
            tasks.push(fetch_node_summary(client, name));
        }
        match res {
            Ok(summary) => parse_summary(summary, &mut out.0, &mut out.1),
            Err(e) => {
                tracing::debug!(error = %e, "kubelet stats/summary fetch failed for a node");
            }
        }
    }
    out
}

async fn fetch_node_summary(client: &Client, node: String) -> Result<SummaryWire, MetricsError> {
    get_json(client, &format!("/api/v1/nodes/{node}/proxy/stats/summary")).await
}

fn parse_summary(
    summary: SummaryWire,
    by_pod: &mut HashMap<String, Vec<VolumeMetric>>,
    by_pvc: &mut HashMap<String, VolumeMetric>,
) {
    for pod in summary.pods.into_iter().flatten() {
        let (pod_namespace, pod_name) = pod
            .pod_ref
            .map(|r| (r.namespace.unwrap_or_default(), r.name.unwrap_or_default()))
            .unwrap_or_default();
        if pod_name.is_empty() {
            continue;
        }
        let mut metrics = Vec::new();
        for vol in pod.volume.into_iter().flatten() {
            let Some(m) = volume_metric(vol, &pod_namespace, &pod_name) else {
                continue;
            };
            if let (Some(ns), Some(name)) = (m.pvc_namespace.as_deref(), m.pvc_name.as_deref()) {
                by_pvc.insert(format!("{ns}/{name}"), m.clone());
            }
            metrics.push(m);
        }
        if !metrics.is_empty() {
            by_pod
                .entry(format!("{pod_namespace}/{pod_name}"))
                .or_default()
                .extend(metrics);
        }
    }
}

fn volume_metric(vol: VolumeWire, pod_ns: &str, pod_name: &str) -> Option<VolumeMetric> {
    // kubelet emits all four fields when the volume is mounted; missing
    // fields mean the volume hasn't been measured yet (just-created pod).
    let (pvc_namespace, pvc_name) = vol.pvc_ref.map_or((None, None), |r| (r.namespace, r.name));
    Some(VolumeMetric {
        pod_namespace: pod_ns.to_owned(),
        pod_name: pod_name.to_owned(),
        volume_name: vol.name?,
        pvc_namespace,
        pvc_name,
        used_bytes: vol.used_bytes.unwrap_or(0),
        capacity_bytes: vol.capacity_bytes.unwrap_or(0),
        available_bytes: vol.available_bytes.unwrap_or(0),
        used_inodes: vol.inodes_used.unwrap_or(0),
        capacity_inodes: vol.inodes.unwrap_or(0),
    })
}

/// Cluster aggregate from independently-resolved node usage + capacity. An
/// aggregate needs BOTH, so a failure in either yields `None` (the gauge is
/// suppressed) without discarding the per-pod metrics resolved alongside it.
fn cluster_aggregate(
    nodes: Option<&HashMap<String, (u64, u64)>>,
    caps: Option<&HashMap<String, (u64, u64)>>,
) -> Option<ClusterMetrics> {
    match (nodes, caps) {
        (Some(n), Some(c)) => Some(aggregate(n, c)),
        _ => None,
    }
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
// The Quantity → base-unit parser lives in `crate::quantity` (shared with
// kube-ext so there's one copy). Here we only convert: cores → millicores and
// bytes → MiB, both clamped to a non-negative `u64` for the gauges.

fn cpu_milli(s: &str) -> u64 {
    crate::quantity::parse_quantity(s).map_or(0, |c| (c * 1000.0).round().max(0.0) as u64)
}

fn mem_mib(s: &str) -> u64 {
    crate::quantity::parse_quantity(s)
        .map_or(0, |b| (b / (1024.0 * 1024.0)).round().max(0.0) as u64)
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
    fn cluster_aggregate_requires_both_nodes_and_caps() {
        let nodes = HashMap::from([("n1".to_owned(), (1000u64, 2048u64))]);
        let caps = HashMap::from([("n1".to_owned(), (4000u64, 8192u64))]);

        // Both present → aggregate over the nodes.
        let agg = cluster_aggregate(Some(&nodes), Some(&caps)).expect("aggregate");
        assert_eq!(agg.cpu_used_milli, 1000);
        assert_eq!(agg.cpu_capacity_milli, 4000);
        assert_eq!(agg.mem_used_mib, 2048);
        assert_eq!(agg.mem_capacity_mib, 8192);

        // Missing either side → None: the gauge is suppressed, but this is the
        // path that previously also discarded per-pod metrics. It no longer does.
        assert!(cluster_aggregate(None, Some(&caps)).is_none());
        assert!(cluster_aggregate(Some(&nodes), None).is_none());
        assert!(cluster_aggregate(None, None).is_none());
    }

    fn wire<T: DeserializeOwned>(v: serde_json::Value) -> T {
        serde_json::from_value(v).expect("wire shape")
    }

    #[test]
    fn pod_metrics_sum_containers_and_skip_unnamed() {
        let list = wire(serde_json::json!({
            "kind": "PodMetricsList",
            "items": [
                {
                    "metadata": { "name": "web", "namespace": "prod", "labels": { "a": "b" } },
                    "timestamp": "2026-01-01T00:00:00Z",
                    "containers": [
                        { "name": "app", "usage": { "cpu": "250m", "memory": "128Mi" } },
                        { "name": "sidecar", "usage": { "cpu": "5000000n", "memory": "64Mi" } },
                        { "name": "no-usage" }
                    ]
                },
                { "metadata": { "namespace": "prod" }, "containers": [] },
                { "metadata": { "name": "idle", "namespace": "prod" }, "containers": null }
            ]
        }));
        let out = pod_metrics_from(list);
        assert_eq!(out.len(), 2);
        let web = &out["prod/web"];
        assert_eq!((web.cpu_milli, web.mem_mib), (255, 192));
        assert_eq!(out["prod/idle"].cpu_milli, 0);
    }

    #[test]
    fn empty_or_null_items_yield_empty_maps() {
        let null: ListWire<PodMetricsWire> = wire(serde_json::json!({ "items": null }));
        assert!(pod_metrics_from(null).is_empty());
        let missing: ListWire<NodeWire> = wire(serde_json::json!({}));
        assert!(node_capacity_from(missing).is_empty());
    }

    #[test]
    fn node_metrics_and_capacity_parse() {
        let used = node_metrics_from(wire(serde_json::json!({
            "items": [
                { "metadata": { "name": "n1" }, "usage": { "cpu": "1500m", "memory": "2Gi" } },
                { "metadata": { "name": "" }, "usage": { "cpu": "1" } }
            ]
        })));
        assert_eq!(used, HashMap::from([("n1".to_owned(), (1500, 2048))]));

        let caps = node_capacity_from(wire(serde_json::json!({
            "items": [
                {
                    "metadata": { "name": "n1", "managedFields": [{ "manager": "kubelet" }] },
                    "status": {
                        "capacity": { "cpu": "4", "memory": "16Gi", "pods": "110" },
                        "allocatable": { "cpu": "3900m", "memory": "15Gi" },
                        "images": [{ "names": ["x"], "sizeBytes": 1 }]
                    }
                },
                { "metadata": { "name": "n2" }, "status": { "allocatable": { "cpu": "2" } } },
                { "metadata": { "name": "n3" } }
            ]
        })));
        assert_eq!(caps["n1"], (4000, 16384));
        assert_eq!(caps["n2"], (2000, 0));
        assert_eq!(caps["n3"], (0, 0));
    }

    #[test]
    fn summary_indexes_pod_and_pvc_volumes() {
        let summary: SummaryWire = wire(serde_json::json!({
            "node": { "nodeName": "n1", "cpu": {} },
            "pods": [
                {
                    "podRef": { "name": "db-0", "namespace": "prod", "uid": "u" },
                    "containers": [{ "name": "pg", "cpu": { "usageNanoCores": 1 } }],
                    "volume": [
                        {
                            "name": "data", "usedBytes": 10, "capacityBytes": 100,
                            "availableBytes": 90, "inodesUsed": 1, "inodes": 50,
                            "pvcRef": { "name": "data-db-0", "namespace": "prod" }
                        },
                        { "name": "tmp", "usedBytes": 3 },
                        { "usedBytes": 7 }
                    ]
                },
                { "podRef": { "name": "no-vols", "namespace": "prod" } },
                { "podRef": { "name": "", "namespace": "prod" }, "volume": [{ "name": "x" }] }
            ]
        }));
        let (mut by_pod, mut by_pvc) = VolumeStats::default();
        parse_summary(summary, &mut by_pod, &mut by_pvc);

        assert_eq!(by_pod.len(), 1, "pods without named volumes get no entry");
        let vols = &by_pod["prod/db-0"];
        assert_eq!(vols.len(), 2);
        assert_eq!(vols[0].capacity_bytes, 100);
        assert_eq!(vols[1].volume_name, "tmp");
        assert_eq!(vols[1].capacity_bytes, 0);
        let pvc = &by_pvc["prod/data-db-0"];
        assert_eq!((pvc.used_bytes, pvc.capacity_inodes), (10, 50));
        assert_eq!(pvc.pod_name, "db-0");
    }

    #[test]
    fn unknown_node_forces_capacity_refresh() {
        let caps = HashMap::from([("n1".to_owned(), (1, 1))]);
        let same = HashMap::from([("n1".to_owned(), (0, 0))]);
        let grown = HashMap::from([("n1".to_owned(), (0, 0)), ("n2".to_owned(), (0, 0))]);
        assert!(!has_unknown_node(&same, &caps));
        assert!(has_unknown_node(&grown, &caps));
        // A node that left (capacity but no metrics) doesn't force a refetch.
        assert!(!has_unknown_node(&HashMap::new(), &caps));
    }

    #[test]
    fn poll_cache_capacity_ttl_and_volume_cadence() {
        let mut cache = PollCache::default();
        assert!(cache.fresh_caps().is_none());
        cache.caps = Some((Instant::now(), Arc::new(HashMap::new())));
        assert!(cache.fresh_caps().is_some());
        if let Some(expired) = Instant::now().checked_sub(CAPACITY_TTL) {
            cache.caps = Some((expired, Arc::new(HashMap::new())));
            assert!(cache.fresh_caps().is_none());
        }

        // Stats land after each due tick, as `poll` would store them.
        fn run(cache: &mut PollCache, wanted: bool) -> bool {
            let due = cache.volumes_due(wanted);
            if due {
                cache.volumes = Some(VolumeStats::default());
            }
            due
        }
        let due: Vec<bool> = (0..9).map(|_| run(&mut cache, true)).collect();
        let expected: Vec<bool> = (0..9u32).map(|i| i % VOLUME_EVERY_TICKS == 0).collect();
        assert_eq!(due, expected);

        // Unwanted drops the stats; wanting them again polls right away.
        assert!(!run(&mut cache, false));
        assert!(cache.volumes.is_none());
        assert!(!run(&mut cache, false));
        assert!(run(&mut cache, true));
        assert!(!run(&mut cache, true));
    }

    #[tokio::test]
    async fn demand_counts_each_need_and_wakes_the_poller() {
        let demand = Arc::new(Demand::default());
        let svc = MetricsService {
            tx: broadcast::channel(1).0,
            last: Arc::new(Mutex::new(None)),
            demand: demand.clone(),
            task: tokio::spawn(async {}),
        };
        let woken = || tokio::time::timeout(Duration::from_millis(50), demand.wake.notified());

        svc.release(MetricsNeed::Volumes);
        svc.want(MetricsNeed::Cluster);
        let w = demand.wants();
        assert!(!w.pods && !w.volumes, "cluster totals need nothing extra");
        assert!(woken().await.is_err());

        svc.want(MetricsNeed::Volumes);
        svc.want(MetricsNeed::Volumes);
        let w = demand.wants();
        assert!(!w.pods && w.volumes);
        // Only the first want of a part leaves a wake permit.
        assert!(woken().await.is_ok());
        assert!(woken().await.is_err());

        svc.want(MetricsNeed::Pods);
        assert!(demand.wants().pods);
        assert!(woken().await.is_ok());

        svc.release(MetricsNeed::Volumes);
        assert!(demand.wants().volumes);
        svc.release(MetricsNeed::Volumes);
        svc.release(MetricsNeed::Pods);
        svc.release(MetricsNeed::Cluster);
        let w = demand.wants();
        assert!(!w.pods && !w.volumes);
    }

    #[test]
    fn metrics_need_parses_from_the_wire() {
        let needs: Vec<MetricsNeed> =
            serde_json::from_str(r#"["cluster","pods","volumes"]"#).unwrap();
        assert_eq!(
            needs,
            [
                MetricsNeed::Cluster,
                MetricsNeed::Pods,
                MetricsNeed::Volumes
            ]
        );
    }

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
    fn same_readings_ignores_fetch_time_only() {
        let pod = |cpu| PodMetric {
            namespace: "ns".into(),
            name: "p".into(),
            cpu_milli: cpu,
            mem_mib: 10,
        };
        let snap = |cpu, at| MetricsSnapshot {
            pods: HashMap::from([("ns/p".to_owned(), pod(cpu))]),
            cluster: None,
            pod_volumes: HashMap::new(),
            pvcs: HashMap::new(),
            available: true,
            volumes_available: None,
            fetched_at_unix_ms: at,
        };
        assert!(snap(5, 1).same_readings(&snap(5, 2)));
        assert!(!snap(5, 1).same_readings(&snap(6, 1)));
        let mut volumes_polled = snap(5, 1);
        volumes_polled.volumes_available = Some(false);
        assert!(!snap(5, 1).same_readings(&volumes_polled));
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
            volumes_available: None,
            fetched_at_unix_ms: 1_700_000_000_000,
        };
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["available"], false);
        assert_eq!(j["volumes_available"], serde_json::Value::Null);
        assert_eq!(j["fetched_at_unix_ms"], 1_700_000_000_000_i64);
    }
}
