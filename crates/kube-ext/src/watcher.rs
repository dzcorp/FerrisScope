//! Generic kube watcher → snapshot + delta firehose.
//!
//! Erases the kube type behind `serde_json::Value` so a single command pair
//! (`subscribe_resource` / `unsubscribe_resource`) can serve every kind in
//! the registry. Only the projected `Value` row is retained; the typed
//! Kubernetes object is dropped immediately after projection so we don't
//! pay the full PodSpec/status/managedFields footprint × N pods × N kinds.
//!
//! Each row is always `{ "uid": "...", ... }` — the watcher injects `uid`
//! after [`KindSpec::project`] so spec implementations don't have to.
//!
//! The watcher → forwarder pipe is a **coalescing dirty channel**, not a
//! bounded broadcast. The previous design used `tokio::sync::broadcast`
//! with a 256-slot ring, which lost events under load — visible as "Pods
//! load stalls at ~2000 of 3000+" or "Custom resources show nothing until
//! the entire 6000-object list finishes" on big clusters. The cache
//! stayed correct (writes happened before the broadcast send), so
//! switching kind and back recovered the full snapshot, but real-time
//! updates were silently dropped. The new shape can't drop: writes
//! collapse by uid into a `HashMap` while the forwarder is busy emitting,
//! and the drainer always sees the latest state.

use ferrisscope_core::sync::LockExt;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ferrisscope_core::cluster::ListStrategy;
use futures::StreamExt;
use kube::runtime::watcher::InitialListStrategy;
use kube::{
    api::{Api, DynamicObject},
    core::ApiResource,
    runtime::{watcher, WatchStreamExt},
    Client, ResourceExt,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::registry::KindSpec;

/// Namespace scope for a single [`ResourceWatcher`]. The operator's
/// namespace selection in the UI is mapped onto one of these by the
/// `subscribe_resource` command:
///
/// | Selected set | Scope used                                           |
/// |--------------|------------------------------------------------------|
/// | empty (All)  | [`NsScope::All`] — `Api::all`                       |
/// | exactly one  | [`NsScope::One`] — `Api::namespaced(ns)`            |
/// | two or more  | [`NsScope::All`] + client-side filter on the table  |
/// | cluster kind | [`NsScope::All`] always — the registry enforces it  |
///
/// The slot in [`crate::registry`] is keyed by `(kind, scope)`, so each
/// scope gets its own watcher + linger cache. Flipping between `All` and
/// `One(ns)` within the 60 s linger window reuses warm watchers — no
/// fresh LIST round-trip.
#[derive(Debug, Clone, Eq, PartialEq, Hash)]
pub enum NsScope {
    All,
    One(String),
}

impl NsScope {
    /// `Some(ns)` for a single-namespace scope, `None` for cluster-wide.
    pub fn namespace(&self) -> Option<&str> {
        match self {
            Self::All => None,
            Self::One(ns) => Some(ns.as_str()),
        }
    }

    /// Map an operator namespace selection onto a scope. Callers handling
    /// cluster-scoped kinds should ignore this and use [`Self::All`].
    pub fn from_selection(selected: &[String]) -> Self {
        match selected {
            [] => Self::All,
            [one] => Self::One(one.clone()),
            // 2+ selected stays on All-watcher; the frontend filters
            // rows client-side against the set. See doc table above.
            _ => Self::All,
        }
    }

    /// Stable string used both as the slot key suffix and as the event
    /// name segment in `resource://{cluster}/{kind}/{scope}`. Colons and
    /// slashes are accepted by the Tauri sanitiser; namespace characters
    /// outside `[A-Za-z0-9_-]` are unusual and the caller pipes the full
    /// event name through `sanitize_event_segment` anyway.
    pub fn key(&self) -> String {
        match self {
            Self::All => "all".to_owned(),
            Self::One(ns) => format!("ns:{ns}"),
        }
    }
}

/// Coalescing channel between the watcher task and its single drain
/// consumer. Replaces the bounded `tokio::sync::broadcast` ring that
/// preceded it — see the module docs for the failure modes that caused.
///
/// Writes mutate per-uid state under a short-lived `std::sync::Mutex`
/// (microseconds; never held across `.await`) and ping a `Notify`.
/// While the drainer is busy emitting batch N to the webview, additional
/// writes keep collapsing into the same uid slots; the next drain takes
/// the coalesced result. Memory is bounded by the cluster's distinct-uid
/// count for the kind, not by raw event volume.
struct DirtyChannel {
    state: Mutex<DirtyState>,
    notify: Notify,
}

struct DirtyState {
    /// uid → latest projected row. An `Upsert` overwrites any prior value;
    /// a `Delete` removes the entry here and inserts the uid into `deleted`.
    changed: HashMap<String, Value>,
    /// uids that were deleted after their last upsert in this window. The
    /// drain emits these as `ResourceDelta::Delete`. Kept disjoint from
    /// `changed` so a Delete-then-Upsert sequence ends as a single Upsert
    /// (the watcher's reflector can re-emit a row after a 410 Gone resync).
    deleted: HashSet<String>,
    /// `true` once the watcher has emitted `Event::InitDone` since the last
    /// drain. Carried as a flag rather than a delta variant so it composes
    /// cleanly with the by-uid coalescing.
    init_done_pending: bool,
    /// Set by [`DirtyChannel::close`] when the watcher task is aborted on
    /// Drop. Lets [`DirtyChannel::wait_for_change`] return cleanly instead
    /// of blocking on Notify forever, so the forwarder task exits.
    closed: bool,
}

/// One drained snapshot from a [`DirtyChannel`]. Returned by
/// [`ResourceDrainer::drain`].
#[derive(Debug, Default)]
pub struct DrainedBatch {
    pub upserts: HashMap<String, Value>,
    pub deletes: HashSet<String>,
    pub init_done: bool,
}

impl DrainedBatch {
    pub fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.deletes.is_empty() && !self.init_done
    }

    /// Total number of `Upsert` + `Delete` entries this batch will emit.
    /// `init_done` is a single trailing marker and is not counted here.
    pub fn delta_count(&self) -> usize {
        self.upserts.len() + self.deletes.len()
    }
}

impl DirtyChannel {
    fn new() -> Self {
        Self {
            state: Mutex::new(DirtyState {
                changed: HashMap::new(),
                deleted: HashSet::new(),
                init_done_pending: false,
                closed: false,
            }),
            notify: Notify::new(),
        }
    }

    fn record_upsert(&self, uid: String, row: Value) {
        let mut s = self.state.lock_recover();
        if s.closed {
            return;
        }
        s.deleted.remove(&uid);
        s.changed.insert(uid, row);
        drop(s);
        self.notify.notify_one();
    }

    fn record_delete(&self, uid: String) {
        let mut s = self.state.lock_recover();
        if s.closed {
            return;
        }
        s.changed.remove(&uid);
        s.deleted.insert(uid);
        drop(s);
        self.notify.notify_one();
    }

    fn mark_init_done(&self) {
        let mut s = self.state.lock_recover();
        if s.closed {
            return;
        }
        s.init_done_pending = true;
        drop(s);
        self.notify.notify_one();
    }

    fn close(&self) {
        let mut s = self.state.lock_recover();
        s.closed = true;
        drop(s);
        // `notify_waiters` wakes every parked task at once. We only ever
        // have one drainer, but using waiters (rather than `notify_one`)
        // guarantees the drainer wakes even if no permit was stored.
        self.notify.notify_waiters();
    }

