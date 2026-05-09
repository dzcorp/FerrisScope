//! `fs_pod_diagnose` and `fs_node_diagnose` — one-shot triage tools.
//!
//! Both pull the standard "why is this thing broken" report into a single
//! tool result instead of forcing the agent to assemble it from N separate
//! list/get calls.

use std::collections::BTreeMap;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::core::v1::{Event, Node, Pod};
use kube::api::{Api, ListParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

/// Cap on events returned per call. The apiserver itself bounds events to a
/// short retention (~1h by default), but a flapping pod can produce hundreds
/// in that window. We keep the most recent N to stay within the LLM's token
/// budget.
const MAX_EVENTS: usize = 30;

#[derive(Debug, Deserialize)]
struct PodArgs {
    namespace: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct NodeArgs {
    name: String,
}

pub(crate) struct PodDiagnose {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PodDiagnose {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PodDiagnose {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pod_diagnose".to_string(),
            description: "Pod triage in one call: phase, container statuses (ready/restarts/\
                last-state), owner refs, recent events. Replaces pods_get + events_list."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: PodArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let pods_api: Api<Pod> = Api::namespaced(client.clone(), &a.namespace);
        let pod = pods_api.get(&a.name).await.map_err(kube_err)?;

        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into());
        let pod_uid = pod.metadata.uid.clone().unwrap_or_default();
        let owner_refs: Vec<Value> = pod
            .metadata
            .owner_references
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|o| {
                json!({
                    "kind": o.kind,
                    "name": o.name,
                    "controller": o.controller,
                })
            })
            .collect();

        let containers = container_states(pod.status.as_ref());
        let init_containers = init_states(pod.status.as_ref());
        let conditions: Vec<Value> = pod
            .status
            .as_ref()
            .and_then(|s| s.conditions.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|c| {
                json!({
                    "type": c.type_,
                    "status": c.status,
                    "reason": c.reason,
                    "message": c.message,
                })
            })
            .collect();

        let events = recent_events(&client, &a.namespace, "Pod", &a.name, &pod_uid).await;

        Ok(json!({
            "namespace": a.namespace,
            "name": a.name,
            "uid": pod_uid,
            "phase": phase,
            "node": pod.spec.as_ref().and_then(|s| s.node_name.clone()),
            "qos_class": pod.status.as_ref().and_then(|s| s.qos_class.clone()),
            "pod_ip": pod.status.as_ref().and_then(|s| s.pod_ip.clone()),
            "host_ip": pod.status.as_ref().and_then(|s| s.host_ip.clone()),
            "start_time": pod.status.as_ref().and_then(|s| s.start_time.clone()).map(|t| t.0.to_string()),
            "owner_refs": owner_refs,
            "init_containers": init_containers,
            "containers": containers,
            "conditions": conditions,
            "reason": pod.status.as_ref().and_then(|s| s.reason.clone()),
            "message": pod.status.as_ref().and_then(|s| s.message.clone()),
            "events": events,
        }))
    }
}

pub(crate) struct NodeDiagnose {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl NodeDiagnose {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for NodeDiagnose {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_diagnose".to_string(),
            description: "Node triage: conditions, capacity vs allocatable, taints, addresses \
                (ExternalIP/InternalIP/Hostname), pods on the node, recent events. Pairs with \
                fs_node_shell_open (debug pod) or fs_node_ssh_open (direct SSH fallback)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: NodeArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let nodes: Api<Node> = Api::all(client.clone());
        let node = nodes.get(&a.name).await.map_err(kube_err)?;
        let node_uid = node.metadata.uid.clone().unwrap_or_default();
        let status = node.status.unwrap_or_default();
        let conditions: Vec<Value> = status
            .conditions
            .unwrap_or_default()
            .into_iter()
            .map(|c| {
                json!({
                    "type": c.type_,
                    "status": c.status,
                    "reason": c.reason,
                    "message": c.message,
                    "last_transition": c.last_transition_time.map(|t| t.0.to_string()),
                })
            })
            .collect();
        let capacity = status.capacity.map(quantities_to_value);
        let allocatable = status.allocatable.map(quantities_to_value);
        let addresses: Vec<Value> = status
            .addresses
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|a| {
                json!({
                    "type": a.type_,
                    "address": a.address,
                })
            })
            .collect();
        let taints: Vec<Value> = node
            .spec
            .and_then(|s| s.taints)
            .unwrap_or_default()
            .into_iter()
            .map(|t| {
                json!({
                    "key": t.key,
                    "value": t.value,
                    "effect": t.effect,
                })
            })
            .collect();

        // Pods on this node — field selector is evaluated server-side so we
        // don't pull every pod in the cluster.
        let pods_api: Api<Pod> = Api::all(client.clone());
        let lp = ListParams::default().fields(&format!("spec.nodeName={}", a.name));
        let pods = pods_api.list(&lp).await.map_err(kube_err)?;
        let mut by_phase: BTreeMap<String, u64> = BTreeMap::new();
        let mut not_ready: Vec<Value> = Vec::new();
        for p in &pods.items {
            let phase = p
                .status
                .as_ref()
                .and_then(|s| s.phase.clone())
                .unwrap_or_else(|| "Unknown".into());
            *by_phase.entry(phase.clone()).or_insert(0) += 1;
            if phase != "Running" && phase != "Succeeded" && not_ready.len() < 20 {
                not_ready.push(json!({
                    "namespace": p.metadata.namespace,
                    "name": p.metadata.name,
                    "phase": phase,
                    "reason": p.status.as_ref().and_then(|s| s.reason.clone()),
                }));
            }
        }

        let events = recent_events(&client, "", "Node", &a.name, &node_uid).await;

        Ok(json!({
            "name": a.name,
            "uid": node_uid,
            "node_info": status.node_info.map(|i| json!({
                "kernel_version": i.kernel_version,
                "os_image": i.os_image,
                "container_runtime_version": i.container_runtime_version,
                "kubelet_version": i.kubelet_version,
                "architecture": i.architecture,
            })),
            "conditions": conditions,
            "capacity": capacity,
            "allocatable": allocatable,
            "addresses": addresses,
            "taints": taints,
            "pods": {
                "total": pods.items.len(),
                "by_phase": by_phase,
                "not_ready_sample": not_ready,
            },
            "events": events,
        }))
    }
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

fn quantities_to_value(
    m: std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>,
) -> Value {
    let mut out = serde_json::Map::new();
    for (k, v) in m {
        out.insert(k, Value::String(v.0));
    }
    Value::Object(out)
}

fn container_states(status: Option<&k8s_openapi::api::core::v1::PodStatus>) -> Vec<Value> {
    status
        .and_then(|s| s.container_statuses.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let (state, reason, message, exit_code) = match c.state.as_ref() {
                Some(st) if st.waiting.is_some() => {
                    let w = st.waiting.as_ref().unwrap();
                    (
                        "Waiting".to_string(),
                        w.reason.clone(),
                        w.message.clone(),
                        None,
                    )
                }
                Some(st) if st.terminated.is_some() => {
                    let t = st.terminated.as_ref().unwrap();
                    (
                        "Terminated".to_string(),
                        t.reason.clone(),
                        t.message.clone(),
                        Some(t.exit_code),
                    )
                }
                Some(st) if st.running.is_some() => ("Running".to_string(), None, None, None),
                _ => ("Unknown".to_string(), None, None, None),
            };
            let last_term = c.last_state.as_ref().and_then(|s| s.terminated.as_ref());
            json!({
                "name": c.name,
                "image": c.image,
                "image_id": c.image_id,
                "ready": c.ready,
                "started": c.started,
                "restart_count": c.restart_count,
                "state": state,
                "state_reason": reason,
                "state_message": message,
                "state_exit_code": exit_code,
                "last_termination": last_term.map(|t| json!({
                    "reason": t.reason,
                    "message": t.message,
                    "exit_code": t.exit_code,
                    "signal": t.signal,
                    "finished_at": t.finished_at.as_ref().map(|t| t.0.to_string()),
                })),
            })
        })
        .collect()
}

fn init_states(status: Option<&k8s_openapi::api::core::v1::PodStatus>) -> Vec<Value> {
    status
        .and_then(|s| s.init_container_statuses.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            json!({
                "name": c.name,
                "ready": c.ready,
                "restart_count": c.restart_count,
                "state": c.state.as_ref().map(state_label),
            })
        })
        .collect()
}

