use k8s_openapi::api::core::v1::LimitRange;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct LimitRangeSpec;

impl KindSpec for LimitRangeSpec {
    type K = LimitRange;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "limitranges",
            group: "",
            version: "v1",
            kind: "LimitRange",
            plural: "limitranges",
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
                    id: "limit_count",
                    header: "Limits",
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

    fn project(lr: &LimitRange) -> Value {
        let meta = &lr.metadata;
        let limit_count = lr.spec.as_ref().map_or(0, |s| s.limits.len());

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "limit_count": limit_count,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(lr: &LimitRange) -> Value {
    let meta = project_meta(&lr.metadata);
    let limits: Vec<Value> = lr
        .spec
        .as_ref()
        .map(|s| {
            s.limits
                .iter()
                .map(|item| {
                    // Each LimitRangeItem is keyed by `type_` (Container,
                    // Pod, PersistentVolumeClaim, ...). The five quantity
                    // maps below are all keyed by resource name (cpu,
                    // memory, ephemeral-storage, …) — flatten each into a
                    // [name, value] tuple list so the UI can grid them.
                    let to_pairs = |m: Option<
                        &std::collections::BTreeMap<
                            String,
                            k8s_openapi::apimachinery::pkg::api::resource::Quantity,
                        >,
                    >|
                     -> Vec<Value> {
                        m.map(|m| m.iter().map(|(k, v)| json!([k, v.0.clone()])).collect())
                            .unwrap_or_default()
                    };
                    json!({
                        "type_": item.type_.clone(),
                        "max": to_pairs(item.max.as_ref()),
                        "min": to_pairs(item.min.as_ref()),
                        "default": to_pairs(item.default.as_ref()),
                        "default_request": to_pairs(item.default_request.as_ref()),
                        "max_limit_request_ratio": to_pairs(item.max_limit_request_ratio.as_ref()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "meta": meta,
        "limits": limits,
    })
}
