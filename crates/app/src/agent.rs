//! AI agent runtime + Tauri command surface.
//!
//! This module is the bridge between the Tauri-free `ferrisscope-agent` crate
//! and the Tauri host: it owns the `ChatRegistry`, persists agent settings to
//! `<config-dir>/agent_settings.json`, mediates API-key storage through the
//! keychain, and exposes the `chat_*` / `ai_*` commands.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::oneshot;

use directories::ProjectDirs;
use ferrisscope_agent::config::McpServerConfig;
use ferrisscope_agent::mcp::{McpTool, ToolCategory};
use ferrisscope_agent::provider::anthropic::AnthropicProvider;
use ferrisscope_agent::provider::meta::{self, ProviderFlavor, ProviderMeta};
use ferrisscope_agent::provider::openai_codex::{CredentialSink, OpenAICodexProvider};
use ferrisscope_agent::provider::openai_compat::OpenAICompatibleProvider;
use ferrisscope_agent::session::{
    ApprovalDecision, SessionData, SessionError, SessionEvent, SessionMeta, SessionStore,
    SessionUpdate,
};
use ferrisscope_agent::types::{ChatMessage, MessageRole, ToolSchema};
use ferrisscope_agent::{
    classify_tool, AgentSettings, ApprovalMode, ChatProvider, CompletionEvent, CompletionRequest,
    Credential, FinishReason, ModelInfo, NativeRegistry, ProviderConfig, ProviderError,
    ProviderKind, ReasoningEffort, ReasoningSettings, ToolCall,
};
use ferrisscope_core::kubeconfig;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use tokio::sync::Mutex;

use crate::agent_keyring;
use crate::agent_mcp::{McpProcess, McpProcessError};
use crate::agent_native;
use crate::agent_oauth;
use crate::state::AppState;

/// Hard cap on tool-call rounds within a single user turn. Defends against
/// the model getting stuck in a `tool_calls`-only loop (we've seen models do
/// this with poorly described tool schemas). On hitting the cap we return
/// the partial transcript and let the operator nudge the model with a
/// follow-up message.
const MAX_TOOL_ROUNDS: u32 = 50;

/// Per-tool-call execution timeout. MCP calls are expected to be quick
/// (single API request, optional formatting); a hung call would otherwise
/// block the whole turn indefinitely. On timeout we surface an
/// `is_error: true` `ToolResult` so the model can recover.
const TOOL_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Soft transcript size limit (chars) before we start dropping the oldest
/// tool messages. Rough proxy for ~150k tokens at the usual ~4 chars/token
/// ratio — leaves headroom for a 200k-context model. System + user + the
/// latest assistant turn are always preserved.
const TRANSCRIPT_CHAR_BUDGET: usize = 600_000;

const SYSTEM_PROMPT_BASELINE: &str = "\
You are FerrisScope's Kubernetes operator assistant. You help the user \
understand and operate their Kubernetes cluster. Prefer Server-Side Apply \
for any change.\n\
\n\
Format every response as Markdown using only the following constructs:\n\
- short paragraphs for prose; one blank line between paragraphs\n\
- `inline code` for resource names, fields, identifiers, and short shell snippets\n\
- fenced code blocks ``` with a language tag for YAML, multi-line shell, or log excerpts \
(```yaml, ```sh, ```json, ```text)\n\
- bullet (`-`) or numbered (`1.`) lists for steps and option enumerations; one item per line, no nesting\n\
- task list items (`- [ ]` / `- [x]`) when summarising a plan or checklist\n\
- **bold** for important caveats or destructive-action warnings; ~~strikethrough~~ for \
deprecated/avoid options when contrasting with a recommendation\n\
- bare http(s) URLs are auto-linkified, so you can paste a docs URL inline; use \
`[label](url)` only when the label adds value\n\
- in-app navigation links via `ferrisscope://` URLs — clicking them drives the \
FerrisScope UI instead of opening a browser. Use them whenever you reference a \
specific resource so the operator can jump to it in one click. Forms:\n\
  - `ferrisscope://resource/<kind>/<namespace>/<name>` opens the detail panel for \
    a namespaced resource (`<kind>` matches the Kubernetes Kind like `Pod`, \
    `Deployment`, `ConfigMap`, or our internal id like `pods`, `helm_releases`)\n\
  - `ferrisscope://resource/<kind>/-/<name>` is the same for cluster-scoped \
    resources (Node, Namespace, ClusterRole, etc.) — use the literal `-` for \
    namespace\n\
  - `ferrisscope://kind/<kind>` switches the rail to that kind's list view\n\
  - URL-encode names that contain spaces or special characters\n\
  - emit the link as raw Markdown — `[label](ferrisscope://...)` — and \
    NEVER wrap the whole link in backticks. Wrapping it (e.g. \
    `` `[mypod](ferrisscope://...)` ``) turns the entire thing into \
    inline code and the operator sees literal `[mypod](url)` text. \
    Inline code is for raw identifiers like `mypod`, NOT for links. \
    Correct in a table cell: `| [mypod](ferrisscope://resource/Pod/default/mypod) | Running |` — \
    do not put backticks around it. If you also want monospaced label \
    text, put the backticks INSIDE the label: \
    `[`mypod`](ferrisscope://resource/Pod/default/mypod)`.\n\
- horizontal rule (`---` on its own line) to separate clearly distinct sections within one reply\n\
- `##` or `###` headings only when an answer has multiple distinct sections; never use `#`\n\
- GitHub-flavoured pipe tables for tabular data: header row, then a `| --- | --- |` \
separator (use `:---`, `:---:`, `---:` to set per-column alignment), then data rows. \
Always include the separator row — without it the table will render as plain text.\n\
\n\
Do not use blockquotes, images, HTML, or nested lists — the chat renderer \
ignores them. Be concise: skip filler text, lead with the answer, and when \
a tool result already shows the data, cite the relevant lines instead of \
restating the whole output.";

// ─── On-disk settings (sibling of prefs.json, owned by the app crate) ───────

fn settings_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("agent_settings.json"))
}

fn sessions_root() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope").map(|p| p.config_dir().join("agent"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedSettings {
    #[serde(default)]
    settings: AgentSettings,
    /// Per-provider plaintext fallback for the credential. Populated only
    /// when the operator opted into `allow_plaintext_api_key` AND the
    /// keychain backend is unavailable on this host. Each value is the
    /// JSON-serialised [`Credential`]; we don't shorthand "bare key" here
    /// since we'd lose the OAuth refresh-token + account-id fields.
    #[serde(default)]
    plaintext_credentials: HashMap<ProviderKind, String>,
}

async fn load_persisted() -> PersistedSettings {
    let Some(path) = settings_path() else {
        return PersistedSettings::default();
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) if !b.is_empty() => b,
        _ => return PersistedSettings::default(),
    };
    // Try the new shape first; on failure, attempt to read the legacy
    // (single-provider) shape and migrate it forward in-memory. The
    // migrated values get written back the first time the operator
    // saves anything.
    match serde_json::from_slice::<PersistedSettings>(&bytes) {
        Ok(mut p) => {
            // Old `api_key_plaintext` field that the modern struct no
            // longer carries: parse it from the raw JSON and migrate it
            // into `plaintext_credentials` under the active provider.
            if let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(legacy_key) = raw.get("api_key_plaintext").and_then(|v| v.as_str()) {
                    if !legacy_key.is_empty() {
                        let cred = Credential::ApiKey {
                            key: legacy_key.to_string(),
                        };
                        if let Ok(json) = serde_json::to_string(&cred) {
                            p.plaintext_credentials
                                .entry(p.settings.active_provider)
                                .or_insert(json);
                        }
                    }
                }
                // Old shape: settings.provider.{kind, base_url}. The
                // modern shape has `active_provider` + `providers` map.
                // Default handling on the new struct keeps `active_provider`
                // at OpenRouter and leaves `providers` empty — preserve
                // base_url override here so operator overrides survive.
                if let Some(legacy_provider) = raw.pointer("/settings/provider") {
                    if let Some(kind_str) = legacy_provider.get("kind").and_then(|x| x.as_str()) {
                        if let Some(kind) = parse_provider_kind(kind_str) {
                            p.settings.active_provider = kind;
                            let base_url = legacy_provider
                                .get("base_url")
                                .and_then(|x| x.as_str())
                                .map(|s| s.to_string())
                                .filter(|s| !s.is_empty());
                            p.settings
                                .providers
                                .entry(kind)
                                .or_insert(ProviderConfig { base_url });
                        }
                    }
                }
            }
            p
        }
        Err(e) => {
            tracing::warn!(error = %e, "agent_settings.json: falling back to default");
            PersistedSettings::default()
        }
    }
}

fn parse_provider_kind(s: &str) -> Option<ProviderKind> {
    serde_json::from_value::<ProviderKind>(serde_json::Value::String(s.to_string())).ok()
}

async fn save_persisted(p: &PersistedSettings) -> std::io::Result<()> {
    let Some(path) = settings_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec_pretty(p)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    tokio::fs::write(&path, bytes).await
}

/// Returns the credential for `kind`, preferring the keychain. Falls back
/// to the plaintext store iff the operator opted in. Returns `None` if
/// neither source has anything.
async fn read_credential(kind: ProviderKind) -> Option<Credential> {
    if let Ok(c) = agent_keyring::get_credential(kind) {
        return Some(c);
    }
    let p = load_persisted().await;
    if !p.settings.allow_plaintext_api_key {
        return None;
    }
    p.plaintext_credentials
        .get(&kind)
        .and_then(|json| serde_json::from_str::<Credential>(json).ok())
}

/// Effective credential for `kind` — the operator-configured one when
/// set, otherwise the provider's public-fallback key when it has one
/// (OpenCode Zen's free tier). This is what every chat / model-listing
/// path should call: it lets a fresh install hit the free models on
/// first run without forcing the operator through Settings → AI.
async fn effective_credential(kind: ProviderKind) -> Option<Credential> {
    if let Some(c) = read_credential(kind).await {
        return Some(c);
    }
    kind.public_fallback_key().map(|key| Credential::ApiKey {
        key: key.to_string(),
    })
}

