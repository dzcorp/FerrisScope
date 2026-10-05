//! Anthropic Messages API provider.
//!
//! Endpoint: `<base>/messages`. Auth via `x-api-key` (key mode only — Pro/Max
//! OAuth is intentionally out of scope, see `plan.md`). Request body shape
//! differs from OpenAI: `system` is a top-level string, `messages` use
//! content blocks (`text` / `tool_use` / `tool_result`), and tools declare
//! their schema via `input_schema`. Streaming uses
//! [SSE event lines](https://docs.anthropic.com/en/api/messages-streaming):
//! `event: message_start`, `event: content_block_start` (with optional
//! `tool_use` block), `event: content_block_delta` (with `text_delta` /
//! `input_json_delta`), `event: content_block_stop`, `event: message_delta`
//! (carries the final stop_reason + usage), `event: message_stop`.
//!
//! We map all of that onto the neutral [`super::CompletionEvent`] wire so
//! the agent loop and the UI don't have to care about Anthropic specifics.

use super::{
    dropped_images_note, merge_top_level, sse_events, ChatProvider, CompletionEvent,
    CompletionFinal, CompletionRequest, EventSink, FinishReason, ModelInfo, ProviderError, Usage,
    STREAM_IDLE_TIMEOUT,
};
use crate::config::{Credential, ProviderKind};
use crate::provider::meta::{self, ProviderMeta};
use crate::types::{ChatMessage, MessageRole, ToolCall};
use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Default `max_tokens` ceiling when the operator hasn't set one (opencode's
/// 32k), further limited by the model's own output limit.
const DEFAULT_MAX_TOKENS_CAP: u32 = 32_000;

/// Floor for `thinking.budget_tokens`.
const MIN_THINKING_BUDGET: u32 = 1_024;

/// Room left for the answer after an extended-thinking budget.
const ANSWER_HEADROOM: u32 = 4_096;

/// Make a request with thinking on acceptable to the Messages API:
/// - `max_tokens` must exceed `thinking.budget_tokens` (thinking counts against
///   it), so raise it — never lower an explicit value — leaving room to answer;
///   the budget itself stays under the model's output limit;
/// - sampling other than the default is rejected, so drop `temperature` / `top_k`.
fn fit_thinking(body: &mut Value, output_limit: Option<u32>) {
    let Some(kind) = body
        .pointer("/thinking/type")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    if kind == "disabled" {
        return;
    }
    if let Some(o) = body.as_object_mut() {
        o.remove("temperature");
        o.remove("top_k");
    }
    if kind != "enabled" {
        return;
    }
    let Some(requested) = body
        .pointer("/thinking/budget_tokens")
        .and_then(Value::as_u64)
    else {
        return;
    };
    let cap = output_limit.unwrap_or(u32::MAX);
    let ceiling = cap
        .saturating_sub(MIN_THINKING_BUDGET)
        .max(MIN_THINKING_BUDGET);
    let budget = u32::try_from(requested)
        .unwrap_or(u32::MAX)
        .clamp(MIN_THINKING_BUDGET, ceiling);
    let max_tokens = body["max_tokens"]
        .as_u64()
        .map_or(0, |m| u32::try_from(m).unwrap_or(u32::MAX));
    let wanted = budget.saturating_add(ANSWER_HEADROOM).min(cap);
    let max_tokens = max_tokens.max(wanted).max(budget + 1);
    body["thinking"]["budget_tokens"] = json!(budget);
    body["max_tokens"] = json!(max_tokens);
}

pub struct AnthropicProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    /// Drives catalogue / capability lookups and the default base URL.
    /// `ProviderKind::Anthropic` for the first-party provider;
    /// `ProviderKind::CustomAnthropic` for operator-defined
    /// Anthropic-Messages-compatible gateways.
    kind: ProviderKind,
    extra_headers: Vec<(&'static str, String)>,
}

