use super::*;
use crate::provider::test_util::{json_response, serve, sse_response};
use crate::types::{ImageAttachment, ToolSchema};
use pretty_assertions::assert_eq;
use std::sync::{Arc, Mutex};

// ─── helpers ────────────────────────────────────────────────────────────────

fn user(text: &str) -> ChatMessage {
    ChatMessage {
        role: MessageRole::User,
        content: text.into(),
        ..Default::default()
    }
}

fn assistant(text: &str, calls: Vec<ToolCall>) -> ChatMessage {
    ChatMessage {
        role: MessageRole::Assistant,
        content: text.into(),
        tool_calls: calls,
        ..Default::default()
    }
}

fn call(id: &str, name: &str, args: &str, sig: Option<&str>) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args.into(),
        thought_signature: sig.map(Into::into),
    }
}

fn tool_result(id: &str, name: Option<&str>, text: &str) -> ChatMessage {
    ChatMessage {
        role: MessageRole::Tool,
        content: text.into(),
        tool_call_id: Some(id.into()),
        name: name.map(Into::into),
        ..Default::default()
    }
}

fn request(model: &str, messages: Vec<ChatMessage>) -> CompletionRequest {
    CompletionRequest {
        model: model.into(),
        messages,
        tools: vec![],
        temperature: None,
        max_tokens: None,
        provider_options: None,
    }
}

fn collecting_sink() -> (EventSink, Arc<Mutex<Vec<CompletionEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let sink: EventSink = Box::new(move |e| sink_events.lock().unwrap().push(e));
    (sink, events)
}

fn feed(chunks: &[Value]) -> (CompletionFinal, Vec<CompletionEvent>) {
    let (sink, events) = collecting_sink();
    let mut state = StreamState::new();
    for c in chunks {
        state.on_data(&c.to_string(), &sink).unwrap();
    }
    let out = state.finish();
    let events = events.lock().unwrap().clone();
    (out, events)
}

// ─── model ids, paths, listing ──────────────────────────────────────────────

#[test]
fn model_path_prefixes_bare_ids_only() {
    assert_eq!(model_path("gemini-2.5-pro"), "models/gemini-2.5-pro");
    assert_eq!(model_path("models/gemini-2.5-pro"), "models/gemini-2.5-pro");
    assert_eq!(model_path("tunedModels/my-tune"), "tunedModels/my-tune");
}

#[test]
fn chat_model_filter_drops_speech_image_video_music_embedding_and_realtime() {
    for id in [
        "gemini-2.5-flash",
        "gemini-3.1-pro-preview",
        "gemini-flash-latest",
        "gemma-4-31b-it",
    ] {
        assert!(is_chat_model_id(id), "{id}");
    }
    for id in [
        "gemini-2.5-flash-preview-tts",
        "gemini-3-pro-image-preview",
        "gemini-embedding-001",
        "gemini-3.1-flash-live-preview",
        "veo-3.1-generate-preview",
        "lyria-3-pro-preview",
        "gemini-2.5-computer-use-preview-10-2025",
        "deep-research-preview-04-2026",
        "gemini-omni-flash-preview",
        "aqa",
    ] {
        assert!(!is_chat_model_id(id), "{id}");
    }
}

#[test]
fn models_page_keeps_generate_content_chat_models_and_strips_the_prefix() {
    let body = json!({
        "models": [
            { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro",
              "inputTokenLimit": 1048576, "supportedGenerationMethods": ["generateContent", "countTokens"] },
            { "name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"] },
            { "name": "models/gemini-2.5-flash-preview-tts", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/imagen-4", "supportedGenerationMethods": ["predict"] },
            { "name": "models/legacy", "supportedGenerationMethods": [] },
        ],
        "nextPageToken": "page2"
    })
    .to_string();
    let (models, next) = parse_models_page(&body).unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "gemini-2.5-pro");
    assert_eq!(models[0].name.as_deref(), Some("Gemini 2.5 Pro"));
    assert_eq!(models[0].context_length, Some(1_048_576));
    assert_eq!(next.as_deref(), Some("page2"));
}

