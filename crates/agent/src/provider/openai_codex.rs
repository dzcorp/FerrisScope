//! OpenAI Codex (ChatGPT Pro/Plus) provider.
//!
//! Operators authenticate by signing into ChatGPT in their browser and
//! granting our OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`, the
//! well-known Codex client also used by `opencode`). The resulting
//! tokens are stored as a [`Credential::OAuth`] and surface here as the
//! `access` / `refresh` pair the provider uses to talk to the **Codex
//! Responses endpoint** at `https://chatgpt.com/backend-api/codex/responses`.
//!
//! Wire-shape differences from plain OpenAI Chat Completions:
//! - Request body uses an `input: [...]` array of typed items (messages
//!   plus `function_call` / `function_call_output` entries) instead of
//!   `messages`.
//! - SSE event types are `response.output_item.added`,
//!   `response.output_text.delta`,
//!   `response.function_call_arguments.delta`,
//!   `response.function_call_arguments.done`, `response.completed`.
//! - Headers `originator: ferrisscope`, `session_id: …`,
//!   `ChatGPT-Account-Id: <accountId>`, plus `Authorization: Bearer
//!   <access>`.
//!
//! Token refresh: on a 401 we POST to `https://auth.openai.com/oauth/token`
//! with `grant_type=refresh_token`, write the fresh credential back via
//! the caller-supplied [`CredentialSink`], and retry the request once.
//! Subsequent 401s surface as `ProviderError::Auth`.

use super::{
    merge_top_level, ChatProvider, CompletionEvent, CompletionFinal, CompletionRequest, EventSink,
    FinishReason, ModelInfo, ProviderError, Usage,
};
use crate::config::Credential;
use crate::provider::meta;
use crate::types::{ChatMessage, MessageRole, ToolCall};
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const CODEX_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
const ORIGINATOR: &str = "ferrisscope";

/// Callback invoked after a successful token refresh. The app crate
/// supplies a closure that writes the new credential back to the
/// keychain so the next chat turn picks it up automatically.
pub type CredentialSink = Arc<dyn Fn(Credential) + Send + Sync>;

/// Mutable-shared OAuth state. The provider holds it under a `Mutex` so
/// concurrent stream calls observe a coherent view across refresh.
struct OauthState {
    access: String,
    refresh: String,
    expires_at_unix_ms: i64,
    account_id: Option<String>,
}

pub struct OpenAICodexProvider {
    client: reqwest::Client,
    oauth: Arc<Mutex<OauthState>>,
    /// Callback invoked after a successful refresh so the caller can
    /// persist the rotated credential. `None` is allowed (refresh still
    /// happens; just isn't written back).
    on_refresh: Option<CredentialSink>,
    /// Frontend-supplied session id, mirrored into the `session_id`
    /// header. Codex requires it for billing / abuse-tracking.
    session_id: Option<String>,
    /// User-Agent we send. Bumped from a constant rather than
    /// `tauri::AppHandle::package_info` so the Tauri-free crate stays
    /// Tauri-free.
    user_agent: String,
}

