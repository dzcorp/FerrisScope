//! Tauri-managed app state.
//!
//! Holds one [`ClusterEntry`] per kubeconfig context the user has connected to.
//! Each entry owns the connected `Cluster` and a refcounted slot per resource
//! kind. Watchers are reference-counted: started on first subscribe, torn down
//! when the last subscriber drops.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ferrisscope_core::{
    cluster::Cluster, fleet::ClusterProbe, health::ClusterHealth, kubeconfig, logs::LogStream,
    metrics::MetricsService, search::SearchIndex, sources::SourcesFile, watcher::KubeconfigWatcher,
};
use ferrisscope_kube_ext::{ForwardHandle, ForwardStatus, ResourceWatcher};
use tokio::sync::{broadcast, oneshot, Mutex};

use crate::terminal::TerminalRegistry;

pub(crate) type ClusterId = String;
pub(crate) type KindId = String;
pub(crate) type StreamId = String;

pub(crate) struct ClusterEntry {
    pub(crate) cluster: Arc<Cluster>,
    /// One refcounted slot per resource kind id (see `ferrisscope_kube_ext::registry`).
    pub(crate) kinds: Mutex<HashMap<KindId, KindSlot>>,
    /// Refcounted metrics-server poller. Lazy: started on first `subscribe_metrics`,
    /// torn down (Drop aborts the task) on the last unsubscribe.
    pub(crate) metrics: Mutex<MetricsSlot>,
    /// Per-cluster apiserver heartbeat probe. Spawned eagerly at connect
    /// time so the operator gets unavailable signal even when no resource
    /// view has been subscribed yet. The probe broadcasts through
    /// `ClusterHealth::subscribe`; commands fan it out to a Tauri event
    /// in `connect_context`.
    pub(crate) health: Arc<ClusterHealth>,
    /// Set to `true` the moment the health probe declares the cluster
    /// `Unavailable` and the watcher/metrics teardown runs. Subsequent
    /// `subscribe_*` commands check this and short-circuit so the UI's
    /// re-subscription attempts don't silently re-spawn watchers against
    /// a dead client. Cleared by dropping the `ClusterEntry` (manual
    /// reconnect path).
    pub(crate) unavailable: AtomicBool,
    /// One-shot guard for connect-time probes (cluster.info background
    /// fetch + pod-list bench). The cluster can be cached either by an
    /// explicit `connect_context` call *or* lazily by `state.entry()` if
    /// some other command (e.g. the App's eager namespaces subscribe)
    /// arrives first — and `connect_context` may itself fire twice in
    /// dev (`StrictMode`) or under fast operator clicks. The probes should
    /// run exactly once per cluster lifetime regardless of who created
    /// the entry; CAS true on first call wins, everyone else skips.
    connect_probes_done: AtomicBool,
    /// One-shot guard for the health-forwarder spawn — kept separate
    /// from `connect_probes_done` because the forwarder needs to be
    /// wired up even on the lazy-connect path (App's eager namespaces
    /// subscribe runs before `connect_context`, and without this gate
    /// the forwarder would never be spawned for clusters first touched
    /// by `state.entry()` rather than `connect_context`). Same CAS
    /// pattern: true on first claim, false thereafter.
    health_wired: AtomicBool,
    /// JoinHandle for the health-event forwarder task spawned by
    /// `spawn_health_forwarder`. Stored here so `drop_cluster_watchers`
    /// / `tear_down_unhealthy` can abort it explicitly on teardown.
    ///
    /// Why this is load-bearing for memory: the forwarder's `rx.recv()`
    /// only returns `Err(Closed)` when the broadcast sender drops, but
    /// the sender lives inside `entry.health` which the forwarder used
    /// to keep alive via its captured `Arc<ClusterEntry>`. That's a
    /// self-sustaining cycle — after `drop_cluster_watchers` removed
    /// the entry from the state map, the forwarder still held the only
    /// strong ref, so the entry never dropped, the `Cluster` + kube
    /// `Client` HTTP/2 pool + `ClusterHealth` probe task all stayed
    /// resident. Operators saw RSS plateau at the high-water mark of
    /// the largest cluster ever opened. Aborting the forwarder breaks
    /// the cycle.
    ///
    /// Uses `std::sync::Mutex` (not tokio's): holds are a single
    /// `replace` / `take` per insert / teardown, so the sync mutex
    /// keeps the call sites a plain function (no `.await`) and avoids
    /// the spawn-a-task-to-insert race that an async mutex would force.
    pub(crate) health_forwarder: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// JoinHandle for the metrics-event forwarder spawned by
    /// `spawn_metrics_forwarder`. Same retention-cycle hazard as
    /// `health_forwarder`: the forwarder holds `Arc<MetricsService>`,
    /// the service holds the broadcast sender, and `unsubscribe_metrics
    /// .slot.service.take()` only drops one of the two strong refs —
    /// the forwarder's clone keeps the service alive (and its polling
    /// task running) until we abort explicitly.
    pub(crate) metrics_forwarder: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ClusterEntry {
    /// Atomically claim the right to run the connect-time probes for this
    /// cluster. Returns `true` exactly once per `ClusterEntry` lifetime
    /// (across any number of concurrent callers). Subsequent calls return
    /// `false` so they can no-op.
    pub(crate) fn claim_connect_probes(&self) -> bool {
        self.connect_probes_done
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Atomically claim the right to spawn the health-event forwarder for
    /// this cluster. Returns `true` exactly once per `ClusterEntry`
    /// lifetime; subsequent callers no-op. Separate from
    /// `claim_connect_probes` because the forwarder needs to fire on
    /// the lazy-connect path too (App's eager namespaces subscribe).
    pub(crate) fn claim_health_wiring(&self) -> bool {
        self.health_wired
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[derive(Default)]
pub(crate) struct MetricsSlot {
    pub(crate) service: Option<Arc<MetricsService>>,
    pub(crate) subscribers: usize,
}

/// Refcounted slot for a single (cluster, kind) reflector. Holding the watcher
/// in an `Option` lets us drop (and abort) it when the refcount hits zero
/// *and* the linger window has elapsed.
pub(crate) struct KindSlot {
    pub(crate) watcher: Option<Arc<ResourceWatcher>>,
    pub(crate) subscribers: usize,
    /// Pending shutdown task. Set when subscribers drops to 0 — sleeps for
    /// the linger window then re-checks subscribers and drops the watcher
    /// if it's still 0. A new subscribe aborts this handle so a quick
    /// kind→kind→kind back flip is instant (the watcher is already warm,
    /// snapshot fires immediately, no fresh LIST round trip).
    pub(crate) shutdown_handle: Option<tokio::task::JoinHandle<()>>,
}

impl KindSlot {
    pub(crate) fn empty() -> Self {
        Self {
            watcher: None,
            subscribers: 0,
            shutdown_handle: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct AppState {
    inner: Mutex<HashMap<ClusterId, Arc<ClusterEntry>>>,
    /// Active log streams keyed by app-assigned id. Dropping the Arc aborts the reader.
    logs: Mutex<HashMap<StreamId, Arc<LogStream>>>,
    /// Per-context fleet probes (cached on disk; loaded lazily).
    pub(crate) fleet: Arc<Mutex<FleetCache>>,
    /// User-managed kubeconfig sources + last-picked dir + default-disabled flag.
    pub(crate) sources: Arc<Mutex<SourcesFile>>,
    /// File-system watcher for kubeconfig changes; populated in `main()`'s setup.
    pub(crate) kubeconfig_watcher: Mutex<Option<Arc<KubeconfigWatcher>>>,
    /// In-flight `connect_context` attempts keyed by frontend-supplied id.
    /// `cancel_connect` removes + signals the corresponding sender so the
    /// running future drops mid-connect.
    pub(crate) connects: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// PTY-backed terminal sessions. Keyed by app-assigned session id.
    pub(crate) terminals: TerminalRegistry,
    /// Active port-forwards. Keyed by deterministic forward id; the broadcast
    /// channel fans status events out to the Tauri event forwarder.
    pub(crate) portforwards: PortForwardRegistry,
    /// Per-cluster SQLite-backed search indices. Opened on `connect_context`,
    /// dropped (file removed) on `drop_cluster_watchers`. Same `ClusterId`
    /// keys as the watcher map so lookups are 1:1.
    pub(crate) search_indices: Mutex<HashMap<ClusterId, Arc<SearchIndex>>>,
}

/// Live port-forward registry. Inserts dedupe by id (a duplicate `pf_start`
/// returns the existing entry instead of binding a second listener); removal
/// drops the `Arc<ForwardHandle>`, whose `Drop` aborts the listener task.
///
/// `pin_overrides` is the mutable side of pin state. The `ForwardSpec` baked
/// into a handle is immutable (it lives behind an Arc clone-shared with the
/// listener task), so toggling pin/unpin after start writes to this side map
/// instead of rebuilding the handle. `persist_forwards()` reads from here.
pub(crate) struct PortForwardRegistry {
    pub(crate) by_id: Mutex<HashMap<String, Arc<ForwardHandle>>>,
    pub(crate) pin_overrides: Mutex<HashMap<String, bool>>,
    pub(crate) status_tx: broadcast::Sender<(String, ForwardStatus)>,
}

impl Default for PortForwardRegistry {
    fn default() -> Self {
        Self {
            by_id: Mutex::new(HashMap::new()),
            pin_overrides: Mutex::new(HashMap::new()),
            status_tx: ferrisscope_kube_ext::new_status_channel(),
        }
    }
}

#[derive(Default)]
pub(crate) struct FleetCache {
    pub(crate) loaded: bool,
    pub(crate) map: HashMap<String, ClusterProbe>,
    /// Names with an in-flight probe — prevents N concurrent probes for the
    /// same context if the UI calls refresh repeatedly.
    pub(crate) in_flight: std::collections::HashSet<String>,
}

impl AppState {
    /// Get the entry for `id` (a composite `ContextInfo::id`), connecting if it
    /// isn't cached yet. Resolves the source's kubeconfig path (file/folder)
    /// or SSH config so connect loads from the right place.
    /// Non-creating lookup. Returns the cached entry if connected,
    /// `None` otherwise. Use this in teardown / unsubscribe paths so a
    /// concurrent `drop_cluster_watchers` can win the race without
    /// triggering a phantom reconnect — `state.entry()` reconnects on
    /// miss, which would re-instate a fresh `Cluster` + kube `Client`
    /// for a cluster the operator just left.
    pub(crate) async fn get_existing(&self, id: &str) -> Option<Arc<ClusterEntry>> {
        self.inner.lock().await.get(id).cloned()
    }

    pub(crate) async fn entry(&self, id: &str) -> Result<Arc<ClusterEntry>, String> {
        let mut map = self.inner.lock().await;
        if let Some(existing) = map.get(id) {
            return Ok(existing.clone());
        }
        let context_name = kubeconfig::context_name_from_id(id);
        let started = std::time::Instant::now();

        // SSH sources connect through a tunnel; everything else is a local
        // kubeconfig file. The SSH branch returns *before* falling through to
        // the file path so we don't try to read a non-existent local file.
        let ssh_lookup = {
            let s = self.sources.lock().await;
            kubeconfig::ssh_for(id, &s)
        };
        let cluster = if let Some((source_id, cfg)) = ssh_lookup {
            Cluster::connect_ssh(context_name, &cfg, &source_id)
                .await
                .map_err(|e| e.to_string())?
        } else {
            let source_path: Option<PathBuf> = {
                let s = self.sources.lock().await;
                kubeconfig::source_path_for(id, &s)
            };
            Cluster::connect(context_name, source_path.as_deref())
                .await
                .map_err(|e| e.to_string())?
        };

        tracing::info!(
            cluster_id = id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "AppState.entry: connected on demand"
        );
        let cluster = Arc::new(cluster);
        let health = ClusterHealth::start(cluster.client());
        let entry = Arc::new(ClusterEntry {
            cluster,
            kinds: Mutex::new(HashMap::new()),
            metrics: Mutex::new(MetricsSlot::default()),
            health,
            unavailable: AtomicBool::new(false),
            connect_probes_done: AtomicBool::new(false),
            health_wired: AtomicBool::new(false),
            health_forwarder: std::sync::Mutex::new(None),
            metrics_forwarder: std::sync::Mutex::new(None),
        });
        map.insert(id.to_owned(), entry.clone());
        Ok(entry)
    }

    /// Cache an already-connected cluster under `id`. Used by `connect_context`
    /// so the proof-of-life client is reused by the very next `subscribe_*`
    /// call instead of re-running `Cluster::connect` (which re-reads the
    /// kubeconfig from disk and, for exec-auth contexts, re-shells the auth
    /// plugin — visible latency before the first row appears).
    ///
    /// If an entry already exists for `id` (e.g. `state.entry(...)` lazily
    /// connected because the App's eager namespaces subscribe arrived
    /// before this command landed), the existing entry wins. Connect-time
    /// probes are deduplicated separately via
    /// `ClusterEntry::claim_connect_probes` — that's the source of truth
    /// for "have we run the bench / cluster.info for this cluster yet",
    /// not whether `insert_connected` was the one to create the entry.
    pub(crate) async fn insert_connected(
        &self,
        id: ClusterId,
        cluster: Cluster,
    ) -> Arc<ClusterEntry> {
        let mut map = self.inner.lock().await;
        if let Some(existing) = map.get(&id) {
            return existing.clone();
        }
        let cluster = Arc::new(cluster);
        let health = ClusterHealth::start(cluster.client());
        let entry = Arc::new(ClusterEntry {
            cluster,
            kinds: Mutex::new(HashMap::new()),
            metrics: Mutex::new(MetricsSlot::default()),
            health,
            unavailable: AtomicBool::new(false),
            connect_probes_done: AtomicBool::new(false),
            health_wired: AtomicBool::new(false),
            health_forwarder: std::sync::Mutex::new(None),
            metrics_forwarder: std::sync::Mutex::new(None),
        });
        map.insert(id, entry.clone());
        entry
    }

    pub(crate) async fn insert_log_stream(&self, id: StreamId, stream: Arc<LogStream>) {
        self.logs.lock().await.insert(id, stream);
    }

    pub(crate) async fn remove_log_stream(&self, id: &str) -> Option<Arc<LogStream>> {
        self.logs.lock().await.remove(id)
    }

    /// Drop the cached `ClusterEntry` for `id` if any. Called by
    /// `drop_cluster_watchers` after the entry's kinds have been torn down,
    /// so the connected `Cluster` (and its kube `Client` HTTP/2 pool) is
    /// fully released instead of lingering for the rest of the session.
    pub(crate) async fn remove_cluster(&self, id: &str) -> Option<Arc<ClusterEntry>> {
        self.inner.lock().await.remove(id)
    }

    /// Snapshot of currently-cached cluster entries — id + the Arc.
    /// Used by dev-memory introspection so the caller can poke each
    /// entry without holding the inner map lock for long.
    pub(crate) async fn entries_snapshot(&self) -> Vec<(ClusterId, Arc<ClusterEntry>)> {
        let map = self.inner.lock().await;
        map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub(crate) async fn log_stream_count(&self) -> usize {
        self.logs.lock().await.len()
    }

    pub(crate) async fn active_connect_count(&self) -> usize {
        self.connects.lock().await.len()
    }

    /// Register a freshly-opened search index for `id`. Called from
    /// `connect_context`. If an index was already registered (re-connect
    /// without an intervening drop), the old one is replaced and dropped
    /// here — its writer task exits when its sender is released.
    pub(crate) async fn insert_search_index(&self, id: ClusterId, index: Arc<SearchIndex>) {
        self.search_indices.lock().await.insert(id, index);
    }

    /// Remove and return the search index for `id` so the caller can drop
    /// it (closing the writer task) before deleting the on-disk file.
    pub(crate) async fn remove_search_index(&self, id: &str) -> Option<Arc<SearchIndex>> {
        self.search_indices.lock().await.remove(id)
    }

    /// Get a clone of the search-index handle for `id`. Returns `None` if
    /// the cluster isn't connected — callers (e.g. the forwarder writing
    /// deltas, the Tauri search command) must handle this gracefully.
    pub(crate) async fn search_index_for(&self, id: &str) -> Option<Arc<SearchIndex>> {
        self.search_indices.lock().await.get(id).cloned()
    }
}