#[test]
fn models_page_without_token_or_models_is_the_last_and_empty() {
    assert_eq!(parse_models_page("{}").unwrap().1, None);
    assert_eq!(
        parse_models_page(r#"{"nextPageToken":""}"#).unwrap().1,
        None
    );
    assert!(parse_models_page("<html>").is_err());
}

#[test]
fn invalid_key_is_an_auth_error_not_a_generic_400() {
    let body = r#"{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}"#;
    assert!(matches!(
        http_error(400, body.into()),
        ProviderError::Auth(_)
    ));
    assert!(matches!(
        http_error(400, "bad request".into()),
        ProviderError::Http {
            status: Some(400),
            ..
        }
    ));
    assert!(matches!(
        http_error(401, "x".into()),
        ProviderError::Auth(_)
    ));
    assert!(matches!(
        http_error(429, "quota".into()),
        ProviderError::Http {
            status: Some(429),
            ..
        }
    ));
}

// ─── thinking config ────────────────────────────────────────────────────────

#[test]
fn gemini_25_takes_a_clamped_token_budget() {
    let cfg = |m, e, b| thinking_config(m, e, b);
    assert_eq!(
        cfg("gemini-2.5-pro", Some("high"), None),
        Some(json!({ "thinkingBudget": 32768 }))
    );
    assert_eq!(
        cfg("gemini-2.5-flash", Some("high"), None),
        Some(json!({ "thinkingBudget": 24576 }))
    );
    assert_eq!(
        cfg("gemini-2.5-flash", Some("low"), None),
        Some(json!({ "thinkingBudget": 4096 }))
    );
    assert_eq!(
        cfg("gemini-2.5-flash", Some("medium"), None),
        Some(json!({ "thinkingBudget": 16000 }))
    );
    // An explicit budget wins over effort, and is clamped to the model's range.
    assert_eq!(
        cfg("gemini-2.5-flash", Some("low"), Some(9000)),
        Some(json!({ "thinkingBudget": 9000 }))
    );
    assert_eq!(
        cfg("gemini-2.5-flash", None, Some(99_999)),
        Some(json!({ "thinkingBudget": 24576 }))
    );
    // 2.5 Pro can't think below 128.
    assert_eq!(
        cfg("gemini-2.5-pro", None, Some(1)),
        Some(json!({ "thinkingBudget": 128 }))
    );
    // A resource-style id resolves the same way.
    assert_eq!(
        cfg("models/gemini-2.5-pro", Some("low"), None),
        Some(json!({ "thinkingBudget": 4096 }))
    );
}

#[test]
fn off_and_minimal_efforts_map_per_generation() {
    let cfg = |m, e| thinking_config(m, Some(e), None);
    // 2.5: a zero budget where allowed, Pro's floor otherwise.
    assert_eq!(
        cfg("gemini-2.5-flash", "none"),
        Some(json!({ "thinkingBudget": 0 }))
    );
    assert_eq!(
        cfg("gemini-2.5-pro", "none"),
        Some(json!({ "thinkingBudget": 128 }))
    );
    assert_eq!(
        cfg("gemini-2.5-flash", "minimal"),
        Some(json!({ "thinkingBudget": 1024 }))
    );
    // 3+: Flash has `minimal`, Pro stops at `low`.
    assert_eq!(
        cfg("gemini-3.5-flash", "none"),
        Some(json!({ "thinkingLevel": "minimal" }))
    );
    assert_eq!(
        cfg("gemini-3.5-flash", "minimal"),
        Some(json!({ "thinkingLevel": "minimal" }))
    );
    assert_eq!(
        cfg("gemini-3.1-pro-preview", "minimal"),
        Some(json!({ "thinkingLevel": "low" }))
    );
    // The upper names collapse to the top level / budget.
    assert_eq!(
        cfg("gemini-3.1-pro-preview", "max"),
        Some(json!({ "thinkingLevel": "high" }))
    );
    assert_eq!(
        cfg("gemini-2.5-pro", "xhigh"),
        Some(json!({ "thinkingBudget": 32768 }))
    );
}

#[test]
fn gemini_3_takes_a_level_and_pro_has_no_medium() {
    let cfg = |m, e, b| thinking_config(m, e, b);
    assert_eq!(
        cfg("gemini-3.5-flash", Some("medium"), None),
        Some(json!({ "thinkingLevel": "medium" }))
    );
    assert_eq!(
        cfg("gemini-3.1-pro-preview", Some("medium"), None),
        Some(json!({ "thinkingLevel": "high" }))
    );
    assert_eq!(
        cfg("gemini-3.1-pro-preview", Some("low"), None),
        Some(json!({ "thinkingLevel": "low" }))
    );
    assert_eq!(
        cfg("gemini-3.1-pro-preview", Some("high"), None),
        Some(json!({ "thinkingLevel": "high" }))
    );
    // Budget only → bucketed into a level; no knobs → nothing.
    assert_eq!(
        cfg("gemini-3.5-flash", None, Some(2000)),
        Some(json!({ "thinkingLevel": "low" }))
    );
    assert_eq!(
        cfg("gemini-3.5-flash", None, Some(20000)),
        Some(json!({ "thinkingLevel": "high" }))
    );
    assert_eq!(cfg("gemini-3.5-flash", None, None), None);
}

#[test]
fn models_without_a_known_thinking_shape_get_no_config() {
    for id in [
        "gemini-2.0-flash",
        "gemini-flash-latest",
        "gemma-4-31b-it",
        "gemini-1.5-pro",
        "weird",
    ] {
        assert_eq!(thinking_config(id, Some("high"), Some(8000)), None, "{id}");
    }
}

// ─── request building ───────────────────────────────────────────────────────

#[test]
fn system_messages_become_system_instruction_not_contents() {
    let msgs = vec![
        ChatMessage {
            role: MessageRole::System,
            content: "Be terse.".into(),
            ..Default::default()
        },
        user("hi"),
    ];
    let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
    assert_eq!(
        body["systemInstruction"],
        json!({ "parts": [{ "text": "Be terse." }] })
    );
    assert_eq!(
        body["contents"],
        json!([{ "role": "user", "parts": [{ "text": "hi" }] }])
    );
}

#[test]
fn tool_round_trip_pairs_responses_to_calls_in_one_user_turn() {
    let msgs = vec![
        user("list pods and nodes"),
        assistant(
            "",
            vec![
                call(
                    "c1",
                    "list_pods",
                    r#"{"namespace":"default"}"#,
                    Some("SIG1"),
                ),
                call("c2", "list_nodes", "{}", None),
            ],
        ),
        // Name resolved from the call id when the message carries none.
        tool_result("c1", None, "pods…"),
        tool_result("c2", Some("list_nodes"), "nodes…"),
    ];
    let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
    assert_eq!(
        body["contents"],
        json!([
            { "role": "user", "parts": [{ "text": "list pods and nodes" }] },
            { "role": "model", "parts": [
                { "functionCall": { "name": "list_pods", "args": { "namespace": "default" } },
                  "thoughtSignature": "SIG1" },
                { "functionCall": { "name": "list_nodes", "args": {} } },
            ]},
            { "role": "user", "parts": [
                { "functionResponse": { "name": "list_pods",
                    "response": { "name": "list_pods", "content": "pods…" } } },
                { "functionResponse": { "name": "list_nodes",
                    "response": { "name": "list_nodes", "content": "nodes…" } } },
            ]},
        ])
    );
}

#[test]
fn signature_is_replayed_verbatim_and_never_invented_before_gemini_3() {
    let msgs = |sig| vec![user("go"), assistant("", vec![call("c1", "t", "{}", sig)])];
    let contents = |m: &str, sig| {
        build_request_body(&request(m, msgs(sig)), Gates::permissive())["contents"].clone()
    };

    let kept = contents("gemini-3.1-pro-preview", Some("REAL"));
    assert_eq!(kept[1]["parts"][0]["thoughtSignature"], "REAL");
    // 2.5 doesn't validate signatures: nothing is added when we have none.
    let none = contents("gemini-2.5-pro", None);
    assert!(none[1]["parts"][0].get("thoughtSignature").is_none());
}

#[test]
fn gemini_3_gets_the_documented_bypass_on_the_first_unsigned_call_only() {
    let msgs = vec![
        user("go"),
        assistant(
            "",
            vec![call("a", "t1", "{}", None), call("b", "t2", "{}", None)],
        ),
    ];
    let body = build_request_body(&request("gemini-3.5-flash", msgs), Gates::permissive());
    let parts = &body["contents"][1]["parts"];
    assert_eq!(parts[0]["thoughtSignature"], SKIP_SIGNATURE);
    assert!(
        parts[1].get("thoughtSignature").is_none(),
        "parallel calls after the first carry none"
    );
}

#[test]
fn malformed_or_non_object_arguments_become_an_empty_object() {
    for bad in ["", "not json", "[1,2]", "\"s\"", "null"] {
        let msgs = vec![user("go"), assistant("", vec![call("c", "t", bad, None)])];
        let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
        assert_eq!(
            body["contents"][1]["parts"][0]["functionCall"]["args"],
            json!({}),
            "{bad:?}"
        );
    }
}

#[test]
fn unnamed_tool_result_with_unknown_call_falls_back_to_a_generic_name() {
    let msgs = vec![
        user("x"),
        assistant("", vec![call("c1", "real", "{}", None)]),
        tool_result("ghost", None, "r"),
    ];
    let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
    assert_eq!(
        body["contents"][2]["parts"][0]["functionResponse"]["name"],
        "tool"
    );
}

#[test]
fn user_text_after_tool_results_stays_its_own_turn() {
    // A message queued while the tools ran must not fold into the turn of
    // function responses (Gemini checks that turn's response count).
    let msgs = vec![
        user("go"),
        assistant("", vec![call("c1", "t", "{}", None)]),
        tool_result("c1", Some("t"), "r"),
        user("also check nodes"),
    ];
    let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
    let contents = body["contents"].as_array().unwrap();
    assert_eq!(contents.len(), 4);
    assert!(contents[2]["parts"][0].get("functionResponse").is_some());
    assert_eq!(contents[2]["parts"].as_array().unwrap().len(), 1);
    assert_eq!(contents[3]["parts"][0]["text"], "also check nodes");
}

#[test]
fn an_empty_tool_result_reads_as_success_not_as_nothing() {
    let msgs = vec![
        user("go"),
        assistant("", vec![call("c1", "t", "{}", None)]),
        tool_result("c1", Some("t"), "  \n"),
    ];
    let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
    assert_eq!(
        body["contents"][2]["parts"][0]["functionResponse"]["response"]["content"],
        "Tool executed successfully."
    );
}

#[test]
fn gemma_gets_its_system_text_in_the_first_user_turn_not_system_instruction() {
    let msgs = |first: ChatMessage| {
        vec![
            ChatMessage {
                role: MessageRole::System,
                content: "Be terse.".into(),
                ..Default::default()
            },
            first,
        ]
    };
    let body = build_request_body(
        &request("gemma-4-31b-it", msgs(user("hi"))),
        Gates::permissive(),
    );
    assert!(body.get("systemInstruction").is_none());
    assert_eq!(
        body["contents"][0]["parts"],
        json!([{ "text": "Be terse.\n\n" }, { "text": "hi" }])
    );
    // Same for a resource-style id; Gemini models keep the real field.
    let body = build_request_body(
        &request("models/gemma-4-31b-it", msgs(user("hi"))),
        Gates::permissive(),
    );
    assert!(body.get("systemInstruction").is_none());
    let gemini = build_request_body(
        &request("gemini-2.5-pro", msgs(user("hi"))),
        Gates::permissive(),
    );
    assert_eq!(gemini["systemInstruction"]["parts"][0]["text"], "Be terse.");
    // No user turn at all: one is created to carry it.
    let only = build_request_body(
        &request(
            "gemma-4-31b-it",
            vec![ChatMessage {
                role: MessageRole::System,
                content: "S".into(),
                ..Default::default()
            }],
        ),
        Gates::permissive(),
    );
    assert_eq!(only["contents"][0]["role"], "user");
}

#[test]
fn a_schema_rejection_names_the_tool_behind_the_index() {
    let tools = vec![
        tool("alpha", json!({})),
        tool("beta", json!({})),
        tool("gamma", json!({})),
    ];
    let body = r#"{"error":{"code":400,"message":"* GenerateContentRequest.tools[0].function_declarations[1].parameters.properties[queries].items: missing field.\n"}}"#;
    let err = name_rejected_tool(
        ProviderError::Http {
            status: Some(400),
            body: body.into(),
        },
        &tools,
    );
    let ProviderError::Http { body, .. } = err else {
        panic!()
    };
    assert!(
        body.contains("function_declarations[1]"),
        "original text kept: {body}"
    );
    assert!(body.contains("tool `beta`"), "{body}");
    assert!(body.contains("disable it"), "{body}");
}

#[test]
fn only_a_400_with_a_valid_declaration_index_is_annotated() {
    let tools = vec![tool("alpha", json!({}))];
    let marker = "tools[0].function_declarations[0].parameters: bad";
    for err in [
        ProviderError::Http {
            status: Some(500),
            body: marker.into(),
        },
        ProviderError::Http {
            status: Some(400),
            body: "function_declarations[9]".into(),
        },
        ProviderError::Http {
            status: Some(400),
            body: "something else".into(),
        },
        ProviderError::Auth(marker.into()),
    ] {
        let before = err.to_string();
        assert_eq!(name_rejected_tool(err, &tools).to_string(), before);
    }
    assert!(name_rejected_tool(
        ProviderError::Http {
            status: Some(400),
            body: marker.into()
        },
        &tools
    )
    .to_string()
    .contains("tool `alpha`"));
}

#[test]
fn empty_turns_are_skipped_and_adjacent_same_role_turns_merge() {
    let msgs = vec![
        user("one"),
        user(""),
        user("two"),
        assistant("", vec![]),
        assistant("answer", vec![]),
    ];
    let body = build_request_body(&request("gemini-2.5-pro", msgs), Gates::permissive());
    assert_eq!(
        body["contents"],
        json!([
            { "role": "user", "parts": [{ "text": "one" }, { "text": "two" }] },
            { "role": "model", "parts": [{ "text": "answer" }] },
        ])
    );
}

#[test]
fn images_become_inline_data_or_a_note_when_the_model_is_text_only() {
    let mut msg = user("what is this?");
    msg.images = vec![ImageAttachment {
        mime: "image/png".into(),
        data: "AAAA".into(),
    }];
    let with = build_request_body(
        &request("gemini-2.5-pro", vec![msg.clone()]),
        Gates::permissive(),
    );
    assert_eq!(
        with["contents"][0]["parts"],
        json!([
            { "text": "what is this?" },
            { "inlineData": { "mimeType": "image/png", "data": "AAAA" } },
        ])
    );

    let gates = Gates {
        vision: false,
        ..Gates::permissive()
    };
    let without = build_request_body(&request("gemma-4-31b-it", vec![msg]), gates);
    let parts = without["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert!(parts[0]["text"].as_str().unwrap().contains("omitted"));
}

fn tool(name: &str, params: Value) -> ToolSchema {
    ToolSchema {
        name: name.into(),
        description: format!("{name} tool"),
        parameters: params,
    }
}

#[test]
fn tools_become_function_declarations_with_sanitised_schemas() {
    let mut req = request("gemini-2.5-pro", vec![user("x")]);
    req.tools = vec![
        tool(
            "scale",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "replicas": { "type": "integer", "enum": [1, 2] } },
                "required": ["replicas", "ghost"]
            }),
        ),
        tool("ping", json!({ "type": "object", "properties": {} })),
    ];
    let body = build_request_body(&req, Gates::permissive());
    let decls = &body["tools"][0]["functionDeclarations"];
    assert_eq!(decls[0]["name"], "scale");
    assert_eq!(
        decls[0]["parameters"],
        json!({
            "type": "object",
            "properties": { "replicas": { "type": "string", "enum": ["1", "2"] } },
            "required": ["replicas"]
        })
    );
    assert!(
        decls[1].get("parameters").is_none(),
        "parameter-less tool omits `parameters`"
    );
}