impl OpenAICodexProvider {
    pub fn new(
        cred: &Credential,
        session_id: Option<String>,
        on_refresh: Option<CredentialSink>,
    ) -> Self {
        let (access, refresh, expires_at_unix_ms, account_id) = match cred {
            Credential::OAuth {
                access,
                refresh,
                expires_at_unix_ms,
                account_id,
            } => (
                access.clone(),
                refresh.clone(),
                *expires_at_unix_ms,
                account_id.clone(),
            ),
            // API-key path doesn't reach the Codex endpoint. Construct
            // an empty state so a misuse fails loudly with 401 rather
            // than silently behaves like an unauthenticated request.
            Credential::ApiKey { key } => (key.clone(), String::new(), 0, None),
        };
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(60))
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .expect("reqwest client"),
            oauth: Arc::new(Mutex::new(OauthState {
                access,
                refresh,
                expires_at_unix_ms,
                account_id,
            })),
            on_refresh,
            session_id,
            user_agent: format!(
                "ferrisscope/{} ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
            ),
        }
    }

    async fn auth_headers(&self) -> reqwest::header::HeaderMap {
        let g = self.oauth.lock().await;
        let mut h = reqwest::header::HeaderMap::new();
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", g.access)) {
            h.insert(reqwest::header::AUTHORIZATION, v);
        }
        if let Some(account) = &g.account_id {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(account) {
                h.insert("ChatGPT-Account-Id", v);
            }
        }
        h.insert(
            "originator",
            reqwest::header::HeaderValue::from_static(ORIGINATOR),
        );
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&self.user_agent) {
            h.insert(reqwest::header::USER_AGENT, v);
        }
        if let Some(sid) = &self.session_id {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(sid) {
                h.insert("session_id", v);
            }
        }
        h
    }

    /// Refresh the OAuth tokens. Updates internal state on success and
    /// invokes the refresh sink so the caller can persist. Returns
    /// `ProviderError::Auth` if the refresh itself fails.
    async fn refresh(&self) -> Result<(), ProviderError> {
        let refresh_token = self.oauth.lock().await.refresh.clone();
        if refresh_token.is_empty() {
            return Err(ProviderError::Auth(
                "no refresh token; sign in again".into(),
            ));
        }
        let resp = self
            .client
            .post(format!("{ISSUER}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!(
                "grant_type=refresh_token&refresh_token={refresh_token}&client_id={CLIENT_ID}"
            ))
            .send()
            .await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Auth(format!("refresh failed: {body}")));
        }
        #[derive(Deserialize)]
        struct TokenResp {
            access_token: String,
            #[serde(default)]
            refresh_token: Option<String>,
            #[serde(default)]
            expires_in: Option<u64>,
        }
        let tokens: TokenResp = resp
            .json()
            .await
            .map_err(|e| ProviderError::Decode(e.to_string()))?;
        let new_cred = {
            let mut g = self.oauth.lock().await;
            g.access = tokens.access_token;
            if let Some(r) = tokens.refresh_token {
                g.refresh = r;
            }
            g.expires_at_unix_ms = chrono::Utc::now().timestamp_millis()
                + i64::from(u32::try_from(tokens.expires_in.unwrap_or(3600)).unwrap_or(3600))
                    * 1000;
            Credential::OAuth {
                access: g.access.clone(),
                refresh: g.refresh.clone(),
                expires_at_unix_ms: g.expires_at_unix_ms,
                account_id: g.account_id.clone(),
            }
        };
        if let Some(sink) = &self.on_refresh {
            sink(new_cred);
        }
        Ok(())
    }
}

// ─── Request body construction ──────────────────────────────────────────────

/// Convert `Vec<ChatMessage>` into Codex Responses input items. The
/// `instructions` system field is split off and returned separately so
/// the caller can drop it into the top-level `instructions` slot
/// (preferred over an in-line `system` message).
fn build_input(messages: &[ChatMessage]) -> (String, Vec<Value>) {
    let mut instructions: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();

    for m in messages {
        match m.role {
            MessageRole::System => {
                if !m.content.is_empty() {
                    instructions.push(m.content.clone());
                }
            }
            MessageRole::User => {
                input.push(json!({
                    "role": "user",
                    "content": [{ "type": "input_text", "text": m.content }],
                }));
            }
            MessageRole::Assistant => {
                if !m.content.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": m.content }],
                    }));
                }
                for tc in &m.tool_calls {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": tc.id,
                        "name": tc.name,
                        "arguments": tc.arguments,
                    }));
                }
            }
            MessageRole::Tool => {
                let id = m.tool_call_id.clone().unwrap_or_default();
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": id,
                    "output": m.content,
                }));
            }
        }
    }

    (instructions.join("\n\n"), input)
}

// ─── ChatProvider impl ──────────────────────────────────────────────────────

#[async_trait]
impl ChatProvider for OpenAICodexProvider {
    fn name(&self) -> &'static str {
        "openai-codex"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // Codex doesn't expose a public catalogue endpoint at the
        // chatgpt.com host. Surface the curated allow-list. The same
        // list opencode hard-codes in `plugin/codex.ts`.
        Ok(meta::static_models(crate::config::ProviderKind::OpenAI)
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
        // Proactive refresh if we're within 60s of expiry. Avoids the
        // 401 + retry round-trip on the next call.
        {
            let exp = self.oauth.lock().await.expires_at_unix_ms;
            if exp != 0 && exp <= chrono::Utc::now().timestamp_millis() + 60_000 {
                let _ = self.refresh().await;
            }
        }

        let (instructions, input) = build_input(&req.messages);

        let body = build_request_body(&req, &instructions, &input);

        let mut response = self.send(&body).await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.refresh().await?;
            response = self.send(&body).await?;
        }
        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(if status == reqwest::StatusCode::UNAUTHORIZED {
                ProviderError::Auth(body_text)
            } else {
                ProviderError::Http(format!("{status}: {body_text}"))
            });
        }

        let mut stream = response.bytes_stream().eventsource();
        let mut state = ResponsesState::default();

        while let Some(ev) = stream.next().await {
            let ev = ev.map_err(|e| ProviderError::Decode(e.to_string()))?;
            if ev.data.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&ev.data) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "openai-codex: skipping unparseable SSE chunk");
                    continue;
                }
            };
            let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
            // Defensive usage harvest: every Codex event nests a
            // `response` object, and any of `response.created`,
            // `response.in_progress`, `response.completed` may carry a
            // `usage` block (the API has changed in the past). Pull
            // the most recent reading on every event so the caller
            // always sees a populated `Usage` even if the terminal
            // event format shifts.
            state.harvest_usage(&value);
            match kind {
                "response.output_item.added" => state.on_item_added(&sink, &value),
                "response.output_text.delta" => state.on_text_delta(&sink, &value),
                "response.function_call_arguments.delta" => state.on_args_delta(&sink, &value),
                "response.function_call_arguments.done" => state.on_args_done(&sink, &value),
                "response.completed" => {
                    state.on_completed(&value);
                    break;
                }
                "response.failed" | "response.cancelled" => {
                    state.finish_reason = FinishReason::Other;
                    break;
                }
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
            // Codex Responses uses encrypted reasoning items, not the
            // OpenAI-compat round-trip slot — nothing to echo back.
            reasoning_content: None,
        })
    }
}

