//! Gemini provider hot paths on a large synthetic session: tool-schema
//! conversion, request-body build, and SSE chunk parsing.
//!
//! `cargo run --release -p ferrisscope-agent --example geminibench`

use std::time::{Duration, Instant};

use ferrisscope_agent::provider::gemini::{build_request_body, Gates, StreamState};
use ferrisscope_agent::provider::gemini_schema;
use ferrisscope_agent::types::{ChatMessage, MessageRole, ToolCall, ToolSchema};
use ferrisscope_agent::{CompletionEvent, CompletionRequest};
use serde_json::{json, Value};

const TOOLS: usize = 60;
const TURNS: usize = 200;
const CHUNKS: usize = 2_000;

fn tool_schema(i: usize) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "namespace": { "type": "string", "description": format!("namespace for tool {i}") },
            "name": { "type": "string", "minLength": 1 },
            "replicas": { "type": "integer", "enum": [0, 1, 2, 3] },
            "labels": { "type": "object", "additionalProperties": { "type": "string" } },
            "selectors": { "type": "array", "items": { "type": "object", "properties": {
                "key": { "type": "string" }, "values": { "type": "array" } },
                "required": ["key", "ghost"] } },
            "mode": { "anyOf": [{ "type": "string", "enum": ["a", "b"] }, { "type": ["number", "null"] }] },
        },
        "required": ["namespace", "name", "ghost"],
    })
}

fn transcript() -> Vec<ChatMessage> {
    let mut msgs = vec![ChatMessage {
        role: MessageRole::System,
        content: "You are a Kubernetes operator assistant. ".repeat(60),
        ..Default::default()
    }];
    for i in 0..TURNS {
        msgs.push(ChatMessage {
            role: MessageRole::User,
            content: format!("why is pod web-{i} crashlooping? ").repeat(4),
            ..Default::default()
        });
        msgs.push(ChatMessage {
            role: MessageRole::Assistant,
            tool_calls: vec![ToolCall {
                id: format!("call_{i}"),
                name: "fs_pod_diagnose".into(),
                arguments: json!({ "namespace": "default", "name": format!("web-{i}") })
                    .to_string(),
                thought_signature: Some("S".repeat(400)),
            }],
            ..Default::default()
        });
        msgs.push(ChatMessage {
            role: MessageRole::Tool,
            content: "container restarted 5 times; OOMKilled; ".repeat(40),
            tool_call_id: Some(format!("call_{i}")),
            ..Default::default()
        });
        msgs.push(ChatMessage {
            role: MessageRole::Assistant,
            content: "The container is being OOMKilled; raise the memory limit. ".repeat(8),
            ..Default::default()
        });
    }
    msgs
}

fn chunks() -> Vec<String> {
    (0..CHUNKS)
        .map(|i| {
            if i % 40 == 39 {
                json!({ "candidates": [{ "content": { "role": "model", "parts": [{
                    "functionCall": { "name": "fs_pod_list", "args": { "namespace": "default", "i": i } },
                    "thoughtSignature": "S".repeat(400) }] } }] })
            } else {
                json!({ "candidates": [{ "content": { "role": "model", "parts": [{
                    "text": "Looking at the container status and recent events now. " }] } }],
                    "usageMetadata": { "promptTokenCount": 12000, "candidatesTokenCount": i,
                                       "thoughtsTokenCount": 300, "totalTokenCount": 12300 + i } })
            }
            .to_string()
        })
        .collect()
}

fn time<T>(label: &str, iters: u32, mut f: impl FnMut() -> T) {
    let _ = f(); // warm-up
    let start = Instant::now();
    for _ in 0..iters {
        std::hint::black_box(f());
    }
    let per: Duration = start.elapsed() / iters;
    println!("{label:<46} {per:>12.2?} / iter  ({iters} iters)");
}

fn main() {
    let schemas: Vec<Value> = (0..TOOLS).map(tool_schema).collect();
    time(&format!("convert {TOOLS} tool schemas"), 200, || {
        schemas.iter().map(gemini_schema::convert).count()
    });

    let req = CompletionRequest {
        model: "gemini-3.5-flash".into(),
        messages: transcript(),
        tools: schemas
            .iter()
            .enumerate()
            .map(|(i, p)| ToolSchema {
                name: format!("fs_tool_{i}"),
                description: "does a thing".into(),
                parameters: p.clone(),
            })
            .collect(),
        temperature: Some(0.2),
        max_tokens: Some(8192),
        provider_options: Some(json!({ "reasoning": { "effort": "high" } })),
    };
    let body_len = build_request_body(&req, Gates::permissive())
        .to_string()
        .len();
    println!(
        "request body: {} messages, {TOOLS} tools, {} KiB",
        req.messages.len(),
        body_len / 1024
    );
    time("build_request_body (transcript + tools)", 50, || {
        build_request_body(&req, Gates::permissive())
    });
    time("  ... and serialise to JSON", 50, || {
        build_request_body(&req, Gates::permissive()).to_string()
    });

    let data = chunks();
    let bytes: usize = data.iter().map(String::len).sum();
    println!("stream: {CHUNKS} chunks, {} KiB", bytes / 1024);
    time("serde_json::Value parse only (baseline)", 50, || {
        data.iter()
            .filter_map(|c| serde_json::from_str::<Value>(c).ok())
            .count()
    });
    let sink: ferrisscope_agent::provider::EventSink = Box::new(|e: CompletionEvent| {
        std::hint::black_box(e);
    });
    time("StreamState::on_data over the whole stream", 50, || {
        let mut state = StreamState::new();
        for c in &data {
            state.on_data(c, &sink).unwrap();
        }
        state.finish().tool_calls.len()
    });
}
