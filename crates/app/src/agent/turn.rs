//! `agent::turn` — see `agent/mod.rs` for the split rationale.

use std::sync::Arc;

use ferrisscope_agent::provider::anthropic::AnthropicProvider;
use ferrisscope_agent::provider::meta::{self, ProviderFlavor};
use ferrisscope_agent::provider::openai_codex::{CredentialSink, OpenAICodexProvider};
use ferrisscope_agent::provider::openai_compat::OpenAICompatibleProvider;
use ferrisscope_agent::session::{SessionError, SessionEvent, SessionStore};
use ferrisscope_agent::types::{ChatMessage, MessageRole, ToolSchema};
use ferrisscope_agent::{
    classify_tool, AgentSettings, ChatProvider, CompletionEvent, CompletionRequest, Credential,
    FinishReason, ProviderError, ProviderKind, ReasoningEffort, ToolCall,
};
use tokio::sync::Mutex;

use crate::state::AppState;

use super::{
    assemble_system_prompt, build_cluster_context_block, build_view_context_block,
    context_limits_for, execute_tool_call, is_context_overflow_error, is_transient_error,
    maybe_run_compaction, maybe_spill, redact_secrets, repair_orphan_tool_calls,
    run_compaction_internal, tools_to_schemas, transient_retry_delay_ms, ChatEvent, ChatRuntime,
    PersistedSettings,
};

/// Hard cap on tool-call rounds within a single user turn. Defends against
/// the model getting stuck in a `tool_calls`-only loop (we've seen models do
/// this with poorly described tool schemas). On hitting the cap we return
/// the partial transcript and let the operator nudge the model with a
/// follow-up message. Sized for genuine multi-step investigations — listing
/// every namespace's pods + tailing logs across them comfortably uses
/// dozens of rounds.
const MAX_TOOL_ROUNDS: u32 = 500;

/// If the chat has no in-flight turn AND the last persisted message is an
/// Assistant turn, append a synthetic user "Continue …" message and spawn
/// the regular run loop. Idempotent: if the loop is running we no-op (the
/// running loop will see the post-compaction state on its next iteration).
///
/// The synthetic message uses `name: Some("auto_continue")` so future
/// reload heuristics (auto-title, etc.) can recognise it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn autocontinue_if_idle(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    cluster_id: &str,
    session_id: &str,
    app_state: &AppState,
    persisted: &PersistedSettings,
    cred: &Credential,
    kind: ProviderKind,
) {
    // Eligibility check + push happen under one lock so a concurrent
    // `chat_send_message` either lands first (and our spawn no-ops) or
    // after (their message coexists with ours; the loop drains both).
    let user_message = ChatMessage {
        role: MessageRole::User,
        content: AUTO_CONTINUE_PROMPT.to_string(),
        tool_calls: vec![],
        tool_call_id: None,
        name: Some(AUTO_CONTINUE_NAME.to_string()),
        reasoning_content: None,
        images: vec![],
    };
    let should_spawn = {
        let mut g = runtime.lock().await;
        if g.cancel.is_some() {
            return;
        }
        // Last message must be Assistant (otherwise either the chat is
        // brand new — odd, but handle anyway — or the previous turn left
        // us mid-tool, in which case the loop should pick that up first
        // rather than asking for "next steps").
        match g.messages.last() {
            Some(m) if matches!(m.role, MessageRole::Assistant) => {
                // If the assistant message has unanswered tool_calls, the
                // repair pass on the next loop iteration will pad them;
                // we still want to autocontinue so the model reacts.
                g.messages.push(user_message.clone());
                true
            }
            _ => false,
        }
    };
    if !should_spawn {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Message {
                message: user_message,
                ts: now,
            },
        )
        .await;

    // System prompt rebuild — the active cluster could have changed since
    // the last turn (agent may have called `fs_configuration_use_context`
    // mid-session). View context reuses the last snapshot from the
    // operator's most recent send; autocontinue is synthetic so there's
    // nothing fresher to use.
    let (cluster_ctx, view_snapshot) = {
        let rt = runtime.lock().await;
        (rt.cluster.clone(), rt.last_view_context.clone())
    };
    let cluster_block = build_cluster_context_block(&cluster_ctx, app_state).await;
    let active_cluster = cluster_ctx.active().await;
    let view_block =
        build_view_context_block(view_snapshot.as_ref(), &active_cluster, app_state).await;
    let system_prompt = assemble_system_prompt(
        &cluster_block,
        &view_block,
        persisted.settings.system_prompt_override.as_deref(),
    );
    let is_oauth = matches!(cred, Credential::OAuth { .. });
    let provider_options_default = resolve_provider_options(kind, &persisted.settings, is_oauth);

    let runtime_clone = runtime.clone();
    let store_clone = store.clone();
    let cluster_id_owned = cluster_id.to_string();
    let session_id_owned = session_id.to_string();
    let provider_clone = provider.clone();
    let join = tokio::spawn(async move {
        run_turn_loop(
            runtime_clone,
            store_clone,
            provider_clone,
            system_prompt,
            cluster_id_owned,
            session_id_owned,
            provider_options_default,
        )
        .await;
    });
    let abort = join.abort_handle();
    runtime.lock().await.cancel = Some(abort);
}

/// Synthetic user-message body injected after compaction so the agent
/// keeps working on the previous goal rather than parking with the
/// summary on screen. Phrased to give the model a clean exit if the
/// task is genuinely done.
const AUTO_CONTINUE_PROMPT: &str =
    "Continue from where you left off. If there are no remaining steps and the previous goal is satisfied, briefly say so and stop.";

/// Marker recorded on the synthetic user message so future code (or a
/// future UI affordance) can distinguish autocontinues from operator
/// input. Never displayed.
const AUTO_CONTINUE_NAME: &str = "auto_continue";

