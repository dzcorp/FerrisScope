//! `fs_tool_output_read` / `fs_tool_output_grep` — recover the full payload of
//! a tool result that was truncated before it entered the conversation.
//!
//! When a tool's output exceeds `MAX_TOOL_RESULT_BYTES` (see `agent.rs`) the
//! agent loop spills the full text to disk and replaces it inline with a head
//! preview plus a `handle` (the tool call id). These two read-only tools serve
//! that spilled file back: page a byte window, or substring-search the whole
//! thing. This is the same idea as opencode's truncation directory, adapted to
//! ferrisscope's native-tool surface.
//!
//! ## Layout & lifecycle
//!
//! `<cache_dir>/tool-output/<cluster>/<session>/<handle>`. Files are written
//! under the OS cache dir (sibling concept to the session JSONL, which lives
//! under the *config* dir). They deliberately **survive chat reopen and app
//! restart** — a reopened chat rebuilds these tools against the same
//! cluster/session path, so the handles from the rehydrated transcript still
//! resolve. Cleanup is by TTL sweep ([`sweep_expired`], run on chat open),
//! not on chat close, so the operator can still inspect a large result after
//! closing and reopening the chat. Best-effort throughout: a missing cache
//! dir or a failed write degrades to lossy truncation, never a panic.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use directories::ProjectDirs;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::char_boundary_floor;

/// How long a spilled output lingers before the sweep reaps it. Matches
/// opencode's retention. The cache dir is OS-reapable anyway; this bounds our
/// own footprint without cutting off an operator who comes back the next day.
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Default + max bytes one `fs_tool_output_read` window returns. Capped at the
/// same order of magnitude as the transcript limit so paging the spool can't
/// re-blow the context window it was meant to relieve.
const READ_DEFAULT_LIMIT: usize = 30_000;
const READ_MAX_LIMIT: usize = 100_000;

/// `fs_tool_output_grep` guardrails.
const GREP_DEFAULT_MAX_MATCHES: usize = 50;
const GREP_MAX_MATCHES: usize = 500;
const GREP_DEFAULT_CONTEXT: usize = 160;
const GREP_MAX_CONTEXT: usize = 2_000;

/// Keep path components tame — same shape as the session store's sanitiser.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Root for all spilled tool output. `None` only when the platform exposes no
/// cache dir (extremely rare); callers degrade to lossy truncation.
fn spool_root() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.cache_dir().join("tool-output"))
}

/// Handle to one chat's spool directory. Cheap to clone (a `PathBuf`). Shared
/// between the agent loop (writes on truncation) and the read/grep tools
/// (serve windows / matches). `dir == None` means no cache dir is available;
/// `put` no-ops and the loop falls back to lossy truncation.
#[derive(Clone)]
pub(crate) struct ToolSpool {
    dir: Option<PathBuf>,
}

impl ToolSpool {
    pub(crate) fn new(cluster_id: &str, session_id: &str) -> Self {
        let dir = spool_root().map(|r| r.join(sanitize(cluster_id)).join(sanitize(session_id)));
        Self { dir }
    }

    fn path_for(&self, handle: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(sanitize(handle)))
    }

    /// Persist `content` under `handle`. Best-effort: returns `false` (caller
    /// falls back to lossy truncation) when there's no cache dir or the write
    /// fails. Never panics.
    pub(crate) async fn put(&self, handle: &str, content: &str) -> bool {
        let (Some(dir), Some(path)) = (self.dir.as_ref(), self.path_for(handle)) else {
            return false;
        };
        if let Err(e) = tokio::fs::create_dir_all(dir).await {
            tracing::warn!(error = %e, "tool-output spool: mkdir failed");
            return false;
        }
        if let Err(e) = tokio::fs::write(&path, content).await {
            tracing::warn!(error = %e, "tool-output spool: write failed");
            return false;
        }
        true
    }

    async fn load(&self, handle: &str) -> Result<String, NativeToolError> {
        let path = self
            .path_for(handle)
            .ok_or_else(|| NativeToolError::msg("tool-output spool unavailable on this host"))?;
        match tokio::fs::read_to_string(&path).await {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(NativeToolError::msg(format!(
                    "no spilled output for handle `{handle}` — it may have expired, or this \
                     chat predates output spooling. Re-run the original tool with a narrower \
                     request (label/field selector, a more specific name, namespace, or limit)."
                )))
            }
            Err(e) => Err(NativeToolError::msg(format!("read spool failed: {e}"))),
        }
    }
}