async fn write_credential(kind: ProviderKind, cred: &Credential) -> Result<(), String> {
    if agent_keyring::is_available() {
        agent_keyring::set_credential(kind, cred).map_err(|e| e.to_string())?;
        // If a plaintext copy lingers from a prior plaintext-only
        // setup, drop it so the keychain stays the single source of
        // truth.
        let mut p = load_persisted().await;
        if p.plaintext_credentials.remove(&kind).is_some() {
            save_persisted(&p).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        let mut p = load_persisted().await;
        if !p.settings.allow_plaintext_api_key {
            return Err(
                "no keychain backend available and plaintext storage is not enabled".into(),
            );
        }
        let json = serde_json::to_string(cred).map_err(|e| e.to_string())?;
        p.plaintext_credentials.insert(kind, json);
        save_persisted(&p).await.map_err(|e| e.to_string())
    }
}

async fn clear_credential(kind: ProviderKind) -> Result<(), String> {
    let _ = agent_keyring::delete_credential(kind);
    let mut p = load_persisted().await;
    if p.plaintext_credentials.remove(&kind).is_some() {
        save_persisted(&p).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Wire types (Tauri command boundary) ────────────────────────────────────

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
    /// Usage report from the provider (token counts).
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
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
    /// first successful turn, when the backend's `maybe_spawn_auto_title`
    /// background task succeeds. The new title has already been
    /// journaled via `SessionUpdate { title }` at the time this event is
    /// emitted — the UI just mirrors it onto its `meta.title` so the
    /// header chip updates without a session reload.
    TitleUpdated { title: String },
}

// ─── Chat registry: live chats keyed by chat_id ─────────────────────────────

/// Live state for one MCP server within a chat. Created at chat-open from
/// an `McpServerConfig` entry; either resolves to a running `McpProcess`
/// with a populated `tools` cache, or to `process: None` + a failure
/// `message`. Either way, kept in `ChatRuntime::mcp_servers` so the UI
/// can render the per-source status row.
struct McpServerHandle {
    /// Stable id from the source config. Lets the frontend address one
    /// server unambiguously across status updates.
    id: String,
    /// Operator-friendly label from the config, used in status events and
    /// the tools-popover source grouping.
    name: String,
    /// Live child + JSON-RPC client. `None` when the spawn / `initialize`
    /// failed; `tools` is empty in that case and `message` carries the
    /// reason.
    process: Option<Arc<McpProcess>>,
    /// Cached `tools/list` from this server. Drives both the LLM's tool
    /// schema enumeration and the dispatch lookup (we walk this list to
    /// route a tool name back to the owning client).
    tools: Vec<McpTool>,
    /// Failure message. `None` on success.
    message: Option<String>,
}

/// Per-live-chat handle. A chat is bound to one session + one cluster;
/// re-opening the same session creates a new `chat_id`.
struct ChatRuntime {
    session_id: String,
    cluster_id: String,
    /// Most recent model id for new turns. Mirrors `SessionMeta::model`.
    model: String,
    /// Per-chat approval mode. Mirrors `SessionMeta::approval_mode`.
    approval_mode: ApprovalMode,
    /// Per-chat sampling overrides. `None` lets the provider pick its
    /// default. Operators tweak these from the chat header. Persisted via
    /// `SessionEvent::SessionUpdate` like approval_mode.
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    /// Per-chat free-form provider knobs (Anthropic `thinking`, OpenAI
    /// `reasoning`, OpenRouter routing). Merged into the request body
    /// last so they win over our defaults. `None` ⇒ provider defaults.
    provider_options: Option<serde_json::Value>,
    /// Latest cumulative token count from the most recent `Usage`
    /// event. Drives the auto-compaction trigger. Resets to 0 after a
    /// successful compaction (the next call's Usage will again be the
    /// running total — providers report cumulative for the request,
    /// not delta — so we keep the most recent observation, not a
    /// running sum across turns).
    last_total_tokens: u32,
    /// `true` when a compaction is mid-flight or already produced a
    /// summary that's pending injection on the next round. Prevents
    /// re-triggering on the round that actually applies the summary.
    compaction_in_flight: bool,
    /// Where to send streaming events.
    channel: Channel<ChatEvent>,
    /// In-memory transcript accumulator. Keeps the loop from re-reading the
    /// JSONL on every turn. Hydrated from `SessionStore::load` when the chat
    /// opens; then appended to on every turn.
    messages: Vec<ChatMessage>,
    /// Cancellation handle for the in-flight `stream_completion` future.
    /// Set while a turn is running so `chat_cancel_streaming` can abort.
    cancel: Option<tokio::task::AbortHandle>,
    /// `message_id` of the assistant bubble currently being streamed.
    /// `Some` from `AssistantStart` until `AssistantEnd`. Lets
    /// `chat_cancel_streaming` close the bubble cleanly when the spawned
    /// task is aborted (the dropped future can't emit `AssistantEnd`
    /// itself).
    in_flight_message_id: Option<String>,
    /// Per-server MCP handles, one entry per enabled server in the
    /// operator's config. Each handle owns the child process plus the
    /// cached `tools/list` response. Failed spawns appear with
    /// `process: None` and a `message` describing the failure so the UI
    /// can surface it without a separate error channel. The vector is
    /// allowed to be empty — native tools alone make the chat usable.
    mcp_servers: Vec<McpServerHandle>,
    /// Shared SSH-tunneled scratch kubeconfig path. Materialised once at
    /// chat-open and pointed at by every MCP child's `KUBECONFIG`. We
    /// own the file's lifetime (delete on chat_close) so multiple servers
    /// can share it without racing on cleanup.
    external_scratch: Option<PathBuf>,
    /// Native (in-process) tools the FerrisScope app exposes directly to the
    /// agent. Always populated regardless of MCP state — these are what makes
    /// the chat useful even before MCP finishes spawning. Merged with the
    /// MCP catalogue at `tools_to_schemas` time.
    native: NativeRegistry,
    /// In-flight approval requests, keyed by tool call id. The agent loop
    /// awaits each receiver while the UI surfaces the approval card; the
    /// `chat_approve_tool_call` command sends the operator's decision.
    pending_approvals: HashMap<String, oneshot::Sender<ApprovalDecision>>,
    /// Tool names the operator has greenlit for the rest of this chat
    /// (Approve always). Cleared on chat close. Survives across turns but
    /// is intentionally NOT persisted to JSONL — re-opening a chat resets
    /// the always-allow set so trust doesn't accidentally span sessions.
    approved_always: HashSet<String>,
    /// `true` once `maybe_spawn_auto_title` has fired for this chat —
    /// either a title-gen task is in-flight or already completed.
    /// Prevents double-renaming when subsequent turns would otherwise
    /// re-trigger the heuristic. Reset on chat re-open (re-opening a
    /// session that's already been auto-titled won't fire again because
    /// the persisted `meta.title` will no longer match the placeholder).
    auto_title_done: bool,
}

#[derive(Default)]
pub(crate) struct AgentState {
    chats: Mutex<HashMap<String, Arc<Mutex<ChatRuntime>>>>,
    store: Mutex<Option<SessionStore>>,
}

impl AgentState {
    async fn store(&self) -> Result<SessionStore, String> {
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

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn ai_get_settings(
    _state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let p = load_persisted().await;
    let kc_available = agent_keyring::is_available();
    let mut providers = HashMap::with_capacity(ProviderKind::all().len());
    for kind in ProviderKind::all() {
        let m: &ProviderMeta = meta::for_kind(*kind);
        let base_url_override = p
            .settings
            .providers
            .get(kind)
            .and_then(|c| c.base_url.clone());
        let cred = read_credential(*kind).await;
        // Providers with a public fallback (OpenCode Zen's free tier)
        // report as configured even without an operator credential —
        // chat / model-listing paths use `effective_credential` and
        // the request still succeeds. We surface the distinction
        // through `account_label = "free tier"` so the UI can show
        // operators which mode they're in.
        let public_fallback_active = cred.is_none() && kind.public_fallback_key().is_some();
        let auth_mode = if public_fallback_active {
            Some("api_key".to_string())
        } else {
            cred.as_ref()
                .map(Credential::auth_mode_label)
                .map(str::to_string)
        };
        let account_label = if public_fallback_active {
            Some("free tier".to_string())
        } else {
            cred.as_ref().and_then(|c| match c {
                Credential::OAuth { account_id, .. } => account_id.clone(),
                _ => None,
            })
        };
        providers.insert(
            *kind,
            ProviderStatusWire {
                kind: *kind,
                id: m.id.to_string(),
                display_name: m.display_name.to_string(),
                default_base_url: m.default_base_url.to_string(),
                base_url_override,
                auth_modes: m
                    .auth_modes
                    .iter()
                    .map(|m| match m {
                        ferrisscope_agent::AuthMode::ApiKey => "api_key".to_string(),
                        ferrisscope_agent::AuthMode::OAuth => "oauth".to_string(),
                    })
                    .collect(),
                auth_mode,
                configured: cred.is_some() || public_fallback_active,
                account_label,
            },
        );
    }
    Ok(AiSettingsWire {
        active_provider: p.settings.active_provider,
        providers,
        default_model: p.settings.default_model.clone(),
        default_approval_mode: p.settings.default_approval_mode,
        system_prompt_override: p.settings.system_prompt_override.clone(),
        allow_plaintext_api_key: p.settings.allow_plaintext_api_key,
        keychain_available: kc_available,
        mcp_servers: p.settings.mcp_servers.clone(),
        mcp_binary_path: p.settings.mcp_binary_path.clone(),
        reasoning: p.settings.reasoning,
    })
}

#[tauri::command]
pub(crate) async fn ai_set_settings(
    patch: AiSettingsPatch,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let mut p = load_persisted().await;
    if let Some(k) = patch.active_provider {
        p.settings.active_provider = k;
    }
    if let Some(bu) = patch.provider_base_url {
        let cfg = p.settings.providers.entry(bu.provider).or_default();
        cfg.base_url = if bu.base_url.is_empty() {
            None
        } else {
            Some(bu.base_url)
        };
    }
    if let Some(m) = patch.default_model {
        p.settings.default_model = if m.is_empty() { None } else { Some(m) };
    }
    if let Some(am) = patch.default_approval_mode {
        p.settings.default_approval_mode = am;
    }
    if let Some(s) = patch.system_prompt_override {
        p.settings.system_prompt_override = if s.is_empty() { None } else { Some(s) };
    }
    if let Some(allow_plaintext) = patch.allow_plaintext_api_key {
        p.settings.allow_plaintext_api_key = allow_plaintext;
        if !allow_plaintext {
            p.plaintext_credentials.clear();
        }
    }
    if let Some(path) = patch.mcp_binary_path {
        p.settings.mcp_binary_path = if path.is_empty() { None } else { Some(path) };
    }
    if let Some(servers) = patch.mcp_servers {
        // Normalise: drop entries with empty name + empty command (operator
        // added a row and abandoned it). Trim names so leading/trailing
        // whitespace doesn't sneak into status messages.
        p.settings.mcp_servers = servers
            .into_iter()
            .filter_map(|mut s| {
                s.name = s.name.trim().to_string();
                s.command = s.command.trim().to_string();
                if s.name.is_empty() && s.command.is_empty() {
                    None
                } else {
                    Some(s)
                }
            })
            .collect();
    }
    if let Some(reasoning) = patch.reasoning {
        // UI sends `0` from the budget select's "off" option; coerce
        // to `None` so we don't ship `budget_tokens: 0` (which some
        // providers treat as enabled-but-zero — pure tax).
        p.settings.reasoning = ReasoningSettings {
            effort: reasoning.effort,
            budget_tokens: reasoning.budget_tokens.filter(|b| *b > 0),
        };
    }

    save_persisted(&p).await.map_err(|e| e.to_string())?;
    ai_get_settings(state).await
}

/// Persist a credential for `provider`. Used by both the API-key form
/// (`Credential::ApiKey`) and the OAuth flow's success path
/// (`Credential::OAuth`). The frontend never reads back the credential
/// — just the boolean `configured` flag in `AiSettingsWire`.
#[tauri::command]
pub(crate) async fn ai_set_credential(
    provider: ProviderKind,
    credential: Credential,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    write_credential(provider, &credential).await?;
    ai_get_settings(state).await
}

#[tauri::command]
pub(crate) async fn ai_delete_credential(
    provider: ProviderKind,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    clear_credential(provider).await?;
    ai_get_settings(state).await
}

#[tauri::command]
pub(crate) async fn ai_oauth_login(
    provider: ProviderKind,
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let cred = agent_oauth::login(app, provider)
        .await
        .map_err(|e| e.to_string())?;
    write_credential(provider, &cred).await?;
    ai_get_settings(state).await
}

#[tauri::command]
pub(crate) async fn ai_oauth_cancel() -> Result<(), String> {
    agent_oauth::cancel().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_test_provider(
    req: ProviderTestRequest,
    _state: State<'_, AgentState>,
) -> Result<ProviderTestResult, String> {
    let cred = Credential::ApiKey { key: req.api_key };
    let provider = match build_provider(req.provider, &cred, req.base_url, None, None) {
        Ok(p) => p,
        Err(e) => {
            return Ok(ProviderTestResult {
                ok: false,
                model_count: 0,
                error: Some(e),
            })
        }
    };
    match provider.list_models().await {
        Ok(models) => Ok(ProviderTestResult {
            ok: true,
            model_count: models.len(),
            error: None,
        }),
        Err(e) => Ok(ProviderTestResult {
            ok: false,
            model_count: 0,
            error: Some(e.to_string()),
        }),
    }
}

/// How many tool names to surface on a successful test response. Operators
/// see this in a hover hint; we don't need the full catalogue, just enough
/// to confirm the right server answered.
const MCP_TEST_NAME_PREVIEW: usize = 12;

/// Cap on captured stderr bytes. Enough to show the failing line plus a
/// few lines of context, not enough to OOM if the child is in a logging
/// loop. Tail-bias: when we hit the cap we keep the most recent lines.
const MCP_TEST_STDERR_CAP: usize = 8192;

/// Timeouts for the test path — generous because tools like `npx -y` cold
/// download the package on first run (frequently 20–40s). The production
/// chat-open path has tighter budgets; we don't share them.
const MCP_TEST_OVERALL: std::time::Duration = std::time::Duration::from_secs(90);
const MCP_TEST_INITIALIZE: std::time::Duration = std::time::Duration::from_secs(60);
const MCP_TEST_LIST_TOOLS: std::time::Duration = std::time::Duration::from_secs(30);

#[tauri::command]
pub(crate) async fn mcp_test_server(
    config: McpServerConfig,
    _state: State<'_, AgentState>,
) -> Result<McpTestResult, String> {
    use std::process::Stdio;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;
    use tokio::sync::Mutex as AsyncMutex;

    let bin = config.command.trim();
    if bin.is_empty() {
        return Ok(McpTestResult {
            ok: false,
            tool_count: 0,
            tool_names: Vec::new(),
            error: Some("command is empty".to_string()),
        });
    }

    // Spawn the child ourselves rather than going through `McpProcess::spawn`
    // — we want a longer initialize budget (npx-y cold-starts), and we want
    // to capture stderr into the response so a failure mode like "module
    // not found" or "permission denied" is visible to the operator instead
    // of vanishing into our tracing log.
    let mut cmd = Command::new(bin);
    if !config.args.is_empty() {
        cmd.args(&config.args);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(McpTestResult {
                ok: false,
                tool_count: 0,
                tool_names: Vec::new(),
                error: Some(format!("failed to spawn `{bin}`: {e}")),
            });
        }
    };

    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            return Ok(McpTestResult {
                ok: false,
                tool_count: 0,
                tool_names: Vec::new(),
                error: Some("child has no stdin pipe".to_string()),
            });
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            return Ok(McpTestResult {
                ok: false,
                tool_count: 0,
                tool_names: Vec::new(),
                error: Some("child has no stdout pipe".to_string()),
            });
        }
    };

    // Capture stderr into a tail-biased buffer. Drains continuously so the
    // pipe doesn't fill and stall the child; on cap-overflow we drop the
    // *front* so the most recent lines (likely containing the failure
    // reason) survive.
    let stderr_buf: Arc<AsyncMutex<String>> = Arc::new(AsyncMutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let mut g = buf.lock().await;
                        g.push_str(&line);
                        if g.len() > MCP_TEST_STDERR_CAP {
                            // Trim to keep the last cap bytes; aligns to the
                            // next newline so we don't bisect an entry mid-
                            // line for the operator to read.
                            let drop_to = g.len() - MCP_TEST_STDERR_CAP;
                            let cut = g[drop_to..].find('\n').map_or(drop_to, |i| drop_to + i + 1);
                            g.drain(..cut);
                        }
                    }
                }
            }
        });
    }

    let client = ferrisscope_agent::McpClient::new(stdin, stdout);

    let outcome: Result<Vec<ferrisscope_agent::mcp::McpTool>, String> =
        tokio::time::timeout(MCP_TEST_OVERALL, async {
            tokio::time::timeout(
                MCP_TEST_INITIALIZE,
                client.initialize("ferrisscope", env!("CARGO_PKG_VERSION")),
            )
            .await
            .map_err(|_| "MCP `initialize` timed out — server didn't respond in 60s".to_string())?
            .map_err(|e| format!("MCP `initialize` failed: {e}"))?;

            tokio::time::timeout(MCP_TEST_LIST_TOOLS, client.list_tools())
                .await
                .map_err(|_| {
                    "MCP `tools/list` timed out — server didn't respond in 30s".to_string()
                })?
                .map_err(|e| format!("MCP `tools/list` failed: {e}"))
        })
        .await
        .unwrap_or_else(|_| Err("test timed out after 90s overall".to_string()));

    // Kill the child explicitly. `kill_on_drop` covers us anyway, but this
    // signals immediately rather than waiting for the wrapper Drop.
    let _ = child.start_kill();
    // Give the stderr reader a brief moment to drain anything the child
    // emitted on its way out — final messages often carry the cause.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let captured = stderr_buf.lock().await.clone();
    let stderr_tail = if captured.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nstderr:\n{}", captured.trim_end())
    };

    Ok(match outcome {
        Ok(tools) => {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = tools.len() as u32;
            let tool_names = tools
                .iter()
                .take(MCP_TEST_NAME_PREVIEW)
                .map(|t| t.name.clone())
                .collect();
            McpTestResult {
                ok: true,
                tool_count,
                tool_names,
                error: None,
            }
        }
        Err(e) => McpTestResult {
            ok: false,
            tool_count: 0,
            tool_names: Vec::new(),
            error: Some(format!("{e}{stderr_tail}")),
        },
    })
}