#[test]
fn regression_array_of_objects_keeps_items_in_the_request_body() {
    // Reported: `function_declarations[5].parameters.properties[queries].items:
    // missing field`. An MCP tool taking a list of free-form objects.
    let mut req = request("gemini-3.5-flash", vec![user("x")]);
    req.tools = vec![tool(
        "query_batch",
        json!({
            "type": "object",
            "properties": { "queries": { "type": "array", "items": { "type": "object" } } },
            "required": ["queries"]
        }),
    )];
    let body = build_request_body(&req, Gates::permissive());
    assert_eq!(
        body["tools"][0]["functionDeclarations"][0]["parameters"]["properties"]["queries"],
        json!({ "type": "array", "items": { "type": "object" } })
    );
}

#[test]
fn tools_are_omitted_for_models_that_cannot_call_them() {
    let mut req = request("gemini-2.5-flash-image", vec![user("x")]);
    req.tools = vec![tool("t", json!({}))];
    let gates = Gates {
        tools: false,
        ..Gates::permissive()
    };
    assert!(build_request_body(&req, gates).get("tools").is_none());
}

#[test]
fn generation_config_carries_limits_and_gates_temperature() {
    let mut req = request("gemini-2.5-pro", vec![user("x")]);
    req.max_tokens = Some(4096);
    req.temperature = Some(0.3);
    let on = build_request_body(&req, Gates::permissive());
    assert_eq!(
        on["generationConfig"],
        json!({ "maxOutputTokens": 4096, "temperature": 0.3 })
    );

    let gates = Gates {
        temperature: false,
        ..Gates::permissive()
    };
    let off = build_request_body(&req, gates);
    assert_eq!(off["generationConfig"], json!({ "maxOutputTokens": 4096 }));

    let bare = build_request_body(
        &request("gemini-2.5-pro", vec![user("x")]),
        Gates::permissive(),
    );
    assert!(bare.get("generationConfig").is_none());
}