/// Construct the right `ChatProvider` impl for `kind`. Dispatches on the
/// provider's flavor metadata, with the special case that OpenAI flips
/// from Chat Completions (key mode) to the Codex Responses adapter
/// (OAuth mode) based on the credential type. `session_id` is plumbed
/// through to providers that need it as a request header (Codex);
/// `on_refresh` lets OAuth providers persist a rotated token back to
/// the keychain without the agent crate knowing about Tauri.
pub(crate) fn build_provider(
    kind: ProviderKind,
    cred: &Credential,
    base_url_override: Option<String>,
    session_id: Option<String>,
    on_refresh: Option<CredentialSink>,
) -> Result<Box<dyn ChatProvider>, String> {
    let m = meta::for_kind(kind);
    let oauth_mode = matches!(cred, Credential::OAuth { .. });
    let flavor = match (m.flavor, kind, oauth_mode) {
        // OpenAI + OAuth credential → Codex Responses adapter, regardless
        // of the metadata's default flavor (which is the API-key path).
        (_, ProviderKind::OpenAI, true) => ProviderFlavor::OpenAiResponses,
        (other, _, _) => other,
    };
    let provider: Box<dyn ChatProvider> = match flavor {
        ProviderFlavor::OpenAiCompat => Box::new(OpenAICompatibleProvider::for_kind(
            kind,
            cred,
            base_url_override,
            session_id.clone(),
        )),
        ProviderFlavor::AnthropicMessages => {
            Box::new(AnthropicProvider::new(cred, base_url_override))
        }
        ProviderFlavor::OpenAiResponses => {
            Box::new(OpenAICodexProvider::new(cred, session_id, on_refresh))
        }
    };
    Ok(provider)
}

pub(crate) fn session_err_to_string(e: SessionError) -> String {
    e.to_string()
}

