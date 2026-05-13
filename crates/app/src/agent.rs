//! AI agent runtime + Tauri command surface.
//!
//! This module is the bridge between the Tauri-free `ferrisscope-agent` crate
//! and the Tauri host: it owns the `ChatRegistry`, persists agent settings to
//! `<config-dir>/agent_settings.json`, mediates API-key storage through the
//! keychain, and exposes the `chat_*` / `ai_*` commands.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
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

use crate::agent_mcp::{McpProcess, McpProcessError};
use crate::agent_native;
use crate::agent_oauth;
use crate::secret_storage::{self, StorageBackend};
use crate::state::AppState;

/// Hard cap on tool-call rounds within a single user turn. Defends against
/// the model getting stuck in a `tool_calls`-only loop (we've seen models do
/// this with poorly described tool schemas). On hitting the cap we return
/// the partial transcript and let the operator nudge the model with a
/// follow-up message. Sized for genuine multi-step investigations — listing
/// every namespace's pods + tailing logs across them comfortably uses
/// dozens of rounds.
const MAX_TOOL_ROUNDS: u32 = 500;

/// Per-tool-call execution timeout. The wrapping deadline that fires when
/// a tool itself doesn't surface a tighter internal timeout. Operations
/// like `helm install --wait`, long `kubectl rollout status`, or
/// multi-second pod-creating debug shells need real headroom; on timeout
/// we still surface `is_error: true` so the model can recover.
const TOOL_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

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

/// Render the "you are connected to context X" block injected into the
/// system prompt at the start of every turn. Reads the active cluster id
/// off the chat's `ChatClusterCtx` and looks up its `ContextInfo` from the
/// operator's registered sources. If the active context drifted (operator
/// removed the source after the chat opened, or the id was never resolvable
/// to begin with) we still emit a block citing the raw id — better stale
/// than silent. Returns "" when there are no sources at all (nothing
/// useful to say).
async fn build_cluster_context_block(
    cluster: &agent_native::ChatClusterRef,
    app_state: &AppState,
) -> String {
    let active_id = cluster.active().await;
    let origin_id = cluster.origin().to_string();
    let switched = active_id != origin_id;

    let sources = app_state.sources.lock().await;
    let contexts = ferrisscope_core::kubeconfig::list_contexts(&sources).unwrap_or_default();
    drop(sources);
    let active = contexts.iter().find(|c| c.id == active_id);
    let origin = contexts.iter().find(|c| c.id == origin_id);

    let mut out = String::from("## Current Kubernetes context\n\n");
    if let Some(c) = active {
        let ns = c
            .namespace
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("(none)");
        let _ = std::fmt::Write::write_fmt(
            &mut out,
            format_args!(
                "Active context: `{}` (cluster `{}`, default namespace `{}`, source group `{}`).\n",
                c.name, c.cluster, ns, c.group
            ),
        );
    } else {
        let _ = std::fmt::Write::write_fmt(
            &mut out,
            format_args!(
                "Active cluster id: `{active_id}` (not currently resolvable in any source).\n"
            ),
        );
    }
    if switched {
        if let Some(c) = origin {
            let _ = std::fmt::Write::write_fmt(
                &mut out,
                format_args!(
                    "This chat opened against `{}` (cluster `{}`); you switched contexts via \
                     `fs_configuration_use_context`. Switch again or back at any time.\n",
                    c.name, c.cluster
                ),
            );
        } else {
            let _ = std::fmt::Write::write_fmt(
                &mut out,
                format_args!(
                    "This chat opened against cluster id `{origin_id}` and was switched mid-session.\n"
                ),
            );
        }
    } else {
        out.push_str(
            "Use `fs_configuration_use_context` to retarget every subsequent native tool call \
             at a different registered context. The operator's UI selection is independent.\n",
        );
    }
    out
}

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
    /// Index of providers known to have a stored credential (keychain or
    /// plaintext). Index only — no secrets. Lets us skip the keychain on
    /// providers that have nothing stored, which matters on macOS where
    /// each `get_password` against a real item triggers an ACL prompt.
    #[serde(default)]
    configured_providers: HashSet<ProviderKind>,
    /// One-shot: have we backfilled `configured_providers` from the
    /// keychain for an existing install? Pre-`configured_providers`
    /// deployments arrive with the field empty even though their keychain
    /// is full; the first `ai_get_settings` after upgrade does a sweep
    /// and sets this true so we never re-sweep.
    #[serde(default)]
    keychain_index_initialized: bool,
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
    let bytes = serde_json::to_vec_pretty(p)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    ferrisscope_agent::atomic_write::atomic_write(&path, &bytes).await
}

// ─── Credential cache ───────────────────────────────────────────────────────
//
// The keychain is expensive on macOS: each `get_password` against a real
// item can trigger an ACL prompt. Without caching, every `ai_get_settings`
// (settings page open, AI chat open, provider list re-render) hammers the
// keychain once per provider — historically 11 prompts every time.
//
// We mitigate three ways:
//   1. `CRED_CACHE` — process-singleton in-memory map. Populated on first
//      read, invalidated on write/delete. Subsequent reads skip the keychain.
//   2. `PersistedSettings::configured_providers` — disk-persistent index of
//      which providers have something stored. We never query the keychain
//      for providers absent from the index (would prompt for nothing).
//   3. `KEYCHAIN_AVAILABLE` — caches the cheap probe so we don't re-run it
//      on every settings load.

/// Cache slot semantics:
///   * key absent  → never looked up
///   * `Some(None)`  → looked up, nothing stored
///   * `Some(Some(c))` → looked up, found
fn cred_cache() -> &'static std::sync::Mutex<HashMap<ProviderKind, Option<Credential>>> {
    static CRED_CACHE: OnceLock<std::sync::Mutex<HashMap<ProviderKind, Option<Credential>>>> =
        OnceLock::new();
    CRED_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

// `Option<Option<_>>` is exactly the right shape: outer `None` = never
// looked up; inner `None` = looked up, nothing stored. A custom enum
// would be the same three states under a different name.
#[allow(clippy::option_option)]
fn cache_get(kind: ProviderKind) -> Option<Option<Credential>> {
    cred_cache().lock().ok()?.get(&kind).cloned()
}

fn cache_set(kind: ProviderKind, value: Option<Credential>) {
    if let Ok(mut g) = cred_cache().lock() {
        g.insert(kind, value);
    }
}

/// Cached `secret_storage::is_available()`. The underlying probe is
/// cheap (a `get_password` against a non-existent item, or an `ioreg`
/// lookup for the encrypted-file backend), but there's no reason to
/// re-run it on every settings read.
fn secret_storage_available_cached() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(secret_storage::is_available)
}

/// One-time backfill for installs that predate `configured_providers`.
/// Sweeps every provider, populating both the on-disk index and the
/// in-memory cache from whatever's already in the active secret backend
/// (or the plaintext fallback). After this runs once, subsequent
/// `read_credential` calls only touch storage for providers actually
/// in the index.
///
/// Mutates `p` in place; caller is responsible for `save_persisted`.
async fn backfill_credential_index(p: &mut PersistedSettings) {
    let allow_plaintext = p.settings.allow_plaintext_api_key;
    for kind in ProviderKind::all() {
        let mut found: Option<Credential> = None;
        if let Ok(c) = secret_storage::get_credential(*kind) {
            found = Some(c);
        } else if allow_plaintext {
            if let Some(json) = p.plaintext_credentials.get(kind) {
                if let Ok(c) = serde_json::from_str::<Credential>(json) {
                    found = Some(c);
                }
            }
        }
        if let Some(c) = found {
            p.configured_providers.insert(*kind);
            cache_set(*kind, Some(c));
        } else {
            cache_set(*kind, None);
        }
    }
    p.keychain_index_initialized = true;
}

