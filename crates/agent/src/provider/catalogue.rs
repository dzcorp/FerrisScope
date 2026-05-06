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

#[derive(Debug, Default)]
struct Catalogue {
    /// (provider_models_dev_id, model_id) → limits.
    by_id: HashMap<(String, String), ModelLimits>,
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
    let mut next = HashMap::new();
    for (provider_id, entry) in resp.0 {
        for (model_id, m) in entry.models {
            if let Some(limits) = parse_limits(m.limit.as_ref()) {
                next.insert((provider_id.clone(), model_id), limits);
            }
        }
    }
    let mut g = slot().write().await;
    g.by_id = next;
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

    let mut next = HashMap::new();
    for (provider_id, entry) in parsed.0 {
        for (model_id, m) in entry.models {
            if let Some(limits) = parse_limits(m.limit.as_ref()) {
                next.insert((provider_id.clone(), model_id), limits);
            }
        }
    }
    {
        let mut g = slot().write().await;
        g.by_id = next;
        g.fetched_unix_ms = chrono::Utc::now().timestamp_millis();
        tracing::info!(count = g.by_id.len(), "models.dev: refreshed");
    }
    // Persist the raw response (not the parsed map) so a future
    // load_from_disk run sees the same shape models.dev sends. Errors
    // are non-fatal — the in-memory state is the source of truth for
    // the running process.
    let path = cache_root.join(CACHE_FILENAME);
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Err(e) = tokio::fs::write(&path, &bytes).await {
        tracing::warn!(error = %e, "models.dev: cache write failed");
    }
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
