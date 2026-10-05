use super::*;
use pretty_assertions::assert_eq;

fn choice(effort: Option<&str>, budget: Option<u32>) -> ProviderReasoning {
    ProviderReasoning {
        effort: effort.map(Into::into),
        budget_tokens: budget,
    }
}

fn efforts(list: &[&str]) -> ModelReasoning {
    ModelReasoning {
        efforts: names(list),
        ..ModelReasoning::default()
    }
}

fn budget_only(min: u32, max: Option<u32>) -> ModelReasoning {
    ModelReasoning {
        budget: Some((min, max)),
        ..ModelReasoning::default()
    }
}

fn run(
    kind: ProviderKind,
    model: &str,
    c: &ProviderReasoning,
    opts: Option<&ModelReasoning>,
) -> Option<Value> {
    lower_with(kind, model, Wire::OpenAiChat, c, false, opts, false)
}

// ─── spec ───────────────────────────────────────────────────────────────────

#[test]
fn budget_is_offered_only_where_a_provider_uses_one() {
    // The catalogue is unseeded in a unit test, so these are the static
    // fallbacks — the "show / hide the budget per provider" rule.
    for (kind, has_budget) in [
        (ProviderKind::Anthropic, true),
        (ProviderKind::CustomAnthropic, true),
        (ProviderKind::KimiCoding, true),
        (ProviderKind::Google, true),
        (ProviderKind::OpenRouter, true),
        (ProviderKind::OpenAI, false),
        (ProviderKind::Groq, false),
        (ProviderKind::Deepseek, false),
        (ProviderKind::Mistral, false),
        (ProviderKind::Ollama, false),
        (ProviderKind::CustomOpenAi, false),
    ] {
        let s = spec(kind, None);
        assert_eq!(s.budget.is_some(), has_budget, "{kind:?}");
        assert!(!s.efforts.is_empty(), "{kind:?} always has effort names");
        assert!(!s.from_catalogue);
    }
}

#[test]
fn spec_from_a_model_keeps_its_own_effort_names_and_budget_range() {
    let m = ModelReasoning {
        efforts: names(&["none", "low", "high", "max"]),
        toggle: true,
        budget: Some((128, Some(32_768))),
    };
    let s = ReasoningSpec::from_model(&m, true);
    assert_eq!(s.efforts, ["none", "low", "high", "max"]);
    assert!(s.toggle && s.from_catalogue);
    let b = s.budget.unwrap();
    assert_eq!((b.min, b.max), (128, Some(32_768)));
    assert_eq!(b.presets, [1_024, 2_048, 4_096, 8_192, 16_384, 32_768]);
}

#[test]
fn budget_presets_stay_inside_the_range() {
    assert_eq!(
        presets(1_024, None),
        [1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536]
    );
    assert_eq!(presets(0, Some(5_000)), [1_024, 2_048, 4_096]);
    // Nothing on the ladder fits: offer the floor itself.
    assert_eq!(presets(5_000, Some(6_000)), [5_000]);
}

#[test]
fn a_model_with_no_options_has_an_empty_spec() {
    assert!(ReasoningSpec::from_model(&ModelReasoning::default(), true).is_empty());
    assert!(!spec(ProviderKind::OpenAI, None).is_empty());
}

// ─── effort resolution ──────────────────────────────────────────────────────

#[test]
fn an_effort_the_model_lacks_maps_to_the_nearest_lower_on_a_tie() {
    let s = names(&["low", "medium", "high"]);
    assert_eq!(nearest_effort("high", &s).as_deref(), Some("high"));
    assert_eq!(nearest_effort("xhigh", &s).as_deref(), Some("high"));
    assert_eq!(nearest_effort("max", &s).as_deref(), Some("high"));
    assert_eq!(nearest_effort("minimal", &s).as_deref(), Some("low"));
    // Equidistant between two levels → the lower one.
    let gap = names(&["low", "high"]);
    assert_eq!(nearest_effort("medium", &gap).as_deref(), Some("low"));
    // A model that can't turn thinking off gives no "none".
    assert_eq!(nearest_effort("none", &s), None);
    assert_eq!(
        nearest_effort("none", &names(&["none", "low"])).as_deref(),
        Some("none")
    );
    // Unknown levels (an empty list) pass through.
    assert_eq!(nearest_effort("wild", &[]).as_deref(), Some("wild"));
}

