//! `agent::compaction` — see `agent/mod.rs` for the split rationale.

use std::sync::Arc;

use ferrisscope_agent::session::{SessionEvent, SessionStore};
use ferrisscope_agent::types::{ChatMessage, MessageRole};
use ferrisscope_agent::{ChatProvider, CompletionEvent, CompletionRequest, ProviderKind};
use tokio::sync::Mutex;

use super::{char_boundary_floor, ChatEvent, ChatRuntime};

/// Structured-summary prompt the compaction call uses. Adapted from
/// opencode's compaction template — produces a Markdown checkpoint
/// the next round consumes as a single synthetic assistant message.
const COMPACTION_PROMPT: &str = "\
The conversation above has run long. Produce a structured summary that \
preserves the operator's intent, the cluster state established so far, \
and any unresolved threads.\n\
\n\
Use **exactly** these sections, in this order, even if a section is empty:\n\
\n\
## Goal\n\
- Single sentence describing what the operator is trying to accomplish.\n\
\n\
## Constraints\n\
- Cluster, namespace, and any operational rules established (RBAC, \
quotas, deadlines).\n\
\n\
## Progress\n\
### Done\n\
- Bullet list of confirmed actions / read-only conclusions.\n\
### In progress\n\
- Bullet list of partially completed work.\n\
### Blocked\n\
- Bullet list of obstacles, with the cause.\n\
\n\
## Key decisions\n\
- Bullet list of trade-offs the operator agreed to.\n\
\n\
## Next steps\n\
- Bullet list of the immediate plan, in order.\n\
\n\
## Critical context\n\
- Bullet list of values that must NOT be lost (image tags, IPs, \
PVC names, secret keys, exact error messages).\n\
\n\
## Relevant files\n\
- `path/relative/to/repo` — why it matters\n\
\n\
Rules:\n\
- Preserve resource names, namespaces, container ids, and error \
strings verbatim.\n\
- Be terse. One bullet per fact. No filler prose.\n\
- Don't reference this summarisation step or apologise for compaction.";

/// Token-headroom fraction. We trigger compaction once cumulative
/// tokens cross this share of the model's usable window. 0.90 leans
/// toward using the full catalogue capacity — for gpt-5.5 that's
/// ~812k tokens before we summarise, vs the ~677k we'd see at 0.75.
/// The remaining 10% is enough for the summarisation call itself plus
/// one more round of growth; if a single tool blows past it between
/// Usage events the reactive `RetryAfterCompaction` path catches the
/// resulting 400 and force-compacts. Opencode runs at 1.0 because they
/// can halt mid-stream on overflow; we trigger pre-flight, so 0.90 is
/// the equivalent safe headroom.
const COMPACTION_TRIGGER_FRACTION: f32 = 0.90;

/// Resolve `(context, usable)` for a `(provider, model)` pair purely
/// from the models.dev catalogue. No per-model overrides in code — the
/// catalogue is the single source of truth, so adding / re-tiering a
/// model in models.dev doesn't require a release here.
///
/// `usable` is `input_limit − reserved_output`, mirroring opencode's
/// `usable()` formula. Critically this is **input**, not raw `context`:
/// for the gpt-5 family the catalogue distinguishes `context` (input +
/// output) from `input` (the actual cap on what we can send). For
/// gpt-5.5 that's 1.05M context vs 922k input — using `context` would
/// have us happily packing a 900k-token input that the server rejects
/// because input alone exceeds the cap. For providers that don't split
/// the budget (most non-OpenAI), `parse_limits` already sets
/// `input = context`, so the formula collapses to the classic
/// "context − output buffer".
///
/// When the live (OAuth/Codex) backend enforces tighter limits than
/// the catalogue's API-tier numbers, `is_context_overflow_error` +
/// reactive compaction recover from the resulting 400 — same end
/// behaviour as if we'd hardcoded the tighter cap, without any
/// model-name string matching that breaks the day a vendor renames.
pub(crate) fn context_limits_for(kind: ProviderKind, model: &str) -> (u32, u32) {
    use ferrisscope_agent::provider::catalogue;
    use ferrisscope_agent::provider::meta;

    let (context, input, output) = match catalogue::lookup(kind, model) {
        Some(l) => (l.context, l.input, l.output),
        None => {
            // Catalogue miss — fall back to the per-provider default.
            // Treat input == context (most providers don't distinguish)
            // and assume output buffer of 8192 for the reserve calc.
            let default = meta::for_kind(kind).default_context_window;
            (default, default, 8192)
        }
    };

    // Reserved output buffer: `min(20_000, max_output)`, floored at 2k
    // so a model with a tiny declared `output` cap doesn't leave us
    // with effectively zero headroom for the response. Mirrors
    // `catalogue::reserved_tokens`.
    let reserved = 20_000.min(output.max(1)).max(2048);
    let usable = input.saturating_sub(reserved);
    (context, usable)
}

