//! `fs_configuration_view` + `fs_configuration_contexts_list` — kubeconfig
//! introspection so the agent knows which cluster it's actually pinned to,
//! and what other contexts the operator has registered.
//!
//! Unlike kubectl, the agent can't switch contexts mid-chat — each chat is
//! bound to one `cluster_id` at open time. The contexts-list tool is purely
//! informational (so the model can confirm "I'm on prod-eu, not staging").

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_core::kubeconfig;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

// ─── fs_configuration_view ──────────────────────────────────────────────────

pub(crate) struct ConfigurationView {
    app: AppHandle,
    cluster_id: String,
}

impl ConfigurationView {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ConfigurationView {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_configuration_view".to_string(),
            description: "What cluster + context this chat is pinned to. Returns context name, \
                source group, source kind (file / folder / ssh), kubeconfig path (when local), \
                and the kubeconfig-default namespace (if the context sets one). The agent \
                cannot switch contexts mid-chat — operator opens a new chat to talk to a \
                different cluster."
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
        let app_state = self.app.state::<AppState>();
        let sources = app_state.sources.lock().await;
        let contexts = kubeconfig::list_contexts(&sources)
            .map_err(|e| NativeToolError::msg(format!("list contexts: {e}")))?;
        let me = contexts
            .iter()
            .find(|c| c.id == self.cluster_id)
            .ok_or_else(|| {
                NativeToolError::msg(format!(
                    "current cluster id {} not found in any source",
                    self.cluster_id
                ))
            })?;
        Ok(json!({
            "cluster_id": me.id,
            "context_name": me.name,
            "cluster": me.cluster,
            "user": me.user,
            "default_namespace": me.namespace,
            "group": me.group,
            "source_id": me.source_id,
            "source_path": me.source_path.as_ref().map(|p| p.display().to_string()),
        }))
    }
}

// ─── fs_configuration_contexts_list ─────────────────────────────────────────

pub(crate) struct ConfigurationContextsList {
    app: AppHandle,
    cluster_id: String,
}

impl ConfigurationContextsList {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for ConfigurationContextsList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_configuration_contexts_list".to_string(),
            description: "Enumerate every kubeconfig context the operator has registered (across \
                the default kubeconfig + user-added file / folder / SSH sources). The current \
                chat is marked `is_current_chat`. Operators may use this to ask which clusters \
                exist; the agent itself can't switch — it stays on the chat's bound context."
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
        let app_state = self.app.state::<AppState>();
        let sources = app_state.sources.lock().await;
        let contexts = kubeconfig::list_contexts(&sources)
            .map_err(|e| NativeToolError::msg(format!("list contexts: {e}")))?;
        let items: Vec<Value> = contexts
            .iter()
            .map(|c| {
                json!({
                    "cluster_id": c.id,
                    "context_name": c.name,
                    "cluster": c.cluster,
                    "namespace": c.namespace,
                    "group": c.group,
                    "source_id": c.source_id,
                    "is_current_chat": c.id == self.cluster_id,
                })
            })
            .collect();
        Ok(json!({ "count": items.len(), "contexts": items }))
    }
}