/// List models for a provider. Defaults to `active_provider` when
/// `provider` is absent so the existing single-provider call sites keep
/// working. The provider must already be configured (credential set).
#[tauri::command]
pub(crate) async fn ai_list_models(
    provider: Option<ProviderKind>,
    _state: State<'_, AgentState>,
) -> Result<Vec<ModelInfo>, String> {
    let p = load_persisted().await;
    let kind = provider.unwrap_or(p.settings.active_provider);
    // Determine whether the public-tier fallback is in effect *before*
    // we hand the credential to the provider — the upstream catalogue
    // doesn't gate models by key, so we filter client-side from
    // models.dev cost data when no operator key is present.
    let operator_credential = read_credential(kind).await;
    let public_fallback_active =
        operator_credential.is_none() && kind.public_fallback_key().is_some();
    let cred = operator_credential
        .or_else(|| {
            kind.public_fallback_key().map(|key| Credential::ApiKey {
                key: key.to_string(),
            })
        })
        .ok_or_else(|| "no credential configured for this provider".to_string())?;
    let base_url = p
        .settings
        .providers
        .get(&kind)
        .and_then(|c| c.base_url.clone());
    let provider_impl = build_provider(kind, &cred, base_url, None, None)?;
    let mut models = provider_impl
        .list_models()
        .await
        .map_err(|e| e.to_string())?;
    // OpenCode Zen on the public tier — drop everything the catalogue
    // marks as paid. Mirrors opencode's `cost.input === 0` filter.
    // When the catalogue hasn't loaded yet for this provider we leave
    // the list alone (better to show all and let the upstream reject
    // paid-model requests than to show an empty picker on first run).
    if public_fallback_active && ferrisscope_agent::provider::catalogue::has_data_for(kind) {
        models.retain(|m| ferrisscope_agent::provider::catalogue::is_known_free(kind, &m.id));
    }
    Ok(models)
}

#[tauri::command]
pub(crate) async fn chat_create_session(
    cluster_id: String,
    model: Option<String>,
    state: State<'_, AgentState>,
) -> Result<SessionMeta, String> {
    let store = state.store().await?;
    let p = load_persisted().await;
    let model_id = model
        .or_else(|| p.settings.default_model.clone())
        .unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis();
    let meta = SessionMeta {
        id: uuid::Uuid::new_v4().to_string(),
        cluster_id,
        title: "New chat".to_string(),
        created_at_unix_ms: now,
        updated_at_unix_ms: now,
        provider_kind: p.settings.active_provider,
        model: model_id,
        approval_mode: p.settings.default_approval_mode,
        temperature: None,
        max_tokens: None,
        provider_options: None,
        last_total_tokens: None,
    };
    store
        .create(meta.clone())
        .await
        .map_err(session_err_to_string)?;
    Ok(meta)
}

#[tauri::command]
pub(crate) async fn chat_list_sessions(
    cluster_id: Option<String>,
    state: State<'_, AgentState>,
) -> Result<Vec<SessionMeta>, String> {
    let store = state.store().await?;
    store
        .list(cluster_id.as_deref())
        .await
        .map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_load_session(
    session_id: String,
    state: State<'_, AgentState>,
) -> Result<SessionData, String> {
    let store = state.store().await?;
    store.load(&session_id).await.map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_rename_session(
    session_id: String,
    title: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let store = state.store().await?;
    store
        .rename(&session_id, title)
        .await
        .map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_delete_session(
    session_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let store = state.store().await?;
    store
        .delete(&session_id)
        .await
        .map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_open(
    session_id: String,
    on_event: Channel<ChatEvent>,
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
    app_state: State<'_, AppState>,
) -> Result<ChatOpenResult, String> {
    let store = state.store().await?;
    let data = store
        .load(&session_id)
        .await
        .map_err(session_err_to_string)?;

    let messages: Vec<ChatMessage> = data
        .events
        .iter()
        .filter_map(|e| {
            if let SessionEvent::Message { message, .. } = e {
                Some(message.clone())
            } else {
                None
            }
        })
        .collect();

    // Most recent Usage event seeds the running token count on
    // reopen. The session index keeps it on the meta so this is
    // O(1); we also fall back to scanning the events when the meta
    // doesn't carry the field (older sessions that pre-date Usage
    // tracking, or during the brief window before the first Usage
    // appends).
    let last_usage_from_events: Option<(u32, u32, u32)> = data.events.iter().rev().find_map(|e| {
        if let SessionEvent::Usage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            ..
        } = e
        {
            Some((*prompt_tokens, *completion_tokens, *total_tokens))
        } else {
            None
        }
    });
    let seeded_total = data
        .meta
        .last_total_tokens
        .or_else(|| last_usage_from_events.map(|(_, _, t)| t))
        .unwrap_or(0);

    // Resolve the kubeconfig path AND context name for this session's
    // cluster, so the MCP server targets the chat's bound context — not
    // whatever happens to be `current-context:` in the source file. We pin
    // it via a per-chat scratch override (see McpProcess::spawn). Failing
    // to resolve is non-fatal — we fall back to the source's current-context.
    //
    // SSH sources need a different shape: we materialise a self-contained
    // scratch kubeconfig pointing at the local SSH tunnel port (the same
    // tunnel our in-process kube client already uses), then pass it as
    // `external_scratch` so the merge logic is bypassed. The cluster must
    // be pre-connected so the tunnel exists before we read its port; we
    // call `state.entry()` here for both branches because connect is a
    // no-op if the entry already exists.
    let (kubeconfig_path, context_name) = {
        let sources = app_state.sources.lock().await;
        let path = kubeconfig::resolve_path_for(&data.meta.cluster_id, &sources);
        let ctx = kubeconfig::context_name_from_id(&data.meta.cluster_id).to_string();
        (path, ctx)
    };

    let cluster_id_for_mcp = data.meta.cluster_id.clone();
    // Build the SSH scratch kubeconfig if this cluster is SSH-sourced. Done
    // before the MCP child spawn task is queued so a failure here surfaces
    // as a clean error in the chat (we still proceed; the chat is usable
    // with native tools only).
    let external_scratch = crate::ssh_scratch::materialize_if_needed(
        &cluster_id_for_mcp,
        &context_name,
        "mcp",
        &app_state,
    )
    .await;

    // External MCP servers — operator-configured only. Empty list = chat
    // runs with native tools only (which cover the full kubernetes
    // management surface). The `mcp_servers` list wins; when empty we
    // fall back to the legacy single-binary `mcp_binary_path` so older
    // configs keep working without a save migration.
    let persisted = load_persisted().await;
    let mcp_servers_cfg: Vec<McpServerConfig> = if !persisted.settings.mcp_servers.is_empty() {
        persisted
            .settings
            .mcp_servers
            .iter()
            .filter(|s| s.enabled)
            .cloned()
            .collect()
    } else if let Some(legacy) = persisted
        .settings
        .mcp_binary_path
        .as_ref()
        .filter(|p| !p.trim().is_empty())
    {
        vec![McpServerConfig {
            id: "legacy".to_string(),
            name: "MCP server".to_string(),
            command: legacy.clone(),
            args: Vec::new(),
            env: HashMap::new(),
            enabled: true,
        }]
    } else {
        Vec::new()
    };

    // Native tools are built unconditionally and per-chat. They close over
    // the AppHandle and cluster id, so subsequent tool calls don't need to
    // pass cluster context — and they work even if the external MCP server
    // failed to spawn.
    let native = agent_native::build_registry(app.clone(), data.meta.cluster_id.clone());

    let chat_id = format!("chat-{}", uuid::Uuid::new_v4());
    let on_event_for_replay = on_event.clone();
    let last_usage_for_replay = last_usage_from_events;
    // Pre-populate the per-server handles in pending state so the initial
    // McpStatus event has the right server count — the UI can render the
    // "starting…" rows immediately while spawns settle in the background.
    let pending_servers: Vec<McpServerHandle> = mcp_servers_cfg
        .iter()
        .map(|s| McpServerHandle {
            id: s.id.clone(),
            name: s.name.clone(),
            process: None,
            tools: Vec::new(),
            message: None,
        })
        .collect();
    let runtime = Arc::new(Mutex::new(ChatRuntime {
        session_id,
        cluster_id: data.meta.cluster_id.clone(),
        model: data.meta.model.clone(),
        approval_mode: data.meta.approval_mode,
        temperature: data.meta.temperature,
        max_tokens: data.meta.max_tokens,
        provider_options: data.meta.provider_options.clone(),
        last_total_tokens: seeded_total,
        compaction_in_flight: false,
        channel: on_event,
        messages,
        cancel: None,
        in_flight_message_id: None,
        mcp_servers: pending_servers,
        external_scratch: external_scratch.clone(),
        native,
        pending_approvals: HashMap::new(),
        approved_always: HashSet::new(),
        // Reset every chat-open. The persisted `meta.title` is the
        // source of truth: if it's still the placeholder when the
        // first turn finishes, we attempt auto-naming exactly once.
        auto_title_done: false,
    }));
    state
        .chats
        .lock()
        .await
        .insert(chat_id.clone(), runtime.clone());

    // Belt-and-braces replay of the most recent persisted Usage so
    // the chat-header chip shows the running total immediately. The
    // primary path is the meta field (read directly by the UI from
    // chat_load_session); this Channel.send is the fallback for the
    // open-without-load path. Send is non-blocking — Tauri queues it
    // on the existing Channel; the JS handler is already attached
    // (set up in api.chatOpen before invoke).
    if let Some((p, c, t)) = last_usage_for_replay {
        // Spawn so we don't hold up chat_open's return on a slow IPC
        // post (the Channel send is sync-ish but the queue write
        // takes a write lock); the user-perceived latency on chat
        // open shouldn't include this.
        let chan = on_event_for_replay;
        tauri::async_runtime::spawn(async move {
            // Brief delay so the JS-side promise settles `chatId` and
            // any state-init effects fire before the Usage event
            // arrives. Without this, races like "frontend resets
            // usage state on chat-id change AFTER our send" leave
            // the chip empty.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = chan.send(ChatEvent::Usage {
                prompt_tokens: p,
                completion_tokens: c,
                total_tokens: t,
            });
        });
    }

    // Heal any orphan tool_calls left over from a previously cancelled
    // / crashed turn. The next provider call would 400 otherwise. We
    // run this immediately on open rather than only at turn-start so
    // re-opening a chat after a crash leaves the in-memory transcript
    // self-consistent for the model picker / preview UI too.
    {
        let store_for_heal = match state.store().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "chat_open: cannot acquire store for orphan repair");
                let initial = initial_status_for_open(&runtime).await;
                return Ok(ChatOpenResult {
                    chat_id,
                    native_tool_count: initial.0,
                    mcp_servers: initial.1,
                });
            }
        };
        let cluster_for_heal = data.meta.cluster_id.clone();
        let session_for_heal = data.meta.id.clone();
        repair_orphan_tool_calls(
            &runtime,
            &store_for_heal,
            &cluster_for_heal,
            &session_for_heal,
        )
        .await;
    }

    // Emit the initial status now so the inspector renders without
    // sitting on "Checking…" — every configured server is in pending
    // state until its background task lands a result. The same
    // snapshot is also returned in-band by `ChatOpenResult` so the
    // frontend can seed `view.mcp` synchronously without waiting on
    // the streamed event (Tauri channel events sent during the same
    // invoke can arrive AFTER the JS-side state-init effects, leaving
    // the chip stuck on "Tools · …"). The streamed event is kept for
    // operators who already have a chat open and re-emit via
    // `chat_refresh_status`.
    emit_mcp_status(&runtime).await;

    if mcp_servers_cfg.is_empty() {
        // No servers configured — the SSH scratch we speculatively
        // materialised has no consumer. Clear it from the runtime so the
        // chat_close cleanup is a no-op. Best-effort delete.
        let leftover = {
            let mut g = runtime.lock().await;
            g.external_scratch.take()
        };
        if let Some(p) = leftover {
            let _ = std::fs::remove_file(p);
        }
    } else {
        // Spawn each configured server in its own task so a slow server
        // doesn't block the others. Each task lands its result into the
        // runtime under the lock and emits a fresh `McpStatus` carrying
        // the full per-server snapshot. Order of completion doesn't
        // matter — the UI reads the most-recent event as authoritative.
        for (idx, cfg) in mcp_servers_cfg.into_iter().enumerate() {
            let runtime_for_mcp = runtime.clone();
            let kc_path = kubeconfig_path.clone();
            let ctx = context_name.clone();
            let scratch_path = external_scratch.clone();
            tokio::spawn(async move {
                let outcome = async {
                    let proc_ = McpProcess::spawn(
                        &cfg,
                        kc_path.as_ref(),
                        Some(ctx.as_str()),
                        scratch_path.as_deref(),
                    )
                    .await?;
                    let tools = tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        proc_.client.list_tools(),
                    )
                    .await
                    .map_err(|_| {
                        McpProcessError::Initialize(ferrisscope_agent::McpError::InvalidResponse(
                            "tools/list timed out".into(),
                        ))
                    })?
                    .map_err(McpProcessError::Initialize)?;
                    Ok::<_, McpProcessError>((Arc::new(proc_), tools))
                }
                .await;

                let mut g = runtime_for_mcp.lock().await;
                if let Some(slot) = g.mcp_servers.get_mut(idx) {
                    match outcome {
                        Ok((proc_, tools)) => {
                            slot.process = Some(proc_);
                            slot.tools = tools;
                            slot.message = None;
                        }
                        Err(e) => {
                            slot.process = None;
                            slot.tools.clear();
                            slot.message = Some(e.to_string());
                        }
                    }
                }
                let snapshot = mcp_status_snapshot(&g);
                let _ = g.channel.send(snapshot);
            });
        }
    }

    let initial = initial_status_for_open(&runtime).await;
    Ok(ChatOpenResult {
        chat_id,
        native_tool_count: initial.0,
        mcp_servers: initial.1,
    })
}

