//! `agent::tools` — see `agent/mod.rs` for the split rationale.

use std::sync::Arc;
use tokio::sync::oneshot;

use ferrisscope_agent::mcp::{McpTool, ToolCategory};
use ferrisscope_agent::session::{ApprovalDecision, SessionEvent, SessionStore};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::{ApprovalMode, ToolCall};
use tokio::sync::Mutex;

use crate::agent_native;

use super::{ChatEvent, ChatRuntime};

/// Per-tool-call execution timeout. The wrapping deadline that fires when
/// a tool itself doesn't surface a tighter internal timeout. Operations
/// like `helm install --wait`, long `kubectl rollout status`, or
/// multi-second pod-creating debug shells need real headroom; on timeout
/// we still surface `is_error: true` so the model can recover.
const TOOL_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_mins(5);

/// Hard ceiling, in bytes, on a single tool result before it enters the
/// transcript. Oversized output — a Prometheus query that returns every
/// `up` series, `kubectl get … -o json` across a busy namespace — otherwise
/// (a) bloats *every* subsequent request because the result rides along on
/// each following round, and (b) can tip the request past the model's
/// context window or, worse, make some OpenAI models return an *empty*
/// completion. The loop then retries that empty turn against the same
/// oversized transcript until it gives up ("no output after N attempts"),
/// and because the giant result is now pinned in the transcript the chat
/// stays wedged. Capping at the source keeps the transcript bounded and the
/// chat recoverable. ~30k bytes ≈ 7-8k tokens — enough for the model to see
/// the shape of a large result and decide to narrow its query.
const MAX_TOOL_RESULT_BYTES: usize = 30_000;