#[test]
fn universal_reasoning_knobs_become_thinking_config_and_never_leak_as_a_top_level_key() {
    let mut req = request("gemini-2.5-flash", vec![user("x")]);
    req.provider_options = Some(json!({ "reasoning": { "effort": "low" } }));
    let body = build_request_body(&req, Gates::permissive());
    assert_eq!(
        body["generationConfig"]["thinkingConfig"],
        json!({ "thinkingBudget": 4096 })
    );
    assert!(body.get("reasoning").is_none());
}

#[test]
fn reasoning_is_dropped_for_models_not_known_to_think() {
    let mut req = request("gemini-2.0-flash", vec![user("x")]);
    req.provider_options = Some(json!({ "reasoning": { "effort": "high" } }));
    let gates = Gates {
        thinking: false,
        ..Gates::permissive()
    };
    let body = build_request_body(&req, gates);
    assert!(body.get("generationConfig").is_none());
    assert!(body.get("reasoning").is_none());
}

#[test]
fn operator_native_options_are_merged_last_and_win() {
    let mut req = request("gemini-2.5-flash", vec![user("x")]);
    req.max_tokens = Some(100);
    req.provider_options = Some(json!({
        "reasoning": { "effort": "low" },
        "generationConfig": { "maxOutputTokens": 900, "thinkingConfig": { "thinkingBudget": 1 } },
        "safetySettings": [{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" }]
    }));
    let body = build_request_body(&req, Gates::permissive());
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 900);
    assert_eq!(
        body["generationConfig"]["thinkingConfig"],
        json!({ "thinkingBudget": 1 })
    );
    assert_eq!(body["safetySettings"][0]["threshold"], "BLOCK_NONE");
}

#[test]
fn gates_are_permissive_for_unknown_models_except_thinking() {
    let g = Gates::from_capabilities(None);
    assert!(g.vision && g.temperature && g.tools);
    assert!(
        !g.thinking,
        "never send a thinking field to a model we know nothing about"
    );
    let known = catalogue::ModelCapabilities {
        reasoning: true,
        tool_call: false,
        temperature: false,
        vision: false,
        interleaved_field: None,
        wire: catalogue::Wire::Gemini,
        reasoning_options: None,
    };
    let g = Gates::from_capabilities(Some(&known));
    assert!(g.thinking && !g.tools && !g.temperature && !g.vision);
}

// ─── stream parsing ─────────────────────────────────────────────────────────

#[test]
fn text_streams_as_deltas_and_finishes_with_stop_and_usage() {
    let (out, events) = feed(&[
        json!({ "candidates": [{ "content": { "role": "model", "parts": [{ "text": "Hel" }] } }] }),
        json!({ "candidates": [{ "content": { "parts": [{ "text": "lo" }] }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 4,
                                   "thoughtsTokenCount": 6, "totalTokenCount": 20 } }),
    ]);
    let text: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            CompletionEvent::TokenDelta(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, ["Hel", "lo"]);
    assert_eq!(out.finish_reason, FinishReason::Stop);
    let usage = out.usage.unwrap();
    // Thoughts count as output: Gemini reports them separately from candidates.
    assert_eq!(
        (
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens
        ),
        (10, 10, 20)
    );
    assert!(out.tool_calls.is_empty());
    assert_eq!(out.reasoning_content, None);
}

#[test]
fn total_tokens_falls_back_to_the_sum_when_not_reported() {
    let (out, _) = feed(&[json!({
        "candidates": [{ "content": { "parts": [{ "text": "x" }] }, "finishReason": "STOP" }],
        "usageMetadata": { "promptTokenCount": 7, "candidatesTokenCount": 3 }
    })]);
    assert_eq!(out.usage.unwrap().total_tokens, 10);
}

#[test]
fn thought_summaries_are_neither_shown_nor_kept() {
    let (out, events) = feed(&[json!({
        "candidates": [{ "content": { "parts": [
            { "text": "thinking about pods…", "thought": true, "thoughtSignature": "T" },
            { "text": "Answer." },
        ] }, "finishReason": "STOP" }]
    })]);
    let text: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            CompletionEvent::TokenDelta(t) => Some(t.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(text, ["Answer."]);
    assert_eq!(out.reasoning_content, None);
}

#[test]
fn function_call_emits_start_args_end_and_keeps_its_signature() {
    let (out, events) = feed(&[json!({
        "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "list_pods", "args": { "namespace": "kube-system" } },
              "thoughtSignature": "SIG-A" },
        ] }, "finishReason": "STOP" }]
    })]);
    assert_eq!(out.tool_calls.len(), 1);
    let tc = &out.tool_calls[0];
    assert_eq!(tc.name, "list_pods");
    assert_eq!(
        serde_json::from_str::<Value>(&tc.arguments).unwrap(),
        json!({ "namespace": "kube-system" })
    );
    assert_eq!(tc.thought_signature.as_deref(), Some("SIG-A"));
    assert!(tc.id.starts_with("call_"));
    // STOP + a call means the model wants the tool run.
    assert_eq!(out.finish_reason, FinishReason::ToolCalls);

    let kinds: Vec<&str> = events
        .iter()
        .map(|e| match e {
            CompletionEvent::ToolCallStart { .. } => "start",
            CompletionEvent::ToolCallArgsDelta { .. } => "args",
            CompletionEvent::ToolCallEnd { .. } => "end",
            CompletionEvent::TokenDelta(_) => "text",
        })
        .collect();
    assert_eq!(kinds, ["start", "args", "end"]);
    let ids: Vec<&str> = events
        .iter()
        .map(|e| match e {
            CompletionEvent::ToolCallStart { id, .. }
            | CompletionEvent::ToolCallArgsDelta { id, .. }
            | CompletionEvent::ToolCallEnd { id } => id.as_str(),
            CompletionEvent::TokenDelta(_) => "",
        })
        .collect();
    assert!(ids.iter().all(|i| *i == tc.id));
}

