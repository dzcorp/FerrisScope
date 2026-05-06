//! `fs_resources_*` — generic dynamic-API tools.
//!
//! These work against arbitrary apiVersion/kind, including CRDs the registry
//! doesn't know about. The agent's read-side toolkit goes through here when
//! the kind isn't covered by a more specific tool (`fs_pods_*`,
//! `fs_helm_*`, etc.). Discovery resolves plural + scope per call so this
//! works for kinds we've never seen before.
//!
//! Why two apply tools (this `fs_resources_apply` + `fs_apply_resource`)?
//! `fs_apply_resource` takes a registry `kind_id` and a *partial* field tree;
//! it's the precise lever for "set replicas to 5" or "patch labels". This
//! one takes a full YAML/JSON document so the agent can stand up a brand-new
//! object (Deployment from scratch, CRD instance, multi-doc manifest). Both
//! land through SSA with field manager `ferrisscope`.

use std::time::Duration;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_kube_ext::{apply_yaml, FIELD_MANAGER};
use http::Request;
use kube::api::{Api, DeleteParams, DynamicObject, GroupVersionKind, ListParams};
use kube::discovery;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const MAX_LIST_ITEMS: u32 = 500;
const SCALE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
struct GvkArgs {
    api_version: String,
    kind: String,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GetArgs {
    api_version: String,
    kind: String,
    #[serde(default)]
    namespace: Option<String>,
    name: String,
}

#[derive(Debug, Deserialize)]
struct DeleteArgs {
    api_version: String,
    kind: String,
    #[serde(default)]
    namespace: Option<String>,
    name: String,
    #[serde(default)]
    grace_period_seconds: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ScaleArgs {
    api_version: String,
    kind: String,
    /// Required — scale only applies to namespaced kinds.
    namespace: String,
    name: String,
    /// `None` = read-only (return current scale); `Some(n)` = set replicas.
    #[serde(default)]
    replicas: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ApplyArgs {
    /// YAML or JSON document(s). Multi-doc YAML is supported (separated by
    /// `---`); each doc is applied independently with per-doc results.
    manifest: String,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    force: bool,
}

// ─── fs_resources_list ───────────────────────────────────────────────────────

pub(crate) struct ResourcesList {
    app: AppHandle,
    cluster_id: String,
}

impl ResourcesList {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ResourcesList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_list".to_string(),
            description: "List resources of any kind by apiVersion + kind. Works for built-ins \
                and CRDs alike. Pass a bare apiVersion (`v1`, `apps/v1`, `networking.k8s.io/v1`, \
                `cert-manager.io/v1`). Omit `namespace` for cluster-wide on namespaced kinds; \
                ignored for cluster-scoped kinds. Returns each item's metadata + a thin \
                projection (kind, name, namespace, age, top-level status fields). Capped at 500 \
                items — narrow with `label_selector` / `field_selector` if you need more."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_version": { "type": "string", "description": "e.g. `v1`, `apps/v1`, `networking.k8s.io/v1`." },
                    "kind": { "type": "string", "description": "PascalCase kind, e.g. `Pod`, `Deployment`, `Ingress`." },
                    "namespace": { "type": "string" },
                    "label_selector": { "type": "string" },
                    "field_selector": { "type": "string" }
                },
                "required": ["api_version", "kind"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: GvkArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;
        let (ar, caps) = resolve_gvk(&client, &a.api_version, &a.kind).await?;

        let api: Api<DynamicObject> = match caps.scope {
            discovery::Scope::Namespaced => match a.namespace.as_deref() {
                Some(ns) if !ns.is_empty() => Api::namespaced_with(client, ns, &ar),
                _ => Api::all_with(client, &ar),
            },
            discovery::Scope::Cluster => Api::all_with(client, &ar),
        };

        let mut lp = ListParams::default().limit(MAX_LIST_ITEMS);
        if let Some(s) = a.label_selector.as_deref() {
            lp = lp.labels(s);
        }
        if let Some(s) = a.field_selector.as_deref() {
            lp = lp.fields(s);
        }
        let list = api.list(&lp).await.map_err(kube_err)?;
        let truncated = list.metadata.continue_.is_some();

        let items: Vec<Value> = list.items.iter().map(project_dyn_row).collect();
        Ok(json!({
            "api_version": a.api_version,
            "kind": a.kind,
            "scope": scope_label(caps.scope),
            "count": items.len(),
            "truncated": truncated,
            "items": items,
        }))
    }
}

// ─── fs_resources_get ────────────────────────────────────────────────────────

pub(crate) struct ResourcesGet {
    app: AppHandle,
    cluster_id: String,
}

impl ResourcesGet {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ResourcesGet {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_get".to_string(),
            description: "Fetch a single resource by apiVersion + kind + name. Returns the full \
                object as YAML, the same shape `kubectl get -o yaml` produces. Works for any \
                kind including CRDs. For Pods prefer `fs_pods_get` (slightly cheaper, same \
                output)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_version": { "type": "string" },
                    "kind": { "type": "string" },
                    "namespace": { "type": "string", "description": "Required for namespaced kinds." },
                    "name": { "type": "string" }
                },
                "required": ["api_version", "kind", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: GetArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;
        let (ar, caps) = resolve_gvk(&client, &a.api_version, &a.kind).await?;

        let api: Api<DynamicObject> = match caps.scope {
            discovery::Scope::Namespaced => {
                let ns = a.namespace.as_deref().ok_or_else(|| {
                    NativeToolError::msg(format!(
                        "namespace required for namespaced kind {}",
                        a.kind
                    ))
                })?;
                Api::namespaced_with(client, ns, &ar)
            }
            discovery::Scope::Cluster => Api::all_with(client, &ar),
        };

        let obj = api.get(&a.name).await.map_err(kube_err)?;
        let yaml =
            serde_yaml::to_string(&obj).map_err(|e| NativeToolError::msg(format!("yaml: {e}")))?;
        Ok(json!({
            "api_version": a.api_version,
            "kind": a.kind,
            "namespace": a.namespace,
            "name": a.name,
            "yaml": yaml,
        }))
    }
}

// ─── fs_resources_delete ─────────────────────────────────────────────────────

pub(crate) struct ResourcesDelete {
    app: AppHandle,
    cluster_id: String,
}

impl ResourcesDelete {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ResourcesDelete {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_delete".to_string(),
            description: "Delete any resource by apiVersion + kind + name. Cluster-scoped kinds \
                ignore `namespace`; namespaced kinds require it. `grace_period_seconds: 0` does \
                a force-delete (used for stuck pods). For pods specifically, `fs_pods_delete` is \
                a thinner wrapper."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_version": { "type": "string" },
                    "kind": { "type": "string" },
                    "namespace": { "type": "string" },
                    "name": { "type": "string" },
                    "grace_period_seconds": { "type": "integer", "minimum": 0 }
                },
                "required": ["api_version", "kind", "name"],
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
        let (ar, caps) = resolve_gvk(&client, &a.api_version, &a.kind).await?;

