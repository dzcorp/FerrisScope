//! Static per-provider metadata: stable id, display name, default base URL,
//! supported auth modes, and the strategy we use to enumerate models.
//!
//! The set is intentionally small. Adding a provider means:
//! 1. A new `ProviderKind` variant in [`crate::config`].
//! 2. A `meta::for_kind` row here.
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
    default_context_window: 200_000,
};

const META_OPENROUTER: ProviderMeta = ProviderMeta {
    id: "openrouter",
    display_name: "OpenRouter",
    default_base_url: "https://openrouter.ai/api/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::OpenAiCompatible,
    flavor: ProviderFlavor::OpenAiCompat,
    default_context_window: 200_000,
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
};

const META_MINIMAX: ProviderMeta = ProviderMeta {
    id: "minimax",
    display_name: "MiniMax",
    default_base_url: "https://api.minimax.io/v1",
    auth_modes: &[AuthMode::ApiKey],
    models_endpoint: ModelsEndpoint::Static,
    flavor: ProviderFlavor::OpenAiCompat,
    default_context_window: 200_000,
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
};

pub fn for_kind(kind: ProviderKind) -> &'static ProviderMeta {
    match kind {
        ProviderKind::OpencodeZen => &META_OPENCODE_ZEN,
        ProviderKind::OpenRouter => &META_OPENROUTER,
        ProviderKind::Anthropic => &META_ANTHROPIC,
        ProviderKind::OpenAI => &META_OPENAI,
        ProviderKind::Zai => &META_ZAI,
        ProviderKind::Minimax => &META_MINIMAX,
        ProviderKind::Groq => &META_GROQ,
        ProviderKind::Deepseek => &META_DEEPSEEK,
        ProviderKind::Mistral => &META_MISTRAL,
        ProviderKind::Together => &META_TOGETHER,
        ProviderKind::Ollama => &META_OLLAMA,
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
        ProviderKind::OpenRouter => "openrouter",
        ProviderKind::Anthropic => "anthropic",
        ProviderKind::OpenAI => "openai",
        ProviderKind::Groq => "groq",
        ProviderKind::Deepseek => "deepseek",
        ProviderKind::Mistral => "mistral",
        ProviderKind::Together => "togetherai",
        // Z.AI / MiniMax / Ollama aren't reliably on models.dev — fall
        // through to per-provider defaults.
        ProviderKind::Zai | ProviderKind::Minimax | ProviderKind::Ollama => return None,
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
        // Anthropic — used by the Anthropic provider when the live
        // catalogue call fails. Names mirror the public model index.
        ProviderKind::Anthropic => &[
            ("claude-opus-4-7", "Claude Opus 4.7"),
            ("claude-opus-4-6", "Claude Opus 4.6"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-haiku-4-5", "Claude Haiku 4.5"),
            ("claude-haiku-4-5-1m", "Claude Haiku 4.5 (1M)"),
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
