//! `fs_cronjob_*` / `fs_job_*` — batch-workload operations that have no
//! generic equivalent.
//!
//! Everything else about Jobs and CronJobs is already reachable:
//! `fs_resources_list` / `fs_resources_get` read them, `fs_apply_resource`
//! flips `spec.suspend`, `fs_resources_delete` removes them. The two verbs
//! here can't be expressed as a patch, because both *create* an object built
//! from another one:
//!
//! * Triggering a CronJob needs its live `uid` to write the controller owner
//!   reference — without it the manual run escapes the CronJob's history
//!   limits and outlives its parent.
//! * Re-running a Job means cloning it, because a Job's spec is immutable; the
//!   clone has to be stripped of the controller-generated selector and labels
//!   or it adopts the original's pods.
//!
//! Left to the model, both are multi-call sequences with a sharp edge in the
//! middle. Here they're one call that either works or explains itself.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_kube_ext::{
    list_jobs_for_cron_job, manual_job_name, rerun_job, rerun_job_name, trigger_cron_job,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct TargetArgs {
    namespace: String,
    name: String,
}

// ─── fs_cronjob_trigger ──────────────────────────────────────────────────────

pub(crate) struct CronJobTrigger {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl CronJobTrigger {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for CronJobTrigger {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_cronjob_trigger".to_string(),
            description: "Run a CronJob now, out of schedule — the equivalent of `kubectl create \
                job <name> --from=cronjob/<cronjob>`. Creates a Job from the CronJob's \
                jobTemplate, named `<cronjob>-manual-<epoch>`, owned by the CronJob so its \
                history limits still reap it. Works on a suspended CronJob (that is usually the \
                point). Returns the created Job's name — follow up with `fs_pods_list` or \
                `fs_logs_tail` to watch it. Does NOT change the schedule or the suspend flag."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string", "description": "CronJob name." }
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
        let a: TargetArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let job_name = manual_job_name(&a.name, chrono::Utc::now());
        let created = trigger_cron_job(client, &a.namespace, &a.name, &job_name)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(json!({
            "cronjob": a.name,
            "namespace": a.namespace,
            "created_job": created,
        }))
    }
}

// ─── fs_job_rerun ────────────────────────────────────────────────────────────

pub(crate) struct JobRerun {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl JobRerun {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for JobRerun {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_job_rerun".to_string(),
            description: "Run a Job again. A Job's spec is immutable, so this creates a copy \
                named `<job>-rerun-<epoch>` with the controller-generated selector, \
                `controller-uid` / `job-name` labels and `spec.suspend` stripped, keeping any \
                owner reference. kubectl has no verb for this. The original Job is left alone — \
                delete it separately if it should not stay around. Returns the new Job's name."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string", "description": "Job to re-run." }
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
        let a: TargetArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let new_name = rerun_job_name(&a.name, chrono::Utc::now());
        let created = rerun_job(client, &a.namespace, &a.name, &new_name)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(json!({
            "source_job": a.name,
            "namespace": a.namespace,
            "created_job": created,
        }))
    }
}

// ─── fs_cronjob_history ──────────────────────────────────────────────────────

pub(crate) struct CronJobHistory {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl CronJobHistory {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for CronJobHistory {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_cronjob_history".to_string(),
            description: "Recent runs of a CronJob, newest first: phase, succeeded / failed / \
                active counts, start and completion times, duration, and whether the run was \
                manual. Selected by controller owner reference, not labels, so unrelated Jobs \
                sharing the template's labels are excluded. Use this instead of \
                `fs_resources_list` on Jobs when asked why a CronJob is failing — the list is \
                bounded by the CronJob's own history limits, so runs older than \
                `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` are already gone from the \
                cluster and no tool can recover them; check Events for those."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string", "description": "CronJob name." }
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
        let a: TargetArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let runs = list_jobs_for_cron_job(client, &a.namespace, &a.name)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(json!({
            "cronjob": a.name,
            "namespace": a.namespace,
            "count": runs.len(),
            "runs": runs,
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