#[test]
fn claude_versions_parse_in_both_id_orders_and_ignore_release_dates() {
    for (id, want) in [
        ("claude-opus-4-7", Some((4, 7))),
        ("claude-opus-4.7", Some((4, 7))),
        ("claude-4.7-opus", Some((4, 7))),
        ("claude-sonnet-5-5", Some((5, 5))),
        ("claude-sonnet-5", Some((5, 0))),
        ("claude-opus-4-20250514", Some((4, 0))),
        ("claude-3-7-sonnet-20250219", Some((3, 7))),
        ("claude-haiku-4-5", Some((4, 5))),
        ("anthropic/claude-opus-4.6", Some((4, 6))),
        ("kimi-for-coding", None),
    ] {
        assert_eq!(claude_version(id), want, "{id}");
    }
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

#[test]
fn modern_claude_gets_adaptive_thinking_with_an_effort() {
    let opts = efforts(&["low", "medium", "high", "xhigh", "max"]);
    let out = run(
        ProviderKind::Anthropic,
        "claude-sonnet-5-5",
        &choice(Some("xhigh"), None),
        Some(&opts),
    )
    .unwrap();
    assert_eq!(
        out,
        json!({ "thinking": { "type": "adaptive" }, "output_config": { "effort": "xhigh" } })
    );
}

#[test]
fn a_saved_level_the_claude_lacks_is_lowered_not_rejected() {
    // 4.6 stops at `max` but has no `xhigh`.
    let opts = efforts(&["low", "medium", "high", "max"]);
    let out = run(
        ProviderKind::Anthropic,
        "claude-opus-4-6",
        &choice(Some("xhigh"), None),
        Some(&opts),
    )
    .unwrap();
    assert_eq!(out["output_config"]["effort"], "high");
}

#[test]
fn none_disables_thinking_explicitly_because_some_claudes_default_it_on() {
    let opts = efforts(&["low", "high"]);
    let out = run(
        ProviderKind::Anthropic,
        "claude-sonnet-5",
        &choice(Some("none"), None),
        Some(&opts),
    )
    .unwrap();
    assert_eq!(out, json!({ "thinking": { "type": "disabled" } }));
}

#[test]
fn budget_only_claude_takes_an_explicit_budget_or_one_derived_from_the_effort() {
    let opts = budget_only(1_024, None);
    let m = "claude-haiku-4-5";
    let k = ProviderKind::Anthropic;
    assert_eq!(
        run(k, m, &choice(Some("medium"), None), Some(&opts)).unwrap(),
        json!({ "thinking": { "type": "enabled", "budget_tokens": 16_384 } })
    );
    // An explicit budget wins over the effort, and respects the floor.
    assert_eq!(
        run(k, m, &choice(Some("low"), Some(20_000)), Some(&opts)).unwrap()["thinking"]
            ["budget_tokens"],
        20_000
    );
    assert_eq!(
        run(k, m, &choice(None, Some(100)), Some(&opts)).unwrap()["thinking"]["budget_tokens"],
        1_024
    );
    // `none` and "nothing chosen" send nothing.
    assert_eq!(run(k, m, &choice(Some("none"), None), Some(&opts)), None);
    assert_eq!(run(k, m, &choice(None, None), Some(&opts)), None);
}

#[test]
fn a_budget_is_never_applied_to_an_effort_capable_claude_alone() {
    // Budget only, no effort name: adaptive models have nothing to apply it to.
    let opts = efforts(&["low", "high"]);
    assert_eq!(
        run(
            ProviderKind::Anthropic,
            "claude-sonnet-5",
            &choice(None, Some(8_000)),
            Some(&opts)
        ),
        None
    );
}

#[test]
fn opus_45_sends_both_a_budget_and_an_effort() {
    let opts = efforts(&["low", "medium", "high"]);
    let out = run(
        ProviderKind::Anthropic,
        "claude-opus-4-5",
        &choice(Some("high"), None),
        Some(&opts),
    )
    .unwrap();
    assert_eq!(
        out,
        json!({ "thinking": { "type": "enabled", "budget_tokens": 16_000 }, "output_config": { "effort": "high" } })
    );
}

#[test]
fn style_falls_back_to_the_model_id_when_the_catalogue_is_silent() {
    let k = ProviderKind::Anthropic;
    // 4.7+ → adaptive with the full level list.
    let new = run(k, "claude-opus-4-7", &choice(Some("max"), None), None).unwrap();
    assert_eq!(new["thinking"]["type"], "adaptive");
    assert_eq!(new["output_config"]["effort"], "max");
    // 4.6 has no xhigh.
    assert_eq!(
        run(k, "claude-opus-4-6", &choice(Some("xhigh"), None), None).unwrap()["output_config"]
            ["effort"],
        "high"
    );
    // Older → budget.
    assert_eq!(
        run(
            k,
            "claude-3-7-sonnet-20250219",
            &choice(Some("low"), None),
            None
        )
        .unwrap(),
        json!({ "thinking": { "type": "enabled", "budget_tokens": 4_096 } })
    );
    // An unversioned Claude id is a new model.
    assert_eq!(
        run(k, "claude-fable", &choice(Some("high"), None), None).unwrap()["thinking"]["type"],
        "adaptive"
    );
}

#[test]
fn non_claude_anthropic_wire_models_use_a_budget() {
    // Kimi For Coding speaks Messages but isn't a Claude.
    let out = run(
        ProviderKind::KimiCoding,
        "kimi-for-coding",
        &choice(Some("high"), None),
        None,
    )
    .unwrap();
    assert_eq!(
        out,
        json!({ "thinking": { "type": "enabled", "budget_tokens": 32_768 } })
    );
}

#[test]
fn budgets_clamp_to_the_models_range() {
    let opts = budget_only(1_024, Some(8_192));
    let out = run(
        ProviderKind::Anthropic,
        "claude-haiku-4-5",
        &choice(None, Some(50_000)),
        Some(&opts),
    )
    .unwrap();
    assert_eq!(out["thinking"]["budget_tokens"], 8_192);
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────

#[test]
fn openai_uses_the_models_own_levels_including_none_and_xhigh() {
    let opts = efforts(&["none", "low", "medium", "high", "xhigh"]);
    let k = ProviderKind::OpenAI;
    let pick = |e| run(k, "gpt-5.4", &choice(Some(e), None), Some(&opts));
    assert_eq!(
        pick("xhigh").unwrap(),
        json!({ "reasoning_effort": "xhigh" })
    );
    assert_eq!(pick("none").unwrap(), json!({ "reasoning_effort": "none" }));
    assert_eq!(pick("max").unwrap(), json!({ "reasoning_effort": "xhigh" }));
}

#[test]
fn openai_models_without_a_none_level_ignore_none() {
    let opts = efforts(&["minimal", "low", "medium", "high"]);
    assert_eq!(
        run(
            ProviderKind::OpenAI,
            "gpt-5-mini",
            &choice(Some("none"), None),
            Some(&opts)
        ),
        None
    );
}

#[test]
fn codex_oauth_uses_the_responses_shape() {
    let opts = efforts(&["low", "medium", "high"]);
    let out = lower_with(
        ProviderKind::OpenAI,
        "gpt-5.3-codex",
        Wire::OpenAiChat,
        &choice(Some("high"), None),
        true,
        Some(&opts),
        false,
    )
    .unwrap();
    assert_eq!(out, json!({ "reasoning": { "effort": "high" } }));
}

#[test]
fn openai_with_no_catalogue_entry_offers_the_classic_levels() {
    let k = ProviderKind::OpenAI;
    assert_eq!(
        run(k, "gpt-new", &choice(Some("xhigh"), None), None).unwrap(),
        json!({ "reasoning_effort": "high" })
    );
    assert_eq!(run(k, "gpt-new", &choice(Some("none"), None), None), None);
}

// ─── OpenAI-compatible family ───────────────────────────────────────────────

#[test]
fn compat_providers_map_to_the_levels_the_model_has() {
    // DeepSeek V4: only high | max.
    let ds = efforts(&["high", "max"]);
    let k = ProviderKind::Deepseek;
    assert_eq!(
        run(k, "deepseek-v4-pro", &choice(Some("low"), None), Some(&ds)).unwrap(),
        json!({ "reasoning_effort": "high" })
    );
    assert_eq!(
        run(k, "deepseek-v4-pro", &choice(Some("max"), None), Some(&ds)).unwrap(),
        json!({ "reasoning_effort": "max" })
    );
}

#[test]
fn toggle_only_and_budget_only_compat_models_get_no_reasoning_effort() {
    let toggle = ModelReasoning {
        toggle: true,
        ..ModelReasoning::default()
    };
    let k = ProviderKind::Zai;
    assert_eq!(
        run(k, "glm-x", &choice(Some("high"), None), Some(&toggle)),
        None
    );
    assert_eq!(
        run(
            k,
            "glm-x",
            &choice(Some("high"), None),
            Some(&budget_only(1_024, None))
        ),
        None
    );
}

#[test]
fn compat_with_unknown_models_sends_low_medium_high() {
    let k = ProviderKind::Groq;
    assert_eq!(
        run(k, "new-model", &choice(Some("medium"), None), None).unwrap(),
        json!({ "reasoning_effort": "medium" })
    );
    assert_eq!(
        run(k, "new-model", &choice(Some("xhigh"), None), None).unwrap(),
        json!({ "reasoning_effort": "high" })
    );
    assert_eq!(
        run(k, "new-model", &choice(None, Some(4_096)), None),
        None,
        "no budget for compat"
    );
}

// ─── OpenRouter / Gemini ────────────────────────────────────────────────────

#[test]
fn openrouter_takes_an_effort_or_a_token_cap_never_both() {
    let k = ProviderKind::OpenRouter;
    assert_eq!(
        run(k, "m", &choice(Some("high"), Some(8_000)), None).unwrap(),
        json!({ "reasoning": { "effort": "high" } })
    );
    assert_eq!(
        run(k, "m", &choice(None, Some(8_000)), None).unwrap(),
        json!({ "reasoning": { "max_tokens": 8_000 } })
    );
    assert_eq!(run(k, "m", &choice(None, None), None), None);
}

#[test]
fn gemini_receives_the_choice_untouched_for_the_provider_to_translate() {
    let k = ProviderKind::Google;
    assert_eq!(
        run(
            k,
            "gemini-3.5-flash",
            &choice(Some("minimal"), Some(2_000)),
            None
        )
        .unwrap(),
        json!({ "reasoning": { "effort": "minimal", "budget_tokens": 2_000 } })
    );
}

// ─── gateways, gating ───────────────────────────────────────────────────────

#[test]
fn gateway_models_lower_by_their_native_wire() {
    let go = |kind, wire, model| {
        lower_with(
            kind,
            model,
            wire,
            &choice(Some("high"), None),
            false,
            None,
            false,
        )
    };
    let zen = ProviderKind::OpencodeZen;
    // A Claude on the Messages wire: adaptive; a non-Claude there: a budget.
    assert_eq!(
        go(zen, Wire::AnthropicMessages, "claude-sonnet-5").unwrap()["thinking"]["type"],
        "adaptive"
    );
    assert_eq!(
        go(zen, Wire::AnthropicMessages, "minimax-m3").unwrap()["thinking"]["type"],
        "enabled"
    );
    assert_eq!(
        go(zen, Wire::Gemini, "gemini-3-flash").unwrap(),
        json!({ "reasoning": { "effort": "high" } })
    );
    assert_eq!(
        go(zen, Wire::OpenAiChat, "kimi-k3").unwrap(),
        json!({ "reasoning_effort": "high" })
    );
    assert_eq!(
        go(zen, Wire::OpenAiResponses, "gpt-5.5").unwrap(),
        json!({ "reasoning_effort": "high" })
    );
    // Go has no native Gemini route, so a Gemini-wire model uses chat completions.
    assert_eq!(
        go(ProviderKind::OpencodeGo, Wire::Gemini, "gemini-3-flash").unwrap(),
        json!({ "reasoning_effort": "high" })
    );
}

#[test]
fn a_known_non_reasoning_model_gets_nothing_but_one_with_options_does() {
    let c = choice(Some("high"), None);
    let none = lower_with(
        ProviderKind::Groq,
        "m",
        Wire::OpenAiChat,
        &c,
        false,
        None,
        true,
    );
    assert_eq!(none, None);
    let listed = efforts(&["low", "high"]);
    assert!(lower_with(
        ProviderKind::Groq,
        "m",
        Wire::OpenAiChat,
        &c,
        false,
        Some(&listed),
        true
    )
    .is_some());
}

#[test]
fn nothing_chosen_means_nothing_sent_for_every_provider() {
    for kind in ProviderKind::all() {
        assert_eq!(
            run(*kind, "any-model", &choice(None, None), None),
            None,
            "{kind:?}"
        );
    }
}
