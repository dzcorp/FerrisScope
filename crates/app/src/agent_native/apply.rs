//! `fs_apply_resource` — Server-Side Apply from the agent.
//!
//! The agent can diagnose without this tool but it can't actually *fix*
//! anything. With it, the model can patch labels/annotations, change a
//! replica count, fix an image, set resource limits — gated by the
//! per-tool approval flow so the operator stays in the loop.
//!
//! Wraps the existing [`ferrisscope_kube_ext::apply_resource`] helper that
//! the inline-edit kit (ConfigMap / Secret / labels / etc.) already uses.
//! Field-manager is the same `ferrisscope` constant — applies from the
//! agent merge with applies from the inline editor instead of fighting
//! over field ownership.
//!
//! `force` defaults to false: a 409 conflict comes back as a structured
//! `ApplyResult::Conflict` so the model can decide whether to retry with
//! `force: true` (and the operator's approval). Never default to force —
//! that's how SSA's whole-point of per-field ownership tracking gets lost.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_kube_ext::apply_resource;
use kube::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct Args {
    /// Registry id, e.g. `deployments`, `configmaps`, `services`. The same
    /// id the inline-edit kit uses internally; not the Kubernetes `kind`
    /// PascalCase name. Browse `fs_workload_summary` / similar tools'
    /// outputs to see the canonical form for less-common kinds.
    kind_id: String,
    /// `None` for cluster-scoped kinds.
    #[serde(default)]
    namespace: Option<String>,
    name: String,
    /// Partial object — just the field tree the apply should own. The
    /// helper attaches `apiVersion` / `kind` / `metadata.name` / `namespace`
    /// itself so the model only sends what it actually wants to change
    /// (e.g. `{"spec": {"replicas": 5}}`, `{"metadata": {"labels": {...}}}`).
    fields: Value,
    /// Take ownership of fields currently owned by another manager. Default
    /// false; a 409 returns ApplyResult::Conflict and the agent should
    /// surface it to the operator before retrying with force.
    #[serde(default)]
    force: bool,
}

pub(crate) struct ApplyResource {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ApplyResource {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for ApplyResource {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_apply_resource".into(),
            description: "Server-Side Apply (kubectl apply --server-side equivalent). \
                Pass the partial object tree to own under `fields` — DO NOT include \
                apiVersion / kind / metadata.name / metadata.namespace (the tool \
                attaches those from kind_id / name / namespace itself). Returns \
                `{kind:\"applied\"}` or `{kind:\"conflict\", managers, fields, message}`. \
                Set force:true only after the operator confirms a conflict was \
                expected — that takes ownership of fields from the other manager. \
                Examples — scale a Deployment to 3: \
                `{\"kind_id\":\"deployments\", \"namespace\":\"prod\", \
                \"name\":\"api\", \"fields\":{\"spec\":{\"replicas\":3}}}`. \
                Update labels: `{\"kind_id\":\"pods\", \"namespace\":\"default\", \
                \"name\":\"api-abc\", \
                \"fields\":{\"metadata\":{\"labels\":{\"team\":\"platform\"}}}}`. \
                Edit ConfigMap data: `{\"kind_id\":\"configmaps\", ..., \
                \"fields\":{\"data\":{\"key\":\"value\"}}}`."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind_id": {
                        "type": "string",
                        "description": "Registry id, lowercase plural — e.g. `deployments`, `configmaps`, `services`, `pods`, `statefulsets`, `daemonsets`, `secrets`, `ingresses`, `namespaces`."
                    },
                    "namespace": {
                        "type": "string",
                        "description": "Namespace. Omit for cluster-scoped kinds (Namespace, ClusterRole, PV, …)."
                    },
                    "name": { "type": "string" },
                    "fields": {
                        "type": "object",
                        "description": "Partial object — ONLY the field tree to own. Do NOT include apiVersion / kind / metadata.name / metadata.namespace; the tool injects them. Common shapes: `{\"spec\":{\"replicas\":N}}`, `{\"metadata\":{\"labels\":{...}}}`, `{\"metadata\":{\"annotations\":{...}}}`, `{\"data\":{...}}` (ConfigMap/Secret), `{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"x\",\"image\":\"...\"}]}}}}` (workload image bump)."
                    },
                    "force": {
                        "type": "boolean",
                        "default": false,
                        "description": "Take ownership of fields owned by another manager. Default false; first call should be force=false so conflicts surface as ApplyResult::Conflict."
                    }
                },
                "required": ["kind_id", "name", "fields"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let result = apply_resource(
            client,
            &a.kind_id,
            a.namespace.as_deref(),
            &a.name,
            a.fields,
            a.force,
        )
        .await
        .map_err(|e| NativeToolError::msg(format!("apply: {e}")))?;
        // ApplyResult is already serde-tagged with `kind: applied|conflict`,
        // so a single to_value gives the model a clean discriminated shape.
        serde_json::to_value(result)
            .map_err(|e| NativeToolError::msg(format!("serialize result: {e}")))
    }
}

async fn client_for(app: &AppHandle, cluster: &ChatClusterRef) -> Result<Client, NativeToolError> {
    let id = cluster.active().await;
    let state = app.state::<AppState>();
    let entry = state
        .entry(&id)
        .await
        .map_err(|e| NativeToolError::msg(format!("connect cluster: {e}")))?;
    Ok(entry.cluster.client())
}
