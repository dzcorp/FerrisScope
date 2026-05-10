//! `models.dev` catalogue cache.
//!
//! `https://models.dev/api.json` is a community-maintained catalogue with
//! per-model `limit.context` / `limit.input` / `limit.output` fields for
//! every major provider (OpenAI, Anthropic, OpenRouter, Groq, DeepSeek,
//! Mistral, Together, ...). We use it for one thing: resolving the
//! effective context window for a model so the auto-compaction trigger
//! knows when to fire.
//!
//! Strategy mirrors opencode's approach:
//! - Fetch once at app startup; cache to disk under the FerrisScope
//!   config dir at `agent/models.json`.
//! - On startup, read the on-disk cache immediately (so the catalogue
//!   is usable straight away even offline), then kick off a background
//!   refresh that runs the fetch and overwrites the cache on success.
//! - Lookup is `(ProviderKind, model_id) -> Option<ModelLimits>`,
//!   strictly. Callers fall back to `meta::for_kind(kind).
//!   default_context_window` on `None`.
//!
//! No periodic refresh — startup-only. Operators who want fresh data
//! restart the app. Cheap to add a 60min Tokio interval if we want it
//! later.

use crate::config::ProviderKind;
use crate::provider::meta;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::sync::RwLock;

const CATALOGUE_URL: &str = "https://models.dev/api.json";
const CACHE_FILENAME: &str = "models_dev.json";

#[derive(Debug, Clone, Copy)]
pub struct ModelLimits {
    /// Total context window in tokens.
    pub context: u32,
    /// Max input tokens (often = context, but some models reserve for
    /// output). Used by the compaction trigger as `usable = input -
    /// reserved` per opencode's formula.
    pub input: u32,
    /// Max output tokens per response. Used as the reserve buffer when
    /// `input` isn't explicitly capped.
    pub output: u32,
}

/// Per-model capability flags surfaced from models.dev. Drives request
/// shaping (gate `temperature` when the model rejects it, skip reasoning
/// knobs on non-reasoning models, round-trip `reasoning_content` for
/// interleaved-thinking models).
///
/// Three booleans + one `Option<String>` per entry — kept tight on
/// purpose. We hold one of these for every model in the catalogue
/// (~4500 entries) for the app's lifetime, so adding a field means
/// adding ~4500 allocations. Don't pull in metadata you can derive from
/// the lookup site instead.
#[derive(Debug, Clone)]
pub struct ModelCapabilities {
    pub reasoning: bool,
    pub tool_call: bool,
    pub temperature: bool,
    /// When set, the OpenAI-compat backend expects every assistant
    /// message to carry the named field with the previously-emitted
    /// reasoning text. The field name itself ("reasoning_content" or
    /// "reasoning_details") differs across vendors so we keep it as a
    /// string rather than encoding the variants here.
    pub interleaved_field: Option<String>,
}

#[derive(Debug, Default)]
struct Catalogue {
    /// (provider_models_dev_id, model_id) → limits.
    by_id: HashMap<(String, String), ModelLimits>,
    /// (provider_models_dev_id, model_id) → input-token cost in USD per
    /// million. Only populated when models.dev exposes a `cost` block;
    /// callers treat a missing entry as "unknown" rather than free.
    cost_by_id: HashMap<(String, String), f64>,
    /// (provider_models_dev_id, model_id) → capability flags.
    caps_by_id: HashMap<(String, String), ModelCapabilities>,
    fetched_unix_ms: i64,
}

fn slot() -> &'static RwLock<Catalogue> {
    static SLOT: OnceLock<RwLock<Catalogue>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(Catalogue::default()))
}

#[derive(Debug, Deserialize)]
struct ApiResponse(HashMap<String, ProviderEntry>);

#[derive(Debug, Deserialize)]
struct ProviderEntry {
    #[serde(default)]
    models: HashMap<String, ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    #[serde(default)]
    limit: Option<ModelLimitJson>,
    #[serde(default)]
    cost: Option<ModelCostJson>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    tool_call: Option<bool>,
    #[serde(default)]
    temperature: Option<bool>,
    #[serde(default)]
    interleaved: Option<InterleavedJson>,
}

#[derive(Debug, Deserialize)]
struct ModelLimitJson {
    #[serde(default)]
    context: Option<f64>,
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ModelCostJson {
    #[serde(default)]
    input: Option<f64>,
}

/// models.dev encodes the `interleaved` field as either a literal `true`
/// (legacy "is interleaved" boolean) or `{ "field": "reasoning_content" |
/// "reasoning_details" }` for vendors that name the round-trip slot
/// explicitly. We only act on the structured form — a plain `true` with
/// no field name is ambiguous and we'd rather no-op than guess.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum InterleavedJson {
    /// Legacy shape — `interleaved: true` with no field name. We
    /// can't act on it (we need the wire field name to round-trip)
    /// so this variant is parsed and discarded.
    #[allow(dead_code)]
    Bool(bool),
    Obj {
        #[serde(default)]
        field: Option<String>,
    },
}

