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

use std::collections::BTreeMap;
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

use crate::agent_native::{delete_outcome_json, ChatClusterRef};
use crate::state::AppState;

/// Default rows returned by `fs_resources_list` when the caller doesn't ask
/// for a `limit`. Conservative so a casual list against a busy cluster doesn't
/// dump thousands of objects into the transcript.
const DEFAULT_LIST_LIMIT: usize = 500;
/// Hard ceiling on the `limit` arg. Above this, narrow with selectors.
const MAX_LIST_HARD: usize = 10_000;
/// Apiserver page size when paginating — keeps each round-trip cheap; we loop
/// continue tokens until `limit` is filled or the server runs out of pages.
const LIST_PAGE_SIZE: u32 = 500;
/// Scale calls finish in one round-trip normally; with `verify` we sleep
/// `DRIFT_WAIT` then re-read, so the per-call budget is wider.
const SCALE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait before re-reading a scaled workload to see whether a
/// reconciler (Argo CD / Flux) reverted the change.
const DRIFT_WAIT: Duration = Duration::from_secs(2);

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
    /// Total rows to return. Default `DEFAULT_LIST_LIMIT`, max `MAX_LIST_HARD`.
    /// Backed by apiserver pagination — values above one page trigger multiple
    /// GETs internally.
    #[serde(default)]
    limit: Option<usize>,
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
    /// After setting replicas, wait briefly and re-read the workload to detect
    /// a GitOps controller reverting the change. Adds ~`DRIFT_WAIT` latency;
    /// ignored on read-only calls.
    #[serde(default)]
    verify: bool,
}

/// How `fs_resources_apply` mutates the object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
enum ApplyMode {
    /// Server-Side Apply from a full `manifest`. The default.
    #[default]
    ServerSideApply,
    /// RFC 7386 JSON merge patch (`application/merge-patch+json`). Set a field
    /// to `null` to delete it — this is how you clear `metadata.finalizers`.
    MergePatch,
    /// RFC 6902 JSON patch (`application/json-patch+json`) — an array of ops.
    JsonPatch,
}

#[derive(Debug, Deserialize)]
struct ApplyArgs {
    #[serde(default)]
    mode: ApplyMode,
    /// SSA only: YAML or JSON document(s). Multi-doc YAML (separated by `---`)
    /// is supported; each doc is applied independently with per-doc results.
    #[serde(default)]
    manifest: Option<String>,
    /// Patch modes: target object coordinates.
    #[serde(default)]
    api_version: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Patch modes: merge_patch → an object; json_patch → an array of ops.
    #[serde(default)]
    patch: Option<Value>,
    #[serde(default)]
    dry_run: bool,
    /// SSA only — take ownership of conflicting fields. Ignored by patch modes.
    #[serde(default)]
    force: bool,
}

// ─── fs_resources_list ───────────────────────────────────────────────────────

pub(crate) struct ResourcesList {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ResourcesList {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
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
                projection (name, namespace, age, top-level status fields). Objects mid-deletion \
                carry `deleting: true` plus `deletion_timestamp` and `finalizers` so stuck \
                terminations are visible without a follow-up get. Default limit is 500 rows; \
                pass `limit` (max 10000) for bigger lists — pagination is handled internally. \
                When `truncated: true` either bump `limit` or refine selectors."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_version": { "type": "string", "description": "e.g. `v1`, `apps/v1`, `networking.k8s.io/v1`." },
                    "kind": { "type": "string", "description": "PascalCase kind, e.g. `Pod`, `Deployment`, `Ingress`." },
                    "namespace": { "type": "string" },
                    "label_selector": { "type": "string" },
                    "field_selector": { "type": "string" },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 10000,
                        "description": "Total rows. Default 500, max 10000. Above one page triggers internal pagination."
                    }
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
        let client = client_for(&self.app, &self.cluster).await?;
        let (ar, caps) = resolve_gvk(&client, &a.api_version, &a.kind).await?;

        let api: Api<DynamicObject> = match caps.scope {
            discovery::Scope::Namespaced => match a.namespace.as_deref() {
                Some(ns) if !ns.is_empty() => Api::namespaced_with(client, ns, &ar),
                _ => Api::all_with(client, &ar),
            },
            discovery::Scope::Cluster => Api::all_with(client, &ar),
        };

        let limit = a
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .clamp(1, MAX_LIST_HARD);