/// Number of trailing messages we keep verbatim across a compaction.
/// Mirrors opencode's `tail_turns: 2` default — leaves enough recent
/// context for the model to thread continuity onto the summary.
const COMPACTION_TAIL_KEEP: usize = 4;

/// Make every assistant tool call answerable the way providers demand: each
/// `Assistant.tool_calls[].id` followed immediately by its `Tool` result, and no
/// `Tool` message anywhere else. OpenAI (`An assistant message with
/// 'tool_calls' must be followed by tool messages…`, `No tool output found for
/// function call …`) and Anthropic (`tool_use_id … must be followed by
/// tool_result`) reject anything else with a 400 — for good, since the bad
/// shape is in the history.
///
/// A call with no result (the turn was cancelled or crashed mid-tool) gets a
/// synthetic "interrupted" result; one whose result ended up later in the
/// transcript (a message sent after the cancelled turn) is moved next to its
/// call; results that answer nothing are dropped. In memory only: the log keeps
/// what happened, and this re-derives the same repair on every load without
/// growing it.
fn repair_tool_pairs(messages: &mut Vec<ChatMessage>) -> usize {
    use std::collections::HashSet;
    let mut fixed = 0;
    let mut i = 0;
    while i < messages.len() {
        let calls = match &messages[i] {
            m if matches!(m.role, MessageRole::Assistant) && !m.tool_calls.is_empty() => {
                m.tool_calls.clone()
            }
            _ => {
                i += 1;
                continue;
            }
        };
        let mut run_end = i + 1;
        let mut answered: HashSet<String> = HashSet::new();
        while run_end < messages.len() && matches!(messages[run_end].role, MessageRole::Tool) {
            if let Some(id) = &messages[run_end].tool_call_id {
                answered.insert(id.clone());
            }
            run_end += 1;
        }
        let mut insert_at = run_end;
        for tc in &calls {
            if answered.contains(&tc.id) {
                continue;
            }
            let stray = (run_end..messages.len()).find(|&k| {
                matches!(messages[k].role, MessageRole::Tool)
                    && messages[k].tool_call_id.as_deref() == Some(tc.id.as_str())
            });
            let result = match stray {
                Some(k) => messages.remove(k),
                None => ChatMessage {
                    role: MessageRole::Tool,
                    content: format!(
                        "[tool execution interrupted: `{}` produced no result on the previous turn]",
                        tc.name
                    ),
                    tool_call_id: Some(tc.id.clone()),
                    name: Some(tc.name.clone()),
                    ..ChatMessage::default()
                },
            };
            messages.insert(insert_at, result);
            insert_at += 1;
            fixed += 1;
        }
        i = insert_at.max(i + 1);
    }
    let mut allowed: HashSet<String> = HashSet::new();
    let before = messages.len();
    messages.retain(|m| match m.role {
        MessageRole::Assistant => {
            allowed = m.tool_calls.iter().map(|c| c.id.clone()).collect();
            true
        }
        MessageRole::Tool => m
            .tool_call_id
            .as_deref()
            .is_some_and(|id| allowed.contains(id)),
        _ => {
            allowed.clear();
            true
        }
    });
    fixed + (before - messages.len())
}

/// Runs [`repair_tool_pairs`] on the live transcript before a provider call
/// (every round, and when a chat opens).
pub(crate) async fn repair_orphan_tool_calls(runtime: &Arc<Mutex<ChatRuntime>>) {
    let mut g = runtime.lock().await;
    let fixed = repair_tool_pairs(&mut g.messages);
    if fixed > 0 {
        tracing::info!(fixed, "agent: repaired tool-call/result pairing");
    }
}

/// Conditional compaction — runs at most once per `run_turn_loop`
/// round, no-ops below the threshold. Use `force=true` for a manual
/// trigger from the chat UI's "Compact now" button; that path skips
/// the token threshold and always summarises if there's enough head
/// to be worth folding.
pub(crate) async fn maybe_run_compaction(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    cluster_id: &str,
    session_id: &str,
) {
    run_compaction_internal(runtime, store, provider, cluster_id, session_id, false).await;
}