/// Public lookup. Returns `None` when the model isn't in the catalogue
/// or the catalogue hasn't been populated yet — caller falls back to
/// `meta::for_kind(kind).default_context_window`.
///
/// We don't carry hardcoded model tables. Per-model limits live in
/// models.dev (canonical source) — opencode's Codex plugin does
/// override `gpt-5.5` to 400k/272k/128k for the OAuth path, but only
/// because the public OpenAI catalogue lists the API-mode variant.
/// We rely on the same upstream and accept the fallback for any
/// model not yet listed there.
pub fn lookup(kind: ProviderKind, model_id: &str) -> Option<ModelLimits> {
    let mdid = meta::models_dev_id(kind)?;
    // Try a non-blocking read; if the lock is contended (background
    // refresh in flight) we just miss. Caller will fall back.
    let g = slot().try_read().ok()?;
    g.by_id
        .get(&(mdid.to_string(), model_id.to_string()))
        .copied()
}

/// Resolve the effective context window for `(kind, model)`. Wraps
/// `lookup` + the per-provider default. Used by the compaction trigger.
pub fn context_window(kind: ProviderKind, model_id: &str) -> u32 {
    lookup(kind, model_id)
        .map(|l| l.context)
        .unwrap_or_else(|| meta::for_kind(kind).default_context_window)
}

/// Tokens we leave unused at the top of the window so the model has
/// room to actually generate. Mirrors opencode's
/// `min(20_000, max_output)` rule. Used by the compaction trigger:
/// fires when `accumulated >= context - reserved`.
pub fn reserved_tokens(kind: ProviderKind, model_id: &str) -> u32 {
    let limits = lookup(kind, model_id);
    let max_output = limits.map_or(8192, |l| l.output.max(1));
    20_000.min(max_output).max(2048)
}

/// True iff the catalogue knows this model has zero input-token cost.
/// Used to filter the OpenCode Zen catalogue when the public-tier key
/// is in use (mirrors opencode's own `cost.input === 0` filter). When
/// the catalogue hasn't loaded yet, or the model isn't listed, returns
/// `false` — caller decides whether to optimistically include unknown
/// models or drop them.
pub fn is_known_free(kind: ProviderKind, model_id: &str) -> bool {
    let Some(mdid) = meta::models_dev_id(kind) else {
        return false;
    };
    let Ok(g) = slot().try_read() else {
        return false;
    };
    g.cost_by_id
        .get(&(mdid.to_string(), model_id.to_string()))
        .is_some_and(|c| *c == 0.0)
}

/// True iff the in-memory catalogue has any entries for `kind`. Lets
/// callers distinguish "filter said not-free" from "filter has no
/// data yet" so they can degrade gracefully on first run / offline.
pub fn has_data_for(kind: ProviderKind) -> bool {
    let Some(mdid) = meta::models_dev_id(kind) else {
        return false;
    };
    let Ok(g) = slot().try_read() else {
        return false;
    };
    g.by_id.keys().any(|(p, _)| p == mdid)
}

/// Initialise the in-memory catalogue from on-disk cache. Cheap and
/// non-blocking — call this at app startup before chats can open.
pub async fn load_from_disk(cache_root: PathBuf) {
    let path = cache_root.join(CACHE_FILENAME);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return,
    };
    let Ok(resp) = serde_json::from_slice::<ApiResponse>(&bytes) else {
        return;
    };
    let (next, next_cost, next_caps) = parse_catalogue(resp);
    let mut g = slot().write().await;
    g.by_id = next;
    g.cost_by_id = next_cost;
    g.caps_by_id = next_caps;
    g.fetched_unix_ms = chrono::Utc::now().timestamp_millis();
    tracing::debug!(count = g.by_id.len(), "models.dev: loaded from disk cache");
}

/// Refresh the catalogue from the network. Best-effort: errors log and
/// leave the in-memory state alone. Spawn this in the background at
/// app startup so the chat code never blocks on it.
pub async fn refresh(cache_root: PathBuf) {
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "models.dev: client build failed");
            return;
        }
    };
    let resp = match client.get(CATALOGUE_URL).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, url = CATALOGUE_URL, "models.dev: fetch failed");
            return;
        }
    };
    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "models.dev: bad status");
        return;
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "models.dev: read body failed");
            return;
        }
    };
    let parsed: ApiResponse = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "models.dev: parse failed");
            return;
        }
    };

    let (next, next_cost, next_caps) = parse_catalogue(parsed);
    {
        let mut g = slot().write().await;
        g.by_id = next;
        g.cost_by_id = next_cost;
        g.caps_by_id = next_caps;
        g.fetched_unix_ms = chrono::Utc::now().timestamp_millis();
        tracing::info!(count = g.by_id.len(), "models.dev: refreshed");
    }
    // Persist the raw response (not the parsed map) so a future
    // load_from_disk run sees the same shape models.dev sends. Errors
    // are non-fatal — the in-memory state is the source of truth for
    // the running process.
    let path = cache_root.join(CACHE_FILENAME);
    if let Err(e) = crate::atomic_write::atomic_write(&path, &bytes).await {
        tracing::warn!(error = %e, "models.dev: cache write failed");
    }
}

