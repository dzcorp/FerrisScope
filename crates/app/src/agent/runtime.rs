//! `agent::runtime` — see `agent/mod.rs` for the split rationale.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::oneshot;

use ferrisscope_agent::mcp::McpTool;
use ferrisscope_agent::session::{ApprovalDecision, SessionStore};
use ferrisscope_agent::types::ChatMessage;
use ferrisscope_agent::{ApprovalMode, NativeRegistry, ProviderKind};
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::agent_mcp::McpProcess;
use crate::agent_native;

use super::{sessions_root, ChatEvent, ViewContextWire};

/// Live state for one MCP server within a chat. Created at chat-open from
/// an `McpServerConfig` entry; either resolves to a running `McpProcess`
/// with a populated `tools` cache, or to `process: None` + a failure
/// `message`. Either way, kept in `ChatRuntime::mcp_servers` so the UI
/// can render the per-source status row.
pub(crate) struct McpServerHandle {
    /// Stable id from the source config. Lets the frontend address one
    /// server unambiguously across status updates.
    pub(crate) id: String,
    /// Operator-friendly label from the config, used in status events and
    /// the tools-popover source grouping.
    pub(crate) name: String,
    /// Live child + JSON-RPC client. `None` when the spawn / `initialize`
    /// failed; `tools` is empty in that case and `message` carries the
    /// reason.
    pub(crate) process: Option<Arc<McpProcess>>,
    /// Cached `tools/list` from this server. Drives both the LLM's tool
    /// schema enumeration and the dispatch lookup (we walk this list to
    /// route a tool name back to the owning client).
    pub(crate) tools: Vec<McpTool>,
    /// Operator opted to treat every tool from this server as a read
    /// (auto-run, no approval). Carried from `McpServerConfig::trust_as_read`
    /// so the approval gate and the tools inspector can override the name
    /// heuristic without re-reading settings.
    pub(crate) trust_as_read: bool,
    /// Failure message. `None` on success.
    pub(crate) message: Option<String>,
}

