//! `agent::title` — see `agent/mod.rs` for the split rationale.

use std::sync::Arc;

use ferrisscope_agent::session::SessionStore;
use ferrisscope_agent::types::{ChatMessage, MessageRole};
use ferrisscope_agent::{ChatProvider, CompletionEvent, CompletionRequest};
use tokio::sync::Mutex;

use super::{ChatEvent, ChatRuntime};

// ─── Auto-title generation ──────────────────────────────────────────────────
//
// After the first successful turn (assistant produced a non-tool reply),
// fire a background provider call that asks the model to summarise the
// conversation in a 3-5 word title. The result is journaled via
// `SessionStore::rename` and streamed to the UI as
// `ChatEvent::TitleUpdated`. Best-effort: any error path leaves the
// session's "New chat" placeholder intact.

/// Default title every freshly-minted session starts with. Mirrors the
/// `chat_create_session` constant — declared here too so the auto-title
/// gate can compare without relying on string literals scattered across
/// the file.
const DEFAULT_SESSION_TITLE: &str = "New chat";

/// Maximum characters of each side of the conversation we feed into the
/// title prompt. Generous enough to capture a question's gist; small
/// enough to keep the title-gen call cheap on the free-tier models that
/// most fresh installs land on.
const TITLE_SNAPSHOT_CHAR_LIMIT: usize = 600;

/// Hard cap on the persisted title's length. Long enough for natural
/// 3-5 word phrases, short enough that the chat header chip never has
/// to ellipsize aggressively.
const TITLE_MAX_CHARS: usize = 80;

/// Prompt shape the auto-title task feeds to the provider. Captures
/// only the first user message — title-gen fires the moment that
/// message lands, before any assistant reply exists. User text alone
/// is usually enough to characterize a chat's topic, and keeps the
/// request token budget tiny so it works under the OpenCode Zen free
/// tier without burning the operator's quota on real providers.
pub(crate) struct TitleSnapshot {
    user_text: String,
}

pub(crate) fn snapshot_for_title(messages: &[ChatMessage]) -> Option<TitleSnapshot> {
    let user = messages
        .iter()
        .find(|m| matches!(m.role, MessageRole::User))?
        .content
        .clone();
    let user_text = clip_for_title(&user);
    if user_text.trim().is_empty() {
        return None;
    }
    Some(TitleSnapshot { user_text })
}

fn clip_for_title(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= TITLE_SNAPSHOT_CHAR_LIMIT {
        return trimmed.to_string();
    }
    // Slice on a char boundary, not a byte boundary — multi-byte UTF-8
    // input (CJK, accents) would panic on a naive `&trimmed[..N]`.
    let mut out = String::with_capacity(TITLE_SNAPSHOT_CHAR_LIMIT + 1);
    for ch in trimmed.chars().take(TITLE_SNAPSHOT_CHAR_LIMIT) {
        out.push(ch);
    }
    out.push('…');
    out
}

/// Background task: ask the provider for a short title, persist it to
/// the session journal, and emit a `TitleUpdated` event so the UI's
/// header chip + sessions popover refresh without a round-trip. Any
/// failure (provider error, empty / oversized output, journal write
/// failure) is logged at WARN and silently abandoned — the session
/// simply keeps the "New chat" placeholder.
pub(crate) async fn run_auto_title_task(
    provider: Arc<dyn ChatProvider>,
    store: SessionStore,
    runtime: Arc<Mutex<ChatRuntime>>,
    cluster_id: String,
    session_id: String,
    snapshot: TitleSnapshot,
    model: String,
) {
    // Skip if the session already has a non-default title (operator
    // renamed manually before the model finished). The runtime flag
    // prevents the task from firing twice for one chat, but it doesn't
    // see operator-driven renames — the on-disk title does.
    match store.load(&session_id).await {
        Ok(data) => {
            let current = data.meta.title.trim();
            if !current.eq_ignore_ascii_case(DEFAULT_SESSION_TITLE) && !current.is_empty() {
                tracing::debug!(
                    session_id,
                    %current,
                    "auto-title: skipping — session already has a custom title",
                );
                return;
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, session_id, "auto-title: load session failed");
            return;
        }
    }

    let req = build_title_request(&snapshot, model);
    let buffer = Arc::new(std::sync::Mutex::new(String::new()));
    let buf_for_sink = buffer.clone();
    let sink: ferrisscope_agent::EventSink = Box::new(move |evt| {
        if let CompletionEvent::TokenDelta(s) = evt {
            if let Ok(mut buf) = buf_for_sink.lock() {
                buf.push_str(&s);
            }
        }
    });
    if let Err(e) = provider.stream_completion(req, sink).await {
        tracing::warn!(error = %e, session_id, "auto-title: provider call failed");
        return;
    }
    let raw = buffer.lock().map(|g| g.clone()).unwrap_or_default();
    let Some(title) = sanitise_title(&raw) else {
        tracing::warn!(session_id, raw = %raw, "auto-title: empty / unusable model output");
        return;
    };

    if let Err(e) = store.rename(&session_id, title.clone()).await {
        tracing::warn!(error = %e, session_id, "auto-title: persist failed");
        return;
    }
    let _ = cluster_id; // kept in scope for future routing — store.rename owns the lookup
    let g = runtime.lock().await;
    let _ = g.channel.send(ChatEvent::TitleUpdated {
        title: title.clone(),
    });
    tracing::info!(session_id, %title, "auto-title: applied");
}