pub(crate) async fn run_compaction_internal(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    provider: &Arc<dyn ChatProvider>,
    cluster_id: &str,
    session_id: &str,
    force: bool,
) {
    let (last_total, model, kind, message_count, in_flight) = {
        let g = runtime.lock().await;
        (
            g.last_total_tokens,
            g.model.clone(),
            g.provider_kind,
            g.messages.len(),
            g.compaction_in_flight,
        )
    };
    if in_flight {
        return;
    }
    // Need at least one tail-keep + a few summarisable messages
    // before compaction is meaningful. Empty / short chats: skip.
    if message_count <= COMPACTION_TAIL_KEEP + 2 {
        return;
    }
    if !force && last_total == 0 {
        return;
    }
    // Resolve the model's usable window via models.dev (or per-
    // provider default).
    let context = ferrisscope_agent::provider::catalogue::context_window(kind, &model);
    let reserved = ferrisscope_agent::provider::catalogue::reserved_tokens(kind, &model);
    let usable = context.saturating_sub(reserved);
    let trigger = (usable as f32 * COMPACTION_TRIGGER_FRACTION) as u32;
    if !force && last_total < trigger {
        return;
    }

    // Mark in-flight under the same lock we use to grab the head, so
    // a concurrent re-entry is impossible. Then run the summarisation
    // call outside the lock.
    let (head, head_count) = {
        let mut g = runtime.lock().await;
        if g.compaction_in_flight {
            return;
        }
        if g.messages.len() <= COMPACTION_TAIL_KEEP + 2 {
            return;
        }
        g.compaction_in_flight = true;
        // Naive cut + advance past leading Tool messages. Without this
        // the tail can begin with a Tool whose matching Assistant
        // `tool_calls` lives in the head we just folded — the next
        // turn would send orphan tool outputs and providers reject
        // them ("No tool call found for function call output with
        // call_id …" on Codex Responses; the equivalent 400 on
        // Anthropic). Advancing the cut absorbs those orphans into
        // the head; the summary already covers what they contained.
        let mut cut = g.messages.len() - COMPACTION_TAIL_KEEP;
        while cut < g.messages.len() && matches!(g.messages[cut].role, MessageRole::Tool) {
            cut += 1;
        }
        let head: Vec<ChatMessage> = g.messages[..cut].to_vec();
        (head, cut)
    };

    let _ = runtime
        .lock()
        .await
        .channel
        .send(ChatEvent::CompactionStarted {
            tokens_before: last_total,
            head_message_count: head_count as u32,
        });
    tracing::info!(
        last_total,
        usable,
        head_count,
        "agent: running auto-compaction"
    );

    // Build the summarisation request. We use the same provider but
    // an empty tools list and a system+user prompt that shows the
    // head transcript followed by the structured-summary instruction.
    let transcript_text = render_head_for_summary(&head);
    let req = CompletionRequest {
        model: model.clone(),
        messages: vec![
            ChatMessage {
                role: MessageRole::System,
                content: COMPACTION_PROMPT.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
                thinking_blocks: vec![],
                images: vec![],
            },
            ChatMessage {
                role: MessageRole::User,
                content: transcript_text,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
                thinking_blocks: vec![],
                images: vec![],
            },
        ],
        tools: vec![],
        // Keep sampling unconstrained — the model picks its own
        // budget for the summary. Most vendors handle this fine.
        temperature: None,
        max_tokens: None,
        provider_options: None,
    };

    // Sink that just accumulates text — no streaming UI for the
    // compaction call itself; from the operator's POV it's
    // transparent overhead. `std::sync::Mutex` with a blocking
    // `.lock()` is the right primitive here: the sink is sync, never
    // awaits while holding the lock, and we cannot afford to drop
    // bytes the way a tokio `try_lock` would on contention — a single
    // missing `(` or `)` corrupts every `[label](url)` link in the
    // summary and breaks the operator's ferrisscope:// nav.
    let summary_buf: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let buf_clone = summary_buf.clone();
    let sink: ferrisscope_agent::provider::EventSink = Box::new(move |evt: CompletionEvent| {
        if let CompletionEvent::TokenDelta(s) = evt {
            if let Ok(mut g) = buf_clone.lock() {
                g.push_str(&s);
            }
        }
    });

    let outcome = provider.stream_completion(req, sink).await;
    let summary = match outcome {
        Ok(_) => summary_buf.lock().map(|g| g.clone()).unwrap_or_default(),
        Err(e) => {
            tracing::warn!(error = %e, "agent: compaction call failed; clearing in-flight flag");
            runtime.lock().await.compaction_in_flight = false;
            return;
        }
    };
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        tracing::warn!("agent: compaction produced empty summary; skipping replacement");
        runtime.lock().await.compaction_in_flight = false;
        return;
    }

    // Replace the head with the synthetic checkpoint message in-place, then
    // log the marker with the tail it kept, all under one lock hold so the
    // tail is exactly what the live transcript continues with. A crash before
    // the marker lands leaves the full history in the log — bigger, never
    // inconsistent. Reset the token total so the next Usage event restarts the
    // running view, and clear the in-flight flag so the next round proceeds.
    let now = chrono::Utc::now().timestamp_millis();
    let tail: Vec<ChatMessage> = {
        let mut g = runtime.lock().await;
        let tail: Vec<ChatMessage> = g.messages.split_off(head_count);
        g.messages.clear();
        g.messages.push(ChatMessage {
            role: MessageRole::Assistant,
            content: format!("[context checkpoint]\n{summary}"),
            name: Some("context_checkpoint".to_string()),
            ..ChatMessage::default()
        });
        g.messages.extend(tail.iter().cloned());
        g.last_total_tokens = 0;
        g.compaction_in_flight = false;
        let _ = store
            .append(
                cluster_id,
                session_id,
                SessionEvent::Compaction {
                    head_message_count: head_count as u32,
                    tokens_before: last_total,
                    summary: summary.clone(),
                    tail: tail.clone(),
                    ts: now,
                },
            )
            .await;
        tail
    };

    // Belt-and-braces: pad any Assistant tool_calls in the surviving
    // tail that no longer have matching Tool answers (manual compact
    // mid-turn can split an Assistant→Tool group). Without this the
    // next round would 400 on the converse orphan ("No tool output
    // found for function call …").
    repair_orphan_tool_calls(runtime).await;

    let _ = runtime
        .lock()
        .await
        .channel
        .send(ChatEvent::CompactionCompleted {
            summary_chars: summary.len() as u32,
            summary: summary.clone(),
            tail,
        });
    tracing::info!("agent: auto-compaction complete");
}

