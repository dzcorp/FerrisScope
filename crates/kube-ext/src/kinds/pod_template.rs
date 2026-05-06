//! Compact summary of a `PodTemplateSpec` shared by every workload kind
//! (Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob.jobTemplate).
//!
//! The summary deliberately stays small — operators reading a workload detail
//! panel want to know "what does each pod look like" without drowning under
//! per-container probe / env / mount lists. For that depth, the operator
//! pivots to an actual Pod's detail panel (every workload page lists its
//! pods, conceptually) or the YAML tab.

use k8s_openapi::api::core::v1::{Container, PodTemplateSpec, Volume};
use serde_json::{json, Value};

/// Project a single PodTemplateSpec volume into the same shape Pod uses
/// (`name`, `kind` tag, `source_name` if any, `target_kind`, opaque `raw`
/// blob for round-tripping unsupported source variants through the editor).
fn volume_value(v: &Volume) -> Value {
    let (kind, source_name, target_kind): (&'static str, Option<String>, Option<&'static str>) =
        if let Some(s) = v.config_map.as_ref() {
            ("configMap", Some(s.name.clone()), Some("ConfigMap"))
        } else if let Some(s) = v.secret.as_ref() {
            ("secret", s.secret_name.clone(), Some("Secret"))
        } else if let Some(s) = v.persistent_volume_claim.as_ref() {
            (
                "persistentVolumeClaim",
                Some(s.claim_name.clone()),
                Some("PersistentVolumeClaim"),
            )
        } else if v.projected.is_some() {
            ("projected", None, None)
        } else if v.empty_dir.is_some() {
            ("emptyDir", None, None)
        } else if let Some(s) = v.host_path.as_ref() {
            ("hostPath", Some(s.path.clone()), None)
        } else if v.downward_api.is_some() {
            ("downwardAPI", None, None)
        } else if let Some(s) = v.csi.as_ref() {
            ("csi", Some(s.driver.clone()), None)
        } else if let Some(s) = v.nfs.as_ref() {
            ("nfs", Some(format!("{}:{}", s.server, s.path)), None)
        } else if v.iscsi.is_some() {
            ("iscsi", None, None)
        } else if v.cephfs.is_some() {
            ("cephfs", None, None)
        } else if v.rbd.is_some() {
            ("rbd", None, None)
        } else if v.glusterfs.is_some() {
            ("glusterfs", None, None)
        } else if v.fc.is_some() {
            ("fc", None, None)
        } else if v.flex_volume.is_some() {
            ("flexVolume", None, None)
        } else if v.azure_disk.is_some() {
            ("azureDisk", None, None)
        } else if v.azure_file.is_some() {
            ("azureFile", None, None)
        } else if v.gce_persistent_disk.is_some() {
            ("gcePersistentDisk", None, None)
        } else if v.aws_elastic_block_store.is_some() {
            ("awsElasticBlockStore", None, None)
        } else if v.ephemeral.is_some() {
            ("ephemeral", None, None)
        } else if v.git_repo.is_some() {
            ("gitRepo", None, None)
        } else {
            ("other", None, None)
        };

    let raw = serde_json::to_value(v)
        .ok()
        .map(|mut v| {
            if let Value::Object(ref mut map) = v {
                map.remove("name");
            }
            v
        })
        .unwrap_or(Value::Null);

    json!({
        "name": v.name.clone(),
        "kind": kind,
        "source_name": source_name,
        "target_kind": target_kind,
        "raw": raw,
    })
}