impl AnthropicProvider {
    pub fn new(cred: &Credential, base_url_override: Option<String>, kind: ProviderKind) -> Self {
        let m: &ProviderMeta = meta::for_kind(kind);
        let key = match cred {
            Credential::ApiKey { key } => key.trim().to_string(),
            // OAuth path is out of scope; if it gets here, send the
            // access token as the key. Server will reject with 401 and
            // we surface it cleanly.
            Credential::OAuth { access, .. } => access.clone(),
        };
        Self {
            client: reqwest::Client::builder()
                .user_agent(super::USER_AGENT)
                .connect_timeout(std::time::Duration::from_mins(1))
                .timeout(std::time::Duration::from_mins(10))
                .build()
                .expect("reqwest client"),
            base_url: base_url_override
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| m.default_base_url.to_string()),
            api_key: key,
            kind,
            extra_headers: Vec::new(),
        }
    }

    /// Attach the conversation's session id for gateways that route and
    /// cache on it (a no-op for every other provider kind).
    #[must_use]
    pub fn with_session(mut self, session_id: Option<&str>) -> Self {
        self.extra_headers = super::gateway_headers(self.kind, session_id);
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&self.api_key) {
            h.insert("x-api-key", v);
        }
        h.insert(
            "anthropic-version",
            reqwest::header::HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        super::apply_headers(&mut h, &self.extra_headers);
        h
    }
}

// ─── Request body construction ──────────────────────────────────────────────

/// Build the `content` array for a user message: an optional text block
/// followed by one `image` block per attachment. When the model can't see
/// images we drop them and fold a short note into the text so the model
/// isn't blind to something the operator attached. Anthropic requires a
/// non-empty content array, so the no-image / no-text path still emits a
/// single (possibly empty) text block — preserving the prior behaviour.
fn user_content(m: &ChatMessage, supports_vision: bool) -> Vec<Value> {
    if supports_vision && !m.images.is_empty() {
        let mut blocks: Vec<Value> = Vec::new();
        if !m.content.is_empty() {
            blocks.push(json!({ "type": "text", "text": m.content }));
        }
        for img in &m.images {
            blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.mime,
                    "data": img.data,
                },
            }));
        }
        blocks
    } else {
        let text = if m.images.is_empty() {
            m.content.clone()
        } else {
            dropped_images_note(&m.content, m.images.len())
        };
        vec![json!({ "type": "text", "text": text })]
    }
}

/// Convert the agent's neutral `Vec<ChatMessage>` into Anthropic's
/// `(system: String, messages: [...] )` shape. System messages collapse
/// into the top-level `system` field; assistant tool_calls become
/// `tool_use` content blocks; `Tool` role messages become a `user`
/// message containing a `tool_result` block (Anthropic's protocol uses
/// `user` with `tool_result` blocks rather than a dedicated tool role).
/// `supports_vision` gates whether user-message image attachments are
/// emitted as `image` blocks or dropped with a note.
fn build_messages(
    messages: &[ChatMessage],
    supports_vision: bool,
    replay_thinking: bool,
) -> (String, Vec<Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for m in messages {
        match m.role {
            MessageRole::System => {
                if !m.content.is_empty() {
                    system_parts.push(m.content.clone());
                }
            }
            MessageRole::User => {
                out.push(json!({
                    "role": "user",
                    "content": user_content(m, supports_vision),
                }));
            }
            MessageRole::Assistant => {
                // Thinking blocks lead the message: with thinking enabled the
                // API rejects a tool turn that doesn't start with them.
                let mut blocks: Vec<Value> = if replay_thinking {
                    m.thinking_blocks.clone()
                } else {
                    Vec::new()
                };
                if !m.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for tc in &m.tool_calls {
                    let input: Value =
                        serde_json::from_str(&tc.arguments).unwrap_or_else(|_| json!(tc.arguments));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": input,
                    }));
                }
                if blocks.is_empty() {
                    // Anthropic requires non-empty content. Pad with a
                    // single empty text block so multi-round transcripts
                    // with content-less assistant turns still validate.
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            MessageRole::Tool => {
                let id = m.tool_call_id.clone().unwrap_or_default();
                out.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": m.content,
                    }],
                }));
            }
        }
    }

    (system_parts.join("\n\n"), out)
}

// ─── Response shapes (subset we parse) ──────────────────────────────────────