        // Paginate via the apiserver's `continue` token until we've filled
        // `limit` or the server runs out of pages. A single `.limit(500)` page
        // (the old behaviour) stopped at the first chunk and reported
        // `truncated` without any way to fetch the rest — mirror fs_pods_list
        // so the model can actually reach every object by bumping `limit`.
        let mut rows: Vec<DynamicObject> = Vec::with_capacity(limit.min(1024));
        let mut continue_token: Option<String> = None;
        let truncated;
        loop {
            let remaining = limit.saturating_sub(rows.len());
            if remaining == 0 {
                // Hit the cap. If the previous page still had a token there's
                // more on the server — report truncated so the model can bump.
                truncated = continue_token.is_some();
                break;
            }
            let page_size = u32::try_from(remaining)
                .unwrap_or(LIST_PAGE_SIZE)
                .min(LIST_PAGE_SIZE);
            let mut lp = ListParams::default().limit(page_size);
            if let Some(s) = a.label_selector.as_deref() {
                lp = lp.labels(s);
            }
            if let Some(s) = a.field_selector.as_deref() {
                lp = lp.fields(s);
            }
            if let Some(tok) = continue_token.as_deref() {
                lp = lp.continue_token(tok);
            }
            let list = api.list(&lp).await.map_err(kube_err)?;
            rows.extend(list.items);
            match list.metadata.continue_.as_deref() {
                Some(t) if !t.is_empty() => continue_token = Some(t.to_string()),
                _ => {
                    // Server has no more pages — we got everything.
                    truncated = false;
                    break;
                }
            }
        }

        let items: Vec<Value> = rows.iter().map(project_dyn_row).collect();
        Ok(json!({
            "api_version": a.api_version,
            "kind": a.kind,
            "scope": scope_label(caps.scope),
            "count": items.len(),
            "limit": limit,
            "limit_max": MAX_LIST_HARD,
            "truncated": truncated,
            "items": items,
        }))
    }
}

// ─── fs_resources_get ────────────────────────────────────────────────────────

pub(crate) struct ResourcesGet {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ResourcesGet {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
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
        let client = client_for(&self.app, &self.cluster).await?;
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
    cluster: ChatClusterRef,
}

impl ResourcesDelete {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
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
                a thinner wrapper. Result distinguishes `actually_deleted` from \
                `still_exists` — an object held open by finalizers reports \
                `still_exists: true` with `remaining_finalizers` and a `deletion_timestamp`, not \
                a misleading success. To clear blocking finalizers use `fs_resources_apply` with \
                `mode: merge_patch` and `patch: {\"metadata\":{\"finalizers\":null}}` (only when \
                the owning controller is gone — see that tool's warning)."
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
        let client = client_for(&self.app, &self.cluster).await?;
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
        // `delete` returns the object (Left) when termination is accepted but
        // not complete — finalizers or grace period — and a Status (Right)
        // when it's gone. Surface the difference instead of a flat success.
        let outcome = api.delete(&a.name, &dp).await.map_err(kube_err)?;
        let mut out = delete_outcome_json(outcome.left().as_ref().map(|obj| &obj.metadata));
        let obj = out
            .as_object_mut()
            .expect("delete_outcome_json returns object");
        obj.insert("api_version".into(), json!(a.api_version));
        obj.insert("kind".into(), json!(a.kind));
        obj.insert("namespace".into(), json!(a.namespace));
        obj.insert("name".into(), json!(a.name));
        Ok(out)
    }
}

// ─── fs_resources_scale ──────────────────────────────────────────────────────

pub(crate) struct ResourcesScale {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ResourcesScale {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for ResourcesScale {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_scale".to_string(),
            description: "Read or update the `scale` subresource on a Deployment / StatefulSet / \
                ReplicaSet / ReplicationController. Omit `replicas` to read the current scale; \
                pass an integer to set it. Returns `{ spec_replicas, status_replicas, selector }` \
                from the scale subresource. Pass `verify: true` when setting replicas to re-read \
                the workload after a moment — if a GitOps controller (Argo CD / Flux) reverts the \
                change you'll get `drift_detected: true` plus `current_spec_replicas` and a \
                `possible_reconciler` / `tracking_id` hint so you stop fighting the controller \
                and fix it at the source instead."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_version": { "type": "string", "description": "e.g. `apps/v1`." },
                    "kind": { "type": "string", "description": "Deployment / StatefulSet / ReplicaSet / ReplicationController." },
                    "namespace": { "type": "string" },
                    "name": { "type": "string" },
                    "replicas": { "type": "integer", "minimum": 0, "description": "Omit to read; set to update." },
                    "verify": { "type": "boolean", "default": false, "description": "After setting replicas, wait ~2s and re-read to detect GitOps drift." }
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
        let client = client_for(&self.app, &self.cluster).await?;
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
            let mut out = scale_to_value(&a, &resp);

