//! Test-only helpers shared by provider tests: a tiny scripted HTTP server
//! that records what it was asked, so request shape (path, headers, body) is
//! asserted against a real socket without any network.

use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Debug)]
pub(crate) struct Captured {
    pub(crate) head: String,
    pub(crate) body: String,
}

/// [`serve_at`] under Gemini's `/v1beta` base path.
pub(crate) async fn serve(responses: Vec<String>) -> (String, Arc<Mutex<Vec<Captured>>>) {
    serve_at("/v1beta", responses).await
}

/// Serve each canned HTTP response to one connection, in order, recording what
/// was asked. Returns `http://127.0.0.1:<port><prefix>` and the request log.
pub(crate) async fn serve_at(
    prefix: &str,
    responses: Vec<String>,
) -> (String, Arc<Mutex<Vec<Captured>>>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let log = Arc::new(Mutex::new(Vec::new()));
    let task_log = log.clone();
    tokio::spawn(async move {
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break buf.len();
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break p + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
            let len: usize = head
                .to_ascii_lowercase()
                .lines()
                .find_map(|l| {
                    l.strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);
            while buf.len() < header_end + len {
                let n = stream.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            let body = String::from_utf8_lossy(&buf[header_end..]).to_string();
            task_log.lock().unwrap().push(Captured { head, body });
            stream.write_all(response.as_bytes()).await.unwrap();
            let _ = stream.shutdown().await;
        }
    });
    (format!("http://{addr}{prefix}"), log)
}

pub(crate) fn json_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

pub(crate) fn sse_response(chunks: &[Value]) -> String {
    use std::fmt::Write as _;
    let mut body = String::new();
    for c in chunks {
        write!(body, "data: {c}\r\n\r\n").unwrap();
    }
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}")
}