#[test]
fn parallel_calls_keep_only_the_signature_gemini_sent_and_get_distinct_ids() {
    let (out, _) = feed(&[json!({
        "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "a", "args": {} }, "thoughtSignature": "ONLY-FIRST" },
            { "functionCall": { "name": "b", "args": {} } },
        ] } }]
    })]);
    assert_eq!(
        out.tool_calls[0].thought_signature.as_deref(),
        Some("ONLY-FIRST")
    );
    assert_eq!(out.tool_calls[1].thought_signature, None);
    assert_ne!(out.tool_calls[0].id, out.tool_calls[1].id);
}

#[test]
fn ids_are_unique_across_responses_so_history_never_collides() {
    let one = || {
        feed(&[json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "t", "args": {} } }] } }] })]).0
    };
    assert_ne!(one().tool_calls[0].id, one().tool_calls[0].id);
}

#[test]
fn a_server_supplied_call_id_is_kept() {
    let (out, _) = feed(&[json!({
        "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "t", "args": {}, "id": "srv-1" } }] } }]
    })]);
    assert_eq!(out.tool_calls[0].id, "srv-1");
}

#[test]
fn call_without_args_gets_an_empty_object() {
    let (out, _) = feed(&[json!({
        "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "t" } }] } }]
    })]);
    assert_eq!(out.tool_calls[0].arguments, "{}");
}

