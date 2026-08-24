//! Resolve log targets to concrete pods.
//!
//! The aggregated logs / metrics panel lets the operator pick pods *or*
//! workloads (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job) — possibly
//! across clusters — and stream everything in one view. The frontend calls
//! `resolve_log_pods` once per cluster with that cluster's share of the
//! selection; each workload target expands to its pods via the workload's
//! label selector (same approach as `portforward.rs` pod resolution).
//!
//! Resolution is best-effort by design: one missing pod or a deleted workload
//! must not blank the whole aggregated view, so per-target failures are
//! collected into `warnings` instead of failing the call. The caller decides
//! how to surface them (the panel shows them above the stream).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use futures::stream::{self, StreamExt};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::ListParams;
use kube::runtime::watcher::Event;
use kube::runtime::{watcher, WatchStreamExt};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::fetch::FetchError;

/// Per-target resolution fan-out. A bulk selection of 100+ pods turns into
/// 100+ GETs; running them with bounded concurrency keeps the call fast
/// without stampeding the apiserver.
const RESOLVE_CONCURRENCY: usize = 8;

/// Cap on the pods a single resolve call returns. A DaemonSet on a large
/// cluster can select thousands of pods — far past what one aggregated view
/// can stream (the frontend additionally caps streams) and big enough to
/// hurt the IPC hop. Overflow is reported in `warnings`.
pub const MAX_RESOLVED_PODS: usize = 500;

/// One entry of the operator's selection, as the frontend sees it: the
/// registry kind id plus namespace/name. Only pod-bearing kinds are
/// accepted; anything else lands in `warnings`.
#[derive(Debug, Clone, Deserialize)]
pub struct LogPodTarget {
    pub kind_id: String,
    pub namespace: String,
    pub name: String,
}

/// What role a container plays in its pod. Drives how the logs surface groups
/// the picker and which containers stream by default in an aggregated view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogContainerKind {
    /// `spec.initContainers` without `restartPolicy: Always` — runs to
    /// completion before the pod starts. Its log is a fixed dump, not a live
    /// stream, but it's exactly what you need on `Init:CrashLoopBackOff`.
    Init,
    /// Native sidecar (K8s 1.29+): declared in `spec.initContainers` with
    /// `restartPolicy: Always`, so it keeps running alongside the main
    /// containers. Streams like a main container.
    Sidecar,
    /// `spec.containers`. Classic injected sidecars (istio-proxy, linkerd)
    /// live here too — the apiserver gives us no way to tell them apart.
    Main,
}

/// One loggable container on a resolved pod.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogContainer {
    pub name: String,
    pub kind: LogContainerKind,
}

/// A concrete pod the panel can open a log stream against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedLogPod {
    pub namespace: String,
    pub name: String,
    /// Every loggable container — init containers and native sidecars first
    /// (manifest order), then `spec.containers`. Mirrors the ordering of the
    /// pod row's `container_states` projection so the two surfaces agree.
    pub containers: Vec<LogContainer>,
}

#[derive(Debug, Default, Serialize)]
pub struct ResolvedLogPods {
    pub pods: Vec<ResolvedLogPod>,
    /// Per-target resolution problems (missing object, empty selector, no
    /// matching pods). The pods list stays usable alongside these.
    pub warnings: Vec<String>,
}

