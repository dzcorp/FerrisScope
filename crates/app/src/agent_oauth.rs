//! OAuth login plumbing — currently only OpenAI Codex (ChatGPT
//! subscription). The flow:
//!
//! 1. We pick a fixed loopback port (1455 — same as the official Codex
//!    CLI, so the OAuth client allow-list works) and bind a one-shot
//!    HTTP listener.
//! 2. We generate PKCE + state, build the authorize URL, and open the
//!    operator's default browser.
//! 3. The browser hits `http://localhost:1455/auth/callback?code=…&state=…`.
//!    We respond with a tiny "you can close this tab" HTML page.
//! 4. We exchange the code for tokens and return a `Credential::OAuth`
//!    blob to the caller, who writes it to the keychain.
//!
//! No external HTTP-server crate — `tokio::net::TcpListener` plus a
//! hand-rolled GET parser is enough for the dozen-or-so requests this
//! flow handles in its lifetime.

use base64::Engine as _;
use ferrisscope_agent::{Credential, ProviderKind};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

const OPENAI_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER: &str = "https://auth.openai.com";
const OPENAI_PORT: u16 = 1455;
const OPENAI_REDIRECT: &str = "http://localhost:1455/auth/callback";

const SUCCESS_HTML: &str = "<!doctype html><html><head><title>FerrisScope</title>\
<style>body{font-family:system-ui;text-align:center;margin-top:20vh;\
background:#0d0d11;color:#e7e6e1}h1{color:#e7e6e1}p{color:#9aa0a6}</style></head>\
<body><h1>Authorization successful</h1>\
<p>You can close this tab and return to FerrisScope.</p>\
<script>setTimeout(()=>window.close(),2000)</script></body></html>";

const ERROR_HTML: &str = "<!doctype html><html><head><title>FerrisScope</title>\
<style>body{font-family:system-ui;text-align:center;margin-top:20vh;\
background:#0d0d11;color:#e7e6e1}h1{color:#fc533a}p{color:#ff917b;\
font-family:monospace;background:#3c140d;padding:1rem;border-radius:.5rem;\
display:inline-block}</style></head><body>\
<h1>Authorization failed</h1><p>{ERR}</p></body></html>";

#[derive(Debug)]
pub(crate) enum OauthError {
    Unsupported,
    InProgress,
    Io(io::Error),
    TokenExchange(String),
    Callback(String),
    Cancelled,
    TimedOut,
}

impl std::fmt::Display for OauthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => write!(f, "provider does not support OAuth"),
            Self::InProgress => write!(f, "oauth flow already in progress"),
            Self::Io(e) => write!(f, "io: {e}"),
            Self::TokenExchange(s) => write!(f, "token exchange failed: {s}"),
            Self::Callback(s) => write!(f, "invalid callback: {s}"),
            Self::Cancelled => write!(f, "flow cancelled"),
            Self::TimedOut => write!(f, "flow timed out"),
        }
    }
}

impl std::error::Error for OauthError {}

impl From<io::Error> for OauthError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// In-flight OAuth state. We keep it in a process-wide `OnceLock<Mutex>`
/// so a second `ai_oauth_login` invocation while one is running gets a
/// clean error rather than racing.
struct InFlight {
    cancel: oneshot::Sender<()>,
    /// Resolved only when the listener task itself exits.
    done: oneshot::Receiver<Result<Credential, OauthError>>,
}

fn slot() -> &'static Mutex<Option<InFlight>> {
    static SLOT: OnceLock<Mutex<Option<InFlight>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Run the OAuth flow for `provider` to completion, returning the new
/// credential. Currently only `ProviderKind::OpenAI` is supported.
pub(crate) async fn login(
    app: AppHandle,
    provider: ProviderKind,
) -> Result<Credential, OauthError> {
    if provider != ProviderKind::OpenAI {
        return Err(OauthError::Unsupported);
    }
    // Reserve the slot. If a flow is already in progress, refuse —
    // racing browser tabs cause one of them to get the wrong tokens.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = oneshot::channel::<Result<Credential, OauthError>>();
    {
        let mut g = slot().lock().await;
        if g.is_some() {
            return Err(OauthError::InProgress);
        }
        *g = Some(InFlight {
            cancel: cancel_tx,
            done: done_rx,
        });
    }

    // Spawn the listener + browser-open task, then await its outcome.
    tokio::spawn(async move {
        let result = run_openai_flow(app, cancel_rx).await;
        let _ = done_tx.send(result);
    });

    // Wait for completion or a 5-minute hard timeout. `done_rx` is moved
    // out of the slot so we own it for the await.
    let mut owned_done = {
        let mut g = slot().lock().await;
        g.as_mut()
            .map(|f| std::mem::replace(&mut f.done, oneshot::channel().1))
            .ok_or(OauthError::Cancelled)?
    };

    let outcome = tokio::select! {
        result = &mut owned_done => match result {
            Ok(r) => r,
            Err(_) => Err(OauthError::Cancelled),
        },
        () = tokio::time::sleep(Duration::from_secs(5 * 60)) => Err(OauthError::TimedOut),
    };

    // Clean up the slot regardless of outcome.
    let _ = slot().lock().await.take();
    outcome
}

