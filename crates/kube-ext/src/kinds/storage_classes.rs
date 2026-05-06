use k8s_openapi::api::storage::v1::StorageClass;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct StorageClassSpec;

impl KindSpec for StorageClassSpec {
    type K = StorageClass;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "storageclasses",
            group: "storage.k8s.io",
            version: "v1",
            kind: "StorageClass",
            plural: "storageclasses",
            namespaced: false,
            category: Category::Storage,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "provisioner",
                    header: "Provisioner",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "reclaim_policy",
                    header: "Reclaim",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "binding_mode",
                    header: "Binding Mode",
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

    fn project(sc: &StorageClass) -> Value {
        let meta = &sc.metadata;
        let reclaim = sc.reclaim_policy.clone().unwrap_or_default();
        let binding = sc.volume_binding_mode.clone().unwrap_or_default();

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "provisioner": sc.provisioner.clone(),
            "reclaim_policy": reclaim,
            "binding_mode": binding,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + spec (provisioner, reclaim policy,
/// volume binding mode, allow expansion, mount options, parameters,
/// allowedTopologies summary). The `default` flag is derived from the
/// `storageclass.kubernetes.io/is-default-class` annotation, the same way
/// `kubectl get sc` decides which class to mark.
pub fn project_detail(sc: &StorageClass) -> Value {
    let meta = project_meta(&sc.metadata);
    let is_default = sc
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("storageclass.kubernetes.io/is-default-class"))
        .map(|v| v == "true")
        .unwrap_or(false);

    let parameters: Vec<Value> = sc
        .parameters
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let mount_options: Vec<String> = sc.mount_options.clone().unwrap_or_default();

    // allowedTopologies — operators usually want to know "which keys does
    // this class restrict to" without seeing every value. Surface keys + a
    // term count.
    let (topology_term_count, topology_keys) = sc
        .allowed_topologies
        .as_ref()
        .map(|terms| {
            let mut keys: Vec<String> = Vec::new();
            for t in terms {
                if let Some(exprs) = t.match_label_expressions.as_ref() {
                    for e in exprs {
                        if !keys.iter().any(|k| k == &e.key) {
                            keys.push(e.key.clone());
                        }
                    }
                }
            }
            (terms.len(), keys)
        })
        .unwrap_or((0, Vec::new()));

    json!({
        "meta": meta,
        "provisioner": sc.provisioner.clone(),
        "reclaim_policy": sc.reclaim_policy.clone(),
        "binding_mode": sc.volume_binding_mode.clone(),
        "allow_volume_expansion": sc.allow_volume_expansion,
        "is_default": is_default,
        "parameters": parameters,
        "mount_options": mount_options,
        "allowed_topologies": {
            "term_count": topology_term_count,
            "keys": topology_keys,
        },
    })
}