/// Returns the credential for `kind`, preferring the keychain. Falls back
/// to the plaintext store iff the operator opted in. Returns `None` if
/// neither source has anything.
///
/// Reads go through the in-memory cache and skip storage entirely for
/// providers not in `configured_providers`. This is what keeps macOS
/// quiet: we never `get_password` against a provider the operator has
/// never configured.
async fn read_credential(kind: ProviderKind) -> Option<Credential> {
    if let Some(slot) = cache_get(kind) {
        return slot;
    }

    let mut p = load_persisted().await;

    // Pre-`configured_providers` install: do the one-time sweep so we
    // know which providers have something worth reading.
    if !p.keychain_index_initialized {
        backfill_credential_index(&mut p).await;
        let _ = save_persisted(&p).await;
        // Sweep populated the cache for every provider — re-check.
        if let Some(slot) = cache_get(kind) {
            return slot;
        }
    }

    if !p.configured_providers.contains(&kind) {
        cache_set(kind, None);
        return None;
    }

    let result = match secret_storage::get_credential(kind) {
        Ok(c) => Some(c),
        Err(_) if p.settings.allow_plaintext_api_key => p
            .plaintext_credentials
            .get(&kind)
            .and_then(|json| serde_json::from_str::<Credential>(json).ok()),
        Err(_) => None,
    };
    cache_set(kind, result.clone());
    result
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
    let mut p = load_persisted().await;
    let mut dirty = false;

    if secret_storage_available_cached() {
        secret_storage::set_credential(kind, cred).map_err(|e| e.to_string())?;
        // If a plaintext copy lingers from a prior plaintext-only
        // setup, drop it so the secret-storage backend stays the
        // single source of truth.
        if p.plaintext_credentials.remove(&kind).is_some() {
            dirty = true;
        }
    } else {
        if !p.settings.allow_plaintext_api_key {
            return Err(
                "no secret storage backend available and plaintext storage is not enabled".into(),
            );
        }
        let json = serde_json::to_string(cred).map_err(|e| e.to_string())?;
        p.plaintext_credentials.insert(kind, json);
        dirty = true;
    }

    if p.configured_providers.insert(kind) {
        dirty = true;
    }
    if !p.keychain_index_initialized {
        // First write also satisfies the migration flag — anything we
        // didn't see during this write isn't ours to claim.
        p.keychain_index_initialized = true;
        dirty = true;
    }
    if dirty {
        save_persisted(&p).await.map_err(|e| e.to_string())?;
    }
    cache_set(kind, Some(cred.clone()));
    Ok(())
}

async fn clear_credential(kind: ProviderKind) -> Result<(), String> {
    let _ = secret_storage::delete_credential(kind);
    let mut p = load_persisted().await;
    let mut dirty = false;
    if p.plaintext_credentials.remove(&kind).is_some() {
        dirty = true;
    }
    if p.configured_providers.remove(&kind) {
        dirty = true;
    }
    if dirty {
        save_persisted(&p).await.map_err(|e| e.to_string())?;
    }
    cache_set(kind, None);
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
    /// Provider kind the chat is bound to. Mirrors
    /// `SessionMeta::provider_kind`. Cached on the runtime so the
    /// per-round transcript-budget + Usage-event limit lookups don't
    /// pay a `store.load()` round-trip per turn.
    provider_kind: ProviderKind,
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
    /// Shared cluster context used by every native tool. `origin` is `cluster_id`;
    /// `active` defaults to origin and is rebound by `fs_configuration_use_context`.
    /// Held here so the per-turn system prompt can describe the *active* cluster
    /// (not just the origin) without going through tool-call round trips.
    cluster: agent_native::ChatClusterRef,
    /// In-flight approval requests, keyed by tool call id. The agent loop
    /// awaits each receiver while the UI surfaces the approval card; the
    /// `chat_approve_tool_call` command sends the operator's decision.
    pending_approvals: HashMap<String, oneshot::Sender<ApprovalDecision>>,
    /// Tool names the operator has greenlit for the rest of this chat
    /// (Approve always). Cleared on chat close. Survives across turns but
    /// is intentionally NOT persisted to JSONL — re-opening a chat resets
    /// the always-allow set so trust doesn't accidentally span sessions.
    approved_always: HashSet<String>,
    /// `true` once the auto-title task has been spawned for this chat
    /// — either it's in-flight or already completed. Claimed under the
    /// runtime lock in `chat_send_message` so concurrent sends can't
    /// both fire the task. Reset on chat re-open; re-opening a session
    /// that already has a custom title won't double-rename because
    /// `run_auto_title_task` bails on load when the persisted title
    /// is no longer the default.
    auto_title_done: bool,
}

#[derive(Default)]
pub(crate) struct AgentState {
    chats: Mutex<HashMap<String, Arc<Mutex<ChatRuntime>>>>,
    store: Mutex<Option<SessionStore>>,
}

