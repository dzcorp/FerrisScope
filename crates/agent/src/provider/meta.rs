//! Static per-provider metadata: stable id, display name, default base URL,
//! supported auth modes, and the strategy we use to enumerate models.
//!
//! The set is intentionally small. Adding a provider means:
//! 1. A new `ProviderKind` variant in [`crate::config`] (and the UI union in
//!    `ui/src/types.ts`).
//! 2. A `meta::for_kind` row here — including the row-facing fields
//!    (`key_hint`, `allows_blank_key`, `oauth_label`, `signup_url`,
//!    `description`), which the settings UI renders as-is.
//! 3. (For OpenAI-shaped providers) nothing else — `OpenAICompatibleProvider`
//!    picks up the metadata. (For Anthropic / OpenAI-Codex) a dedicated
//!    [`crate::provider::ChatProvider`] impl.

use crate::config::ProviderKind;

/// What the operator can do to authenticate with this provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Operator pastes an API key.
    ApiKey,
    /// OAuth flow that ends with a `Credential::OAuth` blob. v1 only
    /// uses this for OpenAI Codex (ChatGPT Pro/Plus subscriptions).
    OAuth,
}

/// How we enumerate models for this provider in the settings UI.
#[derive(Debug, Clone, Copy)]
pub enum ModelsEndpoint {
    /// `GET <base_url>/models` returning OpenAI's `{data:[{id,...},...]}`
    /// shape. Covers OpenRouter, OpenAI, Z.AI, MiniMax, Groq, Together,
    /// Mistral, Ollama (local).
    OpenAiCompatible,
    /// Anthropic's `GET /v1/models` returning `{data:[{id, display_name,
    /// created_at}]}` (slightly different field names).
    AnthropicCatalogue,
    /// Gemini API `GET /models` returning `{models:[{name, displayName,
    /// inputTokenLimit, supportedGenerationMethods}], nextPageToken}`.
    GeminiCatalogue,
    /// Provider's catalogue isn't reliable / discoverable. We fall back
    /// to a hard-coded list. The list lives next to the metadata in
    /// `STATIC_MODELS` keyed off the provider id.
    Static,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderMeta {
    /// Stable lowercase identifier — also the keychain account name.
    pub id: &'static str,
    /// Display name surfaced in the settings UI.
    pub display_name: &'static str,
    /// Canonical base URL (no trailing slash). The operator may override
    /// it via `ProviderConfig::base_url`.
    pub default_base_url: &'static str,
    /// Auth methods this provider supports. The first entry is the
    /// preferred default for the connect flow.
    pub auth_modes: &'static [AuthMode],
    pub models_endpoint: ModelsEndpoint,
    /// Marker telling consumers which `ChatProvider` impl to construct.
    pub flavor: ProviderFlavor,
    /// Conservative default context window for this provider's models,
    /// in tokens. Real models vary (Haiku 4.5 = 200k, Sonnet-1m = 1M,
    /// Opus 4.x = 200k); this is the fallback when we can't pin the
    /// exact model. The auto-compaction trigger uses this to decide
    /// when to summarise.
    pub default_context_window: u32,
    /// The endpoint may legitimately be unauthenticated (local Ollama, open
    /// gateways): a blank key is saved and sends no auth header.
    pub allows_blank_key: bool,
    /// Placeholder for the API-key field.
    pub key_hint: &'static str,
    /// Button noun for the OAuth connect flow ("Sign in with …"). `Some`
    /// exactly when [`AuthMode::OAuth`] is offered.
    pub oauth_label: Option<&'static str>,
    /// Where the operator creates a key, shown as a link in the row.
    pub signup_url: Option<&'static str>,
    /// One plain-text line of context for the row, when the name alone
    /// doesn't say what the provider is.
    pub description: Option<&'static str>,
}

/// Selects the concrete provider impl to instantiate. The build-provider
/// helper in `crates/app/src/agent.rs` dispatches on this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFlavor {
    /// Generic OpenAI Chat Completions wire (`/chat/completions` SSE).
    /// Used by every provider whose default mode is OpenAI-compatible.
    OpenAiCompat,
    /// Anthropic Messages API (`/messages` SSE with `event:` lines).
    AnthropicMessages,
    /// OpenAI Responses API at the Codex endpoint (OAuth-only). Different
    /// request body, different SSE event names.
    OpenAiResponses,
    /// Gemini `models/<id>:streamGenerateContent?alt=sse` (`x-goog-api-key`).
    GeminiGenerate,
}