fn build_title_request(snapshot: &TitleSnapshot, model: String) -> CompletionRequest {
    // Plain string; no markdown / JSON wrapper. Keep it short and let
    // the model output a bare title — sanitise_title will strip any
    // stray quotes / trailing punctuation regardless.
    const SYSTEM_PROMPT: &str = "You generate short, descriptive chat titles. \
        Reply with ONLY a 3 to 5 word title that captures the main topic of the \
        user's opening message below. No quotes, no surrounding punctuation, \
        no labels — just the title itself.";
    let user_content = format!("User message:\n\n{}", snapshot.user_text);
    CompletionRequest {
        model,
        messages: vec![
            ChatMessage {
                role: MessageRole::System,
                content: SYSTEM_PROMPT.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
                images: vec![],
            },
            ChatMessage {
                role: MessageRole::User,
                content: user_content,
                tool_calls: vec![],
                tool_call_id: None,
                name: None,
                reasoning_content: None,
                images: vec![],
            },
        ],
        tools: vec![],
        // Minimal request shape so title-gen works across every
        // provider in the catalogue. Reasoning-class models on
        // OpenAI's Codex Responses endpoint reject both
        // `max_output_tokens` (our `max_tokens` translation) and
        // custom `temperature`; OpenRouter / OpenAI-compat tolerate
        // either being absent; Anthropic supplies its own default
        // when `max_tokens` is unset. Output stays short via the
        // rigid system prompt and is hard-capped by `sanitise_title`,
        // so dropping these costs nothing.
        temperature: None,
        max_tokens: None,
        // Don't inherit the chat's reasoning budgets — title-gen
        // doesn't need extended thinking, and Anthropic in particular
        // adds latency for an enabled `thinking` block.
        provider_options: None,
    }
}

/// Trim quotes / trailing punctuation, collapse whitespace, cap length.
/// Returns `None` for empty or all-whitespace input.
fn sanitise_title(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();
    // Some models produce reasoning prose before the title. Take the
    // first non-empty line as the title — chat titles never legitimately
    // span multiple lines.
    if let Some(first_line) = s.lines().find(|l| !l.trim().is_empty()) {
        s = first_line.trim().to_string();
    }
    // Strip matching wrapping quotes/backticks the model occasionally
    // emits despite the system prompt forbidding them.
    for &(open, close) in &[('"', '"'), ('\'', '\''), ('`', '`'), ('“', '”'), ('‘', '’')] {
        if s.starts_with(open) && s.ends_with(close) && s.chars().count() >= 2 {
            s = s
                .chars()
                .skip(1)
                .take(s.chars().count() - 2)
                .collect::<String>();
            break;
        }
    }
    // Drop a trailing full stop / colon — natural sentence endings the
    // model adds despite the prompt; titles read better without them.
    while matches!(s.chars().last(), Some('.' | ':' | ';' | ',' | '!' | '?')) {
        s.pop();
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        return None;
    }
    // Cap by characters (not bytes) so multi-byte UTF-8 doesn't slice
    // mid-codepoint.
    let trimmed: String = s.chars().take(TITLE_MAX_CHARS).collect();
    Some(trimmed)
}
