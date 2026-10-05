//! `agent::probe` — see `agent/mod.rs` for the split rationale.
//!
//! The Settings "Test" button's live `GET /models` check, split into pure
//! pieces (request shape per wire flavor, response counting, error text) so
//! each is testable without a network.

use ferrisscope_agent::ProviderFlavor;

/// Longest slice of an error body shown in the result chip.
const SNIPPET_MAX_CHARS: usize = 200;

pub(crate) struct Probe {
    pub(crate) url: String,
    pub(crate) headers: Vec<(&'static str, String)>,
}

/// The request that proves `base_url` + `key` can list models on `flavor`'s
/// wire. A blank key sends no auth header (local / open endpoints).
pub(crate) fn build(flavor: ProviderFlavor, base_url: &str, key: &str) -> Probe {
    let mut headers = Vec::new();
    let key = key.trim();
    if !key.is_empty() {
        match flavor {
            // Anthropic's first-party auth style; everything else takes a
            // Bearer token.
            ProviderFlavor::AnthropicMessages => {
                headers.push(("x-api-key", key.to_string()));
                headers.push(("anthropic-version", "2023-06-01".to_string()));
            }
            ProviderFlavor::GeminiGenerate => headers.push(("x-goog-api-key", key.to_string())),
            ProviderFlavor::OpenAiCompat | ProviderFlavor::OpenAiResponses => {
                headers.push(("authorization", format!("Bearer {key}")));
            }
        }
    }
    // Gemini pages `/models` at 50 by default; ask for the maximum so the
    // reported count isn't a first-page artefact.
    let query = match flavor {
        ProviderFlavor::GeminiGenerate => "?pageSize=1000",
        _ => "",
    };
    Probe {
        url: format!("{}/models{query}", base_url.trim_end_matches('/')),
        headers,
    }
}

/// Number of models in a `GET /models` body. The OpenAI shape
/// (`{data:[{id}]}`) and Anthropic's (`{data:[{id, display_name}]}`) hang the
/// list off `data`, Gemini's (`{models:[{name}]}`) off `models`; `None` when
/// the body has neither.
pub(crate) fn count_models(body: &str) -> Option<usize> {
    let v = serde_json::from_str::<serde_json::Value>(body).ok()?;
    ["data", "models"]
        .iter()
        .find_map(|key| v.get(*key)?.as_array().map(Vec::len))
}

/// A short, single-chip version of an error body: trimmed and capped on a
/// char boundary (error pages are often multibyte HTML / localized JSON).
pub(crate) fn error_snippet(body: &str) -> String {
    let trimmed = body.trim();
    match trimmed.char_indices().nth(SNIPPET_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &trimmed[..cut]),
        None => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header<'a>(p: &'a Probe, name: &str) -> Option<&'a str> {
        p.headers
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn openai_wire_uses_a_bearer_token() {
        let p = build(
            ProviderFlavor::OpenAiCompat,
            "https://gw.example/v1/",
            " k ",
        );
        assert_eq!(p.url, "https://gw.example/v1/models");
        assert_eq!(header(&p, "authorization"), Some("Bearer k"));
        assert_eq!(header(&p, "x-api-key"), None);
    }

    #[test]
    fn anthropic_wire_uses_x_api_key_and_version() {
        let p = build(
            ProviderFlavor::AnthropicMessages,
            "https://a.example/v1",
            "k",
        );
        assert_eq!(header(&p, "x-api-key"), Some("k"));
        assert_eq!(header(&p, "anthropic-version"), Some("2023-06-01"));
        assert_eq!(header(&p, "authorization"), None);
    }

    #[test]
    fn gemini_wire_uses_goog_header_and_asks_for_a_big_page() {
        let p = build(
            ProviderFlavor::GeminiGenerate,
            "https://generativelanguage.googleapis.com/v1beta/",
            "AIza-k",
        );
        assert_eq!(
            p.url,
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
        );
        assert_eq!(header(&p, "x-goog-api-key"), Some("AIza-k"));
        assert_eq!(header(&p, "authorization"), None);
        // The other flavors keep a bare `/models`.
        assert!(!build(ProviderFlavor::OpenAiCompat, "http://h/v1", "k")
            .url
            .contains('?'));
    }

    #[test]
    fn blank_key_sends_no_auth_on_any_flavor() {
        for flavor in [
            ProviderFlavor::OpenAiCompat,
            ProviderFlavor::AnthropicMessages,
            ProviderFlavor::OpenAiResponses,
            ProviderFlavor::GeminiGenerate,
        ] {
            assert!(build(flavor, "http://localhost:11434/v1", "  ")
                .headers
                .is_empty());
        }
    }

    #[test]
    fn counts_models_from_either_shape_and_rejects_others() {
        assert_eq!(count_models(r#"{"data":[{"id":"a"},{"id":"b"}]}"#), Some(2));
        assert_eq!(count_models(r#"{"data":[]}"#), Some(0));
        // Gemini hangs its list off `models`.
        assert_eq!(
            count_models(r#"{"models":[{"name":"x"},{"name":"y"}]}"#),
            Some(2)
        );
        assert_eq!(count_models(r#"{"other":[1]}"#), None);
        assert_eq!(count_models(r#"{"data":"nope"}"#), None);
        assert_eq!(count_models("<html>502</html>"), None);
    }

    #[test]
    fn snippet_passes_short_bodies_through_trimmed() {
        assert_eq!(error_snippet("  boom \n"), "boom");
        assert_eq!(error_snippet(""), "");
    }

    #[test]
    fn snippet_truncates_at_the_cap() {
        let long = "x".repeat(SNIPPET_MAX_CHARS + 50);
        let s = error_snippet(&long);
        assert_eq!(s.chars().count(), SNIPPET_MAX_CHARS + 1);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn snippet_never_splits_a_multibyte_char() {
        // 3-byte chars put byte 200 mid-codepoint; a byte slice would panic.
        let body = "错".repeat(SNIPPET_MAX_CHARS + 10);
        let s = error_snippet(&body);
        assert_eq!(s.chars().count(), SNIPPET_MAX_CHARS + 1);
        assert!(s.starts_with('错') && s.ends_with('…'));
    }
}