#[test]
fn finish_reasons_map_to_the_loops_vocabulary() {
    let reason = |r: &str| {
        feed(&[json!({ "candidates": [{ "finishReason": r }] })])
            .0
            .finish_reason
    };
    assert_eq!(reason("STOP"), FinishReason::Stop);
    assert_eq!(reason("MAX_TOKENS"), FinishReason::Length);
    for r in [
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
    ] {
        assert_eq!(reason(r), FinishReason::ContentFilter, "{r}");
    }
    assert_eq!(reason("MALFORMED_FUNCTION_CALL"), FinishReason::Other);
    assert_eq!(reason("SOMETHING_NEW"), FinishReason::Other);
    assert_eq!(feed(&[]).0.finish_reason, FinishReason::Stop);
}

#[test]
fn a_blocked_prompt_finishes_as_content_filter() {
    let (out, _) = feed(&[json!({ "promptFeedback": { "blockReason": "SAFETY" } })]);
    assert_eq!(out.finish_reason, FinishReason::ContentFilter);
}

#[test]
fn in_stream_error_fails_the_round_with_vendor_text_and_code() {
    let (sink, _) = collecting_sink();
    let mut state = StreamState::new();
    let err = state
        .on_data(
            r#"{"error":{"code":429,"message":"Quota exceeded for metric","status":"RESOURCE_EXHAUSTED"}}"#,
            &sink,
        )
        .unwrap_err();
    match err {
        ProviderError::Http { status, body } => {
            assert_eq!(status, Some(429));
            assert!(body.contains("Quota exceeded"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn unparseable_and_candidate_free_chunks_are_skipped() {
    let (sink, events) = collecting_sink();
    let mut state = StreamState::new();
    state.on_data("not json at all", &sink).unwrap();
    state.on_data("{}", &sink).unwrap();
    state
        .on_data(
            r#"{"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}"#,
            &sink,
        )
        .unwrap();
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(state.finish().usage.unwrap().total_tokens, 2);
}

// ─── against a local server ─────────────────────────────────────────────────

fn provider(base: &str) -> GeminiProvider {
    GeminiProvider::new(
        &Credential::ApiKey {
            key: "AIza-test".into(),
        },
        Some(base.into()),
    )
}

#[tokio::test]
async fn streams_a_tool_call_turn_end_to_end_and_authenticates_by_header() {
    let (base, log) = serve(vec![sse_response(&[
        json!({ "candidates": [{ "content": { "parts": [{ "text": "Checking." }] } }] }),
        json!({ "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "list_pods", "args": { "namespace": "default" } }, "thoughtSignature": "SIG" }
        ] }, "finishReason": "STOP" }],
          "usageMetadata": { "promptTokenCount": 5, "candidatesTokenCount": 2, "totalTokenCount": 7 } }),
    ])])
    .await;

    let mut req = request("gemini-3.5-flash", vec![user("pods?")]);
    req.tools = vec![tool(
        "list_pods",
        json!({ "type": "object", "properties": { "namespace": { "type": "string" } } }),
    )];
    let (sink, events) = collecting_sink();
    let out = provider(&base).stream_completion(req, sink).await.unwrap();

    assert_eq!(out.finish_reason, FinishReason::ToolCalls);
    assert_eq!(out.tool_calls[0].thought_signature.as_deref(), Some("SIG"));
    assert_eq!(out.usage.unwrap().total_tokens, 7);
    assert!(
        matches!(&events.lock().unwrap()[0], CompletionEvent::TokenDelta(t) if t == "Checking.")
    );

    let sent = log.lock().unwrap();
    let head = sent[0].head.to_ascii_lowercase();
    assert!(
        head.starts_with("post /v1beta/models/gemini-3.5-flash:streamgeneratecontent?alt=sse "),
        "{head}"
    );
    assert!(head.contains("x-goog-api-key: aiza-test"), "{head}");
    assert!(!head.contains("authorization"), "{head}");
    assert!(
        !head.contains("key="),
        "the key must never ride in the URL: {head}"
    );
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body["contents"][0]["parts"][0]["text"], "pods?");
    assert_eq!(
        body["tools"][0]["functionDeclarations"][0]["name"],
        "list_pods"
    );
}