/// Expand `targets` into a deduplicated, name-sorted pod list, capped at
/// `MAX_RESOLVED_PODS`. Targets resolve with bounded concurrency
/// (`RESOLVE_CONCURRENCY`), results in input order.
pub async fn resolve_log_pods(client: Client, targets: &[LogPodTarget]) -> ResolvedLogPods {
    let mut out = ResolvedLogPods::default();
    // `buffered` (not `buffer_unordered`) keeps per-target results — and so
    // the warning order — deterministic. Targets are cloned into the stream:
    // borrowing them across the async closure trips a higher-ranked lifetime
    // error once the future is wrapped by the Tauri command macro.
    let results: Vec<(LogPodTarget, Result<Vec<ResolvedLogPod>, FetchError>)> =
        stream::iter(targets.to_vec())
            .map(|t| {
                let client = client.clone();
                async move {
                    let res = resolve_one(client, &t).await;
                    (t, res)
                }
            })
            .buffered(RESOLVE_CONCURRENCY)
            .collect()
            .await;
    // Keyed by namespace/name so a workload and one of its own pods selected
    // together don't double-stream.
    let mut seen: BTreeMap<(String, String), ResolvedLogPod> = BTreeMap::new();
    for (t, res) in results {
        match res {
            Ok(pods) => {
                if pods.is_empty() && t.kind_id != "pods" {
                    out.warnings.push(format!(
                        "{} {}/{}: no pods matched its selector",
                        kind_label(&t.kind_id),
                        t.namespace,
                        t.name
                    ));
                }
                for p in pods {
                    seen.entry((p.namespace.clone(), p.name.clone()))
                        .or_insert(p);
                }
            }
            Err(e) => out.warnings.push(format!(
                "{} {}/{}: {e}",
                kind_label(&t.kind_id),
                t.namespace,
                t.name
            )),
        }
    }
    out.pods = seen.into_values().collect();
    truncate_pods(&mut out);
    out
}

/// Enforce `MAX_RESOLVED_PODS`, recording how much was dropped.
fn truncate_pods(out: &mut ResolvedLogPods) {
    if out.pods.len() > MAX_RESOLVED_PODS {
        let dropped = out.pods.len() - MAX_RESOLVED_PODS;
        out.pods.truncate(MAX_RESOLVED_PODS);
        out.warnings.push(format!(
            "selection matched too many pods — showing the first {MAX_RESOLVED_PODS}, {dropped} more omitted"
        ));
    }
}

async fn resolve_one(client: Client, t: &LogPodTarget) -> Result<Vec<ResolvedLogPod>, FetchError> {
    if t.kind_id == "pods" {
        let api: Api<Pod> = Api::namespaced(client, &t.namespace);
        let pod = api.get(&t.name).await?;
        return Ok(vec![resolved_from_pod(&pod)]);
    }
    let selector = workload_selector(client.clone(), &t.kind_id, &t.namespace, &t.name).await?;
    list_by_selector(client, t, selector.as_ref()).await
}

/// GET a workload and return its pod `LabelSelector`. Shared by the one-shot
/// [`resolve_one`], the live [`start_log_pod_watch`], and
/// `fetch::list_pods_for_workload`. `None` only when the workload carries no
/// selector (just the optional `Job.spec.selector`). `UnknownKind` for
/// anything that isn't a pod-owning workload — notably `cronjobs`, whose pods
/// are reached through its child Jobs rather than a selector of its own.
pub(crate) async fn workload_selector(
    client: Client,
    kind_id: &str,
    namespace: &str,
    name: &str,
) -> Result<Option<LabelSelector>, FetchError> {
    match kind_id {
        "deployments" => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            Ok(api.get(name).await?.spec.map(|s| s.selector))
        }
        "statefulsets" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            Ok(api.get(name).await?.spec.map(|s| s.selector))
        }
        "daemonsets" => {
            let api: Api<DaemonSet> = Api::namespaced(client, namespace);
            Ok(api.get(name).await?.spec.map(|s| s.selector))
        }
        "replicasets" => {
            let api: Api<ReplicaSet> = Api::namespaced(client, namespace);
            Ok(api.get(name).await?.spec.map(|s| s.selector))
        }
        "jobs" => {
            let api: Api<Job> = Api::namespaced(client, namespace);
            Ok(api.get(name).await?.spec.and_then(|s| s.selector))
        }
        other => Err(FetchError::UnknownKind(other.to_owned())),
    }
}

async fn list_by_selector(
    client: Client,
    t: &LogPodTarget,
    selector: Option<&LabelSelector>,
) -> Result<Vec<ResolvedLogPod>, FetchError> {
    let Some(query) = selector.and_then(selector_query) else {
        // No usable selector — empty, or carrying an operator we don't
        // recognise. Surface it rather than over-matching the namespace.
        return Err(FetchError::NoSelector(t.name.clone()));
    };
    let pods: Api<Pod> = Api::namespaced(client, &t.namespace);
    let lp = ListParams::default().labels(&query);
    let list = pods.list(&lp).await?;
    Ok(list.items.iter().map(resolved_from_pod).collect())
}

