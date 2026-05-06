use k8s_openapi::api::core::v1::ResourceQuota;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ResourceQuotaSpec;

impl KindSpec for ResourceQuotaSpec {
    type K = ResourceQuota;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "resourcequotas",
            group: "",
            version: "v1",
            kind: "ResourceQuota",
            plural: "resourcequotas",
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
                    id: "limits",
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

    fn project(rq: &ResourceQuota) -> Value {
        let meta = &rq.metadata;
        let hard_count = rq
            .spec
            .as_ref()
            .and_then(|s| s.hard.as_ref())
            .map_or(0, std::collections::BTreeMap::len);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "limits": hard_count,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(rq: &ResourceQuota) -> Value {
    let meta = project_meta(&rq.metadata);
    let spec = rq.spec.as_ref();
    let status = rq.status.as_ref();

    // Pair hard/used by resource name so the UI can render one row per
    // resource with its limit and current consumption side-by-side. A
    // resource may appear in `hard` but not yet in `used` (and vice-versa
    // during quota recompute), so we union the key sets.
    let hard = spec.and_then(|s| s.hard.as_ref());
    let used = status.and_then(|s| s.used.as_ref());
    let mut keys: std::collections::BTreeSet<&String> = std::collections::BTreeSet::new();
    if let Some(h) = hard {
        keys.extend(h.keys());
    }
    if let Some(u) = used {
        keys.extend(u.keys());
    }
    let entries: Vec<Value> = keys
        .into_iter()
        .map(|k| {
            json!({
                "name": k,
                "hard": hard.and_then(|m| m.get(k)).map(|q| q.0.clone()),
                "used": used.and_then(|m| m.get(k)).map(|q| q.0.clone()),
            })
        })
        .collect();

    let scopes: Vec<String> = spec
        .and_then(|s| s.scopes.as_ref())
        .cloned()
        .unwrap_or_default();
    let scope_selector: Vec<Value> = spec
        .and_then(|s| s.scope_selector.as_ref())
        .and_then(|ss| ss.match_expressions.as_ref())
        .map(|exprs| {
            exprs
                .iter()
                .map(|e| {
                    json!({
                        "scope_name": e.scope_name.clone(),
                        "operator": e.operator.clone(),
                        "values": e.values.clone().unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "meta": meta,
        "entries": entries,
        "scopes": scopes,
        "scope_selector": scope_selector,
    })
}
