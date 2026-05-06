use k8s_openapi::api::apps::v1::DaemonSet;
use serde_json::{json, Value};

use crate::kinds::pod_template::{
    project_label_selector, project_meta, project_pod_template_summary,
};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct DaemonSetSpec;

impl KindSpec for DaemonSetSpec {
    type K = DaemonSet;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "daemonsets",
            group: "apps",
            version: "v1",
            kind: "DaemonSet",
            plural: "daemonsets",
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
                    id: "desired",
                    header: "Desired",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "current",
                    header: "Current",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "ready",
                    header: "Ready",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "up_to_date",
                    header: "Up-to-date",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "available",
                    header: "Available",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(ds: &DaemonSet) -> Value {
        let meta = &ds.metadata;
        let status = ds.status.as_ref();
        let desired = status.map(|s| s.desired_number_scheduled).unwrap_or(0);
        let current = status.map(|s| s.current_number_scheduled).unwrap_or(0);
        let ready = status.map(|s| s.number_ready).unwrap_or(0);
        let up_to_date = status.and_then(|s| s.updated_number_scheduled).unwrap_or(0);
        let available = status.and_then(|s| s.number_available).unwrap_or(0);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "desired": desired,
            "current": current,
            "ready": ready,
            "up_to_date": up_to_date,
            "available": available,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(ds: &DaemonSet) -> Value {
    let meta = project_meta(&ds.metadata);
    let spec = ds.spec.as_ref();
    let status = ds.status.as_ref();

    let strategy = spec.and_then(|s| s.update_strategy.as_ref()).map(|st| {
        let ru = st.rolling_update.as_ref();
        json!({
            "type": st.type_.clone().unwrap_or_else(|| "RollingUpdate".to_owned()),
            "max_surge": ru.and_then(|r| r.max_surge.as_ref()).map(intorstring_to_string),
            "max_unavailable": ru
                .and_then(|r| r.max_unavailable.as_ref())
                .map(intorstring_to_string),
        })
    });

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

    let pod_template = spec.map(|s| project_pod_template_summary(&s.template));

    json!({
        "meta": meta,
        "selector": project_label_selector(spec.map(|s| &s.selector)),
        "replicas": {
            "desired_scheduled": status.map(|s| s.desired_number_scheduled).unwrap_or(0),
            "current_scheduled": status.map(|s| s.current_number_scheduled).unwrap_or(0),
            "ready": status.map(|s| s.number_ready).unwrap_or(0),
            "available": status.and_then(|s| s.number_available).unwrap_or(0),
            "unavailable": status.and_then(|s| s.number_unavailable).unwrap_or(0),
            "up_to_date": status.and_then(|s| s.updated_number_scheduled).unwrap_or(0),
            "misscheduled": status.map(|s| s.number_misscheduled).unwrap_or(0),
        },
        "min_ready_seconds": spec.and_then(|s| s.min_ready_seconds),
        "revision_history_limit": spec.and_then(|s| s.revision_history_limit),
        "update_strategy": strategy,
        "observed_generation": status.and_then(|s| s.observed_generation),
        "collision_count": status.and_then(|s| s.collision_count),
        "conditions": conditions,
        "pod_template": pod_template,
    })
}

fn intorstring_to_string(v: &k8s_openapi::apimachinery::pkg::util::intstr::IntOrString) -> String {
    match v {
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
    }
}