fn state_label(s: &k8s_openapi::api::core::v1::ContainerState) -> &'static str {
    if s.waiting.is_some() {
        "Waiting"
    } else if s.terminated.is_some() {
        "Terminated"
    } else if s.running.is_some() {
        "Running"
    } else {
        "Unknown"
    }
}

/// Recent events scoped to one object. Tries `involvedObject.uid` first
/// (server-side filter, exact match); falls back to `involvedObject.kind`
/// + `involvedObject.name` if uid filtering surfaces no rows. Returns the
///   MAX_EVENTS most recent, sorted newest-first.
async fn recent_events(
    client: &kube::Client,
    namespace: &str,
    kind: &str,
    name: &str,
    uid: &str,
) -> Vec<Value> {
    let api: Api<Event> = if namespace.is_empty() {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let mut items: Vec<Event> = Vec::new();
    if !uid.is_empty() {
        let lp = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
        if let Ok(list) = api.list(&lp).await {
            items = list.items;
        }
    }
    if items.is_empty() {
        let lp = ListParams::default().fields(&format!(
            "involvedObject.kind={kind},involvedObject.name={name}"
        ));
        if let Ok(list) = api.list(&lp).await {
            items = list.items;
        }
    }
    items.sort_by_key(|e| std::cmp::Reverse(event_ts(e)));
    items
        .into_iter()
        .take(MAX_EVENTS)
        .map(|e| {
            json!({
                "type": e.type_,
                "reason": e.reason,
                "message": e.message,
                "count": e.count,
                "first_seen": e.first_timestamp.as_ref().map(|t| t.0.to_string()),
                "last_seen": e.last_timestamp.as_ref().map(|t| t.0.to_string()),
                "source": e.source.as_ref().and_then(|s| s.component.clone()),
            })
        })
        .collect()
}

fn event_ts(e: &Event) -> Option<k8s_openapi::jiff::Timestamp> {
    e.last_timestamp
        .as_ref()
        .map(|t| t.0)
        .or_else(|| e.first_timestamp.as_ref().map(|t| t.0))
        .or_else(|| e.event_time.as_ref().map(|t| t.0))
}
