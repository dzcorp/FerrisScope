//! Legacy HTTP+SSE transport (MCP 2024-11-05).
//!
//! Two channels: a long-lived `GET <url>` Server-Sent Events stream for
//! server→client messages, and per-request `POST`s for client→server. On
//! connect the server's first SSE event is `endpoint`, whose data is the URL
//! to POST requests to (often relative — resolved against `url`). Every later
//! `message` event carries a JSON-RPC payload, which we forward to the client.
//!
//! Superseded by [`HttpTransport`](super::http::HttpTransport) (Streamable
//! HTTP) in newer servers, but still widely deployed, so we support both.

use std::collections::HashMap;
use std::sync::Arc;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

use super::transport::{build_headers, Transport};
use super::McpError;

pub struct SseTransport {
    client: reqwest::Client,
    base_headers: reqwest::header::HeaderMap,
    /// The POST endpoint advertised by the server's `endpoint` SSE event.
    /// `None` until that event arrives; `send` waits for it.
    endpoint: watch::Receiver<Option<String>>,
}

impl SseTransport {
    pub async fn connect(
        url: &str,
        headers: &HashMap<String, String>,
        incoming: mpsc::UnboundedSender<Value>,
    ) -> Result<Arc<Self>, McpError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| McpError::Transport(format!("build http client: {e}")))?;
        let base_headers = build_headers(headers);
        let base_url = reqwest::Url::parse(url)
            .map_err(|e| McpError::Transport(format!("invalid url: {e}")))?;

        let mut get_headers = base_headers.clone();
        get_headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        let resp = client
            .get(url)
            .headers(get_headers)
            .send()
            .await
            .map_err(|e| McpError::Transport(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(McpError::Transport(format!("{status}: {body}")));
        }

        let (ep_tx, ep_rx) = watch::channel::<Option<String>>(None);
        tokio::spawn(async move {
            let mut stream = resp.bytes_stream().eventsource();
            while let Some(ev) = stream.next().await {
                let ev = match ev {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!(error = %e, "mcp sse: stream error");
                        break;
                    }
                };
                if ev.event == "endpoint" {
                    let raw = ev.data.trim();
                    match base_url.join(raw) {
                        Ok(u) => {
                            let _ = ep_tx.send(Some(u.to_string()));
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, endpoint = %raw, "mcp sse: bad endpoint");
                        }
                    }
                } else {
                    // "message" (or any data-bearing event) → JSON-RPC payload.
                    if ev.data.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&ev.data) {
                        Ok(v) => {
                            if incoming.send(v).is_err() {
                                break;
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "mcp sse: bad data"),
                    }
                }
            }
            // Stream ended: dropping `incoming` + `ep_tx` here unblocks both
            // the client (pending requests fail) and any `send` awaiting the
            // endpoint (the watch sender closes).
        });

        Ok(Arc::new(Self {
            client,
            base_headers,
            endpoint: ep_rx,
        }))
    }
}

#[async_trait::async_trait]
impl Transport for SseTransport {
    async fn send(&self, message: Value) -> Result<(), McpError> {
        // The endpoint URL arrives asynchronously on the SSE stream; wait for
        // it (the watch sender closing means the stream died before sending
        // one — surface that rather than hang).
        let mut rx = self.endpoint.clone();
        let endpoint = match rx.wait_for(Option::is_some).await {
            Ok(r) => match r.as_ref().cloned() {
                Some(ep) => ep,
                None => return Err(McpError::Transport("sse endpoint missing".into())),
            },
            Err(_) => {
                return Err(McpError::Transport(
                    "sse endpoint never arrived (stream closed)".into(),
                ))
            }
        };

        let mut headers = self.base_headers.clone();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let resp = self
            .client
            .post(&endpoint)
            .headers(headers)
            .json(&message)
            .send()
            .await
            .map_err(|e| McpError::Transport(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(McpError::Transport(format!("{status}: {body}")));
        }
        // The JSON-RPC response (if any) comes back over the SSE stream, not
        // this POST's body.
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

    fn ensure_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    async fn read_http_body(stream: &mut tokio::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
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

    #[tokio::test]
    async fn endpoint_then_post_round_trips_over_sse() {
        ensure_provider();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // Connection 1: GET → SSE headers + endpoint event (relative).
            let (mut s1, _) = listener.accept().await.unwrap();
            let _ = read_http_body(&mut s1).await; // consume GET headers
            s1.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n",
            )
            .await
            .unwrap();
            s1.write_all(b"event: endpoint\r\ndata: /messages\r\n\r\n")
                .await
                .unwrap();
            s1.flush().await.unwrap();

            // Connection 2: POST /messages → 202; reply pushed over SSE.
            let (mut s2, _) = listener.accept().await.unwrap();
            let body = read_http_body(&mut s2).await;
            let id = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("id").cloned())
                .unwrap_or(Value::Null);
            s2.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
            s2.flush().await.unwrap();

            let event =
                format!("data: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"ok\":true}}}}\n\n");
            s1.write_all(event.as_bytes()).await.unwrap();
            s1.flush().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        });

        let url = format!("http://{addr}/sse");
        let (tx, rx) = mpsc::unbounded_channel();
        let transport = SseTransport::connect(&url, &HashMap::new(), tx)
            .await
            .unwrap();
        let client = McpClient::from_transport(transport, rx);
        let out = client.call_tool("noop", json!({})).await.unwrap();
        assert_eq!(out, json!({ "ok": true }));
    }
}