#[tokio::test]
async fn an_oauth_style_credential_authenticates_with_a_bearer_header() {
    let (base, log) = serve(vec![sse_response(&[
        json!({ "candidates": [{ "finishReason": "STOP" }] }),
    ])])
    .await;
    let p = GeminiProvider::new(
        &Credential::OAuth {
            access: "ya29.tok".into(),
            refresh: String::new(),
            expires_at_unix_ms: 0,
            account_id: None,
        },
        Some(base),
    );
    let (sink, _) = collecting_sink();
    p.stream_completion(request("gemini-2.5-pro", vec![user("x")]), sink)
        .await
        .unwrap();
    let head = log.lock().unwrap()[0].head.to_ascii_lowercase();
    assert!(head.contains("authorization: bearer ya29.tok"), "{head}");
    assert!(!head.contains("x-goog-api-key"), "{head}");
}

#[tokio::test]
async fn a_bad_key_surfaces_as_an_auth_error() {
    let (base, _) = serve(vec![json_response(
        "400 Bad Request",
        r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","details":[{"reason":"API_KEY_INVALID"}]}}"#,
    )])
    .await;
    let (sink, _) = collecting_sink();
    let err = provider(&base)
        .stream_completion(request("gemini-2.5-pro", vec![user("x")]), sink)
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Auth(_)), "{err:?}");
}

