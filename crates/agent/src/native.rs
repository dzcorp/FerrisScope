//! Native tool registry.
//!
//! Tools that the FerrisScope app exposes directly to the agent without going
//! through an MCP child process. The trait stays in this crate so the agent
//! loop can dispatch by name uniformly with MCP tools; concrete impls live in
//! `crates/app/src/agent_native/` where they have access to `AppState`,
//! `kube::Client`, the terminal registry, etc.
//!
//! A native registry is built per chat (so each tool can close over the
//! chat's `cluster_id` / kubeconfig) and merged with the MCP catalogue at the
//! tool-schemas-to-LLM boundary. Name uniqueness across the merged set is the
//! caller's responsibility — we recommend an `fs_` prefix for native tools to
//! avoid colliding with any external MCP server's namespace.

use crate::mcp::ToolCategory;
use crate::types::ToolSchema;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum NativeToolError {
    #[error("{0}")]
    Failed(String),
}

impl NativeToolError {
    pub fn msg(s: impl Into<String>) -> Self {
        Self::Failed(s.into())
    }
}

/// One native tool. Implementations close over whatever state they need
/// (cluster id, kube client, app handle…) at construction time, so the
/// `call` signature is uniform regardless of what the tool actually does.
#[async_trait]
pub trait NativeTool: Send + Sync {
    fn schema(&self) -> ToolSchema;
    /// Read / Write / Unknown. Mirrors `mcp::ToolCategory` so the same
    /// approval gate applies to native tools as to MCP ones.
    fn category(&self) -> ToolCategory;
    /// Run the tool. The returned JSON is shoved into the assistant's
    /// next-turn `tool` message verbatim (stringified). Errors are surfaced
    /// as `is_error: true` tool results.
    async fn call(&self, args: Value) -> Result<Value, NativeToolError>;
    /// Per-tool wall-clock budget. `None` (default) lets the agent loop
    /// apply its global `TOOL_CALL_TIMEOUT`. `Some(d)` overrides for tools
    /// that legitimately need to run longer (`fs_pause` waits up to 20
    /// minutes by design) or shorter (a probe that should fail fast).
    /// The agent loop still wraps the call in `tokio::time::timeout` either
    /// way, so a runaway tool can't hang a turn forever.
    fn timeout(&self) -> Option<Duration> {
        None
    }
    /// Lifecycle hook fired when the chat that owns this tool is closing
    /// (operator hit close, app shutdown, cluster switch — which in this
    /// codebase means closing the chat and opening a new one). Tools that
    /// own external state (debug pods, port-forwards, ephemeral files)
    /// release it here. Failures are logged, never propagated — close must
    /// be best-effort. Default: no-op.
    async fn on_chat_close(&self) {}
}

/// Per-chat collection of native tools. Cheap to clone (Arcs only).
#[derive(Clone, Default)]
pub struct NativeRegistry {
    tools: Vec<Arc<dyn NativeTool>>,
}

impl NativeRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn NativeTool>) {
        self.tools.push(tool);
    }

    #[must_use]
    pub fn tools(&self) -> &[Arc<dyn NativeTool>] {
        &self.tools
    }

    #[must_use]
    pub fn schemas(&self) -> Vec<ToolSchema> {
        self.tools.iter().map(|t| t.schema()).collect()
    }

    #[must_use]
    pub fn find(&self, name: &str) -> Option<Arc<dyn NativeTool>> {
        self.tools.iter().find(|t| t.schema().name == name).cloned()
    }

    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.find(name).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct StubTool {
        name: &'static str,
        category: ToolCategory,
    }

    #[async_trait]
    impl NativeTool for StubTool {
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: self.name.to_owned(),
                description: format!("stub for {}", self.name),
                parameters: json!({ "type": "object", "properties": {} }),
            }
        }
        fn category(&self) -> ToolCategory {
            self.category
        }
        async fn call(&self, _args: Value) -> Result<Value, NativeToolError> {
            Ok(json!({ "stub": self.name }))
        }
    }

    fn stub(name: &'static str, cat: ToolCategory) -> Arc<dyn NativeTool> {
        Arc::new(StubTool {
            name,
            category: cat,
        })
    }

    #[test]
    fn registry_round_trips_schemas_and_lookup() {
        let mut r = NativeRegistry::new();
        r.register(stub("fs_pod_diagnose", ToolCategory::Read));
        r.register(stub("fs_node_shell_open", ToolCategory::Write));

        // Schemas come back in registration order — the inspector tree
        // depends on this stable order.
        let names: Vec<_> = r.schemas().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["fs_pod_diagnose", "fs_node_shell_open"]);

        assert!(r.contains("fs_pod_diagnose"));
        assert!(!r.contains("fs_unknown"));

        let t = r.find("fs_node_shell_open").expect("registered");
        assert_eq!(t.category(), ToolCategory::Write);
    }

    #[tokio::test]
    async fn stub_tool_call_returns_value() {
        let t = stub("fs_helm_list", ToolCategory::Read);
        let out = t.call(json!({})).await.unwrap();
        assert_eq!(out["stub"], "fs_helm_list");
    }

    #[test]
    fn native_tool_error_displays_message() {
        let e = NativeToolError::msg("kaboom");
        assert_eq!(format!("{e}"), "kaboom");
    }

    #[test]
    fn registry_default_is_empty() {
        let r = NativeRegistry::new();
        assert!(r.tools().is_empty());
        assert!(r.schemas().is_empty());
        assert!(!r.contains("anything"));
    }
}