impl AgentState {
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

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn ai_get_settings(
    _state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let p = load_persisted().await;
    let kc_available = secret_storage_available_cached();
    let storage_backend = secret_storage::backend();
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
        secret_storage_backend: storage_backend,
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
    // Sort by opencode's priority list so the picker (and any caller
    // that reads `[0]` as a default) sees the best candidate first —
    // `big-pickle` on OpenCode Zen free tier, `gpt-5.x` on OpenAI,
    // `claude-sonnet-4-x` on Anthropic, etc. Stable across runs; the
    // catalogue cache is populated at startup.
    {
        let mut ids: Vec<String> = models.iter().map(|m| m.id.clone()).collect();
        ferrisscope_agent::provider::catalogue::sort_for_default(&mut ids);
        let order: std::collections::HashMap<String, usize> =
            ids.into_iter().enumerate().map(|(i, s)| (s, i)).collect();
        models.sort_by_key(|m| order.get(&m.id).copied().unwrap_or(usize::MAX));
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
    let mut p = load_persisted().await;
    // Resolution order:
    //  1. caller-supplied `model` (used by chat_open's pickModel()
    //     fast path and the provider-switch flow).
    //  2. `settings.default_model` from the operator.
    //  3. First entry of the active provider's catalogue, sorted by
    //     opencode's priority list — falls through to whatever the
    //     provider returns when the priority list misses entirely.
    // Whatever lands in the meta also gets written back to settings as
    // `default_model` if the operator hadn't picked one yet, so the
    // Settings → AI panel reflects the same choice instead of
    // perpetually showing "—" until they manually pick.
    let mut model_id = model
        .or_else(|| p.settings.default_model.clone())
        .unwrap_or_default();
    let mut should_persist_default = false;
    if model_id.is_empty() {
        let kind = p.settings.active_provider;
        if let Some(cred) = effective_credential(kind).await {
            let base_url = p
                .settings
                .providers
                .get(&kind)
                .and_then(|c| c.base_url.clone());
            if let Ok(provider_impl) = build_provider(kind, &cred, base_url, None, None) {
                if let Ok(mut list) = provider_impl.list_models().await {
                    let public_fallback_active = matches!(cred, Credential::ApiKey { ref key } if Some(key.as_str()) == kind.public_fallback_key());
                    if public_fallback_active
                        && ferrisscope_agent::provider::catalogue::has_data_for(kind)
                    {
                        list.retain(|m| {
                            ferrisscope_agent::provider::catalogue::is_known_free(kind, &m.id)
                        });
                    }
                    let mut ids: Vec<String> = list.into_iter().map(|m| m.id).collect();
                    ferrisscope_agent::provider::catalogue::sort_for_default(&mut ids);
                    if let Some(first) = ids.into_iter().next() {
                        model_id = first;
                        should_persist_default = p.settings.default_model.is_none();
                    }
                }
            }
        }
    }
    if should_persist_default && !model_id.is_empty() {
        p.settings.default_model = Some(model_id.clone());
        let _ = save_persisted(&p).await;
    }
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
        active_cluster_id: None,
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

    // Native tools are built unconditionally and per-chat. They share a
    // `ChatClusterCtx` whose `origin` is the session-bound cluster and
    // whose `active` defaults to origin (or the agent's last-persisted
    // override when one survives in `meta.active_cluster_id`).
    // `fs_configuration_use_context` can rebind active mid-chat without
    // touching the chat's session-bound cluster (which still drives
    // storage, auto-title, and MCP child auth). The same `Arc` is also
    // stored on `ChatRuntime` so the per-turn system-prompt builder can
    // read the active cluster without a tool call.
    //
    // Restoration safety: if the persisted active id is no longer in the
    // operator's sources (they removed that kubeconfig), fall back to
    // origin AND clear the stale override on disk so subsequent reopens
    // don't keep tripping. Better silent than failing every tool call.
    let restored_active: Option<String> = match data.meta.active_cluster_id.as_deref() {
        Some(saved) if saved != data.meta.cluster_id => {
            let sources = app_state.sources.lock().await;
            let resolves = ferrisscope_core::kubeconfig::list_contexts(&sources)
                .map(|cs| cs.iter().any(|c| c.id == saved))
                .unwrap_or(false);
            drop(sources);
            if resolves {
                Some(saved.to_string())
            } else {
                tracing::info!(
                    saved = saved,
                    origin = %data.meta.cluster_id,
                    "chat_open: persisted active cluster no longer resolves; reverting to origin",
                );
                let _ = store
                    .append(
                        &data.meta.cluster_id,
                        &session_id,
                        SessionEvent::SessionUpdate {
                            update: SessionUpdate {
                                active_cluster_id: Some(None),
                                ..Default::default()
                            },
                            ts: chrono::Utc::now().timestamp_millis(),
                        },
                    )
                    .await;
                None
            }
        }
        _ => None,
    };
    let cluster_ctx = agent_native::ChatClusterCtx::new(
        data.meta.cluster_id.clone(),
        session_id.clone(),
        restored_active,
    );
    let native = agent_native::build_registry(app.clone(), cluster_ctx.clone());

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
        provider_kind: data.meta.provider_kind,
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
        cluster: cluster_ctx,
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
        let (context_limit, usable_context) =
            context_limits_for(data.meta.provider_kind, &data.meta.model);
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
                context_limit,
                usable_context,
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
                let (context_limit, usable_context) =
                    context_limits_for(data.meta.provider_kind, &data.meta.model);
                return Ok(ChatOpenResult {
                    chat_id,
                    native_tool_count: initial.0,
                    mcp_servers: initial.1,
                    context_limit,
                    usable_context,
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
    let (context_limit, usable_context) =
        context_limits_for(data.meta.provider_kind, &data.meta.model);
    Ok(ChatOpenResult {
        chat_id,
        native_tool_count: initial.0,
        mcp_servers: initial.1,
        context_limit,
        usable_context,
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
    app_state: State<'_, AppState>,
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
        reasoning_content: None,
    };
    let (cluster_id, session_id, queue_only, title_snapshot) = {
        let mut rt = runtime.lock().await;
        rt.messages.push(user_message.clone());
        let queue_only = rt.cancel.is_some();
        // Capture a once-per-chat snapshot for auto-titling under the
        // same lock so concurrent sends can't both fire the task.
        // The actual provider call runs outside this critical section.
        // `run_auto_title_task` separately bails if the persisted
        // title is already custom (manual rename, or a previous
        // successful auto-title on a now-reopened session).
        let snap = if rt.auto_title_done {
            None
        } else {
            snapshot_for_title(&rt.messages).map(|s| {
                rt.auto_title_done = true;
                (s, rt.model.clone())
            })
        };
        (
            rt.cluster_id.clone(),
            rt.session_id.clone(),
            queue_only,
            snap,
        )
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

    // Pull the chat's cluster ctx so the system prompt can describe the
    // *active* cluster (which may differ from origin after a
    // `fs_configuration_use_context` call) instead of forcing the model
    // to spend a tool round-trip on `fs_configuration_view` to know
    // where it is.
    let cluster_ctx = runtime.lock().await.cluster.clone();
    let cluster_block = build_cluster_context_block(&cluster_ctx, &app_state).await;
    let system_prompt = {
        let baseline = SYSTEM_PROMPT_BASELINE.to_string();
        let with_ctx = if cluster_block.is_empty() {
            baseline
        } else {
            format!("{baseline}\n\n{cluster_block}")
        };
        match p.settings.system_prompt_override.as_ref() {
            Some(extra) if !extra.is_empty() => format!("{with_ctx}\n\n{extra}"),
            _ => with_ctx,
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
            // caret. Drop a small in-bubble notice via TokenDelta first
            // so the operator sees "cancelled" as part of the existing
            // bubble rather than as a separate error pill below an empty
            // bubble. Pending approvals also get drained: their senders
            // dropping unwinds awaiting tool futures via Denied.
            if let Some(message_id) = rt.in_flight_message_id.take() {
                let _ = rt.channel.send(ChatEvent::TokenDelta {
                    delta: "\n\n_Cancelled by operator._".into(),
                });
                let _ = rt.channel.send(ChatEvent::AssistantEnd {
                    message_id,
                    finish_reason: FinishReason::Other,
                });
            }
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
    // Pull the channel + cluster/session info out under the lock so the
    // post-update notification doesn't race a chat_close. `provider_kind`
    // is needed for the post-update ContextLimit event; reading it from
    // the runtime avoids a redundant `store.load`.
    let (cluster_id, session_id, channel, kind) = {
        let mut g = rt.lock().await;
        g.model = trimmed.to_string();
        (
            g.cluster_id.clone(),
            g.session_id.clone(),
            g.channel.clone(),
            g.provider_kind,
        )
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
        .map_err(session_err_to_string)?;
    // Emit a ContextLimit event so the UI footer's `<used> / <limit>`
    // chip refreshes immediately on model swap, instead of waiting for
    // the next assistant turn to produce a Usage event with the new
    // limit folded in.
    let (context_limit, usable_context) = context_limits_for(kind, trimmed);
    let _ = channel.send(ChatEvent::ContextLimit {
        context_limit,
        usable_context,
    });
    Ok(())
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
///
/// After a successful compaction, if the chat is **idle** (no in-flight
/// turn) and the last message is an Assistant turn, we inject a
/// synthetic "Continue from where you left off" user message and spawn
/// the loop. Mirrors opencode's `compaction_continue` autocontinue —
/// makes "Compact" mean "Compact and keep going" rather than "Compact
/// and stop". Manual compaction during an active turn skips the
/// autocontinue (the loop will pick up the post-compaction state on
/// its next round naturally).
#[tauri::command]
pub(crate) async fn chat_compact(
    chat_id: String,
    state: State<'_, AgentState>,
    app_state: State<'_, AppState>,
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
    autocontinue_if_idle(
        &runtime,
        &store,
        &provider,
        &cluster_id,
        &session_id,
        &app_state,
        &p,
        &cred,
        kind,
    )
    .await;
    Ok(())
}

/// If the chat has no in-flight turn AND the last persisted message is an
/// Assistant turn, append a synthetic user "Continue …" message and spawn
/// the regular run loop. Idempotent: if the loop is running we no-op (the
/// running loop will see the post-compaction state on its next iteration).
///
/// The synthetic message uses `name: Some("auto_continue")` so future
/// reload heuristics (auto-title, etc.) can recognise it.
#[allow(clippy::too_many_arguments)]
async fn autocontinue_if_idle(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    cluster_id: &str,
    session_id: &str,
    app_state: &AppState,
    persisted: &PersistedSettings,
    cred: &Credential,
    kind: ProviderKind,
) {
    // Eligibility check + push happen under one lock so a concurrent
    // `chat_send_message` either lands first (and our spawn no-ops) or
    // after (their message coexists with ours; the loop drains both).
    let user_message = ChatMessage {
        role: MessageRole::User,
        content: AUTO_CONTINUE_PROMPT.to_string(),
        tool_calls: vec![],
        tool_call_id: None,
        name: Some(AUTO_CONTINUE_NAME.to_string()),
        reasoning_content: None,
    };
    let should_spawn = {
        let mut g = runtime.lock().await;
        if g.cancel.is_some() {
            return;
        }
        // Last message must be Assistant (otherwise either the chat is
        // brand new — odd, but handle anyway — or the previous turn left
        // us mid-tool, in which case the loop should pick that up first
        // rather than asking for "next steps").
        match g.messages.last() {
            Some(m) if matches!(m.role, MessageRole::Assistant) => {
                // If the assistant message has unanswered tool_calls, the
                // repair pass on the next loop iteration will pad them;
                // we still want to autocontinue so the model reacts.
                g.messages.push(user_message.clone());
                true
            }
            _ => false,
        }
    };
    if !should_spawn {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Message {
                message: user_message,
                ts: now,
            },
        )
        .await;

    // System prompt rebuild — the active cluster could have changed since
    // the last turn (agent may have called `fs_configuration_use_context`
    // mid-session).
    let cluster_ctx = runtime.lock().await.cluster.clone();
    let cluster_block = build_cluster_context_block(&cluster_ctx, app_state).await;
    let system_prompt = {
        let baseline = SYSTEM_PROMPT_BASELINE.to_string();
        let with_ctx = if cluster_block.is_empty() {
            baseline
        } else {
            format!("{baseline}\n\n{cluster_block}")
        };
        match persisted.settings.system_prompt_override.as_ref() {
            Some(extra) if !extra.is_empty() => format!("{with_ctx}\n\n{extra}"),
            _ => with_ctx,
        }
    };
    let is_oauth = matches!(cred, Credential::OAuth { .. });
    let provider_options_default = resolve_provider_options(kind, &persisted.settings, is_oauth);

    let runtime_clone = runtime.clone();
    let store_clone = store.clone();
    let cluster_id_owned = cluster_id.to_string();
    let session_id_owned = session_id.to_string();
    let provider_clone = provider.clone();
    let join = tokio::spawn(async move {
        run_turn_loop(
            runtime_clone,
            store_clone,
            provider_clone,
            system_prompt,
            cluster_id_owned,
            session_id_owned,
            provider_options_default,
        )
        .await;
    });
    let abort = join.abort_handle();
    runtime.lock().await.cancel = Some(abort);
}

/// Synthetic user-message body injected after compaction so the agent
/// keeps working on the previous goal rather than parking with the
/// summary on screen. Phrased to give the model a clean exit if the
/// task is genuinely done.
const AUTO_CONTINUE_PROMPT: &str =
    "Continue from where you left off. If there are no remaining steps and the previous goal is satisfied, briefly say so and stop.";

/// Marker recorded on the synthetic user message so future code (or a
/// future UI affordance) can distinguish autocontinues from operator
/// input. Never displayed.
const AUTO_CONTINUE_NAME: &str = "auto_continue";

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
    // Independent cap for context-overflow recoveries. We don't burn a
    // tool-round counter on a recovery (the operator gets the same number
    // of useful rounds before the cap fires) but we do bound recoveries
    // separately so a wedged compaction can't loop.
    let mut overflow_recoveries: u8 = 0;
    // Same idea for empty-stream retries (reasoning models that close
    // their response without emitting anything). Reset to zero on the
    // first non-empty turn so independent flakes later in the session
    // each get their own retry budget.
    let mut empty_retries: u8 = 0;
    // And for transient infra failures (5xx, upstream connection reset,
    // rate limits). Capped at `MAX_TRANSIENT_RETRIES` with exponential
    // backoff between attempts. Resets on first successful round.
    let mut transient_retries: u8 = 0;
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
            pre_round_msg_count,
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
                // Fold any trailing run of consecutive User messages
                // into one synthetic prompt. Operator-queued follow-ups
                // (multiple Send-while-streaming presses) accumulate as
                // separate User entries; some providers reject that
                // shape, and the model is happier reading one combined
                // question than three. Disk + rt.messages keep the
                // originals — only the per-round snapshot is folded.
                merge_trailing_user_run(g.messages.clone()),
                // Pre-round message count (unmerged). The end-of-turn
                // queued-user check compares against this: if
                // `g.messages.len()` grew while we were streaming, a
                // `chat_send_message` landed mid-round and the new tail
                // user(s) are genuinely unanswered. A positional
                // `last_user > last_assistant` check (the old logic)
                // can't tell that apart from the steady state we just
                // left after inserting the previous assistant before a
                // trailing user — and would loop forever on the
                // already-answered case.
                g.messages.len(),
                schemas,
                g.model.clone(),
                g.approval_mode,
                g.temperature,
                g.max_tokens,
                opts,
            )
        };

        // Build the wire-shape message list. The system prompt is freshly
        // composed each round so a mid-session `fs_configuration_use_context`
        // gets reflected immediately. We send the *full* transcript and let
        // token-based pressure valves manage capacity:
        //
        //   1. Proactive: `maybe_run_compaction` above fires at 75% of the
        //      model's usable window (read from the previous Usage event),
        //      summarising the head into a checkpoint message.
        //   2. Reactive: a context-overflow-shaped 400 (`No tool output
        //      found …` / `context_length_exceeded` / `prompt is too long`)
        //      lands as `RetryAfterCompaction` below, force-compacts, and
        //      re-issues the round.
        //
        // Mirrors opencode's flow: trust the model's full window, summarise
        // when we cross the threshold, recover on overflow. No char/byte
        // pre-truncation — that's a heuristic that fights the catalogue's
        // ground-truth token limit.
        let mut full_messages = Vec::with_capacity(messages_so_far.len() + 1);
        full_messages.push(ChatMessage {
            role: MessageRole::System,
            content: system_prompt.clone(),
            tool_calls: vec![],
            tool_call_id: None,
            name: None,
            reasoning_content: None,
        });
        full_messages.extend(messages_so_far);

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
            ProviderRoundOutcome::RetryAfterCompaction { original_error } => {
                if overflow_recoveries >= MAX_OVERFLOW_RECOVERIES {
                    // Compaction couldn't shrink enough (or the error
                    // wasn't actually overflow-shaped). Fall through to
                    // the existing error surface so the operator sees
                    // what happened rather than a silent loop.
                    let err_text = format!(
                        "**Provider error.** The request failed before the model could respond.\n\n\
                         ```text\n{original_error}\n```\n\n\
                         _Auto-compaction couldn't recover after {MAX_OVERFLOW_RECOVERIES} attempts. Try /compact or start a new chat._"
                    );
                    let assistant_msg = ChatMessage {
                        role: MessageRole::Assistant,
                        content: err_text.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    };
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = store
                        .append(
                            &cluster_id,
                            &session_id,
                            SessionEvent::Message {
                                message: assistant_msg.clone(),
                                ts: now,
                            },
                        )
                        .await;
                    {
                        let mut g = runtime.lock().await;
                        g.messages.push(assistant_msg);
                        g.cancel = None;
                    }
                    let _ = runtime
                        .lock()
                        .await
                        .channel
                        .send(ChatEvent::Error { message: err_text });
                    return;
                }
                overflow_recoveries += 1;
                tracing::warn!(
                    attempt = overflow_recoveries,
                    error = %original_error,
                    "agent: context-overflow-shaped error; running forced compaction and retrying"
                );
                // Force-compact even if the catalogue threshold hasn't
                // crossed — we already know the request didn't fit.
                run_compaction_internal(
                    &runtime,
                    &store,
                    &provider,
                    &cluster_id,
                    &session_id,
                    true,
                )
                .await;
                // Don't increment `round`: the failed attempt produced
                // no output, so the operator's effective round budget
                // is unchanged. Next iteration re-issues against the
                // post-compaction transcript.
                round = round.saturating_sub(1);
                continue;
            }
            ProviderRoundOutcome::EmptyTurn => {
                if empty_retries >= MAX_EMPTY_RETRIES {
                    // Reasoning model is genuinely stuck (or the prompt
                    // is fighting itself). Surface a one-line note so the
                    // operator knows why the chat parked, rather than
                    // letting the empty bubble dangle.
                    let err_text = format!(
                        "_The model returned no output after {} attempts. Send a message to continue._",
                        MAX_EMPTY_RETRIES + 1
                    );
                    let assistant_msg = ChatMessage {
                        role: MessageRole::Assistant,
                        content: err_text.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    };
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = store
                        .append(
                            &cluster_id,
                            &session_id,
                            SessionEvent::Message {
                                message: assistant_msg.clone(),
                                ts: now,
                            },
                        )
                        .await;
                    // Emit the synthetic message on the wire as a normal
                    // assistant turn so the operator actually sees it
                    // *now*, not just after a session reload. Without
                    // this, the loop returned silently after persisting
                    // the message and the chat appeared to "park" with
                    // no assistant output between the last tool result
                    // and the next operator message — see issue where
                    // a follow-up "continue" produced no visible reply
                    // because the model kept returning empty turns and
                    // each exhaustion path was disk-only.
                    let synthetic_id = format!("msg-{}", uuid::Uuid::new_v4());
                    {
                        let mut g = runtime.lock().await;
                        g.messages.push(assistant_msg);
                        g.cancel = None;
                        let _ = g.channel.send(ChatEvent::AssistantStart {
                            message_id: synthetic_id.clone(),
                        });
                        let _ = g.channel.send(ChatEvent::TokenDelta { delta: err_text });
                        let _ = g.channel.send(ChatEvent::AssistantEnd {
                            message_id: synthetic_id,
                            finish_reason: FinishReason::Stop,
                        });
                    }
                    return;
                }
                empty_retries += 1;
                tracing::warn!(
                    attempt = empty_retries,
                    "agent: empty assistant turn (no text, no tool calls); retrying"
                );
                // Don't burn a round — the empty turn produced nothing
                // and the next attempt re-issues against the same
                // transcript. The phantom empty bubble that briefly
                // appeared (from AssistantStart/AssistantEnd) is
                // suppressed by the frontend's empty-bubble filter.
                round = round.saturating_sub(1);
                continue;
            }
            ProviderRoundOutcome::TransientFailure {
                reason,
                original_error,
            } => {
                if transient_retries >= MAX_TRANSIENT_RETRIES {
                    // Upstream is genuinely down or our request is
                    // somehow malformed in a way the LB rejects. Render
                    // the underlying error so the operator can decide
                    // (retry manually, switch provider, file an issue).
                    let err_text = format!(
                        "**Provider error.** The request failed before the model could respond.\n\n\
                         ```text\n{original_error}\n```\n\n\
                         _Auto-retry exhausted after {MAX_TRANSIENT_RETRIES} attempts. Likely a transient upstream issue — try sending the message again in a minute._"
                    );
                    let assistant_msg = ChatMessage {
                        role: MessageRole::Assistant,
                        content: err_text.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    };
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = store
                        .append(
                            &cluster_id,
                            &session_id,
                            SessionEvent::Message {
                                message: assistant_msg.clone(),
                                ts: now,
                            },
                        )
                        .await;
                    {
                        let mut g = runtime.lock().await;
                        g.messages.push(assistant_msg);
                        g.cancel = None;
                    }
                    let _ = runtime
                        .lock()
                        .await
                        .channel
                        .send(ChatEvent::Error { message: err_text });
                    return;
                }
                transient_retries += 1;
                let delay_ms = transient_retry_delay_ms(transient_retries);
                tracing::warn!(
                    attempt = transient_retries,
                    delay_ms,
                    %reason,
                    error = %original_error,
                    "agent: transient provider failure; backing off and retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                // Don't burn a round — the failed attempt produced no
                // output. Next iteration re-issues the same transcript.
                round = round.saturating_sub(1);
                continue;
            }
        };

        // First successful round after one or more retries — clear
        // both counters so future independent flakes each get their
        // own budget.
        empty_retries = 0;
        transient_retries = 0;

        if finish_reason != FinishReason::ToolCalls || tool_calls.is_empty() {
            // No tool calls — decide whether the turn is truly done, then
            // place the assistant message. The check has to run BEFORE we
            // push: if the operator queued a follow-up during streaming,
            // their message is already at the tail of `g.messages`, and
            // appending the assistant after it would wrongly trip the
            // "queued user is answered" branch, abandoning the queued
            // turn. Run the check first; if pending, splice the assistant
            // *before* the queued user tail so the transcript reads
            // chronologically by role (`…, asst_final, user2, user3`)
            // rather than the wall-clock shuffled `…, user2, user3,
            // asst_final`. Cancel-clear and the queued-message check live
            // in one critical section so a concurrent `chat_send_message`
            // either lands its message before the check (we keep going)
            // or after we clear cancel (it spawns a fresh turn). No third
            // option.
            //
            // The criterion for "queued during streaming" is that
            // `g.messages` grew past `pre_round_msg_count` *and* the tail
            // is a User. A positional `last_user > last_assistant` check
            // can't tell that apart from the post-insert steady state on
            // a subsequent loop iteration — it would loop forever
            // answering the same already-answered user.
            let pending = {
                let mut g = runtime.lock().await;
                if user_queued_during_round(&g.messages, pre_round_msg_count) {
                    let insert_at =
                        trailing_user_run_start(&g.messages).unwrap_or(g.messages.len());
                    g.messages.insert(insert_at, assistant_msg);
                    round = 0;
                    true
                } else {
                    g.messages.push(assistant_msg);
                    g.cancel = None;
                    false
                }
            };
            if pending {
                continue;
            }
            return;
        }

        // Fan out every requested tool call. Reads run truly concurrently;
        // writes serialise on the operator's approval. Results land in the
        // original tool_calls order so the assistant→tool sequence the
        // provider expects stays intact.
        //
        // ToolResult is emitted to the wire AS EACH FUTURE COMPLETES — not
        // batched after join_all — so a fast-approved sibling clears its
        // approval card and "running" strip in the UI immediately, even
        // when other tools in the batch are still awaiting their own
        // operator decision. Otherwise the user has to approve every card
        // before any of the already-approved cards get a ToolResult and
        // disappear, which feels like the UI is stuck.
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
                let _ = runtime.lock().await.channel.send(ChatEvent::ToolResult {
                    tool_call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    content: content.clone(),
                    is_error,
                });
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
                reasoning_content: None,
            })
            .collect();
        {
            let mut g = runtime.lock().await;
            g.messages.push(assistant_msg);
            for msg in &tool_msgs {
                g.messages.push(msg.clone());
            }
        }

        // Persist outside the lock. Channel emission already happened
        // per-future above; this loop is purely about the on-disk event
        // log so a session reload can rebuild the transcript.
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
                        call: tc,
                        result: content.clone(),
                        error: if is_error { Some(content) } else { None },
                        ts: now,
                    },
                )
                .await;
        }
    }
}

/// True iff a `chat_send_message` landed at the tail of `messages`
/// between the snapshot at the start of the current round and now.
/// `pre_round_count` is `g.messages.len()` captured under the same
/// lock that built the snapshot; growth past that with a trailing
/// `User` is exactly the queued-during-streaming case.
///
/// A positional "last_user > last_assistant" check can't be used: on
/// the iteration that *answers* a previously-queued user, the
/// assistant from the prior round was spliced *before* the user run
/// (to keep the user pinned at the tail across the round-skip), so
/// the positional test stays true forever and the loop spins. The
/// length-delta criterion is observationally tied to the actual
/// race (`chat_send_message` mutating `g.messages` while we awaited
/// the provider stream) and bails as soon as the queued user is
/// consumed.
fn user_queued_during_round(messages: &[ChatMessage], pre_round_count: usize) -> bool {
    messages.len() > pre_round_count
        && matches!(messages.last().map(|m| &m.role), Some(MessageRole::User))
}

/// Start index of the trailing run of consecutive `User` messages, or
/// `None` if the tail isn't a User. Used by the no-tool-call end-of-
/// turn handler to splice a freshly-produced assistant message in
/// *before* operator messages that were queued mid-round, so the
/// transcript reads `…, asst1, asst_final, user2, user3` instead of
/// the clock-ordered `…, asst1, user2, user3, asst_final`.
fn trailing_user_run_start(messages: &[ChatMessage]) -> Option<usize> {
    let mut i = messages.len();
    while i > 0 && matches!(messages[i - 1].role, MessageRole::User) {
        i -= 1;
    }
    if i == messages.len() {
        None
    } else {
        Some(i)
    }
}

/// If the transcript ends with two or more consecutive `User` messages
/// (the operator queued multiple turns while the model was streaming
/// the previous one), fold them into a single synthetic User message
/// for the *provider snapshot only*. The originals stay in
/// `rt.messages` and on disk so the persisted history shows what the
/// operator actually typed; the provider call sees one combined
/// prompt so the model gets a coherent question rather than a
/// "user … user … user …" run that some providers refuse outright
/// (Anthropic rejects consecutive user-role messages with 400).
fn merge_trailing_user_run(mut messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let start = match trailing_user_run_start(&messages) {
        Some(i) => i,
        None => return messages,
    };
    if start + 1 >= messages.len() {
        return messages;
    }
    let merged_content = messages[start..]
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    messages.truncate(start);
    messages.push(ChatMessage {
        role: MessageRole::User,
        content: merged_content,
        tool_calls: vec![],
        tool_call_id: None,
        name: None,
        reasoning_content: None,
    });
    messages
}

enum ProviderRoundOutcome {
    Continue {
        assistant_msg: ChatMessage,
        finish_reason: FinishReason,
        tool_calls: Vec<ToolCall>,
    },
    Stopped,
    /// The provider returned a context-overflow-shaped error (request
    /// body too large for the model's window, or an "orphan tool call"
    /// shape that the API rejects when older history was elided). The
    /// caller (`run_turn_loop`) responds by forcing a compaction and
    /// re-issuing the same round against the post-compaction transcript.
    /// Bounded retries (`MAX_OVERFLOW_RECOVERIES`) prevent a loop when
    /// compaction itself can't fit.
    RetryAfterCompaction {
        /// Display string forwarded to the operator if recovery exhausts.
        original_error: String,
    },
    /// The provider stream closed cleanly with no text and no tool calls.
    /// Common with reasoning models (gpt-5 family on the Codex/OAuth
    /// path, claude with extended thinking) when the model burned its
    /// reasoning budget without emitting output. Same shape as the
    /// operator's manual "type continue" recovery — we re-issue the
    /// round against the unchanged transcript and the next attempt
    /// usually produces real content. Bounded by `MAX_EMPTY_RETRIES`.
    EmptyTurn,
    /// Transient infrastructure failure: 5xx from the provider, an
    /// upstream LB connection reset (Envoy "upstream connect error /
    /// disconnect/reset"), rate-limit (429), or a network timeout. The
    /// caller sleeps an exponential backoff and re-issues the round
    /// against the unchanged transcript. Bounded by
    /// `MAX_TRANSIENT_RETRIES`.
    TransientFailure {
        /// Short human label (`"upstream 503"`, `"rate limited"`, …)
        /// for logs. Distinct from the underlying error, which we keep
        /// in case the retry exhausts and we surface to the operator.
        reason: String,
        /// Full error text — surfaced if all retries exhaust.
        original_error: String,
    },
}

/// Cap on automatic retries after an empty-stream turn. Two attempts
/// covers the typical reasoning-model flake without spinning forever
/// when something is genuinely wrong (model misconfigured, prompt
/// fights itself, etc.). Resets to zero on the first non-empty turn.
const MAX_EMPTY_RETRIES: u8 = 2;

/// Cap on automatic retries after a transient provider failure (5xx,
/// upstream connection reset, rate limit, network timeout). Mirrors
/// opencode's retry policy in spirit: they retry indefinitely with
/// exponential backoff, but a hard cap fits operator expectations
/// better — past 5 attempts something is genuinely wrong upstream and
/// the operator should know rather than watching the chat sit on a
/// silent retry loop. Resets to zero on the first successful round.
const MAX_TRANSIENT_RETRIES: u8 = 5;

/// Initial backoff before the first transient retry (in milliseconds).
/// Doubles each attempt up to `TRANSIENT_RETRY_MAX_DELAY_MS`. Same
/// 2s starting point opencode uses; gives the upstream a real chance
/// to recover from a typical LB hiccup without being so long that the
/// operator notices a perceptible stall.
const TRANSIENT_RETRY_INITIAL_DELAY_MS: u64 = 2_000;
/// Cap on backoff between attempts. 30s matches opencode's
/// `RETRY_MAX_DELAY_NO_HEADERS`. Keeps a misbehaving upstream from
/// stretching a single retry into a multi-minute pause.
const TRANSIENT_RETRY_MAX_DELAY_MS: u64 = 30_000;

/// Classify a `ProviderError` as a transient infrastructure failure
/// worth retrying. Returns `Some(reason)` when retryable; `None`
/// otherwise (caller falls through to either context-overflow recovery
/// or the terminal error path). Keep the reason short — it ends up in
/// trace logs and the eventual exhaustion message.
///
/// Mirrors opencode's `retry.ts::retryable` shape: 5xx codes are
/// always retryable, plus rate-limit and "Overloaded" patterns. We
/// also catch the Envoy / L7-LB phrasing that chatgpt.com surfaces
/// when the OAuth backend is unreachable. Auth failures and 4xx
/// errors aren't retryable — the request is wrong, not the upstream.
fn is_transient_error(e: &ProviderError) -> Option<String> {
    // Auth errors: never retryable. The credential is wrong; retrying
    // wastes the operator's time and risks lockout if the upstream
    // counts attempts.
    if matches!(e, ProviderError::Auth(_)) {
        return None;
    }
    let s = e.to_string().to_ascii_lowercase();
    // 5xx server errors (always retryable).
    for code in ["500", "502", "503", "504"] {
        if s.contains(code) {
            return Some(format!("upstream {code}"));
        }
    }
    // Envoy / Cloudflare LB phrasings — chatgpt.com's edge surfaces
    // these when the actual model backend is unreachable mid-request.
    for phrase in [
        "upstream connect error",
        "disconnect/reset before headers",
        "connection reset",
        "connection refused",
        "no healthy upstream",
        "service unavailable",
    ] {
        if s.contains(phrase) {
            return Some("upstream connection reset".into());
        }
    }
    // Rate limits.
    if s.contains("429")
        || s.contains("rate limit")
        || s.contains("too many requests")
        || s.contains("overloaded")
        || s.contains("rate increased too quickly")
    {
        return Some("rate limited".into());
    }
    // Network timeouts (ours OR theirs). reqwest surfaces these as
    // "operation timed out" / "request timed out".
    if s.contains("timed out") || s.contains("operation timeout") {
        return Some("request timeout".into());
    }
    None
}

/// Backoff delay for the n-th retry attempt (1-indexed). 2s, 4s, 8s,
/// 16s, then capped at 30s. Mirrors opencode's `delay()` formula
/// without the Retry-After header dance — providers that send
/// `Retry-After` would be a future enhancement.
fn transient_retry_delay_ms(attempt: u8) -> u64 {
    let exp = u32::from(attempt.saturating_sub(1)).min(20);
    let raw = TRANSIENT_RETRY_INITIAL_DELAY_MS.saturating_mul(2u64.saturating_pow(exp));
    raw.min(TRANSIENT_RETRY_MAX_DELAY_MS)
}

/// Heuristic: does this provider error look like a context-window /
/// orphan-tool-call rejection that compaction can recover from?
///
/// The Codex Responses endpoint surfaces a too-large request as a
/// 400 "No tool output found for function call call_…". OpenAI Chat
/// Completions and Anthropic both have their own phrasings. We match
/// on signal substrings rather than parsing per-vendor JSON because the
/// error body shape changes more often than the prose — and a false
/// negative is fine (we'd just render the error as today), while a
/// false positive only costs an extra compaction.
fn is_context_overflow_error(e: &ProviderError) -> bool {
    let s = e.to_string().to_ascii_lowercase();
    [
        // Codex Responses orphan-tool symptom (root cause: input body too
        // large to send all the function_call_outputs that pair with the
        // function_calls we sent — backend drops some, then 400s).
        "no tool output found for function call",
        // OpenAI / OpenRouter standard phrasings.
        "context_length_exceeded",
        "context length",
        "context window",
        "maximum context",
        "exceeds the maximum",
        // Anthropic / generic "input too large".
        "input is too long",
        "input too large",
        "prompt is too long",
        // Codex / GPT family token-budget phrasing.
        "exceed the model",
        "token limit",
        "tokens exceed",
    ]
    .iter()
    .any(|needle| s.contains(needle))
}

/// Cap the auto-recover loop so a misclassified error or a transcript
/// that can't fit even after a full summary doesn't spin forever.
const MAX_OVERFLOW_RECOVERIES: u8 = 2;

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

