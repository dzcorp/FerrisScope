//! `fs_pods_list` / `fs_pods_get` / `fs_pods_delete` / `fs_pods_run` —
//! kubectl-equivalent pod primitives.
//!
//! Distinct neighbours:
//!   * `fs_pod_exec` — run a command in an existing container.
//!   * `fs_logs_tail` — fan-out log tail with byte cap.
//!   * `fs_metrics_pod` — point-in-time CPU/mem from metrics-server.
//!
//! These four cover the gap (list / inspect / delete / spawn-from-image) so
//! the agent can do everything kubectl does for pods without an external
//! MCP server.

use std::collections::BTreeMap;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::core::v1::{Container, ContainerPort, Pod, PodSpec, ResourceRequirements};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::{delete_outcome_json, ChatClusterRef};
use crate::state::AppState;

/// Default total cap on rows returned. Conservative so a casual list
/// against a busy cluster doesn't dump thousands of pods into the
/// transcript on the first call. The model can opt up to
/// `MAX_PODS_HARD` via the `limit` arg when it actually wants the
/// full picture.
const DEFAULT_PODS_LIMIT: usize = 500;
/// Hard ceiling on `limit`. 10_000 covers real investigation needs
/// (large clusters often run 5–10k pods cluster-wide) without giving
/// a misbehaving model the option to ask for 1M and stall the chat
/// on a multi-second list call. Above this, narrow the selector.
const MAX_PODS_HARD: usize = 10_000;
/// Apiserver page size when paginating — 500 keeps each round-trip
/// cheap. We loop until we've filled the caller's `limit` or the
/// apiserver runs out of pages.
const PODS_PAGE_SIZE: u32 = 500;

#[derive(Debug, Deserialize)]
struct ListArgs {
    /// Empty / omitted = cluster-wide (all namespaces).
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
    /// Total rows to return. Default `DEFAULT_PODS_LIMIT` (500), max
    /// `MAX_PODS_HARD` (10_000). Backed by apiserver pagination —
    /// values above 500 trigger multiple GETs internally.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct NamespacedArgs {
    namespace: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct DeleteArgs {
    namespace: String,
    name: String,
    /// Optional grace period (seconds). 0 = delete immediately.
    #[serde(default)]
    grace_period_seconds: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RunArgs {
    namespace: String,
    /// Optional — apiserver auto-generates a name when absent.
    #[serde(default)]
    name: Option<String>,
    image: String,
    /// Single port to expose on the container. Optional.
    #[serde(default)]
    port: Option<i32>,
    /// Optional command override (argv).
    #[serde(default)]
    command: Option<Vec<String>>,
    /// Optional args (passed to the image's entrypoint or to `command`).
    #[serde(default)]
    args: Option<Vec<String>>,
    /// `Always` / `IfNotPresent` / `Never`. Default = apiserver default
    /// (Always for `:latest`, IfNotPresent otherwise).
    #[serde(default)]
    image_pull_policy: Option<String>,
    /// Run the pod under a specific ServiceAccount. Needed when the namespace
    /// is RBAC-locked or a policy engine requires a non-default SA.
    #[serde(default)]
    service_account_name: Option<String>,
    /// `Always` / `OnFailure` / `Never`. Default `Never` (one-shot debug pod).
    #[serde(default)]
    restart_policy: Option<String>,
    /// Labels to stamp on the pod — handy so a later `fs_pods_delete` /
    /// selector can find it, or to satisfy a policy that requires labels.
    #[serde(default)]
    labels: Option<BTreeMap<String, String>>,
    /// CPU/memory requests + limits. Many clusters run Kyverno / LimitRange
    /// policies that reject pods with no resources set — pass them here to get
    /// past those instead of hand-rolling YAML.
    #[serde(default)]
    resources: Option<RunResources>,
}

/// Resource requests/limits for `fs_pods_run`, each a map like
/// `{"cpu": "100m", "memory": "128Mi"}`.
#[derive(Debug, Deserialize)]
struct RunResources {
    #[serde(default)]
    requests: Option<BTreeMap<String, String>>,
    #[serde(default)]
    limits: Option<BTreeMap<String, String>>,
}

// ─── fs_pods_list ────────────────────────────────────────────────────────────

pub(crate) struct PodsList {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PodsList {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PodsList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pods_list".to_string(),
            description:
                "List pods. Omit `namespace` for cluster-wide. Optional `label_selector` (e.g. \
                `app=foo,tier=web`) and `field_selector` (e.g. `status.phase=Running`, \
                `spec.nodeName=node-1`) narrow the result. Returns one row per pod with name, \
                namespace, phase, node, ready/total container count, restart count, IP, age, and \
                top-level container reasons (CrashLoopBackOff, ImagePullBackOff, …). Default \
                limit is 500 rows; pass `limit` (max 10000) for bigger lists — pagination is \
                handled internally. When `truncated: true` either bump `limit` or refine selectors."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string", "description": "Omit for cluster-wide." },
                    "label_selector": { "type": "string" },
                    "field_selector": { "type": "string" },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 10000,
                        "description": "Total rows. Default 500, max 10000. Above 500 triggers internal pagination."
                    }
                },
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: ListArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;