    /// Block until there is something to drain or the channel closes.
    /// Returns `true` if work is pending, `false` if closed-and-empty
    /// (the caller should exit its loop).
    async fn wait_for_change(&self) -> bool {
        loop {
            // Take the notified() future before re-checking state, so a
            // notification that fires between our state check and the
            // await is not lost.
            let notified = self.notify.notified();
            {
                let s = self.state.lock_recover();
                if !s.changed.is_empty() || !s.deleted.is_empty() || s.init_done_pending {
                    return true;
                }
                if s.closed {
                    return false;
                }
            }
            notified.await;
        }
    }

    fn drain(&self) -> DrainedBatch {
        let mut s = self.state.lock_recover();
        DrainedBatch {
            upserts: std::mem::take(&mut s.changed),
            deletes: std::mem::take(&mut s.deleted),
            init_done: std::mem::replace(&mut s.init_done_pending, false),
        }
    }

    /// Drain at most `max` `Upsert` + `Delete` deltas, leaving any remainder
    /// in the channel for a subsequent call. A `max` of 0 means "no cap"
    /// (equivalent to [`drain`](Self::drain)).
    ///
    /// `init_done` is only carried out when this call fully empties the
    /// backing maps — so a forwarder draining in chunks never emits
    /// "initial sync complete" before every initial row has been delivered.
    fn drain_capped(&self, max: usize) -> DrainedBatch {
        let mut s = self.state.lock_recover();
        // Fast path: the whole pending set fits (the steady-state norm — by-uid
        // coalescing keeps batches tiny). Take it all, `init_done` included.
        if max == 0 || s.changed.len() + s.deleted.len() <= max {
            return DrainedBatch {
                upserts: std::mem::take(&mut s.changed),
                deletes: std::mem::take(&mut s.deleted),
                init_done: std::mem::replace(&mut s.init_done_pending, false),
            };
        }
        // Capped path (init bursts only): take up to `max` deltas. Deletes go
        // first (cheap, usually few), then fill the remaining budget from
        // upserts. The maps are non-empty afterwards by construction (we only
        // get here when total > max), so `init_done` is held back.
        let mut budget = max;
        let mut deletes = HashSet::new();
        if !s.deleted.is_empty() {
            let take: Vec<String> = s.deleted.iter().take(budget).cloned().collect();
            for uid in take {
                s.deleted.remove(&uid);
                deletes.insert(uid);
            }
            budget -= deletes.len();
        }
        let mut upserts = HashMap::new();
        if budget > 0 {
            let take: Vec<String> = s.changed.keys().take(budget).cloned().collect();
            for uid in take {
                if let Some(v) = s.changed.remove(&uid) {
                    upserts.insert(uid, v);
                }
            }
        }
        DrainedBatch {
            upserts,
            deletes,
            init_done: false,
        }
    }
}

/// Drain side of a [`ResourceWatcher`]'s delta stream. Obtain via
/// [`ResourceWatcher::take_drainer`]. The channel is **single-consumer** —
/// two drainers against the same watcher will race on every `drain` call;
/// `take_drainer` panics if called twice on the same watcher to surface
/// that mistake early.
pub struct ResourceDrainer {
    chan: Arc<DirtyChannel>,
}

impl ResourceDrainer {
    /// Block until at least one upsert / delete / init_done is pending.
    /// Returns `false` once the watcher has been dropped and the channel
    /// is empty — the forwarder loop should `break` on `false`.
    pub async fn wait_for_change(&self) -> bool {
        self.chan.wait_for_change().await
    }

    /// Take everything currently pending. Cheap: a couple of `HashMap`
    /// `take`s under a short mutex. The watcher continues writing into
    /// fresh empty maps while the caller emits this batch.
    pub fn drain(&self) -> DrainedBatch {
        self.chan.drain()
    }

    /// Take at most `max` `Upsert` + `Delete` deltas, leaving the remainder
    /// for the next call (`max == 0` means "no cap"). Lets a forwarder bound
    /// the size of each emitted batch during the initial-sync burst — see
    /// [`DirtyChannel::drain_capped`]. `init_done` is withheld until the
    /// backing maps are fully drained.
    pub fn drain_capped(&self, max: usize) -> DrainedBatch {
        self.chan.drain_capped(max)
    }
}

