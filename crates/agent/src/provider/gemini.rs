//! Google Gemini provider — the native `generateContent` wire.
//!
//! Endpoint: `<base>/models/<id>:streamGenerateContent?alt=sse`, authenticated
//! with `x-goog-api-key` (a header, never `?key=`: URLs end up in transport
//! error strings and logs). Each SSE `data:` line is one JSON chunk shaped
//! `{ candidates: [{ content: { parts }, finishReason }], usageMetadata }`.
//!
//! Why not Google's OpenAI-compat shim: Gemini 3 refuses a replayed function
//! call that lacks the `thoughtSignature` it issued, and only the native shape
//! round-trips it. We keep the signature on [`ToolCall::thought_signature`]
//! (persisted with the transcript) and send it back on the matching
//! `functionCall` part. Thought *text* is never replayed or surfaced.
//!
//! Mirrors opencode's `llm/src/protocols/gemini.ts`.

use super::{
    dropped_images_note, gemini_schema, merge_top_level, sse_events, ChatProvider, CompletionEvent,
    CompletionFinal, CompletionRequest, EventSink, FinishReason, ModelInfo, ProviderError, Usage,
    STREAM_IDLE_TIMEOUT,
};
use crate::config::{Credential, ProviderKind};
use crate::provider::{catalogue, meta};
use crate::types::{ChatMessage, MessageRole, ToolCall};
use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const KIND: ProviderKind = ProviderKind::Google;

/// Documented bypass for a replayed function call whose signature we don't
/// have (a call that never came from Gemini, or history that predates the
/// signature field). Only sent where Gemini 3 would otherwise reject the call.
const SKIP_SIGNATURE: &str = "skip_thought_signature_validator";

/// `GET /models` is paged (default 50); this is the server-side maximum.
const MODELS_PAGE_SIZE: &str = "1000";
const MODELS_MAX_PAGES: usize = 10;

/// Ids that pass `supportedGenerationMethods: generateContent` but aren't
/// chat models (speech, image / video / music generation, realtime, agents,
/// embeddings). They would only ever 400 in the chat picker.
const NON_CHAT_MARKERS: &[&str] = &[
    "embed",
    "tts",
    "image",
    "imagen",
    "veo",
    "lyria",
    "live",
    "audio",
    "omni",
    "robotics",
    "deep-research",
    "computer-use",
    "aqa",
];

pub struct GeminiProvider {
    client: reqwest::Client,
    base_url: String,
    credential: Auth,
    /// `Google` for the first-party API; an OpenCode gateway when one serves
    /// Gemini models on this wire (drives catalogue lookups and headers).
    kind: ProviderKind,
    extra_headers: Vec<(&'static str, String)>,
}

enum Auth {
    ApiKey(String),
    /// A Google OAuth access token (not offered in the UI, but a stored
    /// credential of that shape still has to authenticate somehow).
    Bearer(String),
}

impl GeminiProvider {
    /// `base_url_override` lets the operator point at a proxy; `None` uses
    /// the canonical default from [`meta::for_kind`].
    pub fn new(cred: &Credential, base_url_override: Option<String>) -> Self {
        Self::with_kind(cred, base_url_override, KIND)
    }

    /// Like [`Self::new`] for a gateway that serves Gemini models on this
    /// wire; `kind` selects the default base URL and catalogue entries.
    pub fn with_kind(
        cred: &Credential,
        base_url_override: Option<String>,
        kind: ProviderKind,
    ) -> Self {
        let credential = match cred {
            Credential::ApiKey { key } => Auth::ApiKey(key.trim().to_string()),
            Credential::OAuth { access, .. } => Auth::Bearer(access.clone()),
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
                .unwrap_or_else(|| meta::for_kind(kind).default_base_url.to_string()),
            credential,
            kind,
            extra_headers: Vec::new(),
        }
    }

    /// Attach the conversation's session id for gateways that route and
    /// cache on it (a no-op for the first-party API).
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
        match &self.credential {
            Auth::ApiKey(k) if !k.is_empty() => {
                super::apply_headers(&mut h, &[("x-goog-api-key", k.clone())]);
            }
            Auth::Bearer(t) if !t.is_empty() => {
                super::apply_headers(&mut h, &[("authorization", format!("Bearer {t}"))]);
            }
            _ => {}
        }
        super::apply_headers(&mut h, &self.extra_headers);
        h
    }