const META_OPENCODE_ZEN: ProviderMeta = ProviderMeta {
    id: "opencode_zen",
    display_name: "OpenCode Zen",
    // OpenAI-compatible proxy. With the public ("free tier") key only
    // zero-cost models are listed; with an operator key the full
    // catalogue is available — see <https://opencode.ai/zen>.
    default_base_url: "https://opencode.ai/zen/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Catalogue spans 200k (Claude) → 1M (GPT-5.4 Pro). Use the smaller
    // value as the conservative fallback; per-model overrides land via
    // the models.dev catalogue.
    default_context_window: 200_000,    allows_blank_key: false,
    key_hint: "(blank = free tier)",
    oauth_label: None,
    signup_url: Some("https://opencode.ai/zen"),
    description: Some("Curated coding models behind one OpenAI-compatible endpoint. The free tier needs no key and lists zero-cost models only; add a key to unlock the full catalogue."),
};

const META_OPENCODE_GO: ProviderMeta = ProviderMeta {
    id: "opencode_go",
    display_name: "OpenCode Go",
    default_base_url: "https://opencode.ai/zen/go/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Open coding models: 128k–1M; the models.dev `opencode-go` entry
    // refines per model.
    default_context_window: 200_000,
    allows_blank_key: false,
    key_hint: "OpenCode API key",
    oauth_label: None,
    signup_url: Some("https://opencode.ai/auth"),
    description: Some(
        "OpenCode's subscription ($10 or $40 a month) for open coding models. Most run with zero data retention and no training; the \"Contributor\" models train Meta's models on your prompts.",
    ),
};

const META_GOOGLE: ProviderMeta = ProviderMeta {
    id: "google",
    display_name: "Google Gemini",
    default_base_url: "https://generativelanguage.googleapis.com/v1beta",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::GeminiCatalogue,
    flavor: ProviderFlavor::GeminiGenerate,
    // Gemini 2.5 / 3.x are 1M-token windows; models.dev refines per model.
    default_context_window: 1_048_576,
    allows_blank_key: false,
    key_hint: "AIza…",
    oauth_label: None,
    signup_url: Some("https://aistudio.google.com/apikey"),
    description: Some(
        "Gemini API with a Google AI Studio key. Vertex AI and Google sign-in aren't supported.",
    ),
};

const META_OPENROUTER: ProviderMeta = ProviderMeta {
    id: "openrouter",
    display_name: "OpenRouter",
    default_base_url: "https://openrouter.ai/api/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    default_context_window: 200_000,
    allows_blank_key: false,
    key_hint: "sk-or-v1-…",
    oauth_label: None,
    signup_url: Some("https://openrouter.ai/keys"),
    description: None,
};

const META_ANTHROPIC: ProviderMeta = ProviderMeta {
    id: "anthropic",
    display_name: "Anthropic",
    default_base_url: "https://api.anthropic.com/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::AnthropicCatalogue,
    flavor: ProviderFlavor::AnthropicMessages,
    // Claude 4.x models default to 200k. Sonnet has a 1M variant via
    // `context-1m-2025-08-07` beta; per-model overrides handled by
    // `model_context_window`.
    default_context_window: 200_000,
    allows_blank_key: false,
    key_hint: "sk-ant-…",
    oauth_label: None,
    signup_url: Some("https://console.anthropic.com/settings/keys"),
    description: None,
};