#[derive(Debug, Deserialize)]
struct AnthropicModelsResp {
    data: Vec<AnthropicModelEntry>,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

// ─── ChatProvider impl ──────────────────────────────────────────────────────

#[async_trait]
impl ChatProvider for AnthropicProvider {
    fn name(&self) -> &'static str {
        meta::for_kind(self.kind).id
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // Try the live catalogue first; on any failure fall back to the
        // curated static list so the settings UI still has something to
        // show. (The catalogue endpoint isn't always reachable depending
        // on the operator's plan / region.)
        let result = self
            .client
            .get(self.url("/models"))
            .headers(self.headers())
            .send()
            .await;
        if let Ok(resp) = result {
            if resp.status().is_success() {
                if let Ok(parsed) = resp.json::<AnthropicModelsResp>().await {
                    return Ok(parsed
                        .data
                        .into_iter()
                        .map(|m| ModelInfo {
                            id: m.id,
                            name: m.display_name,
                            context_length: None,
                        })
                        .collect());
                }
            } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                let body = resp.text().await.unwrap_or_default();
                return Err(ProviderError::Auth(body));
            }
        }
        // Live `/models` unreachable. Prefer the models.dev catalogue
        // (stays fresh across releases), then the curated static list as
        // the offline / cold-start fallback so the picker is never empty.
        // Custom gateways have no catalogue entry — `list_models` returns
        // empty for them and the static list is empty too, surfacing the
        // live error to the operator instead of a phantom model list.
        let cat = crate::provider::catalogue::list_models(self.kind);
        if !cat.is_empty() {
            return Ok(cat);
        }
        Ok(meta::static_models(self.kind)
            .iter()
            .map(|(id, name)| ModelInfo {
                id: (*id).to_string(),
                name: Some((*name).to_string()),
                context_length: None,
            })
            .collect())
    }

    async fn stream_completion(
        &self,
        req: CompletionRequest,
        sink: EventSink,
    ) -> Result<CompletionFinal, ProviderError> {
        // Drop image blocks only when models.dev positively says the
        // model is text-only; unknown models default to "try it" and let
        // the apiserver be the arbiter.
        let supports_vision = crate::provider::catalogue::supports_vision(self.kind, &req.model);
        // Kimi For Coding speaks Messages but isn't Claude: it never needed the
        // blocks, so it keeps getting none.
        let replay_thinking = self.kind != ProviderKind::KimiCoding;
        let (system, messages) = build_messages(&req.messages, supports_vision, replay_thinking);
        let output_limit = crate::provider::catalogue::lookup(self.kind, &req.model)
            .map(|l| l.output)
            .filter(|o| *o > 0);
        // The model's own output ceiling (capped like opencode's 32k default):
        // thinking tokens count against `max_tokens`, so 8192 starves them.
        let default_max = output_limit.map_or(8192, |l| l.min(DEFAULT_MAX_TOKENS_CAP));

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            // Anthropic requires max_tokens. Default to a generous
            // ceiling so the model isn't artificially clipped; the
            // operator can override per-chat from the chat header.
            "max_tokens": req.max_tokens.unwrap_or(default_max),
        });
        if !system.is_empty() {
            body["system"] = json!(system);
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        if !req.tools.is_empty() {
            body["tools"] = json!(req
                .tools
                .iter()
                .map(|t| json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                }))
                .collect::<Vec<_>>());
        }

        // Operator-supplied overrides last so they win. Common knobs:
        // `thinking: { type: "enabled", budget_tokens: 16000 }` to
        // unlock extended thinking on Claude 4.x.
        if let Some(opts) = &req.provider_options {
            merge_top_level(&mut body, opts);
        }
        fit_thinking(&mut body, output_limit);

        let resp = self
            .client
            .post(self.url("/messages"))
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::transport(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::from_http_status(status, body));
        }

        let mut stream = sse_events(resp.bytes_stream(), STREAM_IDLE_TIMEOUT);
        let mut state = SseState::default();

        while let Some(ev) = stream.next().await {
            let ev = ev?;
            if ev.data.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&ev.data) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "anthropic: skipping unparseable SSE chunk");
                    continue;
                }
            };
            // The `event:` line is reflected in `value.type` for
            // Anthropic's SSE format, so we don't need to rely on the
            // SSE event-type field. Dispatch on `type`.
            let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "content_block_start" => state.on_block_start(&sink, &value),
                "content_block_delta" => state.on_block_delta(&sink, &value),
                "content_block_stop" => state.on_block_stop(&sink, &value),
                "message_delta" => state.on_message_delta(&value),
                "message_start" => state.on_message_start(&value),
                "message_stop" => break,
                // Mid-stream failure (`event: error` with
                // `{type:"error", error:{type:"rate_limit_error"|
                // "overloaded_error"|…, message}}` on an HTTP 200).
                // Failing the round keeps it out of the empty-turn
                // retry path and lets the classifier decide: transient
                // (rate limit / overload) or terminal (quota).
                "error" => {
                    let err_type = value
                        .pointer("/error/type")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let err_msg = value
                        .pointer("/error/message")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    return Err(ProviderError::Http {
                        status: None,
                        body: if err_type.is_empty() && err_msg.is_empty() {
                            ev.data.clone()
                        } else {
                            format!("{err_type}: {err_msg}")
                        },
                    });
                }
                _ => {}
            }
        }

        let finish_reason = state.finish_reason;
        let usage = state.usage.clone();
        let thinking_blocks = if self.kind == ProviderKind::KimiCoding {
            Vec::new()
        } else {
            state.thinking_blocks()
        };
        let tool_calls = state.into_tool_calls();
        Ok(CompletionFinal {
            finish_reason,
            tool_calls,
            usage,
            // Thinking rides as signed content blocks, not the OpenAI-compat
            // `reasoning_content` slot.
            reasoning_content: None,
            thinking_blocks,
        })
    }
}