/// Cancel the in-flight flow, if any. Idempotent.
pub(crate) async fn cancel() {
    let taken = slot().lock().await.take();
    if let Some(flight) = taken {
        let _ = flight.cancel.send(());
    }
}

async fn run_openai_flow(
    app: AppHandle,
    cancel: oneshot::Receiver<()>,
) -> Result<Credential, OauthError> {
    let listener = TcpListener::bind(("127.0.0.1", OPENAI_PORT)).await?;
    let (verifier, challenge) = generate_pkce();
    let state = generate_state();

    let auth_url = format!(
        "{ISSUER}/oauth/authorize?\
         response_type=code&\
         client_id={CID}&\
         redirect_uri={REDIRECT}&\
         scope=openid%20profile%20email%20offline_access&\
         code_challenge={CHALLENGE}&\
         code_challenge_method=S256&\
         id_token_add_organizations=true&\
         codex_cli_simplified_flow=true&\
         state={STATE}&\
         originator=ferrisscope",
        ISSUER = OPENAI_ISSUER,
        CID = OPENAI_CLIENT_ID,
        REDIRECT = urlencode(OPENAI_REDIRECT),
        CHALLENGE = challenge,
        STATE = state,
    );

    // Best-effort browser open via tauri-plugin-opener. Some headless
    // setups fail here; we surface the URL via tracing so the operator
    // can paste it manually.
    if let Err(e) = app.opener().open_url(&auth_url, None::<&str>) {
        tracing::warn!(error = %e, url = %auth_url, "could not open browser; open the URL manually");
    }

    // Loop accepting connections until the callback lands or cancel
    // fires. Browsers hit the listener with `/auth/callback?…` and
    // various favicon / preflight requests we 404.
    let cancel = Arc::new(Mutex::new(Some(cancel)));
    let maybe_code: Option<String>;
    loop {
        let mut cancel_g = cancel.lock().await;
        let cancel_owned = cancel_g.take();
        drop(cancel_g);
        let cancel_fut = async {
            if let Some(rx) = cancel_owned {
                let _ = rx.await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        let accepted = tokio::select! {
            res = listener.accept() => res?,
            () = cancel_fut => {
                return Err(OauthError::Cancelled);
            }
        };
        let (mut socket, _peer) = accepted;
        let mut buf = vec![0u8; 8192];
        let n = match socket.read(&mut buf).await {
            Ok(n) => n,
            Err(_) => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]).to_string();
        let path = parse_request_path(&request).unwrap_or_default();

        if path.starts_with("/auth/callback") {
            let (code_opt, state_opt, error_opt) = parse_callback_params(&path);

            if let Some(err) = error_opt {
                let body = ERROR_HTML.replace("{ERR}", &html_escape(&err));
                let _ = write_response(&mut socket, 400, "text/html", &body).await;
                return Err(OauthError::Callback(err));
            }
            let Some(code) = code_opt else {
                let body = ERROR_HTML.replace("{ERR}", "missing authorization code");
                let _ = write_response(&mut socket, 400, "text/html", &body).await;
                return Err(OauthError::Callback("missing code".into()));
            };
            if state_opt.as_deref() != Some(state.as_str()) {
                let body = ERROR_HTML.replace("{ERR}", "state mismatch");
                let _ = write_response(&mut socket, 400, "text/html", &body).await;
                return Err(OauthError::Callback(
                    "state mismatch (CSRF check failed)".into(),
                ));
            }
            let _ = write_response(&mut socket, 200, "text/html", SUCCESS_HTML).await;
            maybe_code = Some(code);
            break;
        }
        // 404 anything else (favicon probes, browser preflights).
        let _ = write_response(&mut socket, 404, "text/plain", "not found").await;
    }

    let Some(code) = maybe_code else {
        return Err(OauthError::Cancelled);
    };

    exchange_code(&code, &verifier).await
}

async fn exchange_code(code: &str, verifier: &str) -> Result<Credential, OauthError> {
    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        refresh_token: String,
        #[serde(default)]
        id_token: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
    }

    let body = format!(
        "grant_type=authorization_code&code={C}&redirect_uri={R}&client_id={CID}&code_verifier={V}",
        C = urlencode(code),
        R = urlencode(OPENAI_REDIRECT),
        CID = OPENAI_CLIENT_ID,
        V = urlencode(verifier),
    );
    let resp = reqwest::Client::new()
        .post(format!("{OPENAI_ISSUER}/oauth/token"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| OauthError::TokenExchange(e.to_string()))?;
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(OauthError::TokenExchange(text));
    }
    let tokens: TokenResp = resp
        .json()
        .await
        .map_err(|e| OauthError::TokenExchange(e.to_string()))?;
    let account_id = tokens
        .id_token
        .as_deref()
        .and_then(extract_account_id)
        .or_else(|| extract_account_id(&tokens.access_token));
    Ok(Credential::OAuth {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires_at_unix_ms: chrono::Utc::now().timestamp_millis()
            + i64::from(u32::try_from(tokens.expires_in.unwrap_or(3600)).unwrap_or(3600)) * 1000,
        account_id,
    })
}

