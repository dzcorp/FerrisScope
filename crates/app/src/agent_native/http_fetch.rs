//! `fs_http_fetch` — HTTP probe + readability extractor.
//!
//! Two roles in one tool:
//!
//! 1. **Probe**: hit `http://localhost:<port>` against a port-forward opened
//!    by `fs_port_forward_open`, query an internal service, etc. Set
//!    `mode: "raw"` to get the response body verbatim — useful for JSON APIs
//!    and small text payloads.
//!
//! 2. **Browse**: pull a public docs page or vendor blog. Default mode is
//!    `"reader"`, which parses HTML and returns `{ title, description,
//!    headings, text, links: [{href, text}] }` so the agent gets clean,
//!    follow-up-ready content instead of pages of `<div class="…">` noise.
//!    `text` is whitespace-collapsed, `links` is absolutised against the
//!    final URL so the agent can fetch them directly.
//!
//! Classified **Write** because outbound HTTP is exactly the kind of
//! arbitrary capability that warrants per-call approval (POST/PUT/DELETE
//! can mutate cluster-internal state via a port-forward; even GET can
//! probe internal endpoints).

use std::time::Duration;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use scraper::{Html, Selector};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const MAX_TIMEOUT_SECS: u64 = 60;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;

/// Caps for reader-mode extraction. The raw HTML may be much larger; we
/// strip it down to a budget that keeps the LLM transcript tractable.
const READER_MAX_TEXT_CHARS: usize = 24_000;
const READER_MAX_LINKS: usize = 200;
const READER_MAX_HEADINGS: usize = 200;

/// Default User-Agent. Many docs / blog hosts (Cloudflare, Akamai, vendor
/// sites) ship minimal or interstitial responses to non-browser UAs. We send
/// a recent stable Chrome string so the agent gets the same page a human
/// reader would. The operator can override per-call via `headers`.
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Companion `Accept` so servers don't fall back to JSON or plaintext on a
/// content-negotiated endpoint. Mirrors what stable Chrome sends today.
const DEFAULT_ACCEPT: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/// `Accept-Language` — pick something neutral. Operators with locale-specific
/// expectations override per-call.
const DEFAULT_ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    /// Raw response body verbatim (capped to MAX_RESPONSE_BYTES).
    #[default]
    Raw,
    /// HTML stripped to plain text — no structure, no links.
    Text,
    /// Readability-style: title, description, headings, text, links[].
    Reader,
}

#[derive(Debug, Deserialize)]
struct Args {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    follow_redirects: bool,
    /// Only return status + headers; skip the body. Useful for cheap probes.
    #[serde(default)]
    head_only: bool,
    /// `raw` (default) returns the body verbatim; `text` strips HTML to plain
    /// text; `reader` returns a structured `{ title, headings, text, links }`
    /// extraction with relative URLs absolutised.
    #[serde(default)]
    mode: Mode,
}

fn default_method() -> String {
    "GET".to_string()
}

pub(crate) struct HttpFetch;