type CatalogueMaps = (
    HashMap<(String, String), ModelLimits>,
    HashMap<(String, String), f64>,
    HashMap<(String, String), ModelCapabilities>,
);

fn parse_catalogue(resp: ApiResponse) -> CatalogueMaps {
    let mut by_id = HashMap::new();
    let mut cost_by_id = HashMap::new();
    let mut caps_by_id = HashMap::new();
    for (provider_id, entry) in resp.0 {
        for (model_id, m) in entry.models {
            let key = (provider_id.clone(), model_id.clone());
            if let Some(limits) = parse_limits(m.limit.as_ref()) {
                by_id.insert(key.clone(), limits);
            }
            if let Some(c) = m.cost.as_ref().and_then(|c| c.input) {
                cost_by_id.insert(key.clone(), c.max(0.0));
            }
            // Capability flags. models.dev ships these as plain booleans
            // (`reasoning`, `tool_call`, `temperature`); when missing, we
            // fall back to permissive defaults — `temperature: true`,
            // `tool_call: true`, `reasoning: false` — to match the
            // historical behaviour for models not yet in the catalogue.
            let interleaved_field = m.interleaved.and_then(|i| match i {
                InterleavedJson::Bool(_) => None,
                InterleavedJson::Obj { field } => field.filter(|s| !s.is_empty()),
            });
            let caps = ModelCapabilities {
                reasoning: m.reasoning.unwrap_or(false),
                tool_call: m.tool_call.unwrap_or(true),
                temperature: m.temperature.unwrap_or(true),
                interleaved_field,
            };
            caps_by_id.insert(key, caps);
        }
    }
    // Release HashMap growth headroom — after a bulk insert we sit on
    // ~12% over-allocation by default. The catalogue is read-mostly
    // for the rest of the app's lifetime so it's worth the one-time
    // shrink. Same for the next refresh — the new maps replace these
    // wholesale and get shrunk in turn.
    by_id.shrink_to_fit();
    cost_by_id.shrink_to_fit();
    caps_by_id.shrink_to_fit();
    (by_id, cost_by_id, caps_by_id)
}

/// Per-model capability lookup. Returns `None` when models.dev hasn't
/// loaded yet or doesn't list this `(provider, model)`. Callers should
/// fall back to permissive defaults so unknown models still chat.
pub fn capabilities(kind: ProviderKind, model_id: &str) -> Option<ModelCapabilities> {
    let mdid = meta::models_dev_id(kind)?;
    let g = slot().try_read().ok()?;
    g.caps_by_id
        .get(&(mdid.to_string(), model_id.to_string()))
        .cloned()
}

/// Round-trip slot for OpenAI-compat assistant messages — when present,
/// every assistant message in the next request body must carry this
/// field with the previously-emitted reasoning text. DeepSeek (and the
/// OpenCode Zen `big-pickle` proxy that fronts it) 400s without it.
pub fn interleaved_field(kind: ProviderKind, model_id: &str) -> Option<String> {
    capabilities(kind, model_id)?.interleaved_field
}

/// Opencode-style priority list for default-model selection. Substring
/// match against the model id; anything matching one of these names
/// bubbles to the top regardless of catalogue order. Mirrors
/// `priority` in opencode's `provider.ts::sort` so a fresh install
/// preselects a sensible model on every provider — `big-pickle` on
/// OpenCode Zen free tier, `claude-sonnet-4-x` on Anthropic, `gpt-5.x`
/// on OpenAI, etc.
const DEFAULT_PRIORITY: &[&str] = &["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"];

