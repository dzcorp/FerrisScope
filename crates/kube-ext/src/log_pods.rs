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

use std::collections::BTreeMap;

use futures::stream::{self, StreamExt};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};

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

/// A concrete pod the panel can open a log stream against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedLogPod {
    pub namespace: String,
    pub name: String,
    /// Main containers (`spec.containers`), in manifest order — matches the
    /// `containers` field of the streamed pod row projection.
    pub containers: Vec<String>,
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
    match t.kind_id.as_str() {
        "pods" => {
            let api: Api<Pod> = Api::namespaced(client, &t.namespace);
            let pod = api.get(&t.name).await?;
            Ok(vec![resolved_from_pod(&pod)])
        }
        "deployments" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &t.namespace);
            let w = api.get(&t.name).await?;
            list_by_selector(client, t, w.spec.as_ref().map(|s| &s.selector)).await
        }
        "statefulsets" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &t.namespace);
            let w = api.get(&t.name).await?;
            list_by_selector(client, t, w.spec.as_ref().map(|s| &s.selector)).await
        }
        "daemonsets" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &t.namespace);
            let w = api.get(&t.name).await?;
            list_by_selector(client, t, w.spec.as_ref().map(|s| &s.selector)).await
        }
        "replicasets" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), &t.namespace);
            let w = api.get(&t.name).await?;
            list_by_selector(client, t, w.spec.as_ref().map(|s| &s.selector)).await
        }
        "jobs" => {
            let api: Api<Job> = Api::namespaced(client.clone(), &t.namespace);
            let w = api.get(&t.name).await?;
            list_by_selector(client, t, w.spec.as_ref().and_then(|s| s.selector.as_ref())).await
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
        // A selector built only from matchExpressions can't be expressed as
        // an equality list query — surface it rather than over-matching the
        // whole namespace.
        return Err(FetchError::NoSelector(t.name.clone()));
    };
    let pods: Api<Pod> = Api::namespaced(client, &t.namespace);
    let lp = ListParams::default().labels(&query);
    let list = pods.list(&lp).await?;
    Ok(list.items.iter().map(resolved_from_pod).collect())
}

/// `matchLabels` as a comma-joined equality query. `None` when there are no
/// match labels (e.g. expressions-only selector).
fn selector_query(sel: &LabelSelector) -> Option<String> {
    let labels = sel.match_labels.as_ref()?;
    if labels.is_empty() {
        return None;
    }
    Some(
        labels
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(","),
    )
}

fn resolved_from_pod(pod: &Pod) -> ResolvedLogPod {
    ResolvedLogPod {
        namespace: pod.metadata.namespace.clone().unwrap_or_default(),
        name: pod.metadata.name.clone().unwrap_or_default(),
        containers: pod
            .spec
            .as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default(),
    }
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
    fn selector_query_rejects_empty_and_expression_only() {
        assert_eq!(selector_query(&selector(json!({}))), None);
        assert_eq!(
            selector_query(&selector(json!({ "matchLabels": {} }))),
            None
        );
        let expr_only = selector(json!({
            "matchExpressions": [{ "key": "app", "operator": "Exists" }]
        }));
        assert_eq!(selector_query(&expr_only), None);
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
        assert_eq!(r.containers, vec!["app", "istio-proxy"]);
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