const META_OPENAI: ProviderMeta = ProviderMeta {
    id: "openai",
    display_name: "OpenAI",
    default_base_url: "https://api.openai.com/v1",
    // OAuth listed first so the connect button defaults to "Sign in with
    // ChatGPT" — matches operator expectations for the most-recognised
    // option. Operators with API keys still get the API-key form below.
    auth_modes: &[AuthMode::OAuth, AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    // NOTE: when the active OpenAI credential is `Credential::OAuth`, the
    // builder swaps the flavor to `OpenAiResponses` (Codex endpoint). The
    // metadata here is the API-key default.
    flavor: ProviderFlavor::OpenAiCompat,
    // gpt-5 / gpt-5-mini default 400k; o1/o3 are 200k. Conservative
    // shared default; per-model table covers the variation.
    default_context_window: 200_000,
    allows_blank_key: false,
    key_hint: "sk-…",
    oauth_label: Some("ChatGPT"),
    signup_url: Some("https://platform.openai.com/api-keys"),
    description: None,
};

const META_ZAI: ProviderMeta = ProviderMeta {
    id: "zai",
    display_name: "Z.AI",
    // Coding endpoint serves the GLM coding-tier models.
    default_base_url: "https://api.z.ai/api/coding/paas/v4",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::Static,
    flavor: ProviderFlavor::OpenAiCompat,
    default_context_window: 200_000,
    allows_blank_key: false,
    key_hint: "API key",
    oauth_label: None,
    signup_url: None,
    description: None,
};

const META_MINIMAX: ProviderMeta = ProviderMeta {
    id: "minimax",
    display_name: "MiniMax",
    default_base_url: "https://api.minimax.io/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::Static,
    flavor: ProviderFlavor::OpenAiCompat,
    default_context_window: 200_000,
    allows_blank_key: false,
    key_hint: "API key",
    oauth_label: None,
    signup_url: None,
    description: None,
};

const META_GROQ: ProviderMeta = ProviderMeta {
    id: "groq",
    display_name: "Groq",
    default_base_url: "https://api.groq.com/openai/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Llama-3.3 70B + Kimi K2 on Groq are 131k; older models 32k. Use
    // the larger; per-model overrides cover anything tighter.
    default_context_window: 131_072,
    allows_blank_key: false,
    key_hint: "gsk_…",
    oauth_label: None,
    signup_url: Some("https://console.groq.com/keys"),
    description: None,
};

const META_DEEPSEEK: ProviderMeta = ProviderMeta {
    id: "deepseek",
    display_name: "DeepSeek",
    default_base_url: "https://api.deepseek.com/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // deepseek-chat / deepseek-reasoner are 128k.
    default_context_window: 128_000,
    allows_blank_key: false,
    key_hint: "sk-…",
    oauth_label: None,
    signup_url: Some("https://platform.deepseek.com/api_keys"),
    description: None,
};

const META_MISTRAL: ProviderMeta = ProviderMeta {
    id: "mistral",
    display_name: "Mistral",
    default_base_url: "https://api.mistral.ai/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // mistral-large-2 / codestral are 128k–256k; conservative midpoint.
    default_context_window: 131_072,
    allows_blank_key: false,
    key_hint: "API key",
    oauth_label: None,
    signup_url: Some("https://console.mistral.ai/api-keys"),
    description: None,
};

const META_TOGETHER: ProviderMeta = ProviderMeta {
    id: "together",
    display_name: "Together",
    default_base_url: "https://api.together.xyz/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Highly model-dependent (32k → 1M). 128k is a safe middle.
    default_context_window: 131_072,
    allows_blank_key: false,
    key_hint: "API key",
    oauth_label: None,
    signup_url: Some("https://api.together.xyz/settings/api-keys"),
    description: None,
};

const META_OLLAMA: ProviderMeta = ProviderMeta {
    id: "ollama",
    display_name: "Ollama",
    default_base_url: "http://localhost:11434/v1",
    // Ollama allows anonymous local access. We still ask for an
    // optional "API key" — the operator can leave it blank, in which
    // case the provider sends no Authorization header.
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Local models commonly run with `num_ctx: 8192`; bump if your
    // local Ollama is configured larger. 32k is a kind compromise.
    default_context_window: 32_768,
    allows_blank_key: true,
    key_hint: "(blank for local)",
    oauth_label: None,
    signup_url: None,
    description: None,
};

const META_MOONSHOT: ProviderMeta = ProviderMeta {
    id: "moonshot",
    display_name: "Moonshot (Kimi)",
    // International endpoint. Operators in mainland China can override
    // the base URL to `https://api.moonshot.cn/v1` via the row's
    // base-URL field — the wire shape is identical.
    default_base_url: "https://api.moonshot.ai/v1",
    auth_modes: &[AuthMode::ApiKey],
    // `GET /v1/models` is enumerable with a key (verified: 401 without
    // one), so the picker is fed live; models.dev (`moonshotai`) is the
    // fallback when the endpoint is unreachable.
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Kimi K2 generation is 256k; older moonshot-v1 models are 128k.
    default_context_window: 131_072,    allows_blank_key: false,
    key_hint: "sk-…",
    oauth_label: None,
    signup_url: Some("https://platform.moonshot.ai/console/api-keys"),
    description: Some("Moonshot AI's Kimi models over an OpenAI-compatible wire; the model list is fetched live once a key is saved. In mainland China set the base URL to https://api.moonshot.cn/v1."),
};

const META_CUSTOM_OPENAI: ProviderMeta = ProviderMeta {
    id: "custom_openai",
    display_name: "Custom (OpenAI-compatible)",
    // No canonical endpoint — the operator must supply one via the
    // base-URL field. The placeholder matches Ollama-style local
    // gateways; it's only a hint, never a sensible default.
    default_base_url: "http://localhost:8080/v1",
    auth_modes: &[AuthMode::ApiKey],
    // Probe `GET /models`; when the endpoint can't enumerate, the
    // operator's custom model list carries the picker.
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    // Unknown upstream — conservative middle; custom models get the
    // same fallback unless the operator's gateway reports limits.
    default_context_window: 131_072,    allows_blank_key: true,
    key_hint: "(blank if endpoint is open)",
    oauth_label: None,
    signup_url: None,
    description: Some("Any endpoint speaking OpenAI Chat Completions (proxy, gateway, self-hosted). Set the base URL and key, press Test to probe GET /models; if the endpoint can't list models, add ids under Custom models."),
};

const META_CUSTOM_ANTHROPIC: ProviderMeta = ProviderMeta {
    id: "custom_anthropic",
    display_name: "Custom (Anthropic-compatible)",
    default_base_url: "http://localhost:8080/v1",
    auth_modes: &[AuthMode::ApiKey],
    // Anthropic's `GET /v1/models` shape (`{data:[{id, display_name}]}`).
    models_endpoint: ModelsEndpoint::AnthropicCatalogue,
    flavor: ProviderFlavor::AnthropicMessages,
    default_context_window: 200_000,    allows_blank_key: true,
    key_hint: "(blank if endpoint is open)",
    oauth_label: None,
    signup_url: None,
    description: Some("Any endpoint speaking Anthropic's Messages API (e.g. a Claude gateway or Kimi's /anthropic transport). Same probing rules as the OpenAI-compatible entry."),
};

const META_KIMI_CODING: ProviderMeta = ProviderMeta {
    id: "kimi_coding",
    display_name: "Kimi For Coding",
    // The kimi.com coding subscription — a separate product from the
    // Moonshot platform (different keys, different model set). Verified
    // against the live API: Anthropic-Messages wire (`x-api-key` +
    // `anthropic-version`, `event:`-line SSE), enumerable
    // `GET /v1/models`, thinking blocks always on
    // (`supports_thinking_type: "only"` — streamed as `thinking_delta`,
    // which our SSE machine skips), tolerant of assistant history
    // without thinking blocks, and `budget_tokens` accepted.
    default_base_url: "https://api.kimi.com/coding/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::AnthropicCatalogue,
    flavor: ProviderFlavor::AnthropicMessages,
    // kimi-for-coding / k3-256k are 256k; k3 is 1M. Conservative
    // fallback; models.dev (`kimi-for-coding`) enriches per model.
    default_context_window: 262_144,    allows_blank_key: false,
    key_hint: "sk-kimi-…",
    oauth_label: None,
    signup_url: None,
    description: Some("The kimi.com coding subscription — a separate product from the Moonshot platform with its own keys and models (K2.7 Coding, K3). Speaks Anthropic's Messages API; models are listed live once a key is saved."),
};

/// Disclosure the UI must show before the operator switches a provider on.
/// Lives next to the metadata so the wording is not a frontend concern.
#[derive(Debug, Clone, Copy)]
pub struct EnableNotice {
    pub headline: &'static str,
    pub points: &'static [&'static str],
    pub learn_more_url: &'static str,
}