/// Serialize a `LabelSelector` into the apiserver's label-selector query string,
/// covering BOTH `matchLabels` (equality) and `matchExpressions` (set-based:
/// `In` / `NotIn` / `Exists` / `DoesNotExist`). Returns `None` for a wholly
/// empty selector (no labels, no expressions) — which would match the entire
/// namespace, never what a workload means — and for a selector carrying an
/// operator we don't recognise, since silently dropping that term would widen
/// the match. matchLabels iterate in `BTreeMap` key order so the query is
/// deterministic.
pub(crate) fn selector_query(sel: &LabelSelector) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(labels) = sel.match_labels.as_ref() {
        for (k, v) in labels {
            parts.push(format!("{k}={v}"));
        }
    }
    if let Some(exprs) = sel.match_expressions.as_ref() {
        for e in exprs {
            let values = e.values.as_deref().unwrap_or_default();
            match e.operator.as_str() {
                "In" => parts.push(format!("{} in ({})", e.key, values.join(","))),
                "NotIn" => parts.push(format!("{} notin ({})", e.key, values.join(","))),
                "Exists" => parts.push(e.key.clone()),
                "DoesNotExist" => parts.push(format!("!{}", e.key)),
                // An unrecognised operator cannot be dropped: omitting a
                // restricting term (NotIn / DoesNotExist) WIDENS the query, so
                // we would match pods the workload doesn't own — and callers
                // port-forward to, and offer actions on, whatever comes back.
                // Refuse the whole selector instead; callers surface
                // `NoSelector`.
                _ => return None,
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

fn resolved_from_pod(pod: &Pod) -> ResolvedLogPod {
    ResolvedLogPod {
        namespace: pod.metadata.namespace.clone().unwrap_or_default(),
        name: pod.metadata.name.clone().unwrap_or_default(),
        containers: log_containers(pod),
    }
}

/// Classify every container the kubelet will serve logs for. Init containers
/// come first (manifest order), then `spec.containers` — matching
/// `kinds::pods::build_containers` so the row projection and the log picker
/// never disagree about ordering. Total: a pod with no spec yields an empty
/// list rather than panicking.
fn log_containers(pod: &Pod) -> Vec<LogContainer> {
    let Some(spec) = pod.spec.as_ref() else {
        return Vec::new();
    };
    let inits = spec.init_containers.iter().flatten().map(|c| LogContainer {
        name: c.name.clone(),
        // K8s 1.29+ native sidecar: an init container with
        // `restartPolicy: Always` keeps running alongside the main
        // containers, so it streams rather than dumping once.
        kind: if c.restart_policy.as_deref() == Some("Always") {
            LogContainerKind::Sidecar
        } else {
            LogContainerKind::Init
        },
    });
    let mains = spec.containers.iter().map(|c| LogContainer {
        name: c.name.clone(),
        kind: LogContainerKind::Main,
    });
    inits.chain(mains).collect()
}

fn kind_label(kind_id: &str) -> &str {
    match kind_id {
        "pods" => "Pod",
        "deployments" => "Deployment",
        "statefulsets" => "StatefulSet",
        "daemonsets" => "DaemonSet",
        "replicasets" => "ReplicaSet",
        "jobs" => "Job",
        other => other,
    }
}

// --- Live pod-set watch ---------------------------------------------------
//
// `resolve_log_pods` is a one-shot snapshot — it lists a workload's pods once.
// A long-lived logs panel needs the set to track scale-up / rollout / pod
// recreate so it can open streams for new pods and drop streams for gone pods
// without the operator reopening the panel. `LogPodWatch` watches the workload's
// pods (server-side label-selector-filtered) and broadcasts add/remove deltas.
// It mirrors `LogStream`'s lifecycle: a pre-subscribed receiver so the first
// consumer can't miss the seed, `Arc<Self>` held by the app, `Drop` aborts the
// task. The app bridges the broadcast to a Tauri channel.

/// Broadcast buffer. Pod-set churn is low-frequency (one event per pod
/// add/remove, deduped by container-set), so a small ring is ample.
const EVENT_BUFFER: usize = 256;

/// One change to a workload's live pod set, delivered to the logs panel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LogPodEvent {
    /// A pod entered the set, or its container list changed. Carries the full
    /// resolved pod so the frontend can (re)build its log sources.
    Added { pod: ResolvedLogPod },
    /// A pod left the set (scaled down, rolled, deleted).
    Removed { namespace: String, name: String },
    /// The initial set has been delivered; subsequent events are live deltas.
    /// Lets the panel flip "loading" → "ready" even for a zero-pod set.
    InitDone,
}

type PodKey = (String, String); // (namespace, name)

/// Container set remembered per pod so a status heartbeat doesn't re-emit
/// `Added`. Compares name *and* kind: an init container promoted to a native
/// sidecar across a rollout changes how the panel streams it.
type ContainerSet = Vec<LogContainer>;

/// Record an Apply: emit `Added` only when the pod is new or its container set
/// changed (an Apply fires on every status heartbeat — emitting unconditionally
/// would churn the frontend on a busy workload). Pure, for testing.
fn upsert_pod(
    seen: &mut BTreeMap<PodKey, ContainerSet>,
    pod: ResolvedLogPod,
) -> Option<LogPodEvent> {
    let key = (pod.namespace.clone(), pod.name.clone());
    if seen.get(&key).is_some_and(|c| c == &pod.containers) {
        return None;
    }
    seen.insert(key, pod.containers.clone());
    Some(LogPodEvent::Added { pod })
}

/// Record a Delete: emit `Removed` only if the pod was in the set. Pure.
fn remove_pod(
    seen: &mut BTreeMap<PodKey, ContainerSet>,
    namespace: &str,
    name: &str,
) -> Option<LogPodEvent> {
    if seen
        .remove(&(namespace.to_owned(), name.to_owned()))
        .is_some()
    {
        Some(LogPodEvent::Removed {
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        })
    } else {
        None
    }
}

/// Live watch over a workload's pods. See the module note above.
pub struct LogPodWatch {
    tx: broadcast::Sender<LogPodEvent>,
    initial_rx: Mutex<Option<broadcast::Receiver<LogPodEvent>>>,
    task: JoinHandle<()>,
}

impl LogPodWatch {
    /// Start watching pods in `namespace` matching `query` (a label-selector
    /// string). Returns immediately; the task fills the broadcast channel.
    fn start(client: Client, namespace: String, query: String) -> Arc<Self> {
        let (tx, initial_rx) = broadcast::channel(EVENT_BUFFER);
        let tx_task = tx.clone();
        let task = tokio::spawn(async move {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let cfg = watcher::Config::default().labels(&query);
            let stream = watcher(api, cfg).default_backoff();
            tokio::pin!(stream);
            // Track container-sets so duplicate Applies don't churn, and so a
            // relist (410 Gone / reconnect) can synthesise `Removed` for pods
            // that vanished while we were disconnected — the exact case where a
            // pod was deleted+recreated during a dead watch.
            let mut seen: BTreeMap<PodKey, ContainerSet> = BTreeMap::new();
            let mut init_keys: Option<BTreeSet<PodKey>> = None;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(Event::Init) => init_keys = Some(BTreeSet::new()),
                    Ok(Event::InitApply(pod)) => {
                        let r = resolved_from_pod(&pod);
                        if let Some(keys) = init_keys.as_mut() {
                            keys.insert((r.namespace.clone(), r.name.clone()));
                        }
                        if let Some(ev) = upsert_pod(&mut seen, r) {
                            let _ = tx_task.send(ev);
                        }
                    }
                    Ok(Event::Apply(pod)) => {
                        if let Some(ev) = upsert_pod(&mut seen, resolved_from_pod(&pod)) {
                            let _ = tx_task.send(ev);
                        }
                    }
                    Ok(Event::Delete(pod)) => {
                        let ns = pod.metadata.namespace.clone().unwrap_or_default();
                        let name = pod.metadata.name.clone().unwrap_or_default();
                        if let Some(ev) = remove_pod(&mut seen, &ns, &name) {
                            let _ = tx_task.send(ev);
                        }
                    }
                    Ok(Event::InitDone) => {
                        if let Some(keys) = init_keys.take() {
                            let stale: Vec<PodKey> = seen
                                .keys()
                                .filter(|k| !keys.contains(*k))
                                .cloned()
                                .collect();
                            for (ns, name) in stale {
                                if let Some(ev) = remove_pod(&mut seen, &ns, &name) {
                                    let _ = tx_task.send(ev);
                                }
                            }
                        }
                        let _ = tx_task.send(LogPodEvent::InitDone);
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            namespace = %namespace,
                            "log pod watch: stream error"
                        );
                    }
                }
            }
        });
        Arc::new(Self {
            tx,
            initial_rx: Mutex::new(Some(initial_rx)),
            task,
        })
    }

    /// Subscribe to pod-set events. The first caller gets the receiver that was
    /// subscribed before the task started (so the seed can't be missed); later
    /// callers get a fresh, best-effort receiver.
    pub fn subscribe(&self) -> broadcast::Receiver<LogPodEvent> {
        self.initial_rx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .unwrap_or_else(|| self.tx.subscribe())
    }
}

