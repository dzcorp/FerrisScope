use k8s_openapi::api::apps::v1::ReplicaSet;
use serde_json::{json, Value};

use crate::kinds::pod_template::{
    project_label_selector, project_meta, project_pod_template_summary,
};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ReplicaSetSpec;

impl KindSpec for ReplicaSetSpec {
    type K = ReplicaSet;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "replicasets",
            group: "apps",
            version: "v1",
            kind: "ReplicaSet",
            plural: "replicasets",
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
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(rs: &ReplicaSet) -> Value {
        let meta = &rs.metadata;
        let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let status = rs.status.as_ref();
        let current = status.map(|s| s.replicas).unwrap_or(0);
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "desired": desired,
            "current": current,
            "ready": ready,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(rs: &ReplicaSet) -> Value {
    let meta = project_meta(&rs.metadata);
    let spec = rs.spec.as_ref();
    let status = rs.status.as_ref();

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

    let pod_template = spec
        .and_then(|s| s.template.as_ref())
        .map(project_pod_template_summary);

    json!({
        "meta": meta,
        "selector": project_label_selector(spec.map(|s| &s.selector)),
        "replicas": {
            "desired": spec.and_then(|s| s.replicas).unwrap_or(0),
            "ready": status.and_then(|s| s.ready_replicas).unwrap_or(0),
            "available": status.and_then(|s| s.available_replicas).unwrap_or(0),
            "fully_labeled": status.and_then(|s| s.fully_labeled_replicas).unwrap_or(0),
            "current": status.map(|s| s.replicas).unwrap_or(0),
        },
        "min_ready_seconds": spec.and_then(|s| s.min_ready_seconds),
        "observed_generation": status.and_then(|s| s.observed_generation),
        "conditions": conditions,
        "pod_template": pod_template,
    })
}