impl HttpFetch {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[async_trait]
impl NativeTool for HttpFetch {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_http_fetch".to_string(),
            description: format!(
                "Fetch an HTTP URL from the operator's machine. Two roles:\n\n\
                1. **Probe** an internal endpoint — typically `http://localhost:<port>` from a \
                port-forward you opened with `fs_port_forward_open`. Use `mode: \"raw\"` for \
                JSON APIs or small text payloads.\n\n\
                2. **Browse** a docs/vendor page. Use `mode: \"reader\"` — the tool parses HTML \
                and returns `{{ title, description, headings, text, links: [{{href, text}}] }}` \
                with relative URLs absolutised to the final URL, so you can follow links \
                directly without re-resolving them. Pages of HTML noise become a small, \
                structured payload.\n\n\
                Caps: timeout ≤ {MAX_TIMEOUT_SECS}s (default {DEFAULT_TIMEOUT_SECS}s), request \
                body ≤ {req_kb} KiB, response body ≤ {resp_kb} KiB (truncated past). Reader \
                mode further caps text at {text_kc}k chars, {max_links} links, {max_h} headings. \
                Redirects off by default — set `follow_redirects: true` for normal browsing.",
                req_kb = MAX_REQUEST_BODY_BYTES / 1024,
                resp_kb = MAX_RESPONSE_BYTES / 1024,
                text_kc = READER_MAX_TEXT_CHARS / 1000,
                max_links = READER_MAX_LINKS,
                max_h = READER_MAX_HEADINGS,
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Full URL including scheme." },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                        "default": "GET"
                    },
                    "headers": {
                        "type": "object",
                        "description": "Header map; values are stringified.",
                        "additionalProperties": { "type": "string" }
                    },
                    "body": { "type": "string" },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": MAX_TIMEOUT_SECS },
                    "follow_redirects": { "type": "boolean", "default": false },
                    "head_only": { "type": "boolean", "default": false },
                    "mode": {
                        "type": "string",
                        "enum": ["raw", "text", "reader"],
                        "default": "raw",
                        "description": "raw = body verbatim; text = strip HTML; reader = structured {title, headings, text, links}."
                    }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;

        if let Some(b) = a.body.as_ref() {
            if b.len() > MAX_REQUEST_BODY_BYTES {
                return Err(NativeToolError::msg(format!(
                    "request body exceeds {MAX_REQUEST_BODY_BYTES} bytes"
                )));
            }
        }

        let timeout = Duration::from_secs(
            a.timeout_seconds
                .unwrap_or(DEFAULT_TIMEOUT_SECS)
                .clamp(1, MAX_TIMEOUT_SECS),
        );
        let redirect = if a.follow_redirects {
            reqwest::redirect::Policy::limited(5)
        } else {
            reqwest::redirect::Policy::none()
        };
        // User-Agent goes on the client builder so reqwest doesn't add its
        // own default. Per-call `headers` may still override it (we only
        // insert the defaults when the caller didn't supply that header).
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(redirect)
            .user_agent(DEFAULT_USER_AGENT)
            .build()
            .map_err(|e| NativeToolError::msg(format!("client build failed: {e}")))?;

        let method = reqwest::Method::from_bytes(a.method.to_uppercase().as_bytes())
            .map_err(|e| NativeToolError::msg(format!("invalid method: {e}")))?;
        let mut req = client.request(method.clone(), &a.url);

        let mut header_map = HeaderMap::new();
        if let Some(h) = a.headers {
            for (k, v) in h {
                let name: HeaderName = k
                    .parse()
                    .map_err(|e| NativeToolError::msg(format!("bad header name `{k}`: {e}")))?;
                let value_str = v
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string());
                let value: HeaderValue = value_str
                    .parse()
                    .map_err(|e| NativeToolError::msg(format!("bad header value `{k}`: {e}")))?;
                header_map.insert(name, value);
            }
        }
        // Fill in browser-shaped defaults the caller didn't override. These
        // are what stable Chrome sends; many sites gate or simplify content
        // for non-browser UAs.
        if !header_map.contains_key(reqwest::header::ACCEPT) {
            header_map.insert(
                reqwest::header::ACCEPT,
                HeaderValue::from_static(DEFAULT_ACCEPT),
            );
        }
        if !header_map.contains_key(reqwest::header::ACCEPT_LANGUAGE) {
            header_map.insert(
                reqwest::header::ACCEPT_LANGUAGE,
                HeaderValue::from_static(DEFAULT_ACCEPT_LANGUAGE),
            );
        }
        req = req.headers(header_map);
        if let Some(body) = a.body {
            req = req.body(body);
        }

