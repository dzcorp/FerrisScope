//! Secrets — table view shows the type and number of keys; values are never
//! sent to the frontend from the projection. A future detail panel will add
//! an opt-in reveal for individual keys (with audit logging).

use k8s_openapi::api::core::v1::Secret;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct SecretSpec;

impl KindSpec for SecretSpec {
    type K = Secret;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "secrets",
            group: "",
            version: "v1",
            kind: "Secret",
            plural: "secrets",
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
                    id: "type",
                    header: "Type",
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

    fn project(sec: &Secret) -> Value {
        let meta = &sec.metadata;
        let secret_type = sec.type_.clone().unwrap_or_else(|| "Opaque".to_owned());
        let data_keys = sec.data.as_ref().map_or(0, std::collections::BTreeMap::len);
        let string_keys = sec
            .string_data
            .as_ref()
            .map_or(0, std::collections::BTreeMap::len);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "type": secret_type,
            "keys": data_keys + string_keys,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection. We send the **base64 value** down — the UI keeps it
/// masked by default and only decodes it on an explicit reveal click. This
/// is the deliberate compromise: revealing a secret should be a conscious
/// per-key action, not the default render. Raw size (decoded byte length)
/// rides alongside so the UI can show "12 bytes" without unmasking.
pub fn project_detail(sec: &Secret) -> Value {
    let meta = project_meta(&sec.metadata);
    let secret_type = sec.type_.clone().unwrap_or_else(|| "Opaque".to_owned());
    let immutable = sec.immutable.unwrap_or(false);

    let mut data_entries: Vec<Value> = sec
        .data
        .as_ref()
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    json!({
                        "key": k,
                        // ByteString serializes as base64 — what the UI wants
                        // for the "copy base64" affordance.
                        "value_b64": v,
                        "size": v.0.len(),
                        "from_string_data": false,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // string_data is write-only on the API; the apiserver merges it into
    // `data` before returning. In practice a fresh GET shouldn't surface it,
    // but include it for parity if it does.
    if let Some(sd) = sec.string_data.as_ref() {
        for (k, v) in sd {
            data_entries.push(json!({
                "key": k,
                "value_b64": Value::Null,
                "size": v.len(),
                "from_string_data": true,
            }));
        }
    }

    json!({
        "meta": meta,
        "type_": secret_type,
        "immutable": immutable,
        "data": data_entries,
    })
}
