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
use k8s_openapi::api::core::v1::{Container, Pod, PodSpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const MAX_PODS_PER_LIST: usize = 500;

#[derive(Debug, Deserialize)]
struct ListArgs {
    /// Empty / omitted = cluster-wide (all namespaces).
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
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
}

// ─── fs_pods_list ────────────────────────────────────────────────────────────

pub(crate) struct PodsList {
    app: AppHandle,
    cluster_id: String,
}

impl PodsList {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
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
                top-level container reasons (CrashLoopBackOff, ImagePullBackOff, …). Capped at 500 \
                rows; refine selectors if you hit the cap."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string", "description": "Omit for cluster-wide." },
                    "label_selector": { "type": "string" },
                    "field_selector": { "type": "string" }
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
        let client = client_for(&self.app, &self.cluster_id).await?;

        let api: Api<Pod> = match a.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
            _ => Api::all(client),
        };
        let mut lp = ListParams::default().limit(MAX_PODS_PER_LIST as u32);
        if let Some(s) = a.label_selector.as_deref() {
            lp = lp.labels(s);
        }
        if let Some(s) = a.field_selector.as_deref() {
            lp = lp.fields(s);
        }
        let list = api.list(&lp).await.map_err(kube_err)?;
        let truncated = list.metadata.continue_.is_some();

        let rows: Vec<Value> = list.items.iter().map(project_pod_row).collect();
        Ok(json!({
            "count": rows.len(),
            "truncated": truncated,
            "pods": rows,
        }))
    }
}

// ─── fs_pods_get ─────────────────────────────────────────────────────────────

pub(crate) struct PodsGet {
    app: AppHandle,
    cluster_id: String,
}

impl PodsGet {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
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
        let client = client_for(&self.app, &self.cluster_id).await?;
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
    cluster_id: String,
}

impl PodsDelete {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
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
                actually scale-down or replace, use `fs_resources_scale` or `fs_apply_resource`."
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
        let client = client_for(&self.app, &self.cluster_id).await?;
        let api: Api<Pod> = Api::namespaced(client, &a.namespace);
        let dp = DeleteParams {
            grace_period_seconds: a.grace_period_seconds,
            ..Default::default()
        };
        api.delete(&a.name, &dp).await.map_err(kube_err)?;
        Ok(json!({
            "namespace": a.namespace,
            "name": a.name,
            "deleted": true,
        }))
    }
}

// ─── fs_pods_run ─────────────────────────────────────────────────────────────

pub(crate) struct PodsRun {
    app: AppHandle,
    cluster_id: String,
}

impl PodsRun {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
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
                instead. The pod's container is named `main` regardless of `name`."
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
        let client = client_for(&self.app, &self.cluster_id).await?;
        let api: Api<Pod> = Api::namespaced(client, &a.namespace);

        let ports = a.port.map(|p| {
            vec![k8s_openapi::api::core::v1::ContainerPort {
                container_port: p,
                ..Default::default()
            }]
        });
        let container = Container {
            name: "main".to_string(),
            image: Some(a.image.clone()),
            command: a.command,
            args: a.args,
            image_pull_policy: a.image_pull_policy,
            ports,
            ..Default::default()
        };
        let pod = Pod {
            metadata: ObjectMeta {
                name: a.name.clone(),
                namespace: Some(a.namespace.clone()),
                ..Default::default()
            },
            spec: Some(PodSpec {
                containers: vec![container],
                restart_policy: Some("Never".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

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

async fn client_for(app: &AppHandle, cluster_id: &str) -> Result<kube::Client, NativeToolError> {
    let state = app.state::<AppState>();
    let entry = state
        .entry(cluster_id)
        .await
        .map_err(NativeToolError::msg)?;
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
