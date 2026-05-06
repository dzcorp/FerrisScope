use k8s_openapi::api::networking::v1::IngressClass;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct IngressClassSpec;

impl KindSpec for IngressClassSpec {
    type K = IngressClass;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "ingressclasses",
            group: "networking.k8s.io",
            version: "v1",
            kind: "IngressClass",
            plural: "ingressclasses",
            namespaced: false,
            category: Category::Network,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "controller",
                    header: "Controller",
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

    fn project(ic: &IngressClass) -> Value {
        let meta = &ic.metadata;
        let controller = ic
            .spec
            .as_ref()
            .and_then(|s| s.controller.clone())
            .unwrap_or_default();

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "controller": controller,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the ingressclass detail panel. IngressClass is a thin
// pointer object — controller string + an optional parameters reference to a
// CRD that holds controller-specific config. Surface both so the operator can
// jump from the class to the parameters object.
pub fn project_detail(ic: &IngressClass) -> Value {
    let meta = project_meta(&ic.metadata);
    let spec = ic.spec.as_ref();
    let controller = spec.and_then(|s| s.controller.clone());
    let parameters = spec.and_then(|s| s.parameters.as_ref()).map(|p| {
        json!({
            "api_group": p.api_group.clone(),
            "kind": p.kind.clone(),
            "name": p.name.clone(),
            "namespace": p.namespace.clone(),
            "scope": p.scope.clone(),
        })
    });
    // Some controllers (nginx) advertise a default class via this annotation.
    let is_default = ic
        .metadata
        .annotations
        .as_ref()
        .and_then(|m| m.get("ingressclass.kubernetes.io/is-default-class"))
        .map(|v| v == "true")
        .unwrap_or(false);

    json!({
        "meta": meta,
        "controller": controller,
        "parameters": parameters,
        "is_default": is_default,
    })
}
