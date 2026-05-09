//! `fs_port_forward_list` / `fs_port_forward_open` / `fs_port_forward_close` —
//! agent-driven control of the shared port-forward registry.
//!
//! Forwards opened by the agent live in the same `state.portforwards` table
//! the operator UI uses, so the operator sees them in the dock and can close
//! them by hand. They are NOT torn down on `chat_close`: a port-forward is
//! operator-owned by design, the agent just opens or closes one explicitly.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_core::portforwards::{self, ForwardSpec, ForwardTarget};
use ferrisscope_kube_ext::start_forward;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct OpenArgs {
    kind: String,
    namespace: String,
    name: String,
    remote_port: u16,
    #[serde(default)]
    requested_local_port: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct CloseArgs {
    id: String,
}

pub(crate) struct PortForwardList {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PortForwardList {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PortForwardList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_port_forward_list".to_string(),
            description:
                "List active port-forwards in this cluster. Returns one entry per forward with \
                its id, target, remote/local ports, status, and pinned flag. Forwards opened by \
                the operator and the agent share one table — both are visible here."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, _args: Value) -> Result<Value, NativeToolError> {
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let map = state.portforwards.by_id.lock().await;
        let mut out: Vec<Value> = Vec::with_capacity(map.len());
        for handle in map.values() {
            if handle.spec.cluster_id != cluster_id {
                continue;
            }
            let snap = ferrisscope_kube_ext::forward_snapshot(handle).await;
            out.push(json!({
                "id": snap.spec.id,
                "kind": snap.spec.target.kind,
                "namespace": snap.spec.target.namespace,
                "name": snap.spec.target.name,
                "remote_port": snap.spec.remote_port,
                "local_port": snap.actual_local_port,
                "pinned": snap.spec.autostart,
                "status": snap.status,
                "local_url": format!("http://localhost:{}", snap.actual_local_port),
            }));
        }
        Ok(json!({ "cluster_id": cluster_id, "forwards": out }))
    }
}

pub(crate) struct PortForwardOpen {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PortForwardOpen {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PortForwardOpen {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_port_forward_open".to_string(),
            description:
                "Open a port-forward to a Service / Deployment / StatefulSet / DaemonSet / Job / \
                Pod. Returns the bound `local_port` and a ready-to-use `local_url` \
                (`http://localhost:<port>`) the agent can probe with `fs_http_fetch`. \
                Duplicate-safe: starting a forward whose (kind, namespace, name, remote_port) \
                already exists returns the existing entry. Forwards are NOT auto-closed at chat \
                end — call `fs_port_forward_close` when you are done so the operator's dock stays \
                clean."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["Pod", "Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]
                    },
                    "namespace": { "type": "string" },
                    "name": { "type": "string" },
                    "remote_port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                    "requested_local_port": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 65535,
                        "description": "Optional. Omit to bind a random free port."
                    }
                },
                "required": ["kind", "namespace", "name", "remote_port"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: OpenArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let target = ForwardTarget {
            kind: a.kind.clone(),
            namespace: a.namespace.clone(),
            name: a.name.clone(),
        };
        let id = portforwards::make_id(&cluster_id, &target, a.remote_port);
        {
            let map = state.portforwards.by_id.lock().await;
            if let Some(existing) = map.get(&id) {
                let snap = ferrisscope_kube_ext::forward_snapshot(existing).await;
                return Ok(open_result(&snap, true));
            }
        }
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let spec = ForwardSpec {
            id: id.clone(),
            cluster_id: cluster_id.clone(),
            target,
            remote_port: a.remote_port,
            requested_local_port: a.requested_local_port,
            autostart: false,
        };
        let handle = start_forward(
            entry.cluster.client(),
            spec,
            state.portforwards.status_tx.clone(),
        )
        .await
        .map_err(|e| NativeToolError::msg(e.to_string()))?;
        let snap = ferrisscope_kube_ext::forward_snapshot(&handle).await;
        state.portforwards.by_id.lock().await.insert(id, handle);
        Ok(open_result(&snap, false))
    }
}

fn open_result(snap: &ferrisscope_kube_ext::ForwardEntry, already_running: bool) -> Value {
    json!({
        "id": snap.spec.id,
        "kind": snap.spec.target.kind,
        "namespace": snap.spec.target.namespace,
        "name": snap.spec.target.name,
        "remote_port": snap.spec.remote_port,
        "local_port": snap.actual_local_port,
        "local_url": format!("http://localhost:{}", snap.actual_local_port),
        "status": snap.status,
        "already_running": already_running,
    })
}

pub(crate) struct PortForwardClose {
    app: AppHandle,
}

impl PortForwardClose {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl NativeTool for PortForwardClose {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_port_forward_close".to_string(),
            description:
                "Close one port-forward by id. Idempotent — closing an already-closed forward \
                succeeds with `closed: false`."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Forward id from fs_port_forward_list/open." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: CloseArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let removed = state.portforwards.by_id.lock().await.remove(&a.id);
        let closed = removed.is_some();
        if closed {
            let _ = state
                .portforwards
                .status_tx
                .send((a.id.clone(), ferrisscope_kube_ext::ForwardStatus::Stopped));
            state.portforwards.pin_overrides.lock().await.remove(&a.id);
        }
        Ok(json!({ "id": a.id, "closed": closed }))
    }
}