const ZEN_ENABLE_NOTICE: EnableNotice = EnableNotice {
    headline: "Enable OpenCode Zen free tier?",
    points: &[
        "Free: no account or API key. FerrisScope uses OpenCode's public key and lists only zero-cost models.",
        "Everything the agent sends leaves your machine for OpenCode's proxy and on to third-party model hosts — your prompts plus cluster data it reads (pod logs, manifests, events, tool output).",
        "Free models run on trial terms. Some providers log requests or use them to improve their models (e.g. Big Pickle, NVIDIA Nemotron — \"no confidential data\"). Check the current list before use.",
        "Don't use it on clusters holding secrets, customer data or regulated workloads. Models and rate limits change without notice.",
    ],
    learn_more_url: "https://opencode.ai/docs/zen#privacy",
};

/// The disclosure to show when enabling `kind`, if it has one.
pub fn enable_notice(kind: ProviderKind) -> Option<&'static EnableNotice> {
    match kind {
        ProviderKind::OpencodeZen => Some(&ZEN_ENABLE_NOTICE),
        _ => None,
    }
}

pub fn for_kind(kind: ProviderKind) -> &'static ProviderMeta {
    match kind {
        ProviderKind::OpencodeZen => &META_OPENCODE_ZEN,
        ProviderKind::OpencodeGo => &META_OPENCODE_GO,
        ProviderKind::OpenRouter => &META_OPENROUTER,
        ProviderKind::Anthropic => &META_ANTHROPIC,
        ProviderKind::Google => &META_GOOGLE,
        ProviderKind::OpenAI => &META_OPENAI,
        ProviderKind::Zai => &META_ZAI,
        ProviderKind::Minimax => &META_MINIMAX,
        ProviderKind::Groq => &META_GROQ,
        ProviderKind::Deepseek => &META_DEEPSEEK,
        ProviderKind::Mistral => &META_MISTRAL,
        ProviderKind::Together => &META_TOGETHER,
        ProviderKind::Ollama => &META_OLLAMA,
        ProviderKind::Moonshot => &META_MOONSHOT,
        ProviderKind::KimiCoding => &META_KIMI_CODING,
        ProviderKind::CustomOpenAi => &META_CUSTOM_OPENAI,
        ProviderKind::CustomAnthropic => &META_CUSTOM_ANTHROPIC,
    }
}

