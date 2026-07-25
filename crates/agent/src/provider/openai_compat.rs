//! Generic OpenAI-compatible chat-completions provider. Used by every
//! provider whose default wire is OpenAI's `/chat/completions` SSE: the
//! OpenAI key path, OpenRouter, Z.AI, MiniMax, Groq, DeepSeek, Mistral,
//! Together, and Ollama (local). Per-provider quirks (auth header style,
//! attribution headers, default models endpoint) come from
//! [`crate::provider::meta`].

use super::{
    dropped_images_note, merge_top_level, ChatProvider, CompletionEvent, CompletionFinal,
    CompletionRequest, EventSink, FinishReason, ModelInfo, ProviderError, Usage,
};
use crate::config::{Credential, ProviderKind};
use crate::provider::catalogue;
use crate::provider::meta::{self, ModelsEndpoint, ProviderMeta};
use crate::types::{ChatMessage, MessageRole, ToolCall};
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

/// Header style for the `Authorization` slot. Anthropic is the only one
/// that uses `x-api-key` instead of a Bearer token; everyone else takes
/// `Authorization: Bearer …`.
#[derive(Debug, Clone, Copy)]
enum AuthHeaderStyle {
    Bearer,
    /// Used when the operator left the API-key field blank (Ollama
    /// supports anonymous local access). No auth header is sent.
    None,
}

pub struct OpenAICompatibleProvider {
    client: reqwest::Client,
    base_url: String,
    auth_value: Option<String>,
    auth_style: AuthHeaderStyle,
    extra_headers: Vec<(&'static str, String)>,
    name: &'static str,
    kind: ProviderKind,
    models_endpoint: ModelsEndpoint,
    /// Stable identifier the provider passes through as a prompt-caching
    /// key (OpenRouter's `prompt_cache_key`). `None` ⇒ caching disabled.
    /// Populated from the FerrisScope chat session id.
    session_id: Option<String>,
}

impl OpenAICompatibleProvider {
    /// Build a provider for `kind` using `cred`. `base_url_override` lets
    /// the operator point at a proxy or self-hosted gateway; pass `None`
    /// to use the canonical default from [`meta::for_kind`].
    pub fn for_kind(
        kind: ProviderKind,
        cred: &Credential,
        base_url_override: Option<String>,
        session_id: Option<String>,
    ) -> Self {
        let m: &ProviderMeta = meta::for_kind(kind);
        let key = match cred {
            Credential::ApiKey { key } => key.trim().to_string(),
            // OAuth-only providers go through their dedicated impls;
            // if an OAuth credential reaches here it's a programmer
            // error, but we still degrade gracefully by sending no
            // auth header rather than panicking.
            Credential::OAuth { access, .. } => access.clone(),
        };
        let (auth_value, auth_style) = if key.is_empty() {
            (None, AuthHeaderStyle::None)
        } else {
            (Some(format!("Bearer {key}")), AuthHeaderStyle::Bearer)
        };

        let mut extra_headers: Vec<(&'static str, String)> = Vec::new();
        if matches!(kind, ProviderKind::OpenRouter) {
            // OpenRouter uses these to attribute usage in the operator's
            // dashboard. Harmless for everyone else but we only send
            // them when actually talking to OpenRouter. Names must be
            // lowercase — `HeaderName::from_static` panics on uppercase
            // bytes; HTTP itself treats header names case-insensitively
            // so this changes nothing on the wire.
            extra_headers.push((
                "http-referer",
                "https://github.com/dzcorp/FerrisScope".into(),
            ));
            extra_headers.push(("x-title", "FerrisScope".into()));
        }

        Self {
            client: reqwest::Client::builder()
                // Generous timeouts: SSE streams can run hundreds of
                // seconds for long completions. No automatic retries —
                // the user re-sends.
                .connect_timeout(std::time::Duration::from_mins(1))
                .timeout(std::time::Duration::from_mins(10))
                .build()
                .expect("reqwest client"),
            base_url: base_url_override
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| m.default_base_url.to_string()),
            auth_value,
            auth_style,
            extra_headers,
            name: m.id,
            kind,
            models_endpoint: m.models_endpoint,
            session_id,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        if let (AuthHeaderStyle::Bearer, Some(v)) = (self.auth_style, self.auth_value.as_deref()) {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(v) {
                h.insert(reqwest::header::AUTHORIZATION, value);
            }
        }
        for (name, value) in &self.extra_headers {
            let n = reqwest::header::HeaderName::from_static(name);
            if let Ok(v) = reqwest::header::HeaderValue::from_str(value) {
                h.insert(n, v);
            }
        }
        h
    }

    /// Fetch the provider's live model list from its OpenAI-compatible
    /// `GET /models` endpoint. The freshest source when available;
    /// `list_models` falls back to the models.dev catalogue / static list
    /// when this errors or returns nothing.
    async fn fetch_live_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let resp = self
            .client
            .get(self.url("/models"))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| ProviderError::transport(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::from_http_status(status, body));
        }
        let parsed: OaModelsResponse = resp
            .json()
            .await
            .map_err(|e| ProviderError::Decode(e.to_string()))?;
        Ok(parsed
            .data
            .into_iter()
            .map(|m| ModelInfo {
                id: m.id,
                name: m.name,
                context_length: m.context_length,
            })
            .collect())
    }

