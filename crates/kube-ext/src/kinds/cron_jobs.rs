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
        // k8s-openapi 0.28 made `CronJob.spec` non-optional; keep the downstream
        // Option-chaining intact by re-wrapping.
        let spec = Some(&cj.spec);
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
    // k8s-openapi 0.28 made `CronJob.spec` non-optional; keep the downstream
    // Option-chaining intact by re-wrapping.
    let spec = Some(&cj.spec);
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
        // Computed, not reported: the apiserver exposes no next-fire field, so
        // the operator's only alternative is reading the cron expression by
        // hand. `None` when the expression is one we won't guess at (`@every`,
        // malformed) or the zone is unknown — a dash beats a wrong time.
        "next_run": crate::cron_schedule::next_run_rfc3339(
            &spec.map(|s| s.schedule.clone()).unwrap_or_default(),
            spec.and_then(|s| s.time_zone.as_deref()),
            chrono::Utc::now(),
        ),
        "last_schedule_time": status.and_then(|s| s.last_schedule_time.as_ref().map(|t| t.0.to_string())),
        "last_successful_time": status.and_then(|s| s.last_successful_time.as_ref().map(|t| t.0.to_string())),
        "active": active,
        "job_template": job_template_summary,
        "pod_template": pod_template,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cron_job(schedule: &str, time_zone: Option<&str>) -> CronJob {
        let mut spec = json!({
            "schedule": schedule,
            "jobTemplate": { "spec": { "template": { "spec": { "containers": [] } } } }
        });
        if let Some(tz) = time_zone {
            spec["timeZone"] = json!(tz);
        }
        serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "CronJob",
            "metadata": { "name": "nightly", "namespace": "default" },
            "spec": spec,
        }))
        .expect("valid CronJob fixture")
    }

    /// The apiserver has no next-fire field; this is ours, so it has to be
    /// present and in the future for any schedule we can parse.
    #[test]
    fn detail_computes_next_run() {
        let d = project_detail(&cron_job("*/5 * * * *", None));
        let next = d["next_run"].as_str().expect("next_run present");
        let parsed: chrono::DateTime<chrono::Utc> = next.parse().expect("rfc3339");
        assert!(parsed > chrono::Utc::now());
    }

    /// A schedule we can't evaluate must project null so the UI shows a dash.
    /// Rendering a guess as fact is the failure mode worth guarding.
    #[test]
    fn detail_next_run_is_null_for_unparseable_schedule() {
        assert!(project_detail(&cron_job("@every 1h", None))["next_run"].is_null());
        assert!(project_detail(&cron_job("not a cron", None))["next_run"].is_null());
    }

    /// An unknown IANA zone must not silently fall back to UTC — that would
    /// show an hours-off time with no indication anything was wrong.
    #[test]
    fn detail_next_run_is_null_for_unknown_time_zone() {
        let d = project_detail(&cron_job("0 9 * * *", Some("Mars/Olympus")));
        assert_eq!(d["time_zone"], "Mars/Olympus");
        assert!(d["next_run"].is_null());
    }

    /// A suspended CronJob still reports when it *would* fire; the UI pairs it
    /// with the Suspended pill. Blanking it would lose the information the
    /// operator needs to decide whether resuming is safe right now.
    #[test]
    fn detail_next_run_survives_suspension() {
        let mut cj = cron_job("0 3 * * *", None);
        cj.spec.suspend = Some(true);
        let d = project_detail(&cj);
        assert_eq!(d["suspend"], true);
        assert!(d["next_run"].is_string());
    }
}
