//! LLM provider abstraction. Implementations live in submodules.

pub mod anthropic;
pub mod catalogue;
pub mod meta;
pub mod openai_codex;
pub mod openai_compat;

use crate::types::{ChatMessage, ToolCall, ToolSchema};
use async_trait::async_trait;
use eventsource_stream::{Event, EventStreamError, Eventsource};
use futures::stream::{BoxStream, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// An HTTP-layer failure. `status` is `Some` for a non-success response
    /// (the authoritative numeric code) and `None` for a transport error
    /// (connection refused / reset / timeout — no response, hence no status).
    /// Carrying the status as a field lets the retry classifier key on the
    /// number instead of grepping the prose, where a model id or body text
    /// containing "503"/"429" used to cause misclassification.
    #[error("http error{}: {body}", status.as_ref().map(|s| format!(" {s}")).unwrap_or_default())]
    Http { status: Option<u16>, body: String },
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

impl ProviderError {
    /// Classify a non-success HTTP response into the right error. 401 →
    /// [`ProviderError::Auth`] (never retryable); everything else →
    /// [`ProviderError::Http`] with the numeric status preserved. Centralises
    /// the per-provider mapping that was previously copy-pasted three times.
    pub fn from_http_status(status: u16, body: String) -> Self {
        if status == 401 {
            ProviderError::Auth(body)
        } else {
            ProviderError::Http {
                status: Some(status),
                body,
            }
        }
    }

    /// A transport-level failure (connection refused / reset / timeout) with no
    /// HTTP response — `status` is `None`, so the retry classifier falls back
    /// to phrase matching for these inherently-retryable cases.
    pub fn transport(msg: impl Into<String>) -> Self {
        ProviderError::Http {
            status: None,
            body: msg.into(),
        }
    }

    /// A streaming response that went silent for `idle`. Worded to hit the
    /// retry classifier's timeout phrase.
    pub fn stream_stalled(idle: Duration) -> Self {
        Self::transport(format!(
            "response stream stalled: timed out after {}s without data",
            idle.as_secs()
        ))
    }
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
    /// Concatenated "thinking" text streamed alongside `content` for
    /// interleaved-thinking models (DeepSeek, Big Pickle, GLM-4.x,
    /// Kimi K2.5, …). The agent loop persists it on the assistant
    /// message so the next request can pass it back — DeepSeek's API
    /// 400s without it. `None` for providers that don't stream
    /// reasoning at all (Anthropic uses a separate Messages-API
    /// content block; Codex Responses uses encrypted reasoning items).
    pub reasoning_content: Option<String>,
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

/// Build the replacement text when image attachments are dropped because
/// the active model can't accept image input. Keeps the operator's prose
/// and tells the model an image existed, so its reply isn't confusingly
/// blind to something the operator clearly attached. Shared across
/// providers so the wording (and the "drop, don't 400" policy) stays
/// consistent.
pub(crate) fn dropped_images_note(text: &str, count: usize) -> String {
    let plural = if count == 1 { "image" } else { "images" };
    let note = format!(
        "[{count} {plural} attached but omitted: the selected model does not support image input.]"
    );
    if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    }
}

/// Longest gap tolerated between body chunks of a streaming response. A
/// stream that dies mid-response (suspend, network change) otherwise hangs
/// until the 10-minute request timeout. Measured on raw bytes, so SSE comment
/// keepalives count; generous because reasoning models can pause for a while.
pub(crate) const STREAM_IDLE_TIMEOUT: Duration = Duration::from_mins(2);

/// Parse an SSE body into events, failing with a retryable transport error
/// (see `classify::is_transient_error`) when no bytes arrive for `idle`.
pub(crate) fn sse_events<S, B, E>(
    body: S,
    idle: Duration,
) -> BoxStream<'static, Result<Event, ProviderError>>
where
    S: Stream<Item = Result<B, E>> + Send + Unpin + 'static,
    B: AsRef<[u8]> + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    with_idle_timeout(body, idle)
        .eventsource()
        .map(|ev| {
            ev.map_err(|e| match e {
                EventStreamError::Transport(pe) => pe,
                other => ProviderError::Decode(other.to_string()),
            })
        })
        .boxed()
}

fn with_idle_timeout<S, B, E>(
    body: S,
    idle: Duration,
) -> impl Stream<Item = Result<B, ProviderError>> + Send
where
    S: Stream<Item = Result<B, E>> + Send + Unpin,
    B: Send,
    E: std::fmt::Display,
{
    futures::stream::unfold(Some(body), move |state| async move {
        let mut body = state?;
        match tokio::time::timeout(idle, body.next()).await {
            Ok(Some(Ok(chunk))) => Some((Ok(chunk), Some(body))),
            Ok(Some(Err(e))) => Some((Err(ProviderError::transport(e.to_string())), Some(body))),
            Ok(None) => None,
            Err(_) => Some((Err(ProviderError::stream_stalled(idle)), None)),
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    type Chunk = Result<&'static [u8], std::io::Error>;

    #[tokio::test(start_paused = true)]
    async fn sse_events_errors_when_stream_stalls() {
        let body = futures::stream::iter([Ok::<_, std::io::Error>(&b"data: a\n\n"[..])])
            .chain(futures::stream::pending::<Chunk>());
        let mut events = sse_events(body, Duration::from_secs(90));

        assert_eq!(events.next().await.unwrap().unwrap().data, "a");
        let start = tokio::time::Instant::now();
        let err = events.next().await.unwrap().unwrap_err();
        assert_eq!(start.elapsed(), Duration::from_secs(90));
        assert!(matches!(err, ProviderError::Http { status: None, .. }));
        assert!(err.to_string().contains("timed out"));
        assert!(events.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn sse_events_tolerates_gaps_below_idle() {
        let body = futures::stream::iter([&b"data: a\n\n"[..], b": keepalive\n\n", b"data: b\n\n"])
            .then(|chunk| async move {
                tokio::time::sleep(Duration::from_secs(80)).await;
                Ok::<_, std::io::Error>(chunk)
            })
            .boxed();
        let got: Vec<String> = sse_events(body, Duration::from_secs(90))
            .map(|ev| ev.unwrap().data)
            .collect()
            .await;
        assert_eq!(got, ["a", "b"]);
    }

    #[tokio::test]
    async fn sse_events_maps_body_errors_to_transport() {
        let body =
            futures::stream::iter([Err::<&[u8], _>(std::io::Error::other("connection reset"))]);
        let err = sse_events(body, Duration::from_secs(90))
            .next()
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(err, ProviderError::Http { status: None, .. }));
    }
}