#[tokio::test]
async fn http_failures_keep_their_numeric_status() {
    let (base, _) = serve(vec![json_response(
        "503 Service Unavailable",
        r#"{"error":{"code":503,"message":"overloaded"}}"#,
    )])
    .await;
    let (sink, _) = collecting_sink();
    let err = provider(&base)
        .stream_completion(request("gemini-2.5-pro", vec![user("x")]), sink)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            ProviderError::Http {
                status: Some(503),
                ..
            }
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn an_error_chunk_mid_stream_fails_the_round() {
    let (base, _) = serve(vec![sse_response(&[
        json!({ "candidates": [{ "content": { "parts": [{ "text": "partial" }] } }] }),
        json!({ "error": { "code": 500, "message": "Internal error encountered." } }),
    ])])
    .await;
    let (sink, _) = collecting_sink();
    let err = provider(&base)
        .stream_completion(request("gemini-2.5-pro", vec![user("x")]), sink)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            ProviderError::Http {
                status: Some(500),
                ..
            }
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn model_listing_follows_pages_filters_junk_and_asks_for_big_pages() {
    let page = |models: Value, next: Option<&str>| {
        let mut v = json!({ "models": models });
        if let Some(n) = next {
            v["nextPageToken"] = json!(n);
        }
        json_response("200 OK", &v.to_string())
    };
    let (base, log) = serve(vec![
        page(
            json!([
                { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro", "supportedGenerationMethods": ["generateContent"] },
                { "name": "models/gemini-embedding-001", "supportedGenerationMethods": ["embedContent"] },
            ]),
            Some("tok=="),
        ),
        page(
            json!([{ "name": "models/gemini-3.5-flash", "supportedGenerationMethods": ["generateContent"] }]),
            None,
        ),
    ])
    .await;

    let models = provider(&base).list_models().await.unwrap();
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["gemini-2.5-pro", "gemini-3.5-flash"]);

    let sent = log.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert!(
        sent[0].head.contains("GET /v1beta/models?pageSize=1000 "),
        "{}",
        sent[0].head
    );
    // The opaque token is percent-encoded into the next request.
    assert!(
        sent[1].head.contains("pageToken=tok%3D%3D"),
        "{}",
        sent[1].head
    );
    assert!(sent[1]
        .head
        .to_ascii_lowercase()
        .contains("x-goog-api-key: aiza-test"));
}

#[tokio::test]
async fn model_listing_falls_back_to_the_static_list_when_the_live_call_fails() {
    // The catalogue is unseeded in a unit test, so the static list is the floor.
    let (base, _) = serve(vec![json_response("500 Internal Server Error", "{}")]).await;
    let models = provider(&base).list_models().await.unwrap();
    assert!(models.iter().any(|m| m.id == "gemini-2.5-pro"));
}

#[tokio::test]
async fn a_trailing_slash_on_the_base_url_does_not_double_up() {
    let (base, log) = serve(vec![sse_response(&[
        json!({ "candidates": [{ "finishReason": "STOP" }] }),
    ])])
    .await;
    let (sink, _) = collecting_sink();
    provider(&format!("{base}/"))
        .stream_completion(request("models/gemini-2.5-pro", vec![user("x")]), sink)
        .await
        .unwrap();
    let head = log.lock().unwrap()[0].head.clone();
    assert!(
        head.starts_with("POST /v1beta/models/gemini-2.5-pro:streamGenerateContent"),
        "{head}"
    );
}
