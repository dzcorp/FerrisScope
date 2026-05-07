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
    merge_top_level, ChatProvider, CompletionEvent, CompletionFinal, CompletionRequest, EventSink,
    FinishReason, ModelInfo, ProviderError, Usage,
};
use crate::config::Credential;
use crate::provider::meta::{self, ProviderMeta};
use crate::types::{ChatMessage, MessageRole, ToolCall};
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl AnthropicProvider {
    pub fn new(cred: &Credential, base_url_override: Option<String>) -> Self {
        let m: &ProviderMeta = meta::for_kind(crate::config::ProviderKind::Anthropic);
        let key = match cred {
            Credential::ApiKey { key } => key.trim().to_string(),
            // OAuth path is out of scope; if it gets here, send the
            // access token as the key. Server will reject with 401 and
            // we surface it cleanly.
            Credential::OAuth { access, .. } => access.clone(),
        };
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(60))
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .expect("reqwest client"),
            base_url: base_url_override
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| m.default_base_url.to_string()),
            api_key: key,
        }
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
        h
    }
}

// ─── Request body construction ──────────────────────────────────────────────

/// Convert the agent's neutral `Vec<ChatMessage>` into Anthropic's
/// `(system: String, messages: [...] )` shape. System messages collapse
/// into the top-level `system` field; assistant tool_calls become
/// `tool_use` content blocks; `Tool` role messages become a `user`
/// message containing a `tool_result` block (Anthropic's protocol uses
/// `user` with `tool_result` blocks rather than a dedicated tool role).
fn build_messages(messages: &[ChatMessage]) -> (String, Vec<Value>) {
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
                    "content": [{ "type": "text", "text": m.content }],
                }));
            }
            MessageRole::Assistant => {
                let mut blocks: Vec<Value> = Vec::new();
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
        "anthropic"
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
        Ok(meta::static_models(crate::config::ProviderKind::Anthropic)
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
        let (system, messages) = build_messages(&req.messages);

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            // Anthropic requires max_tokens. Default to a generous
            // ceiling so the model isn't artificially clipped; the
            // operator can override per-chat from the chat header.
            "max_tokens": req.max_tokens.unwrap_or(8192),
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

        let resp = self
            .client
            .post(self.url("/messages"))
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(if status == reqwest::StatusCode::UNAUTHORIZED {
                ProviderError::Auth(body)
            } else {
                ProviderError::Http(format!("{status}: {body}"))
            });
        }

        let mut stream = resp.bytes_stream().eventsource();
        let mut state = SseState::default();

        while let Some(ev) = stream.next().await {
            let ev = ev.map_err(|e| ProviderError::Decode(e.to_string()))?;
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
                _ => {}
            }
        }

        let finish_reason = state.finish_reason;
        let usage = state.usage.clone();
        let tool_calls = state.into_tool_calls();
        Ok(CompletionFinal {
            finish_reason,
            tool_calls,
            usage,
            // Anthropic uses Messages-API thinking blocks, not the
            // OpenAI-compat round-trip slot — no reasoning to echo back
            // here.
            reasoning_content: None,
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
        let (sys, body) = build_messages(&msgs);
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
}