        let api: Api<DynamicObject> = match caps.scope {
            discovery::Scope::Namespaced => {
                let ns = a.namespace.as_deref().ok_or_else(|| {
                    NativeToolError::msg(format!(
                        "namespace required for namespaced kind {}",
                        a.kind
                    ))
                })?;
                Api::namespaced_with(client, ns, &ar)
            }
            discovery::Scope::Cluster => Api::all_with(client, &ar),
        };

        let dp = DeleteParams {
            grace_period_seconds: a.grace_period_seconds,
            ..Default::default()
        };
        api.delete(&a.name, &dp).await.map_err(kube_err)?;
        Ok(json!({
            "api_version": a.api_version,
            "kind": a.kind,
            "namespace": a.namespace,
            "name": a.name,
            "deleted": true,
        }))
    }
}

// ─── fs_resources_scale ──────────────────────────────────────────────────────

pub(crate) struct ResourcesScale {
    app: AppHandle,
    cluster_id: String,
}

impl ResourcesScale {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ResourcesScale {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_scale".to_string(),
            description: "Read or update the `scale` subresource on a Deployment / StatefulSet / \
                ReplicaSet / ReplicationController. Omit `replicas` to read the current scale; \
                pass an integer to set it. Returns `{ replicas, ready_replicas }` from the scale \
                status."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_version": { "type": "string", "description": "e.g. `apps/v1`." },
                    "kind": { "type": "string", "description": "Deployment / StatefulSet / ReplicaSet / ReplicationController." },
                    "namespace": { "type": "string" },
                    "name": { "type": "string" },
                    "replicas": { "type": "integer", "minimum": 0, "description": "Omit to read; set to update." }
                },
                "required": ["api_version", "kind", "namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        // Read when replicas is None, Write when set. We can't know per-call
        // without parsing args here, so report the worst case (Write) and let
        // the approval flow decide. The model can use fs_resources_get / list
        // for true reads.
        ToolCategory::Write
    }

