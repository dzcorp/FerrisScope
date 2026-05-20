//! Transport abstraction for the MCP client.
//!
//! [`McpClient`](super::McpClient) is wire-agnostic: it serializes JSON-RPC
//! messages and hands them to a [`Transport`], and consumes incoming messages
//! from a channel the transport fills. Three transports ship:
//!
//! - [`StdioTransport`] — subprocess pipes (this file). The default.
//! - [`HttpTransport`](super::http::HttpTransport) — Streamable HTTP.
//! - [`SseTransport`](super::sse::SseTransport) — legacy HTTP+SSE.
//!
//! Every transport delivers incoming messages (responses + server
//! notifications) by `send`-ing serde_json [`Value`]s into the
//! `mpsc::UnboundedSender` it was constructed with. Closing that sender (drop)
//! signals the client that the connection is gone.

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use super::McpError;

/// Sends one already-serialized JSON-RPC message (request or notification) to
/// the server. Implementations are responsible for routing any resulting
/// incoming messages into the channel handed to them at construction.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    async fn send(&self, message: Value) -> Result<(), McpError>;
}

/// Build a reqwest [`HeaderMap`] from operator-supplied `name: value` pairs.
/// Invalid header names / values are dropped with a warning rather than
/// failing the whole connection — a single bad header shouldn't sink a server.
pub(crate) fn build_headers(headers: &HashMap<String, String>) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in headers {
        match (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            (Ok(name), Ok(value)) => {
                h.insert(name, value);
            }
            _ => tracing::warn!(header = %k, "mcp: dropping invalid HTTP header"),
        }
    }
    h
}

/// JSON-RPC over a subprocess's stdin (writer) + stdout (reader), one message
/// per line. The reader runs as a detached task that parses each line into a
/// [`Value`] and forwards it to the client; dropping the child's stdout (EOF)
/// ends the task and closes the channel.
pub struct StdioTransport {
    writer: Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
}

impl StdioTransport {
    pub fn new<W, R>(writer: W, reader: R, incoming: mpsc::UnboundedSender<Value>) -> Arc<Self>
    where
        W: AsyncWrite + Unpin + Send + 'static,
        R: AsyncRead + Unpin + Send + 'static,
    {
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
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(v) => {
                        // Receiver dropped (client gone) → stop reading.
                        if incoming.send(v).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, line = %trimmed, "mcp: bad json line");
                    }
                }
            }
            // Dropping `incoming` here closes the channel, which the client's
            // drain loop turns into `McpError::Closed` for pending requests.
        });
        Arc::new(Self {
            writer: Mutex::new(Box::new(writer)),
        })
    }
}

#[async_trait::async_trait]
impl Transport for StdioTransport {
    async fn send(&self, message: Value) -> Result<(), McpError> {
        let bytes = serde_json::to_vec(&message)?;
        let mut w = self.writer.lock().await;
        w.write_all(&bytes).await?;
        w.write_all(b"\n").await?;
        w.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::McpClient;
    use serde_json::json;
    use tokio::io::duplex;

    // A stdio transport over an in-memory duplex pipe: we play "server" on the
    // far end, reading the client's request line and writing a canned reply.
    #[tokio::test]
    async fn stdio_round_trips_a_request() {
        // client writes to `c_wr`, reads from `c_rd`; server uses the mirror.
        let (client_io, mut server_io) = duplex(8192);
        let (c_rd, c_wr) = tokio::io::split(client_io);
        let client = McpClient::new(c_wr, c_rd);

        // Server: read one line (the initialize request), reply with a result.
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let (rd, mut wr) = tokio::io::split(&mut server_io);
            let mut lines = BufReader::new(rd).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let req: serde_json::Value = serde_json::from_str(&line).unwrap();
            let id = req.get("id").cloned().unwrap();
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } });
            wr.write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .await
                .unwrap();
            wr.write_all(b"\n").await.unwrap();
            wr.flush().await.unwrap();
            // Keep server_io alive until the client has read the reply.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        });

        let result = client.call_tool("noop", json!({})).await.unwrap();
        assert_eq!(result, json!({ "ok": true }));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn closed_transport_fails_pending_requests() {
        let (client_io, mut server_io) = duplex(8192);
        let (c_rd, c_wr) = tokio::io::split(client_io);
        let client = McpClient::new(c_wr, c_rd);
        // Server reads the request (so the write succeeds), then drops its end
        // without replying → client reader hits EOF → the drain loop fails the
        // outstanding request with `Closed` rather than letting it hang.
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let (rd, _wr) = tokio::io::split(&mut server_io);
            let mut lines = BufReader::new(rd).lines();
            let _ = lines.next_line().await;
            // drop server_io on return
        });
        let err = client.call_tool("noop", json!({})).await.unwrap_err();
        assert!(matches!(err, McpError::Closed), "{err:?}");
        server.await.unwrap();
    }
}
