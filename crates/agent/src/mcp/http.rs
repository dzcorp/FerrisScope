//! Streamable HTTP transport (MCP 2025-03-26).
//!
//! Every JSON-RPC message is POSTed to a single `url`. The response is either
//! an `application/json` body (one response, or a JSON-RPC batch array) or a
//! `text/event-stream` (SSE) carrying the response plus any interleaved
//! server messages. Notifications get a `202 Accepted` with no body.
//!
//! Session continuity uses the `Mcp-Session-Id` header: the server sets it on
//! the `initialize` response and we echo it on every later request. After
//! `initialize` we also send `MCP-Protocol-Version` (the negotiated version).
//!
//! Scope note: the optional standalone GET stream (for unsolicited
//! server→client messages) is intentionally not opened — the agent only makes
//! request/response tool calls, so the POST response stream is sufficient.

use std::collections::HashMap;
use std::sync::Arc;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::header::{HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use super::transport::{build_headers, Transport};
use super::McpError;

/// Lowercase header names — `HeaderName::from_static` requires lowercase.
const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

pub struct HttpTransport {
    client: reqwest::Client,
    url: String,
    base_headers: reqwest::header::HeaderMap,
    /// Set from the `initialize` response, echoed on every later request.
    session_id: Mutex<Option<String>>,
    /// Negotiated protocol version, captured from the `initialize` result.
    protocol_version: Mutex<Option<String>>,
    incoming: mpsc::UnboundedSender<Value>,
}

impl HttpTransport {
    pub fn connect(
        url: &str,
        headers: &HashMap<String, String>,
        incoming: mpsc::UnboundedSender<Value>,
    ) -> Result<Arc<Self>, McpError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| McpError::Transport(format!("build http client: {e}")))?;
        Ok(Arc::new(Self {
            client,
            url: url.to_string(),
            base_headers: build_headers(headers),
            session_id: Mutex::new(None),
            protocol_version: Mutex::new(None),
            incoming,
        }))
    }

    /// Capture the negotiated protocol version from an `initialize` result so
    /// later requests can advertise it. No-op for every other message.
    async fn capture_meta(&self, v: &Value) {
        if let Some(pv) = v
            .get("result")
            .and_then(|r| r.get("protocolVersion"))
            .and_then(Value::as_str)
        {
            *self.protocol_version.lock().await = Some(pv.to_string());
        }
    }

    async fn deliver(&self, v: Value) -> bool {
        self.capture_meta(&v).await;
        self.incoming.send(v).is_ok()
    }
}