/// Per-live-chat handle. A chat is bound to one session + one cluster;
/// re-opening the same session creates a new `chat_id`.
pub(crate) struct ChatRuntime {
    pub(crate) session_id: String,
    pub(crate) cluster_id: String,
    /// Most recent model id for new turns. Mirrors `SessionMeta::model`.
    pub(crate) model: String,
    /// Provider kind the chat is bound to. Mirrors
    /// `SessionMeta::provider_kind`. Cached on the runtime so the
    /// per-round transcript-budget + Usage-event limit lookups don't
    /// pay a `store.load()` round-trip per turn.
    pub(crate) provider_kind: ProviderKind,
    /// Per-chat approval mode. Mirrors `SessionMeta::approval_mode`.
    pub(crate) approval_mode: ApprovalMode,
    /// Per-chat sampling overrides. `None` lets the provider pick its
    /// default. Operators tweak these from the chat header. Persisted via
    /// `SessionEvent::SessionUpdate` like approval_mode.
    pub(crate) temperature: Option<f32>,
    pub(crate) max_tokens: Option<u32>,
    /// Per-chat free-form provider knobs (Anthropic `thinking`, OpenAI
    /// `reasoning`, OpenRouter routing). Merged into the request body
    /// last so they win over our defaults. `None` ⇒ provider defaults.
    pub(crate) provider_options: Option<serde_json::Value>,
    /// Latest cumulative token count from the most recent `Usage`
    /// event. Drives the auto-compaction trigger. Resets to 0 after a
    /// successful compaction (the next call's Usage will again be the
    /// running total — providers report cumulative for the request,
    /// not delta — so we keep the most recent observation, not a
    /// running sum across turns).
    pub(crate) last_total_tokens: u32,
    /// `true` when a compaction is mid-flight or already produced a
    /// summary that's pending injection on the next round. Prevents
    /// re-triggering on the round that actually applies the summary.
    pub(crate) compaction_in_flight: bool,
    /// Where to send streaming events.
    pub(crate) channel: Channel<ChatEvent>,
    /// In-memory transcript accumulator. Keeps the loop from re-reading the
    /// JSONL on every turn. Hydrated from `SessionStore::load` when the chat
    /// opens; then appended to on every turn.
    pub(crate) messages: Vec<ChatMessage>,
    /// Cancellation handle for the in-flight `stream_completion` future.
    /// Set while a turn is running so `chat_cancel_streaming` can abort.
    pub(crate) cancel: Option<tokio::task::AbortHandle>,
    /// `message_id` of the assistant bubble currently being streamed.
    /// `Some` from `AssistantStart` until `AssistantEnd`. Lets
    /// `chat_cancel_streaming` close the bubble cleanly when the spawned
    /// task is aborted (the dropped future can't emit `AssistantEnd`
    /// itself).
    pub(crate) in_flight_message_id: Option<String>,
    /// Per-server MCP handles, one entry per enabled server in the
    /// operator's config. Each handle owns the child process plus the
    /// cached `tools/list` response. Failed spawns appear with
    /// `process: None` and a `message` describing the failure so the UI
    /// can surface it without a separate error channel. The vector is
    /// allowed to be empty — native tools alone make the chat usable.
    pub(crate) mcp_servers: Vec<McpServerHandle>,
    /// Shared SSH-tunneled scratch kubeconfig path. Materialised once at
    /// chat-open and pointed at by every MCP child's `KUBECONFIG`. We
    /// own the file's lifetime (delete on chat_close) so multiple servers
    /// can share it without racing on cleanup.
    pub(crate) external_scratch: Option<PathBuf>,
    /// Native (in-process) tools the FerrisScope app exposes directly to the
    /// agent. Always populated regardless of MCP state — these are what makes
    /// the chat useful even before MCP finishes spawning. Merged with the
    /// MCP catalogue at `tools_to_schemas` time.
    pub(crate) native: NativeRegistry,
    /// Shared cluster context used by every native tool. `origin` is `cluster_id`;
    /// `active` defaults to origin and is rebound by `fs_configuration_use_context`.
    /// Held here so the per-turn system prompt can describe the *active* cluster
    /// (not just the origin) without going through tool-call round trips.
    pub(crate) cluster: agent_native::ChatClusterRef,
    /// Per-chat disk spool for oversized tool output. The agent loop writes the
    /// full payload here when a result exceeds `MAX_TOOL_RESULT_BYTES`; the
    /// `fs_tool_output_read` / `fs_tool_output_grep` tools (built over the same
    /// directory) read it back. Cloned into each tool-call future. Cheap clone.
    pub(crate) tool_spool: agent_native::tool_output::ToolSpool,
    /// In-flight approval requests, keyed by tool call id. The agent loop
    /// awaits each receiver while the UI surfaces the approval card; the
    /// `chat_approve_tool_call` command sends the operator's decision.
    pub(crate) pending_approvals: HashMap<String, oneshot::Sender<ApprovalDecision>>,
    /// Tool names the operator has greenlit for the rest of this chat
    /// (Approve always). Cleared on chat close. Survives across turns but
    /// is intentionally NOT persisted to JSONL — re-opening a chat resets
    /// the always-allow set so trust doesn't accidentally span sessions.
    pub(crate) approved_always: HashSet<String>,
    /// `true` once the auto-title task has been spawned for this chat
    /// — either it's in-flight or already completed. Claimed under the
    /// runtime lock in `chat_send_message` so concurrent sends can't
    /// both fire the task. Reset on chat re-open; re-opening a session
    /// that already has a custom title won't double-rename because
    /// `run_auto_title_task` bails on load when the persisted title
    /// is no longer the default.
    pub(crate) auto_title_done: bool,
    /// Most recent UI selection snapshot sent with `chat_send_message`.
    /// Optional; only used to inject an informational block into the
    /// system prompt. Overwritten on every send. Not persisted — a
    /// reopened chat starts blank until the next send refreshes it.
    pub(crate) last_view_context: Option<ViewContextWire>,
}

#[derive(Default)]
pub(crate) struct AgentState {
    pub(crate) chats: Mutex<HashMap<String, Arc<Mutex<ChatRuntime>>>>,
    pub(crate) store: Mutex<Option<SessionStore>>,
}