/// Streaming-state machine for the Anthropic SSE protocol. Each
/// `content_block_*` event is keyed by a 0-based index that distinguishes
/// concurrent text + tool_use blocks within the same message.
#[derive(Default)]
struct SseState {
    /// Per-index accumulator. Text blocks have empty id/name; tool_use
    /// blocks carry both.
    blocks: std::collections::BTreeMap<u32, BlockEntry>,
    finish_reason: FinishReason,
    usage: Option<Usage>,
}

#[derive(Default)]
struct BlockEntry {
    /// `tool_use` only.
    tool_id: String,
    tool_name: String,
    /// Buffered partial JSON arguments for a tool_use block. Anthropic
    /// streams these as `input_json_delta.partial_json`.
    arguments: String,
    /// `true` once we've emitted `ToolCallStart` for this block.
    started: bool,
    is_tool: bool,
    /// `thinking` / `redacted_thinking` blocks, accumulated for replay.
    thinking: Option<ThinkingAcc>,
}

#[derive(Default)]
struct ThinkingAcc {
    redacted: bool,
    text: String,
    signature: String,
    /// `redacted_thinking`'s opaque payload.
    data: String,
}

impl SseState {
    fn on_message_start(&mut self, v: &Value) {
        if let Some(usage) = v.pointer("/message/usage") {
            self.usage = Some(merge_usage(self.usage.take(), usage));
        }
    }

    fn on_block_start(&mut self, sink: &EventSink, v: &Value) {
        let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let block = v.get("content_block").cloned().unwrap_or(Value::Null);
        let entry = self.blocks.entry(idx).or_default();
        match block.get("type").and_then(|x| x.as_str()) {
            Some("tool_use") => {
                entry.is_tool = true;
                entry.tool_id = block
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string();
                entry.tool_name = block
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string();
                if !entry.tool_id.is_empty() && !entry.tool_name.is_empty() {
                    sink(CompletionEvent::ToolCallStart {
                        id: entry.tool_id.clone(),
                        name: entry.tool_name.clone(),
                    });
                    entry.started = true;
                }
            }
            Some(kind @ ("thinking" | "redacted_thinking")) => {
                let str_of = |k: &str| {
                    block
                        .get(k)
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string()
                };
                entry.thinking = Some(ThinkingAcc {
                    redacted: kind == "redacted_thinking",
                    text: str_of("thinking"),
                    signature: str_of("signature"),
                    data: str_of("data"),
                });
            }
            _ => {
                // text or other; nothing to emit yet.
            }
        }
    }