        let api: Api<Pod> = match a.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
            _ => Api::all(client),
        };
        let limit = a
            .limit
            .unwrap_or(DEFAULT_PODS_LIMIT)
            .clamp(1, MAX_PODS_HARD);

        // Paginate via the apiserver's `continue` token until we've
        // filled `limit` or the server stops returning a continue
        // value. Each page is bounded by `PODS_PAGE_SIZE` so individual
        // round-trips stay cheap; the requested `limit` shapes how
        // many pages we ask for.
        let mut rows: Vec<Pod> = Vec::with_capacity(limit.min(1024));
        let mut continue_token: Option<String> = None;
        let mut server_has_more = false;
        loop {
            let remaining = limit.saturating_sub(rows.len());
            if remaining == 0 {
                // We hit the operator's cap. If the server *also* ran
                // out of pages we'd see continue=None on the previous
                // iteration; here we don't know, so treat as truncated
                // and let the model bump `limit` if it cares.
                server_has_more = continue_token.is_some();
                break;
            }
            let page_size = u32::try_from(remaining)
                .unwrap_or(PODS_PAGE_SIZE)
                .min(PODS_PAGE_SIZE);
            let mut lp = ListParams::default().limit(page_size);
            if let Some(s) = a.label_selector.as_deref() {
                lp = lp.labels(s);
            }
            if let Some(s) = a.field_selector.as_deref() {
                lp = lp.fields(s);
            }
            if let Some(tok) = continue_token.as_deref() {
                // kube-rs exposes `continue_token` on ListParams but
                // routes through the same field name on the wire.
                lp = lp.continue_token(tok);
            }
            let list = api.list(&lp).await.map_err(kube_err)?;
            rows.extend(list.items);
            match list.metadata.continue_.as_deref() {
                Some(t) if !t.is_empty() => {
                    continue_token = Some(t.to_string());
                }
                _ => {
                    // Server has no more pages — we got everything.
                    continue_token = None;
                    break;
                }
            }
        }
        let truncated = server_has_more && continue_token.is_some();

        let projected: Vec<Value> = rows.iter().map(project_pod_row).collect();
        Ok(json!({
            "count": projected.len(),
            "limit": limit,
            "limit_max": MAX_PODS_HARD,
            "truncated": truncated,
            "pods": projected,
        }))
    }
}

// ─── fs_pods_get ─────────────────────────────────────────────────────────────