#[async_trait::async_trait]
impl Transport for HttpTransport {
    async fn send(&self, message: Value) -> Result<(), McpError> {
        let mut headers = self.base_headers.clone();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        if let Some(sid) = self.session_id.lock().await.clone() {
            if let Ok(v) = HeaderValue::from_str(&sid) {
                headers.insert(HeaderName::from_static(SESSION_HEADER), v);
            }
        }
        if let Some(pv) = self.protocol_version.lock().await.clone() {
            if let Ok(v) = HeaderValue::from_str(&pv) {
                headers.insert(HeaderName::from_static(PROTOCOL_HEADER), v);
            }
        }

        let resp = self
            .client
            .post(&self.url)
            .headers(headers)
            .json(&message)
            .send()
            .await
            .map_err(|e| McpError::Transport(e.to_string()))?;

        let status = resp.status();
        // Capture the session id from any response (the server sets it on
        // initialize). Done before consuming the body below.
        if let Some(sid) = resp
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().await = Some(sid.to_string());
        }
        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(McpError::Transport(format!("{status}: {body}")));
        }

        if content_type.contains("text/event-stream") {
            let mut stream = resp.bytes_stream().eventsource();
            while let Some(ev) = stream.next().await {
                let ev = ev.map_err(|e| McpError::Transport(e.to_string()))?;
                if ev.data.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&ev.data) {
                    Ok(v) => {
                        if !self.deliver(v).await {
                            break;
                        }
                    }
                    Err(e) => tracing::warn!(error = %e, "mcp http: bad sse data"),
                }
            }
        } else if content_type.contains("application/json") {
            let body = resp
                .text()
                .await
                .map_err(|e| McpError::Transport(e.to_string()))?;
            if body.trim().is_empty() {
                return Ok(());
            }
            match serde_json::from_str::<Value>(&body)? {
                Value::Array(items) => {
                    for v in items {
                        if !self.deliver(v).await {
                            break;
                        }
                    }
                }
                other => {
                    self.deliver(other).await;
                }
            }
        }
        // else: 202 Accepted (notification) or empty body — nothing to deliver.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::McpClient;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // reqwest needs a process-global rustls crypto provider (the binary
    // installs `ring` in main.rs). Idempotent: only the first call succeeds.
    fn ensure_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    // Read one HTTP/1.1 request off the socket: headers, then Content-Length
    // bytes of body. Returns the body string (the JSON-RPC request).
    async fn read_http_body(stream: &mut tokio::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        // Read until headers terminator.
        let header_end = loop {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                return String::new();
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..header_end]).to_ascii_lowercase();
        let len: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        while buf.len() < header_end + len {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        String::from_utf8_lossy(&buf[header_end..header_end + len]).to_string()
    }

    fn request_id(body: &str) -> Value {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v.get("id").cloned())
            .unwrap_or(Value::Null)
    }

    // Spawn a one-request mock that replies with the given content-type body,
    // substituting {ID} with the request's JSON-RPC id.
    async fn spawn_mock(content_type: &'static str, body_template: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let body = read_http_body(&mut stream).await;
            let id = request_id(&body);
            let payload = body_template.replace("{ID}", &id.to_string());
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            stream.write_all(resp.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
            let _ = stream.shutdown().await;
        });
        format!("http://{addr}/rpc")
    }

    #[tokio::test]
    async fn json_response_resolves_request() {
        ensure_provider();
        let url = spawn_mock(
            "application/json",
            r#"{"jsonrpc":"2.0","id":{ID},"result":{"ok":true}}"#,
        )
        .await;
        let (tx, rx) = mpsc::unbounded_channel();
        let transport = HttpTransport::connect(&url, &HashMap::new(), tx).unwrap();
        let client = McpClient::from_transport(transport, rx);
        let out = client.call_tool("noop", json!({})).await.unwrap();
        assert_eq!(out, json!({ "ok": true }));
    }

    #[tokio::test]
    async fn sse_response_resolves_request() {
        ensure_provider();
        // The POST response is an SSE stream carrying the JSON-RPC reply.
        let url = spawn_mock(
            "text/event-stream",
            "data: {\"jsonrpc\":\"2.0\",\"id\":{ID},\"result\":{\"ok\":true}}\n\n",
        )
        .await;
        let (tx, rx) = mpsc::unbounded_channel();
        let transport = HttpTransport::connect(&url, &HashMap::new(), tx).unwrap();
        let client = McpClient::from_transport(transport, rx);
        let out = client.call_tool("noop", json!({})).await.unwrap();
        assert_eq!(out, json!({ "ok": true }));
    }

    #[tokio::test]
    async fn http_error_status_surfaces_as_transport_error() {
        ensure_provider();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_http_body(&mut stream).await;
            let resp = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 11\r\nConnection: close\r\n\r\nbad api key";
            stream.write_all(resp.as_bytes()).await.unwrap();
            let _ = stream.shutdown().await;
        });
        let url = format!("http://{addr}/rpc");
        let (tx, rx) = mpsc::unbounded_channel();
        let transport = HttpTransport::connect(&url, &HashMap::new(), tx).unwrap();
        let client = McpClient::from_transport(transport, rx);
        let err = client.call_tool("noop", json!({})).await.unwrap_err();
        match err {
            McpError::Transport(m) => assert!(m.contains("401"), "{m}"),
            other => panic!("expected Transport error, got {other:?}"),
        }
    }
}
