//! `agent::classify` — see `agent/mod.rs` for the split rationale.

use ferrisscope_agent::ProviderError;

/// Initial backoff before the first transient retry (in milliseconds).
/// Doubles each attempt up to `TRANSIENT_RETRY_MAX_DELAY_MS`. Same
/// 2s starting point opencode uses; gives the upstream a real chance
/// to recover from a typical LB hiccup without being so long that the
/// operator notices a perceptible stall.
const TRANSIENT_RETRY_INITIAL_DELAY_MS: u64 = 2_000;

/// Cap on backoff between attempts. 30s matches opencode's
/// `RETRY_MAX_DELAY_NO_HEADERS`. Keeps a misbehaving upstream from
/// stretching a single retry into a multi-minute pause.
const TRANSIENT_RETRY_MAX_DELAY_MS: u64 = 30_000;

/// Classify a `ProviderError` as a transient infrastructure failure
/// worth retrying. Returns `Some(reason)` when retryable; `None`
/// otherwise (caller falls through to either context-overflow recovery
/// or the terminal error path). Keep the reason short — it ends up in
/// trace logs and the eventual exhaustion message.
///
/// Mirrors opencode's `retry.ts::retryable` shape: 5xx codes are
/// always retryable, plus rate-limit and "Overloaded" patterns. We
/// also catch the Envoy / L7-LB phrasing that chatgpt.com surfaces
/// when the OAuth backend is unreachable. Auth failures and 4xx
/// errors aren't retryable — the request is wrong, not the upstream.
pub(crate) fn is_transient_error(e: &ProviderError) -> Option<String> {
    match e {
        // Auth errors: never retryable. The credential is wrong; retrying
        // wastes the operator's time and risks lockout if the upstream
        // counts attempts.
        ProviderError::Auth(_) => None,
        // HTTP responses carry an authoritative numeric status — classify on
        // the number, NOT on substrings. A 400 whose body merely mentions
        // "503" or a model id containing "429" must not be treated as
        // transient. 429 = rate limit; 5xx (incl. Anthropic's 529
        // "overloaded") = upstream. Everything else (4xx) is the client's
        // fault and retrying won't help.
        ProviderError::Http {
            status: Some(code), ..
        } => {
            if *code == 429 {
                Some("rate limited".into())
            } else if *code >= 500 {
                Some(format!("upstream {code}"))
            } else {
                None
            }
        }
        // Transport errors (`status: None`) and other non-HTTP variants have
        // no status — fall back to phrase matching for connection resets and
        // timeouts, which are inherently retryable. (Envoy/Cloudflare 5xx
        // bodies like "upstream connect error" already match the 5xx status
        // branch above; these phrases catch the pre-response TCP failures.)
        _ => {
            let s = e.to_string().to_ascii_lowercase();
            for phrase in [
                "upstream connect error",
                "disconnect/reset before headers",
                "connection reset",
                "connection refused",
                "no healthy upstream",
            ] {
                if s.contains(phrase) {
                    return Some("upstream connection reset".into());
                }
            }
            if s.contains("timed out") || s.contains("operation timeout") {
                return Some("request timeout".into());
            }
            None
        }
    }
}

/// Backoff delay for the n-th retry attempt (1-indexed). 2s, 4s, 8s,
/// 16s, then capped at 30s. Mirrors opencode's `delay()` formula
/// without the Retry-After header dance — providers that send
/// `Retry-After` would be a future enhancement.
pub(crate) fn transient_retry_delay_ms(attempt: u8) -> u64 {
    let exp = u32::from(attempt.saturating_sub(1)).min(20);
    let raw = TRANSIENT_RETRY_INITIAL_DELAY_MS.saturating_mul(2u64.saturating_pow(exp));
    raw.min(TRANSIENT_RETRY_MAX_DELAY_MS)
}

/// Heuristic: does this provider error look like a context-window /
/// orphan-tool-call rejection that compaction can recover from?
///
/// The Codex Responses endpoint surfaces a too-large request as a
/// 400 "No tool output found for function call call_…". OpenAI Chat
/// Completions and Anthropic both have their own phrasings. We match
/// on signal substrings rather than parsing per-vendor JSON because the
/// error body shape changes more often than the prose — and a false
/// negative is fine (we'd just render the error as today), while a
/// false positive only costs an extra compaction.
pub(crate) fn is_context_overflow_error(e: &ProviderError) -> bool {
    // Overflow is a 4xx whose vendor-specific body names the symptom; the
    // status alone can't disambiguate it from other client errors, so we match
    // the response body's prose. Read the `body` field directly when present
    // (don't let the rendered "http error 400: " prefix dilute the match).
    let s = match e {
        ProviderError::Http { body, .. } => body.to_ascii_lowercase(),
        other => other.to_string().to_ascii_lowercase(),
    };
    [
        // Codex Responses orphan-tool symptom (root cause: input body too
        // large to send all the function_call_outputs that pair with the
        // function_calls we sent — backend drops some, then 400s).
        "no tool output found for function call",
        // OpenAI / OpenRouter standard phrasings.
        "context_length_exceeded",
        "context length",
        "context window",
        "maximum context",
        "exceeds the maximum",
        // Anthropic / generic "input too large".
        "input is too long",
        "input too large",
        "prompt is too long",
        // Codex / GPT family token-budget phrasing.
        "exceed the model",
        "token limit",
        "tokens exceed",
    ]
    .iter()
    .any(|needle| s.contains(needle))
}