    async fn fetch_live_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let mut out = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MODELS_MAX_PAGES {
            let mut params = vec![("pageSize", MODELS_PAGE_SIZE)];
            if let Some(t) = page_token.as_deref() {
                params.push(("pageToken", t));
            }
            let url = reqwest::Url::parse_with_params(&self.url("/models"), params)
                .map_err(|e| ProviderError::InvalidResponse(format!("bad base URL: {e}")))?;
            let resp = self
                .client
                .get(url)
                .headers(self.headers())
                .send()
                .await
                .map_err(|e| ProviderError::transport(e.to_string()))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(http_error(status, body));
            }
            let body = resp
                .text()
                .await
                .map_err(|e| ProviderError::transport(e.to_string()))?;
            let (models, next) = parse_models_page(&body)?;
            out.extend(models);
            match next {
                Some(t) => page_token = Some(t),
                None => break,
            }
        }
        Ok(out)
    }

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

/// Gemini rejects a request wholesale when any one tool's schema is outside its
/// dialect, reporting only an index (`…function_declarations[5].parameters…`).
/// Name the tool, so the operator can see which one (usually a third-party MCP
/// server's) to disable instead of guessing at an array position.
fn name_rejected_tool(err: ProviderError, tools: &[crate::types::ToolSchema]) -> ProviderError {
    let ProviderError::Http {
        status: Some(400),
        body,
    } = &err
    else {
        return err;
    };
    const MARKER: &str = "function_declarations[";
    let Some(start) = body.find(MARKER).map(|i| i + MARKER.len()) else {
        return err;
    };
    let digits: String = body[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let Some(tool) = digits.parse::<usize>().ok().and_then(|i| tools.get(i)) else {
        return err;
    };
    ProviderError::Http {
        status: Some(400),
        body: format!(
            "{body}\n(Gemini rejected the schema of tool `{}` — disable it or the MCP server that provides it)",
            tool.name
        ),
    }
}

/// Gemini reports a bad key as HTTP 400 `API_KEY_INVALID`, not 401.
fn http_error(status: u16, body: String) -> ProviderError {
    if status == 400 && body.contains("API_KEY_INVALID") {
        ProviderError::Auth(body)
    } else {
        ProviderError::from_http_status(status, body)
    }
}

// ─── Model listing ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelsPage {
    #[serde(default)]
    models: Vec<ApiModel>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiModel {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    input_token_limit: Option<u32>,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

/// Is `id` something the chat picker should offer?
pub fn is_chat_model_id(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    !NON_CHAT_MARKERS.iter().any(|m| lower.contains(m))
}

/// One page of `GET /models`: the chat-capable models on it, and the token for
/// the next page (`None` on the last).
fn parse_models_page(body: &str) -> Result<(Vec<ModelInfo>, Option<String>), ProviderError> {
    let page: ModelsPage =
        serde_json::from_str(body).map_err(|e| ProviderError::Decode(e.to_string()))?;
    let models = page
        .models
        .into_iter()
        .filter(|m| {
            m.supported_generation_methods
                .iter()
                .any(|g| g == "generateContent")
        })
        .filter_map(|m| {
            let id = m
                .name
                .strip_prefix("models/")
                .unwrap_or(&m.name)
                .to_string();
            is_chat_model_id(&id).then_some(ModelInfo {
                id,
                name: m.display_name,
                context_length: m.input_token_limit,
            })
        })
        .collect();
    Ok((models, page.next_page_token.filter(|t| !t.is_empty())))
}

// ─── Request building ───────────────────────────────────────────────────────

/// Per-model switches derived from models.dev. Unknown models get the
/// permissive defaults (try it; the API is the final arbiter) except thinking,
/// which is only configured for models known to support it — a thinking field
/// on a non-thinking model is a hard 400.
#[derive(Debug, Clone, Copy)]
pub struct Gates {
    pub vision: bool,
    pub temperature: bool,
    pub tools: bool,
    pub thinking: bool,
}

impl Gates {
    pub fn from_capabilities(caps: Option<&catalogue::ModelCapabilities>) -> Self {
        Self {
            vision: caps.is_none_or(|c| c.vision),
            temperature: caps.is_none_or(|c| c.temperature),
            tools: caps.is_none_or(|c| c.tool_call),
            thinking: caps.is_some_and(|c| c.reasoning),
        }
    }

    /// Everything on; used where there's no catalogue to consult.
    pub fn permissive() -> Self {
        Self {
            vision: true,
            temperature: true,
            tools: true,
            thinking: true,
        }
    }
}

/// The API path for a model id: `models/<id>`, unless the id already names a
/// resource (`models/…`, `tunedModels/…`).
fn model_path(model: &str) -> String {
    if model.contains('/') {
        model.to_string()
    } else {
        format!("models/{model}")
    }
}

/// `gemini-<major>…` → major version. `None` for aliases such as
/// `gemini-flash-latest`, whose generation isn't in the name.
fn gemini_major(id: &str) -> Option<u32> {
    let rest = id.strip_prefix("gemini-")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn is_gemini_25(id: &str) -> bool {
    id.starts_with("gemini-2.5") || id.starts_with("gemini-2-5")
}

/// The `thinkingConfig` for `model`, from the universal reasoning knobs.
///
/// Gemini 2.5 takes a token budget (`thinkingBudget`); Gemini 3+ takes a
/// level (`thinkingLevel`) and Pro tiers only accept low/high. Sending the
/// wrong one is a 400, hence the per-model split. Anything else (2.0, Gemma,
/// `*-latest` aliases) gets no config at all.
pub fn thinking_config(
    model: &str,
    effort: Option<&str>,
    budget_tokens: Option<u32>,
) -> Option<Value> {
    let id = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    if is_gemini_25(&id) {
        let pro = id.contains("pro");
        let (min, max) = if pro { (128, 32_768) } else { (0, 24_576) };
        let budget = budget_tokens.or_else(|| {
            effort.map(|e| match e {
                // `none` asks for no thinking: a zero budget where the model
                // allows it (Pro's floor of 128 is applied by the clamp below).
                "none" => 0,
                "minimal" => 1_024,
                "low" => 4_096,
                "medium" => 16_000,
                _ => max,
            })
        })?;
        return Some(json!({ "thinkingBudget": budget.clamp(min, max) }));
    }
    if gemini_major(&id).is_some_and(|m| m >= 3) {
        let flash = id.contains("flash");
        let level = match effort {
            // Gemini 3 Flash has a `minimal` level; Pro stops at `low`.
            Some("none" | "minimal") => {
                if flash {
                    "minimal"
                } else {
                    "low"
                }
            }
            Some("low") => "low",
            Some("medium") if flash => "medium",
            Some(_) => "high",
            None => match budget_tokens? {
                0..=4_096 => "low",
                _ => "high",
            },
        };
        return Some(json!({ "thinkingLevel": level }));
    }
    None
}

/// What a turn carries. Adjacent turns merge only when they are the same
/// kind: plain user text never folds into a turn of function responses (nor the
/// reverse), matching how opencode's SDK lays turns out — Gemini checks the
/// response count against the preceding call turn.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Turn {
    User,
    ToolResults,
    Model,
}

fn push_content(contents: &mut Vec<(Turn, Value)>, turn: Turn, parts: Vec<Value>) {
    if parts.is_empty() {
        return;
    }
    if let Some((last_turn, last)) = contents.last_mut() {
        if *last_turn == turn {
            if let Some(existing) = last["parts"].as_array_mut() {
                existing.extend(parts);
                return;
            }
        }
    }
    let role = if turn == Turn::Model { "model" } else { "user" };
    contents.push((turn, json!({ "role": role, "parts": parts })));
}

/// Gemma models reject `systemInstruction`; their system text rides at the
/// top of the first user turn instead.
fn is_gemma(model: &str) -> bool {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase()
        .starts_with("gemma-")
}

fn function_call_args(arguments: &str) -> Value {
    match serde_json::from_str::<Value>(arguments) {
        Ok(v @ Value::Object(_)) => v,
        _ => Value::Object(Map::new()),
    }
}

/// Map the neutral transcript onto Gemini `contents` + `systemInstruction`.
///
/// Gemini wants strictly user/model turns, with every function response in a
/// user turn directly after the model turn that called, so adjacent same-role
/// messages are merged (consecutive tool results become one turn).
fn to_contents(
    messages: &[ChatMessage],
    model: &str,
    vision: bool,
) -> (Option<String>, Vec<Value>) {
    let gemini3 = gemini_major(
        &model
            .rsplit('/')
            .next()
            .unwrap_or(model)
            .to_ascii_lowercase(),
    )
    .is_some_and(|m| m >= 3);
    let mut system: Vec<&str> = Vec::new();
    let mut contents: Vec<(Turn, Value)> = Vec::new();
    let mut call_names: HashMap<&str, &str> = HashMap::new();

    for m in messages {
        match m.role {
            MessageRole::System => {
                if !m.content.trim().is_empty() {
                    system.push(&m.content);
                }
            }
            MessageRole::User => {
                let mut parts = Vec::new();
                if !m.images.is_empty() && !vision {
                    parts.push(json!({ "text": dropped_images_note(&m.content, m.images.len()) }));
                } else {
                    if !m.content.is_empty() {
                        parts.push(json!({ "text": m.content }));
                    }
                    for img in &m.images {
                        parts.push(json!({
                            "inlineData": { "mimeType": img.mime, "data": img.data }
                        }));
                    }
                }
                push_content(&mut contents, Turn::User, parts);
            }
            MessageRole::Assistant => {
                let mut parts = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "text": m.content }));
                }
                for (i, tc) in m.tool_calls.iter().enumerate() {
                    call_names.insert(&tc.id, &tc.name);
                    let mut part = json!({
                        "functionCall": { "name": tc.name, "args": function_call_args(&tc.arguments) }
                    });
                    let signature = tc
                        .thought_signature
                        .as_deref()
                        .or((gemini3 && i == 0).then_some(SKIP_SIGNATURE));
                    if let Some(sig) = signature {
                        part["thoughtSignature"] = json!(sig);
                    }
                    parts.push(part);
                }
                push_content(&mut contents, Turn::Model, parts);
            }
            MessageRole::Tool => {
                let name = m
                    .name
                    .as_deref()
                    .or_else(|| {
                        m.tool_call_id
                            .as_deref()
                            .and_then(|id| call_names.get(id).copied())
                    })
                    .unwrap_or("tool");
                // An empty result reads as a failure to the model (and Gemini
                // dislikes an empty string); the SDK says the same thing.
                let content = if m.content.trim().is_empty() {
                    "Tool executed successfully."
                } else {
                    m.content.as_str()
                };
                let part = json!({
                    "functionResponse": {
                        "name": name,
                        "response": { "name": name, "content": content }
                    }
                });
                push_content(&mut contents, Turn::ToolResults, vec![part]);
            }
        }
    }
    let system = (!system.is_empty()).then(|| system.join("\n\n"));
    (system, contents.into_iter().map(|(_, c)| c).collect())
}