/// Models.dev id for `kind`. The catalogue at `https://models.dev/api.json`
/// keys providers by these stable ids — we map our `ProviderKind` to
/// them at lookup time. `None` ⇒ this provider isn't on models.dev (we
/// fall back to the per-provider default window).
pub fn models_dev_id(kind: ProviderKind) -> Option<&'static str> {
    Some(match kind {
        // models.dev keys the OpenCode Zen catalogue under the bare
        // `opencode` id (matches opencode's own provider config).
        ProviderKind::OpencodeZen => "opencode",
        ProviderKind::OpencodeGo => "opencode-go",
        ProviderKind::OpenRouter => "openrouter",
        ProviderKind::Anthropic => "anthropic",
        ProviderKind::Google => "google",
        ProviderKind::OpenAI => "openai",
        ProviderKind::Groq => "groq",
        ProviderKind::Deepseek => "deepseek",
        ProviderKind::Mistral => "mistral",
        ProviderKind::Together => "togetherai",
        // Z.AI / MiniMax are on models.dev under their bare ids — this
        // both drives the catalogue-backed model list (their live
        // endpoints aren't enumerable) and enables context-window /
        // capability enrichment for them.
        ProviderKind::Zai => "zai",
        ProviderKind::Minimax => "minimax",
        // Moonshot's international catalogue on models.dev. (There's a
        // separate `moonshotai-cn` entry for the China endpoint; we key
        // enrichment off the international one — model ids overlap.)
        ProviderKind::Moonshot => "moonshotai",
        // Separate catalogue entry from `moonshotai` — different product,
        // different models (`kimi-for-coding`, `k3`), different limits.
        ProviderKind::KimiCoding => "kimi-for-coding",
        // Ollama serves local models that aren't in models.dev — keep it
        // on the live `/models` path. Custom endpoints are by definition
        // not in the community catalogue.
        ProviderKind::Ollama | ProviderKind::CustomOpenAi | ProviderKind::CustomAnthropic => {
            return None;
        }
    })
}

