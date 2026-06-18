//! `fs_global_forward_{list,namespace,service,close}` — agent control of
//! global (DNS) port-forwarding.
//!
//! Unlike `fs_port_forward_*` (localhost:port, no privilege), these route
//! through the **privileged helper**: the first enable in a session triggers an
//! OS elevation prompt (pkexec / osascript / UAC), then per-service loopback IPs
//! and `/etc/hosts` DNS names are created so services are reachable by their
//! in-cluster names (e.g. `api.default.svc.cluster.local`). All Write category —
//! they mutate host networking + the system hosts file.
//!
//! Lifetime: global sessions are **session-scoped**. They are NOT persisted, and
//! are torn down automatically when the app exits (hosts block stripped, aliases
//! dropped). Disconnecting/switching cluster does not auto-disable them in v1 —
//! call `fs_global_forward_close` explicitly.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::globalfwd::GlobalForwardManager;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct NamespaceArgs {
    namespace: String,
}

#[derive(Debug, Deserialize)]
struct ServiceArgs {
    namespace: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct CloseArgs {
    id: String,
}

pub(crate) struct GlobalForwardList {
    app: AppHandle,
}

impl GlobalForwardList {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl NativeTool for GlobalForwardList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_global_forward_list".to_string(),
            description: "List active global forward sessions. Each entry has its \
                session id plus per-service loopback IP, the in-cluster DNS hostnames registered \
                for it, and forwarded ports."
                .to_string(),
            parameters: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, _args: Value) -> Result<Value, NativeToolError> {
        let gf = self.app.state::<GlobalForwardManager>();
        let sessions = gf.list().await;
        let status = gf.status().await;
        Ok(json!({
            "helper_status": serde_json::to_value(status).unwrap_or(Value::Null),
            "sessions": serde_json::to_value(sessions).unwrap_or(Value::Null),
        }))
    }
}

pub(crate) struct GlobalForwardNamespace {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl GlobalForwardNamespace {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for GlobalForwardNamespace {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_global_forward_namespace".to_string(),
            description: "Enable global forwarding for EVERY service in a namespace: each gets a \
                dedicated 127.x.x.x loopback IP keeping its real port, plus /etc/hosts entries so \
                it resolves by in-cluster DNS name. The FIRST global forward in a session triggers \
                an OS elevation prompt (admin/root needed for loopback aliases + hosts file). \
                Session-scoped: not persisted, auto-removed on app exit. Returns the session id and \
                the per-service IP/hostnames."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "namespace": { "type": "string" } },
                "required": ["namespace"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: NamespaceArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let gf = self.app.state::<GlobalForwardManager>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let snap = gf
            .enable_namespace(
                entry.cluster.client(),
                &state.portforwards,
                &cluster_id,
                &a.namespace,
            )
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(serde_json::to_value(snap).unwrap_or(Value::Null))
    }
}

pub(crate) struct GlobalForwardService {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl GlobalForwardService {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for GlobalForwardService {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_global_forward_service".to_string(),
            description: "Enable global forwarding for a single named service: a dedicated \
                127.x.x.x loopback IP keeping its real port(s), plus /etc/hosts DNS names. First \
                global forward in a session prompts for OS elevation. Session-scoped (not \
                persisted, auto-removed on app exit)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string", "description": "Service name." }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: ServiceArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let gf = self.app.state::<GlobalForwardManager>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let snap = gf
            .enable_service(
                entry.cluster.client(),
                &state.portforwards,
                &cluster_id,
                &a.namespace,
                &a.name,
            )
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(serde_json::to_value(snap).unwrap_or(Value::Null))
    }
}

pub(crate) struct GlobalForwardClose {
    app: AppHandle,
}

impl GlobalForwardClose {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl NativeTool for GlobalForwardClose {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_global_forward_close".to_string(),
            description: "Disable one global forward session by id (from fs_global_forward_list): \
                stops its listeners, drops its loopback aliases, and removes its /etc/hosts \
                entries. Idempotent."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
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
        let gf = self.app.state::<GlobalForwardManager>();
        gf.disable(&state.portforwards, &a.id)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(json!({ "id": a.id, "disabled": true }))
    }
}