/// Snapshot the runtime's tool inventory for `chat_open`'s in-band
/// return value. Mirrors what `mcp_status_snapshot` builds for the
/// streaming `McpStatus` event but lifts the values out of the
/// `ChatEvent` enum so they can be serialised verbatim into
/// [`ChatOpenResult`].
async fn initial_status_for_open(
    runtime: &Arc<Mutex<ChatRuntime>>,
) -> (u32, Vec<McpServerStatusWire>) {
    let g = runtime.lock().await;
    #[allow(clippy::cast_possible_truncation)]
    let native_tool_count = g.native.tools().len() as u32;
    let servers = g
        .mcp_servers
        .iter()
        .map(|s| {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = s.tools.len() as u32;
            McpServerStatusWire {
                id: s.id.clone(),
                name: s.name.clone(),
                available: s.process.is_some(),
                tool_count,
                message: s.message.clone(),
            }
        })
        .collect();
    (native_tool_count, servers)
}

/// Build a per-server status snapshot from the live runtime. Used for both
/// the initial "everything pending" emit and the per-server-completed
/// updates. Caller must hold the runtime lock.
fn mcp_status_snapshot(g: &ChatRuntime) -> ChatEvent {
    #[allow(clippy::cast_possible_truncation)]
    let native_tool_count = g.native.tools().len() as u32;
    let servers = g
        .mcp_servers
        .iter()
        .map(|s| {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = s.tools.len() as u32;
            McpServerStatusWire {
                id: s.id.clone(),
                name: s.name.clone(),
                available: s.process.is_some(),
                tool_count,
                message: s.message.clone(),
            }
        })
        .collect();
    ChatEvent::McpStatus {
        servers,
        native_tool_count,
    }
}

async fn emit_mcp_status(runtime: &Arc<Mutex<ChatRuntime>>) {
    let g = runtime.lock().await;
    let evt = mcp_status_snapshot(&g);
    let _ = g.channel.send(evt);
}