impl Drop for LogPodWatch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Resolve a workload `target` to its pod selector and start a [`LogPodWatch`]
/// over the matching pods. `UnknownKind` for `pods` (single pods use the
/// one-shot path) and other non-workload kinds; `NoSelector` when the workload
/// has no usable selector.
pub async fn start_log_pod_watch(
    client: Client,
    target: &LogPodTarget,
) -> Result<Arc<LogPodWatch>, FetchError> {
    let selector = workload_selector(
        client.clone(),
        &target.kind_id,
        &target.namespace,
        &target.name,
    )
    .await?;
    let Some(query) = selector.as_ref().and_then(selector_query) else {
        return Err(FetchError::NoSelector(target.name.clone()));
    };
    Ok(LogPodWatch::start(client, target.namespace.clone(), query))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn selector(v: serde_json::Value) -> LabelSelector {
        serde_json::from_value(v).expect("selector fixture")
    }

    #[test]
    fn selector_query_joins_match_labels() {
        let sel = selector(json!({ "matchLabels": { "app": "web", "tier": "fe" } }));
        // BTreeMap ordering makes the join deterministic.
        assert_eq!(selector_query(&sel).as_deref(), Some("app=web,tier=fe"));
    }

    #[test]
    fn selector_query_none_only_when_wholly_empty() {
        assert_eq!(selector_query(&selector(json!({}))), None);
        assert_eq!(
            selector_query(&selector(json!({ "matchLabels": {} }))),
            None
        );
    }

    #[test]
    fn selector_query_serializes_match_expressions() {
        // Set-based selectors are now supported server-side — no more silent
        // `NoSelector` for expression-only workloads.
        let sel = selector(json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [
                { "key": "tier", "operator": "In", "values": ["fe", "be"] },
                { "key": "canary", "operator": "NotIn", "values": ["true"] },
                { "key": "active", "operator": "Exists" },
                { "key": "legacy", "operator": "DoesNotExist" }
            ]
        }));
        assert_eq!(
            selector_query(&sel).as_deref(),
            Some("app=web,tier in (fe,be),canary notin (true),active,!legacy")
        );
    }

    /// Terse `LogContainer` builder for fixtures.
    fn main_c(name: &str) -> LogContainer {
        LogContainer {
            name: name.to_owned(),
            kind: LogContainerKind::Main,
        }
    }

    #[test]
    fn upsert_pod_emits_on_new_and_on_container_change_only() {
        let mut seen = BTreeMap::new();
        let pod = |containers: Vec<LogContainer>| ResolvedLogPod {
            namespace: "default".into(),
            name: "web-0".into(),
            containers,
        };
        // New pod → Added.
        assert!(matches!(
            upsert_pod(&mut seen, pod(vec![main_c("app")])),
            Some(LogPodEvent::Added { .. })
        ));
        // Same container set (status heartbeat) → no event.
        assert!(upsert_pod(&mut seen, pod(vec![main_c("app")])).is_none());
        // Container set changed (e.g. sidecar injected) → Added again.
        assert!(matches!(
            upsert_pod(&mut seen, pod(vec![main_c("app"), main_c("istio-proxy")])),
            Some(LogPodEvent::Added { .. })
        ));
    }

    #[test]
    fn upsert_pod_emits_when_only_the_container_kind_changed() {
        // A rollout that promotes an init container to a native sidecar keeps
        // the same names but changes how the panel must stream it, so the
        // frontend has to be told.
        let mut seen = BTreeMap::new();
        let pod = |kind: LogContainerKind| ResolvedLogPod {
            namespace: "default".into(),
            name: "web-0".into(),
            containers: vec![
                LogContainer {
                    name: "proxy".into(),
                    kind,
                },
                main_c("app"),
            ],
        };
        assert!(upsert_pod(&mut seen, pod(LogContainerKind::Init)).is_some());
        assert!(matches!(
            upsert_pod(&mut seen, pod(LogContainerKind::Sidecar)),
            Some(LogPodEvent::Added { .. })
        ));
    }

    #[test]
    fn remove_pod_emits_only_when_present() {
        let mut seen = BTreeMap::new();
        upsert_pod(
            &mut seen,
            ResolvedLogPod {
                namespace: "default".into(),
                name: "web-0".into(),
                containers: vec![main_c("app")],
            },
        );
        assert!(matches!(
            remove_pod(&mut seen, "default", "web-0"),
            Some(LogPodEvent::Removed { .. })
        ));
        // Already gone → no event.
        assert!(remove_pod(&mut seen, "default", "web-0").is_none());
        // Never seen → no event.
        assert!(remove_pod(&mut seen, "default", "ghost").is_none());
    }

    #[test]
    fn resolved_from_pod_keeps_container_order() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "namespace": "default", "name": "web-0" },
            "spec": { "containers": [
                { "name": "app" },
                { "name": "istio-proxy" }
            ]}
        }))
        .expect("pod fixture");
        let r = resolved_from_pod(&pod);
        assert_eq!(r.namespace, "default");
        assert_eq!(r.name, "web-0");
        // Classic injected sidecars live in `spec.containers` — indistinguishable
        // from the app container at the API level, so both are `Main`.
        assert_eq!(r.containers, vec![main_c("app"), main_c("istio-proxy")]);
    }

    #[test]
    fn log_containers_classifies_init_sidecar_and_main() {
        // The case that was previously unloggable: a native sidecar and a
        // plain init container, both declared under `spec.initContainers`.
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "namespace": "default", "name": "web-0" },
            "spec": {
                "initContainers": [
                    { "name": "migrate" },
                    { "name": "logship", "restartPolicy": "Always" }
                ],
                "containers": [{ "name": "app" }]
            }
        }))
        .expect("pod fixture");
        assert_eq!(
            log_containers(&pod),
            vec![
                LogContainer {
                    name: "migrate".into(),
                    kind: LogContainerKind::Init,
                },
                LogContainer {
                    name: "logship".into(),
                    kind: LogContainerKind::Sidecar,
                },
                main_c("app"),
            ]
        );
    }

    #[test]
    fn log_containers_serializes_kind_in_snake_case() {
        // The frontend discriminates on these exact strings.
        let c = LogContainer {
            name: "logship".into(),
            kind: LogContainerKind::Sidecar,
        };
        assert_eq!(
            serde_json::to_value(&c).expect("serialize"),
            json!({ "name": "logship", "kind": "sidecar" })
        );
    }

    #[test]
    fn truncate_pods_caps_and_warns() {
        let mut out = ResolvedLogPods {
            pods: (0..MAX_RESOLVED_PODS + 7)
                .map(|i| ResolvedLogPod {
                    namespace: "default".into(),
                    name: format!("p{i}"),
                    containers: vec![],
                })
                .collect(),
            warnings: vec![],
        };
        truncate_pods(&mut out);
        assert_eq!(out.pods.len(), MAX_RESOLVED_PODS);
        assert_eq!(out.warnings.len(), 1);
        assert!(
            out.warnings[0].contains("7 more omitted"),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn truncate_pods_is_a_noop_under_the_cap() {
        let mut out = ResolvedLogPods {
            pods: vec![ResolvedLogPod {
                namespace: "default".into(),
                name: "p0".into(),
                containers: vec![],
            }],
            warnings: vec![],
        };
        truncate_pods(&mut out);
        assert_eq!(out.pods.len(), 1);
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn resolved_from_pod_tolerates_missing_spec() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "namespace": "default", "name": "ghost" }
        }))
        .expect("pod fixture");
        let r = resolved_from_pod(&pod);
        assert!(r.containers.is_empty());
    }
}
