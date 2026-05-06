//! Workload summary native tool.
//!
//! Synthesises a rolled-up view of a Deployment / StatefulSet / DaemonSet /
//! Job / CronJob: desired vs ready counts, child-pod phase histogram, plus a
//! few representative pod names. Saves the agent N round-trips during the
//! "is this workload healthy" question that comes up in basically every
//! incident.
//!
//! Read-only. Targets one workload at a time so the agent passes a deliberate
//! `(kind, namespace, name)` rather than walking the whole cluster.

use std::collections::BTreeMap;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const POD_SAMPLE_LIMIT: usize = 10;

#[derive(Debug, Deserialize)]
struct Args {
    kind: String,
    namespace: String,
    name: String,
}

pub(crate) struct WorkloadSummary {
    app: AppHandle,
    cluster_id: String,
}

impl WorkloadSummary {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for WorkloadSummary {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_workload_summary".to_string(),
            description:
                "Roll up a workload's status in one call. Returns desired/ready/updated/available \
                replica counts, child-pod phase histogram, and a sample of pod names. Use this \
                instead of fetching the workload + listing its pods + counting phases manually. \
                Supported kinds: Deployment, StatefulSet, DaemonSet, Job, CronJob."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"],
                        "description": "Kubernetes kind of the workload."
                    },
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["kind", "namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let (status, selector_labels) = match a.kind.as_str() {
            "Deployment" => {
                let api: Api<Deployment> = Api::namespaced(client.clone(), &a.namespace);
                let d = api.get(&a.name).await.map_err(kube_err)?;
                let s = d.status.unwrap_or_default();
                let spec_replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
                let status = json!({
                    "replicas_desired": spec_replicas,
                    "replicas_current": s.replicas.unwrap_or(0),
                    "replicas_ready": s.ready_replicas.unwrap_or(0),
                    "replicas_updated": s.updated_replicas.unwrap_or(0),
                    "replicas_available": s.available_replicas.unwrap_or(0),
                    "replicas_unavailable": s.unavailable_replicas.unwrap_or(0),
                    "observed_generation": s.observed_generation,
                    "conditions": s.conditions.unwrap_or_default()
                        .into_iter()
                        .map(|c| json!({
                            "type": c.type_,
                            "status": c.status,
                            "reason": c.reason,
                            "message": c.message,
                        }))
                        .collect::<Vec<_>>(),
                });
                let labels = d
                    .spec
                    .and_then(|s| s.selector.match_labels)
                    .unwrap_or_default();
                (status, labels)
            }
            "StatefulSet" => {
                let api: Api<StatefulSet> = Api::namespaced(client.clone(), &a.namespace);
                let d = api.get(&a.name).await.map_err(kube_err)?;
                let s = d.status.unwrap_or_default();
                let spec_replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
                let status = json!({
                    "replicas_desired": spec_replicas,
                    "replicas_current": s.current_replicas.unwrap_or(0),
                    "replicas_ready": s.ready_replicas.unwrap_or(0),
                    "replicas_updated": s.updated_replicas.unwrap_or(0),
                    "replicas_available": s.available_replicas.unwrap_or(0),
                    "current_revision": s.current_revision,
                    "update_revision": s.update_revision,
                    "observed_generation": s.observed_generation,
                    "conditions": s.conditions.unwrap_or_default()
                        .into_iter()
                        .map(|c| json!({
                            "type": c.type_,
                            "status": c.status,
                            "reason": c.reason,
                            "message": c.message,
                        }))
                        .collect::<Vec<_>>(),
                });
                let labels = d
                    .spec
                    .and_then(|s| s.selector.match_labels)
                    .unwrap_or_default();
                (status, labels)
            }
            "DaemonSet" => {
                let api: Api<DaemonSet> = Api::namespaced(client.clone(), &a.namespace);
                let d = api.get(&a.name).await.map_err(kube_err)?;
                let s = d.status.unwrap_or_default();
                let status = json!({
                    "desired_number_scheduled": s.desired_number_scheduled,
                    "current_number_scheduled": s.current_number_scheduled,
                    "number_ready": s.number_ready,
                    "number_available": s.number_available.unwrap_or(0),
                    "number_misscheduled": s.number_misscheduled,
                    "updated_number_scheduled": s.updated_number_scheduled.unwrap_or(0),
                    "observed_generation": s.observed_generation,
                    "conditions": s.conditions.unwrap_or_default()
                        .into_iter()
                        .map(|c| json!({
                            "type": c.type_,
                            "status": c.status,
                            "reason": c.reason,
                            "message": c.message,
                        }))
                        .collect::<Vec<_>>(),
                });
                let labels = d
                    .spec
                    .and_then(|s| s.selector.match_labels)
                    .unwrap_or_default();
                (status, labels)
            }
            "Job" => {
                let api: Api<Job> = Api::namespaced(client.clone(), &a.namespace);
                let j = api.get(&a.name).await.map_err(kube_err)?;
                let s = j.status.unwrap_or_default();
                let status = json!({
                    "active": s.active.unwrap_or(0),
                    "succeeded": s.succeeded.unwrap_or(0),
                    "failed": s.failed.unwrap_or(0),
                    "completion_time": s.completion_time.map(|t| t.0.to_string()),
                    "start_time": s.start_time.map(|t| t.0.to_string()),
                    "conditions": s.conditions.unwrap_or_default()
                        .into_iter()
                        .map(|c| json!({
                            "type": c.type_,
                            "status": c.status,
                            "reason": c.reason,
                            "message": c.message,
                        }))
                        .collect::<Vec<_>>(),
                });
                let labels = j
                    .spec
                    .and_then(|s| s.selector.and_then(|sel| sel.match_labels))
                    .unwrap_or_default();
                (status, labels)
            }
            "CronJob" => {
                let api: Api<CronJob> = Api::namespaced(client.clone(), &a.namespace);
                let cj = api.get(&a.name).await.map_err(kube_err)?;
                let s = cj.status.unwrap_or_default();
                let status = json!({
                    "active_jobs": s.active.as_ref().map(|a| a.len()).unwrap_or(0),
                    "last_schedule_time": s.last_schedule_time.map(|t| t.0.to_string()),
                    "last_successful_time": s.last_successful_time.map(|t| t.0.to_string()),
                    "schedule": cj.spec.as_ref().map(|s| s.schedule.clone()),
                    "suspend": cj.spec.as_ref().and_then(|s| s.suspend),
                });
                // CronJobs don't have a selector — child Jobs are tracked by
                // owner reference. Return early without pod fan-out.
                return Ok(json!({
                    "kind": a.kind,
                    "namespace": a.namespace,
                    "name": a.name,
                    "status": status,
                    "pods": Value::Null,
                    "note": "CronJob does not select pods directly — query its child Jobs by owner reference.",
                }));
            }
            other => {
                return Err(NativeToolError::msg(format!(
                    "unsupported kind: {other} (try Deployment/StatefulSet/DaemonSet/Job/CronJob)"
                )));
            }
        };

