use k8s_openapi::api::core::v1::Node;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct NodeSpec;

impl KindSpec for NodeSpec {
    type K = Node;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "nodes",
            group: "",
            version: "v1",
            kind: "Node",
            plural: "nodes",
            namespaced: false,
            category: Category::Cluster,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "phase",
                    header: "Status",
                    kind: Some(ColumnKind::Phase),
                },
                ColumnDef {
                    id: "roles",
                    header: "Roles",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "version",
                    header: "Version",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "cpu",
                    header: "CPU",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "memory",
                    header: "Memory",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "taints",
                    header: "Taints",
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

    fn project(node: &Node) -> Value {
        let meta = &node.metadata;
        let labels = meta.labels.as_ref();

        // Roles come from labels of the form node-role.kubernetes.io/<role>=
        let roles = labels
            .map(|l| {
                l.keys()
                    .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .filter(|s: &String| !s.is_empty())
            .unwrap_or_else(|| "<none>".to_owned());

        let status = node.status.as_ref();
        let version = status
            .and_then(|s| s.node_info.as_ref())
            .map(|n| n.kubelet_version.clone())
            .unwrap_or_default();
        let cpu = status
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("cpu"))
            .map(|q| q.0.clone())
            .unwrap_or_default();
        let memory = status
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("memory"))
            .map(|q| q.0.clone())
            .unwrap_or_default();
        let taints = node
            .spec
            .as_ref()
            .and_then(|s| s.taints.as_ref())
            .map_or(0, std::vec::Vec::len);

        // Phase: Ready if Ready=True, else NotReady. Cordoned shows separately.
        let cordoned = node
            .spec
            .as_ref()
            .and_then(|s| s.unschedulable)
            .unwrap_or(false);
        let ready_cond = status
            .and_then(|s| s.conditions.as_ref())
            .and_then(|conds| conds.iter().find(|c| c.type_ == "Ready"));
        let phase = match ready_cond {
            Some(c) if c.status == "True" && cordoned => "SchedulingDisabled",
            Some(c) if c.status == "True" => "Ready",
            Some(_) => "NotReady",
            None => "Unknown",
        };

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "phase": phase,
            "roles": roles,
            "version": version,
            "cpu": cpu,
            "memory": memory,
            "taints": taints,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection used by the detail panel. Like the Pod equivalent — fetched
// on demand, never streamed over the watcher bus. Surfaces every field the
// Lens-style Node summary renders so the renderer doesn't have to parse YAML.
pub fn project_detail(node: &Node) -> Value {
    let meta = project_meta(&node.metadata);
    let spec = node.spec.as_ref();
    let status = node.status.as_ref();

    let cordoned = spec.and_then(|s| s.unschedulable).unwrap_or(false);
    let ready_cond = status
        .and_then(|s| s.conditions.as_ref())
        .and_then(|cs| cs.iter().find(|c| c.type_ == "Ready"));
    let phase = match ready_cond {
        Some(c) if c.status == "True" && cordoned => "SchedulingDisabled",
        Some(c) if c.status == "True" => "Ready",
        Some(_) => "NotReady",
        None => "Unknown",
    };

    // Roles come from labels of the form node-role.kubernetes.io/<role>=
    // (and the older kubernetes.io/role=).
    let labels = node.metadata.labels.as_ref();
    let roles: Vec<String> = labels
        .map(|m| {
            let mut r: Vec<String> = m
                .keys()
                .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
                .map(str::to_owned)
                .collect();
            if let Some(v) = m.get("kubernetes.io/role") {
                if !r.contains(v) {
                    r.push(v.clone());
                }
            }
            r
        })
        .unwrap_or_default();

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

    let addresses: Vec<Value> = status
        .and_then(|s| s.addresses.as_ref())
        .map(|addrs| {
            addrs
                .iter()
                .map(|a| {
                    json!({
                        "type": a.type_.clone(),
                        "address": a.address.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let node_info = status.and_then(|s| s.node_info.as_ref()).map(|n| {
        json!({
            "kubelet_version": n.kubelet_version.clone(),
            "kube_proxy_version": n.kube_proxy_version.clone(),
            "container_runtime_version": n.container_runtime_version.clone(),
            "os_image": n.os_image.clone(),
            "kernel_version": n.kernel_version.clone(),
            "operating_system": n.operating_system.clone(),
            "architecture": n.architecture.clone(),
            "machine_id": n.machine_id.clone(),
            "system_uuid": n.system_uuid.clone(),
            "boot_id": n.boot_id.clone(),
        })
    });

    let capacity = status
        .and_then(|s| s.capacity.as_ref())
        .map(quantity_map)
        .unwrap_or_default();
    let allocatable = status
        .and_then(|s| s.allocatable.as_ref())
        .map(quantity_map)
        .unwrap_or_default();

    let taints: Vec<Value> = spec
        .and_then(|s| s.taints.as_ref())
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    json!({
                        "key": t.key.clone(),
                        "value": t.value.clone(),
                        "effect": t.effect.clone(),
                        "time_added": t.time_added.as_ref().map(|x| x.0.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let pod_cidrs: Vec<String> = spec
        .and_then(|s| s.pod_cidrs.clone())
        .or_else(|| spec.and_then(|s| s.pod_cidr.clone()).map(|c| vec![c]))
        .unwrap_or_default();

    json!({
        "meta": meta,
        "phase": phase,
        "roles": roles,
        "unschedulable": cordoned,
        "provider_id": spec.and_then(|s| s.provider_id.clone()),
        "pod_cidrs": pod_cidrs,
        "addresses": addresses,
        "node_info": node_info,
        "capacity": capacity,
        "allocatable": allocatable,
        "taints": taints,
        "conditions": conditions,
    })
}

// `BTreeMap<String, Quantity>` flattened into a JSON object of `String → String`
// so the frontend can render it directly without re-parsing the kube types.
fn quantity_map(
    m: &std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>,
) -> serde_json::Map<String, Value> {
    m.iter()
        .map(|(k, v)| (k.clone(), Value::String(v.0.clone())))
        .collect()
}