/// Render the head of a transcript as a single bounded text block the
/// summarisation call can ingest. We strip schemas and stringify
/// tool calls so the summarisation prompt isn't itself contaminated
/// with provider-shape JSON.
fn render_head_for_summary(messages: &[ChatMessage]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    out.push_str("Conversation transcript to summarise:\n\n");
    for m in messages {
        let role = match m.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        let _ = writeln!(out, "[{role}]");
        if !m.content.is_empty() {
            // Cap each message at 8k chars so a single huge tool
            // result doesn't push the summarisation request itself
            // past the model's context.
            const PER_MSG_CAP: usize = 8000;
            if m.content.len() > PER_MSG_CAP {
                // Split on a char boundary — a raw `&m.content[..8000]`
                // panics when byte 8000 lands mid-codepoint (UTF-8 in a
                // tool result is enough to trip it).
                let end = char_boundary_floor(&m.content, PER_MSG_CAP);
                out.push_str(&m.content[..end]);
                let _ = writeln!(out, "\n…(truncated, {} bytes)", m.content.len());
            } else {
                out.push_str(&m.content);
                out.push('\n');
            }
        }
        for tc in &m.tool_calls {
            let _ = writeln!(out, "called tool `{}` with {}", tc.name, tc.arguments);
        }
        out.push('\n');
    }
    out
}

// SSH-tunneled scratch kubeconfig logic lives in `crate::ssh_scratch` so the
// terminal and helm-CLI paths can share it. The MCP path is one of three
// callers; nothing here is MCP-specific.