/// Build the `streamGenerateContent` request body.
///
/// `provider_options` may carry the universal `reasoning` knobs
/// (`{ effort, budget_tokens }`), which are translated per model into
/// `generationConfig.thinkingConfig`; every other key is merged verbatim, last,
/// so an operator-supplied native `generationConfig` wins.
pub fn build_request_body(req: &CompletionRequest, gates: Gates) -> Value {
    let (system, mut contents) = to_contents(&req.messages, &req.model, gates.vision);
    let mut system_instruction = None;
    if let Some(text) = system {
        if is_gemma(&req.model) {
            let lead = json!({ "text": format!("{text}\n\n") });
            match contents.first_mut() {
                Some(first) if first["role"] == "user" => {
                    if let Some(parts) = first["parts"].as_array_mut() {
                        parts.insert(0, lead);
                    }
                }
                _ => contents.insert(0, json!({ "role": "user", "parts": [lead] })),
            }
        } else {
            system_instruction = Some(json!({ "parts": [{ "text": text }] }));
        }
    }
    let mut body = json!({ "contents": contents });
    if let Some(si) = system_instruction {
        body["systemInstruction"] = si;
    }

    if gates.tools && !req.tools.is_empty() {
        let declarations: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                let mut decl = json!({ "name": t.name, "description": t.description });
                if let Some(params) = gemini_schema::convert(&t.parameters) {
                    decl["parameters"] = params;
                }
                decl
            })
            .collect();
        body["tools"] = json!([{ "functionDeclarations": declarations }]);
    }

    let mut generation = Map::new();
    if let Some(max) = req.max_tokens {
        generation.insert("maxOutputTokens".into(), json!(max));
    }
    if gates.temperature {
        if let Some(t) = req.temperature {
            // f32 → f64 widening prints as 0.30000001192…; go via the short
            // decimal form so the wire carries what the operator typed.
            let t = t
                .to_string()
                .parse::<f64>()
                .unwrap_or_else(|_| f64::from(t));
            generation.insert("temperature".into(), json!(t));
        }
    }

    let mut overrides = req.provider_options.clone();
    let reasoning = overrides
        .as_mut()
        .and_then(Value::as_object_mut)
        .and_then(|o| o.remove("reasoning"));
    if gates.thinking {
        let effort = reasoning
            .as_ref()
            .and_then(|r| r.get("effort"))
            .and_then(Value::as_str);
        let budget = reasoning
            .as_ref()
            .and_then(|r| r.get("budget_tokens"))
            .and_then(Value::as_u64)
            .and_then(|b| u32::try_from(b).ok());
        if let Some(cfg) = thinking_config(&req.model, effort, budget) {
            generation.insert("thinkingConfig".into(), cfg);
        }
    }
    if !generation.is_empty() {
        body["generationConfig"] = Value::Object(generation);
    }

    if let Some(opts) = &overrides {
        merge_top_level(&mut body, opts);
    }
    body
}

