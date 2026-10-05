//! OpenCode gateways (Zen, Go): one endpoint, each model on its native wire.
//!
//! The gateway accepts every model over `/chat/completions` and translates, but
//! translation is lossy where it matters for an agent — Anthropic thinking
//! blocks, Gemini thought signatures (a Gemini 3 tool round trip fails without
//! them). models.dev records the wire per model, so this provider looks the
//! model up and hands the request to the matching client, all aimed at the same
//! base URL:
//!
//! | models.dev package        | wire here                     | path                                   |
//! |---------------------------|-------------------------------|----------------------------------------|
//! | `@ai-sdk/openai-compatible` | chat completions            | `/chat/completions`                    |
//! | `@ai-sdk/anthropic`       | Anthropic Messages            | `/messages`                            |
//! | `@ai-sdk/google`          | Gemini `generateContent` (Zen only) | `/models/<id>:streamGenerateContent` |
//! | `@ai-sdk/openai`          | chat completions (translated) | `/chat/completions`                    |
//!
//! Anything the catalogue doesn't know — including before it has loaded —
//! takes chat completions, the one shape every gateway model accepts.

use super::anthropic::AnthropicProvider;
use super::catalogue::{self, Wire};
use super::gemini::GeminiProvider;
use super::openai_compat::OpenAICompatibleProvider;
use super::{
    meta, ChatProvider, CompletionEvent, CompletionFinal, CompletionRequest, EventSink, ModelInfo,
    ProviderError,
};
use crate::config::{Credential, ProviderKind};
use async_trait::async_trait;
use std::sync::Arc;

/// Zen serves a few models on a question/answer API (`/zen/v1/systemone`),
/// not as chat. They appear in `GET /models` but can never answer a chat turn.
const NON_CHAT_PREFIXES: &[&str] = &["jev-"];

/// The gateway's reply when a model is called on a wire it isn't served on
/// (`Model x is not supported for format google`). The catalogue is a
/// snapshot, so a model can move; chat completions always work.
fn is_wire_mismatch(e: &ProviderError) -> bool {
    let body = match e {
        ProviderError::Auth(b) | ProviderError::Http { body: b, .. } => b,
        _ => return false,
    };
    body.contains("is not supported for format")
}

pub struct OpencodeGatewayProvider {
    kind: ProviderKind,
    chat: OpenAICompatibleProvider,
    anthropic: AnthropicProvider,
    /// Zen serves Gemini models on their native route; Go has none.
    gemini: Option<GeminiProvider>,
    wire_of: fn(ProviderKind, &str) -> Wire,
}

impl OpencodeGatewayProvider {
    /// `base_url_override` points all three wires at one proxy; `None` uses the
    /// gateway's canonical base. `session_id` becomes the routing / caching
    /// header on every request.
    pub fn new(
        kind: ProviderKind,
        cred: &Credential,
        base_url_override: Option<String>,
        session_id: Option<String>,
    ) -> Self {
        debug_assert!(kind.is_opencode_gateway(), "{kind:?} is not a gateway");
        let sid = session_id.as_deref();
        let gemini = (kind == ProviderKind::OpencodeZen).then(|| {
            GeminiProvider::with_kind(cred, base_url_override.clone(), kind).with_session(sid)
        });
        Self {
            kind,
            chat: OpenAICompatibleProvider::for_kind(
                kind,
                cred,
                base_url_override.clone(),
                session_id.clone(),
            ),
            anthropic: AnthropicProvider::new(cred, base_url_override, kind).with_session(sid),
            gemini,
            wire_of: catalogue::wire,
        }
    }

    /// Replace the catalogue lookup (tests; the catalogue is process-global).
    #[must_use]
    pub fn with_wire_fn(mut self, wire_of: fn(ProviderKind, &str) -> Wire) -> Self {
        self.wire_of = wire_of;
        self
    }

    fn target(&self, model: &str) -> &dyn ChatProvider {
        match (self.wire_of)(self.kind, model) {
            Wire::AnthropicMessages => &self.anthropic,
            Wire::Gemini => self
                .gemini
                .as_ref()
                .map_or(&self.chat as &dyn ChatProvider, |g| g),
            Wire::OpenAiChat | Wire::OpenAiResponses => &self.chat,
        }
    }
}

