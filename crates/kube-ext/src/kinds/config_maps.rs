use k8s_openapi::api::core::v1::ConfigMap;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ConfigMapSpec;

impl KindSpec for ConfigMapSpec {
    type K = ConfigMap;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "configmaps",
            group: "",
            version: "v1",
            kind: "ConfigMap",
            plural: "configmaps",
            namespaced: true,
            category: Category::Config,
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
                    id: "keys",
                    header: "Keys",
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

    fn project(cm: &ConfigMap) -> Value {
        let meta = &cm.metadata;
        let data_keys = cm.data.as_ref().map_or(0, std::collections::BTreeMap::len);
        let binary_keys = cm
            .binary_data
            .as_ref()
            .map_or(0, std::collections::BTreeMap::len);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "keys": data_keys + binary_keys,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(cm: &ConfigMap) -> Value {
    let meta = project_meta(&cm.metadata);
    let immutable = cm.immutable.unwrap_or(false);

    let mut data_entries: Vec<Value> = cm
        .data
        .as_ref()
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    json!({
                        "key": k,
                        "value": v,
                        "size": v.len(),
                        "binary": false,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(bd) = cm.binary_data.as_ref() {
        for (k, v) in bd {
            // ByteString is base64-encoded by serde — emit as-is so the UI can
            // present + copy it without a second round-trip.
            data_entries.push(json!({
                "key": k,
                "value": v,
                "size": v.0.len(),
                "binary": true,
            }));
        }
    }

    json!({
        "meta": meta,
        "immutable": immutable,
        "data": data_entries,
    })
}
