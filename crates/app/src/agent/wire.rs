//! `agent::wire` — see `agent/mod.rs` for the split rationale.

use std::collections::HashMap;

use ferrisscope_agent::config::McpServerConfig;
use ferrisscope_agent::{ApprovalMode, FinishReason, ProviderKind, ReasoningSettings};
use serde::{Deserialize, Serialize};

use crate::secret_storage::StorageBackend;

/// Public-shape settings the frontend sees. Per-provider credential
/// material never round-trips: each `ProviderStatusWire` carries
/// `configured: bool` + `auth_mode` so the UI can decide which form to
/// render without ever seeing the key/access-token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiSettingsWire {
    pub active_provider: ProviderKind,
    pub providers: HashMap<ProviderKind, ProviderStatusWire>,
    pub default_model: Option<String>,
    pub default_approval_mode: ApprovalMode,
    pub system_prompt_override: Option<String>,
    pub allow_plaintext_api_key: bool,
    pub keychain_available: bool,
    /// Active secret-storage backend (`Keychain` or `EncryptedFile`).
    /// `EncryptedFile` is selected on macOS when the running binary
    /// isn't persistently signed — the UI can use this to render an
    /// explanatory note ("API keys live in an encrypted local file
    /// because this build is unsigned"). On all other platforms /
    /// signed builds, this is `Keychain`.
    pub secret_storage_backend: StorageBackend,
    /// Operator-configured external MCP servers. Each entry produces one
    /// child process per chat, merged with the native catalogue under the
    /// same approval gate. Empty = native tools only.
    pub mcp_servers: Vec<McpServerConfig>,
    /// Legacy single-binary path. Kept on the wire so the UI can offer a
    /// migration affordance and so older configs keep spawning until the
    /// operator switches to `mcp_servers`. Frontend should treat as
    /// read-only after migration; new edits go through `mcp_servers`.
    pub mcp_binary_path: Option<String>,
    /// Universal reasoning / extended-thinking knobs. Mapped to each
    /// provider's native shape at request time.
    pub reasoning: ReasoningSettings,
}

/// Per-provider snapshot. Surfaces what's needed to render the provider
/// row + any sub-pane: display metadata, configured-state, base URL
/// override (operator-supplied or `None` for the canonical default).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProviderStatusWire {
    pub kind: ProviderKind,
    pub id: String,
    pub display_name: String,
    pub default_base_url: String,
    pub base_url_override: Option<String>,
    pub auth_modes: Vec<String>,
    /// `"api_key"` or `"oauth"` when configured; `None` otherwise.
    pub auth_mode: Option<String>,
    pub configured: bool,
    /// Best-effort label for the configured credential. For OAuth this
    /// is the ChatGPT-Account-Id (helps operators tell their personal
    /// vs work subscription apart). For API key it's `None`.
    pub account_label: Option<String>,
}

/// What the frontend posts when changing global settings. Per-provider
/// credentials are written via `ai_set_credential` / `ai_delete_credential`
/// so secrets never travel through this patch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiSettingsPatch {
    #[serde(default)]
    pub active_provider: Option<ProviderKind>,
    /// Set the base URL override for `provider`. Empty string clears it.
    #[serde(default)]
    pub provider_base_url: Option<ProviderBaseUrlPatch>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_approval_mode: Option<ApprovalMode>,
    #[serde(default)]
    pub system_prompt_override: Option<String>,
    #[serde(default)]
    pub allow_plaintext_api_key: Option<bool>,
    /// Whole-list replace. `Some(vec![])` clears all servers; `None` leaves
    /// the persisted list alone. UI sends this on every save so the order
    /// the operator chose is what's persisted.
    #[serde(default)]
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    #[serde(default)]
    pub mcp_binary_path: Option<String>,
    /// Whole-object replace: `Some(_)` sets, `None` leaves alone. The
    /// inner struct's own fields are themselves `Option`, so a clear
    /// is `Some(ReasoningSettings::default())`.
    #[serde(default)]
    pub reasoning: Option<ReasoningSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProviderBaseUrlPatch {
    pub provider: ProviderKind,
    pub base_url: String,
}