    fn timeout(&self) -> Option<Duration> {
        Some(SCALE_TIMEOUT)
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: ScaleArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;
        let (ar, caps) = resolve_gvk(&client, &a.api_version, &a.kind).await?;
        if !matches!(caps.scope, discovery::Scope::Namespaced) {
            return Err(NativeToolError::msg(
                "scale subresource is only valid on namespaced kinds",
            ));
        }
        let plural = ar.plural.as_str();
        let group = ar.group.as_str();
        let version = ar.version.as_str();

        let path = if group.is_empty() {
            format!(
                "/api/{version}/namespaces/{ns}/{plural}/{name}/scale",
                ns = a.namespace,
                name = a.name,
            )
        } else {
            format!(
                "/apis/{group}/{version}/namespaces/{ns}/{plural}/{name}/scale",
                ns = a.namespace,
                name = a.name,
            )
        };

        if let Some(replicas) = a.replicas {
            // SSA-style patch onto the scale subresource. Using `application/
            // apply-patch+yaml` so the same field manager carries through.
            let patch = json!({
                "apiVersion": "autoscaling/v1",
                "kind": "Scale",
                "metadata": { "name": a.name, "namespace": a.namespace },
                "spec": { "replicas": replicas },
            });
            let body = serde_json::to_vec(&patch)
                .map_err(|e| NativeToolError::msg(format!("encode: {e}")))?;
            let req = Request::builder()
                .method("PATCH")
                .uri(format!("{path}?fieldManager={FIELD_MANAGER}&force=true"))
                .header("content-type", "application/apply-patch+yaml")
                .body(body)
                .map_err(|e| NativeToolError::msg(format!("request: {e}")))?;
            let resp: Value = client.request(req).await.map_err(kube_err)?;
            return Ok(scale_to_value(&a, &resp));
        }

        let req = Request::builder()
            .method("GET")
            .uri(&path)
            .header("accept", "application/json")
            .body(Vec::new())
            .map_err(|e| NativeToolError::msg(format!("request: {e}")))?;
        let resp: Value = client.request(req).await.map_err(kube_err)?;
        Ok(scale_to_value(&a, &resp))
    }
}

fn scale_to_value(a: &ScaleArgs, scale: &Value) -> Value {
    let spec_replicas = scale
        .get("spec")
        .and_then(|s| s.get("replicas"))
        .and_then(Value::as_i64);
    let status = scale.get("status");
    let status_replicas = status
        .and_then(|s| s.get("replicas"))
        .and_then(Value::as_i64);
    json!({
        "api_version": a.api_version,
        "kind": a.kind,
        "namespace": a.namespace,
        "name": a.name,
        "spec_replicas": spec_replicas,
        "status_replicas": status_replicas,
        "selector": status.and_then(|s| s.get("selector")).cloned(),
    })
}

// ─── fs_resources_apply (yaml/json) ──────────────────────────────────────────

pub(crate) struct ResourcesApply {
    app: AppHandle,
    cluster_id: String,
}

impl ResourcesApply {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ResourcesApply {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_apply".to_string(),
            description: "Server-Side Apply from a YAML or JSON manifest. Use this to create \
                brand-new objects (Deployment, Service, CRD instance, ConfigMap…) or to apply a \
                multi-doc manifest in one call. The manifest must include `apiVersion`, `kind`, \
                `metadata.name`, and `metadata.namespace` for namespaced kinds. Each doc is \
                applied independently — the result is a list of per-doc outcomes \
                (`applied` / `conflict` / `error`). Field manager is `ferrisscope` (same as \
                `fs_apply_resource` and the inline editor). Set `dry_run: true` to validate \
                without persisting; `force: true` only after a conflict has been surfaced and \
                operator confirms takeover."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "manifest": {
                        "type": "string",
                        "description": "Full YAML or JSON manifest. Multiple YAML docs separated by `---` are supported."
                    },
                    "dry_run": { "type": "boolean", "default": false },
                    "force": { "type": "boolean", "default": false }
                },
                "required": ["manifest"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: ApplyArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;
        let results = apply_yaml(client, &a.manifest, a.dry_run, a.force).await;
        Ok(json!({
            "dry_run": a.dry_run,
            "force": a.force,
            "results": results,
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

async fn resolve_gvk(
    client: &kube::Client,
    api_version: &str,
    kind: &str,
) -> Result<(kube::api::ApiResource, discovery::ApiCapabilities), NativeToolError> {
    let (group, version) = match api_version.split_once('/') {
        Some((g, v)) => (g.to_string(), v.to_string()),
        None => (String::new(), api_version.to_string()),
    };
    let gvk = GroupVersionKind::gvk(&group, &version, kind);
    discovery::pinned_kind(client, &gvk)
        .await
        .map_err(|e| NativeToolError::msg(format!("discover {api_version} {kind}: {e}")))
}

fn scope_label(s: discovery::Scope) -> &'static str {
    match s {
        discovery::Scope::Namespaced => "namespaced",
        discovery::Scope::Cluster => "cluster",
    }
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

/// Compact projection of any `DynamicObject` for list output. Carries the
/// metadata operators care about + any `status.phase` / `status.conditions`
/// that exist (most kinds have one or both).
fn project_dyn_row(obj: &DynamicObject) -> Value {
    let meta = &obj.metadata;
    let mut out = serde_json::Map::new();
    out.insert(
        "name".into(),
        Value::String(meta.name.clone().unwrap_or_default()),
    );
    if let Some(ns) = &meta.namespace {
        out.insert("namespace".into(), Value::String(ns.clone()));
    }
    if let Some(ts) = &meta.creation_timestamp {
        out.insert("created".into(), Value::String(ts.0.to_string()));
    }
    if let Some(labels) = &meta.labels {
        if !labels.is_empty() {
            out.insert(
                "labels".into(),
                Value::Object(
                    labels
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                        .collect(),
                ),
            );
        }
    }
    if let Some(status) = obj.data.get("status") {
        if let Some(phase) = status.get("phase") {
            out.insert("phase".into(), phase.clone());
        }
        if let Some(ready) = status.get("ready") {
            out.insert("ready".into(), ready.clone());
        }
        if let Some(replicas) = status.get("replicas") {
            out.insert("replicas".into(), replicas.clone());
        }
        if let Some(available) = status.get("availableReplicas") {
            out.insert("available_replicas".into(), available.clone());
        }
    }
    Value::Object(out)
}