    fn on_block_delta(&mut self, sink: &EventSink, v: &Value) {
        let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let delta = v.get("delta").cloned().unwrap_or(Value::Null);
        let entry = self.blocks.entry(idx).or_default();
        match delta.get("type").and_then(|x| x.as_str()) {
            Some("text_delta") => {
                if let Some(text) = delta.get("text").and_then(|x| x.as_str()) {
                    if !text.is_empty() {
                        sink(CompletionEvent::TokenDelta(text.to_string()));
                    }
                }
            }
            Some("thinking_delta") => {
                if let (Some(acc), Some(t)) = (
                    entry.thinking.as_mut(),
                    delta.get("thinking").and_then(|x| x.as_str()),
                ) {
                    acc.text.push_str(t);
                }
            }
            Some("signature_delta") => {
                if let (Some(acc), Some(sig)) = (
                    entry.thinking.as_mut(),
                    delta.get("signature").and_then(|x| x.as_str()),
                ) {
                    acc.signature.push_str(sig);
                }
            }
            Some("input_json_delta") => {
                if let Some(partial) = delta.get("partial_json").and_then(|x| x.as_str()) {
                    if !partial.is_empty() {
                        entry.arguments.push_str(partial);
                        if entry.started {
                            sink(CompletionEvent::ToolCallArgsDelta {
                                id: entry.tool_id.clone(),
                                json_delta: partial.to_string(),
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn on_block_stop(&mut self, sink: &EventSink, v: &Value) {
        let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        if let Some(entry) = self.blocks.get(&idx) {
            if entry.is_tool && entry.started {
                sink(CompletionEvent::ToolCallEnd {
                    id: entry.tool_id.clone(),
                });
            }
        }
    }

    fn on_message_delta(&mut self, v: &Value) {
        if let Some(reason) = v.pointer("/delta/stop_reason").and_then(|x| x.as_str()) {
            self.finish_reason = match reason {
                "end_turn" => FinishReason::Stop,
                "tool_use" => FinishReason::ToolCalls,
                "max_tokens" => FinishReason::Length,
                "stop_sequence" => FinishReason::Stop,
                _ => FinishReason::Other,
            };
        }
        if let Some(usage) = v.get("usage") {
            self.usage = Some(merge_usage(self.usage.take(), usage));
        }
    }

    /// Completed thinking blocks in message order. A block without its
    /// signature (a stream cut short) can't be replayed and is dropped.
    fn thinking_blocks(&self) -> Vec<Value> {
        self.blocks
            .values()
            .filter_map(|e| e.thinking.as_ref())
            .filter_map(|t| {
                if t.redacted {
                    (!t.data.is_empty())
                        .then(|| json!({ "type": "redacted_thinking", "data": t.data }))
                } else {
                    (!t.signature.is_empty()).then(|| {
                        json!({ "type": "thinking", "thinking": t.text, "signature": t.signature })
                    })
                }
            })
            .collect()
    }

    fn into_tool_calls(self) -> Vec<ToolCall> {
        self.blocks
            .into_values()
            .filter(|e| e.is_tool && !e.tool_id.is_empty() && !e.tool_name.is_empty())
            .map(|e| ToolCall {
                id: e.tool_id,
                name: e.tool_name,
                arguments: if e.arguments.is_empty() {
                    "{}".to_string()
                } else {
                    e.arguments
                },
                thought_signature: None,
            })
            .collect()
    }
}

fn merge_usage(prev: Option<Usage>, raw: &Value) -> Usage {
    let mut u = prev.unwrap_or_default();
    if let Some(input) = raw.get("input_tokens").and_then(|x| x.as_u64()) {
        u.prompt_tokens = u.prompt_tokens.max(input as u32);
    }
    if let Some(output) = raw.get("output_tokens").and_then(|x| x.as_u64()) {
        u.completion_tokens = u.completion_tokens.max(output as u32);
    }
    u.total_tokens = u.prompt_tokens + u.completion_tokens;
    u
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolSchema;

    #[test]
    fn build_messages_handles_tool_round_trip() {
        let msgs = vec![
            ChatMessage {
                role: MessageRole::System,
                content: "You are helpful.".into(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::User,
                content: "List the pods".into(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Assistant,
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "call_1".into(),
                    name: "list_pods".into(),
                    arguments: "{\"namespace\":\"default\"}".into(),
                    thought_signature: None,
                }],
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Tool,
                content: "{\"pods\":[]}".into(),
                tool_call_id: Some("call_1".into()),
                ..Default::default()
            },
        ];
        let (sys, body) = build_messages(&msgs, true, true);
        assert_eq!(sys, "You are helpful.");
        assert_eq!(body.len(), 3);
        assert_eq!(body[0]["role"], "user");
        assert_eq!(body[1]["role"], "assistant");
        assert_eq!(body[1]["content"][0]["type"], "tool_use");
        assert_eq!(body[1]["content"][0]["input"]["namespace"], "default");
        assert_eq!(body[2]["role"], "user");
        assert_eq!(body[2]["content"][0]["type"], "tool_result");
        assert_eq!(body[2]["content"][0]["tool_use_id"], "call_1");
    }

    #[test]
    fn user_message_with_image_emits_image_block_when_vision_supported() {
        let msg = ChatMessage {
            role: MessageRole::User,
            content: "what is this?".into(),
            images: vec![crate::types::ImageAttachment {
                mime: "image/png".into(),
                data: "AAAA".into(),
            }],
            ..Default::default()
        };
        let (_sys, body) = build_messages(std::slice::from_ref(&msg), true, true);
        assert_eq!(body.len(), 1);
        let content = body[0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "what is this?");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "AAAA");
    }

    #[test]
    fn user_message_with_image_drops_to_note_when_vision_unsupported() {
        let msg = ChatMessage {
            role: MessageRole::User,
            content: "look".into(),
            images: vec![crate::types::ImageAttachment {
                mime: "image/png".into(),
                data: "AAAA".into(),
            }],
            ..Default::default()
        };
        let (_sys, body) = build_messages(std::slice::from_ref(&msg), false, true);
        let content = body[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        let text = content[0]["text"].as_str().unwrap();
        assert!(text.starts_with("look"));
        assert!(text.contains("does not support image input"));
    }

    #[test]
    fn sse_state_collects_text_and_tool_call() {
        // Mimic a transcript: text block, then tool_use block, then stop.
        let mut state = SseState::default();
        let events: std::sync::Arc<std::sync::Mutex<Vec<CompletionEvent>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_for_sink = events.clone();
        let sink: EventSink = Box::new(move |e| events_for_sink.lock().unwrap().push(e));

        state.on_block_start(
            &sink,
            &json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        );
        state.on_block_delta(
            &sink,
            &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}),
        );
        state.on_block_stop(&sink, &json!({"type":"content_block_stop","index":0}));
        state.on_block_start(
            &sink,
            &json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"do","input":{}}}),
        );
        state.on_block_delta(
            &sink,
            &json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}),
        );
        state.on_block_stop(&sink, &json!({"type":"content_block_stop","index":1}));
        state.on_message_delta(&json!({"delta":{"stop_reason":"tool_use"}}));

        let calls = state.into_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "tu_1");
        assert_eq!(calls[0].name, "do");
        assert_eq!(calls[0].arguments, "{\"a\":1}");

        let evs = events.lock().unwrap().clone();
        let token_seen = evs
            .iter()
            .any(|e| matches!(e, CompletionEvent::TokenDelta(t) if t == "hi"));
        let tool_start = evs
            .iter()
            .any(|e| matches!(e, CompletionEvent::ToolCallStart { id, .. } if id == "tu_1"));
        let tool_end = evs
            .iter()
            .any(|e| matches!(e, CompletionEvent::ToolCallEnd { id } if id == "tu_1"));
        assert!(token_seen && tool_start && tool_end);
    }