/// Map the universal `ReasoningSettings` onto `kind`'s native request
/// shape. Each provider takes whichever knobs it understands and
/// silently drops the rest. Returning `None` when the operator hasn't
/// asked for anything keeps the request body free of empty objects
/// that some servers reject.
///
/// `is_oauth_codex` distinguishes OpenAI's two paths: API-key mode
/// hits Chat Completions which accepts `reasoning_effort`, while OAuth
/// mode hits the Codex Responses endpoint which rejects it (400
/// "Unsupported parameter") and only takes `reasoning: { effort }`.
pub(crate) fn resolve_provider_options(
    kind: ProviderKind,
    settings: &AgentSettings,
    is_oauth_codex: bool,
) -> Option<serde_json::Value> {
    let r = &settings.reasoning;
    if !r.is_active() {
        return None;
    }
    let effort_label = r.effort.map(|e| match e {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
    });
    let mut out = serde_json::Map::new();
    match kind {
        // Anthropic Messages: `thinking: { type, budget_tokens }`.
        // Effort is ignored — Anthropic doesn't have an `effort` field;
        // when only `effort` is set we use the Sonnet-recommended
        // 16k mid budget, scaling with the effort knob.
        ProviderKind::Anthropic => {
            let budget = r.budget_tokens.or_else(|| {
                effort_label.map(|e| match e {
                    "low" => 4096,
                    "medium" => 16384,
                    "high" => 32768,
                    _ => 16384,
                })
            });
            if let Some(b) = budget {
                out.insert(
                    "thinking".to_string(),
                    serde_json::json!({
                        "type": "enabled",
                        "budget_tokens": b,
                    }),
                );
            }
        }
        // OpenAI: shape depends on which endpoint we'll hit.
        // - Chat Completions (API key): `reasoning_effort` top-level.
        // - Codex Responses (OAuth): `reasoning: { effort }` only —
        //   unknown top-level params 400 there.
        ProviderKind::OpenAI => {
            if let Some(label) = effort_label {
                if is_oauth_codex {
                    out.insert(
                        "reasoning".to_string(),
                        serde_json::json!({ "effort": label }),
                    );
                } else {
                    out.insert("reasoning_effort".to_string(), serde_json::json!(label));
                }
            }
        }
        // OpenRouter exposes a unified `reasoning` field that takes
        // both effort and max_tokens — it forwards to whichever
        // upstream provider the model maps to.
        ProviderKind::OpenRouter => {
            let mut node = serde_json::Map::new();
            if let Some(label) = effort_label {
                node.insert("effort".to_string(), serde_json::json!(label));
            }
            if let Some(b) = r.budget_tokens {
                node.insert("max_tokens".to_string(), serde_json::json!(b));
            }
            if !node.is_empty() {
                out.insert("reasoning".to_string(), serde_json::Value::Object(node));
            }
        }
        // DeepSeek r1 / reasoner models accept `reasoning_effort` as a
        // top-level OpenAI-compat extension. Other OpenAI-compat
        // providers (Groq, Mistral, Together, Z.AI, MiniMax, Ollama,
        // OpenCode Zen) don't have a public reasoning-control standard;
        // we still emit `reasoning_effort` because OpenAI-compat servers
        // typically tolerate unknown fields. Non-reasoning models
        // ignore it. OpenCode Zen specifically proxies to the underlying
        // vendor so this passes through to the appropriate native field
        // for the selected model.
        ProviderKind::Deepseek
        | ProviderKind::Groq
        | ProviderKind::Mistral
        | ProviderKind::Together
        | ProviderKind::Zai
        | ProviderKind::Minimax
        | ProviderKind::Ollama
        | ProviderKind::OpencodeZen => {
            if let Some(label) = effort_label {
                out.insert("reasoning_effort".to_string(), serde_json::json!(label));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(out))
    }
}

/// Multi-turn agent loop. Invokes the provider, streams the assistant
/// response, executes any returned tool calls, then re-invokes until
/// `finish_reason != ToolCalls` or the round cap is hit. After a
/// non-tool finish the loop checks whether the operator queued any
/// follow-up messages while it was running (`chat_send_message` appends
/// them rather than aborting the in-flight turn) — if so, the round
/// counter resets and we run another sub-turn so the model can address
/// the new question.
pub(crate) async fn run_turn_loop(
    runtime: Arc<Mutex<ChatRuntime>>,
    store: SessionStore,
    provider: Arc<dyn ChatProvider>,
    system_prompt: String,
    cluster_id: String,
    session_id: String,
    provider_options_default: Option<serde_json::Value>,
) {
    let mut round: u32 = 0;
    // Independent cap for context-overflow recoveries. We don't burn a
    // tool-round counter on a recovery (the operator gets the same number
    // of useful rounds before the cap fires) but we do bound recoveries
    // separately so a wedged compaction can't loop.
    let mut overflow_recoveries: u8 = 0;
    // Same idea for empty-stream retries (reasoning models that close
    // their response without emitting anything). Reset to zero on the
    // first non-empty turn so independent flakes later in the session
    // each get their own retry budget.
    let mut empty_retries: u8 = 0;
    // And for transient infra failures (5xx, upstream connection reset,
    // rate limits). Capped at `MAX_TRANSIENT_RETRIES` with exponential
    // backoff between attempts. Resets on first successful round.
    let mut transient_retries: u8 = 0;
    loop {
        if round >= MAX_TOOL_ROUNDS {
            // Round cap hit. Atomically clear cancel under the same lock
            // we'd use to claim a queued user message, then notify the UI.
            runtime.lock().await.cancel = None;
            let _ = runtime.lock().await.channel.send(ChatEvent::Error {
                message: format!("tool-call round limit reached ({MAX_TOOL_ROUNDS})"),
            });
            return;
        }
        round += 1;

        // Repair orphan tool calls in the transcript before doing
        // anything else. A turn that was cancelled (or crashed) mid-
        // tool-execution leaves an `Assistant` message with `tool_calls`
        // but no matching `Tool` results — the OpenAI Responses API
        // (and Anthropic) refuses such input with 400. We pad the
        // missing results with a synthetic "interrupted" tool message
        // so the transcript validates again. Persist the synthetic
        // entries so reload sees the same view.
        repair_orphan_tool_calls(&runtime, &store, &cluster_id, &session_id).await;

        // Auto-compaction: if the last Usage event landed us above the
        // model's usable window, summarise the head of the transcript
        // before the next provider call. The summarisation itself is a
        // provider call; we mark the chat as in-flight to prevent
        // re-trigger on the round that consumes the summary.
        maybe_run_compaction(&runtime, &store, &provider, &cluster_id, &session_id).await;
        // Snapshot the transcript and tool schemas under the mutex; release
        // before any awaiting on network/MCP IO.
        let (
            messages_so_far,
            pre_round_msg_count,
            tool_schemas,
            model,
            approval_mode,
            temperature,
            max_tokens,
            provider_options,
        ) = {
            let g = runtime.lock().await;
            let mut schemas: Vec<ToolSchema> = Vec::new();
            for server in &g.mcp_servers {
                schemas.extend(tools_to_schemas(&server.tools));
            }
            // Native tools are appended after MCP. If a name collides we
            // intentionally let the MCP entry win (the `fs_` prefix on
            // native tools makes collisions practically impossible, but
            // duplicate-name behaviour is undefined for the LLM either way).
            schemas.extend(g.native.schemas());
            // Per-chat override wins; otherwise inherit the
            // settings-derived default the caller computed.
            let opts = g
                .provider_options
                .clone()
                .or_else(|| provider_options_default.clone());
            (
                // Fold any trailing run of consecutive User messages
                // into one synthetic prompt. Operator-queued follow-ups
                // (multiple Send-while-streaming presses) accumulate as
                // separate User entries; some providers reject that
                // shape, and the model is happier reading one combined
                // question than three. Disk + rt.messages keep the
                // originals — only the per-round snapshot is folded.
                merge_trailing_user_run(g.messages.clone()),
                // Pre-round message count (unmerged). The end-of-turn
                // queued-user check compares against this: if
                // `g.messages.len()` grew while we were streaming, a
                // `chat_send_message` landed mid-round and the new tail
                // user(s) are genuinely unanswered. A positional
                // `last_user > last_assistant` check (the old logic)
                // can't tell that apart from the steady state we just
                // left after inserting the previous assistant before a
                // trailing user — and would loop forever on the
                // already-answered case.
                g.messages.len(),
                schemas,
                g.model.clone(),
                g.approval_mode,
                g.temperature,
                g.max_tokens,
                opts,
            )
        };

        // Build the wire-shape message list. The system prompt is freshly
        // composed each round so a mid-session `fs_configuration_use_context`
        // gets reflected immediately. We send the *full* transcript and let
        // token-based pressure valves manage capacity:
        //
        //   1. Proactive: `maybe_run_compaction` above fires at 75% of the
        //      model's usable window (read from the previous Usage event),
        //      summarising the head into a checkpoint message.
        //   2. Reactive: a context-overflow-shaped 400 (`No tool output
        //      found …` / `context_length_exceeded` / `prompt is too long`)
        //      lands as `RetryAfterCompaction` below, force-compacts, and
        //      re-issues the round.
        //
        // Mirrors opencode's flow: trust the model's full window, summarise
        // when we cross the threshold, recover on overflow. No char/byte
        // pre-truncation — that's a heuristic that fights the catalogue's
        // ground-truth token limit.
        let mut full_messages = Vec::with_capacity(messages_so_far.len() + 1);
        full_messages.push(ChatMessage {
            role: MessageRole::System,
            content: system_prompt.clone(),
            tool_calls: vec![],
            tool_call_id: None,
            name: None,
            reasoning_content: None,
            images: vec![],
        });
        full_messages.extend(messages_so_far);

        let req = CompletionRequest {
            model,
            messages: full_messages,
            tools: tool_schemas,
            temperature,
            max_tokens,
            provider_options: provider_options.clone(),
        };

        let proceed =
            run_provider_round(&runtime, &store, &provider, req, &cluster_id, &session_id).await;
        let (assistant_msg, finish_reason, tool_calls) = match proceed {
            ProviderRoundOutcome::Continue {
                assistant_msg,
                finish_reason,
                tool_calls,
            } => (assistant_msg, finish_reason, tool_calls),
            ProviderRoundOutcome::Stopped => {
                runtime.lock().await.cancel = None;
                return;
            }
            ProviderRoundOutcome::RetryAfterCompaction { original_error } => {
                if overflow_recoveries >= MAX_OVERFLOW_RECOVERIES {
                    // Compaction couldn't shrink enough (or the error
                    // wasn't actually overflow-shaped). Fall through to
                    // the existing error surface so the operator sees
                    // what happened rather than a silent loop.
                    let err_text = format!(
                        "**Provider error.** The request failed before the model could respond.\n\n\
                         ```text\n{original_error}\n```\n\n\
                         _Auto-compaction couldn't recover after {MAX_OVERFLOW_RECOVERIES} attempts. Try /compact or start a new chat._"
                    );
                    let assistant_msg = ChatMessage {
                        role: MessageRole::Assistant,
                        content: err_text.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                        images: vec![],
                    };
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = store
                        .append(
                            &cluster_id,
                            &session_id,
                            SessionEvent::Message {
                                message: assistant_msg.clone(),
                                ts: now,
                            },
                        )
                        .await;
                    {
                        let mut g = runtime.lock().await;
                        g.messages.push(assistant_msg);
                        g.cancel = None;
                    }
                    let _ = runtime
                        .lock()
                        .await
                        .channel
                        .send(ChatEvent::Error { message: err_text });
                    return;
                }
                overflow_recoveries += 1;
                tracing::warn!(
                    attempt = overflow_recoveries,
                    error = %original_error,
                    "agent: context-overflow-shaped error; running forced compaction and retrying"
                );
                // Force-compact even if the catalogue threshold hasn't
                // crossed — we already know the request didn't fit.
                run_compaction_internal(
                    &runtime,
                    &store,
                    &provider,
                    &cluster_id,
                    &session_id,
                    true,
                )
                .await;
                // Don't increment `round`: the failed attempt produced
                // no output, so the operator's effective round budget
                // is unchanged. Next iteration re-issues against the
                // post-compaction transcript.
                round = round.saturating_sub(1);
                continue;
            }
            ProviderRoundOutcome::EmptyTurn => {
                if empty_retries >= MAX_EMPTY_RETRIES {
                    // Reasoning model is genuinely stuck (or the prompt
                    // is fighting itself). Surface a one-line note so the
                    // operator knows why the chat parked, rather than
                    // letting the empty bubble dangle.
                    let err_text = format!(
                        "_The model returned no output after {} attempts. Send a message to continue._",
                        MAX_EMPTY_RETRIES + 1
                    );
                    let assistant_msg = ChatMessage {
                        role: MessageRole::Assistant,
                        content: err_text.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                        images: vec![],
                    };
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = store
                        .append(
                            &cluster_id,
                            &session_id,
                            SessionEvent::Message {
                                message: assistant_msg.clone(),
                                ts: now,
                            },
                        )
                        .await;
                    // Emit the synthetic message on the wire as a normal
                    // assistant turn so the operator actually sees it
                    // *now*, not just after a session reload. Without
                    // this, the loop returned silently after persisting
                    // the message and the chat appeared to "park" with
                    // no assistant output between the last tool result
                    // and the next operator message — see issue where
                    // a follow-up "continue" produced no visible reply
                    // because the model kept returning empty turns and
                    // each exhaustion path was disk-only.
                    let synthetic_id = format!("msg-{}", uuid::Uuid::new_v4());
                    {
                        let mut g = runtime.lock().await;
                        g.messages.push(assistant_msg);
                        g.cancel = None;
                        let _ = g.channel.send(ChatEvent::AssistantStart {
                            message_id: synthetic_id.clone(),
                        });
                        let _ = g.channel.send(ChatEvent::TokenDelta { delta: err_text });
                        let _ = g.channel.send(ChatEvent::AssistantEnd {
                            message_id: synthetic_id,
                            finish_reason: FinishReason::Stop,
                        });
                    }
                    return;
                }
                empty_retries += 1;
                tracing::warn!(
                    attempt = empty_retries,
                    "agent: empty assistant turn (no text, no tool calls); retrying"
                );
                // Don't burn a round — the empty turn produced nothing
                // and the next attempt re-issues against the same
                // transcript. The phantom empty bubble that briefly
                // appeared (from AssistantStart/AssistantEnd) is
                // suppressed by the frontend's empty-bubble filter.
                round = round.saturating_sub(1);
                continue;
            }
            ProviderRoundOutcome::TransientFailure {
                reason,
                original_error,
            } => {
                if transient_retries >= MAX_TRANSIENT_RETRIES {
                    // Upstream is genuinely down or our request is
                    // somehow malformed in a way the LB rejects. Render
                    // the underlying error so the operator can decide
                    // (retry manually, switch provider, file an issue).
                    let err_text = format!(
                        "**Provider error.** The request failed before the model could respond.\n\n\
                         ```text\n{original_error}\n```\n\n\
                         _Auto-retry exhausted after {MAX_TRANSIENT_RETRIES} attempts. Likely a transient upstream issue — try sending the message again in a minute._"
                    );
                    let assistant_msg = ChatMessage {
                        role: MessageRole::Assistant,
                        content: err_text.clone(),
                        tool_calls: vec![],
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                        images: vec![],
                    };
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = store
                        .append(
                            &cluster_id,
                            &session_id,
                            SessionEvent::Message {
                                message: assistant_msg.clone(),
                                ts: now,
                            },
                        )
                        .await;
                    {
                        let mut g = runtime.lock().await;
                        g.messages.push(assistant_msg);
                        g.cancel = None;
                    }
                    let _ = runtime
                        .lock()
                        .await
                        .channel
                        .send(ChatEvent::Error { message: err_text });
                    return;
                }
                transient_retries += 1;
                let delay_ms = transient_retry_delay_ms(transient_retries);
                tracing::warn!(
                    attempt = transient_retries,
                    delay_ms,
                    %reason,
                    error = %original_error,
                    "agent: transient provider failure; backing off and retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                // Don't burn a round — the failed attempt produced no
                // output. Next iteration re-issues the same transcript.
                round = round.saturating_sub(1);
                continue;
            }
        };

        // First successful round after one or more retries — clear
        // both counters so future independent flakes each get their
        // own budget.
        empty_retries = 0;
        transient_retries = 0;

        if finish_reason != FinishReason::ToolCalls || tool_calls.is_empty() {
            // No tool calls — decide whether the turn is truly done, then
            // place the assistant message. The check has to run BEFORE we
            // push: if the operator queued a follow-up during streaming,
            // their message is already at the tail of `g.messages`, and
            // appending the assistant after it would wrongly trip the
            // "queued user is answered" branch, abandoning the queued
            // turn. Run the check first; if pending, splice the assistant
            // *before* the queued user tail so the transcript reads
            // chronologically by role (`…, asst_final, user2, user3`)
            // rather than the wall-clock shuffled `…, user2, user3,
            // asst_final`. Cancel-clear and the queued-message check live
            // in one critical section so a concurrent `chat_send_message`
            // either lands its message before the check (we keep going)
            // or after we clear cancel (it spawns a fresh turn). No third
            // option.
            //
            // The criterion for "queued during streaming" is that
            // `g.messages` grew past `pre_round_msg_count` *and* the tail
            // is a User. A positional `last_user > last_assistant` check
            // can't tell that apart from the post-insert steady state on
            // a subsequent loop iteration — it would loop forever
            // answering the same already-answered user.
            let pending = {
                let mut g = runtime.lock().await;
                if user_queued_during_round(&g.messages, pre_round_msg_count) {
                    let insert_at =
                        trailing_user_run_start(&g.messages).unwrap_or(g.messages.len());
                    g.messages.insert(insert_at, assistant_msg);
                    round = 0;
                    true
                } else {
                    g.messages.push(assistant_msg);
                    g.cancel = None;
                    false
                }
            };
            if pending {
                continue;
            }
            return;
        }

        // Fan out every requested tool call. Reads run truly concurrently;
        // writes serialise on the operator's approval. Results land in the
        // original tool_calls order so the assistant→tool sequence the
        // provider expects stays intact.
        //
        // ToolResult is emitted to the wire AS EACH FUTURE COMPLETES — not
        // batched after join_all — so a fast-approved sibling clears its
        // approval card and "running" strip in the UI immediately, even
        // when other tools in the batch are still awaiting their own
        // operator decision. Otherwise the user has to approve every card
        // before any of the already-approved cards get a ToolResult and
        // disappear, which feels like the UI is stuck.
        let mut futures = Vec::with_capacity(tool_calls.len());
        let spool = { runtime.lock().await.tool_spool.clone() };
        for tc in &tool_calls {
            let runtime = runtime.clone();
            let store = store.clone();
            let cluster_id = cluster_id.clone();
            let session_id = session_id.clone();
            let tc = tc.clone();
            let spool = spool.clone();
            let category = classify_tool(&tc.name);
            futures.push(async move {
                let (content, is_error) = execute_tool_call(
                    &runtime,
                    &store,
                    &cluster_id,
                    &session_id,
                    &tc,
                    category,
                    approval_mode,
                )
                .await;
                // Clamp before anything sees it — the wire ToolResult, the
                // model-facing transcript, and the persisted log all derive
                // from this one string, so capping here keeps them in sync
                // and stops an oversized result from wedging the loop. The
                // full payload is spilled to disk first so the model can
                // recover it via fs_tool_output_read / _grep.
                let content = maybe_spill(&spool, &tc.id, content).await;
                let _ = runtime.lock().await.channel.send(ChatEvent::ToolResult {
                    tool_call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    content: content.clone(),
                    is_error,
                });
                (tc, content, is_error)
            });
        }
        let results = futures::future::join_all(futures).await;

        // Push assistant + every tool message into runtime state in one
        // locked critical section. This preserves the provider's required
        // ordering (an assistant message with `tool_calls` must be
        // immediately followed by the matching tool messages) even when
        // a concurrent `chat_send_message` queues a user message between
        // rounds — the user message can land before or after this batch,
        // never in the middle.
        let tool_msgs: Vec<ChatMessage> = results
            .iter()
            .map(|(tc, content, _)| ChatMessage {
                role: MessageRole::Tool,
                content: content.clone(),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
                name: Some(tc.name.clone()),
                reasoning_content: None,
                images: vec![],
            })
            .collect();
        {
            let mut g = runtime.lock().await;
            g.messages.push(assistant_msg);
            for msg in &tool_msgs {
                g.messages.push(msg.clone());
            }
        }

        // Persist outside the lock. Channel emission already happened
        // per-future above; this loop is purely about the on-disk event
        // log so a session reload can rebuild the transcript.
        let now = chrono::Utc::now().timestamp_millis();
        for ((tc, content, is_error), tool_msg) in results.into_iter().zip(tool_msgs) {
            let _ = store
                .append(
                    &cluster_id,
                    &session_id,
                    SessionEvent::Message {
                        message: tool_msg,
                        ts: now,
                    },
                )
                .await;
            let _ = store
                .append(
                    &cluster_id,
                    &session_id,
                    SessionEvent::ToolResult {
                        call: tc,
                        result: content.clone(),
                        error: if is_error { Some(content) } else { None },
                        ts: now,
                    },
                )
                .await;
        }
    }
}

/// True iff a `chat_send_message` landed at the tail of `messages`
/// between the snapshot at the start of the current round and now.
/// `pre_round_count` is `g.messages.len()` captured under the same
/// lock that built the snapshot; growth past that with a trailing
/// `User` is exactly the queued-during-streaming case.
///
/// A positional "last_user > last_assistant" check can't be used: on
/// the iteration that *answers* a previously-queued user, the
/// assistant from the prior round was spliced *before* the user run
/// (to keep the user pinned at the tail across the round-skip), so
/// the positional test stays true forever and the loop spins. The
/// length-delta criterion is observationally tied to the actual
/// race (`chat_send_message` mutating `g.messages` while we awaited
/// the provider stream) and bails as soon as the queued user is
/// consumed.
fn user_queued_during_round(messages: &[ChatMessage], pre_round_count: usize) -> bool {
    messages.len() > pre_round_count
        && matches!(messages.last().map(|m| &m.role), Some(MessageRole::User))
}

/// Start index of the trailing run of consecutive `User` messages, or
/// `None` if the tail isn't a User. Used by the no-tool-call end-of-
/// turn handler to splice a freshly-produced assistant message in
/// *before* operator messages that were queued mid-round, so the
/// transcript reads `…, asst1, asst_final, user2, user3` instead of
/// the clock-ordered `…, asst1, user2, user3, asst_final`.
fn trailing_user_run_start(messages: &[ChatMessage]) -> Option<usize> {
    let mut i = messages.len();
    while i > 0 && matches!(messages[i - 1].role, MessageRole::User) {
        i -= 1;
    }
    if i == messages.len() {
        None
    } else {
        Some(i)
    }
}

/// If the transcript ends with two or more consecutive `User` messages
/// (the operator queued multiple turns while the model was streaming
/// the previous one), fold them into a single synthetic User message
/// for the *provider snapshot only*. The originals stay in
/// `rt.messages` and on disk so the persisted history shows what the
/// operator actually typed; the provider call sees one combined
/// prompt so the model gets a coherent question rather than a
/// "user … user … user …" run that some providers refuse outright
/// (Anthropic rejects consecutive user-role messages with 400).
fn merge_trailing_user_run(mut messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let start = match trailing_user_run_start(&messages) {
        Some(i) => i,
        None => return messages,
    };
    if start + 1 >= messages.len() {
        return messages;
    }
    let merged_content = messages[start..]
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    messages.truncate(start);
    messages.push(ChatMessage {
        role: MessageRole::User,
        content: merged_content,
        tool_calls: vec![],
        tool_call_id: None,
        name: None,
        reasoning_content: None,
        images: vec![],
    });
    messages
}

enum ProviderRoundOutcome {
    Continue {
        assistant_msg: ChatMessage,
        finish_reason: FinishReason,
        tool_calls: Vec<ToolCall>,
    },
    Stopped,
    /// The provider returned a context-overflow-shaped error (request
    /// body too large for the model's window, or an "orphan tool call"
    /// shape that the API rejects when older history was elided). The
    /// caller (`run_turn_loop`) responds by forcing a compaction and
    /// re-issuing the same round against the post-compaction transcript.
    /// Bounded retries (`MAX_OVERFLOW_RECOVERIES`) prevent a loop when
    /// compaction itself can't fit.
    RetryAfterCompaction {
        /// Display string forwarded to the operator if recovery exhausts.
        original_error: String,
    },
    /// The provider stream closed cleanly with no text and no tool calls.
    /// Common with reasoning models (gpt-5 family on the Codex/OAuth
    /// path, claude with extended thinking) when the model burned its
    /// reasoning budget without emitting output. Same shape as the
    /// operator's manual "type continue" recovery — we re-issue the
    /// round against the unchanged transcript and the next attempt
    /// usually produces real content. Bounded by `MAX_EMPTY_RETRIES`.
    EmptyTurn,
    /// Transient infrastructure failure: 5xx from the provider, an
    /// upstream LB connection reset (Envoy "upstream connect error /
    /// disconnect/reset"), rate-limit (429), or a network timeout. The
    /// caller sleeps an exponential backoff and re-issues the round
    /// against the unchanged transcript. Bounded by
    /// `MAX_TRANSIENT_RETRIES`.
    TransientFailure {
        /// Short human label (`"upstream 503"`, `"rate limited"`, …)
        /// for logs. Distinct from the underlying error, which we keep
        /// in case the retry exhausts and we surface to the operator.
        reason: String,
        /// Full error text — surfaced if all retries exhaust.
        original_error: String,
    },
}

/// Cap on automatic retries after an empty-stream turn. Two attempts
/// covers the typical reasoning-model flake without spinning forever
/// when something is genuinely wrong (model misconfigured, prompt
/// fights itself, etc.). Resets to zero on the first non-empty turn.
const MAX_EMPTY_RETRIES: u8 = 2;

/// Cap on automatic retries after a transient provider failure (5xx,
/// upstream connection reset, rate limit, network timeout). Mirrors
/// opencode's retry policy in spirit: they retry indefinitely with
/// exponential backoff, but a hard cap fits operator expectations
/// better — past 5 attempts something is genuinely wrong upstream and
/// the operator should know rather than watching the chat sit on a
/// silent retry loop. Resets to zero on the first successful round.
const MAX_TRANSIENT_RETRIES: u8 = 5;

/// Cap the auto-recover loop so a misclassified error or a transcript
/// that can't fit even after a full summary doesn't spin forever.
const MAX_OVERFLOW_RECOVERIES: u8 = 2;

/// One provider invocation: stream tokens / tool-call deltas, persist the
/// assistant message, return the finish reason + collected tool calls.
async fn run_provider_round(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    req: CompletionRequest,
    cluster_id: &str,
    session_id: &str,
) -> ProviderRoundOutcome {
    let message_id = format!("msg-{}", uuid::Uuid::new_v4());
    let send = |ev: ChatEvent| {
        let rt = runtime.clone();
        async move {
            let g = rt.lock().await;
            let _ = g.channel.send(ev);
        }
    };
    // Record the in-flight bubble id so `chat_cancel_streaming` can close
    // it cleanly when the spawned task is aborted mid-stream.
    runtime.lock().await.in_flight_message_id = Some(message_id.clone());
    send(ChatEvent::AssistantStart {
        message_id: message_id.clone(),
    })
    .await;

    // Streaming sink: forwards events synchronously through the channel and
    // accumulates text for persistence. try_lock keeps a misbehaving
    // consumer from stalling the stream; on contention the event drops
    // (the persisted assistant message is the source of truth either way).
    let runtime_for_sink = runtime.clone();
    // std::sync::Mutex (NOT tokio::sync::Mutex) — the sink is sync, no
    // .await while holding, and we MUST NOT drop bytes on contention.
    // The previous tokio try_lock could silently lose characters when
    // the lock looked contended, leaving the persisted assistant
    // message with broken markdown (`[label](url)` mangled to
    // `[label]url)` on a missing `(` byte). std::Mutex::lock blocks
    // for at most a few µs here.
    let text_accum: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let text_clone = text_accum.clone();
    let provider_sink: ferrisscope_agent::provider::EventSink =
        Box::new(move |evt: CompletionEvent| {
            if let CompletionEvent::TokenDelta(s) = &evt {
                if let Ok(mut g) = text_clone.lock() {
                    g.push_str(s);
                }
            }
            if let Ok(g) = runtime_for_sink.try_lock() {
                let outgoing = match evt {
                    CompletionEvent::TokenDelta(s) => ChatEvent::TokenDelta { delta: s },
                    CompletionEvent::ToolCallStart { id, name } => {
                        ChatEvent::ToolCallStart { id, name }
                    }
                    CompletionEvent::ToolCallArgsDelta { id, json_delta } => {
                        ChatEvent::ToolCallArgsDelta { id, json_delta }
                    }
                    CompletionEvent::ToolCallEnd { id } => ChatEvent::ToolCallEnd { id },
                };
                let _ = g.channel.send(outgoing);
            }
        });

    let result = provider.stream_completion(req, provider_sink).await;

    let (finish_reason, tool_calls, reasoning_content): (
        FinishReason,
        Vec<ToolCall>,
        Option<String>,
    ) = match result {
        Ok(final_) => {
            if let Some(usage) = &final_.usage {
                // Resolve the active model's context limits at emit time so
                // the UI's `<used>/<limit>` footer stays consistent with the
                // compaction trigger's view (both go through the same
                // catalogue). Both kind and model live on the runtime so
                // this is a single lock acquire — no store IO per turn.
                let (context_limit, usable_context) = {
                    let g = runtime.lock().await;
                    context_limits_for(g.provider_kind, &g.model)
                };
                send(ChatEvent::Usage {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                    context_limit,
                    usable_context,
                })
                .await;
                // Stash the running total so the loop can decide
                // whether to compact before the next round. Providers
                // report cumulative `total_tokens` per request, so we
                // overwrite rather than accumulate.
                let total = if usage.total_tokens > 0 {
                    usage.total_tokens
                } else {
                    usage.prompt_tokens.saturating_add(usage.completion_tokens)
                };
                runtime.lock().await.last_total_tokens = total;
                // Persist so chat_open after a close can rehydrate
                // the running total — without this we lose the count
                // every time the operator reopens the chat window
                // and the compaction trigger silently sleeps until
                // the next round's Usage lands.
                let now = chrono::Utc::now().timestamp_millis();
                let _ = store
                    .append(
                        cluster_id,
                        session_id,
                        SessionEvent::Usage {
                            prompt_tokens: usage.prompt_tokens,
                            completion_tokens: usage.completion_tokens,
                            total_tokens: total,
                            ts: now,
                        },
                    )
                    .await;
            }
            (
                final_.finish_reason,
                final_.tool_calls,
                final_.reasoning_content,
            )
        }
        Err(ProviderError::Cancelled) => {
            // Fill the open assistant bubble with a brief cancellation
            // notice and close it — one bubble, not "empty bubble + error
            // pill". Cancellation isn't persisted: it's operator-initiated
            // and adding it to the on-disk transcript would replay as
            // assistant content on reload, which is misleading.
            let cancel_text = "_Cancelled by operator._".to_string();
            if let Ok(mut g) = text_accum.lock() {
                g.push_str(&cancel_text);
            }
            send(ChatEvent::TokenDelta { delta: cancel_text }).await;
            runtime.lock().await.in_flight_message_id = None;
            send(ChatEvent::AssistantEnd {
                message_id: message_id.clone(),
                finish_reason: FinishReason::Other,
            })
            .await;
            return ProviderRoundOutcome::Stopped;
        }
        Err(e) => {
            // Context-overflow-shaped error? Hand it back to the loop as a
            // recoverable signal: don't render anything, don't persist —
            // the loop will run a forced compaction and re-issue the round
            // against the post-compaction transcript. Capped retries in
            // the caller prevent ping-ponging when compaction itself can't
            // shrink enough.
            if is_context_overflow_error(&e) {
                runtime.lock().await.in_flight_message_id = None;
                send(ChatEvent::AssistantEnd {
                    message_id: message_id.clone(),
                    finish_reason: FinishReason::Other,
                })
                .await;
                return ProviderRoundOutcome::RetryAfterCompaction {
                    original_error: e.to_string(),
                };
            }
            // Transient infra failure (5xx, upstream LB reset, rate
            // limit, network timeout)? Don't render — the caller does
            // an exponential backoff and re-issues the round. The
            // empty assistant bubble we just opened gets hidden by
            // the frontend's empty-bubble filter.
            if let Some(reason) = is_transient_error(&e) {
                runtime.lock().await.in_flight_message_id = None;
                send(ChatEvent::AssistantEnd {
                    message_id: message_id.clone(),
                    finish_reason: FinishReason::Other,
                })
                .await;
                return ProviderRoundOutcome::TransientFailure {
                    reason,
                    original_error: e.to_string(),
                };
            }
            // Render the failure inside the in-flight assistant bubble
            // (TokenDelta + AssistantEnd) and persist it as the bubble's
            // content. Avoids the "empty bubble + separate error pill"
            // duplication and keeps the chat transcript honest about
            // what the operator saw. Redact secrets first: this text is
            // persisted to disk, and a provider error body can echo request
            // URLs / headers carrying API keys or bearer tokens.
            let err_text = format!(
                "**Provider error.** The request failed before the model could respond.\n\n\
                 ```text\n{}\n```",
                redact_secrets(&e.to_string())
            );
            if let Ok(mut g) = text_accum.lock() {
                g.push_str(&err_text);
            }
            send(ChatEvent::TokenDelta {
                delta: err_text.clone(),
            })
            .await;
            runtime.lock().await.in_flight_message_id = None;
            let assistant_msg = ChatMessage {
                role: MessageRole::Assistant,
                content: err_text,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
                images: vec![],
            };
            let now = chrono::Utc::now().timestamp_millis();
            let _ = store
                .append(
                    cluster_id,
                    session_id,
                    SessionEvent::Message {
                        message: assistant_msg.clone(),
                        ts: now,
                    },
                )
                .await;
            // Push to in-memory transcript so the next round (if the
            // operator sends another message) sees this bubble rather
            // than a hole. The model is expected to read the error and
            // adjust on its next turn.
            runtime.lock().await.messages.push(assistant_msg);
            send(ChatEvent::AssistantEnd {
                message_id: message_id.clone(),
                finish_reason: FinishReason::Other,
            })
            .await;
            return ProviderRoundOutcome::Stopped;
        }
    };

    let final_text = text_accum.lock().map(|g| g.clone()).unwrap_or_default();

    // Empty-stream detection: the model closed the response with no text
    // *and* no tool calls. Common with reasoning models that burn their
    // thinking budget internally without emitting output. Don't persist
    // a content-less bubble — close the in-flight one on the wire and
    // signal the loop to re-issue the round. The next attempt against
    // the same transcript usually produces real output (same recovery
    // the operator gets by typing "continue" manually).
    if final_text.trim().is_empty() && tool_calls.is_empty() {
        runtime.lock().await.in_flight_message_id = None;
        send(ChatEvent::AssistantEnd {
            message_id,
            finish_reason,
        })
        .await;
        return ProviderRoundOutcome::EmptyTurn;
    }

    let assistant_msg = ChatMessage {
        role: MessageRole::Assistant,
        content: final_text,
        tool_calls: tool_calls.clone(),
        tool_call_id: None,
        name: None,
        reasoning_content,
        images: vec![],
    };
    runtime.lock().await.in_flight_message_id = None;
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Message {
                message: assistant_msg.clone(),
                ts: now,
            },
        )
        .await;

    send(ChatEvent::AssistantEnd {
        message_id,
        finish_reason,
    })
    .await;

    // Caller (`run_turn_loop`) is responsible for atomically pushing the
    // assistant + tool messages into runtime state and for clearing the
    // cancel handle when the turn finishes — that lock-coupled handoff is
    // how we keep mid-turn user-message queueing race-free.
    ProviderRoundOutcome::Continue {
        assistant_msg,
        finish_reason,
        tool_calls,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: MessageRole, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.into(),
            ..Default::default()
        }
    }

    #[test]
    fn trailing_user_run_none_when_tail_isnt_user() {
        let msgs = vec![
            msg(MessageRole::User, "hi"),
            msg(MessageRole::Assistant, "hello"),
        ];
        assert_eq!(trailing_user_run_start(&msgs), None);
    }

    #[test]
    fn trailing_user_run_finds_single_user_tail() {
        let msgs = vec![
            msg(MessageRole::User, "hi"),
            msg(MessageRole::Assistant, "hello"),
            msg(MessageRole::User, "follow-up"),
        ];
        assert_eq!(trailing_user_run_start(&msgs), Some(2));
    }

    #[test]
    fn trailing_user_run_finds_multi_user_tail() {
        let msgs = vec![
            msg(MessageRole::User, "first"),
            msg(MessageRole::Assistant, "ack"),
            msg(MessageRole::User, "queued 1"),
            msg(MessageRole::User, "queued 2"),
            msg(MessageRole::User, "queued 3"),
        ];
        assert_eq!(trailing_user_run_start(&msgs), Some(2));
    }

    #[test]
    fn trailing_user_run_handles_empty_transcript() {
        let msgs: Vec<ChatMessage> = vec![];
        assert_eq!(trailing_user_run_start(&msgs), None);
    }

    #[test]
    fn merge_trailing_user_run_noop_when_no_tail() {
        let msgs = vec![
            msg(MessageRole::User, "hi"),
            msg(MessageRole::Assistant, "hello"),
        ];
        let out = merge_trailing_user_run(msgs.clone());
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].content, "hello");
    }

    #[test]
    fn merge_trailing_user_run_noop_when_single_user_tail() {
        // A single trailing user message is normal — leave it alone.
        let msgs = vec![
            msg(MessageRole::Assistant, "hello"),
            msg(MessageRole::User, "follow-up"),
        ];
        let out = merge_trailing_user_run(msgs);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].content, "follow-up");
    }

    #[test]
    fn merge_trailing_user_run_combines_queue() {
        let msgs = vec![
            msg(MessageRole::User, "first"),
            msg(MessageRole::Assistant, "ack"),
            msg(MessageRole::User, "queued 1"),
            msg(MessageRole::User, "queued 2"),
            msg(MessageRole::User, "queued 3"),
        ];
        let out = merge_trailing_user_run(msgs);
        // Three queued user messages collapse to one combined entry.
        assert_eq!(out.len(), 3);
        assert!(matches!(out[2].role, MessageRole::User));
        assert_eq!(out[2].content, "queued 1\n\nqueued 2\n\nqueued 3");
        // History before the queue is untouched.
        assert_eq!(out[0].content, "first");
        assert_eq!(out[1].content, "ack");
    }

    #[test]
    fn user_queued_during_round_detects_growth_with_user_tail() {
        // Round started with two messages; a `chat_send_message` landed
        // mid-stream and pushed a User to the tail. The end-of-turn
        // check must flag this as queued so the loop runs another round.
        let pre = 2;
        let msgs = vec![
            msg(MessageRole::User, "user1"),
            msg(MessageRole::Assistant, "asst1 (had tool calls)"),
            msg(MessageRole::User, "user2 queued"),
        ];
        assert!(user_queued_during_round(&msgs, pre));
    }

    #[test]
    fn user_queued_during_round_false_when_no_growth() {
        // No new messages arrived during the round → trailing user (if
        // any) is the same one the model just answered. Loop must exit.
        let msgs = vec![
            msg(MessageRole::Assistant, "asst1"),
            msg(MessageRole::User, "user1"),
        ];
        let pre = msgs.len();
        assert!(!user_queued_during_round(&msgs, pre));
    }

    #[test]
    fn user_queued_during_round_false_when_tail_isnt_user() {
        // Tool result(s) landed but no new user — also not a queue.
        let pre = 1;
        let msgs = vec![
            msg(MessageRole::User, "user1"),
            msg(MessageRole::Assistant, "asst1 (had tool calls)"),
            msg(MessageRole::Tool, "tool result"),
        ];
        assert!(!user_queued_during_round(&msgs, pre));
    }

    #[test]
    fn user_queued_during_round_breaks_post_insert_loop() {
        // Regression for the loop bug: after iteration N inserts the
        // assistant *before* the trailing user run (to keep the queued
        // user at the tail), iteration N+1 sees the same User at the
        // tail. With the old positional `last_user > last_assistant`
        // check this loops forever; with the length-delta criterion,
        // the next round's `pre_round_count` already includes the user,
        // so `user_queued_during_round` returns false and the loop
        // exits as soon as the queued user is genuinely answered.
        let after_iter1 = vec![
            msg(MessageRole::User, "user1"),
            msg(MessageRole::Assistant, "asst1"),
            msg(MessageRole::User, "queued"),
        ];
        // Iteration 2 captures pre_round_count from this transcript.
        let pre_iter2 = after_iter1.len();
        // No `chat_send_message` lands during iter 2 — messages stay
        // the same length when the provider returns the answer.
        assert!(!user_queued_during_round(&after_iter1, pre_iter2));
    }
}
