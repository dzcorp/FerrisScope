use k8s_openapi::api::core::v1::Namespace;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct NamespaceSpec;

impl KindSpec for NamespaceSpec {
    type K = Namespace;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "namespaces",
            group: "",
            version: "v1",
            kind: "Namespace",
            plural: "namespaces",
            namespaced: false,
            category: Category::Cluster,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
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

    fn project(ns: &Namespace) -> Value {
        let meta = &ns.metadata;
        let phase = ns
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".to_owned());

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "phase": phase,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the namespace detail panel. Keeps shape parity with the
// other detail kinds — a single `meta` block at the top, kind-specific status
// + spec rows underneath. Namespaces are thin objects so this projection is
// short by design.
pub fn project_detail(ns: &Namespace) -> Value {
    let meta = project_meta(&ns.metadata);
    let status = ns.status.as_ref();
    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".to_owned());
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
    let finalizers: Vec<String> = ns
        .spec
        .as_ref()
        .and_then(|s| s.finalizers.as_ref())
        .cloned()
        .unwrap_or_default();

    json!({
        "meta": meta,
        "phase": phase,
        "finalizers": finalizers,
        "conditions": conditions,
    })
}
