//! `fs_configuration_view` + `fs_configuration_contexts_list` +
//! `fs_configuration_use_context` — kubeconfig introspection and
//! per-chat context switching.
//!
//! At chat-open the agent's tools target the cluster the chat was opened
//! against (`origin`). `fs_configuration_use_context` lets the model
//! retarget every subsequent native-tool call to a different context the
//! operator has registered (a different file/folder source, an SSH source,
//! the default kubeconfig…) without disturbing what the operator has
//! selected in the UI. This makes "investigate prod from a chat that's
//! parked on staging" a no-op for the operator.
//!
//! Stateful sessions that were already open before the switch (node-shell
//! debug pods, port-forwards) keep targeting the cluster they were opened
//! on — the new context is for *new* work.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::session::{SessionEvent, SessionUpdate};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_core::kubeconfig;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::AgentState;
use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

// ─── fs_configuration_view ──────────────────────────────────────────────────

pub(crate) struct ConfigurationView {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ConfigurationView {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for ConfigurationView {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_configuration_view".to_string(),
            description: "What cluster + context this chat is currently targeting. Returns the \
                origin cluster (where the chat was opened, stable for the chat's lifetime) and \
                the active cluster (what every subsequent tool call targets — equal to origin \
                until you call `fs_configuration_use_context`). Each side carries context name, \
                cluster, user, default namespace, source group, and kubeconfig path (when local)."
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
        let active_id = self.cluster.active().await;
        let origin_id = self.cluster.origin().to_string();
        let project = |id: &str| -> Option<Value> {
            contexts.iter().find(|c| c.id == id).map(|c| {
                json!({
                    "cluster_id": c.id,
                    "context_name": c.name,
                    "cluster": c.cluster,
                    "user": c.user,
                    "default_namespace": c.namespace,
                    "group": c.group,
                    "source_id": c.source_id,
                    "source_path": c.source_path.as_ref().map(|p| p.display().to_string()),
                })
            })
        };
        let active = project(&active_id).ok_or_else(|| {
            NativeToolError::msg(format!(
                "active cluster id {active_id} not found in any source"
            ))
        })?;
        // Origin may have been removed from sources after open — surface it
        // as null rather than failing, so the model can still reason about
        // "I'm on a different context now."
        let origin = project(&origin_id);
        Ok(json!({
            "active": active,
            "origin": origin,
            "origin_cluster_id": origin_id,
            "switched": active_id != origin_id,
        }))
    }
}

// ─── fs_configuration_contexts_list ─────────────────────────────────────────

pub(crate) struct ConfigurationContextsList {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ConfigurationContextsList {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for ConfigurationContextsList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_configuration_contexts_list".to_string(),
            description: "Enumerate every kubeconfig context the operator has registered (across \
                the default kubeconfig + user-added file / folder / SSH sources). Each entry is \
                marked `is_active` (current target for this chat's tool calls) and `is_origin` \
                (where the chat was opened). Use this to discover ids you can pass to \
                `fs_configuration_use_context` for cross-cluster work."
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
        let active_id = self.cluster.active().await;
        let origin_id = self.cluster.origin().to_string();
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
                    "is_active": c.id == active_id,
                    "is_origin": c.id == origin_id,
                })
            })
            .collect();
        Ok(json!({
            "count": items.len(),
            "active_cluster_id": active_id,
            "origin_cluster_id": origin_id,
            "contexts": items,
        }))
    }
}

// ─── fs_configuration_use_context ───────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct UseArgs {
    /// Either the full `cluster_id` from `fs_configuration_contexts_list`
    /// (preferred, unambiguous across sources) or a bare context name.
    /// When ambiguous (same context name in multiple sources), the call
    /// returns an error listing the candidate `cluster_id`s.
    cluster_id: Option<String>,
    /// Convenience: name of the context. Resolved via context-name match
    /// across all registered sources. Errors if zero or >1 matches.
    #[serde(default)]
    context_name: Option<String>,
}

