use k8s_openapi::api::batch::v1::CronJob;
use serde_json::{json, Value};

use crate::kinds::pod_template::{project_meta, project_pod_template_summary};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct CronJobSpec;

impl KindSpec for CronJobSpec {
    type K = CronJob;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "cronjobs",
            group: "batch",
            version: "v1",
            kind: "CronJob",
            plural: "cronjobs",
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
                    id: "schedule",
                    header: "Schedule",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "suspend",
                    header: "Suspend",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "active",
                    header: "Active",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "last_schedule",
                    header: "Last Schedule",
                    kind: Some(ColumnKind::Age),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(cj: &CronJob) -> Value {
        let meta = &cj.metadata;
        let spec = cj.spec.as_ref();
        let status = cj.status.as_ref();
        let schedule = spec.map(|s| s.schedule.clone()).unwrap_or_default();
        let suspend = spec.and_then(|s| s.suspend).unwrap_or(false);
        let active_count = status
            .and_then(|s| s.active.as_ref())
            .map_or(0, std::vec::Vec::len);
        let last_schedule = status
            .and_then(|s| s.last_schedule_time.as_ref())
            .map(|t| t.0.to_string());

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "schedule": schedule,
            "suspend": if suspend { "true" } else { "false" },
            "active": active_count,
            "last_schedule": last_schedule,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(cj: &CronJob) -> Value {
    let meta = project_meta(&cj.metadata);
    let spec = cj.spec.as_ref();
    let status = cj.status.as_ref();

    // The CronJob's pod template lives at .spec.jobTemplate.spec.template.
    let pod_template = spec
        .and_then(|s| s.job_template.spec.as_ref())
        .map(|js| project_pod_template_summary(&js.template));

    let job_spec = spec.and_then(|s| s.job_template.spec.as_ref());
    let job_template_summary = job_spec.map(|js| {
        json!({
            "completions": js.completions,
            "parallelism": js.parallelism,
            "backoff_limit": js.backoff_limit,
            "active_deadline_seconds": js.active_deadline_seconds,
            "ttl_seconds_after_finished": js.ttl_seconds_after_finished,
        })
    });

    let active: Vec<Value> = status
        .and_then(|s| s.active.as_ref())
        .map(|refs| {
            refs.iter()
                .map(|r| {
                    json!({
                        "kind": r.kind.clone(),
                        "name": r.name.clone(),
                        "namespace": r.namespace.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "meta": meta,
        "schedule": spec.map(|s| s.schedule.clone()),
        "time_zone": spec.and_then(|s| s.time_zone.clone()),
        "suspend": spec.and_then(|s| s.suspend).unwrap_or(false),
        "concurrency_policy": spec.and_then(|s| s.concurrency_policy.clone()),
        "starting_deadline_seconds": spec.and_then(|s| s.starting_deadline_seconds),
        "successful_jobs_history_limit": spec.and_then(|s| s.successful_jobs_history_limit),
        "failed_jobs_history_limit": spec.and_then(|s| s.failed_jobs_history_limit),
        "last_schedule_time": status.and_then(|s| s.last_schedule_time.as_ref().map(|t| t.0.to_string())),
        "last_successful_time": status.and_then(|s| s.last_successful_time.as_ref().map(|t| t.0.to_string())),
        "active": active,
        "job_template": job_template_summary,
        "pod_template": pod_template,
    })
}
