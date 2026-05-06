use k8s_openapi::api::core::v1::PersistentVolumeClaim;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct PersistentVolumeClaimSpec;

impl KindSpec for PersistentVolumeClaimSpec {
    type K = PersistentVolumeClaim;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "persistentvolumeclaims",
            group: "",
            version: "v1",
            kind: "PersistentVolumeClaim",
            plural: "persistentvolumeclaims",
            namespaced: true,
            category: Category::Storage,
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
                    id: "phase",
                    header: "Status",
                    kind: Some(ColumnKind::Phase),
                },
                ColumnDef {
                    id: "volume",
                    header: "Volume",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "capacity",
                    header: "Capacity",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "access_modes",
                    header: "Access Modes",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "storage_class",
                    header: "StorageClass",
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

    fn project(pvc: &PersistentVolumeClaim) -> Value {
        let meta = &pvc.metadata;
        let spec = pvc.spec.as_ref();
        let status = pvc.status.as_ref();
        let phase = status
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".to_owned());
        let volume = spec.and_then(|s| s.volume_name.clone()).unwrap_or_default();
        let capacity = status
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map(|q| q.0.clone())
            .unwrap_or_default();
        let access_modes = spec
            .and_then(|s| s.access_modes.as_ref())
            .map(|m| {
                m.iter()
                    .map(|x| match x.as_str() {
                        "ReadWriteOnce" => "RWO",
                        "ReadOnlyMany" => "ROX",
                        "ReadWriteMany" => "RWX",
                        "ReadWriteOncePod" => "RWOP",
                        _ => "?",
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let storage_class = spec
            .and_then(|s| s.storage_class_name.clone())
            .unwrap_or_default();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "phase": phase,
            "volume": volume,
            "capacity": capacity,
            "access_modes": access_modes,
            "storage_class": storage_class,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + status (phase, conditions, capacity) and
/// spec (volumeName, storageClassName, accessModes, requested storage, volume
/// mode, dataSource). Cross-kind references (volumeName → PV, storageClassName
/// → StorageClass) are surfaced as separate fields so the UI can render them
/// as `LinkValue`s without re-deriving the kind name.
pub fn project_detail(pvc: &PersistentVolumeClaim) -> Value {
    let meta = project_meta(&pvc.metadata);
    let spec = pvc.spec.as_ref();
    let status = pvc.status.as_ref();

    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".to_owned());
    let access_modes: Vec<String> = spec
        .and_then(|s| s.access_modes.as_ref())
        .cloned()
        .unwrap_or_default();
    let volume_name = spec.and_then(|s| s.volume_name.clone());
    let storage_class = spec.and_then(|s| s.storage_class_name.clone());
    let volume_mode = spec.and_then(|s| s.volume_mode.clone());
    let requested_storage = spec
        .and_then(|s| s.resources.as_ref())
        .and_then(|r| r.requests.as_ref())
        .and_then(|m| m.get("storage"))
        .map(|q| q.0.clone());
    let capacity = status
        .and_then(|s| s.capacity.as_ref())
        .and_then(|c| c.get("storage"))
        .map(|q| q.0.clone());
    let allocated_resources: Vec<Value> = status
        .and_then(|s| s.allocated_resources.as_ref())
        .map(|m| m.iter().map(|(k, v)| json!([k, v.0.clone()])).collect())
        .unwrap_or_default();

    let data_source = spec.and_then(|s| s.data_source.as_ref()).map(|r| {
        json!({
            "kind": r.kind.clone(),
            "name": r.name.clone(),
            "api_group": r.api_group.clone(),
        })
    });
    let data_source_ref = spec.and_then(|s| s.data_source_ref.as_ref()).map(|r| {
        json!({
            "kind": r.kind.clone(),
            "name": r.name.clone(),
            "api_group": r.api_group.clone(),
            "namespace": r.namespace.clone(),
        })
    });

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

    let selector_labels: Vec<Value> = spec
        .and_then(|s| s.selector.as_ref())
        .and_then(|sel| sel.match_labels.as_ref())
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let selector_expressions = spec
        .and_then(|s| s.selector.as_ref())
        .and_then(|sel| sel.match_expressions.as_ref())
        .map_or(0, std::vec::Vec::len);

    json!({
        "meta": meta,
        "phase": phase,
        "volume_name": volume_name,
        "storage_class": storage_class,
        "access_modes": access_modes,
        "volume_mode": volume_mode,
        "requested_storage": requested_storage,
        "capacity": capacity,
        "allocated_resources": allocated_resources,
        "data_source": data_source,
        "data_source_ref": data_source_ref,
        "selector": {
            "match_labels": selector_labels,
            "match_expressions": selector_expressions,
        },
        "conditions": conditions,
    })
}
