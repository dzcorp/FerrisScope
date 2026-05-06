//! Persisted AI-agent settings. Lives next to `Prefs` in core (the `app`
//! crate is responsible for serialising / deserialising this against
//! `prefs.json`); we just define the shape.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// LLM provider the agent can talk to. The set is intentionally small —
/// adding a provider means an entry here, a metadata row in
/// `provider::meta::for_kind`, and (for non-OpenAI-shaped providers) a
/// dedicated `ChatProvider` impl.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    #[default]
    OpenRouter,
    Anthropic,
    // Explicit rename — serde's snake_case mangles consecutive capitals
    // (`OpenAI` → `open_a_i`). Use the natural `openai` lowercase.
    #[serde(rename = "openai")]
    OpenAI,
    Zai,
    Minimax,
    Groq,
    Deepseek,
    Mistral,
    Together,
    Ollama,
}

impl ProviderKind {
    /// Static list of every supported provider, in stable display order.
    /// The settings UI iterates over this to render its provider list.
    pub fn all() -> &'static [ProviderKind] {
        &[
            Self::OpenAI,
            Self::Anthropic,
            Self::OpenRouter,
            Self::Zai,
            Self::Minimax,
            Self::Groq,
            Self::Deepseek,
            Self::Mistral,
            Self::Together,
            Self::Ollama,
        ]
    }
}

/// Stored credential for one provider. Lives in the OS keychain
/// (`account = ProviderKind::id()`, `password = serde_json(self)`); the
/// plaintext fallback in `prefs.json` uses the same JSON shape.
///
/// The discriminator and field names mirror opencode's `auth.json` so an
/// operator switching tools doesn't have to re-authenticate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    ApiKey {
        key: String,
    },
    OAuth {
        access: String,
        refresh: String,
        /// Unix epoch milliseconds at which `access` is no longer valid.
        /// We refresh on 401 regardless, but use this as a hint to refresh
        /// proactively when we're within ~60s of expiry.
        expires_at_unix_ms: i64,
        /// OpenAI-Codex-only: ChatGPT account / organization id, sent as
        /// the `ChatGPT-Account-Id` header so the request is billed to
        /// the right subscription.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
    },
}

impl Credential {
    /// Coarse classification used by the settings UI: "api_key" / "oauth".
    pub fn auth_mode_label(&self) -> &'static str {
        match self {
            Self::ApiKey { .. } => "api_key",
            Self::OAuth { .. } => "oauth",
        }
    }
}

/// Per-provider runtime config the operator might tweak. Sparse map:
/// entries only exist for providers the operator has touched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Override the canonical base URL from `ProviderMeta::default_base_url`.
    /// `None` = use the canonical default. Empty string = treat as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    /// Every write tool call requires explicit user approval. Default.
    #[default]
    ApprovePerWrite,
    /// Bypass approval for write tool calls. Per-chat only — never the
    /// global default. The chat UI surfaces a persistent warning banner.
    AllowAllWrites,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    #[default]
    Low,
    Medium,
    High,
}

/// Universal reasoning / extended-thinking knobs. Each provider that
/// supports reasoning maps these onto its native fields:
/// - Anthropic Messages API: `thinking: { type: "enabled", budget_tokens }`
///   (uses `budget_tokens`; `effort` ignored).
/// - OpenAI Chat Completions: `reasoning_effort: <effort>`
///   (uses `effort`; `budget_tokens` ignored).
/// - OpenAI Codex / Responses: `reasoning: { effort, summary: false }`
///   (uses `effort`; `budget_tokens` ignored).
/// - OpenRouter: `reasoning: { effort, max_tokens }` (uses both, passes
///   through to the upstream provider's native shape).
///
/// Both fields `None` ⇒ reasoning disabled / let the API choose.
/// Models without reasoning support ignore whatever we send.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ReasoningSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<ReasoningEffort>,
    /// Extended-thinking / reasoning token budget. `None` ⇒ provider
    /// default (or "off" for Anthropic, since no budget = no thinking).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u32>,
}

impl ReasoningSettings {
    /// True iff at least one knob is set. Used to decide whether to
    /// emit any reasoning fields at all.
    pub fn is_active(&self) -> bool {
        self.effort.is_some() || self.budget_tokens.is_some()
    }
}

/// One operator-configured external MCP-protocol server. Each entry produces
/// a separate child process per chat; their tool catalogues are merged with
/// the native toolkit. The shape mirrors `mcpServers` in Claude Desktop /
/// Cursor / similar tools so the JSON copy-pastes between them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Stable id used to address this entry from the UI / events. Generated
    /// once on creation; never re-used. Frontend uses this as the React key.
    pub id: String,
    /// Operator-friendly label ("filesystem", "github", "my-server"). Shown
    /// in the chat-tools popover and per-server status messages.
    pub name: String,
    /// Path to the executable. Absolute paths are recommended (no PATH
    /// lookup is performed by FerrisScope itself, but the OS may resolve
    /// relative names).
    pub command: String,
    /// CLI args appended after the command. Most MCP servers want a `stdio`
    /// flag here (e.g. `--stdio`, `--transport stdio`).
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra env vars merged on top of the inherited environment + the
    /// `KUBECONFIG` we set to pin the chat's bound context. Operator-supplied
    /// vars win on key collision.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Disabled servers are persisted but not spawned. Lets operators keep
    /// configurations around without paying the spawn cost.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentSettings {
    /// Provider new chats default to. Drives the model picker and the
    /// initial `SessionMeta::provider_kind` for newly created sessions.
    #[serde(default)]
    pub active_provider: ProviderKind,
    /// Per-provider config (base URL overrides). Sparse: entries exist
    /// only for providers the operator has explicitly configured.
    #[serde(default)]
    pub providers: HashMap<ProviderKind, ProviderConfig>,
    /// Last-used / preferred default model id within `active_provider`.
    /// New chats start here; the frontend overwrites this on first chat
    /// creation by picking the first model from `list_models`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub default_approval_mode: ApprovalMode,
    /// User-supplied addition prepended to the system prompt. The crate
    /// ships a curated baseline; this value (when set) appends to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_override: Option<String>,
    /// When the secret-service / Keychain isn't available on the platform
    /// (headless Linux), the operator can opt in to plaintext storage.
    /// Default `false` keeps credentials in the keychain only.
    #[serde(default)]
    pub allow_plaintext_api_key: bool,
    /// External MCP-protocol servers to spawn per chat. Each entry produces
    /// one child process; their tools are merged with the native catalogue
    /// under the same approval gate. Empty by default — native tools alone
    /// cover the full Kubernetes management surface.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    /// Legacy single-binary path. Retained so older `prefs.json` files keep
    /// working — when `mcp_servers` is empty and this is set, the chat
    /// open path treats it as a virtual single entry. Operators are
    /// expected to migrate to `mcp_servers` via the Settings UI; we never
    /// rewrite this value silently on load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_binary_path: Option<String>,
    /// Universal reasoning / extended-thinking defaults. Mapped to each
    /// provider's native field shape at request build time. Per-chat
    /// `provider_options` still wins.
    #[serde(default)]
    pub reasoning: ReasoningSettings,
}