    let (finish_reason, tool_calls, reasoning_content): (
        FinishReason,
        Vec<ToolCall>,
        Option<String>,
    ) = match result {
        Ok(final_) => {
            if let Some(usage) = &final_.usage {
                // Resolve the active model's context limits at emit time so
                // the UI's `<used>/<limit>` footer stays consistent with the
                // compaction trigger's view (both go through the same
                // catalogue). Both kind and model live on the runtime so
                // this is a single lock acquire — no store IO per turn.
                let (context_limit, usable_context) = {
                    let g = runtime.lock().await;
                    context_limits_for(g.provider_kind, &g.model)
                };
                send(ChatEvent::Usage {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                    context_limit,
                    usable_context,
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
            (
                final_.finish_reason,
                final_.tool_calls,
                final_.reasoning_content,
            )
        }
        Err(ProviderError::Cancelled) => {
            // Fill the open assistant bubble with a brief cancellation
            // notice and close it — one bubble, not "empty bubble + error
            // pill". Cancellation isn't persisted: it's operator-initiated
            // and adding it to the on-disk transcript would replay as
            // assistant content on reload, which is misleading.
            let cancel_text = "_Cancelled by operator._".to_string();
            if let Ok(mut g) = text_accum.lock() {
                g.push_str(&cancel_text);
            }
            send(ChatEvent::TokenDelta { delta: cancel_text }).await;
            runtime.lock().await.in_flight_message_id = None;
            send(ChatEvent::AssistantEnd {
                message_id: message_id.clone(),
                finish_reason: FinishReason::Other,
            })
            .await;
            return ProviderRoundOutcome::Stopped;
        }
        Err(e) => {
            // Context-overflow-shaped error? Hand it back to the loop as a
            // recoverable signal: don't render anything, don't persist —
            // the loop will run a forced compaction and re-issue the round
            // against the post-compaction transcript. Capped retries in
            // the caller prevent ping-ponging when compaction itself can't
            // shrink enough.
            if is_context_overflow_error(&e) {
                runtime.lock().await.in_flight_message_id = None;
                send(ChatEvent::AssistantEnd {
                    message_id: message_id.clone(),
                    finish_reason: FinishReason::Other,
                })
                .await;
                return ProviderRoundOutcome::RetryAfterCompaction {
                    original_error: e.to_string(),
                };
            }
            // Transient infra failure (5xx, upstream LB reset, rate
            // limit, network timeout)? Don't render — the caller does
            // an exponential backoff and re-issues the round. The
            // empty assistant bubble we just opened gets hidden by
            // the frontend's empty-bubble filter.
            if let Some(reason) = is_transient_error(&e) {
                runtime.lock().await.in_flight_message_id = None;
                send(ChatEvent::AssistantEnd {
                    message_id: message_id.clone(),
                    finish_reason: FinishReason::Other,
                })
                .await;
                return ProviderRoundOutcome::TransientFailure {
                    reason,
                    original_error: e.to_string(),
                };
            }
            // Render the failure inside the in-flight assistant bubble
            // (TokenDelta + AssistantEnd) and persist it as the bubble's
            // content. Avoids the "empty bubble + separate error pill"
            // duplication and keeps the chat transcript honest about
            // what the operator saw.
            let err_text = format!(
                "**Provider error.** The request failed before the model could respond.\n\n\
                 ```text\n{e}\n```"
            );
            if let Ok(mut g) = text_accum.lock() {
                g.push_str(&err_text);
            }
            send(ChatEvent::TokenDelta {
                delta: err_text.clone(),
            })
            .await;
            runtime.lock().await.in_flight_message_id = None;
            let assistant_msg = ChatMessage {
                role: MessageRole::Assistant,
                content: err_text,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
            };
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
            // Push to in-memory transcript so the next round (if the
            // operator sends another message) sees this bubble rather
            // than a hole. The model is expected to read the error and
            // adjust on its next turn.
            runtime.lock().await.messages.push(assistant_msg);
            send(ChatEvent::AssistantEnd {
                message_id: message_id.clone(),
                finish_reason: FinishReason::Other,
            })
            .await;
            return ProviderRoundOutcome::Stopped;
        }
    };

    let final_text = text_accum.lock().map(|g| g.clone()).unwrap_or_default();

    // Empty-stream detection: the model closed the response with no text
    // *and* no tool calls. Common with reasoning models that burn their
    // thinking budget internally without emitting output. Don't persist
    // a content-less bubble — close the in-flight one on the wire and
    // signal the loop to re-issue the round. The next attempt against
    // the same transcript usually produces real output (same recovery
    // the operator gets by typing "continue" manually).
    if final_text.trim().is_empty() && tool_calls.is_empty() {
        runtime.lock().await.in_flight_message_id = None;
        send(ChatEvent::AssistantEnd {
            message_id,
            finish_reason,
        })
        .await;
        return ProviderRoundOutcome::EmptyTurn;
    }

    let assistant_msg = ChatMessage {
        role: MessageRole::Assistant,
        content: final_text,
        tool_calls: tool_calls.clone(),
        tool_call_id: None,
        name: None,
        reasoning_content,
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

/// Prompt shape the auto-title task feeds to the provider. Captures
/// only the first user message — title-gen fires the moment that
/// message lands, before any assistant reply exists. User text alone
/// is usually enough to characterize a chat's topic, and keeps the
/// request token budget tiny so it works under the OpenCode Zen free
/// tier without burning the operator's quota on real providers.
struct TitleSnapshot {
    user_text: String,
}

fn snapshot_for_title(messages: &[ChatMessage]) -> Option<TitleSnapshot> {
    let user = messages
        .iter()
        .find(|m| matches!(m.role, MessageRole::User))?
        .content
        .clone();
    let user_text = clip_for_title(&user);
    if user_text.trim().is_empty() {
        return None;
    }
    Some(TitleSnapshot { user_text })
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
        user's opening message below. No quotes, no surrounding punctuation, \
        no labels — just the title itself.";
    let user_content = format!("User message:\n\n{}", snapshot.user_text);
    CompletionRequest {
        model,
        messages: vec![
            ChatMessage {
                role: MessageRole::System,
                content: SYSTEM_PROMPT.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
            },
            ChatMessage {
                role: MessageRole::User,
                content: user_content,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
            },
        ],
        tools: vec![],
        // Minimal request shape so title-gen works across every
        // provider in the catalogue. Reasoning-class models on
        // OpenAI's Codex Responses endpoint reject both
        // `max_output_tokens` (our `max_tokens` translation) and
        // custom `temperature`; OpenRouter / OpenAI-compat tolerate
        // either being absent; Anthropic supplies its own default
        // when `max_tokens` is unset. Output stays short via the
        // rigid system prompt and is hard-capped by `sanitise_title`,
        // so dropping these costs nothing.
        temperature: None,
        max_tokens: None,
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
/// tokens cross this share of the model's usable window. 0.90 leans
/// toward using the full catalogue capacity — for gpt-5.5 that's
/// ~812k tokens before we summarise, vs the ~677k we'd see at 0.75.
/// The remaining 10% is enough for the summarisation call itself plus
/// one more round of growth; if a single tool blows past it between
/// Usage events the reactive `RetryAfterCompaction` path catches the
/// resulting 400 and force-compacts. Opencode runs at 1.0 because they
/// can halt mid-stream on overflow; we trigger pre-flight, so 0.90 is
/// the equivalent safe headroom.
const COMPACTION_TRIGGER_FRACTION: f32 = 0.90;

/// Resolve `(context, usable)` for a `(provider, model)` pair purely
/// from the models.dev catalogue. No per-model overrides in code — the
/// catalogue is the single source of truth, so adding / re-tiering a
/// model in models.dev doesn't require a release here.
///
/// `usable` is `input_limit − reserved_output`, mirroring opencode's
/// `usable()` formula. Critically this is **input**, not raw `context`:
/// for the gpt-5 family the catalogue distinguishes `context` (input +
/// output) from `input` (the actual cap on what we can send). For
/// gpt-5.5 that's 1.05M context vs 922k input — using `context` would
/// have us happily packing a 900k-token input that the server rejects
/// because input alone exceeds the cap. For providers that don't split
/// the budget (most non-OpenAI), `parse_limits` already sets
/// `input = context`, so the formula collapses to the classic
/// "context − output buffer".
///
/// When the live (OAuth/Codex) backend enforces tighter limits than
/// the catalogue's API-tier numbers, `is_context_overflow_error` +
/// reactive compaction recover from the resulting 400 — same end
/// behaviour as if we'd hardcoded the tighter cap, without any
/// model-name string matching that breaks the day a vendor renames.
fn context_limits_for(kind: ProviderKind, model: &str) -> (u32, u32) {
    use ferrisscope_agent::provider::catalogue;
    use ferrisscope_agent::provider::meta;

    let (context, input, output) = match catalogue::lookup(kind, model) {
        Some(l) => (l.context, l.input, l.output),
        None => {
            // Catalogue miss — fall back to the per-provider default.
            // Treat input == context (most providers don't distinguish)
            // and assume output buffer of 8192 for the reserve calc.
            let default = meta::for_kind(kind).default_context_window;
            (default, default, 8192)
        }
    };

    // Reserved output buffer: `min(20_000, max_output)`, floored at 2k
    // so a model with a tiny declared `output` cap doesn't leave us
    // with effectively zero headroom for the response. Mirrors
    // `catalogue::reserved_tokens`.
    let reserved = 20_000.min(output.max(1)).max(2048);
    let usable = input.saturating_sub(reserved);
    (context, usable)
}

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
                    reasoning_content: None,
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
                reasoning_content: None,
            },
            ChatMessage {
                role: MessageRole::User,
                content: transcript_text,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
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
            reasoning_content: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: token-driven flow keeps the full transcript on the wire,
    /// no byte/char pre-truncation. Compaction (proactive at 75%, reactive
    /// on 400) is the only management lever now — mirrors opencode's flow.
    #[test]
    fn context_limits_match_catalogue_default() {
        // Unknown model id → falls back to the per-provider default
        // context window (200k for OpenAI). Usable subtracts the
        // reserved output buffer (≥ 2048, ≤ 20_000).
        let (context, usable) = context_limits_for(ProviderKind::OpenAI, "unknown");
        assert_eq!(context, 200_000);
        assert!(
            usable < context && usable >= context.saturating_sub(20_000),
            "usable {usable} should be context {context} minus reserved (≤20k)"
        );
    }

    #[test]
    fn context_overflow_classifier_codex_orphan() {
        let e = ProviderError::Http(
            "400: { \"error\": { \"message\": \"No tool output found for function call call_X\" } }".into(),
        );
        assert!(is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_openai_context_length() {
        let e = ProviderError::Http(
            "400: { \"error\": { \"code\": \"context_length_exceeded\" } }".into(),
        );
        assert!(is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_anthropic_input_too_long() {
        let e = ProviderError::Http(
            "400: { \"error\": { \"message\": \"prompt is too long: 200000 tokens > 199998 maximum\" } }".into(),
        );
        assert!(is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_negative_unrelated_400() {
        let e = ProviderError::Http("400 Bad Request: invalid model id 'gpt-5'".into());
        assert!(!is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_negative_auth() {
        let e = ProviderError::Auth("invalid token".into());
        assert!(!is_context_overflow_error(&e));
    }

    #[test]
    fn transient_classifier_503_envoy_reset() {
        let e = ProviderError::Http(
            "503 Service Unavailable: upstream connect error or disconnect/reset before headers"
                .into(),
        );
        assert!(is_transient_error(&e).is_some());
    }

    #[test]
    fn transient_classifier_429_rate_limit() {
        let e = ProviderError::Http("429 Too Many Requests".into());
        assert!(is_transient_error(&e).is_some());
    }

    #[test]
    fn transient_classifier_502_504() {
        assert!(is_transient_error(&ProviderError::Http("502 Bad Gateway".into())).is_some());
        assert!(is_transient_error(&ProviderError::Http("504 Gateway Timeout".into())).is_some());
    }

    #[test]
    fn transient_classifier_overloaded() {
        let e = ProviderError::Http(
            "{\"error\":{\"message\":\"Overloaded\",\"type\":\"overloaded_error\"}}".into(),
        );
        assert!(is_transient_error(&e).is_some());
    }

    #[test]
    fn transient_classifier_negative_400() {
        let e = ProviderError::Http("400 Bad Request: invalid model".into());
        assert!(is_transient_error(&e).is_none());
    }

    #[test]
    fn transient_classifier_negative_auth() {
        let e = ProviderError::Auth("invalid token".into());
        assert!(is_transient_error(&e).is_none());
    }

    #[test]
    fn transient_backoff_grows_then_caps() {
        // 2s, 4s, 8s, 16s, 30s (capped from 32s).
        assert_eq!(transient_retry_delay_ms(1), 2_000);
        assert_eq!(transient_retry_delay_ms(2), 4_000);
        assert_eq!(transient_retry_delay_ms(3), 8_000);
        assert_eq!(transient_retry_delay_ms(4), 16_000);
        assert_eq!(transient_retry_delay_ms(5), 30_000);
        // Subsequent attempts stay capped (we cap MAX_TRANSIENT_RETRIES
        // at 5 anyway, but the math has to be safe past that).
        assert_eq!(transient_retry_delay_ms(10), 30_000);
        assert_eq!(transient_retry_delay_ms(255), 30_000);
    }

    fn msg(role: MessageRole, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.into(),
            ..Default::default()
        }
    }

    #[test]
    fn trailing_user_run_none_when_tail_isnt_user() {
        let msgs = vec![
            msg(MessageRole::User, "hi"),
            msg(MessageRole::Assistant, "hello"),
        ];
        assert_eq!(trailing_user_run_start(&msgs), None);
    }

    #[test]
    fn trailing_user_run_finds_single_user_tail() {
        let msgs = vec![
            msg(MessageRole::User, "hi"),
            msg(MessageRole::Assistant, "hello"),
            msg(MessageRole::User, "follow-up"),
        ];
        assert_eq!(trailing_user_run_start(&msgs), Some(2));
    }

    #[test]
    fn trailing_user_run_finds_multi_user_tail() {
        let msgs = vec![
            msg(MessageRole::User, "first"),
            msg(MessageRole::Assistant, "ack"),
            msg(MessageRole::User, "queued 1"),
            msg(MessageRole::User, "queued 2"),
            msg(MessageRole::User, "queued 3"),
        ];
        assert_eq!(trailing_user_run_start(&msgs), Some(2));
    }

    #[test]
    fn trailing_user_run_handles_empty_transcript() {
        let msgs: Vec<ChatMessage> = vec![];
        assert_eq!(trailing_user_run_start(&msgs), None);
    }

    #[test]
    fn merge_trailing_user_run_noop_when_no_tail() {
        let msgs = vec![
            msg(MessageRole::User, "hi"),
            msg(MessageRole::Assistant, "hello"),
        ];
        let out = merge_trailing_user_run(msgs.clone());
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].content, "hello");
    }

    #[test]
    fn merge_trailing_user_run_noop_when_single_user_tail() {
        // A single trailing user message is normal — leave it alone.
        let msgs = vec![
            msg(MessageRole::Assistant, "hello"),
            msg(MessageRole::User, "follow-up"),
        ];
        let out = merge_trailing_user_run(msgs);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].content, "follow-up");
    }

    #[test]
    fn merge_trailing_user_run_combines_queue() {
        let msgs = vec![
            msg(MessageRole::User, "first"),
            msg(MessageRole::Assistant, "ack"),
            msg(MessageRole::User, "queued 1"),
            msg(MessageRole::User, "queued 2"),
            msg(MessageRole::User, "queued 3"),
        ];
        let out = merge_trailing_user_run(msgs);
        // Three queued user messages collapse to one combined entry.
        assert_eq!(out.len(), 3);
        assert!(matches!(out[2].role, MessageRole::User));
        assert_eq!(out[2].content, "queued 1\n\nqueued 2\n\nqueued 3");
        // History before the queue is untouched.
        assert_eq!(out[0].content, "first");
        assert_eq!(out[1].content, "ack");
    }

    #[test]
    fn user_queued_during_round_detects_growth_with_user_tail() {
        // Round started with two messages; a `chat_send_message` landed
        // mid-stream and pushed a User to the tail. The end-of-turn
        // check must flag this as queued so the loop runs another round.
        let pre = 2;
        let msgs = vec![
            msg(MessageRole::User, "user1"),
            msg(MessageRole::Assistant, "asst1 (had tool calls)"),
            msg(MessageRole::User, "user2 queued"),
        ];
        assert!(user_queued_during_round(&msgs, pre));
    }

    #[test]
    fn user_queued_during_round_false_when_no_growth() {
        // No new messages arrived during the round → trailing user (if
        // any) is the same one the model just answered. Loop must exit.
        let msgs = vec![
            msg(MessageRole::Assistant, "asst1"),
            msg(MessageRole::User, "user1"),
        ];
        let pre = msgs.len();
        assert!(!user_queued_during_round(&msgs, pre));
    }

    #[test]
    fn user_queued_during_round_false_when_tail_isnt_user() {
        // Tool result(s) landed but no new user — also not a queue.
        let pre = 1;
        let msgs = vec![
            msg(MessageRole::User, "user1"),
            msg(MessageRole::Assistant, "asst1 (had tool calls)"),
            msg(MessageRole::Tool, "tool result"),
        ];
        assert!(!user_queued_during_round(&msgs, pre));
    }

    #[test]
    fn user_queued_during_round_breaks_post_insert_loop() {
        // Regression for the loop bug: after iteration N inserts the
        // assistant *before* the trailing user run (to keep the queued
        // user at the tail), iteration N+1 sees the same User at the
        // tail. With the old positional `last_user > last_assistant`
        // check this loops forever; with the length-delta criterion,
        // the next round's `pre_round_count` already includes the user,
        // so `user_queued_during_round` returns false and the loop
        // exits as soon as the queued user is genuinely answered.
        let after_iter1 = vec![
            msg(MessageRole::User, "user1"),
            msg(MessageRole::Assistant, "asst1"),
            msg(MessageRole::User, "queued"),
        ];
        // Iteration 2 captures pre_round_count from this transcript.
        let pre_iter2 = after_iter1.len();
        // No `chat_send_message` lands during iter 2 — messages stay
        // the same length when the provider returns the answer.
        assert!(!user_queued_during_round(&after_iter1, pre_iter2));
    }
}