// ─── PKCE / encoding helpers ────────────────────────────────────────────────

fn generate_pkce() -> (String, String) {
    let charset: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut bytes = [0u8; 64];
    fill_random(&mut bytes);
    let verifier: String = bytes
        .iter()
        .map(|b| char::from(charset[(*b as usize) % charset.len()]))
        .collect();
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    let challenge = base64_url(&digest);
    (verifier, challenge)
}

fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes);
    base64_url(&bytes)
}

fn fill_random(buf: &mut [u8]) {
    // `getrandom` reads from the OS entropy source (`getrandom(2)` on
    // Linux, `SecRandomCopyBytes` on macOS, `BCryptGenRandom` on
    // Windows). Cryptographically suitable for PKCE / state.
    if getrandom::getrandom(buf).is_err() {
        // Fallback so PKCE generation never panics. Two UUIDs give 256
        // bits which exceeds OAuth's PKCE requirement; degrades to
        // process-time entropy if the syscall fails (extremely rare,
        // typically only on misconfigured sandboxes).
        let mut i = 0;
        while i < buf.len() {
            let bytes = uuid::Uuid::new_v4().into_bytes();
            let take = (buf.len() - i).min(16);
            buf[i..i + take].copy_from_slice(&bytes[..take]);
            i += take;
        }
    }
}

fn base64_url(input: &[u8]) -> String {
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine.encode(input)
}

fn urlencode(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        if matches!(*byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(*byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn parse_request_path(req: &str) -> Option<String> {
    let line = req.lines().next()?;
    let mut parts = line.split_whitespace();
    let _method = parts.next()?;
    let target = parts.next()?;
    Some(target.to_string())
}

fn parse_callback_params(path: &str) -> (Option<String>, Option<String>, Option<String>) {
    let qs = match path.split_once('?') {
        Some((_, q)) => q,
        None => return (None, None, None),
    };
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for kv in qs.split('&') {
        let Some((k, v)) = kv.split_once('=') else {
            continue;
        };
        let v = urldecode(v);
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => error = Some(v),
            "error_description" => {
                if error.is_some() {
                    error = Some(v);
                }
            }
            _ => {}
        }
    }
    (code, state, error)
}

fn urldecode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                let v = u8::from_str_radix(hex, 16).unwrap_or(b' ');
                out.push(char::from(v));
                i += 3;
            }
            other => {
                out.push(char::from(other));
                i += 1;
            }
        }
    }
    out
}

async fn write_response<W: AsyncWriteExt + Unpin>(
    socket: &mut W,
    status: u16,
    content_type: &str,
    body: &str,
) -> io::Result<()> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let payload = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\r\n\
         {body}",
        len = body.len(),
    );
    socket.write_all(payload.as_bytes()).await?;
    socket.shutdown().await?;
    Ok(())
}

/// Extract the ChatGPT account / org id from a JWT (id_token or access
/// token). Mirrors opencode's logic — looks at `chatgpt_account_id`
/// directly, then the namespaced `https://api.openai.com/auth` claim,
/// then the first `organizations[].id`.
fn extract_account_id(jwt: &str) -> Option<String> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload_b64 = parts[1];
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let bytes = engine
        .decode(payload_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload_b64))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if let Some(s) = claims.get("chatgpt_account_id").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = claims
        .pointer("/https://api.openai.com/auth/chatgpt_account_id")
        .and_then(|x| x.as_str())
    {
        return Some(s.to_string());
    }
    if let Some(arr) = claims.get("organizations").and_then(|x| x.as_array()) {
        if let Some(first) = arr
            .first()
            .and_then(|v| v.get("id"))
            .and_then(|x| x.as_str())
        {
            return Some(first.to_string());
        }
    }
    None
}