            if a.verify {
                tokio::time::sleep(DRIFT_WAIT).await;
                // Re-read the parent object: its `spec.replicas` tells us
                // whether the value stuck, and its annotations name the
                // reconciler if one reverted us.
                let api: Api<DynamicObject> = Api::namespaced_with(client, &a.namespace, &ar);
                if let Ok(obj) = api.get(&a.name).await {
                    let current = obj
                        .data
                        .get("spec")
                        .and_then(|s| s.get("replicas"))
                        .and_then(Value::as_i64);
                    let map = out.as_object_mut().expect("scale_to_value object");
                    map.insert("requested_replicas".into(), json!(replicas));
                    map.insert("current_spec_replicas".into(), json!(current));
                    map.insert(
                        "drift_detected".into(),
                        json!(current.is_some_and(|c| c != i64::from(replicas))),
                    );
                    if let Some((reconciler, id)) = obj
                        .metadata
                        .annotations
                        .as_ref()
                        .and_then(detect_reconciler)
                    {
                        map.insert("possible_reconciler".into(), json!(reconciler));
                        if let Some(id) = id {
                            map.insert("tracking_id".into(), json!(id));
                        }
                    }
                }
            }
            return Ok(out);
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
    cluster: ChatClusterRef,
}

impl ResourcesApply {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for ResourcesApply {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_resources_apply".to_string(),
            description: "Write to any resource. `mode` selects how:\n\
                • `server_side_apply` (default) — SSA from a full `manifest` (YAML/JSON, \
                multi-doc via `---`). Use to create or declaratively own objects. The manifest \
                must include apiVersion / kind / metadata.name (+ namespace for namespaced \
                kinds). Returns per-doc `applied` / `conflict` / `error`. `force: true` only \
                after a conflict has been surfaced and the operator confirms takeover.\n\
                • `merge_patch` — RFC 7386 JSON merge patch. Pass `api_version` / `kind` / \
                `name` (+ `namespace`) and a `patch` object. Set a field to `null` to remove it. \
                This is the reliable way to clear stuck finalizers: \
                `patch: {\"metadata\":{\"finalizers\":null}}`.\n\
                • `json_patch` — RFC 6902. Same coordinates; `patch` is an array of ops, e.g. \
                `[{\"op\":\"remove\",\"path\":\"/metadata/finalizers\"}]` (note: `remove` fails \
                if the path is already absent — prefer merge_patch for finalizers).\n\
                ⚠️ Removing finalizers force-completes a deletion and can orphan external \
                resources (cloud LBs, volumes, DNS) or skip a controller's cleanup. Only do it \
                when the owning controller is confirmed gone or broken; otherwise fix the \
                controller. Field manager is `ferrisscope`. `dry_run: true` validates without \
                persisting."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": ["server_side_apply", "merge_patch", "json_patch"],
                        "default": "server_side_apply"
                    },
                    "manifest": {
                        "type": "string",
                        "description": "server_side_apply only. Full YAML or JSON manifest; multiple docs separated by `---`."
                    },
                    "api_version": { "type": "string", "description": "Patch modes. e.g. `apps/v1`, `keda.sh/v1alpha1`." },
                    "kind": { "type": "string", "description": "Patch modes. PascalCase kind." },
                    "namespace": { "type": "string", "description": "Patch modes. Required for namespaced kinds." },
                    "name": { "type": "string", "description": "Patch modes. Object name." },
                    "patch": {
                        "description": "Patch modes. merge_patch → object; json_patch → array of ops.",
                        "type": ["object", "array"]
                    },
                    "dry_run": { "type": "boolean", "default": false },
                    "force": { "type": "boolean", "default": false, "description": "server_side_apply only." }
                },
                "required": [],
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
        let client = client_for(&self.app, &self.cluster).await?;