        let started = std::time::Instant::now();
        let resp = req
            .send()
            .await
            .map_err(|e| NativeToolError::msg(format!("request failed: {e}")))?;
        let status = resp.status();
        let final_url = resp.url().to_string();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .unwrap_or_default();
        let headers_out: serde_json::Map<String, Value> = resp
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_owned(),
                    Value::String(v.to_str().unwrap_or("<binary>").to_owned()),
                )
            })
            .collect();

        if a.head_only || method == reqwest::Method::HEAD {
            return Ok(json!({
                "url": a.url,
                "final_url": final_url,
                "status": status.as_u16(),
                "status_text": status.canonical_reason(),
                "headers": headers_out,
                "content_type": content_type,
                "body": Value::Null,
                "mode": "head",
                "elapsed_ms": started.elapsed().as_millis() as u64,
            }));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| NativeToolError::msg(format!("read body failed: {e}")))?;
        let (slice, transport_truncated) = if bytes.len() > MAX_RESPONSE_BYTES {
            (&bytes[..MAX_RESPONSE_BYTES], true)
        } else {
            (&bytes[..], false)
        };
        let text = match std::str::from_utf8(slice) {
            Ok(s) => s,
            Err(_) => {
                return Ok(json!({
                    "url": a.url,
                    "final_url": final_url,
                    "status": status.as_u16(),
                    "status_text": status.canonical_reason(),
                    "headers": headers_out,
                    "content_type": content_type,
                    "body": Value::Null,
                    "binary_bytes": slice.len(),
                    "truncated": transport_truncated,
                    "mode": "binary",
                    "elapsed_ms": started.elapsed().as_millis() as u64,
                }))
            }
        };

        let (body_value, mode_label, content_truncated) = match a.mode {
            Mode::Raw => (Value::String(text.to_owned()), "raw", transport_truncated),
            Mode::Text => {
                let (out, was_capped) = html_to_text(text, READER_MAX_TEXT_CHARS);
                (
                    Value::String(out),
                    "text",
                    transport_truncated || was_capped,
                )
            }
            Mode::Reader => {
                let extracted = extract_reader(text, &final_url);
                (
                    extracted.value,
                    "reader",
                    transport_truncated || extracted.truncated,
                )
            }
        };

        Ok(json!({
            "url": a.url,
            "final_url": final_url,
            "status": status.as_u16(),
            "status_text": status.canonical_reason(),
            "headers": headers_out,
            "content_type": content_type,
            "mode": mode_label,
            "body": body_value,
            "truncated": content_truncated,
            "elapsed_ms": started.elapsed().as_millis() as u64,
        }))
    }
}

/// Strip HTML to plain text. Drops `<script>`/`<style>` content entirely,
/// collapses whitespace, separates block elements with newlines. Caps the
/// output at `max_chars` characters; returns `(text, truncated)`.
fn html_to_text(html: &str, max_chars: usize) -> (String, bool) {
    let doc = Html::parse_document(html);
    let body_sel = Selector::parse("body").unwrap();
    let root: scraper::ElementRef = doc.select(&body_sel).next().unwrap_or_else(|| {
        // No <body> — walk from the root element.
        doc.root_element()
    });
    let mut buf = String::new();
    walk_text(root, &mut buf);
    let collapsed = collapse_whitespace(&buf);
    if collapsed.chars().count() > max_chars {
        let truncated: String = collapsed.chars().take(max_chars).collect();
        (truncated, true)
    } else {
        (collapsed, false)
    }
}

