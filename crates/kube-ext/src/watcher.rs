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

use std::collections::HashMap;
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
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::registry::KindSpec;

const DELTA_BUFFER: usize = 1024;

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

/// A live reflector + broadcast for a single (cluster, kind). Use
/// [`start::<S>`] from [`KindSpec`] to construct one. Drop aborts the task.
pub struct ResourceWatcher {
    snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync>,
    tx: broadcast::Sender<ResourceDelta>,
    /// Set after kube-rs emits `Event::InitDone`. Read by `subscribe_resource`
    /// so a late subscriber (one that connects *after* init finished) still
    /// learns the watcher is past initial sync — the broadcast channel
    /// itself doesn't replay history, so without this flag a late subscriber
    /// would see an unbounded-looking spinner.
    init_done: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl ResourceWatcher {
    pub fn start<S: KindSpec>(client: Client, strategy: ListStrategy) -> Self {
        let (tx, _rx) = broadcast::channel(DELTA_BUFFER);
        // Api::all watches across all namespaces for namespaced kinds and the
        // whole cluster for cluster-scoped kinds.
        let api: Api<S::K> = Api::all(client);
        // Project on apply, store only the projected row. A typed reflector
        // store would keep full `Arc<S::K>` per object — on a 5000-pod
        // cluster that's 50–200 MB of typed Rust state we never read again
        // (the UI consumes the projected row, not the Pod struct).
        let cache: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));

        let cfg = watcher_config(strategy);
        let stream = watcher(api, cfg).default_backoff();

        let init_done = Arc::new(AtomicBool::new(false));
        let init_done_task = init_done.clone();
        let tx_task = tx.clone();
        let cache_task = cache.clone();
        let task = tokio::spawn(async move {
            // Per-task timing so the operator can pinpoint where Pods-load
            // latency lives. Markers logged: task start, first InitApply
            // (apiserver returned the first object), every Nth InitApply
            // (page-drain progress), InitDone (initial sync complete), and
            // subsequent Apply / Delete events at debug level. Read with
            // `RUST_LOG=ferrisscope=info` (or `=debug` for the fine-grained
            // per-event lines).
            let started = std::time::Instant::now();
            tracing::info!(kind = S::meta().id, ?strategy, "watcher: task starting");
            tokio::pin!(stream);
            let mut applied = 0u64;
            let mut suppressed = 0u64;
            let mut first_apply_logged = false;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(watcher::Event::Apply(obj) | watcher::Event::InitApply(obj)) => {
                        let Some(uid) = obj.uid() else { continue };
                        let row = with_uid(uid.clone(), S::project(&obj));
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
                        let mut cache = cache_task.lock().expect("watcher cache poisoned");
                        let unchanged = cache.get(&uid).is_some_and(|prev| prev == &row);
                        if unchanged {
                            suppressed += 1;
                        } else {
                            cache.insert(uid.clone(), row.clone());
                            drop(cache);
                            let _ = tx_task.send(ResourceDelta::Upsert { row });
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
                            tracing::info!(
                                kind = S::meta().id,
                                elapsed_ms = started.elapsed().as_millis() as u64,
                                applied,
                                suppressed,
                                "watcher: apply progress"
                            );
                        }
                    }
                    Ok(watcher::Event::Delete(obj)) => {
                        if let Some(uid) = obj.uid() {
                            tracing::debug!(
                                kind = S::meta().id,
                                uid = %uid,
                                "watcher: delete"
                            );
                            cache_task
                                .lock()
                                .expect("watcher cache poisoned")
                                .remove(&uid);
                            let _ = tx_task.send(ResourceDelta::Delete { uid });
                        }
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = S::meta().id, "watcher: init");
                    }
                    Ok(watcher::Event::InitDone) => {
                        init_done_task.store(true, Ordering::SeqCst);
                        tracing::info!(
                            kind = S::meta().id,
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            suppressed,
                            "watcher: init done (initial sync complete)"
                        );
                        let _ = tx_task.send(ResourceDelta::InitDone);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, kind = S::meta().id, "watcher: stream error");
                    }
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