    /// The curated per-provider static model list — the offline / cold-start
    /// fallback used when neither the live endpoint nor models.dev yield
    /// anything.
    fn static_models(&self) -> Vec<ModelInfo> {
        meta::static_models(self.kind)
            .iter()
            .map(|(id, name)| ModelInfo {
                id: (*id).to_string(),
                name: Some((*name).to_string()),
                context_length: None,
            })
            .collect()
    }
}

// ─── OpenAI-compatible request/response shapes (subset we need) ─────────────

fn role_str(r: MessageRole) -> &'static str {
    match r {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

/// Convert a neutral `ChatMessage` to OpenAI's wire shape. `interleaved`
/// names the per-model round-trip field (typically "reasoning_content")
/// from models.dev — when set, every assistant message in the request
/// body must carry it (empty string when the message has no captured
/// reasoning) or DeepSeek-family backends 400. `supports_vision` gates
/// whether user-message image attachments are emitted as `image_url`
/// content parts (which forces the array content form) or dropped with a
/// note folded into the text.
fn message_to_oa(m: &ChatMessage, interleaved: Option<&str>, supports_vision: bool) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("role".to_string(), Value::String(role_str(m.role).into()));
    let user_with_images = matches!(m.role, MessageRole::User) && !m.images.is_empty();
    if user_with_images && supports_vision {
        // Multimodal user turn: content is an array of typed parts. OpenAI
        // (and every vision-capable compat backend) takes images as a
        // data-URI under `image_url.url`.
        let mut parts: Vec<Value> = Vec::new();
        if !m.content.is_empty() {
            parts.push(json!({ "type": "text", "text": m.content }));
        }
        for img in &m.images {
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) },
            }));
        }
        obj.insert("content".to_string(), Value::Array(parts));
    } else if user_with_images {
        // Vision-incapable model: keep the text, fold in a note so the
        // model knows an image was attached, never send `image_url`.
        let text = dropped_images_note(&m.content, m.images.len());
        obj.insert("content".to_string(), Value::String(text));
    } else if !m.content.is_empty() {
        obj.insert("content".to_string(), Value::String(m.content.clone()));
    }
    if let Some(name) = &m.name {
        obj.insert("name".to_string(), Value::String(name.clone()));
    }
    if let Some(tcid) = &m.tool_call_id {
        obj.insert("tool_call_id".to_string(), Value::String(tcid.clone()));
    }
    if !m.tool_calls.is_empty() {
        obj.insert(
            "tool_calls".to_string(),
            json!(m
                .tool_calls
                .iter()
                .map(|tc| json!({
                    "id": tc.id,
                    "type": "function",
                    "function": { "name": tc.name, "arguments": tc.arguments },
                }))
                .collect::<Vec<_>>()),
        );
    }
    // Round-trip the assistant's reasoning text. Required for DeepSeek
    // (and any opencode-zen route that proxies to it — `big-pickle` et
    // al). Always set the field once interleaved is in play, even when
    // empty: opencode's transform.ts does the same — DeepSeek expects
    // every assistant message in the history to declare it.
    if matches!(m.role, MessageRole::Assistant) {
        if let Some(field) = interleaved {
            let value = m.reasoning_content.clone().unwrap_or_default();
            obj.insert(field.to_string(), Value::String(value));
        }
    }
    Value::Object(obj)
}

