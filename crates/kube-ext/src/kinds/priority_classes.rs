use k8s_openapi::api::scheduling::v1::PriorityClass;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct PriorityClassSpec;

impl KindSpec for PriorityClassSpec {
    type K = PriorityClass;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "priorityclasses",
            group: "scheduling.k8s.io",
            version: "v1",
            kind: "PriorityClass",
            plural: "priorityclasses",
            namespaced: false,
            category: Category::Cluster,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "value",
                    header: "Value",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "global_default",
                    header: "Global Default",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "preemption_policy",
                    header: "Preemption",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(pc: &PriorityClass) -> Value {
        let meta = &pc.metadata;
        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "value": pc.value,
            "global_default": pc.global_default.unwrap_or(false).to_string(),
            "preemption_policy": pc.preemption_policy.clone().unwrap_or_default(),
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(pc: &PriorityClass) -> Value {
    let meta = project_meta(&pc.metadata);
    json!({
        "meta": meta,
        "value": pc.value,
        "global_default": pc.global_default.unwrap_or(false),
        "preemption_policy": pc.preemption_policy.clone(),
        "description": pc.description.clone(),
    })
}