/// Drop spilled outputs whose newest file is older than [`RETENTION`].
/// Best-effort; called on chat open. Walks `<root>/<cluster>/<session>` and
/// removes whole session dirs past the cutoff, then prunes emptied cluster
/// dirs so the tree doesn't accrete forever.
pub(crate) async fn sweep_expired() {
    let Some(root) = spool_root() else { return };
    let Some(cutoff) = SystemTime::now().checked_sub(RETENTION) else {
        return;
    };
    let Ok(mut clusters) = tokio::fs::read_dir(&root).await else {
        return; // no spool yet
    };
    while let Ok(Some(cluster)) = clusters.next_entry().await {
        let cluster_path = cluster.path();
        let Ok(mut sessions) = tokio::fs::read_dir(&cluster_path).await else {
            continue;
        };
        let mut any_left = false;
        while let Ok(Some(session)) = sessions.next_entry().await {
            let session_path = session.path();
            if dir_is_stale(&session_path, cutoff).await {
                let _ = tokio::fs::remove_dir_all(&session_path).await;
            } else {
                any_left = true;
            }
        }
        if !any_left {
            let _ = tokio::fs::remove_dir(&cluster_path).await;
        }
    }
}

/// True when every file in `dir` is older than `cutoff` (or the dir is empty /
/// unreadable). A session touched recently keeps all its handles.
async fn dir_is_stale(dir: &Path, cutoff: SystemTime) -> bool {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return true;
    };
    let mut newest: Option<SystemTime> = None;
    while let Ok(Some(e)) = entries.next_entry().await {
        if let Ok(modified) = e.metadata().await.and_then(|m| m.modified()) {
            newest = Some(newest.map_or(modified, |n| n.max(modified)));
        }
    }
    newest.is_none_or(|m| m < cutoff)
}

// ── read ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ReadArgs {
    handle: String,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) struct ToolOutputRead {
    spool: ToolSpool,
}

impl ToolOutputRead {
    pub(crate) fn new(spool: ToolSpool) -> Self {
        Self { spool }
    }
}

#[async_trait]
impl NativeTool for ToolOutputRead {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_tool_output_read".to_string(),
            description: format!(
                "Page through the full output of a tool result that was truncated before it \
                 entered the conversation. Oversized output is spilled to disk and shown \
                 inline as a head preview plus a `handle` (the tool call id, e.g. \
                 `call_abc123`). Pass that handle to read a byte window: up to {READ_MAX_LIMIT} \
                 bytes per call (default {READ_DEFAULT_LIMIT}). Use the returned `next_offset` to \
                 continue. To locate specific content in a large result prefer \
                 `fs_tool_output_grep`. Spilled output persists for {days} days and survives \
                 reopening the chat.",
                days = RETENTION.as_secs() / 86_400,
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "handle": {
                        "type": "string",
                        "description": "Handle from the truncation notice (the tool call id)."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 0,
                        "description": "Byte offset to start reading from."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": READ_MAX_LIMIT,
                        "default": READ_DEFAULT_LIMIT,
                        "description": "Max bytes to return."
                    }
                },
                "required": ["handle"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: ReadArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let content = self.spool.load(&a.handle).await?;
        let total = content.len();
        let limit = a
            .limit
            .unwrap_or(READ_DEFAULT_LIMIT)
            .clamp(1, READ_MAX_LIMIT);
        let start = char_boundary_floor(&content, a.offset.min(total));
        let end = char_boundary_floor(&content, start.saturating_add(limit).min(total));
        let slice = &content[start..end.max(start)];
        Ok(json!({
            "handle": a.handle,
            "total_bytes": total,
            "offset": start,
            "returned_bytes": slice.len(),
            "next_offset": if end < total { Some(end) } else { None },
            "eof": end >= total,
            "content": slice,
        }))
    }
}

// ── grep ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GrepArgs {
    handle: String,
    pattern: String,
    #[serde(default)]
    ignore_case: bool,
    #[serde(default)]
    max_matches: Option<usize>,
    #[serde(default)]
    context_bytes: Option<usize>,
}

pub(crate) struct ToolOutputGrep {
    spool: ToolSpool,
}

impl ToolOutputGrep {
    pub(crate) fn new(spool: ToolSpool) -> Self {
        Self { spool }
    }
}