/// One-line per-container shape: name, image, port count, full env list,
/// mount count, resource requests/limits. Keeps the workload detail panel
/// readable when the template has many containers; env is projected in full
/// so the editor can round-trip literal values without a second fetch.
fn summarise_container(c: &Container, kind: &'static str) -> Value {
    let ports: Vec<Value> = c
        .ports
        .as_ref()
        .map(|ps| {
            ps.iter()
                .map(|p| {
                    json!({
                        "name": p.name.clone(),
                        "container_port": p.container_port,
                        "protocol": p.protocol.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let env: Vec<Value> = c
        .env
        .as_ref()
        .map(|es| {
            es.iter()
                .map(|e| {
                    let from = e.value_from.as_ref().map(|vf| {
                        if vf.config_map_key_ref.is_some() {
                            "configMapKeyRef"
                        } else if vf.secret_key_ref.is_some() {
                            "secretKeyRef"
                        } else if vf.field_ref.is_some() {
                            "fieldRef"
                        } else if vf.resource_field_ref.is_some() {
                            "resourceFieldRef"
                        } else {
                            "valueFrom"
                        }
                    });
                    json!({
                        "name": e.name.clone(),
                        "value": e.value.clone(),
                        "from": from,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let env_from_count = c.env_from.as_ref().map_or(0, std::vec::Vec::len);
    let mounts = c.volume_mounts.as_ref().map_or(0, std::vec::Vec::len);
    let requests = c
        .resources
        .as_ref()
        .and_then(|r| r.requests.as_ref())
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), Value::String(v.0.clone())))
                .collect::<serde_json::Map<_, _>>()
        });
    let limits = c
        .resources
        .as_ref()
        .and_then(|r| r.limits.as_ref())
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), Value::String(v.0.clone())))
                .collect::<serde_json::Map<_, _>>()
        });

    json!({
        "name": c.name.clone(),
        "kind": kind,
        "image": c.image.clone(),
        "image_pull_policy": c.image_pull_policy.clone(),
        "ports": ports,
        "env": env,
        "env_from_count": env_from_count,
        "mounts_count": mounts,
        "requests": requests,
        "limits": limits,
        "command": c.command.clone(),
        "args": c.args.clone(),
    })
}

/// Compact projection for the workload detail panel.
pub fn project_pod_template_summary(template: &PodTemplateSpec) -> Value {
    let labels: Vec<Value> = template
        .metadata
        .as_ref()
        .and_then(|m| m.labels.as_ref())
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let annotations_count = template
        .metadata
        .as_ref()
        .and_then(|m| m.annotations.as_ref())
        .map_or(0, std::collections::BTreeMap::len);

    let spec = template.spec.as_ref();
    let containers: Vec<Value> = spec
        .map(|s| {
            let inits = s
                .init_containers
                .as_ref()
                .map(|cs| {
                    cs.iter().map(|c| {
                        let kind = if c.restart_policy.as_deref() == Some("Always") {
                            "sidecar"
                        } else {
                            "init"
                        };
                        summarise_container(c, kind)
                    })
                })
                .into_iter()
                .flatten();
            let mains = s.containers.iter().map(|c| summarise_container(c, "main"));
            inits.chain(mains).collect()
        })
        .unwrap_or_default();

    let node_selector: Vec<Value> = spec
        .and_then(|s| s.node_selector.as_ref())
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();

    let tolerations_count = spec
        .and_then(|s| s.tolerations.as_ref())
        .map_or(0, std::vec::Vec::len);
    let volumes: Vec<Value> = spec
        .and_then(|s| s.volumes.as_ref())
        .map(|vs| vs.iter().map(volume_value).collect())
        .unwrap_or_default();
    let image_pull_secrets: Vec<String> = spec
        .and_then(|s| s.image_pull_secrets.as_ref())
        .map(|v| v.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();

    json!({
        "labels": labels,
        "annotations_count": annotations_count,
        "containers": containers,
        "service_account": spec.and_then(|s| s.service_account_name.clone()),
        "restart_policy": spec.and_then(|s| s.restart_policy.clone()),
        "node_selector": node_selector,
        "tolerations_count": tolerations_count,
        "volumes": volumes,
        "image_pull_secrets": image_pull_secrets,
        "priority_class": spec.and_then(|s| s.priority_class_name.clone()),
        "host_network": spec.and_then(|s| s.host_network),
        "host_pid": spec.and_then(|s| s.host_pid),
        "host_ipc": spec.and_then(|s| s.host_ipc),
    })
}

/// Compact projection for a `LabelSelector`. Workloads use this to pick which
/// pods they own — the detail panel shows the matchLabels as chips and a
/// single line of "N matchExpressions" since expressions don't render nicely
/// inline.
pub fn project_label_selector(
    sel: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector>,
) -> Value {
    let Some(sel) = sel else {
        return Value::Null;
    };
    let labels: Vec<Value> = sel
        .match_labels
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let expressions = sel.match_expressions.as_ref().map_or(0, std::vec::Vec::len);
    json!({
        "match_labels": labels,
        "match_expressions": expressions,
    })
}

/// Common metadata projection — name, namespace, uid, created, labels,
/// annotations (full), controlled_by. Reused so every workload shares the same
/// detail header shape.
pub fn project_meta(meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta) -> Value {
    let labels: Vec<Value> = meta
        .labels
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let annotations: Vec<Value> = meta
        .annotations
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let controlled_by = meta
        .owner_references
        .as_ref()
        .and_then(|owners| owners.iter().find(|o| o.controller == Some(true)))
        .map(|o| json!({ "kind": o.kind.clone(), "name": o.name.clone() }));

    json!({
        "name": meta.name.clone().unwrap_or_default(),
        "namespace": meta.namespace.clone(),
        "uid": meta.uid.clone(),
        "created_at": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        "labels": labels,
        "annotations": annotations,
        "controlled_by": controlled_by,
        "generation": meta.generation,
    })
}