// ─── Stream parsing ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunk {
    #[serde(default)]
    candidates: Vec<Candidate>,
    #[serde(default)]
    usage_metadata: Option<UsageMetadata>,
    #[serde(default)]
    prompt_feedback: Option<PromptFeedback>,
    /// Mid-stream error on an HTTP 200.
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    #[serde(default)]
    content: Option<Content>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Content {
    #[serde(default)]
    parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    thought: Option<bool>,
    #[serde(default)]
    thought_signature: Option<String>,
    #[serde(default)]
    function_call: Option<FunctionCall>,
}

#[derive(Debug, Deserialize)]
struct FunctionCall {
    name: String,
    #[serde(default)]
    args: Option<Value>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UsageMetadata {
    #[serde(default, rename = "promptTokenCount")]
    prompt: u32,
    #[serde(default, rename = "candidatesTokenCount")]
    candidates: u32,
    #[serde(default, rename = "thoughtsTokenCount")]
    thoughts: u32,
    #[serde(default, rename = "totalTokenCount")]
    total: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptFeedback {
    #[serde(default)]
    block_reason: Option<String>,
}

/// Accumulates one streamed response. Fed one SSE `data:` payload at a time
/// and emitting [`CompletionEvent`]s as it goes; pure of I/O so the whole wire
/// behaviour is testable from JSON fixtures.
#[derive(Default)]
pub struct StreamState {
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    blocked: bool,
    usage: Option<Usage>,
}

impl StreamState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply one chunk. `Err` only for an in-stream API error; an unparseable
    /// chunk is skipped.
    pub fn on_data(&mut self, data: &str, sink: &EventSink) -> Result<(), ProviderError> {
        let chunk: StreamChunk = match serde_json::from_str(data) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "gemini: skipping unparseable SSE chunk");
                return Ok(());
            }
        };

        if let Some(err) = chunk.error {
            let status = err
                .get("code")
                .and_then(Value::as_u64)
                .and_then(|c| u16::try_from(c).ok());
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .map_or_else(|| data.to_string(), str::to_string);
            // `status: None` is deliberate when the code is missing: the HTTP
            // status was 200, and the classifier reads the vendor text.
            return Err(ProviderError::Http {
                status,
                body: message,
            });
        }

        if chunk
            .prompt_feedback
            .and_then(|f| f.block_reason)
            .is_some_and(|r| !r.is_empty())
        {
            self.blocked = true;
        }
        if let Some(u) = chunk.usage_metadata {
            let completion = u.candidates + u.thoughts;
            self.usage = Some(Usage {
                prompt_tokens: u.prompt,
                completion_tokens: completion,
                total_tokens: if u.total > 0 {
                    u.total
                } else {
                    u.prompt + completion
                },
            });
        }

        let Some(candidate) = chunk.candidates.into_iter().next() else {
            return Ok(());
        };
        if let Some(reason) = candidate.finish_reason {
            self.finish_reason = Some(reason);
        }
        for part in candidate.content.map(|c| c.parts).unwrap_or_default() {
            if let Some(fc) = part.function_call {
                self.on_function_call(sink, fc, part.thought_signature);
            } else if let Some(text) = part.text {
                // Thought summaries are scratch work: neither shown nor kept.
                if part.thought != Some(true) && !text.is_empty() {
                    sink(CompletionEvent::TokenDelta(text));
                }
            }
        }
        Ok(())
    }

    fn on_function_call(&mut self, sink: &EventSink, fc: FunctionCall, signature: Option<String>) {
        let id = fc
            .id
            .filter(|i| !i.is_empty())
            .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()));
        let arguments = match fc.args {
            Some(a @ Value::Object(_)) => a.to_string(),
            _ => "{}".to_string(),
        };
        // Gemini sends a call whole, so the three events fire back to back.
        sink(CompletionEvent::ToolCallStart {
            id: id.clone(),
            name: fc.name.clone(),
        });
        sink(CompletionEvent::ToolCallArgsDelta {
            id: id.clone(),
            json_delta: arguments.clone(),
        });
        sink(CompletionEvent::ToolCallEnd { id: id.clone() });
        self.tool_calls.push(ToolCall {
            id,
            name: fc.name,
            arguments,
            thought_signature: signature.filter(|s| !s.is_empty()),
        });
    }

    pub fn finish(self) -> CompletionFinal {
        let finish_reason = if !self.tool_calls.is_empty() {
            FinishReason::ToolCalls
        } else if self.blocked {
            FinishReason::ContentFilter
        } else {
            match self.finish_reason.as_deref() {
                Some("MAX_TOKENS") => FinishReason::Length,
                Some(
                    "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
                    | "IMAGE_SAFETY" | "LANGUAGE",
                ) => FinishReason::ContentFilter,
                Some("STOP") | None => FinishReason::Stop,
                Some(_) => FinishReason::Other,
            }
        };
        CompletionFinal {
            finish_reason,
            tool_calls: self.tool_calls,
            usage: self.usage,
            reasoning_content: None,
            thinking_blocks: Vec::new(),
        }
    }
}

