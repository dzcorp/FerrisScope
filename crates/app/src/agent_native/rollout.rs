//! `fs_rollout_status` — one-shot rollout snapshot.
//!
//! `kubectl rollout status` semantics squashed into a single tool result. The
//! agent's natural pattern is "apply → wait → check", and without this it
//! ends up tight-looping `fs_pod_diagnose` against every replica which is
//! both noisy and incomplete (the rollout has its own conditions and
//! generation-vs-observed sync that pod-level diagnosis doesn't surface).
//!
//! Snapshot-only — the tool returns immediately. The agent pairs it with
//! `fs_pause` to poll: the explicit cadence keeps the model's attention on
//! the right thing and avoids burning the per-tool budget on a single call
//! that might wait minutes.
//!
//! Supported kinds: Deployment, StatefulSet, DaemonSet. ReplicaSet rollouts
//! are managed by the parent Deployment so we don't expose them directly;
//! Jobs / CronJobs use `fs_workload_summary` instead (different lifecycle).

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use kube::{Api, Client};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct Args {
    /// `Deployment` | `StatefulSet` | `DaemonSet`. Case-insensitive.
    kind: String,
    namespace: String,
    name: String,
}

pub(crate) struct RolloutStatus {
    app: AppHandle,
    cluster_id: String,
}

impl RolloutStatus {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for RolloutStatus {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_rollout_status".into(),
            description: "Snapshot a Deployment / StatefulSet / DaemonSet rollout: \
                replicas (desired/updated/ready/available), generation vs \
                observedGeneration, conditions, and a single `ready` boolean \
                meaning the rollout has fully landed. Pair with fs_pause to poll \
                until ready=true."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["Deployment", "StatefulSet", "DaemonSet"] },
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["kind", "namespace", "name"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;
        match a.kind.to_lowercase().as_str() {
            "deployment" => deploy_status(&client, &a.namespace, &a.name).await,
            "statefulset" => sts_status(&client, &a.namespace, &a.name).await,
            "daemonset" => ds_status(&client, &a.namespace, &a.name).await,
            other => Err(NativeToolError::msg(format!("unsupported kind: {other}"))),
        }
    }
}

async fn deploy_status(client: &Client, ns: &str, name: &str) -> Result<Value, NativeToolError> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let d = api
        .get(name)
        .await
        .map_err(|e| NativeToolError::msg(format!("get deployment: {e}")))?;
    let spec_replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let s = d.status.as_ref();
    let replicas = s.and_then(|x| x.replicas).unwrap_or(0);
    let updated = s.and_then(|x| x.updated_replicas).unwrap_or(0);
    let ready = s.and_then(|x| x.ready_replicas).unwrap_or(0);
    let available = s.and_then(|x| x.available_replicas).unwrap_or(0);
    let unavailable = s.and_then(|x| x.unavailable_replicas).unwrap_or(0);
    let observed = s.and_then(|x| x.observed_generation).unwrap_or(-1);
    let generation = d.metadata.generation.unwrap_or(0);
    // Mirrors `kubectl rollout status deployment/<x>`: spec generation must
    // be observed, all desired replicas updated + available, and the
    // outgoing rs (if any) drained.
    let is_ready = observed >= generation
        && updated >= spec_replicas
        && available >= spec_replicas
        && replicas == updated
        && unavailable == 0;
    Ok(json!({
        "kind": "Deployment",
        "namespace": ns,
        "name": name,
        "ready": is_ready,
        "generation": generation,
        "observed_generation": observed,
        "spec_replicas": spec_replicas,
        "replicas": replicas,
        "updated": updated,
        "ready_replicas": ready,
        "available": available,
        "unavailable": unavailable,
        "conditions": conditions_value(s.and_then(|x| x.conditions.as_ref())),
    }))
}