impl AgentState {
    /// Close every chat bound to `cluster_id` and run its cleanup (see
    /// [`close_chat_runtime`]). Returns how many were closed.
    ///
    /// Called from the cluster-disconnect path so a backend-initiated
    /// disconnect reaps agent-resident state — debug pods, node-SSH sessions —
    /// instead of relying solely on the frontend's `chat_close` (which it may
    /// never send) and the pods' server-side TTL. Must run while the cluster's
    /// kube `Client` is still alive so `on_chat_close`'s pod deletions land.
    pub(crate) async fn close_chats_for_cluster(&self, cluster_id: &str) -> usize {
        // Clone the (id, Arc) pairs under the map lock — cheap, holding no
        // per-runtime lock. We then read each runtime's `cluster_id` with the
        // map lock released, so a chat mid-turn can't block the whole sweep.
        let candidates: Vec<(String, Arc<Mutex<ChatRuntime>>)> = {
            let chats = self.chats.lock().await;
            chats.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        // Read each runtime's bound cluster (lock briefly, map lock released)
        // then select matches via the pure helper.
        let mut pairs: Vec<(String, String)> = Vec::with_capacity(candidates.len());
        for (id, rt) in candidates {
            let cid = rt.lock().await.cluster_id.clone();
            pairs.push((id, cid));
        }
        let matching = chats_matching_cluster(&pairs, cluster_id);
        let mut closed = 0;
        for id in matching {
            // Re-check under the lock: a concurrent `chat_close` may have won.
            let removed = self.chats.lock().await.remove(&id);
            if let Some(rt) = removed {
                close_chat_runtime(rt).await;
                closed += 1;
            }
        }
        closed
    }

    pub(crate) async fn store(&self) -> Result<SessionStore, String> {
        let mut slot = self.store.lock().await;
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let root = sessions_root().ok_or_else(|| "no config dir".to_string())?;
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|e| e.to_string())?;
        let store = SessionStore::new(root);
        *slot = Some(store.clone());
        Ok(store)
    }
}

/// Run the close-time cleanup for a removed chat runtime: cancel the in-flight
/// turn, drain pending approvals (unwinding awaiting tool futures via
/// `Err -> Denied`), drop MCP server handles (killing their child processes via
/// `McpProcess::Drop`), fire each native tool's `on_chat_close` (releasing
/// debug pods / node-SSH sessions / other external state), and delete the
/// shared SSH-tunneled scratch kubeconfig. Best-effort — hooks log their own
/// errors and we never propagate. Shared by [`chat_close`] and
/// [`AgentState::close_chats_for_cluster`].
pub(crate) async fn close_chat_runtime(rt: Arc<Mutex<ChatRuntime>>) {
    // Snapshot the native tool handles + scratch path under the lock, then
    // release it before we await on cleanup — pod deletion can take a few
    // hundred ms per pod and we don't want to hold the chat lock during that.
    let (native_tools, scratch) = {
        let mut g = rt.lock().await;
        if let Some(handle) = g.cancel.take() {
            handle.abort();
        }
        g.pending_approvals.clear();
        g.mcp_servers.clear();
        (g.native.tools().to_vec(), g.external_scratch.take())
    };
    for tool in native_tools {
        tool.on_chat_close().await;
    }
    if let Some(p) = scratch {
        let _ = std::fs::remove_file(p);
    }
}

/// From `(chat_id, runtime_cluster_id)` pairs, the chat ids bound to
/// `cluster_id`. Exact match (not prefix) — a composite cluster id like
/// `default::user@host` must not match a different context sharing a prefix.
/// Pure so the disconnect sweep's selection is unit-testable without
/// constructing `ChatRuntime`s.
fn chats_matching_cluster(pairs: &[(String, String)], cluster_id: &str) -> Vec<String> {
    pairs
        .iter()
        .filter(|(_, cid)| cid == cluster_id)
        .map(|(id, _)| id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chats_matching_cluster_selects_exact_cluster_only() {
        let pairs = vec![
            ("chat-a".to_owned(), "ctx-1".to_owned()),
            ("chat-b".to_owned(), "ctx-2".to_owned()),
            ("chat-c".to_owned(), "ctx-1".to_owned()),
        ];
        let mut got = chats_matching_cluster(&pairs, "ctx-1");
        got.sort();
        assert_eq!(got, vec!["chat-a".to_owned(), "chat-c".to_owned()]);
        // No match → empty (disconnecting a cluster with no chats is a no-op).
        assert!(chats_matching_cluster(&pairs, "ctx-3").is_empty());
        // Exact match, not prefix: a composite id must not match a sibling
        // context that merely shares a prefix.
        let composite = vec![
            ("chat-x".to_owned(), "default::user@host".to_owned()),
            ("chat-y".to_owned(), "default::user@host-2".to_owned()),
        ];
        assert_eq!(
            chats_matching_cluster(&composite, "default::user@host"),
            vec!["chat-x".to_owned()]
        );
    }
}
