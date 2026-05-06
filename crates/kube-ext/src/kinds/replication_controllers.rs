use k8s_openapi::api::core::v1::ReplicationController;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ReplicationControllerSpec;

impl KindSpec for ReplicationControllerSpec {
    type K = ReplicationController;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "replicationcontrollers",
            group: "",
            version: "v1",
            kind: "ReplicationController",
            plural: "replicationcontrollers",
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

    fn project(rc: &ReplicationController) -> Value {
        let meta = &rc.metadata;
        let spec = rc.spec.as_ref();
        let status = rc.status.as_ref();

        let desired = spec.and_then(|s| s.replicas).unwrap_or(0);
        let current = status.map(|s| s.replicas).unwrap_or(0);
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "namespace": meta.namespace.clone(),
            "desired": desired,
            "current": current,
            "ready": ready,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(rc: &ReplicationController) -> Value {
    let meta = project_meta(&rc.metadata);
    let spec = rc.spec.as_ref();
    let status = rc.status.as_ref();

    let selector: Vec<Value> = spec
        .and_then(|s| s.selector.as_ref())
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();

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

    json!({
        "meta": meta,
        "replicas": spec.and_then(|s| s.replicas),
        "min_ready_seconds": spec.and_then(|s| s.min_ready_seconds),
        "selector": selector,
        "current": status.map(|s| s.replicas).unwrap_or(0),
        "ready": status.and_then(|s| s.ready_replicas),
        "available": status.and_then(|s| s.available_replicas),
        "fully_labeled": status.and_then(|s| s.fully_labeled_replicas),
        "observed_generation": status.and_then(|s| s.observed_generation),
        "conditions": conditions,
    })
}
