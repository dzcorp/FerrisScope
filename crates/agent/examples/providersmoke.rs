//! Live two-turn tool-call smoke test for one provider/model.
//!
//! ```text
//! PROVIDER_API_KEY=… cargo run -p ferrisscope-agent --example providersmoke -- \
//!     <provider-id> <model> [base-url]
//! ```
//!
//! `provider-id` is a `ProviderKind` id (`google`, `opencode_zen`,
//! `opencode_go`, `anthropic`, `groq`, …). Zen defaults the key to its public
//! free-tier key. The models.dev cache is read from `MODELS_DEV_DIR` (default
//! `~/.config/ferrisscope/agent`) so the per-model wire lookup works.
//!
//! The conversation is synthetic — nothing from a real cluster is sent:
//! turn 1 asks for a tool call; turn 2 replays it with a canned tool result
//! and expects prose. That second turn is the one that exercises Gemini's
//! `thoughtSignature` round trip.

use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use ferrisscope_agent::provider::anthropic::AnthropicProvider;
use ferrisscope_agent::provider::catalogue;
use ferrisscope_agent::provider::gateway::OpencodeGatewayProvider;
use ferrisscope_agent::provider::gemini::GeminiProvider;
use ferrisscope_agent::provider::openai_compat::OpenAICompatibleProvider;
use ferrisscope_agent::types::{ChatMessage, MessageRole, ToolSchema};
use ferrisscope_agent::{
    ChatProvider, CompletionEvent, CompletionRequest, Credential, FinishReason, ProviderFlavor,
    ProviderKind,
};
use serde_json::json;

fn build(kind: ProviderKind, key: String, base: Option<String>) -> Box<dyn ChatProvider> {
    let cred = Credential::ApiKey { key };
    let session = Some("providersmoke".to_string());
    if kind.is_opencode_gateway() {
        return Box::new(OpencodeGatewayProvider::new(kind, &cred, base, session));
    }
    match ferrisscope_agent::provider::meta::for_kind(kind).flavor {
        ProviderFlavor::GeminiGenerate => {
            Box::new(GeminiProvider::new(&cred, base).with_session(session.as_deref()))
        }
        ProviderFlavor::AnthropicMessages => {
            Box::new(AnthropicProvider::new(&cred, base, kind).with_session(session.as_deref()))
        }
        _ => Box::new(OpenAICompatibleProvider::for_kind(
            kind, &cred, base, session,
        )),
    }
}

fn msg(role: MessageRole, content: &str) -> ChatMessage {
    ChatMessage {
        role,
        content: content.into(),
        ..Default::default()
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(id), Some(model)) = (args.first(), args.get(1)) else {
        eprintln!("usage: providersmoke <provider-id> <model> [base-url]");
        return ExitCode::from(2);
    };
    let Some(kind) = ProviderKind::from_id(id) else {
        eprintln!("unknown provider id `{id}`");
        return ExitCode::from(2);
    };
    let key = std::env::var("PROVIDER_API_KEY")
        .ok()
        .or_else(|| kind.public_fallback_key().map(str::to_string))
        .unwrap_or_default();

    let dir = std::env::var("MODELS_DEV_DIR").unwrap_or_else(|_| {
        format!(
            "{}/.config/ferrisscope/agent",
            std::env::var("HOME").unwrap_or_default()
        )
    });
    catalogue::load_from_disk(dir.into()).await;
    println!("{id} / {model}  wire={:?}", catalogue::wire(kind, model));

    let provider = build(kind, key, args.get(2).cloned());
    match provider.list_models().await {
        Ok(models) => println!(
            "list_models: {} models (has {model}: {})",
            models.len(),
            models.iter().any(|m| &m.id == model)
        ),
        Err(e) => println!("list_models: FAILED {e}"),
    }

    let tool = ToolSchema {
        name: "list_pods".into(),
        description: "List the pods in a Kubernetes namespace.".into(),
        parameters: json!({
            "type": "object",
            "properties": { "namespace": { "type": "string", "description": "namespace" } },
            "required": ["namespace"],
            "additionalProperties": false
        }),
    };
    let mut messages = vec![
        msg(MessageRole::System, "You are a terse Kubernetes assistant."),
        msg(
            MessageRole::User,
            "Use the list_pods tool for namespace `demo`. Do not answer in text first.",
        ),
    ];
    let request = |messages: &[ChatMessage]| CompletionRequest {
        model: model.clone(),
        messages: messages.to_vec(),
        tools: vec![tool.clone()],
        temperature: None,
        max_tokens: Some(1024),
        provider_options: None,
    };
    let sink = |text: Arc<Mutex<String>>| -> ferrisscope_agent::provider::EventSink {
        Box::new(move |e| {
            if let CompletionEvent::TokenDelta(t) = e {
                text.lock().unwrap().push_str(&t);
            }
        })
    };

    // Turn 1: expect a tool call.
    let text = Arc::new(Mutex::new(String::new()));
    let first = match provider
        .stream_completion(request(&messages), sink(text.clone()))
        .await
    {
        Ok(f) => f,
        Err(e) => {
            println!("turn 1: FAILED {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "turn 1: finish={:?} tool_calls={} signature={} usage={:?}",
        first.finish_reason,
        first.tool_calls.len(),
        first
            .tool_calls
            .first()
            .and_then(|c| c.thought_signature.as_ref())
            .map_or("none".to_string(), |s| format!("{} bytes", s.len())),
        first.usage.as_ref().map(|u| u.total_tokens)
    );
    let Some(call) = first.tool_calls.first().cloned() else {
        println!("turn 1: no tool call (text: {:?})", text.lock().unwrap());
        return ExitCode::FAILURE;
    };
    println!("  call: {}({})", call.name, call.arguments);

    // Turn 2: replay the call (with its signature) + a canned result.
    messages.push(ChatMessage {
        role: MessageRole::Assistant,
        tool_calls: first.tool_calls.clone(),
        ..Default::default()
    });
    messages.push(ChatMessage {
        role: MessageRole::Tool,
        content: "web-1 Running\nweb-2 CrashLoopBackOff".into(),
        tool_call_id: Some(call.id.clone()),
        name: Some(call.name.clone()),
        ..Default::default()
    });
    let text = Arc::new(Mutex::new(String::new()));
    let second = match provider
        .stream_completion(request(&messages), sink(text.clone()))
        .await
    {
        Ok(f) => f,
        Err(e) => {
            println!("turn 2: FAILED {e}");
            return ExitCode::FAILURE;
        }
    };
    let answer = text.lock().unwrap().clone();
    println!(
        "turn 2: finish={:?} text={:?}",
        second.finish_reason,
        answer.chars().take(160).collect::<String>()
    );
    if second.finish_reason == FinishReason::Stop && !answer.trim().is_empty() {
        println!("OK");
        ExitCode::SUCCESS
    } else {
        println!("turn 2: expected a prose answer");
        ExitCode::FAILURE
    }
}
