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
//! - Cache to disk under the FerrisScope config dir at
//!   `agent/models_dev.json`.
//! - On startup, read the on-disk cache immediately (so the catalogue
//!   is usable straight away even offline); refetch only when the cache
//!   is older than [`REFRESH_TTL`] (the payload is ~5 MB, ~0.5 MB gzipped).
//! - Lookup is `(ProviderKind, model_id) -> Option<ModelLimits>`,
//!   strictly. Callers fall back to `meta::for_kind(kind).
//!   default_context_window` on `None`.
//!
//! No periodic refresh — startup-only. Operators who want fresh data
//! restart the app. Cheap to add a 60min Tokio interval if we want it
//! later.

use crate::config::ProviderKind;
use crate::provider::meta;
use crate::provider::ModelInfo;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

const CATALOGUE_URL: &str = "https://models.dev/api.json";
const CACHE_FILENAME: &str = "models_dev.json";
pub const REFRESH_TTL: std::time::Duration = std::time::Duration::from_hours(24);

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

/// Which request shape serves a model. models.dev records it per model as the
/// AI-SDK package (`provider.npm`); the OpenCode gateways expose each model on
/// its native wire, and only that wire carries everything the model returns
/// (Anthropic thinking blocks, Gemini thought signatures).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Wire {
    /// `/chat/completions` — also the safe default for anything unlisted.
    #[default]
    OpenAiChat,
    /// Anthropic Messages (`/messages`).
    AnthropicMessages,
    /// Gemini `generateContent` (`/models/<id>:streamGenerateContent`).
    Gemini,
    /// OpenAI Responses (`/responses`). Not spoken natively here; callers
    /// fall back to chat completions, which the gateways translate.
    OpenAiResponses,
}

impl Wire {
    fn from_npm(npm: Option<&str>) -> Self {
        match npm {
            Some("@ai-sdk/anthropic") => Self::AnthropicMessages,
            Some("@ai-sdk/google") => Self::Gemini,
            Some("@ai-sdk/openai") => Self::OpenAiResponses,
            _ => Self::OpenAiChat,
        }
    }
}

/// What a model offers for reasoning, from models.dev `reasoning_options`:
/// the effort names it accepts (each model has its own — `none`, `minimal`,
/// `low` … `xhigh`, `max`), whether thinking can be switched off, and whether
/// it takes a token budget (with its floor and optional ceiling). Identical
/// specs are shared (`Arc`): a few dozen distinct shapes cover thousands of
/// models.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct ModelReasoning {
    pub efforts: Vec<String>,
    pub toggle: bool,
    /// `(min, max)` when the model takes `budget_tokens`.
    pub budget: Option<(u32, Option<u32>)>,
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
    /// True when the model accepts image input (models.dev
    /// `modalities.input` contains `"image"`). Drives whether the
    /// providers emit image content blocks for attached images or drop
    /// them with a note. Defaults to `false` when the catalogue lists the
    /// model without modalities — callers treat a *missing* catalogue
    /// entry (lookup returns `None`) as permissive, so unknown models
    /// still get a chance to render attachments.
    pub vision: bool,
    /// When set, the OpenAI-compat backend expects every assistant
    /// message to carry the named field with the previously-emitted
    /// reasoning text. The field name itself ("reasoning_content" or
    /// "reasoning_details") differs across vendors so we keep it as a
    /// string rather than encoding the variants here.
    pub interleaved_field: Option<String>,
    /// The wire the model is served on (see [`Wire`]). One byte, so it adds
    /// nothing to the per-entry cost noted above.
    pub wire: Wire,
    /// The model's reasoning options. `None` = the catalogue is silent about
    /// them (fall back to the provider's defaults); `Some` with nothing in it
    /// = it explicitly offers none.
    pub reasoning_options: Option<Arc<ModelReasoning>>,
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
    /// provider_models_dev_id → the provider's full model list, as the
    /// picker's source of truth. Populated from the same parse as the
    /// lookup maps above. `list_models` reads this; the per-provider
    /// `ChatProvider::list_models` impls fall back to it when their live
    /// `/models` call fails (and use it as the *primary* source for
    /// providers with no live endpoint — Codex OAuth, Z.AI, MiniMax).
    models_by_provider: HashMap<String, Vec<ModelInfo>>,
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
    /// Human-readable display name (models.dev `name`). Surfaced in the
    /// picker as `id — name`. Absent → picker shows the bare id.
    #[serde(default)]
    name: Option<String>,
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
    /// `{ "input": ["text", "image", "pdf"], "output": ["text"] }`.
    /// We only read `input` to decide vision support.
    #[serde(default)]
    modalities: Option<ModalitiesJson>,
    /// Per-model transport override, e.g. `{ "npm": "@ai-sdk/anthropic" }`
    /// on a gateway that serves Claude next to open models.
    #[serde(default)]
    provider: Option<ModelProviderJson>,
    /// `[{ "type": "effort", "values": ["low", …] }, { "type": "toggle" },
    /// { "type": "budget_tokens", "min": 1024 }]`.
    #[serde(default)]
    reasoning_options: Option<Vec<ReasoningOptionJson>>,
}