/// Build a kube-rs watcher Config that matches the cluster's chosen
/// strategy. Streaming uses `InitialListStrategy::StreamingList` (one watch
/// stream, no paging — items arrive individually as the apiserver pushes
/// them). Paged uses kube-rs's default 500-item page size: on the hot path
/// (operator opens Pods on a typical cluster with ≤ a few hundred pods) the
/// whole list comes back in one round trip, matching `kubectl get pods -A`
/// wall-clock; kube-rs still drains the page through per-item `InitApply`
/// events so rows render progressively from the in-memory buffer. Smaller
/// page sizes were tried (50) but added 2-3 sequential round trips that
/// were visible to the operator on small clusters and didn't help large
/// ones (where streaming list, on 1.32+, is the right tool).
fn watcher_config(strategy: ListStrategy) -> watcher::Config {
    let mut cfg = watcher::Config::default();
    if strategy == ListStrategy::Streaming {
        cfg.initial_list_strategy = InitialListStrategy::StreamingList;
    }
    cfg
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResourceDelta {
    Upsert {
        row: Value,
    },
    Delete {
        uid: String,
    },
    /// Emitted once after the initial LIST / streaming-list sync completes.
    /// The frontend uses this to flip its loading state off — without it
    /// the spinner would have to be torn down based on row presence alone,
    /// which gives the wrong UX for genuinely-empty kinds (the operator
    /// briefly sees an "empty cluster" message while the watcher is still
    /// loading).
    #[serde(rename = "init_done")]
    InitDone,
}

/// A live reflector + coalescing dirty channel for a single
/// (cluster, kind). Use [`start::<S>`] from [`KindSpec`] to construct
/// one. Drop aborts the task and closes the channel so the forwarder
/// exits cleanly.
pub struct ResourceWatcher {
    snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync>,
    dirty: Arc<DirtyChannel>,
    /// Single-consumer guard for [`Self::take_drainer`]. Production code
    /// only ever takes one drainer (the forwarder spawned in
    /// `subscribe_resource`); the assert turns a silent multi-take into
    /// an immediate panic in tests.
    drainer_taken: AtomicBool,
    /// Set after kube-rs emits `Event::InitDone`. Read by `subscribe_resource`
    /// so a late subscriber (one that connects *after* init finished) still
    /// learns the watcher is past initial sync — the dirty channel doesn't
    /// replay history, so without this flag a late subscriber would see an
    /// unbounded-looking spinner.
    init_done: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl ResourceWatcher {
    /// Cross-namespace typed watcher. Used by [`crate::registry::ResourceKindEntry`]
    /// for the `NsScope::All` path and for every cluster-scoped kind
    /// (where the scope choice is meaningless). Namespaced kinds with
    /// `NsScope::One(ns)` go through [`Self::start_with_api`] so the
    /// caller can construct an `Api::namespaced` against a `S::K` that
    /// is statically known to be namespaced.
    pub fn start<S: KindSpec>(client: Client, strategy: ListStrategy) -> Self {
        Self::start_with_api::<S>(Api::all(client), strategy)
    }

    /// Typed watcher backed by a caller-built [`Api`]. Same machinery
    /// as [`Self::start`], parameterised over the API construction so a
    /// namespaced caller (whose `S::K` carries `NamespaceResourceScope`)
    /// can pass `Api::namespaced(client, ns)`.
    pub fn start_with_api<S: KindSpec>(api: Api<S::K>, strategy: ListStrategy) -> Self {
        let dirty = Arc::new(DirtyChannel::new());
        // Project on apply, store only the projected row. A typed reflector
        // store would keep full `Arc<S::K>` per object — on a 5000-pod
        // cluster that's 50–200 MB of typed Rust state we never read again
        // (the UI consumes the projected row, not the Pod struct).
        let cache: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));

        let cfg = watcher_config(strategy);
        let stream = watcher(api, cfg).default_backoff();

        let init_done = Arc::new(AtomicBool::new(false));
        let init_done_task = init_done.clone();
        let dirty_task = dirty.clone();
        let cache_task = cache.clone();
        let task = tokio::spawn(async move {
            // Per-task timing so the operator can pinpoint where Pods-load
            // latency lives. INFO markers: task start, first InitApply
            // (apiserver returned the first object), InitDone (initial
            // sync complete), stream ended. DEBUG: per-event Apply /
            // Delete and every-Nth page-drain progress (chatty kinds like
            // `events` would otherwise flood at INFO). Read with
            // `RUST_LOG=ferrisscope=info` (or `=debug` for the fine-
            // grained per-event lines).
            let started = std::time::Instant::now();
            tracing::info!(kind = S::meta().id, ?strategy, "watcher: task starting");
            tokio::pin!(stream);
            let mut applied = 0u64;
            let mut suppressed = 0u64;
            let mut first_apply_logged = false;
            // Uids observed during the current Init→InitDone window. Allocated
            // when Init fires, drained on InitDone to reconcile the cache:
            // anything present locally but absent from the new LIST is a
            // delete-while-disconnected (sleep/wake, 410 Gone resync). kube-rs
            // never replays Delete for missing items — it just LISTs current
            // state — so without this we'd carry ghost rows until the next
            // teardown.
            let mut init_seen: Option<HashSet<String>> = None;
            while let Some(event) = stream.next().await {
                let (obj, is_init_apply) = match event {
                    Ok(watcher::Event::Apply(o)) => (o, false),
                    Ok(watcher::Event::InitApply(o)) => (o, true),
                    Ok(watcher::Event::Delete(obj)) => {
                        if let Some(uid) = obj.uid() {
                            tracing::debug!(
                                kind = S::meta().id,
                                uid = %uid,
                                "watcher: delete"
                            );
                            cache_task.lock_recover().remove(&uid);
                            dirty_task.record_delete(uid);
                        }
                        continue;
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = S::meta().id, "watcher: init");
                        init_seen = Some(HashSet::new());
                        continue;
                    }
                    Ok(watcher::Event::InitDone) => {
                        init_done_task.store(true, Ordering::SeqCst);
                        let reconciled =
                            reconcile_init_seen(&mut init_seen, &cache_task, &dirty_task);
                        tracing::info!(
                            kind = S::meta().id,
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            suppressed,
                            reconciled_deletes = reconciled,
                            "watcher: init done (initial sync complete)"
                        );
                        dirty_task.mark_init_done();
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, kind = S::meta().id, "watcher: stream error");
                        continue;
                    }
                };
                let Some(uid) = obj.uid() else { continue };
                if is_init_apply {
                    if let Some(seen) = init_seen.as_mut() {
                        seen.insert(uid.clone());
                    }
                }
                let row = with_uid(uid.clone(), S::project(&obj));
                let row = with_labels(row, Some(obj.labels()));
                // Drop the typed object as soon as projection is done.
                drop(obj);
                // No-op suppression: if the projected row is byte-
                // identical to the last one we cached for this uid,
                // skip the broadcast. Catches kube-rs resync after a
                // 410 Gone (re-emits every object as InitApply, most
                // unchanged) and the steady-state churn from server-
                // side fields the projection deliberately drops
                // (managedFields, resourceVersion, lastTransitionTime
                // bumps that don't move any column). One Value::eq
                // walk is orders of magnitude cheaper than the IPC
                // emit + JSON-decode + React reconciliation we'd
                // otherwise pay downstream.
                let mut cache = cache_task.lock_recover();
                let unchanged = cache.get(&uid).is_some_and(|prev| prev == &row);
                if unchanged {
                    suppressed += 1;
                } else {
                    cache.insert(uid.clone(), row.clone());
                    drop(cache);
                    dirty_task.record_upsert(uid, row);
                }
                applied += 1;
                if !first_apply_logged {
                    first_apply_logged = true;
                    tracing::info!(
                        kind = S::meta().id,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "watcher: first apply (apiserver returned first object)"
                    );
                } else if applied.is_multiple_of(50) {
                    tracing::debug!(
                        kind = S::meta().id,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        applied,
                        suppressed,
                        "watcher: apply progress"
                    );
                }
            }
            tracing::info!(
                kind = S::meta().id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                applied,
                suppressed,
                "watcher: stream ended"
            );
        });

        let snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync> =
            Box::new(move || cache.lock_recover().values().cloned().collect());

        Self {
            snapshot_fn,
            dirty,
            drainer_taken: AtomicBool::new(false),
            init_done,
            task,
        }
    }

    /// Dynamic-API watcher for arbitrary GVKs (CRDs whose typed structs we
    /// don't have at compile time). Uses a hand-rolled `HashMap<uid, row>` as
    /// the snapshot store — same shape as the typed `start::<S>` path now
    /// (both paths cache only the projected row).
    ///
    /// `project` flattens a `DynamicObject` into the row shape (must match
    /// the kind's registered columns).
    pub fn start_dynamic(
        client: Client,
        ar: ApiResource,
        _namespaced: bool,
        log_id: String,
        project: Arc<dyn Fn(&DynamicObject) -> Value + Send + Sync>,
        scope: NsScope,
        strategy: ListStrategy,
    ) -> Self {
        let dirty = Arc::new(DirtyChannel::new());
        // `Api::all_with` for cluster-wide watches; `namespaced_with` for a
        // single-namespace CRD scope. Cluster-scoped CRDs always land on
        // `All` because the registry's `from_dynamic_crd` / `from_well_known`
        // coerce the scope before invoking us.
        let api: Api<DynamicObject> = match scope.namespace() {
            Some(ns) => Api::namespaced_with(client, ns, &ar),
            None => Api::all_with(client, &ar),
        };
        let cache: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));

        let cfg = watcher_config(strategy);
        let stream = watcher(api, cfg).default_backoff();

        let init_done = Arc::new(AtomicBool::new(false));
        let init_done_task = init_done.clone();
        let dirty_task = dirty.clone();
        let cache_task = cache.clone();
        let project_task = project.clone();
        let log_id_task = log_id.clone();
        let task = tokio::spawn(async move {
            let started = std::time::Instant::now();
            tracing::info!(
                kind = %log_id_task,
                ?strategy,
                "dynamic watcher: task starting"
            );
            tokio::pin!(stream);
            let mut applied = 0u64;
            let mut suppressed = 0u64;
            let mut skipped_no_uid = 0u64;
            let mut first_apply_logged = false;
            // See `start_with_api` for the rationale — same reconcile
            // applies to CRD watches.
            let mut init_seen: Option<HashSet<String>> = None;
            while let Some(event) = stream.next().await {
                let (obj, is_init_apply) = match event {
                    Ok(watcher::Event::Apply(o)) => (o, false),
                    Ok(watcher::Event::InitApply(o)) => (o, true),
                    Ok(watcher::Event::Delete(obj)) => {
                        if let Some(uid) = obj.uid() {
                            cache_task.lock_recover().remove(&uid);
                            dirty_task.record_delete(uid);
                        }
                        continue;
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = %log_id_task, "dynamic watcher: init");
                        init_seen = Some(HashSet::new());
                        continue;
                    }
                    Ok(watcher::Event::InitDone) => {
                        let reconciled =
                            reconcile_init_seen(&mut init_seen, &cache_task, &dirty_task);
                        tracing::info!(
                            kind = %log_id_task,
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            suppressed,
                            skipped_no_uid,
                            reconciled_deletes = reconciled,
                            "dynamic watcher: init done"
                        );
                        init_done_task.store(true, Ordering::SeqCst);
                        dirty_task.mark_init_done();
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            kind = %log_id_task,
                            "dynamic watcher: stream error"
                        );
                        continue;
                    }
                };
                let Some(uid) = obj.uid() else {
                    skipped_no_uid += 1;
                    continue;
                };
                if is_init_apply {
                    if let Some(seen) = init_seen.as_mut() {
                        seen.insert(uid.clone());
                    }
                }
                let row = with_uid(uid.clone(), project_task(&obj));
                let row = with_labels(row, Some(obj.labels()));
                // No-op suppression — see typed-watcher branch above
                // for the rationale. Same behaviour: cheap structural
                // equality on the projected row; on miss, update the
                // cache and broadcast; on hit, drop silently.
                let mut cache = cache_task.lock_recover();
                let unchanged = cache.get(&uid).is_some_and(|prev| prev == &row);
                if unchanged {
                    suppressed += 1;
                } else {
                    cache.insert(uid.clone(), row.clone());
                    drop(cache);
                    dirty_task.record_upsert(uid, row);
                }
                applied += 1;
                if !first_apply_logged {
                    first_apply_logged = true;
                    tracing::info!(
                        kind = %log_id_task,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "dynamic watcher: first apply"
                    );
                } else if applied.is_multiple_of(50) {
                    tracing::debug!(
                        kind = %log_id_task,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        applied,
                        suppressed,
                        "dynamic watcher: apply progress"
                    );
                }
            }
            tracing::info!(
                kind = %log_id_task,
                elapsed_ms = started.elapsed().as_millis() as u64,
                applied,
                suppressed,
                "dynamic watcher: stream ended"
            );
        });

        let cache_snap = cache.clone();
        let snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync> = Box::new(move || {
            // std::sync::Mutex held only across tiny insert/remove/clone
            // critical sections — blocking briefly here is fine and avoids
            // the lossy try_lock path the previous version used (which
            // returned empty whenever the watcher task happened to hold
            // the lock).
            cache_snap.lock_recover().values().cloned().collect()
        });

        Self {
            snapshot_fn,
            dirty,
            drainer_taken: AtomicBool::new(false),
            init_done,
            task,
        }
    }

    /// Helm releases — synthetic kind backed by Secrets of type
    /// `helm.sh/release.v1`. We watch Secrets with a `type=` field selector,
    /// decode each release secret (base64 + gzip + JSON), and aggregate by
    /// `(namespace, release-name)` keeping only the **highest revision** as
    /// the live row. Previous revisions stay in the per-release map so a
    /// delete of the latest revision can demote to the next-highest one
    /// without dropping the release from the table.
    ///
    /// Why a bespoke constructor instead of a `KindSpec`: `KindSpec` is a
    /// 1:1 typed resource ↔ row mapping. Helm releases violate both halves
    /// — multiple secrets per logical row, and the row content lives inside
    /// the secret's `data.release` blob. Forcing this through `KindSpec`
    /// would require leaking an aggregator into the trait.
    pub fn start_helm_releases(client: Client, scope: NsScope, strategy: ListStrategy) -> Self {
        use crate::kinds::helm_releases::{
            decode_release, project_row, synthetic_uid, Release, HELM_SECRET_TYPE,
        };
        use k8s_openapi::api::core::v1::Secret;
        use kube::ResourceExt;
        use std::collections::BTreeMap;

        let dirty = Arc::new(DirtyChannel::new());
        // Helm release secrets are namespaced — scoping to `One(ns)`
        // gives the operator only releases deployed there.
        let api: Api<Secret> = match scope.namespace() {
            Some(ns) => Api::namespaced(client, ns),
            None => Api::all(client),
        };

        // Per-release state keyed by `(namespace, name)`. Each entry holds
        // every revision we've seen, keyed by the underlying secret uid so
        // delete events can target a specific revision. The "live" revision
        // is the entry with the highest `version`.
        type Releases = BTreeMap<(String, String), BTreeMap<String, Release>>;
        let store: Arc<Mutex<Releases>> = Arc::new(Mutex::new(BTreeMap::new()));

        let mut cfg = watcher_config(strategy);
        cfg.field_selector = Some(format!("type={HELM_SECRET_TYPE}"));
        let stream = watcher(api, cfg).default_backoff();

        let init_done = Arc::new(AtomicBool::new(false));
        let init_done_task = init_done.clone();
        let dirty_task = dirty.clone();
        let store_task = store.clone();

        let task = tokio::spawn(async move {
            let started = std::time::Instant::now();
            tracing::info!(kind = "helm_releases", ?strategy, "helm watcher: starting");
            tokio::pin!(stream);
            let mut applied = 0u64;
            let mut decode_errors = 0u64;
            let mut first_apply_logged = false;
            // Secret uids replayed during the current Init→InitDone window.
            // On InitDone we diff against the per-release secret_uids maps
            // and prune anything missing — same sleep/wake reconcile as the
            // typed/dynamic watchers, but the aggregator shape (one row per
            // logical release, multiple secrets per row) means we have to
            // walk the store inline instead of using `reconcile_init_seen`.
            let mut init_seen: Option<HashSet<String>> = None;
            while let Some(event) = stream.next().await {
                let (obj, is_init_apply) = match event {
                    Ok(watcher::Event::Apply(o)) => (o, false),
                    Ok(watcher::Event::InitApply(o)) => (o, true),
                    Ok(watcher::Event::Delete(obj)) => {
                        let Some(secret_uid) = obj.uid() else {
                            continue;
                        };
                        let mut g = store_task.lock_recover();
                        // We don't have the parsed Release here (the Delete
                        // event only carries metadata) — locate which (ns,
                        // name) holds this secret uid by scanning. Helm
                        // release counts per cluster are small (hundreds at
                        // most) so this is fine.
                        let mut found_key: Option<(String, String)> = None;
                        for (k, revs) in g.iter() {
                            if revs.contains_key(&secret_uid) {
                                found_key = Some(k.clone());
                                break;
                            }
                        }
                        let Some(key) = found_key else { continue };
                        let revs = g.get_mut(&key).expect("key checked above");
                        revs.remove(&secret_uid);
                        if revs.is_empty() {
                            g.remove(&key);
                            dirty_task.record_delete(synthetic_uid(&key.0, &key.1));
                        } else if let Some(latest) = revs.values().max_by_key(|r| r.version) {
                            // A non-latest revision was removed, or latest
                            // was removed and we now demote: re-emit so the
                            // table reflects the new live revision.
                            let uid = synthetic_uid(&key.0, &key.1);
                            let row = with_uid(uid.clone(), project_row(latest));
                            dirty_task.record_upsert(uid, row);
                        }
                        continue;
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = "helm_releases", "helm watcher: init");
                        init_seen = Some(HashSet::new());
                        continue;
                    }
                    Ok(watcher::Event::InitDone) => {
                        init_done_task.store(true, Ordering::SeqCst);
                        let reconciled = if let Some(seen) = init_seen.take() {
                            let mut g = store_task.lock_recover();
                            // Snapshot (key, missing_secret_uid) pairs while
                            // holding the lock; can't mutate `g` while a
                            // borrow into it is alive.
                            let stale: Vec<((String, String), String)> = g
                                .iter()
                                .flat_map(|(key, revs)| {
                                    revs.keys()
                                        .filter(|u| !seen.contains(u.as_str()))
                                        .map(|u| (key.clone(), u.clone()))
                                        .collect::<Vec<_>>()
                                })
                                .collect();
                            for (key, secret_uid) in &stale {
                                let Some(revs) = g.get_mut(key) else {
                                    continue;
                                };
                                revs.remove(secret_uid);
                                if revs.is_empty() {
                                    g.remove(key);
                                    dirty_task.record_delete(synthetic_uid(&key.0, &key.1));
                                } else if let Some(latest) = revs.values().max_by_key(|r| r.version)
                                {
                                    let uid = synthetic_uid(&key.0, &key.1);
                                    let row = with_uid(uid.clone(), project_row(latest));
                                    dirty_task.record_upsert(uid, row);
                                }
                            }
                            stale.len()
                        } else {
                            0
                        };
                        tracing::info!(
                            kind = "helm_releases",
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            decode_errors,
                            reconciled_secret_uids = reconciled,
                            "helm watcher: init done"
                        );
                        dirty_task.mark_init_done();
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, kind = "helm_releases", "helm watcher: stream error");
                        continue;
                    }
                };
                let Some(secret_uid) = obj.uid() else {
                    continue;
                };
                if is_init_apply {
                    if let Some(seen) = init_seen.as_mut() {
                        seen.insert(secret_uid.clone());
                    }
                }
                let release = match decode_release(&obj) {
                    Ok(r) => r,
                    Err(e) => {
                        decode_errors += 1;
                        tracing::debug!(
                            error = %e,
                            secret = %obj.name_any(),
                            namespace = ?obj.namespace(),
                            "helm watcher: decode failed"
                        );
                        continue;
                    }
                };
                let ns = release.namespace.clone().unwrap_or_default();
                let name = release.name.clone();
                let key = (ns.clone(), name.clone());
                let mut g = store_task.lock_recover();
                let entry = g.entry(key.clone()).or_default();
                entry.insert(secret_uid, release);
                if let Some(latest) = entry.values().max_by_key(|r| r.version) {
                    let uid = synthetic_uid(&ns, &name);
                    let row = with_uid(uid.clone(), project_row(latest));
                    dirty_task.record_upsert(uid, row);
                }
                applied += 1;
                if !first_apply_logged {
                    first_apply_logged = true;
                    tracing::info!(
                        kind = "helm_releases",
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "helm watcher: first apply"
                    );
                }
            }
            tracing::info!(
                kind = "helm_releases",
                elapsed_ms = started.elapsed().as_millis() as u64,
                applied,
                decode_errors,
                "helm watcher: stream ended"
            );
        });

        let store_snap = store.clone();
        let snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync> = Box::new(move || {
            let g = store_snap.lock_recover();
            g.iter()
                .filter_map(|((ns, name), revs)| {
                    let latest = revs.values().max_by_key(|r| r.version)?;
                    Some(with_uid(synthetic_uid(ns, name), project_row(latest)))
                })
                .collect()
        });

        Self {
            snapshot_fn,
            dirty,
            drainer_taken: AtomicBool::new(false),
            init_done,
            task,
        }
    }

    /// Helm charts — synthetic kind derived from the same Helm release
    /// secrets the [`Self::start_helm_releases`] watcher consumes, but
    /// deduplicated by `(chart_name, chart_version)`. One chart row per
    /// unique pair; `used_by` reflects the number of releases currently
    /// referencing that chart in the cluster.
    ///
    /// We run a second watch with the same field selector rather than
    /// derive from the existing helm_releases watcher because the watcher
    /// API doesn't expose a "subscribe to another kind's reflector" path
    /// without significant refactoring. The duplicate watch is cheap on
    /// the apiserver — Helm release secrets number in the hundreds even
    /// on busy clusters — and the lazy unsubscribe path means it only
    /// runs while the operator has the chart catalog open.
    pub fn start_helm_charts(client: Client, scope: NsScope, strategy: ListStrategy) -> Self {
        use crate::fetch::{helm_search_repo, HelmRepoChart, HELM_CLUSTER_SOURCE};
        use crate::kinds::helm_charts::{project_cluster_row, project_repo_row, synthetic_uid};
        use crate::kinds::helm_releases::{decode_release, Release, HELM_SECRET_TYPE};
        use k8s_openapi::api::core::v1::Secret;
        use kube::ResourceExt;
        use std::collections::{BTreeMap, HashMap, HashSet};

        let dirty = Arc::new(DirtyChannel::new());
        // Underlying secrets are namespaced; a `One(ns)` chart view shows
        // only charts deployed there. Repo-side entries (loaded via
        // `helm search repo` below) are independent of the cluster scope.
        let api: Api<Secret> = match scope.namespace() {
            Some(ns) => Api::namespaced(client, ns),
            None => Api::all(client),
        };

        // Three stores:
        //   `cluster_charts`: (name, version) → { sample release, set of
        //              contributing release-secret uids }. Drives the
        //              in-cluster source rows; deltas come from Apply /
        //              Delete on helm release secrets.
        //   `repo_charts`: (repo, name, version) → HelmRepoChart, loaded
        //              once on subscribe via `helm search repo`.
        //   `secret_to_chart`: helper for cluster_charts to demote on
        //              Delete events without scanning.
        type ClusterKey = (String, String);
        type RepoKey = (String, String, String);
        struct ChartEntry {
            sample: Release,
            secret_uids: HashSet<String>,
        }
        let cluster_charts: Arc<Mutex<BTreeMap<ClusterKey, ChartEntry>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let repo_charts: Arc<Mutex<BTreeMap<RepoKey, HelmRepoChart>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let secret_to_chart: Arc<Mutex<HashMap<String, ClusterKey>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let mut cfg = watcher_config(strategy);
        cfg.field_selector = Some(format!("type={HELM_SECRET_TYPE}"));
        let stream = watcher(api, cfg).default_backoff();

        let init_done = Arc::new(AtomicBool::new(false));
        let init_done_task = init_done.clone();
        let dirty_task = dirty.clone();
        let cluster_charts_task = cluster_charts.clone();
        let repo_charts_task = repo_charts.clone();
        let secret_map_task = secret_to_chart.clone();

        let task = tokio::spawn(async move {
            let started = std::time::Instant::now();
            tracing::info!(
                kind = "helm_charts",
                ?strategy,
                "helm-chart watcher: starting"
            );

            // Repo charts load in parallel with the secret watch's first
            // page. They're cheap (helm reads its own cache) and
            // bounded; emit each as Upsert with source=<repo>. We don't
            // gate InitDone on this — it can complete after.
            {
                let dirty = dirty_task.clone();
                let store = repo_charts_task.clone();
                tokio::spawn(async move {
                    let entries = helm_search_repo().await;
                    let mut g = store.lock_recover();
                    for rc in &entries {
                        let key: RepoKey = (rc.repo.clone(), rc.name.clone(), rc.version.clone());
                        g.insert(key.clone(), rc.clone());
                        let uid = synthetic_uid(&rc.repo, &rc.name, &rc.version);
                        let row = with_uid(uid.clone(), project_repo_row(rc));
                        dirty.record_upsert(uid, row);
                    }
                    tracing::info!(
                        kind = "helm_charts",
                        repo_charts = entries.len(),
                        "helm-chart watcher: repo entries loaded"
                    );
                });
            }

            tokio::pin!(stream);
            let mut applied = 0u64;
            let mut decode_errors = 0u64;
            // Secret uids replayed during the current Init→InitDone window.
            // On InitDone we drop secret_to_chart entries for missing uids
            // and demote the affected ChartEntry — same sleep/wake reconcile
            // as the typed/dynamic watchers; the secret→chart reverse map
            // means we don't have to scan cluster_charts here.
            let mut init_seen: Option<HashSet<String>> = None;
            while let Some(event) = stream.next().await {
                let (obj, is_init_apply) = match event {
                    Ok(watcher::Event::Apply(o)) => (o, false),
                    Ok(watcher::Event::InitApply(o)) => (o, true),
                    Ok(watcher::Event::Delete(obj)) => {
                        let Some(secret_uid) = obj.uid() else {
                            continue;
                        };
                        let key = secret_map_task.lock_recover().remove(&secret_uid);
                        if let Some(k) = key {
                            demote_cluster_chart(
                                &cluster_charts_task,
                                &k,
                                &secret_uid,
                                &dirty_task,
                            );
                        }
                        continue;
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = "helm_charts", "helm-chart watcher: init");
                        init_seen = Some(HashSet::new());
                        continue;
                    }
                    Ok(watcher::Event::InitDone) => {
                        init_done_task.store(true, Ordering::SeqCst);
                        let reconciled = if let Some(seen) = init_seen.take() {
                            // Snapshot (secret_uid, key) for any tracked
                            // secret missing from the new LIST, drop from
                            // the reverse map, then demote each owning
                            // chart entry (which may delete the row or
                            // re-emit with a lower used_by count).
                            let stale: Vec<(String, ClusterKey)> = secret_map_task
                                .lock_recover()
                                .iter()
                                .filter(|(u, _)| !seen.contains(u.as_str()))
                                .map(|(u, k)| (u.clone(), k.clone()))
                                .collect();
                            for (secret_uid, key) in &stale {
                                secret_map_task.lock_recover().remove(secret_uid);
                                demote_cluster_chart(
                                    &cluster_charts_task,
                                    key,
                                    secret_uid,
                                    &dirty_task,
                                );
                            }
                            stale.len()
                        } else {
                            0
                        };
                        tracing::info!(
                            kind = "helm_charts",
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            decode_errors,
                            reconciled_secret_uids = reconciled,
                            "helm-chart watcher: init done"
                        );
                        dirty_task.mark_init_done();
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            kind = "helm_charts",
                            "helm-chart watcher: stream error"
                        );
                        continue;
                    }
                };
                let Some(secret_uid) = obj.uid() else {
                    continue;
                };
                if is_init_apply {
                    if let Some(seen) = init_seen.as_mut() {
                        seen.insert(secret_uid.clone());
                    }
                }
                let release = match decode_release(&obj) {
                    Ok(r) => r,
                    Err(e) => {
                        decode_errors += 1;
                        tracing::debug!(
                            error = %e,
                            "helm-chart watcher: decode failed"
                        );
                        continue;
                    }
                };
                let Some(name) = release.chart_meta_str("name") else {
                    continue;
                };
                let Some(version) = release.chart_meta_str("version") else {
                    continue;
                };
                let new_key: ClusterKey = (name.clone(), version.clone());

                // Demote a prior chart-key for this same secret
                // uid (rare in-place version change) before
                // promoting into the new key.
                let prior_key = secret_map_task.lock_recover().get(&secret_uid).cloned();
                if let Some(old_key) = prior_key {
                    if old_key != new_key {
                        demote_cluster_chart(
                            &cluster_charts_task,
                            &old_key,
                            &secret_uid,
                            &dirty_task,
                        );
                    }
                }

                {
                    let mut g = cluster_charts_task.lock_recover();
                    let entry = g.entry(new_key.clone()).or_insert_with(|| ChartEntry {
                        sample: release.clone(),
                        secret_uids: HashSet::new(),
                    });
                    entry.secret_uids.insert(secret_uid.clone());
                    let uid = synthetic_uid(HELM_CLUSTER_SOURCE, &name, &version);
                    let row = with_uid(
                        uid.clone(),
                        project_cluster_row(&entry.sample, entry.secret_uids.len()),
                    );
                    dirty_task.record_upsert(uid, row);
                }
                secret_map_task.lock_recover().insert(secret_uid, new_key);

                applied += 1;
            }
        });

        // Snapshot for late subscribers — covers both sources.
        let cluster_snap = cluster_charts.clone();
        let repo_snap = repo_charts.clone();
        let snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync> = Box::new(move || {
            use crate::fetch::HELM_CLUSTER_SOURCE;
            let mut out = Vec::new();
            {
                let g = cluster_snap.lock_recover();
                for ((name, version), entry) in g.iter() {
                    out.push(with_uid(
                        synthetic_uid(HELM_CLUSTER_SOURCE, name, version),
                        project_cluster_row(&entry.sample, entry.secret_uids.len()),
                    ));
                }
            }
            {
                let g = repo_snap.lock_recover();
                for ((repo, name, version), rc) in g.iter() {
                    out.push(with_uid(
                        synthetic_uid(repo, name, version),
                        project_repo_row(rc),
                    ));
                }
            }
            out
        });

        return Self {
            snapshot_fn,
            dirty,
            drainer_taken: AtomicBool::new(false),
            init_done,
            task,
        };

        // Local helper: drop a secret_uid from a cluster chart entry; if
        // the entry empties, remove it and emit Delete; otherwise emit a
        // refreshed Upsert with the new used_by count.
        fn demote_cluster_chart(
            charts: &Arc<Mutex<BTreeMap<(String, String), ChartEntry>>>,
            key: &(String, String),
            secret_uid: &str,
            dirty: &DirtyChannel,
        ) {
            use crate::fetch::HELM_CLUSTER_SOURCE;
            let mut g = charts.lock_recover();
            let Some(entry) = g.get_mut(key) else { return };
            entry.secret_uids.remove(secret_uid);
            if entry.secret_uids.is_empty() {
                g.remove(key);
                dirty.record_delete(synthetic_uid(HELM_CLUSTER_SOURCE, &key.0, &key.1));
            } else {
                let uid = synthetic_uid(HELM_CLUSTER_SOURCE, &key.0, &key.1);
                let row = with_uid(
                    uid.clone(),
                    project_cluster_row(&entry.sample, entry.secret_uids.len()),
                );
                dirty.record_upsert(uid, row);
            }
        }
    }

    pub fn snapshot(&self) -> Vec<Value> {
        (self.snapshot_fn)()
    }

    /// `true` once the watcher has finished its initial sync (kube-rs
    /// `Event::InitDone`). Used by `subscribe_resource` to signal the
    /// frontend that the spinner can come down even if the snapshot was
    /// empty (kind has no instances).
    pub fn init_done(&self) -> bool {
        self.init_done.load(Ordering::SeqCst)
    }

    /// Take the single drain consumer for this watcher. Panics if
    /// called twice on the same `ResourceWatcher` — the dirty channel
    /// is single-consumer by design (the prior multi-subscriber
    /// `broadcast` shape was the source of the lost-event bug). Each
    /// `Arc<ResourceWatcher>` clone shares one drainer slot; only
    /// `spawn_resource_forwarder` should call this in production.
    pub fn take_drainer(&self) -> ResourceDrainer {
        assert!(
            !self.drainer_taken.swap(true, Ordering::SeqCst),
            "ResourceWatcher::take_drainer called twice; channel is single-consumer"
        );
        ResourceDrainer {
            chan: self.dirty.clone(),
        }
    }
}