#[derive(Debug, Deserialize)]
struct OaModelsResponse {
    data: Vec<OaModel>,
}

#[derive(Debug, Deserialize)]
struct OaModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OaStreamEvent {
    #[serde(default)]
    choices: Vec<OaStreamChoice>,
    #[serde(default)]
    usage: Option<OaUsage>,
    /// Mid-stream error payload (`{"error":{code,message}}` on an HTTP
    /// 200). OpenAI-compat gateways deliver some failures this way —
    /// without reading it, the stream looks like a clean-but-empty
    /// completion and the caller retries a hard error in a loop.
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct OaStreamChoice {
    #[serde(default)]
    delta: OaDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OaDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OaToolCallDelta>>,
    /// DeepSeek / Big Pickle / GLM-4.x stream "thinking" tokens here
    /// alongside the user-visible `content`. We accumulate it so the
    /// next request can pass it back as a top-level message field —
    /// without that, DeepSeek 400s on the next turn.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// Other interleaved-thinking vendors stream the same payload under
    /// `reasoning_details` instead. Captured the same way; round-trip
    /// uses the field name from models.dev.
    #[serde(default)]
    reasoning_details: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OaToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<OaFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct OaFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[allow(clippy::struct_field_names)]
struct OaUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
}

// ─── ChatProvider impl ──────────────────────────────────────────────────────

#[async_trait]
impl ChatProvider for OpenAICompatibleProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        match self.models_endpoint {
            ModelsEndpoint::OpenAiCompatible => {
                // Live `/models` is the freshest source (OpenRouter alone
                // ships hundreds, updated constantly). On failure or an
                // empty list, fall back to the models.dev catalogue, then
                // the static list. Only surface the live error when we
                // have nothing at all to show.
                let live = self.fetch_live_models().await;
                if let Ok(list) = &live {
                    if !list.is_empty() {
                        return Ok(live.unwrap_or_default());
                    }
                }
                let cat = catalogue::list_models(self.kind);
                if !cat.is_empty() {
                    return Ok(cat);
                }
                match live {
                    // Live succeeded but was empty — surface the empty list
                    // rather than an error (the provider genuinely has none
                    // reachable, or the catalogue simply isn't loaded).
                    Ok(list) => Ok(list),
                    Err(e) => {
                        let fallback = self.static_models();
                        if fallback.is_empty() {
                            Err(e)
                        } else {
                            Ok(fallback)
                        }
                    }
                }
            }
            ModelsEndpoint::Static | ModelsEndpoint::AnthropicCatalogue => {
                // No enumerable live endpoint (Z.AI, MiniMax; AnthropicCatalogue
                // only lands here on a mis-wire). models.dev is the source of
                // truth; the static list is the offline / not-yet-loaded
                // fallback so the picker is never empty on a cold start.
                let cat = catalogue::list_models(self.kind);
                if cat.is_empty() {
                    Ok(self.static_models())
                } else {
                    Ok(cat)
                }
            }
        }
    }

    async fn stream_completion(
        &self,
        req: CompletionRequest,
        sink: EventSink,
    ) -> Result<CompletionFinal, ProviderError> {
        // Per-model capability gates from models.dev. Drives whether to
        // emit `temperature` (some Codex-tier models 400 on it), whether
        // to send tool schemas at all (`tool_call: false` models reject
        // them), and the round-trip slot for interleaved reasoning.
        let caps = catalogue::capabilities(self.kind, &req.model);
        let interleaved = caps.as_ref().and_then(|c| c.interleaved_field.clone());
        let supports_temperature = caps.as_ref().is_none_or(|c| c.temperature);
        let supports_tools = caps.as_ref().is_none_or(|c| c.tool_call);
        // Unknown models (no catalogue entry) default to "try it" — only
        // drop images when models.dev positively marks the model text-only.
        let supports_vision = caps.as_ref().is_none_or(|c| c.vision);

        let oa_messages: Vec<Value> = req
            .messages
            .iter()
            .map(|m| message_to_oa(m, interleaved.as_deref(), supports_vision))
            .collect();

        let mut body = json!({
            "model": req.model,
            "messages": oa_messages,
            "stream": true,
        });
        if supports_temperature {
            if let Some(t) = req.temperature {
                body["temperature"] = json!(t);
            }
        }
        if let Some(m) = req.max_tokens {
            body["max_tokens"] = json!(m);
        }
        if supports_tools && !req.tools.is_empty() {
            body["tools"] = json!(req
                .tools
                .iter()
                .map(|t| json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }))
                .collect::<Vec<_>>());
        }

        // OpenRouter-only enhancements. `usage.include` makes the SSE
        // emit detailed token-usage events; `prompt_cache_key` keys the
        // server-side prompt cache off the chat session so multi-turn
        // conversations hit it. Both are no-ops elsewhere — sending
        // them to a vanilla OpenAI endpoint would be ignored — but we
        // still gate to avoid surprising other vendors with extra
        // fields that some implementations reject.
        if matches!(self.kind, ProviderKind::OpenRouter) {
            body["usage"] = json!({ "include": true });
            if let Some(sid) = &self.session_id {
                body["prompt_cache_key"] = json!(sid);
            }
        }

        // Vendor-specific overrides last, so the operator can clobber
        // anything we set above. Top-level keys merge shallowly: a
        // `temperature` here wins over the one we computed; a `tools`
        // here replaces our list (operator's responsibility).
        if let Some(opts) = &req.provider_options {
            merge_top_level(&mut body, opts);
        }

        // Capability gating after the merge. If models.dev marks the
        // model as non-reasoning, scrub `reasoning_effort` / `reasoning`
        // even when the caller (or operator) supplied them — non-
        // reasoning OpenAI-compat models reject these fields with 400
        // (deepseek-chat being the canonical example). Done here rather
        // than upstream so operator overrides go through the same gate
        // as our auto-derived defaults.
        let supports_reasoning = caps.as_ref().is_none_or(|c| c.reasoning);
        if !supports_reasoning {
            if let Some(obj) = body.as_object_mut() {
                obj.remove("reasoning_effort");
                obj.remove("reasoning");
                obj.remove("thinking");
            }
        }

        let resp = self
            .client
            .post(self.url("/chat/completions"))
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

        let mut stream = resp.bytes_stream().eventsource();
        let mut accum: ToolCallAccum = ToolCallAccum::default();
        let mut finish_reason = FinishReason::Stop;
        let mut usage: Option<Usage> = None;
        let mut reasoning_buf = String::new();

        while let Some(ev) = stream.next().await {
            let ev = ev.map_err(|e| ProviderError::Decode(e.to_string()))?;
            // OpenAI's SSE termination sentinel.
            if ev.data.trim() == "[DONE]" {
                break;
            }
            let parsed: OaStreamEvent = match serde_json::from_str(&ev.data) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(error = %e, provider = self.name, "skipping unparseable SSE chunk");
                    continue;
                }
            };

            // In-stream error payload — fail the round with the raw body
            // so the classifier sees the vendor code (status: None is
            // deliberate; the HTTP status was 200).
            if let Some(err) = parsed.error {
                let code = err.get("code").and_then(|x| x.as_str()).unwrap_or("");
                let msg = err.get("message").and_then(|x| x.as_str()).unwrap_or("");
                return Err(ProviderError::Http {
                    status: None,
                    body: if code.is_empty() && msg.is_empty() {
                        ev.data.clone()
                    } else {
                        format!("{code}: {msg}")
                    },
                });
            }

            for choice in parsed.choices {
                if let Some(text) = choice.delta.content {
                    if !text.is_empty() {
                        sink(CompletionEvent::TokenDelta(text));
                    }
                }
                // Interleaved-thinking deltas. We don't surface them to
                // the UI as tokens (operators see the model's prose, not
                // its scratch pad) but we do accumulate so the next
                // request can echo them back — DeepSeek 400s otherwise.
                if let Some(text) = choice.delta.reasoning_content {
                    if !text.is_empty() {
                        reasoning_buf.push_str(&text);
                    }
                }
                if let Some(text) = choice.delta.reasoning_details {
                    if !text.is_empty() {
                        reasoning_buf.push_str(&text);
                    }
                }
                if let Some(tcs) = choice.delta.tool_calls {
                    for tc in tcs {
                        accum.apply(&sink, tc);
                    }
                }
                if let Some(fr) = choice.finish_reason {
                    finish_reason = match fr.as_str() {
                        "stop" => FinishReason::Stop,
                        "tool_calls" => FinishReason::ToolCalls,
                        "length" => FinishReason::Length,
                        "content_filter" => FinishReason::ContentFilter,
                        _ => FinishReason::Other,
                    };
                }
            }

            if let Some(u) = parsed.usage {
                usage = Some(Usage {
                    prompt_tokens: u.prompt_tokens,
                    completion_tokens: u.completion_tokens,
                    total_tokens: u.total_tokens,
                });
            }
        }

        let tool_calls = accum.finish(&sink);
        // Only carry reasoning through to the assistant message when the
        // model actually wants it on the round-trip. For non-interleaved
        // models we'd just be padding the persisted transcript.
        let reasoning_content = if interleaved.is_some() {
            Some(reasoning_buf)
        } else if reasoning_buf.is_empty() {
            None
        } else {
            // Catalogue hadn't loaded yet but the wire says reasoning is
            // in play — keep it; round-trip is harmless on backends that
            // ignore the field, and the lookup will populate on next
            // request once the catalogue refreshes.
            Some(reasoning_buf)
        };
        Ok(CompletionFinal {
            finish_reason,
            tool_calls,
            usage,
            reasoning_content,
        })
    }
}