// ─── ChatProvider ───────────────────────────────────────────────────────────

#[async_trait]
impl ChatProvider for GeminiProvider {
    fn name(&self) -> &'static str {
        meta::for_kind(self.kind).id
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // Live `/models` is freshest; on failure or an empty list fall back to
        // models.dev, then the static list. Surface the live error only when
        // there is nothing at all to show.
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

    async fn stream_completion(
        &self,
        req: CompletionRequest,
        sink: EventSink,
    ) -> Result<CompletionFinal, ProviderError> {
        let caps = catalogue::capabilities(self.kind, &req.model);
        let gates = Gates::from_capabilities(caps.as_ref());
        let body = build_request_body(&req, gates);
        let url = self.url(&format!(
            "/{}:streamGenerateContent?alt=sse",
            model_path(&req.model)
        ));

        let resp = self
            .client
            .post(url)
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::transport(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            let tools: &[crate::types::ToolSchema] = if gates.tools { &req.tools } else { &[] };
            return Err(name_rejected_tool(http_error(status, body), tools));
        }

        let mut stream = sse_events(resp.bytes_stream(), STREAM_IDLE_TIMEOUT);
        let mut state = StreamState::new();
        while let Some(ev) = stream.next().await {
            state.on_data(&ev?.data, &sink)?;
        }
        Ok(state.finish())
    }
}

#[cfg(test)]
mod tests;
