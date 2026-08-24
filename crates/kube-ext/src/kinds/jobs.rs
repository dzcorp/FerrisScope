use k8s_openapi::api::batch::v1::Job;
use serde_json::{json, Value};

use crate::kinds::pod_template::{
    project_label_selector, project_meta, project_pod_template_summary,
};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct JobSpec;

impl KindSpec for JobSpec {
    type K = Job;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "jobs",
            group: "batch",
            version: "v1",
            kind: "Job",
            plural: "jobs",
            namespaced: true,
            category: Category::Workloads,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "namespace",
                    header: "Namespace",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "pods",
                    header: "Pods",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "completions",
                    header: "Completions",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "phase",
                    header: "Status",
                    kind: Some(ColumnKind::Phase),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(job: &Job) -> Value {
        let meta = &job.metadata;
        let spec = job.spec.as_ref();
        let status = job.status.as_ref();
        let desired = spec.and_then(|s| s.completions).unwrap_or(1);
        let succeeded = status.and_then(|s| s.succeeded).unwrap_or(0);
        let active = status.and_then(|s| s.active).unwrap_or(0);
        let failed = status.and_then(|s| s.failed).unwrap_or(0);

        let phase = if status.and_then(|s| s.completion_time.as_ref()).is_some() {
            "Succeeded"
        } else if failed > 0 {
            "Failed"
        } else if active > 0 {
            "Running"
        } else {
            "Pending"
        };

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            // `active + succeeded + failed`, matching `kubectl describe job`'s
            // "Pods Statuses" line. Not a live count: succeeded pods stay
            // counted after the apiserver garbage-collects them, and the
            // number dips while pods terminate. Widened to i64 because a
            // projection must be total — i32 addition on apiserver-supplied
            // values panics in debug and wraps negative in release.
            //
            // Earns a column where Deployment's didn't: `completions` counts
            // only successes, so a job that failed twice before succeeding
            // reads 1/1 there and 3 here. Deployment/StatefulSet dropped
            // theirs — `ready` already carried the same number.
            "pods": i64::from(active) + i64::from(succeeded) + i64::from(failed),
            "completions": format!("{succeeded}/{desired}"),
            "phase": phase,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(job: &Job) -> Value {
    let meta = project_meta(&job.metadata);
    let spec = job.spec.as_ref();
    let status = job.status.as_ref();

    let conditions: Vec<Value> = status
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    json!({
                        "type": c.type_.clone(),
                        "status": c.status.clone(),
                        "reason": c.reason.clone(),
                        "message": c.message.clone(),
                        "last_transition_time": c.last_transition_time.as_ref().map(|t| t.0.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let phase = if status.and_then(|s| s.completion_time.as_ref()).is_some() {
        "Succeeded"
    } else if status.and_then(|s| s.failed).unwrap_or(0) > 0 {
        "Failed"
    } else if status.and_then(|s| s.active).unwrap_or(0) > 0 {
        "Running"
    } else {
        "Pending"
    };

    let pod_template = spec.map(|s| project_pod_template_summary(&s.template));

    json!({
        "meta": meta,
        "selector": project_label_selector(spec.and_then(|s| s.selector.as_ref())),
        "phase": phase,
        "completions_desired": spec.and_then(|s| s.completions),
        "parallelism": spec.and_then(|s| s.parallelism),
        "backoff_limit": spec.and_then(|s| s.backoff_limit),
        "active_deadline_seconds": spec.and_then(|s| s.active_deadline_seconds),
        "ttl_seconds_after_finished": spec.and_then(|s| s.ttl_seconds_after_finished),
        "completion_mode": spec.and_then(|s| s.completion_mode.clone()),
        "suspend": spec.and_then(|s| s.suspend).unwrap_or(false),
        "manual_selector": spec.and_then(|s| s.manual_selector).unwrap_or(false),
        "status": {
            "active": status.and_then(|s| s.active).unwrap_or(0),
            "succeeded": status.and_then(|s| s.succeeded).unwrap_or(0),
            "failed": status.and_then(|s| s.failed).unwrap_or(0),
            "ready": status.and_then(|s| s.ready),
            "terminating": status.and_then(|s| s.terminating),
        },
        "start_time": status.and_then(|s| s.start_time.as_ref().map(|t| t.0.to_string())),
        "completion_time": status.and_then(|s| s.completion_time.as_ref().map(|t| t.0.to_string())),
        "conditions": conditions,
        "pod_template": pod_template,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case that earns Job its Pods column: `completions` counts only
    /// successes, so a job that burned two pods before succeeding still reads
    /// 1/1 there. Only `pods` shows that three pods actually ran.
    #[test]
    fn pods_counts_failed_attempts_that_completions_hides() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate", "namespace": "default" },
            "spec": { "completions": 1, "backoffLimit": 4 },
            "status": {
                "succeeded": 1,
                "failed": 2,
                "completionTime": "2026-04-15T09:00:30Z"
            }
        }))
        .expect("valid Job fixture");

        let row = JobSpec::project(&job);
        assert_eq!(row["completions"], "1/1");
        assert_eq!(row["pods"], 3);
    }

    /// A Job the controller hasn't touched yet has no `status`. Projection
    /// must be total — 0, never a panic or a null.
    #[test]
    fn pods_defaults_to_zero_without_status() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "fresh", "namespace": "default" },
            "spec": { "completions": 1 }
        }))
        .expect("valid Job fixture");

        assert_eq!(JobSpec::project(&job)["pods"], 0);
    }
}
