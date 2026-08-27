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

        let suspend = spec.and_then(|s| s.suspend).unwrap_or(false);

        let phase = if status.and_then(|s| s.completion_time.as_ref()).is_some() {
            "Succeeded"
        } else if failed > 0 {
            "Failed"
        } else if active > 0 {
            "Running"
        } else if suspend {
            // A suspended Job has no pods and no completion, so every other
            // branch would read "Pending" — indistinguishable from one the
            // scheduler simply hasn't got to yet.
            "Suspended"
        } else {
            "Pending"
        };

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            // No column of its own — the row carries it so the detail panel's
            // Suspend/Resume toggle tracks the watcher instead of refetching.
            "suspend": suspend,
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
        "backoff_limit_per_index": spec.and_then(|s| s.backoff_limit_per_index),
        "max_failed_indexes": spec.and_then(|s| s.max_failed_indexes),
        "pod_replacement_policy": spec.and_then(|s| s.pod_replacement_policy.clone()),
        "managed_by": spec.and_then(|s| s.managed_by.clone()),
        "pod_failure_policy": spec
            .and_then(|s| s.pod_failure_policy.as_ref())
            .map(project_pod_failure_policy),
        "success_policy": spec
            .and_then(|s| s.success_policy.as_ref())
            .map(project_success_policy),
        "status": {
            "active": status.and_then(|s| s.active).unwrap_or(0),
            "succeeded": status.and_then(|s| s.succeeded).unwrap_or(0),
            "failed": status.and_then(|s| s.failed).unwrap_or(0),
            "ready": status.and_then(|s| s.ready),
            "terminating": status.and_then(|s| s.terminating),
            "completed_indexes": status.and_then(|s| s.completed_indexes.clone()),
            "failed_indexes": status.and_then(|s| s.failed_indexes.clone()),
        },
        "start_time": status.and_then(|s| s.start_time.as_ref().map(|t| t.0.to_string())),
        "completion_time": status.and_then(|s| s.completion_time.as_ref().map(|t| t.0.to_string())),
        "conditions": conditions,
        "pod_template": pod_template,
    })
}

/// Flatten `spec.podFailurePolicy` into one row per rule. `action` is required
/// by the schema; the two requirement shapes are mutually exclusive in
/// practice but both are projected so neither is silently dropped.
fn project_pod_failure_policy(policy: &k8s_openapi::api::batch::v1::PodFailurePolicy) -> Value {
    let rules: Vec<Value> = policy
        .rules
        .iter()
        .map(|r| {
            json!({
                "action": r.action.clone(),
                "on_exit_codes": r.on_exit_codes.as_ref().map(|c| json!({
                    "container_name": c.container_name.clone(),
                    "operator": c.operator.clone(),
                    "values": c.values.clone(),
                })),
                "on_pod_conditions": r.on_pod_conditions.as_ref().map(|conds| {
                    conds
                        .iter()
                        .map(|c| json!({ "type": c.type_.clone(), "status": c.status.clone() }))
                        .collect::<Vec<_>>()
                }),
            })
        })
        .collect();
    json!({ "rules": rules })
}

fn project_success_policy(policy: &k8s_openapi::api::batch::v1::SuccessPolicy) -> Value {
    let rules: Vec<Value> = policy
        .rules
        .iter()
        .map(|r| {
            json!({
                "succeeded_count": r.succeeded_count,
                "succeeded_indexes": r.succeeded_indexes.clone(),
            })
        })
        .collect();
    json!({ "rules": rules })
}