#[async_trait]
impl NativeTool for ToolOutputGrep {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_tool_output_grep".to_string(),
            description: format!(
                "Substring-search the full output of a tool result that was truncated before \
                 it entered the conversation (see `fs_tool_output_read` for the handle). \
                 Returns each match's byte offset, line number, and a surrounding snippet \
                 (±{GREP_DEFAULT_CONTEXT} bytes by default). Plain substring match — not regex. \
                 Caps at {GREP_DEFAULT_MAX_MATCHES} matches by default ({GREP_MAX_MATCHES} max); \
                 `truncated: true` means more exist past the cap."
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "handle": {
                        "type": "string",
                        "description": "Handle from the truncation notice (the tool call id)."
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Substring to search for. Not a regex."
                    },
                    "ignore_case": {
                        "type": "boolean",
                        "default": false,
                        "description": "ASCII case-insensitive match."
                    },
                    "max_matches": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": GREP_MAX_MATCHES,
                        "default": GREP_DEFAULT_MAX_MATCHES
                    },
                    "context_bytes": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": GREP_MAX_CONTEXT,
                        "default": GREP_DEFAULT_CONTEXT,
                        "description": "Bytes of surrounding context to include around each match."
                    }
                },
                "required": ["handle", "pattern"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: GrepArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        if a.pattern.is_empty() {
            return Err(NativeToolError::msg("pattern must not be empty"));
        }
        let content = self.spool.load(&a.handle).await?;
        let max_matches = a
            .max_matches
            .unwrap_or(GREP_DEFAULT_MAX_MATCHES)
            .clamp(1, GREP_MAX_MATCHES);
        let context = a
            .context_bytes
            .unwrap_or(GREP_DEFAULT_CONTEXT)
            .clamp(0, GREP_MAX_CONTEXT);

        let bytes = content.as_bytes();
        let mut matches: Vec<Value> = Vec::new();
        let mut from = 0usize;
        let mut nl_counted_to = 0usize;
        let mut line = 1usize;
        while matches.len() < max_matches {
            let Some(pos) = next_match(&content, &a.pattern, from, a.ignore_case) else {
                break;
            };
            // Line number: count newlines between the last match and this one.
            // Byte-slice (never str-slice) so a non-boundary offset from the
            // case-insensitive path can't panic.
            line += bytes[nl_counted_to..pos]
                .iter()
                .filter(|&&b| b == b'\n')
                .count();
            nl_counted_to = pos;
            let (window_offset, snippet) = window(&content, pos, a.pattern.len(), context);
            matches.push(json!({
                "offset": pos,
                "line": line,
                "window_offset": window_offset,
                "snippet": snippet,
            }));
            from = pos + a.pattern.len(); // pattern non-empty ⇒ forward progress
        }
        let truncated = matches.len() == max_matches
            && next_match(&content, &a.pattern, from, a.ignore_case).is_some();

        Ok(json!({
            "handle": a.handle,
            "pattern": a.pattern,
            "ignore_case": a.ignore_case,
            "total_bytes": content.len(),
            "match_count": matches.len(),
            "truncated": truncated,
            "matches": matches,
        }))
    }
}

/// First match at or after byte `from`. Case-sensitive uses `str::find`
/// (memchr-fast, boundary-aligned offsets). Case-insensitive folds ASCII only
/// — which preserves byte length, so offsets still line up with the original
/// content. Returns `None` past the end.
fn next_match(content: &str, pattern: &str, from: usize, ignore_case: bool) -> Option<usize> {
    let h = content.as_bytes();
    let n = pattern.as_bytes();
    if n.is_empty() || from > h.len() {
        return None;
    }
    if ignore_case {
        let mut i = from;
        while i + n.len() <= h.len() {
            if h[i..i + n.len()].eq_ignore_ascii_case(n) {
                return Some(i);
            }
            i += 1;
        }
        None
    } else {
        // `from` is always a char boundary here (0, or the end of a previous
        // case-sensitive match), so `get(from..)` is `Some`.
        content.get(from..)?.find(pattern).map(|p| from + p)
    }
}