/// Sort `models` in-place from "best default" to "worst", using the
/// same rules as opencode: priority-list match first (later in the list
/// = higher priority — opencode sorts the index `desc`), then `latest`
/// in the id, then alphabetical descending so newer-versioned ids
/// (`*-2026-…`) come ahead of older ones at the tail.
pub fn sort_for_default<T: AsRef<str>>(models: &mut [T]) {
    models.sort_by(|a, b| {
        let ai = priority_index(a.as_ref());
        let bi = priority_index(b.as_ref());
        // Higher index wins (opencode's `desc`). Models that don't match
        // any priority entry get -1 and lose to anything that does.
        bi.cmp(&ai)
            .then_with(|| {
                // "latest" first (asc on the boolean — false sorts before
                // true, so we negate by mapping latest→0 and other→1).
                latest_rank(a.as_ref()).cmp(&latest_rank(b.as_ref()))
            })
            .then_with(|| {
                // Alphabetical descending among ties so newer date-tagged
                // ids show up first.
                b.as_ref().cmp(a.as_ref())
            })
    });
}

fn priority_index(id: &str) -> i32 {
    let lower = id.to_ascii_lowercase();
    DEFAULT_PRIORITY
        .iter()
        .position(|p| lower.contains(p))
        .map_or(-1, |i| i as i32)
}

fn latest_rank(id: &str) -> u8 {
    u8::from(!id.to_ascii_lowercase().contains("latest"))
}

fn parse_limits(j: Option<&ModelLimitJson>) -> Option<ModelLimits> {
    let j = j?;
    let context = j.context.map(|x| x.max(0.0) as u32).unwrap_or(0);
    let input = j.input.map(|x| x.max(0.0) as u32).unwrap_or(context);
    let output = j.output.map(|x| x.max(0.0) as u32).unwrap_or(0);
    if context == 0 {
        return None;
    }
    Some(ModelLimits {
        context,
        input,
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_for_default_promotes_priority_matches() {
        // Mix of free-tier OpenCode Zen ids. `big-pickle` matches the
        // priority list and must surface ahead of the others.
        let mut ids = vec![
            "trinity-large-preview-free".to_string(),
            "ling-2.6-flash-free".to_string(),
            "big-pickle".to_string(),
            "qwen3.6-plus-free".to_string(),
        ];
        sort_for_default(&mut ids);
        assert_eq!(ids[0], "big-pickle");
    }

    #[test]
    fn sort_for_default_orders_by_priority_then_latest_then_alpha_desc() {
        let mut ids = vec![
            "claude-haiku-4-5".to_string(),
            "claude-sonnet-4-5".to_string(),
            "gpt-5-latest".to_string(),
            "gpt-5".to_string(),
            "big-pickle".to_string(),
            "random-model".to_string(),
        ];
        sort_for_default(&mut ids);
        // big-pickle (index 2) > claude-sonnet-4 (index 1) > gpt-5 (index 0).
        // Within gpt-5 family, "latest" wins.
        assert_eq!(ids[0], "big-pickle");
        assert_eq!(ids[1], "claude-sonnet-4-5");
        assert_eq!(ids[2], "gpt-5-latest");
        assert_eq!(ids[3], "gpt-5");
        // Non-matching ids fall to the tail; alphabetical desc among them.
        assert_eq!(ids[4], "random-model");
        assert_eq!(ids[5], "claude-haiku-4-5");
    }

    #[test]
    fn parse_catalogue_extracts_interleaved_field() {
        let raw = serde_json::json!({
            "deepseek": {
                "models": {
                    "deepseek-reasoner": {
                        "limit": { "context": 128000, "output": 8192 },
                        "cost": { "input": 0.14 },
                        "reasoning": true,
                        "tool_call": true,
                        "temperature": true,
                        "interleaved": { "field": "reasoning_content" },
                    },
                    "deepseek-chat": {
                        "limit": { "context": 128000, "output": 8192 },
                        "cost": { "input": 0.14 },
                        "reasoning": false,
                        "tool_call": true,
                        "temperature": true,
                    },
                }
            }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_limits, _cost, caps) = parse_catalogue(resp);
        let reasoner = caps
            .get(&("deepseek".to_string(), "deepseek-reasoner".to_string()))
            .expect("deepseek-reasoner caps");
        assert_eq!(
            reasoner.interleaved_field.as_deref(),
            Some("reasoning_content")
        );
        assert!(reasoner.reasoning);
        let chat = caps
            .get(&("deepseek".to_string(), "deepseek-chat".to_string()))
            .expect("deepseek-chat caps");
        assert!(chat.interleaved_field.is_none());
        assert!(!chat.reasoning);
    }

    #[test]
    fn parse_catalogue_tolerates_legacy_interleaved_bool() {
        let raw = serde_json::json!({
            "openai": {
                "models": {
                    "legacy": {
                        "limit": { "context": 128000, "output": 4096 },
                        "interleaved": true,
                    }
                }
            }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_limits, _cost, caps) = parse_catalogue(resp);
        let m = caps
            .get(&("openai".to_string(), "legacy".to_string()))
            .expect("legacy caps");
        // Bare `interleaved: true` is parsed but ignored — we only act
        // when the field name is supplied.
        assert!(m.interleaved_field.is_none());
    }
}