/// Compact row for a CronJob's run history. Deliberately smaller than
/// `project_detail` — this ships a list of Jobs, and the operator scanning it
/// wants outcome and timing, not specs.
pub fn project_history_row(job: &Job) -> Value {
    let meta = &job.metadata;
    let status = job.status.as_ref();
    let succeeded = status.and_then(|s| s.succeeded).unwrap_or(0);
    let failed = status.and_then(|s| s.failed).unwrap_or(0);
    let active = status.and_then(|s| s.active).unwrap_or(0);
    let start_time = status.and_then(|s| s.start_time.as_ref().map(|t| t.0.to_string()));
    let completion_time = status.and_then(|s| s.completion_time.as_ref().map(|t| t.0.to_string()));

    // A Job with a completionTime succeeded even if earlier attempts failed —
    // `failed` counts burned pods, not the Job's verdict. Check the terminal
    // condition first so a job that retried into success doesn't read "Failed".
    let phase = if completion_time.is_some() {
        "Succeeded"
    } else if has_true_condition(job, "Failed") {
        "Failed"
    } else if active > 0 {
        "Running"
    } else if failed > 0 {
        "Failed"
    } else {
        "Pending"
    };

    let duration_seconds = match (
        status.and_then(|s| s.start_time.as_ref()),
        status.and_then(|s| s.completion_time.as_ref()),
    ) {
        (Some(start), Some(end)) => Some((end.0.as_second() - start.0.as_second()).max(0)),
        _ => None,
    };

    json!({
        "uid": meta.uid.clone(),
        "name": meta.name.clone().unwrap_or_default(),
        "namespace": meta.namespace.clone(),
        "phase": phase,
        "succeeded": succeeded,
        "failed": failed,
        "active": active,
        "completions_desired": job.spec.as_ref().and_then(|s| s.completions),
        "start_time": start_time,
        "completion_time": completion_time,
        "duration_seconds": duration_seconds,
        "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        // Distinguishes a manually triggered run from a scheduled one — the
        // annotation kubectl and our own trigger both stamp.
        "manual": meta
            .annotations
            .as_ref()
            .and_then(|a| a.get("cronjob.kubernetes.io/instantiate"))
            .is_some_and(|v| v == "manual"),
    })
}