impl OpenAICodexProvider {
    async fn send(&self, body: &Value) -> Result<reqwest::Response, ProviderError> {
        self.client
            .post(CODEX_ENDPOINT)
            .headers(self.auth_headers().await)
            .json(body)
            .send()
            .await
            .map_err(|e| ProviderError::Http(e.to_string()))
    }
}

fn build_request_body(req: &CompletionRequest, instructions: &str, input: &[Value]) -> Value {
    // Per-model capability gates from models.dev. gpt-5.x codex models
    // reject `temperature` (Responses returns 400 "Unsupported
    // parameter") so we drop it when the catalogue says so.
    let caps =
        crate::provider::catalogue::capabilities(crate::config::ProviderKind::OpenAI, &req.model);
    let supports_temperature = caps.as_ref().is_none_or(|c| c.temperature);

    let mut body = json!({
        "model": req.model,
        "input": input,
        "stream": true,
        // We don't need OpenAI to retain the response — agent loop is
        // stateless from the provider's POV. Opt out so `previous_response_id`
        // doesn't accidentally drift.
        "store": false,
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions);
    }
    if supports_temperature {
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
    }
    if let Some(m) = req.max_tokens {
        body["max_output_tokens"] = json!(m);
    }
    if !req.tools.is_empty() {
        body["tools"] = json!(req
            .tools
            .iter()
            .map(|t| json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
                "strict": false,
            }))
            .collect::<Vec<_>>());
    }
    // Operator overrides last. Common knobs: `reasoning: { effort:
    // "high" }`, `text: { verbosity: "low" }`, `service_tier: "priority"`.
    if let Some(opts) = &req.provider_options {
        merge_top_level(&mut body, opts);
    }
    // Capability gate after merge (operator overrides flow through the
    // same scrub). Strip temperature again in case the operator set it
    // and the model rejects it — better to silently drop than 400.
    if !supports_temperature {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("temperature");
        }
    }
    body
}

// ─── Streaming-state machine ────────────────────────────────────────────────

#[derive(Default)]
struct ResponsesState {
    /// Tool calls keyed by output_index → in-flight accumulator.
    tool_calls: std::collections::BTreeMap<u32, ToolAccum>,
    finish_reason: FinishReason,
    usage: Option<Usage>,
}

#[derive(Default)]
struct ToolAccum {
    call_id: String,
    name: String,
    arguments: String,
    started: bool,
}