#[cfg(test)]
mod tests {
    use super::*;
    use ferrisscope_agent::ToolCall;

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: MessageRole::User,
            content: text.into(),
            ..ChatMessage::default()
        }
    }

    fn assistant_calling(ids: &[&str]) -> ChatMessage {
        ChatMessage {
            role: MessageRole::Assistant,
            tool_calls: ids
                .iter()
                .map(|id| ToolCall {
                    id: (*id).into(),
                    name: "fs_pods_list".into(),
                    arguments: "{}".into(),
                    thought_signature: None,
                })
                .collect(),
            ..ChatMessage::default()
        }
    }

    fn result(id: &str) -> ChatMessage {
        ChatMessage {
            role: MessageRole::Tool,
            content: format!("result {id}"),
            tool_call_id: Some(id.into()),
            name: Some("fs_pods_list".into()),
            ..ChatMessage::default()
        }
    }

    fn shape(messages: &[ChatMessage]) -> Vec<String> {
        messages
            .iter()
            .map(|m| match m.role {
                MessageRole::User => format!("user:{}", m.content),
                MessageRole::Assistant => format!(
                    "asst[{}]",
                    m.tool_calls
                        .iter()
                        .map(|c| c.id.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                MessageRole::Tool => format!("tool:{}", m.tool_call_id.clone().unwrap_or_default()),
                MessageRole::System => "system".into(),
            })
            .collect()
    }

    #[test]
    fn a_call_cut_off_at_the_end_of_the_transcript_gets_an_interrupted_result() {
        let mut m = vec![user("scale it"), assistant_calling(&["a"])];
        assert_eq!(repair_tool_pairs(&mut m), 1);
        assert_eq!(shape(&m), ["user:scale it", "asst[a]", "tool:a"]);
        assert!(m[2].content.contains("interrupted"));
    }

    #[test]
    fn the_result_lands_right_after_its_call_not_after_later_messages() {
        // Cancelled mid-tool, then the operator wrote again and the model answered.
        let mut m = vec![
            user("scale it"),
            assistant_calling(&["a"]),
            user("never mind"),
            ChatMessage {
                role: MessageRole::Assistant,
                content: "ok".into(),
                ..ChatMessage::default()
            },
        ];
        repair_tool_pairs(&mut m);
        assert_eq!(
            shape(&m),
            [
                "user:scale it",
                "asst[a]",
                "tool:a",
                "user:never mind",
                "asst[]"
            ]
        );
    }

    #[test]
    fn only_the_unanswered_calls_of_a_parallel_batch_are_padded() {
        let mut m = vec![assistant_calling(&["a", "b", "c"]), result("b"), user("hi")];
        assert_eq!(repair_tool_pairs(&mut m), 2);
        assert_eq!(
            shape(&m),
            ["asst[a,b,c]", "tool:b", "tool:a", "tool:c", "user:hi"]
        );
    }

    #[test]
    fn a_result_stranded_after_a_user_message_is_moved_next_to_its_call() {
        // What a previous version's repair left in the log: the padding went at
        // the end, behind the message sent after the cancelled turn.
        let mut m = vec![assistant_calling(&["a"]), user("never mind"), result("a")];
        assert_eq!(repair_tool_pairs(&mut m), 1);
        assert_eq!(shape(&m), ["asst[a]", "tool:a", "user:never mind"]);
        assert_eq!(m[1].content, "result a", "moved, not replaced");
    }

    #[test]
    fn results_that_answer_no_call_are_dropped() {
        let mut m = vec![
            user("hi"),
            result("ghost"),
            assistant_calling(&["a"]),
            result("a"),
        ];
        assert_eq!(repair_tool_pairs(&mut m), 1);
        assert_eq!(shape(&m), ["user:hi", "asst[a]", "tool:a"]);
    }

    #[test]
    fn a_well_formed_transcript_is_left_alone_and_repair_is_idempotent() {
        let ok = vec![
            user("go"),
            assistant_calling(&["a", "b"]),
            result("a"),
            result("b"),
            assistant_calling(&["c"]),
            result("c"),
        ];
        let mut m = ok.clone();
        assert_eq!(repair_tool_pairs(&mut m), 0);
        assert_eq!(shape(&m), shape(&ok));

        let mut broken = vec![
            assistant_calling(&["a"]),
            user("x"),
            assistant_calling(&["b"]),
        ];
        repair_tool_pairs(&mut broken);
        let once = shape(&broken);
        assert_eq!(repair_tool_pairs(&mut broken), 0);
        assert_eq!(shape(&broken), once);
    }

    /// Smoke test: token-driven flow keeps the full transcript on the wire,
    /// no byte/char pre-truncation. Compaction (proactive at 75%, reactive
    /// on 400) is the only management lever now — mirrors opencode's flow.
    #[test]
    fn context_limits_match_catalogue_default() {
        // Unknown model id → falls back to the per-provider default
        // context window (200k for OpenAI). Usable subtracts the
        // reserved output buffer (≥ 2048, ≤ 20_000).
        let (context, usable) = context_limits_for(ProviderKind::OpenAI, "unknown");
        assert_eq!(context, 200_000);
        assert!(
            usable < context && usable >= context.saturating_sub(20_000),
            "usable {usable} should be context {context} minus reserved (≤20k)"
        );
    }
}