#[tauri::command]
pub(crate) async fn chat_send_message(
    chat_id: String,
    content: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let runtime = {
        let chats = state.chats.lock().await;
        chats
            .get(&chat_id)
            .cloned()
            .ok_or_else(|| format!("chat not found: {chat_id}"))?
    };
    let store = state.store().await?;
    let p = load_persisted().await;
    // Pick the chat's provider from the persisted session meta, NOT the
    // currently-active global default — operators may have changed the
    // global default since the session was created. Old (pre-multi-
    // provider) sessions deserialised default to OpenRouter.
    let session_id_snapshot = runtime.lock().await.session_id.clone();
    let kind = match store.load(&session_id_snapshot).await {
        Ok(data) => data.meta.provider_kind,
        Err(_) => p.settings.active_provider,
    };
    let cred = effective_credential(kind)
        .await
        .ok_or_else(|| format!("no credential configured for provider {kind:?}"))?;
    let base_url = p
        .settings
        .providers
        .get(&kind)
        .and_then(|c| c.base_url.clone());
    let provider: Arc<dyn ChatProvider> = Arc::from(build_provider(
        kind,
        &cred,
        base_url,
        Some(session_id_snapshot.clone()),
        Some(make_credential_sink(kind)),
    )?);

    // Append the user message and decide whether to spawn a new turn or
    // hand off to the in-flight loop. Critical that the cancel-check and
    // append happen under one lock: if the loop is winding down it grabs
    // the lock to clear `cancel` and then re-checks for unanswered user
    // messages before exiting, so this critical section either lands
    // before the loop's check (loop picks up our message and re-runs) or
    // after (we see `cancel == None` and spawn fresh).
    let user_message = ChatMessage {
        role: MessageRole::User,
        content: content.clone(),
        tool_calls: vec![],
        tool_call_id: None,
        name: None,
    };
    let (cluster_id, session_id, queue_only) = {
        let mut rt = runtime.lock().await;
        rt.messages.push(user_message.clone());
        let queue_only = rt.cancel.is_some();
        (rt.cluster_id.clone(), rt.session_id.clone(), queue_only)
    };
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            &cluster_id,
            &session_id,
            SessionEvent::Message {
                message: user_message,
                ts: now,
            },
        )
        .await;

    if queue_only {
        // The running turn-loop will see this message at the top of its
        // next round (or, if it has already produced its final assistant
        // response, when it does its end-of-turn pending-message check).
        return Ok(());
    }

    let system_prompt = {
        let baseline = SYSTEM_PROMPT_BASELINE.to_string();
        match p.settings.system_prompt_override.as_ref() {
            Some(extra) if !extra.is_empty() => format!("{baseline}\n\n{extra}"),
            _ => baseline,
        }
    };

    let runtime_clone = runtime.clone();
    let store_clone = store.clone();
    let cluster_id_clone = cluster_id.clone();
    let session_id_clone = session_id.clone();
    // OpenAI's Codex Responses endpoint rejects unknown top-level
    // params (`reasoning_effort` 400s); Chat Completions accepts
    // both. Pick the right shape based on credential type — OAuth
    // ⇒ Codex Responses, ApiKey ⇒ Chat Completions.
    let is_oauth = matches!(cred, Credential::OAuth { .. });
    let provider_options_default = resolve_provider_options(kind, &p.settings, is_oauth);

    let join = tokio::spawn(async move {
        run_turn_loop(
            runtime_clone,
            store_clone,
            provider,
            system_prompt,
            cluster_id_clone,
            session_id_clone,
            provider_options_default,
        )
        .await;
    });
    let abort = join.abort_handle();
    runtime.lock().await.cancel = Some(abort);
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_cancel_streaming(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    if let Some(rt) = chats.get(&chat_id) {
        let mut rt = rt.lock().await;
        if let Some(handle) = rt.cancel.take() {
            handle.abort();
            // The aborted task can't emit `AssistantEnd` itself — its
            // future is dropped. Close the bubble + flip the streaming
            // flag from here so the UI doesn't hang on a perpetual
            // caret. Pending approvals also get drained: their senders
            // dropping unwinds awaiting tool futures via Denied.
            if let Some(message_id) = rt.in_flight_message_id.take() {
                let _ = rt.channel.send(ChatEvent::AssistantEnd {
                    message_id,
                    finish_reason: FinishReason::Other,
                });
            }
            let _ = rt.channel.send(ChatEvent::Error {
                message: "cancelled".into(),
            });
            rt.pending_approvals.clear();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_set_approval_mode(
    chat_id: String,
    mode: ApprovalMode,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let (cluster_id, session_id) = {
        let mut g = rt.lock().await;
        g.approval_mode = mode;
        (g.cluster_id.clone(), g.session_id.clone())
    };
    drop(chats);
    let store = state.store().await?;
    let now = chrono::Utc::now().timestamp_millis();
    store
        .append(
            &cluster_id,
            &session_id,
            SessionEvent::SessionUpdate {
                update: SessionUpdate {
                    approval_mode: Some(mode),
                    ..Default::default()
                },
                ts: now,
            },
        )
        .await
        .map_err(session_err_to_string)
}

/// Re-emit the current `McpStatus` for this chat through its event
/// channel. The chat header's tools chip is driven by mcp_status events
/// alone; the backend only emits at chat_open time and on MCP-server
/// spawn results, so any UI flow that resets `view.mcp` (a remount, a
/// stale-state race) leaves the chip showing "…" or an out-of-date
/// count. The frontend pings this on tab-becomes-visible / settings
/// close so the chip is eventually-consistent with the live runtime.
#[tauri::command]
pub(crate) async fn chat_refresh_status(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id).cloned() else {
        return Err(format!("chat not found: {chat_id}"));
    };
    drop(chats);
    emit_mcp_status(&rt).await;
    Ok(())
}

/// Switch the model used for this chat's next provider call. The
/// provider stays the same — model has to come from the session's
/// bound provider — and history is preserved. Updates the in-memory
/// runtime and journals a `SessionUpdate { model }` so reload picks
/// up the new id.
#[tauri::command]
pub(crate) async fn chat_set_model(
    chat_id: String,
    model: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err("model id cannot be empty".to_string());
    }
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let (cluster_id, session_id) = {
        let mut g = rt.lock().await;
        g.model = trimmed.to_string();
        (g.cluster_id.clone(), g.session_id.clone())
    };
    drop(chats);
    let store = state.store().await?;
    let now = chrono::Utc::now().timestamp_millis();
    store
        .append(
            &cluster_id,
            &session_id,
            SessionEvent::SessionUpdate {
                update: SessionUpdate {
                    model: Some(trimmed.to_string()),
                    ..Default::default()
                },
                ts: now,
            },
        )
        .await
        .map_err(session_err_to_string)
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

#[tauri::command]
pub(crate) async fn chat_list_tools(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<Vec<ChatToolWire>, String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let g = rt.lock().await;
    let mut out: Vec<ChatToolWire> = Vec::new();
    for server in &g.mcp_servers {
        for tool in &server.tools {
            out.push(ChatToolWire {
                name: tool.name.clone(),
                description: tool.description.clone(),
                category: category_label(classify_tool(&tool.name)),
                input_schema: tool.input_schema.clone(),
                source: server.name.clone(),
            });
        }
    }
    // Native tools come last, but otherwise look identical to MCP entries —
    // same wire shape so the inspector tree renders them with one code path.
    // We trust each tool's declared `category()` rather than re-running the
    // name heuristic, since native tools know their own kind exactly.
    for tool in g.native.tools() {
        let schema = tool.schema();
        out.push(ChatToolWire {
            name: schema.name,
            description: if schema.description.is_empty() {
                None
            } else {
                Some(schema.description)
            },
            category: category_label(tool.category()),
            input_schema: schema.parameters,
            source: "native".to_string(),
        });
    }
    Ok(out)
}

fn category_label(c: ToolCategory) -> &'static str {
    match c {
        ToolCategory::Read => "read",
        ToolCategory::Write => "write",
        ToolCategory::Unknown => "unknown",
    }
}

/// Manual compaction trigger. Operator clicks "Compact" in the chat
/// header; we fire a forced compaction outside the regular round
/// loop. Safe to call mid-streaming — `compaction_in_flight` and the
/// run-loop's per-round check serialise overlapping requests.
#[tauri::command]
pub(crate) async fn chat_compact(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let runtime = {
        let chats = state.chats.lock().await;
        chats
            .get(&chat_id)
            .cloned()
            .ok_or_else(|| format!("chat not found: {chat_id}"))?
    };
    let store = state.store().await?;
    let p = load_persisted().await;
    let session_id = runtime.lock().await.session_id.clone();
    let kind = match store.load(&session_id).await {
        Ok(d) => d.meta.provider_kind,
        Err(_) => p.settings.active_provider,
    };
    let cred = effective_credential(kind)
        .await
        .ok_or_else(|| format!("no credential configured for provider {kind:?}"))?;
    let base_url = p
        .settings
        .providers
        .get(&kind)
        .and_then(|c| c.base_url.clone());
    let provider: Arc<dyn ChatProvider> = Arc::from(build_provider(
        kind,
        &cred,
        base_url,
        Some(session_id.clone()),
        Some(make_credential_sink(kind)),
    )?);
    let cluster_id = runtime.lock().await.cluster_id.clone();
    run_compaction_internal(&runtime, &store, &provider, &cluster_id, &session_id, true).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_close(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let removed = state.chats.lock().await.remove(&chat_id);
    if let Some(rt) = removed {
        // Snapshot the native tool handles + scratch path under the lock,
        // then release it before we await on cleanup — pod deletion can
        // take a few hundred ms per pod and we don't want to hold the
        // chat lock during that.
        let (native_tools, scratch) = {
            let mut g = rt.lock().await;
            if let Some(handle) = g.cancel.take() {
                handle.abort();
            }
            // Drain pending approvals so the senders drop and any awaiting
            // tool-execution futures unwind via `Err -> Denied` mapping.
            g.pending_approvals.clear();
            // Drop all MCP server handles so their child processes are
            // killed (Drop on McpProcess does this). Held-open clients
            // would otherwise outlive the chat.
            g.mcp_servers.clear();
            (g.native.tools().to_vec(), g.external_scratch.take())
        };
        // Best-effort: fire every tool's lifecycle hook. Native tools that
        // own external state (debug pods, port-forwards) release it here.
        // Errors are logged inside the hook; we don't propagate.
        for tool in native_tools {
            tool.on_chat_close().await;
        }
        // Shared SSH-tunneled scratch kubeconfig — owned by the chat, not
        // any individual MCP process, so we delete it here once all the
        // servers that referenced it have been dropped above.
        if let Some(p) = scratch {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_approve_tool_call(
    chat_id: String,
    tool_call_id: String,
    decision: ApprovalDecision,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let tx = {
        let mut g = rt.lock().await;
        g.pending_approvals.remove(&tool_call_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(decision);
        Ok(())
    } else {
        // No-op: the approval already resolved (chat closed, race) — let
        // the UI silently drop the click rather than surface a confusing
        // error.
        Ok(())
    }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/// Construct the right `ChatProvider` impl for `kind`. Dispatches on the
/// provider's flavor metadata, with the special case that OpenAI flips
/// from Chat Completions (key mode) to the Codex Responses adapter
/// (OAuth mode) based on the credential type. `session_id` is plumbed
/// through to providers that need it as a request header (Codex);
/// `on_refresh` lets OAuth providers persist a rotated token back to
/// the keychain without the agent crate knowing about Tauri.
fn build_provider(
    kind: ProviderKind,
    cred: &Credential,
    base_url_override: Option<String>,
    session_id: Option<String>,
    on_refresh: Option<CredentialSink>,
) -> Result<Box<dyn ChatProvider>, String> {
    let m = meta::for_kind(kind);
    let oauth_mode = matches!(cred, Credential::OAuth { .. });
    let flavor = match (m.flavor, kind, oauth_mode) {
        // OpenAI + OAuth credential → Codex Responses adapter, regardless
        // of the metadata's default flavor (which is the API-key path).
        (_, ProviderKind::OpenAI, true) => ProviderFlavor::OpenAiResponses,
        (other, _, _) => other,
    };
    let provider: Box<dyn ChatProvider> = match flavor {
        ProviderFlavor::OpenAiCompat => Box::new(OpenAICompatibleProvider::for_kind(
            kind,
            cred,
            base_url_override,
            session_id.clone(),
        )),
        ProviderFlavor::AnthropicMessages => {
            Box::new(AnthropicProvider::new(cred, base_url_override))
        }
        ProviderFlavor::OpenAiResponses => {
            Box::new(OpenAICodexProvider::new(cred, session_id, on_refresh))
        }
    };
    Ok(provider)
}

/// Build the credential-rotation sink the OpenAI Codex provider uses to
/// persist refreshed access tokens. The sink is wired up at provider-
/// build time so a refresh during `stream_completion` writes the new
/// token straight to the keychain — the next chat turn picks it up
/// without the operator noticing.
fn make_credential_sink(kind: ProviderKind) -> CredentialSink {
    Arc::new(move |cred: Credential| {
        // Best-effort: log on failure but don't block the in-flight
        // call. The token is still good for the duration of the
        // current request; operator just gets an extra refresh on the
        // next turn if persistence failed.
        let kind = kind;
        tauri::async_runtime::spawn(async move {
            if let Err(e) = write_credential(kind, &cred).await {
                tracing::warn!(?kind, error = %e, "failed to persist refreshed credential");
            }
        });
    })
}

fn session_err_to_string(e: SessionError) -> String {
    e.to_string()
}

/// Map the universal `ReasoningSettings` onto `kind`'s native request
/// shape. Each provider takes whichever knobs it understands and
/// silently drops the rest. Returning `None` when the operator hasn't
/// asked for anything keeps the request body free of empty objects
/// that some servers reject.
///
/// `is_oauth_codex` distinguishes OpenAI's two paths: API-key mode
/// hits Chat Completions which accepts `reasoning_effort`, while OAuth
/// mode hits the Codex Responses endpoint which rejects it (400
/// "Unsupported parameter") and only takes `reasoning: { effort }`.
fn resolve_provider_options(
    kind: ProviderKind,
    settings: &AgentSettings,
    is_oauth_codex: bool,
) -> Option<serde_json::Value> {
    let r = &settings.reasoning;
    if !r.is_active() {
        return None;
    }
    let effort_label = r.effort.map(|e| match e {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
    });
    let mut out = serde_json::Map::new();
    match kind {
        // Anthropic Messages: `thinking: { type, budget_tokens }`.
        // Effort is ignored — Anthropic doesn't have an `effort` field;
        // when only `effort` is set we use the Sonnet-recommended
        // 16k mid budget, scaling with the effort knob.
        ProviderKind::Anthropic => {
            let budget = r.budget_tokens.or_else(|| {
                effort_label.map(|e| match e {
                    "low" => 4096,
                    "medium" => 16384,
                    "high" => 32768,
                    _ => 16384,
                })
            });
            if let Some(b) = budget {
                out.insert(
                    "thinking".to_string(),
                    serde_json::json!({
                        "type": "enabled",
                        "budget_tokens": b,
                    }),
                );
            }
        }
        // OpenAI: shape depends on which endpoint we'll hit.
        // - Chat Completions (API key): `reasoning_effort` top-level.
        // - Codex Responses (OAuth): `reasoning: { effort }` only —
        //   unknown top-level params 400 there.
        ProviderKind::OpenAI => {
            if let Some(label) = effort_label {
                if is_oauth_codex {
                    out.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "effort": label }),
                    );
                } else {
                    out.insert("reasoning_effort".to_string(), serde_json::json!(label));
                }
            }
        }
        // OpenRouter exposes a unified `reasoning` field that takes
        // both effort and max_tokens — it forwards to whichever
        // upstream provider the model maps to.
        ProviderKind::OpenRouter => {
            let mut node = serde_json::Map::new();
            if let Some(label) = effort_label {
                node.insert("effort".to_string(), serde_json::json!(label));
            }
            if let Some(b) = r.budget_tokens {
                node.insert("max_tokens".to_string(), serde_json::json!(b));
            }
            if !node.is_empty() {
                out.insert("reasoning".to_string(), serde_json::Value::Object(node));
            }
        }
        // DeepSeek r1 / reasoner models accept `reasoning_effort` as a
        // top-level OpenAI-compat extension. Other OpenAI-compat
        // providers (Groq, Mistral, Together, Z.AI, MiniMax, Ollama,
        // OpenCode Zen) don't have a public reasoning-control standard;
        // we still emit `reasoning_effort` because OpenAI-compat servers
        // typically tolerate unknown fields. Non-reasoning models
        // ignore it. OpenCode Zen specifically proxies to the underlying
        // vendor so this passes through to the appropriate native field
        // for the selected model.
        ProviderKind::Deepseek
        | ProviderKind::Groq
        | ProviderKind::Mistral
        | ProviderKind::Together
        | ProviderKind::Zai
        | ProviderKind::Minimax
        | ProviderKind::Ollama
        | ProviderKind::OpencodeZen => {
            if let Some(label) = effort_label {
                out.insert("reasoning_effort".to_string(), serde_json::json!(label));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(out))
    }
}

/// Multi-turn agent loop. Invokes the provider, streams the assistant
/// response, executes any returned tool calls, then re-invokes until
/// `finish_reason != ToolCalls` or the round cap is hit. After a
/// non-tool finish the loop checks whether the operator queued any
/// follow-up messages while it was running (`chat_send_message` appends
/// them rather than aborting the in-flight turn) — if so, the round
/// counter resets and we run another sub-turn so the model can address
/// the new question.
async fn run_turn_loop(
    runtime: Arc<Mutex<ChatRuntime>>,
    store: SessionStore,
    provider: Arc<dyn ChatProvider>,
    system_prompt: String,
    cluster_id: String,
    session_id: String,
    provider_options_default: Option<serde_json::Value>,
) {
    let mut round: u32 = 0;
    loop {
        if round >= MAX_TOOL_ROUNDS {
            // Round cap hit. Atomically clear cancel under the same lock
            // we'd use to claim a queued user message, then notify the UI.
            runtime.lock().await.cancel = None;
            let _ = runtime.lock().await.channel.send(ChatEvent::Error {
                message: format!("tool-call round limit reached ({MAX_TOOL_ROUNDS})"),
            });
            return;
        }
        round += 1;

        // Repair orphan tool calls in the transcript before doing
        // anything else. A turn that was cancelled (or crashed) mid-
        // tool-execution leaves an `Assistant` message with `tool_calls`
        // but no matching `Tool` results — the OpenAI Responses API
        // (and Anthropic) refuses such input with 400. We pad the
        // missing results with a synthetic "interrupted" tool message
        // so the transcript validates again. Persist the synthetic
        // entries so reload sees the same view.
        repair_orphan_tool_calls(&runtime, &store, &cluster_id, &session_id).await;

        // Auto-compaction: if the last Usage event landed us above the
        // model's usable window, summarise the head of the transcript
        // before the next provider call. The summarisation itself is a
        // provider call; we mark the chat as in-flight to prevent
        // re-trigger on the round that consumes the summary.
        maybe_run_compaction(&runtime, &store, &provider, &cluster_id, &session_id).await;
        // Snapshot the transcript and tool schemas under the mutex; release
        // before any awaiting on network/MCP IO.
        let (
            messages_so_far,
            tool_schemas,
            model,
            approval_mode,
            temperature,
            max_tokens,
            provider_options,
        ) = {
            let g = runtime.lock().await;
            let mut schemas: Vec<ToolSchema> = Vec::new();
            for server in &g.mcp_servers {
                schemas.extend(tools_to_schemas(&server.tools));
            }
            // Native tools are appended after MCP. If a name collides we
            // intentionally let the MCP entry win (the `fs_` prefix on
            // native tools makes collisions practically impossible, but
            // duplicate-name behaviour is undefined for the LLM either way).
            schemas.extend(g.native.schemas());
            // Per-chat override wins; otherwise inherit the
            // settings-derived default the caller computed.
            let opts = g
                .provider_options
                .clone()
                .or_else(|| provider_options_default.clone());
            (
                g.messages.clone(),
                schemas,
                g.model.clone(),
                g.approval_mode,
                g.temperature,
                g.max_tokens,
                opts,
            )
        };

        // Trim oldest tool messages when the transcript grows past the soft
        // budget. Keeps the system prompt, every user message, and the
        // latest assistant turn intact.
        let mut full_messages = Vec::with_capacity(messages_so_far.len() + 1);
        full_messages.push(ChatMessage {
            role: MessageRole::System,
            content: system_prompt.clone(),
            tool_calls: vec![],
            tool_call_id: None,
            name: None,
        });
        full_messages.extend(messages_so_far);
        truncate_transcript(&mut full_messages, TRANSCRIPT_CHAR_BUDGET);

        let req = CompletionRequest {
            model,
            messages: full_messages,
            tools: tool_schemas,
            temperature,
            max_tokens,
            provider_options: provider_options.clone(),
        };

        let proceed =
            run_provider_round(&runtime, &store, &provider, req, &cluster_id, &session_id).await;
        let (assistant_msg, finish_reason, tool_calls) = match proceed {
            ProviderRoundOutcome::Continue {
                assistant_msg,
                finish_reason,
                tool_calls,
            } => (assistant_msg, finish_reason, tool_calls),
            ProviderRoundOutcome::Stopped => {
                runtime.lock().await.cancel = None;
                return;
            }
        };

        if finish_reason != FinishReason::ToolCalls || tool_calls.is_empty() {
            // No tool calls — push the assistant message and decide
            // whether the turn is truly done. The cancel-clear and the
            // queued-user-message check live in one critical section so
            // a concurrent `chat_send_message` either lands its message
            // before the check (we keep going) or after we clear cancel
            // (it spawns a fresh turn). No third option.
            let (pending, title_snapshot) = {
                let mut g = runtime.lock().await;
                g.messages.push(assistant_msg);
                // Capture a once-per-chat snapshot for auto-titling.
                // We claim the slot under the same lock that pushed
                // the assistant message so concurrent turns can't
                // both fire the task. The actual provider call runs
                // outside this critical section.
                let snap = if g.auto_title_done {
                    None
                } else {
                    snapshot_for_title(&g.messages).map(|s| {
                        g.auto_title_done = true;
                        (s, g.model.clone())
                    })
                };
                let pending = if has_unanswered_user_message(&g.messages) {
                    round = 0;
                    true
                } else {
                    g.cancel = None;
                    false
                };
                (pending, snap)
            };
            if let Some((snap, model)) = title_snapshot {
                let provider_for_title = provider.clone();
                let store_for_title = store.clone();
                let runtime_for_title = runtime.clone();
                let cluster_for_title = cluster_id.clone();
                let session_for_title = session_id.clone();
                tauri::async_runtime::spawn(async move {
                    run_auto_title_task(
                        provider_for_title,
                        store_for_title,
                        runtime_for_title,
                        cluster_for_title,
                        session_for_title,
                        snap,
                        model,
                    )
                    .await;
                });
            }
            if pending {
                continue;
            }
            return;
        }

        // Fan out every requested tool call. Reads run truly concurrently;
        // writes serialise on the operator's approval. Results land in the
        // original tool_calls order so the assistant→tool sequence the
        // provider expects stays intact.
        let mut futures = Vec::with_capacity(tool_calls.len());
        for tc in &tool_calls {
            let runtime = runtime.clone();
            let store = store.clone();
            let cluster_id = cluster_id.clone();
            let session_id = session_id.clone();
            let tc = tc.clone();
            let category = classify_tool(&tc.name);
            futures.push(async move {
                let (content, is_error) = execute_tool_call(
                    &runtime,
                    &store,
                    &cluster_id,
                    &session_id,
                    &tc,
                    category,
                    approval_mode,
                )
                .await;
                (tc, content, is_error)
            });
        }
        let results = futures::future::join_all(futures).await;

        // Push assistant + every tool message into runtime state in one
        // locked critical section. This preserves the provider's required
        // ordering (an assistant message with `tool_calls` must be
        // immediately followed by the matching tool messages) even when
        // a concurrent `chat_send_message` queues a user message between
        // rounds — the user message can land before or after this batch,
        // never in the middle.
        let tool_msgs: Vec<ChatMessage> = results
            .iter()
            .map(|(tc, content, _)| ChatMessage {
                role: MessageRole::Tool,
                content: content.clone(),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
                name: Some(tc.name.clone()),
            })
            .collect();
        {
            let mut g = runtime.lock().await;
            g.messages.push(assistant_msg);
            for msg in &tool_msgs {
                g.messages.push(msg.clone());
            }
        }

        // Persist + emit events outside the lock.
        let now = chrono::Utc::now().timestamp_millis();
        for ((tc, content, is_error), tool_msg) in results.into_iter().zip(tool_msgs.into_iter()) {
            let _ = store
                .append(
                    &cluster_id,
                    &session_id,
                    SessionEvent::Message {
                        message: tool_msg,
                        ts: now,
                    },
                )
                .await;
            let _ = store
                .append(
                    &cluster_id,
                    &session_id,
                    SessionEvent::ToolResult {
                        call: tc.clone(),
                        result: content.clone(),
                        error: if is_error {
                            Some(content.clone())
                        } else {
                            None
                        },
                        ts: now,
                    },
                )
                .await;
            let _ = runtime.lock().await.channel.send(ChatEvent::ToolResult {
                tool_call_id: tc.id,
                name: tc.name,
                content,
                is_error,
            });
        }
    }
}

/// True iff the most recent `User` message has no `Assistant` message
/// after it. Used by `run_turn_loop` to detect operator messages queued
/// via `chat_send_message` while the model was busy.
fn has_unanswered_user_message(messages: &[ChatMessage]) -> bool {
    let last_user = messages
        .iter()
        .rposition(|m| matches!(m.role, MessageRole::User));
    let Some(last_user) = last_user else {
        return false;
    };
    let last_assistant = messages
        .iter()
        .rposition(|m| matches!(m.role, MessageRole::Assistant));
    match last_assistant {
        Some(a) => last_user > a,
        None => true,
    }
}

enum ProviderRoundOutcome {
    Continue {
        assistant_msg: ChatMessage,
        finish_reason: FinishReason,
        tool_calls: Vec<ToolCall>,
    },
    Stopped,
}

/// One provider invocation: stream tokens / tool-call deltas, persist the
/// assistant message, return the finish reason + collected tool calls.
async fn run_provider_round(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    req: CompletionRequest,
    cluster_id: &str,
    session_id: &str,
) -> ProviderRoundOutcome {
    let message_id = format!("msg-{}", uuid::Uuid::new_v4());
    let send = |ev: ChatEvent| {
        let rt = runtime.clone();
        async move {
            let g = rt.lock().await;
            let _ = g.channel.send(ev);
        }
    };
    // Record the in-flight bubble id so `chat_cancel_streaming` can close
    // it cleanly when the spawned task is aborted mid-stream.
    runtime.lock().await.in_flight_message_id = Some(message_id.clone());
    send(ChatEvent::AssistantStart {
        message_id: message_id.clone(),
    })
    .await;

    // Streaming sink: forwards events synchronously through the channel and
    // accumulates text for persistence. try_lock keeps a misbehaving
    // consumer from stalling the stream; on contention the event drops
    // (the persisted assistant message is the source of truth either way).
    let runtime_for_sink = runtime.clone();
    // std::sync::Mutex (NOT tokio::sync::Mutex) — the sink is sync, no
    // .await while holding, and we MUST NOT drop bytes on contention.
    // The previous tokio try_lock could silently lose characters when
    // the lock looked contended, leaving the persisted assistant
    // message with broken markdown (`[label](url)` mangled to
    // `[label]url)` on a missing `(` byte). std::Mutex::lock blocks
    // for at most a few µs here.
    let text_accum: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let text_clone = text_accum.clone();
    let provider_sink: ferrisscope_agent::provider::EventSink =
        Box::new(move |evt: CompletionEvent| {
            if let CompletionEvent::TokenDelta(s) = &evt {
                if let Ok(mut g) = text_clone.lock() {
                    g.push_str(s);
                }
            }
            if let Ok(g) = runtime_for_sink.try_lock() {
                let outgoing = match evt {
                    CompletionEvent::TokenDelta(s) => ChatEvent::TokenDelta { delta: s },
                    CompletionEvent::ToolCallStart { id, name } => {
                        ChatEvent::ToolCallStart { id, name }
                    }
                    CompletionEvent::ToolCallArgsDelta { id, json_delta } => {
                        ChatEvent::ToolCallArgsDelta { id, json_delta }
                    }
                    CompletionEvent::ToolCallEnd { id } => ChatEvent::ToolCallEnd { id },
                };
                let _ = g.channel.send(outgoing);
            }
        });

    let result = provider.stream_completion(req, provider_sink).await;

    let (finish_reason, tool_calls): (FinishReason, Vec<ToolCall>) = match result {
        Ok(final_) => {
            if let Some(usage) = &final_.usage {
                send(ChatEvent::Usage {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                })
                .await;
                // Stash the running total so the loop can decide
                // whether to compact before the next round. Providers
                // report cumulative `total_tokens` per request, so we
                // overwrite rather than accumulate.
                let total = if usage.total_tokens > 0 {
                    usage.total_tokens
                } else {
                    usage.prompt_tokens.saturating_add(usage.completion_tokens)
                };
                runtime.lock().await.last_total_tokens = total;
                // Persist so chat_open after a close can rehydrate
                // the running total — without this we lose the count
                // every time the operator reopens the chat window
                // and the compaction trigger silently sleeps until
                // the next round's Usage lands.
                let now = chrono::Utc::now().timestamp_millis();
                let _ = store
                    .append(
                        cluster_id,
                        session_id,
                        SessionEvent::Usage {
                            prompt_tokens: usage.prompt_tokens,
                            completion_tokens: usage.completion_tokens,
                            total_tokens: total,
                            ts: now,
                        },
                    )
                    .await;
            }
            (final_.finish_reason, final_.tool_calls)
        }
        Err(ProviderError::Cancelled) => {
            runtime.lock().await.in_flight_message_id = None;
            send(ChatEvent::Error {
                message: "cancelled".into(),
            })
            .await;
            return ProviderRoundOutcome::Stopped;
        }
        Err(e) => {
            runtime.lock().await.in_flight_message_id = None;
            send(ChatEvent::Error {
                message: e.to_string(),
            })
            .await;
            send(ChatEvent::AssistantEnd {
                message_id: message_id.clone(),
                finish_reason: FinishReason::Other,
            })
            .await;
            return ProviderRoundOutcome::Stopped;
        }
    };

    let final_text = text_accum.lock().map(|g| g.clone()).unwrap_or_default();
    let assistant_msg = ChatMessage {
        role: MessageRole::Assistant,
        content: final_text,
        tool_calls: tool_calls.clone(),
        tool_call_id: None,
        name: None,
    };
    runtime.lock().await.in_flight_message_id = None;
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Message {
                message: assistant_msg.clone(),
                ts: now,
            },
        )
        .await;

    send(ChatEvent::AssistantEnd {
        message_id,
        finish_reason,
    })
    .await;

    // Caller (`run_turn_loop`) is responsible for atomically pushing the
    // assistant + tool messages into runtime state and for clearing the
    // cancel handle when the turn finishes — that lock-coupled handoff is
    // how we keep mid-turn user-message queueing race-free.
    ProviderRoundOutcome::Continue {
        assistant_msg,
        finish_reason,
        tool_calls,
    }
}

/// Run a single tool call. Reads execute via MCP / native immediately.
/// Writes consult the approval bridge: `AllowAllWrites` (per-chat toggle) or
/// a name in `approved_always` runs immediately; otherwise we fire an
/// `ApprovalRequest` event, await the operator's decision over a oneshot,
/// then proceed (or refuse). Unknowns are treated as writes — fail safe.
///
/// Native tools take precedence: if a name resolves to a native tool, its
/// `category()` overrides the heuristic and dispatch goes in-process. Falls
/// through to MCP otherwise.
async fn execute_tool_call(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    cluster_id: &str,
    session_id: &str,
    tc: &ToolCall,
    category: ToolCategory,
    approval_mode: ApprovalMode,
) -> (String, bool) {
    let args: serde_json::Value = match serde_json::from_str(&tc.arguments) {
        Ok(v) => v,
        Err(_) if tc.arguments.trim().is_empty() => serde_json::Value::Null,
        Err(e) => {
            tracing::warn!(error = %e, name = %tc.name, "tool call: bad json args");
            serde_json::Value::Null
        }
    };

    // Native lookup wins over name-based heuristic classification.
    let native_tool = { runtime.lock().await.native.find(&tc.name) };
    let category = match &native_tool {
        Some(t) => t.category(),
        None => category,
    };

    let is_destructive = matches!(category, ToolCategory::Write | ToolCategory::Unknown);
    if is_destructive && approval_mode != ApprovalMode::AllowAllWrites {
        // "Approve always" remembers the tool name within this chat session.
        let already_allowed = {
            let g = runtime.lock().await;
            g.approved_always.contains(&tc.name)
        };
        if !already_allowed {
            match request_approval(runtime, tc).await {
                ApprovalDecision::Approved => {
                    persist_approval(
                        store,
                        cluster_id,
                        session_id,
                        &tc.id,
                        ApprovalDecision::Approved,
                    )
                    .await;
                }
                ApprovalDecision::ApprovedAlways => {
                    {
                        let mut g = runtime.lock().await;
                        g.approved_always.insert(tc.name.clone());
                    }
                    persist_approval(
                        store,
                        cluster_id,
                        session_id,
                        &tc.id,
                        ApprovalDecision::ApprovedAlways,
                    )
                    .await;
                }
                ApprovalDecision::Denied => {
                    persist_approval(
                        store,
                        cluster_id,
                        session_id,
                        &tc.id,
                        ApprovalDecision::Denied,
                    )
                    .await;
                    return (
                        format!(
                            "Operator denied execution of `{}`. Suggest a different \
                             approach or ask the operator to retry with adjusted args.",
                            tc.name
                        ),
                        true,
                    );
                }
            }
        }
    }

    // Approval cleared (or wasn't needed) — signal the UI that real work is
    // starting now. The matching `ToolResult` will close the strip; any
    // early return below (MCP unavailable) also produces a `ToolResult`,
    // so the strip is guaranteed to retire.
    {
        let _ = runtime
            .lock()
            .await
            .channel
            .send(ChatEvent::ToolExecutionStart {
                tool_call_id: tc.id.clone(),
                name: tc.name.clone(),
            });
    }

    if let Some(tool) = native_tool {
        // Per-tool override wins; everything else gets the global ceiling.
        let budget = tool.timeout().unwrap_or(TOOL_CALL_TIMEOUT);
        return match tokio::time::timeout(budget, tool.call(args)).await {
            Ok(Ok(value)) => (
                serde_json::to_string(&value)
                    .unwrap_or_else(|_| "<unserialisable native tool result>".to_string()),
                false,
            ),
            Ok(Err(e)) => (format!("Native tool `{}` failed: {e}", tc.name), true),
            Err(_) => (
                format!(
                    "Native tool `{}` timed out after {}s",
                    tc.name,
                    budget.as_secs()
                ),
                true,
            ),
        };
    }

    // Walk the per-server tool catalogues to find which MCP server owns
    // this name. A tool name is unique within a single server; collisions
    // across servers are rare in practice (each ecosystem prefixes its
    // own tools). On collision the first match wins — the order matches
    // the operator's `mcp_servers` config.
    let mcp_client = {
        let g = runtime.lock().await;
        g.mcp_servers.iter().find_map(|s| {
            if s.tools.iter().any(|t| t.name == tc.name) {
                s.process.as_ref().map(|p| p.client.clone())
            } else {
                None
            }
        })
    };
    let Some(client) = mcp_client else {
        return (
            format!(
                "Tool `{}` is not available — no MCP server claims this name and \
                 it isn't a native tool either.",
                tc.name
            ),
            true,
        );
    };

    match tokio::time::timeout(TOOL_CALL_TIMEOUT, client.call_tool(&tc.name, args)).await {
        Ok(Ok(value)) => {
            let is_error = value
                .get("isError")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            (
                ferrisscope_agent::mcp::flatten_tool_result(&value),
                is_error,
            )
        }
        Ok(Err(e)) => (format!("MCP tool `{}` failed: {e}", tc.name), true),
        Err(_) => (
            format!(
                "MCP tool `{}` timed out after {}s",
                tc.name,
                TOOL_CALL_TIMEOUT.as_secs()
            ),
            true,
        ),
    }
}

/// Park the loop until the operator decides via `chat_approve_tool_call`.
/// Sends the approval-request event, registers a oneshot, awaits. If the
/// chat is closed (sender dropped) we treat it as denial so the loop
/// unwinds rather than hanging.
async fn request_approval(runtime: &Arc<Mutex<ChatRuntime>>, tc: &ToolCall) -> ApprovalDecision {
    let (tx, rx) = oneshot::channel();
    {
        let mut g = runtime.lock().await;
        g.pending_approvals.insert(tc.id.clone(), tx);
        let _ = g.channel.send(ChatEvent::ApprovalRequest {
            tool_call_id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
        });
    }
    rx.await.unwrap_or(ApprovalDecision::Denied)
}

async fn persist_approval(
    store: &SessionStore,
    cluster_id: &str,
    session_id: &str,
    tool_call_id: &str,
    decision: ApprovalDecision,
) {
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Approval {
                tool_call_id: tool_call_id.to_string(),
                decision,
                ts: now,
            },
        )
        .await;
}

// ─── Auto-title generation ──────────────────────────────────────────────────
//
// After the first successful turn (assistant produced a non-tool reply),
// fire a background provider call that asks the model to summarise the
// conversation in a 3-5 word title. The result is journaled via
// `SessionStore::rename` and streamed to the UI as
// `ChatEvent::TitleUpdated`. Best-effort: any error path leaves the
// session's "New chat" placeholder intact.

/// Default title every freshly-minted session starts with. Mirrors the
/// `chat_create_session` constant — declared here too so the auto-title
/// gate can compare without relying on string literals scattered across
/// the file.
const DEFAULT_SESSION_TITLE: &str = "New chat";

/// Maximum characters of each side of the conversation we feed into the
/// title prompt. Generous enough to capture a question's gist; small
/// enough to keep the title-gen call cheap on the free-tier models that
/// most fresh installs land on.
const TITLE_SNAPSHOT_CHAR_LIMIT: usize = 600;

/// Hard cap on the persisted title's length. Long enough for natural
/// 3-5 word phrases, short enough that the chat header chip never has
/// to ellipsize aggressively.
const TITLE_MAX_CHARS: usize = 80;

/// Prompt shape the auto-title task feeds to the provider. Snapshot
/// captures only the first user → first assistant exchange — that's
/// usually enough to characterize the chat's topic, and keeps the
/// request token budget tiny so it works under the OpenCode Zen free
/// tier without burning the operator's quota on real providers.
struct TitleSnapshot {
    user_text: String,
    assistant_text: String,
}

fn snapshot_for_title(messages: &[ChatMessage]) -> Option<TitleSnapshot> {
    let user = messages
        .iter()
        .find(|m| matches!(m.role, MessageRole::User))?
        .content
        .clone();
    // Pick the FIRST assistant message that actually carries text — skip
    // any tool-call-only turns whose `content` is empty.
    let assistant = messages
        .iter()
        .find(|m| matches!(m.role, MessageRole::Assistant) && !m.content.trim().is_empty())?
        .content
        .clone();
    let user_text = clip_for_title(&user);
    let assistant_text = clip_for_title(&assistant);
    if user_text.trim().is_empty() || assistant_text.trim().is_empty() {
        return None;
    }
    Some(TitleSnapshot {
        user_text,
        assistant_text,
    })
}

fn clip_for_title(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= TITLE_SNAPSHOT_CHAR_LIMIT {
        return trimmed.to_string();
    }
    // Slice on a char boundary, not a byte boundary — multi-byte UTF-8
    // input (CJK, accents) would panic on a naive `&trimmed[..N]`.
    let mut out = String::with_capacity(TITLE_SNAPSHOT_CHAR_LIMIT + 1);
    for ch in trimmed.chars().take(TITLE_SNAPSHOT_CHAR_LIMIT) {
        out.push(ch);
    }
    out.push('…');
    out
}

/// Background task: ask the provider for a short title, persist it to
/// the session journal, and emit a `TitleUpdated` event so the UI's
/// header chip + sessions popover refresh without a round-trip. Any
/// failure (provider error, empty / oversized output, journal write
/// failure) is logged at WARN and silently abandoned — the session
/// simply keeps the "New chat" placeholder.
async fn run_auto_title_task(
    provider: Arc<dyn ChatProvider>,
    store: SessionStore,
    runtime: Arc<Mutex<ChatRuntime>>,
    cluster_id: String,
    session_id: String,
    snapshot: TitleSnapshot,
    model: String,
) {
    // Skip if the session already has a non-default title (operator
    // renamed manually before the model finished). The runtime flag
    // prevents the task from firing twice for one chat, but it doesn't
    // see operator-driven renames — the on-disk title does.
    match store.load(&session_id).await {
        Ok(data) => {
            let current = data.meta.title.trim();
            if !current.eq_ignore_ascii_case(DEFAULT_SESSION_TITLE) && !current.is_empty() {
                tracing::debug!(
                    session_id,
                    %current,
                    "auto-title: skipping — session already has a custom title",
                );
                return;
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, session_id, "auto-title: load session failed");
            return;
        }
    }

    let req = build_title_request(&snapshot, model);
    let buffer = Arc::new(std::sync::Mutex::new(String::new()));
    let buf_for_sink = buffer.clone();
    let sink: ferrisscope_agent::EventSink = Box::new(move |evt| {
        if let CompletionEvent::TokenDelta(s) = evt {
            if let Ok(mut buf) = buf_for_sink.lock() {
                buf.push_str(&s);
            }
        }
    });
    if let Err(e) = provider.stream_completion(req, sink).await {
        tracing::warn!(error = %e, session_id, "auto-title: provider call failed");
        return;
    }
    let raw = buffer.lock().map(|g| g.clone()).unwrap_or_default();
    let Some(title) = sanitise_title(&raw) else {
        tracing::warn!(session_id, raw = %raw, "auto-title: empty / unusable model output");
        return;
    };

    if let Err(e) = store.rename(&session_id, title.clone()).await {
        tracing::warn!(error = %e, session_id, "auto-title: persist failed");
        return;
    }
    let _ = cluster_id; // kept in scope for future routing — store.rename owns the lookup
    let g = runtime.lock().await;
    let _ = g.channel.send(ChatEvent::TitleUpdated {
        title: title.clone(),
    });
    tracing::info!(session_id, %title, "auto-title: applied");
}

fn build_title_request(snapshot: &TitleSnapshot, model: String) -> CompletionRequest {
    // Plain string; no markdown / JSON wrapper. Keep it short and let
    // the model output a bare title — sanitise_title will strip any
    // stray quotes / trailing punctuation regardless.
    const SYSTEM_PROMPT: &str = "You generate short, descriptive chat titles. \
        Reply with ONLY a 3 to 5 word title that captures the main topic of the \
        conversation below. No quotes, no surrounding punctuation, no labels — \
        just the title itself.";
    let user_content = format!(
        "Conversation:\n\nUser: {}\n\nAssistant: {}",
        snapshot.user_text, snapshot.assistant_text,
    );
    CompletionRequest {
        model,
        messages: vec![
            ChatMessage {
                role: MessageRole::System,
                content: SYSTEM_PROMPT.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: MessageRole::User,
                content: user_content,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
            },
        ],
        tools: vec![],
        // Most providers cap titles tightly here. Some reasoning models
        // ignore temperature; that's fine — the system prompt is rigid
        // enough that the output stays on-task.
        temperature: Some(0.4),
        max_tokens: Some(60),
        // Don't inherit the chat's reasoning budgets — title-gen
        // doesn't need extended thinking, and Anthropic in particular
        // adds latency for an enabled `thinking` block.
        provider_options: None,
    }
}

/// Trim quotes / trailing punctuation, collapse whitespace, cap length.
/// Returns `None` for empty or all-whitespace input.
fn sanitise_title(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();
    // Some models produce reasoning prose before the title. Take the
    // first non-empty line as the title — chat titles never legitimately
    // span multiple lines.
    if let Some(first_line) = s.lines().find(|l| !l.trim().is_empty()) {
        s = first_line.trim().to_string();
    }
    // Strip matching wrapping quotes/backticks the model occasionally
    // emits despite the system prompt forbidding them.
    for &(open, close) in &[('"', '"'), ('\'', '\''), ('`', '`'), ('“', '”'), ('‘', '’')] {
        if s.starts_with(open) && s.ends_with(close) && s.chars().count() >= 2 {
            s = s
                .chars()
                .skip(1)
                .take(s.chars().count() - 2)
                .collect::<String>();
            break;
        }
    }
    // Drop a trailing full stop / colon — natural sentence endings the
    // model adds despite the prompt; titles read better without them.
    while matches!(s.chars().last(), Some('.' | ':' | ';' | ',' | '!' | '?')) {
        s.pop();
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        return None;
    }
    // Cap by characters (not bytes) so multi-byte UTF-8 doesn't slice
    // mid-codepoint.
    let trimmed: String = s.chars().take(TITLE_MAX_CHARS).collect();
    Some(trimmed)
}

/// Drops oldest tool messages while the transcript exceeds `budget` chars.
/// Keeps system messages, user messages, and the most recent assistant turn
/// intact — only the historical tool noise is shed. The model loses
/// intermediate evidence but keeps the conversation thread.
fn truncate_transcript(messages: &mut Vec<ChatMessage>, budget: usize) {
    let total: usize = messages.iter().map(|m| m.content.len()).sum();
    if total <= budget {
        return;
    }
    let last_assistant_idx = messages
        .iter()
        .rposition(|m| matches!(m.role, MessageRole::Assistant));
    let mut current = total;
    let mut i = 0;
    while i < messages.len() && current > budget {
        let drop_it = matches!(messages[i].role, MessageRole::Tool)
            && Some(i) != last_assistant_idx
            && messages[i].tool_call_id.is_some();
        if drop_it {
            current = current.saturating_sub(messages[i].content.len());
            messages.remove(i);
        } else {
            i += 1;
        }
    }
}

fn tools_to_schemas(tools: &[McpTool]) -> Vec<ToolSchema> {
    tools
        .iter()
        .map(|t| ToolSchema {
            name: t.name.clone(),
            description: t.description.clone().unwrap_or_default(),
            parameters: t.input_schema.clone(),
        })
        .collect()
}

/// Structured-summary prompt the compaction call uses. Adapted from
/// opencode's compaction template — produces a Markdown checkpoint
/// the next round consumes as a single synthetic assistant message.
const COMPACTION_PROMPT: &str = "\
The conversation above has run long. Produce a structured summary that \
preserves the operator's intent, the cluster state established so far, \
and any unresolved threads.\n\
\n\
Use **exactly** these sections, in this order, even if a section is empty:\n\
\n\
## Goal\n\
- Single sentence describing what the operator is trying to accomplish.\n\
\n\
## Constraints\n\
- Cluster, namespace, and any operational rules established (RBAC, \
quotas, deadlines).\n\
\n\
## Progress\n\
### Done\n\
- Bullet list of confirmed actions / read-only conclusions.\n\
### In progress\n\
- Bullet list of partially completed work.\n\
### Blocked\n\
- Bullet list of obstacles, with the cause.\n\
\n\
## Key decisions\n\
- Bullet list of trade-offs the operator agreed to.\n\
\n\
## Next steps\n\
- Bullet list of the immediate plan, in order.\n\
\n\
## Critical context\n\
- Bullet list of values that must NOT be lost (image tags, IPs, \
PVC names, secret keys, exact error messages).\n\
\n\
## Relevant files\n\
- `path/relative/to/repo` — why it matters\n\
\n\
Rules:\n\
- Preserve resource names, namespaces, container ids, and error \
strings verbatim.\n\
- Be terse. One bullet per fact. No filler prose.\n\
- Don't reference this summarisation step or apologise for compaction.";

/// Token-headroom fraction. We trigger compaction once cumulative
/// tokens cross this share of the model's usable window. 0.75 leaves
/// room for the next round's input + output without blowing the cap
/// on the very call that produces the summary.
const COMPACTION_TRIGGER_FRACTION: f32 = 0.75;

/// Number of trailing messages we keep verbatim across a compaction.
/// Mirrors opencode's `tail_turns: 2` default — leaves enough recent
/// context for the model to thread continuity onto the summary.
const COMPACTION_TAIL_KEEP: usize = 4;

/// Pad any `Assistant.tool_calls[].id` that doesn't have a matching
/// downstream `Tool.tool_call_id` with a synthetic tool-result
/// message. Both OpenAI Responses (`No tool output found for function
/// call …`) and Anthropic (`tool_use_id … must be followed by
/// tool_result`) reject orphans with 400.
///
/// Persists each synthetic tool message via `SessionEvent::Message`
/// so a reload sees the same repaired transcript — without this,
/// every chat_open would re-orphan and we'd loop. The original (now
/// reconciled) tool_call line stays in the JSONL for audit.
async fn repair_orphan_tool_calls(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    cluster_id: &str,
    session_id: &str,
) {
    // Collect orphans under the lock, mutate, release. Persistence
    // happens outside the lock — best-effort.
    let synthetic: Vec<ChatMessage> = {
        let mut g = runtime.lock().await;
        let mut synthetic: Vec<ChatMessage> = Vec::new();
        // Walk left-to-right. Every assistant message's tool_call ids
        // must be answered by a subsequent Tool message before the
        // next Assistant message (or EOF). When we find an unanswered
        // id, append a synthetic tool result immediately after the
        // last answered one (or at the end if there are none).
        let mut i = 0;
        while i < g.messages.len() {
            let calls = match &g.messages[i] {
                m if matches!(m.role, MessageRole::Assistant) && !m.tool_calls.is_empty() => {
                    m.tool_calls.clone()
                }
                _ => {
                    i += 1;
                    continue;
                }
            };
            // Find which ids are answered between here and the next
            // assistant message (or the end).
            let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
            let mut j = i + 1;
            while j < g.messages.len() {
                let m = &g.messages[j];
                if matches!(m.role, MessageRole::Assistant) {
                    break;
                }
                if matches!(m.role, MessageRole::Tool) {
                    if let Some(id) = m.tool_call_id.as_ref() {
                        answered.insert(id.clone());
                    }
                }
                j += 1;
            }
            // For each unanswered tool_call, splice in a synthetic
            // tool result right before `j` (the next assistant
            // boundary or EOF).
            let mut insert_at = j;
            for tc in &calls {
                if answered.contains(&tc.id) {
                    continue;
                }
                let msg = ChatMessage {
                    role: MessageRole::Tool,
                    content: format!(
                        "[tool execution interrupted: `{}` produced no result on the previous turn]",
                        tc.name
                    ),
                    tool_calls: vec![],
                    tool_call_id: Some(tc.id.clone()),
                    name: Some(tc.name.clone()),
                };
                g.messages.insert(insert_at, msg.clone());
                synthetic.push(msg);
                insert_at += 1;
            }
            i = insert_at.max(i + 1);
        }
        synthetic
    };
    if synthetic.is_empty() {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();
    for msg in synthetic {
        let _ = store
            .append(
                cluster_id,
                session_id,
                SessionEvent::Message {
                    message: msg,
                    ts: now,
                },
            )
            .await;
    }
}

/// Conditional compaction — runs at most once per `run_turn_loop`
/// round, no-ops below the threshold. Use `force=true` for a manual
/// trigger from the chat UI's "Compact now" button; that path skips
/// the token threshold and always summarises if there's enough head
/// to be worth folding.
async fn maybe_run_compaction(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    cluster_id: &str,
    session_id: &str,
) {
    run_compaction_internal(runtime, store, provider, cluster_id, session_id, false).await;
}

async fn run_compaction_internal(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    cluster_id: &str,
    session_id: &str,
    force: bool,
) {
    let (last_total, model, message_count, in_flight) = {
        let g = runtime.lock().await;
        (
            g.last_total_tokens,
            g.model.clone(),
            g.messages.len(),
            g.compaction_in_flight,
        )
    };
    if in_flight {
        return;
    }
    // Need at least one tail-keep + a few summarisable messages
    // before compaction is meaningful. Empty / short chats: skip.
    if message_count <= COMPACTION_TAIL_KEEP + 2 {
        return;
    }
    if !force && last_total == 0 {
        return;
    }
    // Resolve the model's usable window via models.dev (or per-
    // provider default).
    let kind = match store.load(session_id).await {
        Ok(d) => d.meta.provider_kind,
        Err(_) => return,
    };
    let context = ferrisscope_agent::provider::catalogue::context_window(kind, &model);
    let reserved = ferrisscope_agent::provider::catalogue::reserved_tokens(kind, &model);
    let usable = context.saturating_sub(reserved);
    let trigger = (usable as f32 * COMPACTION_TRIGGER_FRACTION) as u32;
    if !force && last_total < trigger {
        return;
    }

    // Mark in-flight under the same lock we use to grab the head, so
    // a concurrent re-entry is impossible. Then run the summarisation
    // call outside the lock.
    let (head, head_count) = {
        let mut g = runtime.lock().await;
        if g.compaction_in_flight {
            return;
        }
        if g.messages.len() <= COMPACTION_TAIL_KEEP + 2 {
            return;
        }
        g.compaction_in_flight = true;
        // Naive cut + advance past leading Tool messages. Without this
        // the tail can begin with a Tool whose matching Assistant
        // `tool_calls` lives in the head we just folded — the next
        // turn would send orphan tool outputs and providers reject
        // them ("No tool call found for function call output with
        // call_id …" on Codex Responses; the equivalent 400 on
        // Anthropic). Advancing the cut absorbs those orphans into
        // the head; the summary already covers what they contained.
        let mut cut = g.messages.len() - COMPACTION_TAIL_KEEP;
        while cut < g.messages.len() && matches!(g.messages[cut].role, MessageRole::Tool) {
            cut += 1;
        }
        let head: Vec<ChatMessage> = g.messages[..cut].to_vec();
        (head, cut)
    };

    let _ = runtime
        .lock()
        .await
        .channel
        .send(ChatEvent::CompactionStarted {
            tokens_before: last_total,
            head_message_count: head_count as u32,
        });
    tracing::info!(
        last_total,
        usable,
        head_count,
        "agent: running auto-compaction"
    );

    // Build the summarisation request. We use the same provider but
    // an empty tools list and a system+user prompt that shows the
    // head transcript followed by the structured-summary instruction.
    let transcript_text = render_head_for_summary(&head);
    let req = CompletionRequest {
        model: model.clone(),
        messages: vec![
            ChatMessage {
                role: MessageRole::System,
                content: COMPACTION_PROMPT.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: MessageRole::User,
                content: transcript_text,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
            },
        ],
        tools: vec![],
        // Keep sampling unconstrained — the model picks its own
        // budget for the summary. Most vendors handle this fine.
        temperature: None,
        max_tokens: None,
        provider_options: None,
    };

    // Sink that just accumulates text — no streaming UI for the
    // compaction call itself; from the operator's POV it's
    // transparent overhead. `std::sync::Mutex` with a blocking
    // `.lock()` is the right primitive here: the sink is sync, never
    // awaits while holding the lock, and we cannot afford to drop
    // bytes the way a tokio `try_lock` would on contention — a single
    // missing `(` or `)` corrupts every `[label](url)` link in the
    // summary and breaks the operator's ferrisscope:// nav.
    let summary_buf: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let buf_clone = summary_buf.clone();
    let sink: ferrisscope_agent::provider::EventSink = Box::new(move |evt: CompletionEvent| {
        if let CompletionEvent::TokenDelta(s) = evt {
            if let Ok(mut g) = buf_clone.lock() {
                g.push_str(&s);
            }
        }
    });

    let outcome = provider.stream_completion(req, sink).await;
    let summary = match outcome {
        Ok(_) => summary_buf.lock().map(|g| g.clone()).unwrap_or_default(),
        Err(e) => {
            tracing::warn!(error = %e, "agent: compaction call failed; clearing in-flight flag");
            runtime.lock().await.compaction_in_flight = false;
            return;
        }
    };
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        tracing::warn!("agent: compaction produced empty summary; skipping replacement");
        runtime.lock().await.compaction_in_flight = false;
        return;
    }

    // Persist the marker BEFORE mutating in-memory transcript so a
    // crash mid-replacement doesn't leave us with a desynced view.
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Compaction {
                head_message_count: head_count as u32,
                tokens_before: last_total,
                summary: summary.clone(),
                ts: now,
            },
        )
        .await;

    // Replace the head with the synthetic checkpoint message in-
    // place. Reset token total so the next Usage event resets the
    // running view; clear the in-flight flag so the next round can
    // proceed normally.
    {
        let mut g = runtime.lock().await;
        let tail: Vec<ChatMessage> = g.messages.split_off(head_count);
        g.messages.clear();
        g.messages.push(ChatMessage {
            role: MessageRole::Assistant,
            content: format!("[context checkpoint]\n{summary}"),
            tool_calls: vec![],
            tool_call_id: None,
            name: Some("context_checkpoint".to_string()),
        });
        g.messages.extend(tail);
        g.last_total_tokens = 0;
        g.compaction_in_flight = false;
    }

    // Belt-and-braces: pad any Assistant tool_calls in the surviving
    // tail that no longer have matching Tool answers (manual compact
    // mid-turn can split an Assistant→Tool group). Without this the
    // next round would 400 on the converse orphan ("No tool output
    // found for function call …").
    repair_orphan_tool_calls(runtime, store, cluster_id, session_id).await;

    let _ = runtime
        .lock()
        .await
        .channel
        .send(ChatEvent::CompactionCompleted {
            summary_chars: summary.len() as u32,
            summary: summary.clone(),
        });
    tracing::info!("agent: auto-compaction complete");
}

/// Render the head of a transcript as a single bounded text block the
/// summarisation call can ingest. We strip schemas and stringify
/// tool calls so the summarisation prompt isn't itself contaminated
/// with provider-shape JSON.
fn render_head_for_summary(messages: &[ChatMessage]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    out.push_str("Conversation transcript to summarise:\n\n");
    for m in messages {
        let role = match m.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        let _ = writeln!(out, "[{role}]");
        if !m.content.is_empty() {
            // Cap each message at 8k chars so a single huge tool
            // result doesn't push the summarisation request itself
            // past the model's context.
            const PER_MSG_CAP: usize = 8000;
            if m.content.len() > PER_MSG_CAP {
                out.push_str(&m.content[..PER_MSG_CAP]);
                let _ = writeln!(out, "\n…(truncated, {} chars)", m.content.len());
            } else {
                out.push_str(&m.content);
                out.push('\n');
            }
        }
        for tc in &m.tool_calls {
            let _ = writeln!(out, "called tool `{}` with {}", tc.name, tc.arguments);
        }
        out.push('\n');
    }
    out
}

// SSH-tunneled scratch kubeconfig logic lives in `crate::ssh_scratch` so the
// terminal and helm-CLI paths can share it. The MCP path is one of three
// callers; nothing here is MCP-specific.