/// Reassembles streamed tool-call deltas into complete `ToolCall` records.
/// OpenAI sends each tool call as a series of partial JSON fragments
/// keyed by `index`; the `id` and `name` arrive on the first chunk and
/// the arguments are concatenated across chunks.
#[derive(Default)]
struct ToolCallAccum {
    by_index: std::collections::BTreeMap<u32, AccumEntry>,
    /// Tracks which indexes we've already emitted a `ToolCallStart` for
    /// so downstream consumers see exactly one start event per call.
    started: std::collections::BTreeSet<u32>,
}

#[derive(Default)]
struct AccumEntry {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAccum {
    fn apply(&mut self, sink: &EventSink, delta: OaToolCallDelta) {
        let idx = delta.index.unwrap_or(0);
        let entry = self.by_index.entry(idx).or_default();
        if let Some(id) = delta.id {
            if !id.is_empty() && entry.id.is_empty() {
                entry.id = id;
            }
        }
        if let Some(func) = delta.function {
            if let Some(name) = func.name {
                if !name.is_empty() && entry.name.is_empty() {
                    entry.name = name;
                }
            }
            if !self.started.contains(&idx) && !entry.id.is_empty() && !entry.name.is_empty() {
                sink(CompletionEvent::ToolCallStart {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                });
                self.started.insert(idx);
            }
            if let Some(args) = func.arguments {
                if !args.is_empty() {
                    entry.arguments.push_str(&args);
                    if let Some(id) = self.started.contains(&idx).then(|| entry.id.clone()) {
                        sink(CompletionEvent::ToolCallArgsDelta {
                            id,
                            json_delta: args,
                        });
                    }
                }
            }
        }
    }