        match a.mode {
            ApplyMode::ServerSideApply => {
                let manifest = a.manifest.as_deref().ok_or_else(|| {
                    NativeToolError::msg("`manifest` is required for mode server_side_apply")
                })?;
                let results = apply_yaml(client, manifest, a.dry_run, a.force).await;
                Ok(json!({
                    "mode": "server_side_apply",
                    "dry_run": a.dry_run,
                    "force": a.force,
                    "results": results,
                }))
            }
            ApplyMode::MergePatch | ApplyMode::JsonPatch => {
                let api_version = a.api_version.as_deref().ok_or_else(|| {
                    NativeToolError::msg("`api_version` is required for patch modes")
                })?;
                let kind = a
                    .kind
                    .as_deref()
                    .ok_or_else(|| NativeToolError::msg("`kind` is required for patch modes"))?;
                let name = a
                    .name
                    .as_deref()
                    .ok_or_else(|| NativeToolError::msg("`name` is required for patch modes"))?;
                let patch = a
                    .patch
                    .as_ref()
                    .ok_or_else(|| NativeToolError::msg("`patch` is required for patch modes"))?;
                validate_patch_body(a.mode, patch).map_err(NativeToolError::msg)?;

                let (ar, caps) = resolve_gvk(&client, api_version, kind).await?;
                let namespace = match caps.scope {
                    discovery::Scope::Namespaced => {
                        Some(a.namespace.as_deref().ok_or_else(|| {
                            NativeToolError::msg(format!(
                                "namespace required for namespaced kind {kind}"
                            ))
                        })?)
                    }
                    discovery::Scope::Cluster => None,
                };
                let path = patch_path(
                    ar.group.as_str(),
                    ar.version.as_str(),
                    ar.plural.as_str(),
                    namespace,
                    name,
                    a.dry_run,
                );
                let body = serde_json::to_vec(patch)
                    .map_err(|e| NativeToolError::msg(format!("encode patch: {e}")))?;
                let req = Request::builder()
                    .method("PATCH")
                    .uri(&path)
                    .header("content-type", patch_content_type(a.mode))
                    .header("accept", "application/json")
                    .body(body)
                    .map_err(|e| NativeToolError::msg(format!("request: {e}")))?;
                let resp: Value = client.request(req).await.map_err(kube_err)?;
                Ok(patch_result_json(
                    a.mode,
                    api_version,
                    kind,
                    namespace,
                    name,
                    a.dry_run,
                    &resp,
                ))
            }
        }
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

/// Wire content-type for each patch mode.
fn patch_content_type(mode: ApplyMode) -> &'static str {
    match mode {
        ApplyMode::MergePatch => "application/merge-patch+json",
        ApplyMode::JsonPatch => "application/json-patch+json",
        // SSA never reaches here (it goes through apply_yaml), but a sane
        // default keeps the fn total.
        ApplyMode::ServerSideApply => "application/apply-patch+yaml",
    }
}

/// REST path for a PATCH against a resource, with the field-manager (and
/// optional dry-run) query attached. Mirrors how the scale tool builds its
/// subresource path.
fn patch_path(
    group: &str,
    version: &str,
    plural: &str,
    namespace: Option<&str>,
    name: &str,
    dry_run: bool,
) -> String {
    let base = match (group.is_empty(), namespace) {
        (true, Some(ns)) => format!("/api/{version}/namespaces/{ns}/{plural}/{name}"),
        (true, None) => format!("/api/{version}/{plural}/{name}"),
        (false, Some(ns)) => format!("/apis/{group}/{version}/namespaces/{ns}/{plural}/{name}"),
        (false, None) => format!("/apis/{group}/{version}/{plural}/{name}"),
    };
    if dry_run {
        format!("{base}?fieldManager={FIELD_MANAGER}&dryRun=All")
    } else {
        format!("{base}?fieldManager={FIELD_MANAGER}")
    }
}

/// Shape-check the patch body before we hit the apiserver: merge patches must
/// be an object, JSON patches a non-empty array. Catches the common LLM mixup
/// (sending an ops array as merge_patch, or an object as json_patch) with a
/// clear message instead of an opaque 422.
fn validate_patch_body(mode: ApplyMode, patch: &Value) -> Result<(), String> {
    match mode {
        ApplyMode::MergePatch => {
            if patch.is_object() {
                Ok(())
            } else {
                Err("merge_patch `patch` must be a JSON object".to_string())
            }
        }
        ApplyMode::JsonPatch => match patch.as_array() {
            Some(ops) if !ops.is_empty() => Ok(()),
            Some(_) => Err("json_patch `patch` array is empty".to_string()),
            None => Err("json_patch `patch` must be a JSON array of operations".to_string()),
        },
        ApplyMode::ServerSideApply => Ok(()),
    }
}

/// Summarise the apiserver's response to a patch. Surfaces resourceVersion
/// plus the finalizer/deletion state so a finalizer-clearing patch can be
/// confirmed (`remaining_finalizers: []`) in the same call.
fn patch_result_json(
    mode: ApplyMode,
    api_version: &str,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
    dry_run: bool,
    resp: &Value,
) -> Value {
    let mode_str = match mode {
        ApplyMode::MergePatch => "merge_patch",
        ApplyMode::JsonPatch => "json_patch",
        ApplyMode::ServerSideApply => "server_side_apply",
    };
    let meta = resp.get("metadata");
    let resource_version = meta
        .and_then(|m| m.get("resourceVersion"))
        .and_then(Value::as_str);
    let finalizers = meta
        .and_then(|m| m.get("finalizers"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let deletion_timestamp = meta.and_then(|m| m.get("deletionTimestamp")).cloned();
    json!({
        "mode": mode_str,
        "api_version": api_version,
        "kind": kind,
        "namespace": namespace,
        "name": name,
        "patched": true,
        "dry_run": dry_run,
        "resource_version": resource_version,
        "remaining_finalizers": finalizers,
        "deletion_timestamp": deletion_timestamp,
    })
}

/// Best-effort: name the GitOps controller that owns an object from its
/// annotations, so a drift report can point at the source instead of just
/// saying "something reverted you". Returns `(reconciler, tracking_id)`.
fn detect_reconciler(
    annotations: &BTreeMap<String, String>,
) -> Option<(&'static str, Option<String>)> {
    if let Some(id) = annotations.get("argocd.argoproj.io/tracking-id") {
        return Some(("Argo CD", Some(id.clone())));
    }
    if annotations.keys().any(|k| {
        k.starts_with("kustomize.toolkit.fluxcd.io/") || k.starts_with("helm.toolkit.fluxcd.io/")
    }) {
        let id = annotations
            .get("kustomize.toolkit.fluxcd.io/name")
            .or_else(|| annotations.get("helm.toolkit.fluxcd.io/name"))
            .cloned();
        return Some(("Flux", id));
    }
    if let Some(release) = annotations.get("meta.helm.sh/release-name") {
        return Some(("Helm", Some(release.clone())));
    }
    None
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
    // Surface termination state so stuck deletions are visible in the list
    // itself — operators hunting "why won't this namespace empty out" don't
    // have to get each object to see the finalizers holding it open.
    if let Some(ts) = &meta.deletion_timestamp {
        out.insert("deleting".into(), Value::Bool(true));
        // `Time` wraps a `jiff::Timestamp` whose Display is RFC 3339.
        out.insert("deletion_timestamp".into(), Value::String(ts.0.to_string()));
    }
    if let Some(finalizers) = &meta.finalizers {
        if !finalizers.is_empty() {
            out.insert(
                "finalizers".into(),
                Value::Array(finalizers.iter().cloned().map(Value::String).collect()),
            );
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_mode_defaults_to_ssa() {
        // Bare args (no `mode`) must parse as SSA so existing manifest-only
        // calls keep working.
        let a: ApplyArgs = serde_json::from_value(json!({ "manifest": "x" })).unwrap();
        assert_eq!(a.mode, ApplyMode::ServerSideApply);
    }

    #[test]
    fn apply_mode_parses_patch_variants() {
        let merge: ApplyArgs = serde_json::from_value(json!({ "mode": "merge_patch" })).unwrap();
        assert_eq!(merge.mode, ApplyMode::MergePatch);
        let jsonp: ApplyArgs = serde_json::from_value(json!({ "mode": "json_patch" })).unwrap();
        assert_eq!(jsonp.mode, ApplyMode::JsonPatch);
    }

    #[test]
    fn content_type_per_mode() {
        assert_eq!(
            patch_content_type(ApplyMode::MergePatch),
            "application/merge-patch+json"
        );
        assert_eq!(
            patch_content_type(ApplyMode::JsonPatch),
            "application/json-patch+json"
        );
    }

    #[test]
    fn patch_path_namespaced_and_cluster_and_core() {
        // CRD, namespaced.
        assert_eq!(
            patch_path("keda.sh", "v1alpha1", "scaledobjects", Some("ns"), "envoy", false),
            format!("/apis/keda.sh/v1alpha1/namespaces/ns/scaledobjects/envoy?fieldManager={FIELD_MANAGER}")
        );
        // Cluster-scoped (no namespace).
        assert_eq!(
            patch_path("rbac.authorization.k8s.io", "v1", "clusterroles", None, "admin", false),
            format!("/apis/rbac.authorization.k8s.io/v1/clusterroles/admin?fieldManager={FIELD_MANAGER}")
        );
        // Core group → /api, and dry-run query appended.
        assert_eq!(
            patch_path("", "v1", "configmaps", Some("default"), "cm", true),
            format!(
                "/api/v1/namespaces/default/configmaps/cm?fieldManager={FIELD_MANAGER}&dryRun=All"
            )
        );
    }

    #[test]
    fn validate_patch_body_enforces_shape() {
        // merge wants an object; an array is the classic mixup.
        assert!(validate_patch_body(
            ApplyMode::MergePatch,
            &json!({"metadata": {"finalizers": null}})
        )
        .is_ok());
        assert!(validate_patch_body(ApplyMode::MergePatch, &json!([])).is_err());
        // json wants a non-empty array.
        assert!(validate_patch_body(
            ApplyMode::JsonPatch,
            &json!([{ "op": "remove", "path": "/metadata/finalizers" }])
        )
        .is_ok());
        assert!(validate_patch_body(ApplyMode::JsonPatch, &json!([])).is_err());
        assert!(validate_patch_body(ApplyMode::JsonPatch, &json!({})).is_err());
    }

    #[test]
    fn patch_result_confirms_finalizers_cleared() {
        // After a finalizer-clearing merge patch the apiserver echoes the
        // object with no finalizers — the model should be able to confirm it.
        let resp = json!({
            "metadata": { "name": "envoy", "resourceVersion": "12345" }
        });
        let out = patch_result_json(
            ApplyMode::MergePatch,
            "keda.sh/v1alpha1",
            "ScaledObject",
            Some("ns"),
            "envoy",
            false,
            &resp,
        );
        assert_eq!(out["mode"], "merge_patch");
        assert_eq!(out["patched"], true);
        assert_eq!(out["resource_version"], "12345");
        assert_eq!(out["remaining_finalizers"].as_array().unwrap().len(), 0);
        assert!(out["deletion_timestamp"].is_null());
    }

    #[test]
    fn detect_reconciler_recognises_owners() {
        let mut argo = BTreeMap::new();
        argo.insert(
            "argocd.argoproj.io/tracking-id".to_string(),
            "keda:apps/Deployment:keda/keda-operator".to_string(),
        );
        assert_eq!(
            detect_reconciler(&argo),
            Some((
                "Argo CD",
                Some("keda:apps/Deployment:keda/keda-operator".to_string())
            ))
        );

        let mut flux = BTreeMap::new();
        flux.insert(
            "kustomize.toolkit.fluxcd.io/name".to_string(),
            "apps".to_string(),
        );
        assert_eq!(
            detect_reconciler(&flux),
            Some(("Flux", Some("apps".to_string())))
        );

        let mut helm = BTreeMap::new();
        helm.insert("meta.helm.sh/release-name".to_string(), "redis".to_string());
        assert_eq!(
            detect_reconciler(&helm),
            Some(("Helm", Some("redis".to_string())))
        );

        assert_eq!(detect_reconciler(&BTreeMap::new()), None);
    }

    #[test]
    fn project_row_surfaces_terminating_state() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "keda.sh/v1alpha1",
            "kind": "ScaledObject",
            "metadata": {
                "name": "envoy",
                "namespace": "ns",
                "deletionTimestamp": "2026-05-15T21:01:38Z",
                "finalizers": ["finalizer.keda.sh"]
            }
        }))
        .unwrap();
        let row = project_dyn_row(&obj);
        assert_eq!(row["name"], "envoy");
        assert_eq!(row["deleting"], true);
        assert_eq!(row["deletion_timestamp"], "2026-05-15T21:01:38Z");
        assert_eq!(row["finalizers"][0], "finalizer.keda.sh");
    }

    #[test]
    fn project_row_omits_termination_fields_when_alive() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "cm", "namespace": "ns" }
        }))
        .unwrap();
        let row = project_dyn_row(&obj);
        assert!(row.get("deleting").is_none());
        assert!(row.get("finalizers").is_none());
    }
}