pub(crate) struct PodsGet {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PodsGet {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PodsGet {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pods_get".to_string(),
            description:
                "Full Pod object as YAML (the same shape `kubectl get pod -o yaml` returns). Use \
                this when you need spec details, conditions, container statuses with last-state, \
                volumes, tolerations, etc. For a one-line view use `fs_pods_list`."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: NamespacedArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let api: Api<Pod> = Api::namespaced(client, &a.namespace);
        let pod = api.get(&a.name).await.map_err(kube_err)?;
        let yaml =
            serde_yaml::to_string(&pod).map_err(|e| NativeToolError::msg(format!("yaml: {e}")))?;
        Ok(json!({ "namespace": a.namespace, "name": a.name, "yaml": yaml }))
    }
}

// ─── fs_pods_delete ──────────────────────────────────────────────────────────

pub(crate) struct PodsDelete {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PodsDelete {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PodsDelete {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pods_delete".to_string(),
            description: "Delete a Pod. `grace_period_seconds: 0` forces immediate removal \
                (equivalent to `kubectl delete --grace-period=0 --force`). For \
                controller-managed pods the controller will recreate them; if you want to \
                actually scale-down or replace, use `fs_resources_scale` or `fs_apply_resource`. \
                Result reports `actually_deleted` vs `still_exists` — a pod within its grace \
                period or held by finalizers comes back `still_exists: true` with \
                `deletion_timestamp` / `remaining_finalizers`, not a false success."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" },
                    "grace_period_seconds": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Default = pod's terminationGracePeriodSeconds (usually 30). 0 = force-delete."
                    }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: DeleteArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let api: Api<Pod> = Api::namespaced(client, &a.namespace);
        let dp = DeleteParams {
            grace_period_seconds: a.grace_period_seconds,
            ..Default::default()
        };
        // `delete` returns the pod (Left) while it's still terminating
        // (grace period / finalizers), a Status (Right) once it's gone.
        let outcome = api.delete(&a.name, &dp).await.map_err(kube_err)?;
        let mut out = delete_outcome_json(outcome.left().as_ref().map(|p| &p.metadata));
        let obj = out
            .as_object_mut()
            .expect("delete_outcome_json returns object");
        obj.insert("namespace".into(), json!(a.namespace));
        obj.insert("name".into(), json!(a.name));
        Ok(out)
    }
}

// ─── fs_pods_run ─────────────────────────────────────────────────────────────

pub(crate) struct PodsRun {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PodsRun {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PodsRun {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pods_run".to_string(),
            description: "Create a single Pod from an image (kubectl run equivalent). \
                Use for ephemeral troubleshooting (netshoot, busybox, dnsutils). The pod has no \
                controller — when it exits or is deleted it's gone for good. For long-running \
                workloads create a Deployment via `fs_apply_resource` / `fs_resources_apply` \
                instead. The pod's container is named `main` regardless of `name`. \
                `restart_policy` defaults to `Never`. Set `service_account_name`, `labels`, and \
                `resources` (requests/limits) when the namespace enforces RBAC or admission \
                policies (Kyverno / LimitRange) that would otherwise reject a bare pod."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string", "description": "Optional. Apiserver auto-generates if omitted." },
                    "image": { "type": "string", "description": "e.g. nicolaka/netshoot:latest" },
                    "port": { "type": "integer", "description": "Single TCP port to expose." },
                    "command": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Override the image's entrypoint."
                    },
                    "args": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Args passed to the entrypoint or to `command`."
                    },
                    "image_pull_policy": {
                        "type": "string",
                        "enum": ["Always", "IfNotPresent", "Never"]
                    },
                    "service_account_name": { "type": "string", "description": "ServiceAccount to run as." },
                    "restart_policy": {
                        "type": "string",
                        "enum": ["Always", "OnFailure", "Never"],
                        "description": "Default Never."
                    },
                    "labels": {
                        "type": "object",
                        "additionalProperties": { "type": "string" },
                        "description": "Pod labels."
                    },
                    "resources": {
                        "type": "object",
                        "description": "CPU/memory requests + limits.",
                        "properties": {
                            "requests": { "type": "object", "additionalProperties": { "type": "string" } },
                            "limits": { "type": "object", "additionalProperties": { "type": "string" } }
                        },
                        "additionalProperties": false
                    }
                },
                "required": ["namespace", "image"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: RunArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let api: Api<Pod> = Api::namespaced(client, &a.namespace);

        let pod = build_run_pod(&a).map_err(NativeToolError::msg)?;

        let created = api
            .create(&PostParams::default(), &pod)
            .await
            .map_err(kube_err)?;
        Ok(json!({
            "namespace": a.namespace,
            "name": created.metadata.name,
            "uid": created.metadata.uid,
            "image": a.image,
            "phase": created.status.as_ref().and_then(|s| s.phase.clone()),
        }))
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async fn client_for(
    app: &AppHandle,
    cluster: &ChatClusterRef,
) -> Result<kube::Client, NativeToolError> {
    let id = cluster.active().await;
    let state = app.state::<AppState>();
    let entry = state.entry(&id).await.map_err(NativeToolError::msg)?;
    Ok(entry.cluster.client())
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

/// Compact one-row projection. Mirrors what `kubectl get pods` prints plus
/// per-container reason codes that surface CrashLoopBackOff /
/// ImagePullBackOff without a follow-up `fs_pods_get`.
fn project_pod_row(p: &Pod) -> Value {
    let name = p.metadata.name.clone().unwrap_or_default();
    let namespace = p.metadata.namespace.clone().unwrap_or_default();
    let node = p
        .spec
        .as_ref()
        .and_then(|s| s.node_name.clone())
        .unwrap_or_default();
    let phase = p
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_default();
    let pod_ip = p
        .status
        .as_ref()
        .and_then(|s| s.pod_ip.clone())
        .unwrap_or_default();
    let created = p
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|t| t.0.to_string());

    let mut total = 0usize;
    let mut ready = 0usize;
    let mut restarts: i32 = 0;
    let mut reasons: BTreeMap<String, i32> = BTreeMap::new();
    if let Some(statuses) = p
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
    {
        for cs in statuses {
            total += 1;
            if cs.ready {
                ready += 1;
            }
            restarts += cs.restart_count;
            if let Some(state) = cs.state.as_ref() {
                if let Some(w) = state.waiting.as_ref() {
                    if let Some(r) = &w.reason {
                        *reasons.entry(r.clone()).or_insert(0) += 1;
                    }
                }
                if let Some(t) = state.terminated.as_ref() {
                    if let Some(r) = &t.reason {
                        *reasons.entry(r.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    json!({
        "namespace": namespace,
        "name": name,
        "phase": phase,
        "ready": format!("{ready}/{total}"),
        "restarts": restarts,
        "node": node,
        "pod_ip": pod_ip,
        "created": created,
        "reasons": reasons,
    })
}

/// Map a `{name: quantity}` string map into the typed `Quantity` map the
/// `ResourceRequirements` struct expects. Validation of the quantity string
/// itself is left to the apiserver — it's the final arbiter and its error
/// message is clearer than anything we'd reconstruct.
fn quantities(map: &BTreeMap<String, String>) -> BTreeMap<String, Quantity> {
    map.iter()
        .map(|(k, v)| (k.clone(), Quantity(v.clone())))
        .collect()
}

/// Build the `Pod` for `fs_pods_run` from its args. Pure (no I/O) so the spec
/// shaping — defaults, optional fields, resource mapping — is unit-testable.
fn build_run_pod(a: &RunArgs) -> Result<Pod, String> {
    if let Some(rp) = a.restart_policy.as_deref() {
        if !matches!(rp, "Always" | "OnFailure" | "Never") {
            return Err(format!(
                "restart_policy must be Always, OnFailure, or Never (got `{rp}`)"
            ));
        }
    }

    let ports = a.port.map(|p| {
        vec![ContainerPort {
            container_port: p,
            ..Default::default()
        }]
    });
    let resources = a.resources.as_ref().map(|r| ResourceRequirements {
        requests: r.requests.as_ref().map(quantities),
        limits: r.limits.as_ref().map(quantities),
        ..Default::default()
    });
    let container = Container {
        name: "main".to_string(),
        image: Some(a.image.clone()),
        command: a.command.clone(),
        args: a.args.clone(),
        image_pull_policy: a.image_pull_policy.clone(),
        ports,
        resources,
        ..Default::default()
    };
    let labels = a.labels.clone().filter(|m| !m.is_empty());
    Ok(Pod {
        metadata: ObjectMeta {
            name: a.name.clone(),
            namespace: Some(a.namespace.clone()),
            labels,
            ..Default::default()
        },
        spec: Some(PodSpec {
            containers: vec![container],
            restart_policy: Some(
                a.restart_policy
                    .clone()
                    .unwrap_or_else(|| "Never".to_string()),
            ),
            service_account_name: a.service_account_name.clone(),
            ..Default::default()
        }),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_args(v: Value) -> RunArgs {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn run_pod_defaults_to_never_restart_one_container() {
        let pod = build_run_pod(&run_args(json!({
            "namespace": "ns",
            "image": "nicolaka/netshoot:latest"
        })))
        .unwrap();
        let spec = pod.spec.unwrap();
        assert_eq!(spec.restart_policy.as_deref(), Some("Never"));
        assert_eq!(spec.containers.len(), 1);
        assert_eq!(spec.containers[0].name, "main");
        assert_eq!(
            spec.containers[0].image.as_deref(),
            Some("nicolaka/netshoot:latest")
        );
        assert!(spec.service_account_name.is_none());
        assert!(spec.containers[0].resources.is_none());
        assert!(pod.metadata.labels.is_none());
    }

    #[test]
    fn run_pod_wires_sa_labels_and_resources() {
        let pod = build_run_pod(&run_args(json!({
            "namespace": "ns",
            "image": "busybox",
            "service_account_name": "debugger",
            "restart_policy": "OnFailure",
            "labels": { "app": "debug" },
            "resources": {
                "requests": { "cpu": "100m", "memory": "128Mi" },
                "limits": { "cpu": "200m", "memory": "256Mi" }
            }
        })))
        .unwrap();
        let spec = pod.spec.unwrap();
        assert_eq!(spec.restart_policy.as_deref(), Some("OnFailure"));
        assert_eq!(spec.service_account_name.as_deref(), Some("debugger"));
        assert_eq!(
            pod.metadata.labels.unwrap().get("app").map(String::as_str),
            Some("debug")
        );
        let res = spec.containers[0].resources.as_ref().unwrap();
        assert_eq!(
            res.requests.as_ref().unwrap()["cpu"],
            Quantity("100m".into())
        );
        assert_eq!(
            res.limits.as_ref().unwrap()["memory"],
            Quantity("256Mi".into())
        );
    }

    #[test]
    fn run_pod_rejects_bad_restart_policy() {
        let err = build_run_pod(&run_args(json!({
            "namespace": "ns",
            "image": "busybox",
            "restart_policy": "Sometimes"
        })))
        .unwrap_err();
        assert!(err.contains("restart_policy"));
    }

    #[test]
    fn run_pod_empty_labels_stay_unset() {
        // An empty labels map shouldn't produce `metadata.labels: {}`.
        let pod = build_run_pod(&run_args(json!({
            "namespace": "ns",
            "image": "busybox",
            "labels": {}
        })))
        .unwrap();
        assert!(pod.metadata.labels.is_none());
    }
}