/// Run a single tool call. Reads execute via MCP / native immediately.
/// Writes consult the approval bridge: `AllowAllWrites` (per-chat toggle) or
/// a name in `approved_always` runs immediately; otherwise we fire an
/// `ApprovalRequest` event, await the operator's decision over a oneshot,
/// then proceed (or refuse). Unknowns are treated as writes — fail safe.
///
/// Native tools take precedence: if a name resolves to a native tool, its
/// `category()` overrides the heuristic and dispatch goes in-process. Falls
/// through to MCP otherwise.
/// Largest byte index `<= max` that falls on a UTF-8 char boundary of `s`.
/// Slicing `&s[..n]` at the returned `n` never panics mid-codepoint.
/// Returns `s.len()` when the string already fits within `max`.
pub(crate) fn char_boundary_floor(s: &str, max: usize) -> usize {
    if s.len() <= max {
        return s.len();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// Clamp a tool result to [`MAX_TOOL_RESULT_BYTES`], keeping the head and
/// appending a marker that tells the model the output was clipped. Splits on a
/// char boundary — never panics. Short results pass through untouched. Applied
/// at the single tool-call chokepoint so the cap is uniform across the wire
/// event, the model-facing transcript, and the on-disk log.
///
/// `handle: Some(id)` means the full output was spilled to disk and can be
/// recovered with `fs_tool_output_read` / `fs_tool_output_grep` — the marker
/// points the model at those tools. `None` means spilling was unavailable (no
/// cache dir / write failed), so the dropped bytes are gone and the marker
/// tells the model to narrow the request and retry instead.
fn cap_tool_result(content: String, handle: Option<&str>) -> String {
    if content.len() <= MAX_TOOL_RESULT_BYTES {
        return content;
    }
    let end = char_boundary_floor(&content, MAX_TOOL_RESULT_BYTES);
    let total = content.len();
    let dropped = total - end;
    let mut out = content;
    out.truncate(end);
    use std::fmt::Write as _;
    match handle {
        Some(h) => {
            let _ = write!(
                out,
                "\n\n…[tool output truncated: showing the first {end} of {total} bytes. \
                 Full output saved as handle \"{h}\" — call `fs_tool_output_read` \
                 (offset/limit) to page through it or `fs_tool_output_grep` (pattern) to \
                 search it. Or narrow the original request and call again.]"
            );
        }
        None => {
            let _ = write!(
                out,
                "\n\n…[tool output truncated: {dropped} of {total} bytes omitted. \
                 Narrow the request (label/field selector, a more specific name, \
                 namespace, time range, or limit) and call again to see the rest.]"
            );
        }
    }
    out
}

/// Spill an oversized tool result to the per-chat disk spool and return the
/// capped, handle-bearing preview. Results within budget pass through
/// untouched. If the spool write fails (no cache dir, IO error) we still cap —
/// just lossily, without a handle — so an oversized result can never wedge the
/// loop regardless of disk state.
pub(crate) async fn maybe_spill(
    spool: &agent_native::tool_output::ToolSpool,
    handle: &str,
    content: String,
) -> String {
    if content.len() <= MAX_TOOL_RESULT_BYTES {
        return content;
    }
    if spool.put(handle, &content).await {
        cap_tool_result(content, Some(handle))
    } else {
        cap_tool_result(content, None)
    }
}

/// `true` when the MCP tool `name` is served by a server the operator marked
/// `trust_as_read`. Walks the same per-server catalogues the dispatch lookup
/// uses, so a name is trusted iff its owning server is trusted.
async fn mcp_tool_is_trusted(runtime: &Arc<Mutex<ChatRuntime>>, name: &str) -> bool {
    let g = runtime.lock().await;
    g.mcp_servers
        .iter()
        .any(|s| s.trust_as_read && s.tools.iter().any(|t| t.name == name))
}

pub(crate) async fn execute_tool_call(
    runtime: &Arc<Mutex<ChatRuntime>>,
    store: &SessionStore,
    cluster_id: &str,
    session_id: &str,
    tc: &ToolCall,
    category: ToolCategory,
    approval_mode: ApprovalMode,
) -> (String, bool) {
    let args: serde_json::Value = match serde_json::from_str(&tc.arguments) {
        Ok(v) => v,
        Err(_) if tc.arguments.trim().is_empty() => serde_json::Value::Null,
        Err(e) => {
            tracing::warn!(error = %e, name = %tc.name, "tool call: bad json args");
            serde_json::Value::Null
        }
    };

    // Native lookup wins over name-based heuristic classification.
    let native_tool = { runtime.lock().await.native.find(&tc.name) };
    let category = match &native_tool {
        Some(t) => t.category(),
        // MCP tool: an operator-trusted server ("treat all as read") forces
        // Read so the call auto-runs; otherwise keep the passed-in name
        // heuristic. Mirrors `mcp_category`, but reuses the already-computed
        // `category` instead of re-classifying.
        None if mcp_tool_is_trusted(runtime, &tc.name).await => ToolCategory::Read,
        None => category,
    };

    let is_destructive = matches!(category, ToolCategory::Write | ToolCategory::Unknown);
    if is_destructive && approval_mode != ApprovalMode::AllowAllWrites {
        // "Approve always" remembers the tool name within this chat session.
        let already_allowed = {
            let g = runtime.lock().await;
            g.approved_always.contains(&tc.name)
        };
        if !already_allowed {
            match request_approval(runtime, tc).await {
                ApprovalDecision::Approved => {
                    persist_approval(
                        store,
                        cluster_id,
                        session_id,
                        &tc.id,
                        ApprovalDecision::Approved,
                    )
                    .await;
                }
                ApprovalDecision::ApprovedAlways => {
                    {
                        let mut g = runtime.lock().await;
                        g.approved_always.insert(tc.name.clone());
                    }
                    persist_approval(
                        store,
                        cluster_id,
                        session_id,
                        &tc.id,
                        ApprovalDecision::ApprovedAlways,
                    )
                    .await;
                }
                ApprovalDecision::Denied => {
                    persist_approval(
                        store,
                        cluster_id,
                        session_id,
                        &tc.id,
                        ApprovalDecision::Denied,
                    )
                    .await;
                    return (
                        format!(
                            "Operator denied execution of `{}`. Suggest a different \
                             approach or ask the operator to retry with adjusted args.",
                            tc.name
                        ),
                        true,
                    );
                }
            }
        }
    }

    // Approval cleared (or wasn't needed) — signal the UI that real work is
    // starting now. The matching `ToolResult` will close the strip; any
    // early return below (MCP unavailable) also produces a `ToolResult`,
    // so the strip is guaranteed to retire.
    {
        let _ = runtime
            .lock()
            .await
            .channel
            .send(ChatEvent::ToolExecutionStart {
                tool_call_id: tc.id.clone(),
                name: tc.name.clone(),
            });
    }

    if let Some(tool) = native_tool {
        // Per-tool override wins; everything else gets the global ceiling.
        let budget = tool.timeout().unwrap_or(TOOL_CALL_TIMEOUT);
        return match tokio::time::timeout(budget, tool.call(args)).await {
            Ok(Ok(value)) => (
                serde_json::to_string(&value)
                    .unwrap_or_else(|_| "<unserialisable native tool result>".to_string()),
                false,
            ),
            Ok(Err(e)) => (format!("Native tool `{}` failed: {e}", tc.name), true),
            Err(_) => (
                format!(
                    "Native tool `{}` timed out after {}s",
                    tc.name,
                    budget.as_secs()
                ),
                true,
            ),
        };
    }

    // Walk the per-server tool catalogues to find which MCP server owns
    // this name. A tool name is unique within a single server; collisions
    // across servers are rare in practice (each ecosystem prefixes its
    // own tools). On collision the first match wins — the order matches
    // the operator's `mcp_servers` config.
    let mcp_client = {
        let g = runtime.lock().await;
        g.mcp_servers.iter().find_map(|s| {
            if s.tools.iter().any(|t| t.name == tc.name) {
                s.process.as_ref().map(|p| p.client.clone())
            } else {
                None
            }
        })
    };
    let Some(client) = mcp_client else {
        return (
            format!(
                "Tool `{}` is not available — no MCP server claims this name and \
                 it isn't a native tool either.",
                tc.name
            ),
            true,
        );
    };

    match tokio::time::timeout(TOOL_CALL_TIMEOUT, client.call_tool(&tc.name, args)).await {
        Ok(Ok(value)) => {
            let is_error = value
                .get("isError")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            (
                ferrisscope_agent::mcp::flatten_tool_result(&value),
                is_error,
            )
        }
        Ok(Err(e)) => (format!("MCP tool `{}` failed: {e}", tc.name), true),
        Err(_) => (
            format!(
                "MCP tool `{}` timed out after {}s",
                tc.name,
                TOOL_CALL_TIMEOUT.as_secs()
            ),
            true,
        ),
    }
}

/// Park the loop until the operator decides via `chat_approve_tool_call`.
/// Sends the approval-request event, registers a oneshot, awaits. If the
/// chat is closed (sender dropped) we treat it as denial so the loop
/// unwinds rather than hanging.
async fn request_approval(runtime: &Arc<Mutex<ChatRuntime>>, tc: &ToolCall) -> ApprovalDecision {
    let (tx, rx) = oneshot::channel();
    {
        let mut g = runtime.lock().await;
        g.pending_approvals.insert(tc.id.clone(), tx);
        let _ = g.channel.send(ChatEvent::ApprovalRequest {
            tool_call_id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
        });
    }
    rx.await.unwrap_or(ApprovalDecision::Denied)
}

async fn persist_approval(
    store: &SessionStore,
    cluster_id: &str,
    session_id: &str,
    tool_call_id: &str,
    decision: ApprovalDecision,
) {
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            cluster_id,
            session_id,
            SessionEvent::Approval {
                tool_call_id: tool_call_id.to_string(),
                decision,
                ts: now,
            },
        )
        .await;
}

pub(crate) fn tools_to_schemas(tools: &[McpTool]) -> Vec<ToolSchema> {
    tools
        .iter()
        .map(|t| ToolSchema {
            name: t.name.clone(),
            description: t.description.clone().unwrap_or_default(),
            parameters: t.input_schema.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_tool_result_passes_short_through() {
        let s = "small tool output".to_string();
        assert_eq!(cap_tool_result(s.clone(), None), s);
    }

    #[test]
    fn cap_tool_result_passes_exact_cap_through() {
        let s = "x".repeat(MAX_TOOL_RESULT_BYTES);
        // A result sitting exactly on the cap is left untouched — no marker.
        assert_eq!(cap_tool_result(s.clone(), None), s);
    }

    #[test]
    fn cap_tool_result_truncates_oversized_with_marker() {
        let s = "y".repeat(MAX_TOOL_RESULT_BYTES + 5_000);
        // No handle (spool unavailable) → lossy marker tells the model to narrow.
        let out = cap_tool_result(s, None);
        assert!(out.starts_with(&"y".repeat(MAX_TOOL_RESULT_BYTES)));
        assert!(out.contains("tool output truncated"));
        assert!(out.contains("5000 of"));
        assert!(out.contains("Narrow the request"));
    }

    #[test]
    fn cap_tool_result_with_handle_points_at_recovery_tools() {
        let s = "z".repeat(MAX_TOOL_RESULT_BYTES + 1_000);
        let out = cap_tool_result(s, Some("call_abc123"));
        assert!(out.starts_with(&"z".repeat(MAX_TOOL_RESULT_BYTES)));
        assert!(out.contains("tool output truncated"));
        assert!(out.contains("call_abc123"));
        assert!(out.contains("fs_tool_output_read"));
        assert!(out.contains("fs_tool_output_grep"));
    }

    #[test]
    fn cap_tool_result_never_splits_codepoint() {
        // A 3-byte char straddling the cap so a naive `&s[..MAX]` would
        // panic mid-codepoint. The whole char is dropped, not split.
        let mut s = "a".repeat(MAX_TOOL_RESULT_BYTES - 1);
        s.push('€'); // occupies bytes MAX-1..=MAX+1; byte MAX is not a boundary
        s.push_str(&"b".repeat(100));
        let out = cap_tool_result(s, None); // must not panic
        assert!(out.starts_with(&"a".repeat(MAX_TOOL_RESULT_BYTES - 1)));
        assert!(!out.contains('€'));
        assert!(out.contains("tool output truncated"));
    }

    #[test]
    fn char_boundary_floor_walks_back_to_boundary() {
        // "a€" → bytes [a][€ € €], valid boundaries at 0, 1, 4.
        let s = "a€";
        assert_eq!(s.len(), 4);
        assert_eq!(char_boundary_floor(s, 5), 4, "already fits → full len");
        assert_eq!(char_boundary_floor(s, 4), 4, "exact boundary kept");
        assert_eq!(char_boundary_floor(s, 3), 1, "mid-€ floors to 1");
        assert_eq!(char_boundary_floor(s, 2), 1, "mid-€ floors to 1");
        assert_eq!(char_boundary_floor(s, 1), 1, "ascii boundary kept");
    }
}
