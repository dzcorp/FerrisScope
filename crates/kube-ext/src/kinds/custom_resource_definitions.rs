use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct CustomResourceDefinitionSpec;

impl KindSpec for CustomResourceDefinitionSpec {
    type K = CustomResourceDefinition;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "customresourcedefinitions",
            group: "apiextensions.k8s.io",
            version: "v1",
            kind: "CustomResourceDefinition",
            plural: "customresourcedefinitions",
            namespaced: false,
            category: Category::CustomResources,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "group",
                    header: "Group",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "kind",
                    header: "Kind",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "scope",
                    header: "Scope",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "versions",
                    header: "Versions",
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

    fn project(crd: &CustomResourceDefinition) -> Value {
        let meta = &crd.metadata;
        let spec = &crd.spec;
        // Comma-separated served versions, served ones first. Operators
        // typically want to know which version they should target without
        // opening the detail panel.
        let mut versions: Vec<&str> = spec
            .versions
            .iter()
            .filter(|v| v.served)
            .map(|v| v.name.as_str())
            .collect();
        if versions.is_empty() {
            versions = spec.versions.iter().map(|v| v.name.as_str()).collect();
        }
        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "group": spec.group.clone(),
            "kind": spec.names.kind.clone(),
            "scope": spec.scope.clone(),
            "versions": versions.join(", "),
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — the spec block in human-readable shape. Includes
/// every served version's name + storage marker so the operator can see at
/// a glance which version is the storage version. `printer_columns` mirrors
/// `kubectl get` additional-printer-columns for that version.
pub fn project_detail(crd: &CustomResourceDefinition) -> Value {
    let meta = project_meta(&crd.metadata);
    let spec = &crd.spec;

    let versions: Vec<Value> = spec
        .versions
        .iter()
        .map(|v| {
            let printer_columns: Vec<Value> = v
                .additional_printer_columns
                .as_ref()
                .map(|cols| {
                    cols.iter()
                        .map(|c| {
                            json!({
                                "name": c.name.clone(),
                                "type": c.type_.clone(),
                                "json_path": c.json_path.clone(),
                                "description": c.description.clone(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "name": v.name.clone(),
                "served": v.served,
                "storage": v.storage,
                "deprecated": v.deprecated.unwrap_or(false),
                "deprecation_warning": v.deprecation_warning.clone(),
                "printer_columns": printer_columns,
            })
        })
        .collect();

    let categories: Vec<String> = spec.names.categories.clone().unwrap_or_default();
    let short_names: Vec<String> = spec.names.short_names.clone().unwrap_or_default();

    json!({
        "meta": meta,
        "group": spec.group.clone(),
        "scope": spec.scope.clone(),
        "names": {
            "kind": spec.names.kind.clone(),
            "list_kind": spec.names.list_kind.clone(),
            "plural": spec.names.plural.clone(),
            "singular": spec.names.singular.clone(),
            "short_names": short_names,
            "categories": categories,
        },
        "versions": versions,
        "conversion_strategy": spec
            .conversion
            .as_ref()
            .map(|c| c.strategy.clone()),
    })
}