/// Per-MCP-server status, emitted as part of `ChatEvent::McpStatus`. One
/// entry per enabled server in the operator's config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct McpServerStatusWire {
    pub id: String,
    pub name: String,
    /// `true` once the child has spawned and `tools/list` returned. `false`
    /// while still spawning, or after a failure (see `message`).
    pub available: bool,
    pub tool_count: u32,
    /// Spawn / init failure message. `None` while pending or on success.
    pub message: Option<String>,
}

/// Returned in-band from `chat_open`. Bundles the new chat id with the
/// initial MCP-status snapshot so the frontend can seed `view.mcp`
/// synchronously instead of waiting for the streamed `mcp_status`
/// event — Tauri channel events sent during the same invoke can arrive
/// after the JS-side state-init effects, which left the header chip
/// stuck on `Tools · …`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ChatOpenResult {
    pub chat_id: String,
    /// Native (in-process) tool count. Stable for the chat's lifetime.
    pub native_tool_count: u32,
    /// Per-MCP-server snapshot, in operator-config order. Each entry is
    /// in the "pending" state initially (`available: false`, no
    /// `message`); the streaming `mcp_status` event updates them as
    /// each spawn task completes.
    pub mcp_servers: Vec<McpServerStatusWire>,
    /// The model's context window in tokens, resolved through the
    /// models.dev catalogue (with the per-provider default as fallback
    /// when the model isn't listed yet). Lets the UI render
    /// `<used> / <limit> tok` in the chat footer immediately on open,
    /// before the first `Usage` event lands. Updates over the wire as a
    /// `ContextLimit` event whenever the operator switches model.
    pub context_limit: u32,
    /// Usable window after subtracting the reserved output buffer
    /// (`min(20k, max_output)`, mirroring opencode). This is what the
    /// auto-compaction trigger compares against — surfacing it lets the
    /// UI show "% of usable" rather than a misleading raw-context %.
    pub usable_context: u32,
}

/// Probe-only test request. The frontend supplies a candidate key inline
/// so the operator can validate before saving. OAuth providers are
/// validated via the live `ai_oauth_login` flow instead.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProviderTestRequest {
    pub provider: ProviderKind,
    #[serde(default)]
    pub base_url: Option<String>,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProviderTestResult {
    pub ok: bool,
    pub model_count: usize,
    pub error: Option<String>,
}

/// Outcome of a one-shot MCP-server validation. The server is spawned,
/// initialized, asked for `tools/list`, and immediately killed — the
/// goal is to confirm the operator's command + args + env produces a
/// usable MCP server before they save and discover the failure mid-chat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct McpTestResult {
    pub ok: bool,
    pub tool_count: u32,
    /// First few tool names (capped, see `MCP_TEST_NAME_PREVIEW`) so the
    /// UI can show a hover hint without paying the wire cost of a
    /// 100-tool catalogue. Empty on failure.
    pub tool_names: Vec<String>,
    pub error: Option<String>,
}

// ─── Streaming events sent over the per-chat Channel<ChatEvent> ─────────────

