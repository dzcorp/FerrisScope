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

/// Pad any `Assistant.tool_calls[].id` that doesn't have a matching
/// downstream `Tool.tool_call_id` with a synthetic tool-result
/// message. Both OpenAI Responses (`No tool output found for function
/// call …`) and Anthropic (`tool_use_id … must be followed by
/// tool_result`) reject orphans with 400.
///
/// Persists each synthetic tool message via `SessionEvent::Message`
/// so a reload sees the same repaired transcript — without this,
/// every chat_open would re-orphan and we'd loop. The original (now
/// reconciled) tool_call line stays in the JSONL for audit.
pub(crate) async fn repair_orphan_tool_calls(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    cluster_id: &str,
    session_id: &str,
) {
    // Collect orphans under the lock, mutate, release. Persistence
    // happens outside the lock — best-effort.
    let synthetic: Vec<ChatMessage> = {
        let mut g = runtime.lock().await;
        let mut synthetic: Vec<ChatMessage> = Vec::new();
        // Walk left-to-right. Every assistant message's tool_call ids
        // must be answered by a subsequent Tool message before the
        // next Assistant message (or EOF). When we find an unanswered
        // id, append a synthetic tool result immediately after the
        // last answered one (or at the end if there are none).
        let mut i = 0;
        while i < g.messages.len() {
            let calls = match &g.messages[i] {
                m if matches!(m.role, MessageRole::Assistant) && !m.tool_calls.is_empty() => {
                    m.tool_calls.clone()
                }
                _ => {
                    i += 1;
                    continue;
                }
            };
            // Find which ids are answered between here and the next
            // assistant message (or the end).
            let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
            let mut j = i + 1;
            while j < g.messages.len() {
                let m = &g.messages[j];
                if matches!(m.role, MessageRole::Assistant) {
                    break;
                }
                if matches!(m.role, MessageRole::Tool) {
                    if let Some(id) = m.tool_call_id.as_ref() {
                        answered.insert(id.clone());
                    }
                }
                j += 1;
            }
            // For each unanswered tool_call, splice in a synthetic
            // tool result right before `j` (the next assistant
            // boundary or EOF).
            let mut insert_at = j;
            for tc in &calls {
                if answered.contains(&tc.id) {
                    continue;
                }
                let msg = ChatMessage {
                    role: MessageRole::Tool,
                    content: format!(
                        "[tool execution interrupted: `{}` produced no result on the previous turn]",
                        tc.name
                    ),
                    tool_calls: vec![],
                    tool_call_id: Some(tc.id.clone()),
                    name: Some(tc.name.clone()),
                    reasoning_content: None,
                    images: vec![],
                };
                g.messages.insert(insert_at, msg.clone());
                synthetic.push(msg);
                insert_at += 1;
            }
            i = insert_at.max(i + 1);
        }
        synthetic
    };
    if synthetic.is_empty() {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();
    for msg in synthetic {
        let _ = store
            .append(
                cluster_id,
                session_id,
                SessionEvent::Message {
                    message: msg,
                    ts: now,
                },
            )
            .await;
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
    let (last_total, model, message_count, in_flight) = {
        let g = runtime.lock().await;
        (
            g.last_total_tokens,
            g.model.clone(),
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
    let kind = match store.load(session_id).await {
        Ok(d) => d.meta.provider_kind,
        Err(_) => return,
    };
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
                images: vec![],
            },
            ChatMessage {
                role: MessageRole::User,
                content: transcript_text,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
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

    // Persist the marker BEFORE mutating in-memory transcript so a
    // crash mid-replacement doesn't leave us with a desynced view.
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Compaction {
                head_message_count: head_count as u32,
                tokens_before: last_total,
                summary: summary.clone(),
                ts: now,
            },
        )
        .await;

    // Replace the head with the synthetic checkpoint message in-
    // place. Reset token total so the next Usage event resets the
    // running view; clear the in-flight flag so the next round can
    // proceed normally.
    {
        let mut g = runtime.lock().await;
        let tail: Vec<ChatMessage> = g.messages.split_off(head_count);
        g.messages.clear();
        g.messages.push(ChatMessage {
            role: MessageRole::Assistant,
            content: format!("[context checkpoint]\n{summary}"),
            tool_calls: vec![],
            tool_call_id: None,
            name: Some("context_checkpoint".to_string()),
            reasoning_content: None,
            images: vec![],
        });
        g.messages.extend(tail);
        g.last_total_tokens = 0;
        g.compaction_in_flight = false;
    }

    // Belt-and-braces: pad any Assistant tool_calls in the surviving
    // tail that no longer have matching Tool answers (manual compact
    // mid-turn can split an Assistant→Tool group). Without this the
    // next round would 400 on the converse orphan ("No tool output
    // found for function call …").
    repair_orphan_tool_calls(runtime, store, cluster_id, session_id).await;

    let _ = runtime
        .lock()
        .await
        .channel
        .send(ChatEvent::CompactionCompleted {
            summary_chars: summary.len() as u32,
            summary: summary.clone(),
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