#[async_trait]
impl ChatProvider for OpencodeGatewayProvider {
    fn name(&self) -> &'static str {
        meta::for_kind(self.kind).id
    }

    /// The gateway's own `/models` is the source of truth for what the key may
    /// use, whatever wire each model is later called on.
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let mut models = self.chat.list_models().await?;
        models.retain(|m| !NON_CHAT_PREFIXES.iter().any(|p| m.id.starts_with(p)));
        Ok(models)
    }

    async fn stream_completion(
        &self,
        req: CompletionRequest,
        sink: EventSink,
    ) -> Result<CompletionFinal, ProviderError> {
        let native = match (self.wire_of)(self.kind, &req.model) {
            Wire::AnthropicMessages => true,
            Wire::Gemini => self.gemini.is_some(),
            Wire::OpenAiChat | Wire::OpenAiResponses => false,
        };
        if !native {
            return self.chat.stream_completion(req, sink).await;
        }
        // A wrong-wire refusal arrives as the HTTP response, before any event
        // is emitted, so the same sink can safely serve the retry.
        let shared: Arc<dyn Fn(CompletionEvent) + Send + Sync> = Arc::from(sink);
        let forward = || -> EventSink {
            let shared = shared.clone();
            Box::new(move |e| shared(e))
        };
        match self
            .target(&req.model)
            .stream_completion(req.clone(), forward())
            .await
        {
            Err(e) if is_wire_mismatch(&e) => {
                tracing::warn!(model = %req.model, "gateway: native wire refused, retrying on chat completions");
                self.chat.stream_completion(req, forward()).await
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::test_util::{json_response, serve_at, sse_response};
    use crate::types::{ChatMessage, MessageRole};
    use serde_json::{json, Value};

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: MessageRole::User,
            content: text.into(),
            ..Default::default()
        }
    }

    fn request(model: &str) -> CompletionRequest {
        CompletionRequest {
            model: model.into(),
            messages: vec![user("hi")],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            provider_options: None,
        }
    }

    fn key() -> Credential {
        Credential::ApiKey {
            key: "public".into(),
        }
    }

    fn sink() -> EventSink {
        Box::new(|_| {})
    }

    fn wires(_: ProviderKind, model: &str) -> Wire {
        match model {
            "claude-x" | "qwen-anthropic" => Wire::AnthropicMessages,
            "gemini-x" => Wire::Gemini,
            "gpt-x" => Wire::OpenAiResponses,
            _ => Wire::OpenAiChat,
        }
    }

    fn chat_ok() -> String {
        sse_response(&[
            json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": "stop" }] }),
        ])
    }

    fn anthropic_ok() -> String {
        let events = [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        use std::fmt::Write as _;
        let mut body = String::new();
        for e in events {
            let ty = serde_json::from_str::<Value>(e).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string();
            write!(body, "event: {ty}\ndata: {e}\n\n").unwrap();
        }
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
        )
    }

    fn gemini_ok() -> String {
        sse_response(&[json!({
            "candidates": [{ "content": { "parts": [{ "text": "ok" }] }, "finishReason": "STOP" }]
        })])
    }

    /// Which path a request for `model` hit, and the full request head.
    async fn route(kind: ProviderKind, model: &str, response: String) -> (String, String) {
        let (base, log) = serve_at("/zen/v1", vec![response]).await;
        let p = OpencodeGatewayProvider::new(kind, &key(), Some(base), Some("sess-123".into()))
            .with_wire_fn(wires);
        p.stream_completion(request(model), sink()).await.unwrap();
        let head = log.lock().unwrap()[0].head.clone();
        let path = head.split_whitespace().nth(1).unwrap().to_string();
        (path, head.to_ascii_lowercase())
    }

    #[tokio::test]
    async fn each_model_goes_to_its_native_path() {
        let zen = ProviderKind::OpencodeZen;
        assert_eq!(
            route(zen, "kimi-k3", chat_ok()).await.0,
            "/zen/v1/chat/completions"
        );
        assert_eq!(
            route(zen, "claude-x", anthropic_ok()).await.0,
            "/zen/v1/messages"
        );
        assert_eq!(
            route(zen, "gemini-x", gemini_ok()).await.0,
            "/zen/v1/models/gemini-x:streamGenerateContent?alt=sse"
        );
    }

    #[tokio::test]
    async fn responses_only_models_fall_back_to_translated_chat_completions() {
        let (path, _) = route(ProviderKind::OpencodeZen, "gpt-x", chat_ok()).await;
        assert_eq!(path, "/zen/v1/chat/completions");
    }

    #[tokio::test]
    async fn go_has_no_gemini_route_so_gemini_models_use_chat() {
        let (path, _) = route(ProviderKind::OpencodeGo, "gemini-x", chat_ok()).await;
        assert_eq!(path, "/zen/v1/chat/completions");
    }

    #[tokio::test]
    async fn unknown_models_take_chat_completions() {
        // The real catalogue lookup against an unseeded catalogue.
        let (base, log) = serve_at("/zen/v1", vec![chat_ok()]).await;
        let p = OpencodeGatewayProvider::new(ProviderKind::OpencodeZen, &key(), Some(base), None);
        p.stream_completion(request("brand-new-model"), sink())
            .await
            .unwrap();
        assert!(log.lock().unwrap()[0]
            .head
            .starts_with("POST /zen/v1/chat/completions "));
    }

    #[tokio::test]
    async fn every_wire_carries_session_headers_the_ua_and_its_own_auth() {
        let zen = ProviderKind::OpencodeZen;
        for (model, response, auth) in [
            ("kimi-k3", chat_ok(), "authorization: bearer public"),
            ("claude-x", anthropic_ok(), "x-api-key: public"),
            ("gemini-x", gemini_ok(), "x-goog-api-key: public"),
        ] {
            let (_, head) = route(zen, model, response).await;
            assert!(head.contains(auth), "{model}: {head}");
            for h in [
                "x-opencode-session: sess-123",
                "x-session-affinity: sess-123",
                "x-opencode-client: ferrisscope",
                "user-agent: ferrisscope/",
            ] {
                assert!(head.contains(h), "{model} missing `{h}`: {head}");
            }
        }
    }

    #[tokio::test]
    async fn no_session_header_without_a_session_but_the_client_is_still_named() {
        let (base, log) = serve_at("/zen/v1", vec![chat_ok()]).await;
        let p = OpencodeGatewayProvider::new(ProviderKind::OpencodeGo, &key(), Some(base), None)
            .with_wire_fn(wires);
        p.stream_completion(request("kimi-k3"), sink())
            .await
            .unwrap();
        let head = log.lock().unwrap()[0].head.to_ascii_lowercase();
        assert!(!head.contains("x-opencode-session"), "{head}");
        assert!(!head.contains("x-session-affinity"), "{head}");
        assert!(head.contains("x-opencode-client: ferrisscope"), "{head}");
    }

    #[tokio::test]
    async fn listing_uses_the_gateways_own_models_endpoint() {
        let (base, log) = serve_at(
            "/zen/v1",
            vec![json_response(
                "200 OK",
                r#"{"data":[{"id":"big-pickle"},{"id":"claude-x"}]}"#,
            )],
        )
        .await;
        let p = OpencodeGatewayProvider::new(ProviderKind::OpencodeZen, &key(), Some(base), None);
        let ids: Vec<String> = p
            .list_models()
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["big-pickle", "claude-x"]);
        assert!(log.lock().unwrap()[0]
            .head
            .starts_with("GET /zen/v1/models "));
    }

    #[tokio::test]
    async fn a_wrong_wire_refusal_retries_once_on_chat_completions() {
        let mismatch = json_response(
            "401 Unauthorized",
            r#"{"type":"error","error":{"type":"ModelError","message":"Model claude-x is not supported for format anthropic"}}"#,
        );
        let (base, log) = serve_at("/zen/v1", vec![mismatch, chat_ok()]).await;
        let p = OpencodeGatewayProvider::new(ProviderKind::OpencodeZen, &key(), Some(base), None)
            .with_wire_fn(wires);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink: EventSink = Box::new(move |e| sink_events.lock().unwrap().push(e));
        let out = p
            .stream_completion(request("claude-x"), sink)
            .await
            .unwrap();
        assert_eq!(out.finish_reason, crate::provider::FinishReason::Stop);

        let sent = log.lock().unwrap();
        assert!(sent[0].head.starts_with("POST /zen/v1/messages "));
        assert!(sent[1].head.starts_with("POST /zen/v1/chat/completions "));
        // The retry's text reached the same sink the caller supplied.
        assert!(matches!(&events.lock().unwrap()[0], CompletionEvent::TokenDelta(t) if t == "ok"));
    }

    #[tokio::test]
    async fn other_native_wire_errors_are_not_retried() {
        let bad_key = json_response(
            "401 Unauthorized",
            r#"{"type":"error","error":{"type":"AuthError","message":"Invalid API key"}}"#,
        );
        let (base, log) = serve_at("/zen/v1", vec![bad_key]).await;
        let p = OpencodeGatewayProvider::new(ProviderKind::OpencodeZen, &key(), Some(base), None)
            .with_wire_fn(wires);
        let err = p
            .stream_completion(request("claude-x"), sink())
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Auth(_)), "{err:?}");
        assert_eq!(log.lock().unwrap().len(), 1, "no second request");
    }

    #[test]
    fn only_the_wrong_format_message_counts_as_a_wire_mismatch() {
        let e = |b: &str| ProviderError::Http {
            status: Some(400),
            body: b.into(),
        };
        assert!(is_wire_mismatch(&ProviderError::Auth(
            "Model x is not supported for format google".into()
        )));
        assert!(is_wire_mismatch(&e(
            "Model y is not supported for format anthropic"
        )));
        assert!(!is_wire_mismatch(&e("Model y is not supported")));
        assert!(!is_wire_mismatch(&e("rate limited")));
        assert!(!is_wire_mismatch(&ProviderError::Cancelled));
    }

    #[tokio::test]
    async fn non_chat_models_are_not_offered() {
        let (base, _) = serve_at(
            "/zen/v1",
            vec![json_response(
                "200 OK",
                r#"{"data":[{"id":"big-pickle"},{"id":"jev-1.13"},{"id":"jev-1.13-free"},{"id":"kimi-k3"}]}"#,
            )],
        )
        .await;
        let p = OpencodeGatewayProvider::new(ProviderKind::OpencodeZen, &key(), Some(base), None);
        let ids: Vec<String> = p
            .list_models()
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["big-pickle", "kimi-k3"]);
    }

    #[test]
    fn names_follow_the_kind() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let zen = OpencodeGatewayProvider::new(ProviderKind::OpencodeZen, &key(), None, None);
        let go = OpencodeGatewayProvider::new(ProviderKind::OpencodeGo, &key(), None, None);
        assert_eq!(zen.name(), "opencode_zen");
        assert_eq!(go.name(), "opencode_go");
    }

    #[tokio::test]
    async fn only_the_gateways_send_a_session_id_other_providers_never_see_it() {
        // The session id is shared with OpenCode's gateways and nobody else.
        use crate::provider::gateway_headers;
        for kind in ProviderKind::all() {
            let h = gateway_headers(*kind, Some("sess"));
            assert_eq!(!h.is_empty(), kind.is_opencode_gateway(), "{kind:?}");
        }
        let (base, log) = serve_at("/v1", vec![chat_ok()]).await;
        let p = OpenAICompatibleProvider::for_kind(
            ProviderKind::Groq,
            &key(),
            Some(base),
            Some("sess-123".into()),
        );
        p.stream_completion(request("llama"), sink()).await.unwrap();
        let head = log.lock().unwrap()[0].head.to_ascii_lowercase();
        assert!(!head.contains("sess-123"), "{head}");
        assert!(!head.contains("x-opencode"), "{head}");
        // …but the User-Agent names the client everywhere.
        assert!(head.contains("user-agent: ferrisscope/"), "{head}");
    }
}