        let snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync> = Box::new(move || {
            cache
                .lock()
                .expect("watcher cache poisoned")
                .values()
                .cloned()
                .collect()
        });

        Self {
            snapshot_fn,
            tx,
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
        strategy: ListStrategy,
    ) -> Self {
        let (tx, _rx) = broadcast::channel(DELTA_BUFFER);
        // `Api::all_with` works for both cluster-scoped and namespaced kinds:
        // for namespaced kinds it yields a cross-namespace stream, which is
        // exactly what we want.
        let api: Api<DynamicObject> = Api::all_with(client, &ar);
        let cache: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));

        let cfg = watcher_config(strategy);
        let stream = watcher(api, cfg).default_backoff();

        let init_done = Arc::new(AtomicBool::new(false));
        let init_done_task = init_done.clone();
        let tx_task = tx.clone();
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
            while let Some(event) = stream.next().await {
                match event {
                    Ok(watcher::Event::Apply(obj) | watcher::Event::InitApply(obj)) => {
                        let Some(uid) = obj.uid() else {
                            skipped_no_uid += 1;
                            continue;
                        };
                        let row = with_uid(uid.clone(), project_task(&obj));
                        // No-op suppression — see typed-watcher branch above
                        // for the rationale. Same behaviour: cheap structural
                        // equality on the projected row; on miss, update the
                        // cache and broadcast; on hit, drop silently.
                        let mut cache = cache_task.lock().expect("dynamic watcher cache poisoned");
                        let unchanged = cache.get(&uid).is_some_and(|prev| prev == &row);
                        if unchanged {
                            suppressed += 1;
                        } else {
                            cache.insert(uid.clone(), row.clone());
                            drop(cache);
                            let _ = tx_task.send(ResourceDelta::Upsert { row });
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
                            tracing::info!(
                                kind = %log_id_task,
                                elapsed_ms = started.elapsed().as_millis() as u64,
                                applied,
                                suppressed,
                                "dynamic watcher: apply progress"
                            );
                        }
                    }
                    Ok(watcher::Event::Delete(obj)) => {
                        if let Some(uid) = obj.uid() {
                            cache_task
                                .lock()
                                .expect("dynamic watcher cache poisoned")
                                .remove(&uid);
                            let _ = tx_task.send(ResourceDelta::Delete { uid });
                        }
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = %log_id_task, "dynamic watcher: init");
                    }
                    Ok(watcher::Event::InitDone) => {
                        tracing::info!(
                            kind = %log_id_task,
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            suppressed,
                            skipped_no_uid,
                            "dynamic watcher: init done"
                        );
                        init_done_task.store(true, Ordering::SeqCst);
                        let _ = tx_task.send(ResourceDelta::InitDone);
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            kind = %log_id_task,
                            "dynamic watcher: stream error"
                        );
                    }
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
            cache_snap
                .lock()
                .expect("dynamic watcher cache poisoned")
                .values()
                .cloned()
                .collect()
        });

        Self {
            snapshot_fn,
            tx,
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
    pub fn start_helm_releases(client: Client, strategy: ListStrategy) -> Self {
        use crate::kinds::helm_releases::{
            decode_release, project_row, synthetic_uid, Release, HELM_SECRET_TYPE,
        };
        use k8s_openapi::api::core::v1::Secret;
        use kube::ResourceExt;
        use std::collections::BTreeMap;

        let (tx, _rx) = broadcast::channel(DELTA_BUFFER);
        let api: Api<Secret> = Api::all(client);

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
        let tx_task = tx.clone();
        let store_task = store.clone();

        let task = tokio::spawn(async move {
            let started = std::time::Instant::now();
            tracing::info!(kind = "helm_releases", ?strategy, "helm watcher: starting");
            tokio::pin!(stream);
            let mut applied = 0u64;
            let mut decode_errors = 0u64;
            let mut first_apply_logged = false;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(watcher::Event::Apply(obj) | watcher::Event::InitApply(obj)) => {
                        let Some(secret_uid) = obj.uid() else {
                            continue;
                        };
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
                        let mut g = store_task.lock().expect("helm store poisoned");
                        let entry = g.entry(key.clone()).or_default();
                        entry.insert(secret_uid, release);
                        if let Some(latest) = entry.values().max_by_key(|r| r.version) {
                            let row = with_uid(synthetic_uid(&ns, &name), project_row(latest));
                            let _ = tx_task.send(ResourceDelta::Upsert { row });
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
                    Ok(watcher::Event::Delete(obj)) => {
                        let Some(secret_uid) = obj.uid() else {
                            continue;
                        };
                        let mut g = store_task.lock().expect("helm store poisoned");
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
                            let _ = tx_task.send(ResourceDelta::Delete {
                                uid: synthetic_uid(&key.0, &key.1),
                            });
                        } else if let Some(latest) = revs.values().max_by_key(|r| r.version) {
                            // A non-latest revision was removed, or latest
                            // was removed and we now demote: re-emit so the
                            // table reflects the new live revision.
                            let row = with_uid(synthetic_uid(&key.0, &key.1), project_row(latest));
                            let _ = tx_task.send(ResourceDelta::Upsert { row });
                        }
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = "helm_releases", "helm watcher: init");
                    }
                    Ok(watcher::Event::InitDone) => {
                        init_done_task.store(true, Ordering::SeqCst);
                        tracing::info!(
                            kind = "helm_releases",
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            decode_errors,
                            "helm watcher: init done"
                        );
                        let _ = tx_task.send(ResourceDelta::InitDone);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, kind = "helm_releases", "helm watcher: stream error");
                    }
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
            let g = store_snap.lock().expect("helm store poisoned");
            g.iter()
                .filter_map(|((ns, name), revs)| {
                    let latest = revs.values().max_by_key(|r| r.version)?;
                    Some(with_uid(synthetic_uid(ns, name), project_row(latest)))
                })
                .collect()
        });

        Self {
            snapshot_fn,
            tx,
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
    pub fn start_helm_charts(client: Client, strategy: ListStrategy) -> Self {
        use crate::fetch::{helm_search_repo, HelmRepoChart, HELM_CLUSTER_SOURCE};
        use crate::kinds::helm_charts::{project_cluster_row, project_repo_row, synthetic_uid};
        use crate::kinds::helm_releases::{decode_release, Release, HELM_SECRET_TYPE};
        use k8s_openapi::api::core::v1::Secret;
        use kube::ResourceExt;
        use std::collections::{BTreeMap, HashMap, HashSet};

        let (tx, _rx) = broadcast::channel(DELTA_BUFFER);
        let api: Api<Secret> = Api::all(client);

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
        let tx_task = tx.clone();
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
                let tx = tx_task.clone();
                let store = repo_charts_task.clone();
                tokio::spawn(async move {
                    let entries = helm_search_repo().await;
                    let mut g = store.lock().expect("helm-chart repo map poisoned");
                    for rc in &entries {
                        let key: RepoKey = (rc.repo.clone(), rc.name.clone(), rc.version.clone());
                        g.insert(key.clone(), rc.clone());
                        let row = with_uid(
                            synthetic_uid(&rc.repo, &rc.name, &rc.version),
                            project_repo_row(rc),
                        );
                        let _ = tx.send(ResourceDelta::Upsert { row });
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
            while let Some(event) = stream.next().await {
                match event {
                    Ok(watcher::Event::Apply(obj) | watcher::Event::InitApply(obj)) => {
                        let Some(secret_uid) = obj.uid() else {
                            continue;
                        };
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
                        let prior_key = secret_map_task
                            .lock()
                            .expect("helm-chart secret map poisoned")
                            .get(&secret_uid)
                            .cloned();
                        if let Some(old_key) = prior_key {
                            if old_key != new_key {
                                demote_cluster_chart(
                                    &cluster_charts_task,
                                    &old_key,
                                    &secret_uid,
                                    &tx_task,
                                );
                            }
                        }

                        {
                            let mut g =
                                cluster_charts_task.lock().expect("helm-chart map poisoned");
                            let entry = g.entry(new_key.clone()).or_insert_with(|| ChartEntry {
                                sample: release.clone(),
                                secret_uids: HashSet::new(),
                            });
                            entry.secret_uids.insert(secret_uid.clone());
                            let row = with_uid(
                                synthetic_uid(HELM_CLUSTER_SOURCE, &name, &version),
                                project_cluster_row(&entry.sample, entry.secret_uids.len()),
                            );
                            let _ = tx_task.send(ResourceDelta::Upsert { row });
                        }
                        secret_map_task
                            .lock()
                            .expect("helm-chart secret map poisoned")
                            .insert(secret_uid, new_key);

                        applied += 1;
                    }
                    Ok(watcher::Event::Delete(obj)) => {
                        let Some(secret_uid) = obj.uid() else {
                            continue;
                        };
                        let key = secret_map_task
                            .lock()
                            .expect("helm-chart secret map poisoned")
                            .remove(&secret_uid);
                        if let Some(k) = key {
                            demote_cluster_chart(&cluster_charts_task, &k, &secret_uid, &tx_task);
                        }
                    }
                    Ok(watcher::Event::Init) => {
                        tracing::debug!(kind = "helm_charts", "helm-chart watcher: init");
                    }
                    Ok(watcher::Event::InitDone) => {
                        init_done_task.store(true, Ordering::SeqCst);
                        tracing::info!(
                            kind = "helm_charts",
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            applied,
                            decode_errors,
                            "helm-chart watcher: init done"
                        );
                        let _ = tx_task.send(ResourceDelta::InitDone);
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            kind = "helm_charts",
                            "helm-chart watcher: stream error"
                        );
                    }
                }
            }
        });

        // Snapshot for late subscribers — covers both sources.
        let cluster_snap = cluster_charts.clone();
        let repo_snap = repo_charts.clone();
        let snapshot_fn: Box<dyn Fn() -> Vec<Value> + Send + Sync> = Box::new(move || {
            use crate::fetch::HELM_CLUSTER_SOURCE;
            let mut out = Vec::new();
            {
                let g = cluster_snap.lock().expect("helm-chart map poisoned");
                for ((name, version), entry) in g.iter() {
                    out.push(with_uid(
                        synthetic_uid(HELM_CLUSTER_SOURCE, name, version),
                        project_cluster_row(&entry.sample, entry.secret_uids.len()),
                    ));
                }
            }
            {
                let g = repo_snap.lock().expect("helm-chart repo map poisoned");
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
            tx,
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
            tx: &broadcast::Sender<ResourceDelta>,
        ) {
            use crate::fetch::HELM_CLUSTER_SOURCE;
            let mut g = charts.lock().expect("helm-chart map poisoned");
            let Some(entry) = g.get_mut(key) else { return };
            entry.secret_uids.remove(secret_uid);
            if entry.secret_uids.is_empty() {
                g.remove(key);
                let _ = tx.send(ResourceDelta::Delete {
                    uid: synthetic_uid(HELM_CLUSTER_SOURCE, &key.0, &key.1),
                });
            } else {
                let row = with_uid(
                    synthetic_uid(HELM_CLUSTER_SOURCE, &key.0, &key.1),
                    project_cluster_row(&entry.sample, entry.secret_uids.len()),
                );
                let _ = tx.send(ResourceDelta::Upsert { row });
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

    pub fn subscribe(&self) -> broadcast::Receiver<ResourceDelta> {
        self.tx.subscribe()
    }
}

impl Drop for ResourceWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
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