/// What the frontend receives over `Channel<ChatEvent>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ChatEvent {
    /// New assistant message id starting (so the UI can allocate a bubble).
    AssistantStart { message_id: String },
    /// Streaming token delta for the in-flight assistant message.
    TokenDelta { delta: String },
    /// Tool call started streaming.
    ToolCallStart { id: String, name: String },
    /// More tool-call argument JSON.
    ToolCallArgsDelta { id: String, json_delta: String },
    /// Tool-call args finished streaming.
    ToolCallEnd { id: String },
    /// Final shape of the assistant message after streaming ends.
    AssistantEnd {
        message_id: String,
        finish_reason: FinishReason,
    },
    /// A tool call has cleared the approval gate (or didn't need one) and
    /// is about to dispatch. Lets the UI show a "running" strip for tools
    /// whose execution is genuinely long — port-forward, ssh, http_fetch,
    /// or anything timing out near the 60s tool budget. Always followed
    /// by exactly one `ToolResult` for the same `tool_call_id`.
    ToolExecutionStart { tool_call_id: String, name: String },
    /// A tool call has finished executing — its result has been forwarded
    /// back into the conversation. `is_error` distinguishes a tool failure
    /// (provider/network error, MCP exception, classification refusal) from
    /// a successful response so the UI can render appropriately.
    ToolResult {
        tool_call_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    /// Tool catalogue summary. Emitted once on chat-open with the native
    /// count, then again per MCP server as each finishes its `tools/list`
    /// (or fails to spawn). The frontend uses the most recent event to
    /// render the chat-header tools pill and the per-source breakdown
    /// in the tools popover.
    McpStatus {
        /// Per-server entries, in the order they appear in
        /// `AgentSettings::mcp_servers`. Disabled servers are omitted.
        /// Empty when only native tools are available.
        servers: Vec<McpServerStatusWire>,
        /// Number of in-process native tools. Stable for the chat's
        /// lifetime — re-emitted unchanged on every status update so the
        /// UI doesn't have to remember a separate value.
        native_tool_count: u32,
    },
    /// A write/destructive tool call is awaiting operator approval. The UI
    /// renders an inline approval card; the operator's choice arrives via
    /// `chat_approve_tool_call`. Resolved by `ToolResult` once the call has
    /// run (or `ToolResult { is_error: true }` on denial).
    ApprovalRequest {
        tool_call_id: String,
        name: String,
        /// Raw JSON arguments string the model produced. The UI may pretty-
        /// print it locally; we don't reformat here so what the operator
        /// sees matches what the LLM emitted.
        arguments: String,
    },
    /// Usage report from the provider (token counts). `context_limit`
    /// and `usable_context` are resolved from the models.dev catalogue
    /// at the moment the event is emitted, so the UI can render
    /// `<total>/<limit>` without a second round-trip. `0` means the
    /// catalogue hasn't loaded yet (rare — only on the very first call
    /// before the background fetch lands); the UI should fall back to
    /// the value from `ChatOpenResult` / the most recent `ContextLimit`
    /// event in that case.
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
        context_limit: u32,
        usable_context: u32,
    },
    /// The chat's effective context limits changed — typically because
    /// the operator switched models (`chat_set_model`). The UI uses this
    /// to refresh the "used / limit" footer chip without waiting for the
    /// next `Usage` event.
    ContextLimit {
        context_limit: u32,
        usable_context: u32,
    },
    /// Auto-compaction lifecycle. UI surfaces a small "summarising
    /// older context…" indicator so a 5–15s compaction call doesn't
    /// look like a hang.
    CompactionStarted {
        tokens_before: u32,
        head_message_count: u32,
    },
    CompactionCompleted {
        summary_chars: u32,
        /// Full summary text the backend persisted as the synthetic
        /// `[context checkpoint]` message. The UI uses this to rebuild
        /// the bubble list synchronously rather than refetching from
        /// disk and racing the next streaming round.
        summary: String,
    },
    /// Streaming error. The chat is left intact; the frontend can retry by
    /// sending another message.
    Error { message: String },
    /// Auto-generated session title landed. Fired once per chat after the
    /// dedicated title-gen request (spawned the moment the operator's
    /// first message lands, in parallel with the assistant turn)
    /// succeeds. The new title has already been journaled via
    /// `SessionUpdate { title }` at the time this event is emitted —
    /// the UI just mirrors it onto its `meta.title` so the header chip
    /// updates without a session reload.
    TitleUpdated { title: String },
}