impl Drop for ResourceWatcher {
    fn drop(&mut self) {
        self.task.abort();
        // Wake any drainer parked on `wait_for_change` so the forwarder
        // exits cleanly. Without this, `drop(watcher)` aborts the
        // producer but leaves the forwarder blocked on Notify forever
        // — small leak per cluster-switch, but accumulating.
        self.dirty.close();
    }
}

/// Diff the watcher cache against the uids replayed during an
/// `Event::Init` → `Event::InitDone` window and emit a synthetic
/// `Delete` for any uid present in the cache but absent from the
/// replayed set. This is how we catch deletes that happened while
/// the watcher was disconnected (sleep/wake, 410 Gone resync) —
/// kube-rs only emits `Event::Delete` when the apiserver streams
/// the deletion live; a resync is a plain LIST and never tells us
/// "this item is gone." Returns the number of reconciled deletions.
///
/// Used by the typed and dynamic watchers (same `Mutex<HashMap<uid, row>>`
/// cache shape). The helm aggregators carry a richer per-release /
/// per-chart store and reconcile inline.
fn reconcile_init_seen(
    init_seen: &mut Option<HashSet<String>>,
    cache: &Mutex<HashMap<String, Value>>,
    dirty: &DirtyChannel,
) -> usize {
    let Some(seen) = init_seen.take() else {
        return 0;
    };
    let mut cache = cache.lock_recover();
    let stale: Vec<String> = cache
        .keys()
        .filter(|uid| !seen.contains(uid.as_str()))
        .cloned()
        .collect();
    for uid in &stale {
        cache.remove(uid);
    }
    drop(cache);
    let n = stale.len();
    for uid in stale {
        dirty.record_delete(uid);
    }
    n
}