    fn finish(self, sink: &EventSink) -> Vec<ToolCall> {
        let started = self.started;
        self.by_index
            .into_iter()
            .filter_map(|(idx, e)| {
                if e.id.is_empty() || e.name.is_empty() {
                    return None;
                }
                if started.contains(&idx) {
                    sink(CompletionEvent::ToolCallEnd { id: e.id.clone() });
                }
                Some(ToolCall {
                    id: e.id,
                    name: e.name,
                    arguments: e.arguments,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ChatMessage;

    #[test]
    fn assistant_message_with_interleaved_field_carries_reasoning_content() {
        let msg = ChatMessage {
            role: MessageRole::Assistant,
            content: "hi".into(),
            reasoning_content: Some("step 1; step 2".into()),
            ..Default::default()
        };
        let v = message_to_oa(&msg, Some("reasoning_content"), true);
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["content"], "hi");
        assert_eq!(v["reasoning_content"], "step 1; step 2");
    }

    #[test]
    fn assistant_message_with_interleaved_emits_empty_string_when_missing() {
        // DeepSeek expects every assistant message in the history to
        // declare the field — even when the message had no reasoning
        // (e.g. an old transcript persisted before we started capturing).
        let msg = ChatMessage {
            role: MessageRole::Assistant,
            content: "hi".into(),
            reasoning_content: None,
            ..Default::default()
        };
        let v = message_to_oa(&msg, Some("reasoning_content"), true);
        assert_eq!(v["reasoning_content"], "");
    }

    #[test]
    fn user_message_never_carries_reasoning_content() {
        let msg = ChatMessage {
            role: MessageRole::User,
            content: "hi".into(),
            ..Default::default()
        };
        let v = message_to_oa(&msg, Some("reasoning_content"), true);
        assert!(v.get("reasoning_content").is_none());
    }

    #[test]
    fn no_interleaved_field_omits_reasoning_content() {
        let msg = ChatMessage {
            role: MessageRole::Assistant,
            content: "hi".into(),
            reasoning_content: Some("noise".into()),
            ..Default::default()
        };
        let v = message_to_oa(&msg, None, true);
        assert!(v.get("reasoning_content").is_none());
        assert!(v.get("reasoning_details").is_none());
    }

    #[test]
    fn user_message_with_image_uses_array_content_with_image_url() {
        let msg = ChatMessage {
            role: MessageRole::User,
            content: "describe".into(),
            images: vec![crate::types::ImageAttachment {
                mime: "image/jpeg".into(),
                data: "Zm9v".into(),
            }],
            ..Default::default()
        };
        let v = message_to_oa(&msg, None, true);
        let parts = v["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "describe");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/jpeg;base64,Zm9v");
    }

    #[test]
    fn user_message_with_image_drops_to_string_note_when_vision_unsupported() {
        let msg = ChatMessage {
            role: MessageRole::User,
            content: "describe".into(),
            images: vec![crate::types::ImageAttachment {
                mime: "image/jpeg".into(),
                data: "Zm9v".into(),
            }],
            ..Default::default()
        };
        let v = message_to_oa(&msg, None, false);
        let content = v["content"].as_str().unwrap();
        assert!(content.starts_with("describe"));
        assert!(content.contains("does not support image input"));
    }

    #[tokio::test]
    async fn static_kind_falls_back_to_static_models_when_catalogue_empty() {
        // Z.AI has no enumerable live endpoint. With the models.dev
        // catalogue unloaded (the default in a unit test — nothing seeds
        // the global slot), list_models must return the curated static
        // list rather than an empty picker. No network is touched: the
        // Static branch never calls the live `/models` endpoint.
        use crate::config::{Credential, ProviderKind};
        // Building a reqwest client needs a process-global rustls crypto
        // provider; main.rs installs it in the app, tests install it here.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let p = OpenAICompatibleProvider::for_kind(
            ProviderKind::Zai,
            &Credential::ApiKey { key: "x".into() },
            None,
            None,
        );
        let models = p.list_models().await.expect("static fallback");
        assert!(!models.is_empty());
        let static_ids: std::collections::HashSet<&str> = meta::static_models(ProviderKind::Zai)
            .iter()
            .map(|(id, _)| *id)
            .collect();
        assert!(models.iter().all(|m| static_ids.contains(m.id.as_str())));
    }
}