pub(crate) struct ConfigurationUseContext {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl ConfigurationUseContext {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for ConfigurationUseContext {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_configuration_use_context".to_string(),
            description: "Switch the chat's active Kubernetes context. Every subsequent native \
                tool call (pods/resources/events/logs/exec/apply/…) targets the new context \
                until switched again. Pass `cluster_id` (preferred, from \
                `fs_configuration_contexts_list`) or `context_name` (looked up across all \
                registered sources; errors on ambiguity). The chat's origin cluster is \
                unchanged — `fs_configuration_view` still reports it. Already-open node-shell \
                debug pods and port-forwards stay pinned to the cluster they were opened in; \
                only new work moves. The operator's UI selection is unaffected — they can be \
                parked on cluster A while the agent investigates B."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "cluster_id": {
                        "type": "string",
                        "description": "Full cluster id from fs_configuration_contexts_list."
                    },
                    "context_name": {
                        "type": "string",
                        "description": "Bare context name. Resolved across sources; ambiguous matches error out."
                    }
                },
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        // Switching the active context changes where every subsequent
        // write-category tool will land. Classify as Write so the
        // operator's approval gate fires on first switch when they're in
        // confirm-each-write mode.
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: UseArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        if a.cluster_id.is_none() && a.context_name.is_none() {
            return Err(NativeToolError::msg(
                "specify `cluster_id` or `context_name`",
            ));
        }
        let app_state = self.app.state::<AppState>();
        let sources = app_state.sources.lock().await;
        let contexts = kubeconfig::list_contexts(&sources)
            .map_err(|e| NativeToolError::msg(format!("list contexts: {e}")))?;
        drop(sources);

        // Resolve to a single ContextInfo.
        let resolved = if let Some(id) = a.cluster_id.as_deref() {
            contexts
                .iter()
                .find(|c| c.id == id)
                .ok_or_else(|| {
                    NativeToolError::msg(format!(
                        "no registered context with cluster_id `{id}` — call \
                         fs_configuration_contexts_list to see the available ids"
                    ))
                })?
                .clone()
        } else {
            let name = a.context_name.as_deref().expect("checked above");
            let matches: Vec<_> = contexts.iter().filter(|c| c.name == name).collect();
            match matches.len() {
                0 => {
                    return Err(NativeToolError::msg(format!(
                        "no context named `{name}` in any registered source"
                    )));
                }
                1 => matches[0].clone(),
                _ => {
                    let ids: Vec<String> = matches.iter().map(|c| c.id.clone()).collect();
                    return Err(NativeToolError::msg(format!(
                        "ambiguous context name `{name}` matches {} sources — pass cluster_id \
                         instead. Candidates: {}",
                        ids.len(),
                        ids.join(", ")
                    )));
                }
            }
        };

        let new_id = resolved.id.clone();
        let previous = self.cluster.active().await;
        let unchanged = previous == new_id;
        if !unchanged {
            self.cluster.set_active(new_id.clone()).await;
            // Persist the override so an app restart re-opens the chat
            // on the agent's last target rather than reverting to origin.
            // Sentinel: `Some(None)` when switching back to origin clears
            // the override; `Some(Some(id))` when switching elsewhere.
            // Best-effort — failures are logged but don't roll back the
            // in-memory switch (the current turn already used it).
            persist_active_cluster(
                &self.app,
                self.cluster.origin().to_string(),
                self.cluster.session_id().to_string(),
                if new_id == self.cluster.origin() {
                    None
                } else {
                    Some(new_id.clone())
                },
            )
            .await;
        }
        Ok(json!({
            "ok": true,
            "switched": !unchanged,
            "previous_cluster_id": previous,
            "active": {
                "cluster_id": resolved.id,
                "context_name": resolved.name,
                "cluster": resolved.cluster,
                "user": resolved.user,
                "default_namespace": resolved.namespace,
                "group": resolved.group,
                "source_id": resolved.source_id,
                "source_path": resolved.source_path.as_ref().map(|p| p.display().to_string()),
            },
            "origin_cluster_id": self.cluster.origin().to_string(),
        }))
    }
}

/// Append a `SessionUpdate { active_cluster_id }` so the chat reopens on
/// the agent's last target. `new_active = None` clears the override (back
/// to origin); `Some(id)` records the switch. Errors are logged, not
/// returned — persistence is best-effort and the in-memory switch is
/// already live.
async fn persist_active_cluster(
    app: &AppHandle,
    origin_cluster_id: String,
    session_id: String,
    new_active: Option<String>,
) {
    let agent_state = app.state::<AgentState>();
    let store = match agent_state.store().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "fs_configuration_use_context: cannot acquire session store; switch is in-memory only");
            return;
        }
    };
    let now = chrono::Utc::now().timestamp_millis();
    if let Err(e) = store
        .append(
            &origin_cluster_id,
            &session_id,
            SessionEvent::SessionUpdate {
                update: SessionUpdate {
                    active_cluster_id: Some(new_active),
                    ..Default::default()
                },
                ts: now,
            },
        )
        .await
    {
        tracing::warn!(error = %e, "fs_configuration_use_context: persist failed; switch is in-memory only");
    }
}