/// Byte window of `content` around a match, clamped to char boundaries on both
/// ends so the snippet is always valid UTF-8. Returns `(window_start, snippet)`.
fn window(content: &str, pos: usize, match_len: usize, context: usize) -> (usize, String) {
    let start = char_boundary_floor(content, pos.saturating_sub(context));
    let raw_end = pos
        .saturating_add(match_len)
        .saturating_add(context)
        .min(content.len());
    let end = char_boundary_floor(content, raw_end).max(start);
    (start, content[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_spool() -> ToolSpool {
        let dir = std::env::temp_dir().join(format!("fs-spool-test-{}", uuid::Uuid::new_v4()));
        ToolSpool { dir: Some(dir) }
    }

    #[test]
    fn read_schema_advertises_prefix_and_required_handle() {
        let s = ToolOutputRead::new(temp_spool()).schema();
        assert_eq!(s.name, "fs_tool_output_read");
        let required = s.parameters["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "handle"));
    }

    #[test]
    fn grep_schema_and_categories_are_read() {
        let g = ToolOutputGrep::new(temp_spool());
        assert_eq!(g.schema().name, "fs_tool_output_grep");
        assert_eq!(g.category(), ToolCategory::Read);
        assert_eq!(
            ToolOutputRead::new(temp_spool()).category(),
            ToolCategory::Read
        );
    }

    #[tokio::test]
    async fn read_pages_window_and_reports_next_offset() {
        let spool = temp_spool();
        let body = "0123456789".repeat(10); // 100 bytes
        assert!(spool.put("h1", &body).await);
        let tool = ToolOutputRead::new(spool);

        let first = tool
            .call(json!({ "handle": "h1", "offset": 0, "limit": 40 }))
            .await
            .unwrap();
        assert_eq!(first["total_bytes"], 100);
        assert_eq!(first["returned_bytes"], 40);
        assert_eq!(first["eof"], false);
        assert_eq!(first["next_offset"], 40);
        assert_eq!(first["content"].as_str().unwrap(), &body[..40]);

        let last = tool
            .call(json!({ "handle": "h1", "offset": 80, "limit": 40 }))
            .await
            .unwrap();
        assert_eq!(last["returned_bytes"], 20);
        assert_eq!(last["eof"], true);
        assert!(last["next_offset"].is_null());
    }

    #[tokio::test]
    async fn read_missing_handle_is_a_clear_error() {
        let tool = ToolOutputRead::new(temp_spool());
        let err = tool.call(json!({ "handle": "nope" })).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("nope"), "error names the handle: {msg}");
        assert!(msg.contains("Re-run"), "error suggests recovery: {msg}");
    }

    #[tokio::test]
    async fn grep_finds_matches_with_line_numbers() {
        let spool = temp_spool();
        let body = "alpha error one\nbeta ok\ngamma error two\ndelta ok\n";
        assert!(spool.put("g1", body).await);
        let tool = ToolOutputGrep::new(spool);

        let out = tool
            .call(json!({ "handle": "g1", "pattern": "error" }))
            .await
            .unwrap();
        assert_eq!(out["match_count"], 2);
        assert_eq!(out["truncated"], false);
        let matches = out["matches"].as_array().unwrap();
        assert_eq!(matches[0]["line"], 1);
        assert_eq!(matches[1]["line"], 3);
        assert!(matches[0]["snippet"]
            .as_str()
            .unwrap()
            .contains("alpha error"));
    }

    #[tokio::test]
    async fn grep_respects_max_matches_and_flags_truncation() {
        let spool = temp_spool();
        let body = "x\n".repeat(10); // 10 lines each containing 'x'
        assert!(spool.put("g2", &body).await);
        let tool = ToolOutputGrep::new(spool);

        let out = tool
            .call(json!({ "handle": "g2", "pattern": "x", "max_matches": 3 }))
            .await
            .unwrap();
        assert_eq!(out["match_count"], 3);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn grep_ignore_case_folds_ascii() {
        let spool = temp_spool();
        assert!(spool.put("g3", "Found a FATAL Fault").await);
        let tool = ToolOutputGrep::new(spool);

        let sensitive = tool
            .call(json!({ "handle": "g3", "pattern": "fatal" }))
            .await
            .unwrap();
        assert_eq!(sensitive["match_count"], 0);

        let insensitive = tool
            .call(json!({ "handle": "g3", "pattern": "fatal", "ignore_case": true }))
            .await
            .unwrap();
        assert_eq!(insensitive["match_count"], 1);
    }

    #[tokio::test]
    async fn grep_handles_multibyte_without_panic() {
        let spool = temp_spool();
        // Multibyte chars around the match so naive slicing would panic.
        assert!(spool.put("g4", "héllo wörld NEEDLE café").await);
        let tool = ToolOutputGrep::new(spool);
        let out = tool
            .call(json!({ "handle": "g4", "pattern": "NEEDLE", "context_bytes": 3 }))
            .await
            .unwrap();
        assert_eq!(out["match_count"], 1);
        // Snippet is valid UTF-8 (it deserialised as a str at all).
        assert!(out["matches"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains("NEEDLE"));
    }

    #[tokio::test]
    async fn put_then_load_round_trips() {
        let spool = temp_spool();
        let body = "round trip payload";
        assert!(spool.put("rt", body).await);
        assert_eq!(spool.load("rt").await.unwrap(), body);
    }
}