        let pods_summary = if selector_labels.is_empty() {
            json!({ "note": "workload selector is empty — no pod fan-out" })
        } else {
            let selector = selector_labels
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(",");
            let pods_api: Api<Pod> = Api::namespaced(client, &a.namespace);
            let lp = ListParams::default().labels(&selector);
            let pods = pods_api.list(&lp).await.map_err(kube_err)?;
            summarise_pods(&pods.items)
        };

        Ok(json!({
            "kind": a.kind,
            "namespace": a.namespace,
            "name": a.name,
            "status": status,
            "pods": pods_summary,
        }))
    }
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

fn summarise_pods(pods: &[Pod]) -> Value {
    let mut by_phase: BTreeMap<String, u64> = BTreeMap::new();
    let mut not_ready: Vec<Value> = Vec::new();
    let mut sample: Vec<Value> = Vec::new();

    for p in pods {
        let phase = p
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into());
        *by_phase.entry(phase.clone()).or_insert(0) += 1;
        let name = p.metadata.name.clone().unwrap_or_default();
        let ready_count = p
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().filter(|c| c.ready).count())
            .unwrap_or(0);
        let total_count = p.spec.as_ref().map(|s| s.containers.len()).unwrap_or(0);
        if sample.len() < POD_SAMPLE_LIMIT {
            sample.push(json!({
                "name": name.clone(),
                "phase": phase.clone(),
                "ready": format!("{ready_count}/{total_count}"),
                "node": p.spec.as_ref().and_then(|s| s.node_name.clone()),
            }));
        }
        let is_ready_phase = phase == "Running" && ready_count == total_count && total_count > 0;
        if !is_ready_phase {
            let reason = p
                .status
                .as_ref()
                .and_then(|s| {
                    s.container_statuses
                        .as_ref()
                        .and_then(|cs| {
                            cs.iter().find_map(|c| {
                                c.state
                                    .as_ref()
                                    .and_then(|st| st.waiting.as_ref())
                                    .and_then(|w| w.reason.clone())
                                    .or_else(|| {
                                        c.state
                                            .as_ref()
                                            .and_then(|st| st.terminated.as_ref())
                                            .and_then(|t| t.reason.clone())
                                    })
                            })
                        })
                        .or_else(|| s.reason.clone())
                })
                .unwrap_or_default();
            if not_ready.len() < POD_SAMPLE_LIMIT {
                not_ready.push(json!({
                    "name": name,
                    "phase": phase,
                    "ready": format!("{ready_count}/{total_count}"),
                    "reason": reason,
                }));
            }
        }
    }

    json!({
        "total": pods.len(),
        "by_phase": by_phase,
        "sample": sample,
        "not_ready_sample": not_ready,
    })
}