#[derive(Debug, Deserialize)]
struct ReasoningOptionJson {
    #[serde(rename = "type", default)]
    kind: String,
    /// Effort names; `null` is the API's "off" and reads as `none`.
    #[serde(default)]
    values: Vec<Option<String>>,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
}

fn parse_reasoning(options: &[ReasoningOptionJson]) -> ModelReasoning {
    let mut out = ModelReasoning::default();
    for o in options {
        match o.kind.as_str() {
            "effort" => {
                for v in &o.values {
                    let name = v.clone().unwrap_or_else(|| "none".to_string());
                    if !out.efforts.contains(&name) {
                        out.efforts.push(name);
                    }
                }
            }
            "toggle" => out.toggle = true,
            "budget_tokens" => {
                let min = o.min.map_or(0, |m| m.max(0.0) as u32);
                out.budget = Some((min, o.max.map(|m| m.max(0.0) as u32)));
            }
            _ => {}
        }
    }
    out
}

#[derive(Debug, Deserialize)]
struct ModelProviderJson {
    #[serde(default)]
    npm: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModalitiesJson {
    #[serde(default)]
    input: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

/// Whether a catalogue entry belongs in the *chat* model picker: it answers in
/// text only (image / audio / video / music generators don't) and isn't an
/// embedding model. A model with no modalities listed stays — absence isn't
/// evidence. Limits and capabilities are still recorded for every entry; this
/// only gates the picker list.
fn is_chat_model(id: &str, modalities: Option<&ModalitiesJson>) -> bool {
    let text_only = modalities.is_none_or(|m| m.output.iter().all(|o| o == "text"));
    text_only && !id.to_ascii_lowercase().contains("embed")
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
    let (next, next_cost, next_caps, next_models) = parse_catalogue(resp);
    let mut g = slot().write().await;
    g.by_id = next;
    g.cost_by_id = next_cost;
    g.caps_by_id = next_caps;
    g.models_by_provider = next_models;
    g.fetched_unix_ms = chrono::Utc::now().timestamp_millis();
    tracing::debug!(count = g.by_id.len(), "models.dev: loaded from disk cache");
}

fn cache_is_fresh(path: &std::path::Path, now: std::time::SystemTime) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        // An mtime ahead of `now` (clock skew, fine-grained FS timestamps) is age zero.
        .map(|at| now.duration_since(at).unwrap_or_default())
        .is_some_and(|age| age < REFRESH_TTL)
}

/// [`refresh`] unless the on-disk cache is younger than [`REFRESH_TTL`].
pub async fn refresh_if_stale(cache_root: PathBuf) {
    if cache_is_fresh(
        &cache_root.join(CACHE_FILENAME),
        std::time::SystemTime::now(),
    ) {
        tracing::debug!("models.dev: cache fresh, skipping refresh");
        return;
    }
    refresh(cache_root).await;
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

    let (next, next_cost, next_caps, next_models) = parse_catalogue(parsed);
    {
        let mut g = slot().write().await;
        g.by_id = next;
        g.cost_by_id = next_cost;
        g.caps_by_id = next_caps;
        g.models_by_provider = next_models;
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
    HashMap<String, Vec<ModelInfo>>,
);

fn parse_catalogue(resp: ApiResponse) -> CatalogueMaps {
    let mut by_id = HashMap::new();
    let mut cost_by_id = HashMap::new();
    let mut caps_by_id = HashMap::new();
    let mut models_by_provider: HashMap<String, Vec<ModelInfo>> = HashMap::new();
    let mut interned: HashMap<ModelReasoning, Arc<ModelReasoning>> = HashMap::new();
    for (provider_id, entry) in resp.0 {
        for (model_id, m) in entry.models {
            let key = (provider_id.clone(), model_id.clone());
            let context_length = parse_limits(m.limit.as_ref()).map(|l| l.context);
            if let Some(limits) = parse_limits(m.limit.as_ref()) {
                by_id.insert(key.clone(), limits);
            }
            if is_chat_model(&model_id, m.modalities.as_ref()) {
                models_by_provider
                    .entry(provider_id.clone())
                    .or_default()
                    .push(ModelInfo {
                        id: model_id.clone(),
                        name: m.name.clone(),
                        context_length,
                    });
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
            let vision = m
                .modalities
                .as_ref()
                .is_some_and(|md| md.input.iter().any(|s| s == "image"));
            let caps = ModelCapabilities {
                reasoning: m.reasoning.unwrap_or(false),
                tool_call: m.tool_call.unwrap_or(true),
                temperature: m.temperature.unwrap_or(true),
                vision,
                interleaved_field,
                wire: Wire::from_npm(m.provider.as_ref().and_then(|p| p.npm.as_deref())),
                reasoning_options: m.reasoning_options.as_deref().map(|opts| {
                    let spec = parse_reasoning(opts);
                    interned
                        .entry(spec.clone())
                        .or_insert_with(|| Arc::new(spec))
                        .clone()
                }),
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
    // Sort each provider's list once here (read-mostly afterwards) so
    // `list_models` is a cheap clone. Same default ordering the call
    // sites already apply to ids downstream.
    for models in models_by_provider.values_mut() {
        sort_model_infos(models);
        models.shrink_to_fit();
    }
    models_by_provider.shrink_to_fit();
    (by_id, cost_by_id, caps_by_id, models_by_provider)
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

/// True iff `(kind, model)` is known to accept image input. Returns
/// `true` when the model isn't in the catalogue yet — callers default to
/// "try it" rather than silently dropping attachments for a model we have
/// no data on (the apiserver is the final arbiter and surfaces a clean
/// 400). Returns `false` only when models.dev lists the model *and* its
/// input modalities exclude images, which is the one case where we can
/// confidently drop the attachment with a note instead of erroring.
pub fn supports_vision(kind: ProviderKind, model_id: &str) -> bool {
    capabilities(kind, model_id).is_none_or(|c| c.vision)
}

/// The reasoning options models.dev lists for `(kind, model)`, if it lists any.
pub fn reasoning_options(kind: ProviderKind, model_id: &str) -> Option<Arc<ModelReasoning>> {
    capabilities(kind, model_id)?.reasoning_options
}

/// Everything `kind`'s catalogue models offer for reasoning, merged: effort
/// names in canonical order, and the loosest budget range. What a
/// provider-level settings control can honestly list when no model is chosen.
/// Empty when the catalogue has nothing for the provider.
pub fn provider_reasoning_union(kind: ProviderKind) -> ModelReasoning {
    let Some(mdid) = meta::models_dev_id(kind) else {
        return ModelReasoning::default();
    };
    let Ok(g) = slot().try_read() else {
        return ModelReasoning::default();
    };
    let mut efforts: Vec<String> = Vec::new();
    let mut union = ModelReasoning::default();
    for ((provider, _), caps) in &g.caps_by_id {
        if provider != mdid {
            continue;
        }
        let Some(r) = &caps.reasoning_options else {
            continue;
        };
        for e in &r.efforts {
            if !efforts.contains(e) {
                efforts.push(e.clone());
            }
        }
        union.toggle |= r.toggle;
        union.budget = match (union.budget, r.budget) {
            (None, b) | (b, None) => b,
            (Some((lo_a, hi_a)), Some((lo_b, hi_b))) => Some((
                lo_a.min(lo_b),
                match (hi_a, hi_b) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    _ => None,
                },
            )),
        };
    }
    efforts.sort_by_key(|e| effort_rank(e));
    union.efforts = efforts;
    union
}

/// Canonical low → high ordering of effort names; unknown names sort last,
/// alphabetically stable.
pub fn effort_rank(name: &str) -> usize {
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        .iter()
        .position(|n| *n == name)
        .unwrap_or(usize::MAX)
}

/// The wire `(kind, model)` is served on. `OpenAiChat` when the catalogue
/// hasn't loaded or doesn't list the model — the one shape every gateway
/// accepts.
pub fn wire(kind: ProviderKind, model_id: &str) -> Wire {
    capabilities(kind, model_id).map_or(Wire::default(), |c| c.wire)
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
    models.sort_by(|a, b| default_order(a.as_ref(), b.as_ref()));
}

/// Free models whose provider collects or trains on prompts, per OpenCode's
/// privacy page (Big Pickle, the MiMo / Ling / Nemotron free tiers, and the
/// Contributor models that train Meta's models). Only ever *demotes* a model in
/// the default ordering — it stays selectable — so a stale entry degrades to
/// "slightly lower in the list", never to "missing".
fn collects_prompts(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    l == "big-pickle"
        || l.contains("contributor")
        || (l.ends_with("-free") && ["mimo-", "ling-", "nemotron"].iter().any(|m| l.contains(m)))
}

/// [`sort_for_default`] with a provider's own policy on top: for the OpenCode
/// gateways, models that collect prompts sort after every other model, so a
/// fresh install never preselects one — important when the agent is about to
/// send cluster data to it.
pub fn sort_for_default_for<T: AsRef<str>>(kind: ProviderKind, models: &mut [T]) {
    if kind.is_opencode_gateway() {
        models.sort_by(|a, b| {
            collects_prompts(a.as_ref())
                .cmp(&collects_prompts(b.as_ref()))
                .then_with(|| default_order(a.as_ref(), b.as_ref()))
        });
    } else {
        sort_for_default(models);
    }
}

/// The default-model comparator, keyed on a model id. Shared by
/// `sort_for_default` (id lists at the call sites) and `sort_model_infos`
/// (the `ModelInfo` lists stored in the catalogue) so both orderings stay
/// identical.
fn default_order(a: &str, b: &str) -> std::cmp::Ordering {
    let ai = priority_index(a);
    let bi = priority_index(b);
    // Higher index wins (opencode's `desc`). Models that don't match
    // any priority entry get -1 and lose to anything that does.
    bi.cmp(&ai)
        .then_with(|| latest_rank(a).cmp(&latest_rank(b)))
        .then_with(|| b.cmp(a))
}

/// Sort a `ModelInfo` list by the default ordering (keyed on id). Applied
/// once per catalogue refresh so `list_models` stays a cheap clone.
fn sort_model_infos(models: &mut [ModelInfo]) {
    models.sort_by(|a, b| default_order(&a.id, &b.id));
}

/// A provider's full model list from models.dev, pre-sorted by the
/// default ordering. Empty when the catalogue hasn't loaded yet, the
/// lock is contended, or `kind` has no models.dev id (e.g. Ollama —
/// local models aren't in the catalogue). Callers treat empty as "fall
/// back to my own source" (live `/models` or the static list).
pub fn list_models(kind: ProviderKind) -> Vec<ModelInfo> {
    let Some(mdid) = meta::models_dev_id(kind) else {
        return Vec::new();
    };
    let Ok(g) = slot().try_read() else {
        return Vec::new();
    };
    models_for(&g.models_by_provider, mdid)
}

/// Pure lookup + clone, split from `list_models` so it's unit-testable
/// without seeding the global slot. Stored vecs are already sorted.
fn models_for(map: &HashMap<String, Vec<ModelInfo>>, mdid: &str) -> Vec<ModelInfo> {
    map.get(mdid).cloned().unwrap_or_default()
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
    fn cache_freshness_follows_file_age() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILENAME);
        let now = std::time::SystemTime::now();
        assert!(!cache_is_fresh(&path, now), "missing cache is stale");

        std::fs::write(&path, b"{}").unwrap();
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(now - std::time::Duration::from_mins(1))
            .unwrap();
        assert!(cache_is_fresh(&path, now));
        file.set_modified(now - REFRESH_TTL - std::time::Duration::from_secs(1))
            .unwrap();
        assert!(!cache_is_fresh(&path, now));
    }

    #[test]
    fn cache_written_after_now_is_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILENAME);
        let now = std::time::SystemTime::now();
        std::fs::write(&path, b"{}").unwrap();
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(now + std::time::Duration::from_secs(5))
            .unwrap();
        assert!(cache_is_fresh(&path, now));
    }

    fn reasoning_of(
        raw: serde_json::Value,
        provider: &str,
        model: &str,
    ) -> Option<Arc<ModelReasoning>> {
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_l, _c, caps, _m) = parse_catalogue(resp);
        caps.get(&(provider.to_string(), model.to_string()))
            .unwrap()
            .reasoning_options
            .clone()
    }

    #[test]
    fn reasoning_options_parse_efforts_toggle_and_budget() {
        let raw = serde_json::json!({
            "p": { "models": {
                "effort": { "limit": { "context": 1 }, "reasoning_options": [
                    { "type": "toggle" },
                    { "type": "effort", "values": ["low", "medium", "high", "xhigh", "max"] } ] },
                "budget": { "limit": { "context": 1 }, "reasoning_options": [
                    { "type": "budget_tokens", "min": 1024 } ] },
                "ranged": { "limit": { "context": 1 }, "reasoning_options": [
                    { "type": "budget_tokens", "min": 128, "max": 32768 } ] },
                "nullable": { "limit": { "context": 1 }, "reasoning_options": [
                    { "type": "effort", "values": [null, "high"] } ] },
                "none": { "limit": { "context": 1 }, "reasoning_options": [] },
                "silent": { "limit": { "context": 1 } },
            } }
        });
        let get = |m: &str| reasoning_of(raw.clone(), "p", m);
        let e = get("effort").unwrap();
        assert_eq!(e.efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(e.toggle && e.budget.is_none());
        assert_eq!(get("budget").unwrap().budget, Some((1024, None)));
        assert_eq!(get("ranged").unwrap().budget, Some((128, Some(32768))));
        // `null` is the API's off switch.
        assert_eq!(get("nullable").unwrap().efforts, ["none", "high"]);
        // Explicitly nothing vs. silent are different answers.
        assert_eq!(*get("none").unwrap(), ModelReasoning::default());
        assert!(get("silent").is_none());
    }

    #[test]
    fn identical_reasoning_specs_are_shared_not_copied() {
        let raw = serde_json::json!({
            "p": { "models": {
                "a": { "limit": { "context": 1 }, "reasoning_options": [{ "type": "effort", "values": ["low", "high"] }] },
                "b": { "limit": { "context": 1 }, "reasoning_options": [{ "type": "effort", "values": ["low", "high"] }] },
            } }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_l, _c, caps, _m) = parse_catalogue(resp);
        let a = caps[&("p".to_string(), "a".to_string())]
            .reasoning_options
            .clone()
            .unwrap();
        let b = caps[&("p".to_string(), "b".to_string())]
            .reasoning_options
            .clone()
            .unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn effort_names_sort_low_to_high_with_strangers_last() {
        let mut names = [
            "max", "wild", "low", "none", "xhigh", "high", "minimal", "medium",
        ];
        names.sort_by_key(|n| effort_rank(n));
        assert_eq!(
            names,
            ["none", "minimal", "low", "medium", "high", "xhigh", "max", "wild"]
        );
    }

    #[test]
    fn wire_follows_the_models_package_and_defaults_to_chat() {
        let raw = serde_json::json!({
            "opencode": {
                "npm": "@ai-sdk/openai-compatible",
                "models": {
                    "claude-sonnet-4-6": { "limit": { "context": 200000 },
                        "provider": { "npm": "@ai-sdk/anthropic" } },
                    "gemini-3-flash": { "limit": { "context": 1048576 },
                        "provider": { "npm": "@ai-sdk/google" } },
                    "gpt-5.5": { "limit": { "context": 400000 },
                        "provider": { "npm": "@ai-sdk/openai" } },
                    "big-pickle": { "limit": { "context": 200000 } },
                    "kimi-k3": { "limit": { "context": 262144 },
                        "provider": { "npm": "@ai-sdk/openai-compatible" } },
                }
            }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_l, _c, caps, _m) = parse_catalogue(resp);
        let wire_of = |id: &str| {
            caps.get(&("opencode".to_string(), id.to_string()))
                .unwrap()
                .wire
        };
        assert_eq!(wire_of("claude-sonnet-4-6"), Wire::AnthropicMessages);
        assert_eq!(wire_of("gemini-3-flash"), Wire::Gemini);
        assert_eq!(wire_of("gpt-5.5"), Wire::OpenAiResponses);
        assert_eq!(wire_of("big-pickle"), Wire::OpenAiChat);
        assert_eq!(wire_of("kimi-k3"), Wire::OpenAiChat);
        // Unseeded catalogue (the unit-test default): the safe default.
        assert_eq!(
            wire(ProviderKind::OpencodeZen, "claude-sonnet-4-6"),
            Wire::OpenAiChat
        );
    }

    #[test]
    fn gateways_never_preselect_a_model_that_collects_prompts() {
        let mut ids: Vec<String> = [
            "big-pickle",
            "mimo-v2.5-free",
            "nemotron-3-ultra-free",
            "muse-spark-1.3-contributor-free",
            "space-bunny-free",
            "longcat-2.5-preview-free",
            "ling-3.0-flash-fin-free",
        ]
        .map(String::from)
        .to_vec();
        sort_for_default_for(ProviderKind::OpencodeZen, &mut ids);
        // The two zero-retention models lead; everything that collects follows.
        let lead: std::collections::HashSet<&str> = ids[..2].iter().map(String::as_str).collect();
        assert_eq!(
            lead,
            ["space-bunny-free", "longcat-2.5-preview-free"]
                .into_iter()
                .collect()
        );
        assert_eq!(ids.len(), 7);
        assert!(ids[2..].iter().all(|i| collects_prompts(i)));
    }

    #[test]
    fn demotion_is_a_gateway_policy_not_a_global_one() {
        let ids = || vec!["big-pickle".to_string(), "random-model".to_string()];
        let mut other = ids();
        sort_for_default_for(ProviderKind::OpenRouter, &mut other);
        assert_eq!(other[0], "big-pickle", "plain priority order elsewhere");
        let mut zen = ids();
        sort_for_default_for(ProviderKind::OpencodeZen, &mut zen);
        assert_eq!(zen[0], "random-model");
        // Paid models that merely share a family name aren't demoted.
        assert!(!collects_prompts("mimo-v2.5-pro"));
        assert!(!collects_prompts("kimi-k3"));
        assert!(collects_prompts("Muse-Spark-1.2-Contributor"));
    }

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
        let (_limits, _cost, caps, _models) = parse_catalogue(resp);
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
    fn parse_catalogue_extracts_vision_from_modalities() {
        let raw = serde_json::json!({
            "anthropic": {
                "models": {
                    "claude-opus": {
                        "limit": { "context": 200000, "output": 8192 },
                        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
                    },
                    "text-only": {
                        "limit": { "context": 128000, "output": 8192 },
                        "modalities": { "input": ["text"], "output": ["text"] },
                    },
                    "no-modalities": {
                        "limit": { "context": 128000, "output": 8192 },
                    },
                }
            }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_limits, _cost, caps, _models) = parse_catalogue(resp);
        assert!(
            caps.get(&("anthropic".to_string(), "claude-opus".to_string()))
                .unwrap()
                .vision
        );
        assert!(
            !caps
                .get(&("anthropic".to_string(), "text-only".to_string()))
                .unwrap()
                .vision
        );
        // Missing modalities block → vision defaults to false (we only
        // claim vision when models.dev positively lists "image").
        assert!(
            !caps
                .get(&("anthropic".to_string(), "no-modalities".to_string()))
                .unwrap()
                .vision
        );
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
        let (_limits, _cost, caps, _models) = parse_catalogue(resp);
        let m = caps
            .get(&("openai".to_string(), "legacy".to_string()))
            .expect("legacy caps");
        // Bare `interleaved: true` is parsed but ignored — we only act
        // when the field name is supplied.
        assert!(m.interleaved_field.is_none());
    }

    #[test]
    fn parse_catalogue_builds_model_list_with_names_and_context() {
        let raw = serde_json::json!({
            "zai": {
                "models": {
                    "glm-4.5": { "name": "GLM-4.5", "limit": { "context": 128000 } },
                    "glm-4.6": { "name": "GLM-4.6", "limit": { "context": 200000 } },
                }
            }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (_l, _c, _caps, models) = parse_catalogue(resp);
        let list = models_for(&models, "zai");
        assert_eq!(list.len(), 2);
        // Display name + context window carried from the catalogue.
        let glm46 = list.iter().find(|m| m.id == "glm-4.6").expect("glm-4.6");
        assert_eq!(glm46.name.as_deref(), Some("GLM-4.6"));
        assert_eq!(glm46.context_length, Some(200_000));
        // Pre-sorted by the default ordering: neither id matches the
        // priority list nor "latest", so alphabetical-descending wins and
        // the newer 4.6 sorts ahead of 4.5.
        assert_eq!(list[0].id, "glm-4.6");
        assert_eq!(list[1].id, "glm-4.5");
    }

    #[test]
    fn model_list_keeps_chat_models_and_drops_generators_and_embeddings() {
        let raw = serde_json::json!({
            "google": {
                "models": {
                    "gemini-2.5-pro": { "limit": { "context": 1048576 },
                        "modalities": { "input": ["text", "image"], "output": ["text"] } },
                    "gemini-2.5-flash-preview-tts": { "limit": { "context": 8192 },
                        "modalities": { "input": ["text"], "output": ["audio"] } },
                    "gemini-3-pro-image": { "limit": { "context": 65536 },
                        "modalities": { "input": ["text"], "output": ["text", "image"] } },
                    "veo-3.1": { "limit": { "context": 480 },
                        "modalities": { "input": ["text"], "output": ["video"] } },
                    "gemini-embedding-001": { "limit": { "context": 2048 },
                        "modalities": { "input": ["text"], "output": ["text"] } },
                    "no-modalities": { "limit": { "context": 1000 } },
                }
            }
        });
        let resp: ApiResponse = serde_json::from_value(raw).unwrap();
        let (limits, _c, caps, models) = parse_catalogue(resp);
        let listed = models_for(&models, "google");
        let mut ids: Vec<&str> = listed.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["gemini-2.5-pro", "no-modalities"]);
        // Excluded from the picker, but still known for limits / capabilities
        // — an operator can add them as custom models and get right behaviour.
        let key = ("google".to_string(), "gemini-3-pro-image".to_string());
        assert!(limits.contains_key(&key));
        assert!(caps.contains_key(&key));
    }

    #[test]
    fn models_for_unknown_provider_is_empty() {
        let map: HashMap<String, Vec<ModelInfo>> = HashMap::new();
        assert!(models_for(&map, "nope").is_empty());
    }

    #[test]
    fn list_models_empty_for_provider_without_models_dev_id() {
        // Ollama serves local models absent from models.dev — no id, so
        // the catalogue never supplies a list (caller stays on live).
        assert!(list_models(ProviderKind::Ollama).is_empty());
    }
}