/// Inject `uid` into a projected row. If the projection produced something
/// that isn't a JSON object, wrap it under a `value` key so we never lose data.
fn with_uid(uid: String, projected: Value) -> Value {
    match projected {
        Value::Object(mut map) => {
            map.insert("uid".to_owned(), Value::String(uid));
            Value::Object(map)
        }
        other => serde_json::json!({ "uid": uid, "value": other }),
    }
}

/// Inject the object's labels into a projected row under the reserved
/// `__labels` key. The frontend filter box uses it for label-selector
/// matching (`app=nginx`, `tier=prod,app=web`). Attached only when there
/// is at least one label, so the per-update bus payload stays minimal —
/// label-less objects add nothing. The `__` prefix marks it as synthetic
/// row metadata (cf. `__sid` / `__clusterId` on the frontend), never a
/// table column. No-op when the projection isn't a JSON object.
fn with_labels(row: Value, labels: Option<&BTreeMap<String, String>>) -> Value {
    let Some(labels) = labels.filter(|m| !m.is_empty()) else {
        return row;
    };
    let Value::Object(mut map) = row else {
        return row;
    };
    let projected: serde_json::Map<String, Value> = labels
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    map.insert("__labels".to_owned(), Value::Object(projected));
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn row(name: &str) -> Value {
        json!({ "uid": "ignored", "name": name })
    }

    #[test]
    fn with_labels_attaches_only_when_present() {
        let base = with_uid("u1".to_owned(), json!({ "name": "nginx" }));

        // None / empty → no `__labels`, original fields untouched.
        let none = with_labels(base.clone(), None);
        assert_eq!(none["uid"], json!("u1"));
        assert_eq!(none["name"], json!("nginx"));
        assert!(none.get("__labels").is_none());

        let empty = with_labels(base.clone(), Some(&BTreeMap::new()));
        assert!(empty.get("__labels").is_none());

        // Non-empty → mirrored under `__labels`, siblings preserved.
        let labels: BTreeMap<String, String> = [
            ("app".to_owned(), "nginx".to_owned()),
            ("tier".to_owned(), "frontend".to_owned()),
        ]
        .into_iter()
        .collect();
        let tagged = with_labels(base, Some(&labels));
        assert_eq!(tagged["uid"], json!("u1"));
        assert_eq!(tagged["name"], json!("nginx"));
        assert_eq!(tagged["__labels"]["app"], json!("nginx"));
        assert_eq!(tagged["__labels"]["tier"], json!("frontend"));
    }

    #[tokio::test]
    async fn coalesces_repeat_upserts_for_same_uid() {
        // The previous broadcast pipe would emit 100 events. Under the
        // dirty-channel design, 100 writes to the same uid collapse to
        // one drained entry — the latest row wins.
        let chan = DirtyChannel::new();
        for i in 0..100 {
            chan.record_upsert("u1".to_owned(), row(&format!("v{i}")));
        }
        let batch = chan.drain();
        assert_eq!(batch.upserts.len(), 1);
        assert_eq!(batch.upserts["u1"]["name"], "v99");
        assert!(batch.deletes.is_empty());
    }

    #[tokio::test]
    async fn upsert_then_delete_resolves_to_delete() {
        let chan = DirtyChannel::new();
        chan.record_upsert("u1".to_owned(), row("a"));
        chan.record_delete("u1".to_owned());
        let batch = chan.drain();
        assert!(batch.upserts.is_empty(), "delete must clear pending upsert");
        assert!(batch.deletes.contains("u1"));
    }

    #[tokio::test]
    async fn delete_then_upsert_resolves_to_upsert() {
        // A reflector re-emit after 410 Gone can deliver Delete then
        // Upsert for the same uid; the final state is "present".
        let chan = DirtyChannel::new();
        chan.record_delete("u1".to_owned());
        chan.record_upsert("u1".to_owned(), row("a"));
        let batch = chan.drain();
        assert!(batch.deletes.is_empty(), "upsert must clear pending delete");
        assert_eq!(batch.upserts.len(), 1);
        assert_eq!(batch.upserts["u1"]["name"], "a");
    }

    #[tokio::test]
    async fn drain_capped_bounds_each_batch_and_loses_nothing() {
        // An init-phase drain can carry one distinct uid per object. Draining
        // in capped chunks must bound each batch yet deliver every uid exactly
        // once across the chunks.
        let chan = DirtyChannel::new();
        const N: usize = 2_500;
        for i in 0..N {
            chan.record_upsert(format!("u{i}"), row(&format!("v{i}")));
        }
        let mut seen = HashSet::new();
        let mut chunks = 0;
        loop {
            let batch = chan.drain_capped(1000);
            if batch.is_empty() {
                break;
            }
            assert!(batch.delta_count() <= 1000, "chunk exceeded the cap");
            for uid in batch.upserts.keys() {
                assert!(seen.insert(uid.clone()), "uid emitted twice: {uid}");
            }
            chunks += 1;
        }
        assert_eq!(seen.len(), N, "every uid must be delivered exactly once");
        assert_eq!(chunks, 3, "2500 / 1000 → 1000 + 1000 + 500");
        assert!(chan.drain().is_empty(), "channel fully drained");
    }

    #[tokio::test]
    async fn drain_capped_withholds_init_done_until_fully_drained() {
        // `init_done` means "initial sync complete". When the initial set is
        // sliced across chunks, the marker must ride the LAST chunk, never an
        // intermediate one — else the frontend flips to "ready" with rows
        // still in flight.
        let chan = DirtyChannel::new();
        for i in 0..2_500 {
            chan.record_upsert(format!("u{i}"), row("x"));
        }
        chan.mark_init_done();

        let first = chan.drain_capped(1000);
        assert!(!first.init_done, "init_done must not ride an early chunk");
        let second = chan.drain_capped(1000);
        assert!(!second.init_done, "init_done must not ride a middle chunk");
        let last = chan.drain_capped(1000);
        assert!(last.init_done, "init_done rides the final chunk");
        assert_eq!(last.delta_count(), 500);
        assert!(chan.drain_capped(1000).is_empty());
    }

    #[tokio::test]
    async fn drain_capped_fast_path_takes_all_under_cap() {
        // The common case: a steady-state batch fits under the cap, so one
        // call takes everything plus the init_done marker.
        let chan = DirtyChannel::new();
        for i in 0..5 {
            chan.record_upsert(format!("u{i}"), row("x"));
        }
        chan.mark_init_done();
        let batch = chan.drain_capped(1000);
        assert_eq!(batch.upserts.len(), 5);
        assert!(batch.init_done);
        assert!(chan.drain_capped(1000).is_empty());
    }

    #[tokio::test]
    async fn drain_capped_zero_means_no_cap() {
        let chan = DirtyChannel::new();
        for i in 0..2_000 {
            chan.record_upsert(format!("u{i}"), row("x"));
        }
        chan.mark_init_done();
        let batch = chan.drain_capped(0);
        assert_eq!(batch.upserts.len(), 2_000, "max=0 drains everything");
        assert!(batch.init_done);
    }

    #[tokio::test]
    async fn no_events_lost_under_burst_during_drain() {
        // Mirrors the production failure: while the consumer is busy
        // emitting batch N, many more events arrive. They must all be
        // visible in the next drain. The old broadcast pipe lost any
        // event past the 256-slot ring; this regresses if that pattern
        // ever returns.
        let chan = Arc::new(DirtyChannel::new());
        const N: usize = 5_000;

        let producer = {
            let chan = chan.clone();
            tokio::spawn(async move {
                for i in 0..N {
                    chan.record_upsert(format!("u{i}"), row(&format!("name{i}")));
                }
            })
        };

        let mut seen = HashSet::new();
        let consumer = {
            let chan = chan.clone();
            tokio::spawn(async move {
                while seen.len() < N {
                    if !chan.wait_for_change().await {
                        break;
                    }
                    // Simulate slow emit: yield + sleep to give the
                    // producer time to enqueue many uids per cycle.
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    let batch = chan.drain();
                    for uid in batch.upserts.keys() {
                        seen.insert(uid.clone());
                    }
                }
                seen
            })
        };

        producer.await.unwrap();
        // Producer is done — give the consumer one last cycle, then close so it exits.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            // Spin until drained or timeout
            loop {
                let drained = {
                    let s = chan.state.lock().unwrap();
                    s.changed.is_empty() && s.deleted.is_empty()
                };
                if drained {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        chan.close();

        let seen = consumer.await.unwrap();
        assert_eq!(
            seen.len(),
            N,
            "every uid produced must appear in some drained batch"
        );
    }

    #[tokio::test]
    async fn wait_returns_false_after_close() {
        let chan = Arc::new(DirtyChannel::new());
        let chan2 = chan.clone();
        let waiter = tokio::spawn(async move { chan2.wait_for_change().await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        chan.close();
        let result = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("waiter must unblock on close")
            .unwrap();
        assert!(!result, "wait_for_change must return false once closed");
    }

    #[tokio::test]
    async fn pending_work_still_drains_after_close() {
        // Closing doesn't lose unread state. The forwarder's last
        // drain after watcher Drop still gets every Upsert it queued.
        let chan = DirtyChannel::new();
        chan.record_upsert("u1".to_owned(), row("a"));
        chan.mark_init_done();
        chan.close();
        assert!(
            chan.wait_for_change().await,
            "wait must see the queued work even after close"
        );
        let batch = chan.drain();
        assert_eq!(batch.upserts.len(), 1);
        assert!(batch.init_done);
        // Second wait sees empty + closed.
        assert!(!chan.wait_for_change().await);
    }

    #[test]
    fn reconcile_init_seen_none_is_noop() {
        // If Init/InitDone never fired (e.g. an Apply-only stream), the
        // reconcile must not touch the cache and must return 0.
        let cache = Mutex::new(HashMap::from([("u1".to_owned(), row("a"))]));
        let chan = DirtyChannel::new();
        let mut seen: Option<HashSet<String>> = None;
        let n = reconcile_init_seen(&mut seen, &cache, &chan);
        assert_eq!(n, 0);
        assert_eq!(cache.lock().unwrap().len(), 1);
        assert!(chan.drain().is_empty());
    }

    #[test]
    fn reconcile_init_seen_drops_missing_uids() {
        // The reflector relist after sleep/wake / 410 Gone replays the
        // current state via Init→InitApply→InitDone but never tells us
        // what disappeared. `init_seen` carries the uids replayed in this
        // window; anything in the cache that's missing is a ghost.
        let cache = Mutex::new(HashMap::from([
            ("kept".to_owned(), row("k")),
            ("gone-1".to_owned(), row("g1")),
            ("gone-2".to_owned(), row("g2")),
        ]));
        let chan = DirtyChannel::new();
        let mut seen: Option<HashSet<String>> = Some(HashSet::from(["kept".to_owned()]));
        let n = reconcile_init_seen(&mut seen, &cache, &chan);
        assert_eq!(n, 2);
        assert!(seen.is_none(), "init_seen consumed");
        let c = cache.lock().unwrap();
        assert!(c.contains_key("kept"));
        assert!(!c.contains_key("gone-1"));
        assert!(!c.contains_key("gone-2"));
        let batch = chan.drain();
        assert!(batch.deletes.contains("gone-1"));
        assert!(batch.deletes.contains("gone-2"));
        assert!(batch.upserts.is_empty());
    }

    #[test]
    fn reconcile_init_seen_full_overlap_is_noop() {
        // Steady-state resync (apiserver still has every object we knew
        // about) must emit zero Deletes.
        let cache = Mutex::new(HashMap::from([
            ("a".to_owned(), row("a")),
            ("b".to_owned(), row("b")),
        ]));
        let chan = DirtyChannel::new();
        let mut seen: Option<HashSet<String>> = Some(HashSet::from([
            "a".to_owned(),
            "b".to_owned(),
            "c".to_owned(),
        ]));
        // Extra "c" in seen (live object we don't yet have cached) is
        // fine — InitApply for c would have already record_upsert'd it.
        let n = reconcile_init_seen(&mut seen, &cache, &chan);
        assert_eq!(n, 0);
        assert_eq!(cache.lock().unwrap().len(), 2);
        assert!(chan.drain().is_empty());
    }
}