impl ResponsesState {
    fn on_item_added(&mut self, sink: &EventSink, v: &Value) {
        let item = v.get("item").cloned().unwrap_or(Value::Null);
        if item.get("type").and_then(|x| x.as_str()) != Some("function_call") {
            return;
        }
        let idx = v.get("output_index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let call_id = item
            .get("call_id")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        let entry = self.tool_calls.entry(idx).or_default();
        entry.call_id.clone_from(&call_id);
        entry.name.clone_from(&name);
        if !call_id.is_empty() && !name.is_empty() && !entry.started {
            sink(CompletionEvent::ToolCallStart { id: call_id, name });
            entry.started = true;
        }
    }

    fn on_text_delta(&mut self, sink: &EventSink, v: &Value) {
        if let Some(delta) = v.get("delta").and_then(|x| x.as_str()) {
            if !delta.is_empty() {
                sink(CompletionEvent::TokenDelta(delta.to_string()));
            }
        }
    }

    fn on_args_delta(&mut self, sink: &EventSink, v: &Value) {
        let idx = v.get("output_index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let entry = self.tool_calls.entry(idx).or_default();
        if let Some(delta) = v.get("delta").and_then(|x| x.as_str()) {
            if !delta.is_empty() {
                entry.arguments.push_str(delta);
                if entry.started {
                    sink(CompletionEvent::ToolCallArgsDelta {
                        id: entry.call_id.clone(),
                        json_delta: delta.to_string(),
                    });
                }
            }
        }
    }

    fn on_args_done(&mut self, sink: &EventSink, v: &Value) {
        let idx = v.get("output_index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        if let Some(entry) = self.tool_calls.get(&idx) {
            if entry.started {
                sink(CompletionEvent::ToolCallEnd {
                    id: entry.call_id.clone(),
                });
            }
        }
    }

    fn on_completed(&mut self, v: &Value) {
        let response = v.get("response").cloned().unwrap_or(Value::Null);
        if let Some(reason) = response.get("status").and_then(|x| x.as_str()) {
            // `status` is "completed" / "failed" / "cancelled". Tool-call
            // exit is signalled by an output item of type=function_call.
            self.finish_reason = if !self.tool_calls.is_empty() {
                FinishReason::ToolCalls
            } else if reason == "completed" {
                FinishReason::Stop
            } else {
                FinishReason::Other
            };
        }
        // Final usage harvest — `harvest_usage` already runs on every
        // event so this is belt-and-braces for the terminal case.
        self.harvest_usage(v);
    }

    /// Pull a usage block from any Codex SSE event payload. The OpenAI
    /// Responses API has shifted the field placement across releases:
    /// some events nest it under `response.usage`, some emit it at the
    /// top level, some only on the terminal `response.completed`. We
    /// look in every plausible spot and overwrite the running view.
    /// Empty / partial blocks are ignored so a usage-less event
    /// doesn't clobber a prior good reading.
    fn harvest_usage(&mut self, v: &Value) {
        let candidates: [Option<&Value>; 2] = [v.pointer("/response/usage"), v.get("usage")];
        for raw in candidates.iter().flatten() {
            let input = raw
                .get("input_tokens")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32;
            let output = raw
                .get("output_tokens")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32;
            let total = raw
                .get("total_tokens")
                .and_then(|x| x.as_u64())
                .map(|x| x as u32)
                .unwrap_or_else(|| input.saturating_add(output));
            if input == 0 && output == 0 && total == 0 {
                continue;
            }
            self.usage = Some(Usage {
                prompt_tokens: input,
                completion_tokens: output,
                total_tokens: total,
            });
        }
    }

    fn into_tool_calls(self) -> Vec<ToolCall> {
        self.tool_calls
            .into_values()
            .filter(|e| !e.call_id.is_empty() && !e.name.is_empty())
            .map(|e| ToolCall {
                id: e.call_id,
                name: e.name,
                arguments: if e.arguments.is_empty() {
                    "{}".to_string()
                } else {
                    e.arguments
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_input_round_trips_tool_call() {
        let msgs = vec![
            ChatMessage {
                role: MessageRole::System,
                content: "be helpful".into(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::User,
                content: "list pods".into(),
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Assistant,
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "call_a".into(),
                    name: "list_pods".into(),
                    arguments: "{\"ns\":\"default\"}".into(),
                }],
                ..Default::default()
            },
            ChatMessage {
                role: MessageRole::Tool,
                content: "[]".into(),
                tool_call_id: Some("call_a".into()),
                ..Default::default()
            },
        ];
        let (instr, input) = build_input(&msgs);
        assert_eq!(instr, "be helpful");
        // user, function_call, function_call_output (assistant-text was empty)
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "call_a");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["call_id"], "call_a");
        assert_eq!(input[2]["output"], "[]");
    }

    #[test]
    fn responses_state_collects_text_and_tool() {
        let mut state = ResponsesState::default();
        let events: std::sync::Arc<std::sync::Mutex<Vec<CompletionEvent>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let evs_for_sink = events.clone();
        let sink: EventSink = Box::new(move |e| evs_for_sink.lock().unwrap().push(e));

        state.on_text_delta(&sink, &json!({"delta":"hi"}));
        state.on_item_added(
            &sink,
            &json!({
                "output_index": 0,
                "item": {"type":"function_call","call_id":"c1","name":"do","arguments":""}
            }),
        );
        state.on_args_delta(&sink, &json!({"output_index": 0, "delta":"{\"x\":1}"}));
        state.on_args_done(&sink, &json!({"output_index": 0}));
        state.on_completed(&json!({
            "response":{
                "status":"completed",
                "usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}
            }
        }));

        let calls = state.into_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "c1");
        assert_eq!(calls[0].name, "do");
        assert_eq!(calls[0].arguments, "{\"x\":1}");

        let evs = events.lock().unwrap().clone();
        assert!(evs
            .iter()
            .any(|e| matches!(e, CompletionEvent::TokenDelta(t) if t == "hi")));
        assert!(evs
            .iter()
            .any(|e| matches!(e, CompletionEvent::ToolCallStart{ id, .. } if id == "c1")));
        assert!(evs
            .iter()
            .any(|e| matches!(e, CompletionEvent::ToolCallEnd{ id } if id == "c1")));
    }
}