    // Silences the unused-import warning when `ToolSchema` ever stops
    // being referenced by the test; left in case future tests need it.
    #[allow(dead_code)]
    fn _unused(_: ToolSchema) {}

    // ─── thinking: budget fitting, capture, replay ──────────────────────────

    fn body_with(thinking: Value, max_tokens: u64) -> Value {
        json!({ "max_tokens": max_tokens, "temperature": 0.5, "top_k": 40, "thinking": thinking })
    }

    #[test]
    fn a_thinking_budget_gets_room_to_answer_and_never_shrinks_an_explicit_max() {
        // 32k budget under the old 8192 default would be a 400.
        let mut b = body_with(json!({ "type": "enabled", "budget_tokens": 32_768 }), 8_192);
        fit_thinking(&mut b, Some(64_000));
        assert_eq!(b["thinking"]["budget_tokens"], 32_768);
        assert_eq!(b["max_tokens"], 36_864);

        let mut big = body_with(
            json!({ "type": "enabled", "budget_tokens": 16_000 }),
            50_000,
        );
        fit_thinking(&mut big, Some(64_000));
        assert_eq!(big["max_tokens"], 50_000, "an explicit larger max is kept");
    }

    #[test]
    fn a_budget_is_floored_and_kept_under_the_models_output_limit() {
        let mut low = body_with(json!({ "type": "enabled", "budget_tokens": 100 }), 8_192);
        fit_thinking(&mut low, None);
        assert_eq!(low["thinking"]["budget_tokens"], 1_024);
        assert!(low["max_tokens"].as_u64().unwrap() > 1_024);

        let mut over = body_with(json!({ "type": "enabled", "budget_tokens": 32_768 }), 8_192);
        fit_thinking(&mut over, Some(16_000));
        assert_eq!(over["thinking"]["budget_tokens"], 14_976);
        assert_eq!(over["max_tokens"], 16_000);
        assert!(over["max_tokens"].as_u64() > over["thinking"]["budget_tokens"].as_u64());
    }

