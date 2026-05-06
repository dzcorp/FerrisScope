use k8s_openapi::api::core::v1::PersistentVolume;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct PersistentVolumeSpec;

impl KindSpec for PersistentVolumeSpec {
    type K = PersistentVolume;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "persistentvolumes",
            group: "",
            version: "v1",
            kind: "PersistentVolume",
            plural: "persistentvolumes",
            namespaced: false,
            category: Category::Storage,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
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
                    id: "reclaim_policy",
                    header: "Reclaim",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "phase",
                    header: "Status",
                    kind: Some(ColumnKind::Phase),
                },
                ColumnDef {
                    id: "claim",
                    header: "Claim",
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

    fn project(pv: &PersistentVolume) -> Value {
        let meta = &pv.metadata;
        let spec = pv.spec.as_ref();
        let capacity = spec
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map(|q| q.0.clone())
            .unwrap_or_else(|| "—".to_owned());
        let access_modes = spec
            .and_then(|s| s.access_modes.as_ref())
            .map(|m| {
                m.iter()
                    .map(|x| short_mode(x))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let reclaim_policy = spec
            .and_then(|s| s.persistent_volume_reclaim_policy.clone())
            .unwrap_or_else(|| "—".to_owned());
        let phase = pv
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".to_owned());
        let claim = spec
            .and_then(|s| s.claim_ref.as_ref())
            .and_then(|r| match (r.namespace.as_ref(), r.name.as_ref()) {
                (Some(ns), Some(n)) => Some(format!("{ns}/{n}")),
                _ => None,
            })
            .unwrap_or_default();
        let storage_class = spec
            .and_then(|s| s.storage_class_name.clone())
            .unwrap_or_default();

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "capacity": capacity,
            "access_modes": access_modes,
            "reclaim_policy": reclaim_policy,
            "phase": phase,
            "claim": claim,
            "storage_class": storage_class,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + spec (capacity, access modes, reclaim
/// policy, storage class, claim ref, source type, mount options, node
/// affinity summary) + status (phase, message, reason). The `source` field
/// is a `(type, summary)` tuple so the UI can render "csi · driver/handle"
/// without parsing every variant. Node affinity is summarised as a count of
/// `nodeSelectorTerms` since the full structure is too rich for a side panel.
pub fn project_detail(pv: &PersistentVolume) -> Value {
    let meta = project_meta(&pv.metadata);
    let spec = pv.spec.as_ref();
    let status = pv.status.as_ref();

    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".to_owned());
    let phase_message = status.and_then(|s| s.message.clone());
    let phase_reason = status.and_then(|s| s.reason.clone());

    let capacity = spec
        .and_then(|s| s.capacity.as_ref())
        .and_then(|c| c.get("storage"))
        .map(|q| q.0.clone());
    let access_modes: Vec<String> = spec
        .and_then(|s| s.access_modes.as_ref())
        .cloned()
        .unwrap_or_default();
    let reclaim_policy = spec.and_then(|s| s.persistent_volume_reclaim_policy.clone());
    let storage_class = spec.and_then(|s| s.storage_class_name.clone());
    let volume_mode = spec.and_then(|s| s.volume_mode.clone());
    let mount_options: Vec<String> = spec
        .and_then(|s| s.mount_options.as_ref())
        .cloned()
        .unwrap_or_default();

    let claim_ref = spec.and_then(|s| s.claim_ref.as_ref()).map(|r| {
        json!({
            "kind": r.kind.clone(),
            "namespace": r.namespace.clone(),
            "name": r.name.clone(),
            "uid": r.uid.clone(),
        })
    });

    // ── Volume source — pick the populated variant and reduce it to a
    // human-readable summary. We want operators to see "what kind of
    // backend" + "where" without dumping every CSI parameter.
    let (source_type, source_summary) = pv
        .spec
        .as_ref()
        .map(volume_source_summary)
        .unwrap_or((None, None));

    // ── Node affinity — full required.nodeSelectorTerms struct is too
    // large; surface the term count and the unique key set instead.
    let (na_term_count, na_keys) = spec
        .and_then(|s| s.node_affinity.as_ref())
        .and_then(|na| na.required.as_ref())
        .map(|req| {
            let terms = &req.node_selector_terms;
            let mut keys: Vec<String> = Vec::new();
            for t in terms {
                if let Some(exprs) = t.match_expressions.as_ref() {
                    for e in exprs {
                        if !keys.iter().any(|k| k == &e.key) {
                            keys.push(e.key.clone());
                        }
                    }
                }
                if let Some(fields) = t.match_fields.as_ref() {
                    for f in fields {
                        if !keys.iter().any(|k| k == &f.key) {
                            keys.push(f.key.clone());
                        }
                    }
                }
            }
            (terms.len(), keys)
        })
        .unwrap_or((0, Vec::new()));

    json!({
        "meta": meta,
        "phase": phase,
        "phase_message": phase_message,
        "phase_reason": phase_reason,
        "capacity": capacity,
        "access_modes": access_modes,
        "reclaim_policy": reclaim_policy,
        "storage_class": storage_class,
        "volume_mode": volume_mode,
        "mount_options": mount_options,
        "claim_ref": claim_ref,
        "source_type": source_type,
        "source_summary": source_summary,
        "node_affinity": {
            "term_count": na_term_count,
            "keys": na_keys,
        },
    })
}

/// Returns `(source_type, summary)` for the populated volume source on a PV
/// spec. The summary string is a one-line operator-friendly digest — driver +
/// volumeHandle for CSI, server + path for NFS, etc.
fn volume_source_summary(
    s: &k8s_openapi::api::core::v1::PersistentVolumeSpec,
) -> (Option<String>, Option<String>) {
    if let Some(c) = s.csi.as_ref() {
        return (
            Some("CSI".to_owned()),
            Some(format!("{} · {}", c.driver, c.volume_handle)),
        );
    }
    if let Some(h) = s.host_path.as_ref() {
        return (Some("HostPath".to_owned()), Some(h.path.clone()));
    }
    if let Some(n) = s.nfs.as_ref() {
        return (
            Some("NFS".to_owned()),
            Some(format!("{}:{}", n.server, n.path)),
        );
    }
    if let Some(i) = s.iscsi.as_ref() {
        return (
            Some("iSCSI".to_owned()),
            Some(format!("{} / {}", i.target_portal, i.iqn)),
        );
    }
    if let Some(l) = s.local.as_ref() {
        return (Some("Local".to_owned()), Some(l.path.clone()));
    }
    if let Some(c) = s.cephfs.as_ref() {
        return (Some("CephFS".to_owned()), Some(c.monitors.join(",")));
    }
    if let Some(r) = s.rbd.as_ref() {
        return (
            Some("RBD".to_owned()),
            Some(format!("{} / {}", r.monitors.join(","), r.image)),
        );
    }
    if let Some(g) = s.glusterfs.as_ref() {
        return (
            Some("Glusterfs".to_owned()),
            Some(format!("{} / {}", g.endpoints, g.path)),
        );
    }
    if s.fc.is_some() {
        return (Some("FC".to_owned()), None);
    }
    if let Some(a) = s.azure_disk.as_ref() {
        return (
            Some("AzureDisk".to_owned()),
            Some(format!("{} · {}", a.disk_name, a.disk_uri)),
        );
    }
    if let Some(a) = s.azure_file.as_ref() {
        return (
            Some("AzureFile".to_owned()),
            Some(format!("{} / {}", a.secret_name, a.share_name)),
        );
    }
    if let Some(g) = s.gce_persistent_disk.as_ref() {
        return (
            Some("GCEPersistentDisk".to_owned()),
            Some(g.pd_name.clone()),
        );
    }
    if let Some(a) = s.aws_elastic_block_store.as_ref() {
        return (
            Some("AWSElasticBlockStore".to_owned()),
            Some(a.volume_id.clone()),
        );
    }
    if s.cinder.is_some() {
        return (Some("Cinder".to_owned()), None);
    }
    if s.flex_volume.is_some() {
        return (Some("FlexVolume".to_owned()), None);
    }
    if s.flocker.is_some() {
        return (Some("Flocker".to_owned()), None);
    }
    if s.photon_persistent_disk.is_some() {
        return (Some("PhotonPersistentDisk".to_owned()), None);
    }
    if s.portworx_volume.is_some() {
        return (Some("PortworxVolume".to_owned()), None);
    }
    if s.quobyte.is_some() {
        return (Some("Quobyte".to_owned()), None);
    }
    if s.scale_io.is_some() {
        return (Some("ScaleIO".to_owned()), None);
    }
    if s.storageos.is_some() {
        return (Some("StorageOS".to_owned()), None);
    }
    if s.vsphere_volume.is_some() {
        return (Some("vSphereVolume".to_owned()), None);
    }
    (None, None)
}

fn short_mode(m: &str) -> &'static str {
    match m {
        "ReadWriteOnce" => "RWO",
        "ReadOnlyMany" => "ROX",
        "ReadWriteMany" => "RWX",
        "ReadWriteOncePod" => "RWOP",
        _ => "?",
    }
}