/// Curated fallback model list for providers whose `/models` isn't
/// publicly enumerable. Returned by `list_models` when
/// `ModelsEndpoint::Static`. Keep ids in sync with each vendor's docs.
pub fn static_models(kind: ProviderKind) -> &'static [(&'static str, &'static str)] {
    match kind {
        ProviderKind::Zai => &[
            ("glm-4.6", "GLM-4.6"),
            ("glm-4.5-air", "GLM-4.5 Air"),
            ("glm-4.5", "GLM-4.5"),
            ("glm-4.5-x", "GLM-4.5-X"),
        ],
        ProviderKind::Minimax => &[
            ("MiniMax-M2", "MiniMax-M2"),
            ("MiniMax-Text-01", "MiniMax-Text-01"),
            ("abab6.5s-chat", "abab6.5s"),
        ],
        // Moonshot — offline / cold-start fallback only; the live
        // `/models` endpoint is enumerable with a key and models.dev
        // covers the rest. Ids mirror the public model index.
        ProviderKind::Moonshot => &[
            ("kimi-k2.5", "Kimi K2.5"),
            ("kimi-k2-thinking", "Kimi K2 Thinking"),
            ("kimi-k2-0905-preview", "Kimi K2 (0905 preview)"),
            ("moonshot-v1-128k", "Moonshot v1 128k"),
        ],
        // Kimi For Coding — offline fallback only; live `/v1/models` is
        // enumerable with a key (verified).
        ProviderKind::KimiCoding => &[
            ("kimi-for-coding", "K2.7 Coding"),
            ("kimi-for-coding-highspeed", "K2.7 Coding Highspeed"),
            ("k3", "K3 (1M)"),
            ("k3-256k", "K3 256k"),
        ],
        // Anthropic — used by the Anthropic provider when the live
        // catalogue call fails. Names mirror the public model index.
        ProviderKind::Anthropic => &[
            ("claude-opus-4-7", "Claude Opus 4.7"),
            ("claude-opus-4-6", "Claude Opus 4.6"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-haiku-4-5", "Claude Haiku 4.5"),
            ("claude-haiku-4-5-1m", "Claude Haiku 4.5 (1M)"),
        ],
        // Gemini — offline / cold-start fallback only; the live `GET /models`
        // call and models.dev supply the real list.
        ProviderKind::Google => &[
            ("gemini-3.5-flash", "Gemini 3.5 Flash"),
            ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
            ("gemini-flash-latest", "Gemini Flash Latest"),
        ],
        // OpenAI Codex (OAuth) — model set the Codex endpoint accepts.
        // Used by `OpenAICodexProvider::list_models`.
        ProviderKind::OpenAI => &[
            ("gpt-5.5", "GPT-5.5"),
            ("gpt-5.4", "GPT-5.4"),
            ("gpt-5.4-mini", "GPT-5.4 mini"),
            ("gpt-5.3-codex", "GPT-5.3 Codex"),
            ("gpt-5.2", "GPT-5.2"),
        ],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_fields_agree_with_auth_modes_and_blank_key_policy() {
        for kind in ProviderKind::all() {
            let m = for_kind(*kind);
            assert_eq!(
                m.oauth_label.is_some(),
                m.auth_modes.contains(&AuthMode::OAuth),
                "{kind:?}: oauth_label must match the OAuth auth mode"
            );
            assert!(!m.key_hint.is_empty(), "{kind:?}");
            if let Some(url) = m.signup_url {
                assert!(url.starts_with("https://"), "{kind:?}: {url}");
            }
            if let Some(d) = m.description {
                assert!(!d.trim().is_empty(), "{kind:?}");
            }
            // Only endpoints that can run unauthenticated may save a blank key.
            assert_eq!(
                m.allows_blank_key,
                matches!(
                    kind,
                    ProviderKind::Ollama
                        | ProviderKind::CustomOpenAi
                        | ProviderKind::CustomAnthropic
                ),
                "{kind:?}"
            );
        }
        assert_eq!(for_kind(ProviderKind::OpenAI).oauth_label, Some("ChatGPT"));
    }

    #[test]
    fn only_zen_carries_an_enable_notice() {
        for kind in ProviderKind::all() {
            let notice = enable_notice(*kind);
            assert_eq!(
                notice.is_some(),
                kind.supports_public_fallback(),
                "{kind:?}"
            );
        }
        let zen = enable_notice(ProviderKind::OpencodeZen).unwrap();
        assert!(zen.points.len() >= 3);
        assert!(zen.learn_more_url.starts_with("https://"));
        assert!(zen.points.iter().any(|p| p.contains("Free")));
        assert!(zen.points.iter().any(|p| p.contains("leaves your machine")));
    }

    #[test]
    fn models_dev_id_maps_zai_and_minimax() {
        // These drive catalogue-backed model lists (no enumerable live
        // endpoint) plus context/capability enrichment.
        assert_eq!(models_dev_id(ProviderKind::Zai), Some("zai"));
        assert_eq!(models_dev_id(ProviderKind::Minimax), Some("minimax"));
    }

    #[test]
    fn models_dev_id_none_for_ollama() {
        // Ollama serves local models absent from models.dev — must stay on
        // the live `/models` path.
        assert_eq!(models_dev_id(ProviderKind::Ollama), None);
    }

    #[test]
    fn moonshot_metadata_points_at_enumerable_openai_endpoint() {
        let m = for_kind(ProviderKind::Moonshot);
        assert_eq!(m.id, "moonshot");
        assert_eq!(m.default_base_url, "https://api.moonshot.ai/v1");
        assert!(matches!(
            m.models_endpoint,
            ModelsEndpoint::OpenAiCompatible
        ));
        assert!(matches!(m.flavor, ProviderFlavor::OpenAiCompat));
        assert_eq!(models_dev_id(ProviderKind::Moonshot), Some("moonshotai"));
        assert!(!static_models(ProviderKind::Moonshot).is_empty());
    }

    #[test]
    fn custom_providers_have_no_catalogue_and_unique_ids() {
        // Custom endpoints aren't on models.dev (catalogue enrichment /
        // fallback list would be wrong for an arbitrary gateway), and
        // their keychain account ids must not collide with built-ins.
        for kind in [ProviderKind::CustomOpenAi, ProviderKind::CustomAnthropic] {
            assert_eq!(models_dev_id(kind), None);
            assert!(static_models(kind).is_empty());
        }
        let ids: std::collections::HashSet<&str> = ProviderKind::all()
            .iter()
            .map(|k| for_kind(*k).id)
            .collect();
        assert_eq!(ids.len(), ProviderKind::all().len());
        assert!(matches!(
            for_kind(ProviderKind::CustomAnthropic).flavor,
            ProviderFlavor::AnthropicMessages
        ));
    }

    #[test]
    fn kimi_coding_is_anthropic_wired_with_own_catalogue() {
        // The kimi.com coding subscription is a separate product from
        // the Moonshot platform: Anthropic-Messages wire, its own
        // models.dev entry, its own keychain id. Verified against the
        // live API (2026-07): `GET /coding/v1/models` + `/messages` SSE
        // both speak the Anthropic shapes with `x-api-key` auth.
        let m = for_kind(ProviderKind::KimiCoding);
        assert_eq!(m.id, "kimi_coding");
        assert_eq!(m.default_base_url, "https://api.kimi.com/coding/v1");
        assert!(matches!(
            m.models_endpoint,
            ModelsEndpoint::AnthropicCatalogue
        ));
        assert!(matches!(m.flavor, ProviderFlavor::AnthropicMessages));
        assert_eq!(
            models_dev_id(ProviderKind::KimiCoding),
            Some("kimi-for-coding")
        );
        assert!(static_models(ProviderKind::KimiCoding)
            .iter()
            .any(|(id, _)| *id == "kimi-for-coding"));
        assert_eq!(
            serde_json::to_string(&ProviderKind::KimiCoding).unwrap(),
            "\"kimi_coding\""
        );
    }
}
