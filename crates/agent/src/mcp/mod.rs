//! MCP (Model Context Protocol) client.
//!
//! Talks JSON-RPC 2.0 over an arbitrary `AsyncWrite` + `AsyncRead` pair so
//! the app crate can drive a child process while this crate stays IO-shape
//! agnostic. One client = one MCP server connection. The reader runs as a
//! detached task; requests correlate by id through a `pending` map.
//!
//! Read/write classification is heuristic on tool names — see [`classify`].
//! It exists because the chat surface auto-runs read tools but defers writes
//! to the per-call approval bridge (M5.3). Heuristics live here so they can
//! be unit-tested without spinning up an MCP server.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("decode: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("server returned error: {message} (code {code})")]
    Server { code: i64, message: String },
    #[error("server channel closed before responding")]
    Closed,
    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

/// MCP protocol version we advertise during `initialize`. Servers either
/// echo back the same string or downgrade — the spec leaves negotiation
/// to the implementation, so we don't enforce equality.
pub const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCategory {
    /// Safe to auto-run. List, get, describe, view, log, top.
    Read,
    /// Requires explicit approval. Create, update, delete, exec, helm install, scale, etc.
    Write,
    /// Couldn't decide. Treat as write to stay safe.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema describing the tool's parameter shape. Forwarded to the
    /// LLM as-is; not validated locally.
    #[serde(default = "empty_object", rename = "inputSchema")]
    pub input_schema: Value,
}

fn empty_object() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// Heuristic classification by tool name. See module docs for rationale.
/// The patterns are matched substring-style on the lowercased name so any
/// mcp-go-style server (`pods_list`, `pods_create_or_update`, …) is covered.
#[must_use]
pub fn classify(name: &str) -> ToolCategory {
    let n = name.to_ascii_lowercase();
    // Order matters: "create_or_update" must beat "_update" and "_create".
    const WRITE_MARKERS: &[&str] = &[
        "create_or_update",
        "_create",
        "_update",
        "_delete",
        "_patch",
        "_apply",
        "_install",
        "_uninstall",
        "_upgrade",
        "_rollback",
        "_exec",
        "_run",
        "_scale",
        "_restart",
        "_drain",
        "_cordon",
        "_uncordon",
        "_evict",
    ];
    if WRITE_MARKERS.iter().any(|m| n.contains(m)) {
        return ToolCategory::Write;
    }
    const READ_MARKERS: &[&str] = &[
        "_list",
        "_get",
        "_describe",
        "_view",
        "_top",
        "_log",
        "_logs",
        "_status",
        "events_",
        "configuration_",
        "namespaces_",
        "resources_list",
        "resources_get",
    ];
    if READ_MARKERS.iter().any(|m| n.contains(m)) {
        return ToolCategory::Read;
    }
    ToolCategory::Unknown
}

// ─── JSON-RPC framing ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcNotification<'a> {
    jsonrpc: &'static str,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcErrorObj>,
}