/// Recursively pull visible text out of an element. Ignores `<script>`,
/// `<style>`, `<noscript>` and `<template>` subtrees. Inserts a newline
/// between block-level elements so the collapsed output doesn't smash
/// paragraphs together.
fn walk_text(el: scraper::ElementRef, out: &mut String) {
    use scraper::node::Node;
    let tag = el.value().name();
    if matches!(tag, "script" | "style" | "noscript" | "template" | "svg") {
        return;
    }
    let is_block = matches!(
        tag,
        "p" | "div"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "main"
            | "nav"
            | "aside"
            | "li"
            | "tr"
            | "br"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "pre"
            | "blockquote"
            | "hr"
    );
    for child in el.children() {
        match child.value() {
            Node::Text(t) => out.push_str(&t.text),
            Node::Element(_) => {
                if let Some(child_el) = scraper::ElementRef::wrap(child) {
                    walk_text(child_el, out);
                }
            }
            _ => {}
        }
    }
    if is_block {
        out.push('\n');
    }
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = true;
    for ch in s.chars() {
        if ch == '\n' {
            // Preserve paragraph breaks. Strip trailing spaces before the newline.
            while out.ends_with(' ') {
                out.pop();
            }
            // Avoid runs of more than two newlines.
            if out.ends_with("\n\n") {
                continue;
            }
            out.push('\n');
            last_was_space = true;
        } else if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    out.trim().to_owned()
}

struct ReaderResult {
    value: Value,
    truncated: bool,
}

fn extract_reader(html: &str, final_url: &str) -> ReaderResult {
    let doc = Html::parse_document(html);
    let base_url = url::Url::parse(final_url).ok();

    // Title — prefer <title>, fall back to first <h1>.
    let title_sel = Selector::parse("title").unwrap();
    let title = doc
        .select(&title_sel)
        .next()
        .map(|n| collapse_whitespace(&n.text().collect::<String>()))
        .filter(|s| !s.is_empty());

    // Meta description / og:description.
    let meta_sel = Selector::parse("meta").unwrap();
    let mut description: Option<String> = None;
    for el in doc.select(&meta_sel) {
        let attrs = el.value();
        let name = attrs
            .attr("name")
            .or_else(|| attrs.attr("property"))
            .unwrap_or("");
        if matches!(name, "description" | "og:description") {
            if let Some(content) = attrs.attr("content") {
                let s = collapse_whitespace(content);
                if !s.is_empty() {
                    description = Some(s);
                    break;
                }
            }
        }
    }

    // Headings.
    let headings_sel = Selector::parse("h1, h2, h3, h4, h5, h6").unwrap();
    let mut headings: Vec<Value> = Vec::new();
    for h in doc.select(&headings_sel) {
        if headings.len() >= READER_MAX_HEADINGS {
            break;
        }
        let level = h.value().name().chars().last().and_then(|c| c.to_digit(10));
        let text = collapse_whitespace(&h.text().collect::<String>());
        if text.is_empty() {
            continue;
        }
        headings.push(json!({ "level": level, "text": text }));
    }

    // Visible text — strip the same body we would for `mode=text`.
    let (text, text_truncated) = html_to_text(html, READER_MAX_TEXT_CHARS);

    // Links — anchors with href, absolutised against the final URL when
    // possible. Skips javascript:/mailto:/tel:/empty/in-page-anchor links.
    let a_sel = Selector::parse("a[href]").unwrap();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut links: Vec<Value> = Vec::new();
    for a in doc.select(&a_sel) {
        if links.len() >= READER_MAX_LINKS {
            break;
        }
        let href = match a.value().attr("href") {
            Some(h) => h.trim(),
            None => continue,
        };
        if href.is_empty() || href.starts_with('#') {
            continue;
        }
        let lower = href.to_ascii_lowercase();
        if lower.starts_with("javascript:")
            || lower.starts_with("mailto:")
            || lower.starts_with("tel:")
        {
            continue;
        }
        let resolved = match base_url.as_ref() {
            Some(base) => base
                .join(href)
                .map(|u| u.to_string())
                .unwrap_or_else(|_| href.to_owned()),
            None => href.to_owned(),
        };
        if !seen.insert(resolved.clone()) {
            continue;
        }
        let text = collapse_whitespace(&a.text().collect::<String>());
        links.push(json!({ "href": resolved, "text": text }));
    }

    ReaderResult {
        value: json!({
            "title": title,
            "description": description,
            "headings": headings,
            "text": text,
            "links": links,
        }),
        truncated: text_truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collapse_whitespace, extract_reader, html_to_text, HttpFetch, READER_MAX_TEXT_CHARS,
    };
    use ferrisscope_agent::native::NativeTool;
    use ferrisscope_agent::ToolCategory;

    #[test]
    fn schema_advertises_fs_prefix_and_required_url() {
        let tool = HttpFetch::new();
        let schema = tool.schema();
        assert_eq!(schema.name, "fs_http_fetch");
        let required = schema.parameters["required"]
            .as_array()
            .expect("required is an array")
            .clone();
        assert!(required.iter().any(|v| v == "url"));
        // Mode enum carries the three documented variants.
        let modes = schema.parameters["properties"]["mode"]["enum"]
            .as_array()
            .expect("mode enum array")
            .clone();
        let mode_strs: Vec<&str> = modes.iter().filter_map(|v| v.as_str()).collect();
        assert!(mode_strs.contains(&"raw"));
        assert!(mode_strs.contains(&"text"));
        assert!(mode_strs.contains(&"reader"));
    }

    #[test]
    fn category_is_write() {
        // Outbound HTTP can mutate state via port-forwarded admin endpoints —
        // the approval gate must defer it.
        assert_eq!(HttpFetch::new().category(), ToolCategory::Write);
    }

    #[test]
    fn collapse_whitespace_normalises_runs() {
        assert_eq!(collapse_whitespace("hello   world"), "hello world");
        assert_eq!(collapse_whitespace("\thello\nworld\n"), "hello\nworld");
        // No more than two consecutive newlines.
        assert_eq!(collapse_whitespace("a\n\n\n\nb"), "a\n\nb");
        // Trailing spaces before newline are stripped.
        assert_eq!(collapse_whitespace("foo   \nbar"), "foo\nbar");
        // Leading + trailing whitespace fully trimmed.
        assert_eq!(collapse_whitespace("  hello  "), "hello");
    }

    #[test]
    fn html_to_text_drops_script_and_style() {
        let (text, capped) = html_to_text(
            "<html><head><style>p{color:red}</style><script>alert(1)</script></head>\
             <body><p>visible</p><p>text</p></body></html>",
            READER_MAX_TEXT_CHARS,
        );
        assert!(text.contains("visible"));
        assert!(text.contains("text"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
        assert!(!capped);
    }

    #[test]
    fn html_to_text_caps_at_max_chars() {
        // Build a body with > max chars of plain text.
        let raw = "x".repeat(200);
        let html = format!("<html><body>{raw}</body></html>");
        let (text, capped) = html_to_text(&html, 100);
        assert!(capped);
        assert_eq!(text.chars().count(), 100);
    }

    #[test]
    fn extract_reader_pulls_title_description_links() {
        let html = r##"<html><head>
            <title>The Page</title>
            <meta name="description" content="A description.">
            </head><body>
            <h1>Top heading</h1>
            <h2>Sub heading</h2>
            <p>Body paragraph.</p>
            <a href="/docs/intro">Intro</a>
            <a href="https://elsewhere.example/blog">Elsewhere</a>
            <a href="javascript:void(0)">js</a>
            <a href="#section">in-page</a>
            </body></html>"##;
        let r = extract_reader(html, "https://example.com/page");
        assert_eq!(r.value["title"], "The Page");
        assert_eq!(r.value["description"], "A description.");
        let headings = r.value["headings"].as_array().unwrap();
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0]["level"], 1);
        assert_eq!(headings[0]["text"], "Top heading");
        let links = r.value["links"].as_array().unwrap();
        let hrefs: Vec<&str> = links.iter().filter_map(|l| l["href"].as_str()).collect();
        // Relative link absolutised; absolute one preserved; js + in-page dropped.
        assert!(hrefs.contains(&"https://example.com/docs/intro"));
        assert!(hrefs.contains(&"https://elsewhere.example/blog"));
        assert!(!hrefs.iter().any(|h| h.starts_with("javascript:")));
        assert!(!hrefs.iter().any(|h| h.starts_with('#')));
    }

    #[test]
    fn extract_reader_falls_back_when_metadata_missing() {
        let r = extract_reader("<html><body><p>text</p></body></html>", "");
        // Empty title becomes null in the JSON, not an empty string.
        assert!(r.value["title"].is_null());
        assert!(r.value["description"].is_null());
        assert_eq!(r.value["text"], "text");
    }
}