    #[test]
    fn thinking_on_drops_sampling_knobs_and_off_leaves_them() {
        let mut adaptive = body_with(json!({ "type": "adaptive" }), 8_192);
        fit_thinking(&mut adaptive, None);
        assert!(adaptive.get("temperature").is_none() && adaptive.get("top_k").is_none());
        assert_eq!(
            adaptive["max_tokens"], 8_192,
            "adaptive has no budget to fit"
        );

        let mut off = body_with(json!({ "type": "disabled" }), 8_192);
        fit_thinking(&mut off, None);
        assert_eq!(off["temperature"], 0.5);

        let mut none = json!({ "max_tokens": 8_192, "temperature": 0.5 });
        fit_thinking(&mut none, None);
        assert_eq!(none, json!({ "max_tokens": 8_192, "temperature": 0.5 }));
    }

    fn feed(events: &[Value]) -> SseState {
        let sink: EventSink = Box::new(|_| {});
        let mut st = SseState::default();
        for v in events {
            match v["type"].as_str().unwrap() {
                "content_block_start" => st.on_block_start(&sink, v),
                "content_block_delta" => st.on_block_delta(&sink, v),
                "content_block_stop" => st.on_block_stop(&sink, v),
                _ => {}
            }
        }
        st
    }

    #[test]
    fn thinking_blocks_are_captured_with_their_signatures_in_order() {
        let st = feed(&[
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me " } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "check." } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "SIG" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "redacted_thinking", "data": "OPAQUE" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "text", "text": "" } }),
        ]);
        assert_eq!(
            st.thinking_blocks(),
            vec![
                json!({ "type": "thinking", "thinking": "Let me check.", "signature": "SIG" }),
                json!({ "type": "redacted_thinking", "data": "OPAQUE" }),
            ]
        );
    }

