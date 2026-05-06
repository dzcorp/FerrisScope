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