async fn sts_status(client: &Client, ns: &str, name: &str) -> Result<Value, NativeToolError> {
    let api: Api<StatefulSet> = Api::namespaced(client.clone(), ns);
    let s = api
        .get(name)
        .await
        .map_err(|e| NativeToolError::msg(format!("get statefulset: {e}")))?;
    let spec_replicas = s.spec.as_ref().and_then(|x| x.replicas).unwrap_or(0);
    let st = s.status.as_ref();
    let replicas = st.map(|x| x.replicas).unwrap_or(0);
    let ready_replicas = st.and_then(|x| x.ready_replicas).unwrap_or(0);
    let current = st.and_then(|x| x.current_replicas).unwrap_or(0);
    let updated = st.and_then(|x| x.updated_replicas).unwrap_or(0);
    let observed = st.and_then(|x| x.observed_generation).unwrap_or(-1);
    let generation = s.metadata.generation.unwrap_or(0);
    let current_rev = st.and_then(|x| x.current_revision.clone());
    let update_rev = st.and_then(|x| x.update_revision.clone());
    // RollingUpdate strategy: the rollout has landed when current_revision
    // matches update_revision and replicas are all ready+updated.
    let is_ready = observed >= generation
        && replicas == spec_replicas
        && ready_replicas == spec_replicas
        && updated == spec_replicas
        && current == spec_replicas
        && current_rev == update_rev;
    Ok(json!({
        "kind": "StatefulSet",
        "namespace": ns,
        "name": name,
        "ready": is_ready,
        "generation": generation,
        "observed_generation": observed,
        "spec_replicas": spec_replicas,
        "replicas": replicas,
        "ready_replicas": ready_replicas,
        "current_replicas": current,
        "updated_replicas": updated,
        "current_revision": current_rev,
        "update_revision": update_rev,
        "conditions": conditions_value(st.and_then(|x| x.conditions.as_ref())),
    }))
}

async fn ds_status(client: &Client, ns: &str, name: &str) -> Result<Value, NativeToolError> {
    let api: Api<DaemonSet> = Api::namespaced(client.clone(), ns);
    let d = api
        .get(name)
        .await
        .map_err(|e| NativeToolError::msg(format!("get daemonset: {e}")))?;
    let st = d.status.as_ref();
    let desired = st.map(|x| x.desired_number_scheduled).unwrap_or(0);
    let current = st.map(|x| x.current_number_scheduled).unwrap_or(0);
    let ready = st.map(|x| x.number_ready).unwrap_or(0);
    let available = st.and_then(|x| x.number_available).unwrap_or(0);
    let updated = st.and_then(|x| x.updated_number_scheduled).unwrap_or(0);
    let misscheduled = st.map(|x| x.number_misscheduled).unwrap_or(0);
    let observed = st.and_then(|x| x.observed_generation).unwrap_or(-1);
    let generation = d.metadata.generation.unwrap_or(0);
    let is_ready = observed >= generation
        && current == desired
        && ready == desired
        && available == desired
        && updated == desired
        && misscheduled == 0;
    Ok(json!({
        "kind": "DaemonSet",
        "namespace": ns,
        "name": name,
        "ready": is_ready,
        "generation": generation,
        "observed_generation": observed,
        "desired": desired,
        "current": current,
        "ready_count": ready,
        "available": available,
        "updated": updated,
        "misscheduled": misscheduled,
        "conditions": conditions_value(st.and_then(|x| x.conditions.as_ref())),
    }))
}

/// Generic conditions projection — works for Deployment / StatefulSet /
/// DaemonSet alike since each carries a struct-shape with the same fields
/// (type, status, reason, message). We hand-roll one over `serde_json::Value`
/// so we don't have to thread a generic with a trait bound for a 5-field
/// flatten; cost is one Value::to_value per condition.
fn conditions_value<T: serde::Serialize>(conds: Option<&Vec<T>>) -> Value {
    let Some(conds) = conds else {
        return Value::Array(Vec::new());
    };
    let mut out = Vec::with_capacity(conds.len());
    for c in conds {
        if let Ok(v) = serde_json::to_value(c) {
            out.push(json!({
                "type": v.get("type").cloned().unwrap_or(Value::Null),
                "status": v.get("status").cloned().unwrap_or(Value::Null),
                "reason": v.get("reason").cloned().unwrap_or(Value::Null),
                "message": v.get("message").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Value::Array(out)
}

async fn client_for(app: &AppHandle, cluster_id: &str) -> Result<Client, NativeToolError> {
    let state = app.state::<AppState>();
    let entry = state
        .entry(cluster_id)
        .await
        .map_err(|e| NativeToolError::msg(format!("connect cluster: {e}")))?;
    Ok(entry.cluster.client())
}