/// Best-effort redaction of common secret shapes from text that will be shown
/// to the operator AND persisted to the on-disk transcript. Provider error
/// bodies can echo request URLs / headers that carry API keys or bearer tokens;
/// scrub the high-signal patterns so they don't land on disk. Conservative and
/// word-boundary-aware: a missed pattern just leaves the (already low-risk)
/// prose intact rather than mangling a legitimate error message.
pub(crate) fn redact_secrets(input: &str) -> String {
    const REDACTED: &str = "<redacted>";
    // Triggers that *begin* a secret token — the run from here is redacted
    // whole. Lowercase (we match against a lowercased copy).
    const KEY_PREFIXES: &[&str] = &["sk-ant-", "sk-", "aiza", "ghp_", "gho_", "xoxb-", "xoxp-"];
    // `<name>=<value>` / `Bearer <value>` triggers — keep the literal trigger,
    // redact the value run that follows.
    const VALUE_TRIGGERS: &[&str] = &[
        "bearer ",
        "authorization=",
        "access_token=",
        "refresh_token=",
        "api_key=",
        "api-key=",
        "apikey=",
        "token=",
        "secret=",
        "password=",
        "key=",
    ];

    fn is_secret_char(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+' | b'/' | b'=' | b'~')
    }
    // A trigger only starts a match at a word boundary, so "task-force" can't
    // match the "sk-" prefix and "monkey=" can't match the "key=" trigger.
    fn is_word_char(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
    }

    let lower = input.to_ascii_lowercase();
    let lb = lower.as_bytes();
    let n = input.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    'outer: while i < n {
        let at_boundary = i == 0 || !is_word_char(lb[i - 1]);
        if at_boundary {
            // `<name>=<value>` / `Bearer <value>`: keep the trigger, redact the value.
            for trig in VALUE_TRIGGERS {
                if lb[i..].starts_with(trig.as_bytes()) {
                    let pend = i + trig.len();
                    out.push_str(&input[i..pend]);
                    let mut j = pend;
                    while j < n && is_secret_char(lb[j]) {
                        j += 1;
                    }
                    if j > pend {
                        out.push_str(REDACTED);
                        i = j;
                    } else {
                        i = pend;
                    }
                    continue 'outer;
                }
            }
            // Bare key tokens (sk-…, AIza…): redact the prefix + run together.
            // Require ≥8 chars beyond the prefix so ordinary words don't match.
            for pre in KEY_PREFIXES {
                if lb[i..].starts_with(pre.as_bytes()) {
                    let mut j = i + pre.len();
                    while j < n && is_secret_char(lb[j]) {
                        j += 1;
                    }
                    if j - i >= pre.len() + 8 {
                        out.push_str(REDACTED);
                        i = j;
                        continue 'outer;
                    }
                }
            }
        }
        // No trigger here — copy one UTF-8 char.
        let ch = input[i..].chars().next().expect("i is on a char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(status: u16, body: &str) -> ProviderError {
        ProviderError::Http {
            status: Some(status),
            body: body.to_owned(),
        }
    }

    #[test]
    fn context_overflow_classifier_codex_orphan() {
        let e = http(
            400,
            "{ \"error\": { \"message\": \"No tool output found for function call call_X\" } }",
        );
        assert!(is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_openai_context_length() {
        let e = http(
            400,
            "{ \"error\": { \"code\": \"context_length_exceeded\" } }",
        );
        assert!(is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_anthropic_input_too_long() {
        let e = http(
            400,
            "{ \"error\": { \"message\": \"prompt is too long: 200000 tokens > 199998 maximum\" } }",
        );
        assert!(is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_negative_unrelated_400() {
        let e = http(400, "Bad Request: invalid model id 'gpt-5'");
        assert!(!is_context_overflow_error(&e));
    }

    #[test]
    fn context_overflow_classifier_negative_auth() {
        let e = ProviderError::Auth("invalid token".into());
        assert!(!is_context_overflow_error(&e));
    }

    #[test]
    fn transient_classifier_503_envoy_reset() {
        // Envoy's edge surfaces "upstream connect error" as the BODY of a 503.
        let e = http(
            503,
            "upstream connect error or disconnect/reset before headers",
        );
        assert!(is_transient_error(&e).is_some());
    }

    #[test]
    fn transient_classifier_429_rate_limit() {
        assert!(is_transient_error(&http(429, "Too Many Requests")).is_some());
    }

    #[test]
    fn transient_classifier_502_504() {
        assert!(is_transient_error(&http(502, "Bad Gateway")).is_some());
        assert!(is_transient_error(&http(504, "Gateway Timeout")).is_some());
    }

    #[test]
    fn transient_classifier_overloaded() {
        // Anthropic "overloaded" arrives as HTTP 529 — caught by the >= 500
        // status branch, no body-substring needed.
        let e = http(
            529,
            "{\"error\":{\"message\":\"Overloaded\",\"type\":\"overloaded_error\"}}",
        );
        assert!(is_transient_error(&e).is_some());
    }

    #[test]
    fn transient_classifier_negative_400() {
        assert!(is_transient_error(&http(400, "Bad Request: invalid model")).is_none());
    }

    #[test]
    fn transient_classifier_no_false_positive_from_body_digits() {
        // The whole point of keying on the numeric status: a 400 whose body
        // happens to contain "503" or "429" must NOT be retried. The old
        // substring matcher misclassified these.
        assert!(is_transient_error(&http(400, "model gpt-503 not found")).is_none());
        assert!(is_transient_error(&http(400, "error code 429000 invalid")).is_none());
    }

    #[test]
    fn transient_classifier_transport_errors_retry() {
        // Transport failures (no HTTP response → status None) are retryable
        // via phrase matching.
        assert!(
            is_transient_error(&ProviderError::transport("connection reset by peer")).is_some()
        );
        assert!(
            is_transient_error(&ProviderError::transport("operation timed out")).is_some(),
            "timeouts retry"
        );
        // A transport error with no recognised phrase isn't classified transient.
        assert!(is_transient_error(&ProviderError::transport("tls handshake botched")).is_none());
    }

    #[test]
    fn redact_secrets_scrubs_keys_and_tokens() {
        // OpenAI / Anthropic key prefixes.
        let r = redact_secrets("auth failed for sk-ant-abcd1234efgh5678 on /v1/messages");
        assert!(
            !r.contains("sk-ant-abcd1234"),
            "anthropic key redacted: {r}"
        );
        assert!(r.contains("<redacted>"));
        assert!(r.contains("/v1/messages"), "non-secret text preserved");

        // Bearer token: keep the word, redact the token.
        let r = redact_secrets("Authorization: Bearer abcdEFGH1234567890tok");
        assert!(r.contains("Bearer "), "Bearer label kept");
        assert!(!r.contains("abcdEFGH1234567890tok"));

        // Query-param secret.
        let r = redact_secrets("GET https://h/api?api_key=AIzaSyD1234567890abc&x=1 failed");
        assert!(!r.contains("AIzaSyD1234567890abc"));
        assert!(r.contains("api_key="), "param name kept");
        assert!(r.contains("x=1"), "unrelated param preserved");
    }

    #[test]
    fn redact_secrets_leaves_ordinary_prose_intact() {
        // Word-boundary guard: hyphenated words containing "sk-" / params like
        // "monkey=" must not be mangled.
        let s = "task-force update; the monkey=banana joke; status 503 upstream";
        assert_eq!(redact_secrets(s), s, "no false-positive redaction");
        // Short tokens after a prefix aren't redacted (need >= 8 trailing).
        assert_eq!(redact_secrets("sk-abc"), "sk-abc");
    }

    #[test]
    fn transient_classifier_negative_auth() {
        let e = ProviderError::Auth("invalid token".into());
        assert!(is_transient_error(&e).is_none());
    }

    #[test]
    fn transient_backoff_grows_then_caps() {
        // 2s, 4s, 8s, 16s, 30s (capped from 32s).
        assert_eq!(transient_retry_delay_ms(1), 2_000);
        assert_eq!(transient_retry_delay_ms(2), 4_000);
        assert_eq!(transient_retry_delay_ms(3), 8_000);
        assert_eq!(transient_retry_delay_ms(4), 16_000);
        assert_eq!(transient_retry_delay_ms(5), 30_000);
        // Subsequent attempts stay capped (we cap MAX_TRANSIENT_RETRIES
        // at 5 anyway, but the math has to be safe past that).
        assert_eq!(transient_retry_delay_ms(10), 30_000);
        assert_eq!(transient_retry_delay_ms(255), 30_000);
    }
}