/// Snapshot of the MCP tool catalogue for a live chat. Returned by
/// `chat_list_tools` so the UI can render an inspector tree without
/// re-running tools/list (which would block on the MCP child).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChatToolWire {
    pub name: String,
    pub description: Option<String>,
    pub category: &'static str,
    pub input_schema: serde_json::Value,
    /// Where this tool came from. `"native"` for in-process tools; the
    /// MCP server's `name` (from `McpServerConfig`) for everything else.
    /// Drives the source-grouping in the chat-tools popover.
    pub source: String,
}

/// Snapshot of what the operator's UI is showing at the moment they hit
/// send. Optional on every `chat_send_message` call; when present, it
/// goes into the system prompt as informational context so the model
/// can resolve vague references ("fix this", "delete it") without the
/// operator having to spell out cluster / kind / namespace / target.
///
/// Deliberately a snapshot, not a subscription — the chat is still
/// independent of UI state; this is just the view at send-time. The
/// model is told it may ignore the block if the request is unrelated.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewContextWire {
    /// Cluster id the UI is currently viewing. May differ from the chat's
    /// active cluster; the prompt block calls out the mismatch when it
    /// happens so the model knows tool calls still hit the chat cluster.
    #[serde(default)]
    pub cluster_id: Option<String>,
    /// Internal kind id (e.g. `pods`, `deployments`, `wkcrd:...`) — not
    /// the Kubernetes `Kind`. Used for navigation links if we ever want
    /// to emit one; today we only show `kind_label` in the prompt.
    #[serde(default)]
    pub kind_id: Option<String>,
    /// Human-readable kind label as the rail shows it (e.g. "Deployments").
    /// Optional — falls back to `kind_id` in the rendered block.
    #[serde(default)]
    pub kind_label: Option<String>,
    /// Currently filtered namespaces. Empty vec = "all namespaces".
    #[serde(default)]
    pub namespaces: Vec<String>,
    /// Multi-selected rows from the current table. Truncated in the
    /// rendered block to keep the prompt bounded.
    #[serde(default)]
    pub selected: Vec<ViewSelectedResource>,
    /// Present when the operator has a multi-cluster (virtual context)
    /// view active. The prompt block then lists the member clusters and
    /// reminds the model that native tools target one cluster at a time
    /// (switchable via `fs_configuration_use_context`), and the
    /// single-cluster mismatch warning is suppressed — it would be
    /// misleading when the UI is deliberately viewing several clusters.
    #[serde(default)]
    pub virtual_context: Option<VirtualContextWire>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VirtualContextWire {
    /// Operator-given name of the virtual context (or ad-hoc view label).
    pub name: String,
    /// Physical cluster ids of every member currently in the view.
    #[serde(default)]
    pub member_cluster_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewSelectedResource {
    /// `None` for cluster-scoped resources.
    #[serde(default)]
    pub namespace: Option<String>,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_context_wire_tolerates_payload_without_virtual_context() {
        // Frontend builds that predate the multi-cluster view send the old
        // shape — `virtual_context` must default to None, not fail deser.
        let legacy = r#"{
            "clusterId": "default::a",
            "kindId": "pods",
            "namespaces": ["default"],
            "selected": [{ "namespace": "default", "name": "api" }]
        }"#;
        let wire: ViewContextWire = serde_json::from_str(legacy).unwrap();
        assert!(wire.virtual_context.is_none());
        assert_eq!(wire.cluster_id.as_deref(), Some("default::a"));
    }

    #[test]
    fn view_context_wire_parses_virtual_context_members() {
        let payload = r#"{
            "virtualContext": {
                "name": "prod fleet",
                "memberClusterIds": ["default::a", "default::b"]
            }
        }"#;
        let wire: ViewContextWire = serde_json::from_str(payload).unwrap();
        let vc = wire.virtual_context.expect("virtual context parsed");
        assert_eq!(vc.name, "prod fleet");
        assert_eq!(vc.member_cluster_ids, vec!["default::a", "default::b"]);
    }
}