#[derive(Deserialize)]
struct JsonRpcErrorObj {
    code: i64,
    message: String,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, McpError>>>>>;

/// One MCP client. Holds the writer; the reader task is detached and
/// notifies pending requests via the shared `pending` map.
pub struct McpClient {
    next_id: AtomicU64,
    writer: Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    pending: Pending,
}

impl McpClient {
    /// Wraps an already-opened `(reader, writer)` pair. Spawns a detached
    /// reader task. The caller (typically the app crate's subprocess
    /// supervisor) owns the underlying child; dropping the writer here
    /// closes the request side without killing the child by itself.
    pub fn new<W, R>(writer: W, reader: R) -> Arc<Self>
    where
        W: AsyncWrite + Unpin + Send + 'static,
        R: AsyncRead + Unpin + Send + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        tokio::spawn(async move {
            let mut buf = BufReader::new(reader);
            let mut line = String::new();
            loop {
                line.clear();
                match buf.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let resp: JsonRpcResponse = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(error = %e, line = %trimmed, "mcp: bad json line");
                        continue;
                    }
                };
                let Some(id) = resp.id.as_ref().and_then(Value::as_u64) else {
                    // Notifications and malformed ids — ignore.
                    continue;
                };
                let mut g = pending_for_reader.lock().await;
                if let Some(tx) = g.remove(&id) {
                    let payload = if let Some(err) = resp.error {
                        Err(McpError::Server {
                            code: err.code,
                            message: err.message,
                        })
                    } else {
                        Ok(resp.result.unwrap_or(Value::Null))
                    };
                    let _ = tx.send(payload);
                }
            }
            // Reader closed: fail every outstanding request so callers
            // unblock instead of hanging on a dead child.
            let mut g = pending_for_reader.lock().await;
            for (_, tx) in g.drain() {
                let _ = tx.send(Err(McpError::Closed));
            }
        });
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            writer: Mutex::new(Box::new(writer)),
            pending,
        })
    }

    async fn write_line(&self, bytes: &[u8]) -> Result<(), McpError> {
        let mut w = self.writer.lock().await;
        w.write_all(bytes).await?;
        w.write_all(b"\n").await?;
        w.flush().await?;
        Ok(())
    }

    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        let bytes = serde_json::to_vec(&req)?;
        if let Err(e) = self.write_line(&bytes).await {
            // Failed to write — clear the pending slot so we don't leak.
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match rx.await {
            Ok(r) => r,
            Err(_) => Err(McpError::Closed),
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), McpError> {
        let n = JsonRpcNotification {
            jsonrpc: "2.0",
            method,
            params,
        };
        let bytes = serde_json::to_vec(&n)?;
        self.write_line(&bytes).await
    }

    /// MCP `initialize` handshake. Returns the server's reply verbatim so
    /// callers can inspect `serverInfo` / `capabilities` if they care.
    pub async fn initialize(
        &self,
        client_name: &str,
        client_version: &str,
    ) -> Result<Value, McpError> {
        let result = self
            .request(
                "initialize",
                Some(json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": client_name, "version": client_version },
                })),
            )
            .await?;
        // Per spec the client must send `notifications/initialized` after a
        // successful initialize. Servers that don't require it ignore it.
        let _ = self.notify("notifications/initialized", None).await;
        Ok(result)
    }

    pub async fn list_tools(&self) -> Result<Vec<McpTool>, McpError> {
        let v = self.request("tools/list", None).await?;
        let arr = v
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| {
                McpError::InvalidResponse("tools/list response missing `tools`".into())
            })?;
        let mut tools = Vec::with_capacity(arr.len());
        for item in arr {
            tools.push(serde_json::from_value::<McpTool>(item)?);
        }
        Ok(tools)
    }

    /// Invokes a tool. The MCP spec returns
    /// `{ content: [{ type: "text", text: "…" }, …], isError?: bool }`.
    /// We pass the raw object up — the agent runtime extracts text and
    /// flattens it for the LLM.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, McpError> {
        self.request(
            "tools/call",
            Some(json!({ "name": name, "arguments": arguments })),
        )
        .await
    }
}

/// Convenience: turn an MCP `tools/call` result into a flat string suitable
/// for an OpenAI-style `tool` message. Concatenates every `text` content
/// block; falls back to JSON for non-text content.
#[must_use]
pub fn flatten_tool_result(value: &Value) -> String {
    let Some(arr) = value.get("content").and_then(Value::as_array) else {
        return value.to_string();
    };
    let mut out = String::new();
    for block in arr {
        if let Some(t) = block.get("text").and_then(Value::as_str) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(t);
        } else {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&block.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{classify, flatten_tool_result, ToolCategory};
    use serde_json::json;

    #[test]
    fn classify_reads() {
        for n in [
            "pods_list",
            "pods_get",
            "namespaces_list",
            "events_list",
            "pods_log",
            "pods_top",
            "configuration_view",
            "resources_get",
        ] {
            assert_eq!(classify(n), ToolCategory::Read, "{n}");
        }
    }

    #[test]
    fn classify_writes() {
        for n in [
            "pods_create_or_update",
            "pods_delete",
            "pods_exec",
            "pods_run",
            "helm_install",
            "helm_uninstall",
            "deployments_scale",
            "nodes_drain",
            "deployments_restart",
            "resources_apply",
            "resources_patch",
        ] {
            assert_eq!(classify(n), ToolCategory::Write, "{n}");
        }
    }

    #[test]
    fn classify_unknown_when_ambiguous() {
        // No marker either way.
        assert_eq!(classify("ping"), ToolCategory::Unknown);
        assert_eq!(classify("frobnicate"), ToolCategory::Unknown);
    }

    #[test]
    fn flatten_text_blocks() {
        let v = json!({
            "content": [
                { "type": "text", "text": "first" },
                { "type": "text", "text": "second" }
            ]
        });
        assert_eq!(flatten_tool_result(&v), "first\nsecond");
    }

    #[test]
    fn flatten_falls_back_for_non_text() {
        let v = json!({ "content": [{ "type": "image", "data": "…" }] });
        let out = flatten_tool_result(&v);
        assert!(out.contains("image"), "{out}");
    }

    #[test]
    fn flatten_falls_back_when_no_content_array() {
        let v = json!({ "ok": true });
        assert_eq!(flatten_tool_result(&v), v.to_string());
    }
}