    #[test]
    fn a_thinking_block_cut_off_before_its_signature_is_not_replayable() {
        let st = feed(&[
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "half" } }),
        ]);
        assert!(st.thinking_blocks().is_empty());
    }

    #[test]
    fn thinking_blocks_lead_the_assistant_turn_when_replayed() {
        let blocks = vec![json!({ "type": "thinking", "thinking": "t", "signature": "S" })];
        let msgs = vec![
            ChatMessage {
                role: MessageRole::User,
                content: "go".into(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Assistant,
                content: "checking".into(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "t".into(),
                    arguments: "{}".into(),
                    thought_signature: None,
                }],
                thinking_blocks: blocks.clone(),
                ..Default::default()
            },
        ];
        let (_s, with) = build_messages(&msgs, true, true);
        let content = with[1]["content"].as_array().unwrap();
        assert_eq!(content[0], blocks[0]);
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[2]["type"], "tool_use");

        let (_s, without) = build_messages(&msgs, true, false);
        assert_eq!(without[1]["content"][0]["type"], "text");
    }

    fn thinking_sse() -> String {
        let events = [
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 5, "output_tokens": 0 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hmm" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "SIG-1" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "list_pods" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"namespace\":\"demo\"}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 9 } }),
            json!({ "type": "message_stop" }),
        ];
        crate::provider::test_util::sse_response(&events)
    }

    fn provider_at(base: String, kind: ProviderKind) -> AnthropicProvider {
        AnthropicProvider::new(&Credential::ApiKey { key: "k".into() }, Some(base), kind)
    }

    fn req(model: &str, opts: Option<Value>, messages: Vec<ChatMessage>) -> CompletionRequest {
        CompletionRequest {
            model: model.into(),
            messages,
            tools: vec![],
            temperature: Some(0.7),
            max_tokens: None,
            provider_options: opts,
        }
    }

    #[tokio::test]
    async fn a_thinking_turn_round_trips_its_blocks_and_fits_the_request() {
        use crate::provider::test_util::serve_at;
        let (base, log) = serve_at("/v1", vec![thinking_sse(), thinking_sse()]).await;
        let p = provider_at(base, ProviderKind::Anthropic);
        let sink = || -> EventSink { Box::new(|_| {}) };

        // Turn 1: budget thinking. The request must satisfy max_tokens > budget
        // and carry no temperature.
        let opts = json!({ "thinking": { "type": "enabled", "budget_tokens": 16_000 } });
        let first = p
            .stream_completion(
                req(
                    "claude-haiku-4-5",
                    Some(opts.clone()),
                    vec![ChatMessage {
                        role: MessageRole::User,
                        content: "go".into(),
                        ..Default::default()
                    }],
                ),
                sink(),
            )
            .await
            .unwrap();
        assert_eq!(
            first.thinking_blocks,
            vec![json!({ "type": "thinking", "thinking": "hmm", "signature": "SIG-1" })]
        );
        assert_eq!(first.tool_calls[0].name, "list_pods");

        // Turn 2: the assistant turn is replayed with its thinking block first.
        let history = vec![
            ChatMessage {
                role: MessageRole::User,
                content: "go".into(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Assistant,
                tool_calls: first.tool_calls.clone(),
                thinking_blocks: first.thinking_blocks.clone(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Tool,
                content: "web-1 Running".into(),
                tool_call_id: Some(first.tool_calls[0].id.clone()),
                ..Default::default()
            },
        ];
        p.stream_completion(req("claude-haiku-4-5", Some(opts), history), sink())
            .await
            .unwrap();

        let sent = log.lock().unwrap();
        let one: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(
            one["thinking"],
            json!({ "type": "enabled", "budget_tokens": 16_000 })
        );
        assert!(one["max_tokens"].as_u64().unwrap() > 16_000, "{one}");
        assert!(one.get("temperature").is_none(), "{one}");
        let two: Value = serde_json::from_str(&sent[1].body).unwrap();
        assert_eq!(two["messages"][1]["content"][0]["type"], "thinking");
        assert_eq!(two["messages"][1]["content"][0]["signature"], "SIG-1");
        assert_eq!(two["messages"][1]["content"][1]["type"], "tool_use");
    }

    #[tokio::test]
    async fn adaptive_thinking_sends_effort_in_output_config() {
        use crate::provider::test_util::serve_at;
        let (base, log) = serve_at("/v1", vec![thinking_sse()]).await;
        let p = provider_at(base, ProviderKind::Anthropic);
        let opts =
            json!({ "thinking": { "type": "adaptive" }, "output_config": { "effort": "xhigh" } });
        p.stream_completion(
            req(
                "claude-sonnet-5-5",
                Some(opts),
                vec![ChatMessage {
                    role: MessageRole::User,
                    content: "go".into(),
                    ..Default::default()
                }],
            ),
            Box::new(|_| {}),
        )
        .await
        .unwrap();
        let body: Value = serde_json::from_str(&log.lock().unwrap()[0].body).unwrap();
        assert_eq!(body["thinking"], json!({ "type": "adaptive" }));
        assert_eq!(body["output_config"]["effort"], "xhigh");
        assert!(body.get("temperature").is_none());
    }

    #[tokio::test]
    async fn kimi_coding_neither_captures_nor_replays_thinking_blocks() {
        use crate::provider::test_util::serve_at;
        let (base, _log) = serve_at("/v1", vec![thinking_sse()]).await;
        let p = provider_at(base, ProviderKind::KimiCoding);
        let out = p
            .stream_completion(
                req(
                    "kimi-for-coding",
                    None,
                    vec![ChatMessage {
                        role: MessageRole::User,
                        content: "go".into(),
                        ..Default::default()
                    }],
                ),
                Box::new(|_| {}),
            )
            .await
            .unwrap();
        assert!(out.thinking_blocks.is_empty());
    }
}