fn has_true_condition(job: &Job, kind: &str) -> bool {
    job.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|cs| cs.iter().any(|c| c.type_ == kind && c.status == "True"))
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

    /// A suspended Job has no pods and no completion time, so without this
    /// branch it reads "Pending" — the same as one that simply hasn't started,
    /// which is the state the operator most needs to tell it apart from.
    #[test]
    fn suspended_job_reports_a_distinct_phase() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "paused", "namespace": "default" },
            "spec": { "completions": 1, "suspend": true }
        }))
        .expect("valid Job fixture");

        let row = JobSpec::project(&job);
        assert_eq!(row["phase"], "Suspended");
        assert_eq!(row["suspend"], true);
    }

    /// Suspension must not mask a terminal outcome: a Job suspended after it
    /// finished still succeeded.
    #[test]
    fn suspended_flag_does_not_override_a_finished_job() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "done" },
            "spec": { "suspend": true },
            "status": { "succeeded": 1, "completionTime": "2026-08-27T10:00:00Z" }
        }))
        .expect("valid Job fixture");
        assert_eq!(JobSpec::project(&job)["phase"], "Succeeded");
    }

    /// Indexed Jobs are opaque without these — `3/5 completed` says nothing
    /// about *which* shards failed, which is the only actionable part.
    #[test]
    fn detail_projects_indexed_job_fields() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "shard", "namespace": "default" },
            "spec": {
                "completions": 5,
                "completionMode": "Indexed",
                "backoffLimitPerIndex": 2,
                "maxFailedIndexes": 1,
                "podReplacementPolicy": "Failed",
                "managedBy": "kueue.x-k8s.io/multikueue"
            },
            "status": { "completedIndexes": "0-2", "failedIndexes": "3" }
        }))
        .expect("valid Job fixture");

        let d = project_detail(&job);
        assert_eq!(d["backoff_limit_per_index"], 2);
        assert_eq!(d["max_failed_indexes"], 1);
        assert_eq!(d["pod_replacement_policy"], "Failed");
        assert_eq!(d["managed_by"], "kueue.x-k8s.io/multikueue");
        assert_eq!(d["status"]["completed_indexes"], "0-2");
        assert_eq!(d["status"]["failed_indexes"], "3");
    }

    /// Absent policies must project as null, not as empty rule lists — the UI
    /// hides the row entirely when there is no policy, and an empty `rules`
    /// array would render a misleading "Pod Failure Policy: (none)" section.
    #[test]
    fn detail_omits_absent_policies() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "plain" },
            "spec": {}
        }))
        .expect("valid Job fixture");

        let d = project_detail(&job);
        assert!(d["pod_failure_policy"].is_null());
        assert!(d["success_policy"].is_null());
        assert!(d["managed_by"].is_null());
    }

    #[test]
    fn detail_projects_pod_failure_policy_rules() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "picky" },
            "spec": {
                "podFailurePolicy": { "rules": [
                    {
                        "action": "FailJob",
                        "onExitCodes": { "containerName": "main", "operator": "In", "values": [42] }
                    },
                    {
                        "action": "Ignore",
                        "onPodConditions": [{ "type": "DisruptionTarget", "status": "True" }]
                    }
                ]},
                "successPolicy": { "rules": [{ "succeededIndexes": "0,1" }] }
            }
        }))
        .expect("valid Job fixture");

        let d = project_detail(&job);
        let rules = d["pod_failure_policy"]["rules"]
            .as_array()
            .expect("rules array");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["action"], "FailJob");
        assert_eq!(rules[0]["on_exit_codes"]["values"][0], 42);
        assert!(rules[0]["on_pod_conditions"].is_null());
        assert_eq!(rules[1]["on_pod_conditions"][0]["type"], "DisruptionTarget");
        assert_eq!(d["success_policy"]["rules"][0]["succeeded_indexes"], "0,1");
    }

    /// The verdict a naive `failed > 0` check gets wrong: a Job that burned a
    /// pod and then succeeded is Succeeded, not Failed. Operators scanning a
    /// CronJob's history read that column as the answer.
    #[test]
    fn history_row_reports_succeeded_despite_earlier_failures() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "retried", "namespace": "default" },
            "spec": { "completions": 1 },
            "status": {
                "succeeded": 1,
                "failed": 2,
                "startTime": "2026-08-27T10:00:00Z",
                "completionTime": "2026-08-27T10:00:30Z"
            }
        }))
        .expect("valid Job fixture");

        let row = project_history_row(&job);
        assert_eq!(row["phase"], "Succeeded");
        assert_eq!(row["failed"], 2);
        assert_eq!(row["duration_seconds"], 30);
    }

    /// A Job past its backoff limit has no completionTime; the terminal
    /// `Failed` condition is what makes it definitively failed rather than
    /// still retrying.
    #[test]
    fn history_row_uses_the_failed_condition() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "doomed" },
            "spec": {},
            "status": {
                "failed": 4,
                "startTime": "2026-08-27T10:00:00Z",
                "conditions": [{ "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded" }]
            }
        }))
        .expect("valid Job fixture");

        let row = project_history_row(&job);
        assert_eq!(row["phase"], "Failed");
        // Still running as far as the clock is concerned — no end, no duration.
        assert!(row["duration_seconds"].is_null());
    }

    #[test]
    fn history_row_reports_running_and_pending() {
        let running: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1", "kind": "Job", "metadata": { "name": "r" },
            "spec": {}, "status": { "active": 1, "startTime": "2026-08-27T10:00:00Z" }
        }))
        .expect("valid Job fixture");
        assert_eq!(project_history_row(&running)["phase"], "Running");

        let pending: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1", "kind": "Job", "metadata": { "name": "p" }, "spec": {}
        }))
        .expect("valid Job fixture");
        let row = project_history_row(&pending);
        assert_eq!(row["phase"], "Pending");
        assert_eq!(row["manual"], false);
    }

    /// Manual runs have to be distinguishable in the history list — a run that
    /// appeared off-schedule is otherwise unexplainable.
    #[test]
    fn history_row_flags_manual_runs() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": "nightly-manual-1",
                "annotations": { "cronjob.kubernetes.io/instantiate": "manual" }
            },
            "spec": {}
        }))
        .expect("valid Job fixture");
        assert_eq!(project_history_row(&job)["manual"], true);
    }
}
