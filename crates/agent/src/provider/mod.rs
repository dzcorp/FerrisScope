//! LLM provider abstraction. Implementations live in submodules.

pub mod anthropic;
pub mod catalogue;
pub mod meta;
pub mod openai_codex;
pub mod openai_compat;

use crate::types::{ChatMessage, ToolCall, ToolSchema};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("http error: {0}")]
    Http(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("provider returned an invalid response: {0}")]
    InvalidResponse(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("decode: {0}")]
    Decode(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    /// Optional display name from the provider catalogue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Context window in tokens, when the catalogue exposes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    /// Tools the agent may call. Empty for plain-chat M1 sessions.
    #[serde(default)]
    pub tools: Vec<ToolSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Provider-specific knobs that don't generalise across vendors —
    /// merged verbatim into the request body. Examples: Anthropic
    /// extended thinking (`{ "thinking": { "type": "enabled",
    /// "budget_tokens": 16000 } }`), OpenAI Responses reasoning effort
    /// (`{ "reasoning": { "effort": "high" } }`), OpenRouter routing
    /// preferences (`{ "provider": { "order": ["Anthropic"] } }`).
    /// Values here override anything the provider would set by default.
    /// `None` means "use defaults" — the canonical state for chats that
    /// haven't customised options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<serde_json::Value>,
}

/// Streaming events emitted while a provider call is in flight. The provider
/// implementation maps its native streaming format (OpenAI-compatible SSE for
/// OpenRouter) onto this neutral wire shape so the agent loop and the UI
/// don't have to care about provider-specific deltas.
#[derive(Debug, Clone)]
pub enum CompletionEvent {
    /// A chunk of assistant text.
    TokenDelta(String),
    /// A new tool call has begun streaming.
    ToolCallStart { id: String, name: String },
    /// More argument JSON for an in-flight tool call.
    ToolCallArgsDelta { id: String, json_delta: String },
    /// The provider signalled the end of a tool call's arguments.
    ToolCallEnd { id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    #[default]
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct CompletionFinal {
    pub finish_reason: FinishReason,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
}

/// Sink the provider invokes for each streaming event. Boxed-trait-object
/// rather than a generic so `dyn ChatProvider` stays object-safe.
pub type EventSink = Box<dyn Fn(CompletionEvent) + Send + Sync>;

/// Shallow-merge `overrides` into `body`. Operator-supplied
/// `provider_options` should be applied last so they can clobber the
/// provider's defaults (e.g. force a particular `temperature`, swap in
/// a custom `tools` array, set Anthropic `thinking` or OpenAI
/// `reasoning`). Object values nest one level: `body.x.y` survives an
/// override of `x.z` only if both `x`s are objects we can merge.
/// Anything else replaces verbatim.
pub(crate) fn merge_top_level(body: &mut serde_json::Value, overrides: &serde_json::Value) {
    let (Some(body_obj), Some(over_obj)) = (body.as_object_mut(), overrides.as_object()) else {
        return;
    };
    for (k, v) in over_obj {
        match (body_obj.get_mut(k), v) {
            (Some(existing @ serde_json::Value::Object(_)), serde_json::Value::Object(_)) => {
                merge_top_level(existing, v);
            }
            _ => {
                body_obj.insert(k.clone(), v.clone());
            }
        }
    }
}

#[async_trait]
pub trait ChatProvider: Send + Sync {
    fn name(&self) -> &'static str;

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;

    async fn stream_completion(
        &self,
        req: CompletionRequest,
        sink: EventSink,
    ) -> Result<CompletionFinal, ProviderError>;
}
