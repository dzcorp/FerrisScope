//! Reasoning controls: what each provider / model offers ([`spec`]) and how a
//! saved choice becomes request fields ([`lower`]).
//!
//! Effort *names* are per model — `gpt-5.4` takes `none … xhigh`, a Claude 5
//! `low … max`, DeepSeek `high | max`, some models only an on/off toggle or a
//! token budget — so nothing here assumes a fixed low/medium/high. models.dev
//! `reasoning_options` is the source when it knows the model; a short static
//! table covers providers it doesn't (local / custom endpoints).
//!
//! A choice is saved per *provider*, so it may name a level the model in use
//! lacks ("xhigh" saved, a model that stops at "high"): [`lower`] maps it to
//! the nearest level that model accepts instead of sending a 400.

use crate::config::{ProviderKind, ProviderReasoning};
use crate::provider::catalogue::{self, effort_rank, ModelReasoning, Wire};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Budget presets offered in the UI, low to high.
const BUDGET_LADDER: &[u32] = &[1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536];

/// Anthropic's floor for `thinking.budget_tokens`.
const ANTHROPIC_MIN_BUDGET: u32 = 1_024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetRange {
    pub min: u32,
    pub max: Option<u32>,
    /// Ready-made choices inside the range.
    pub presets: Vec<u32>,
}

/// What the settings UI may offer for a provider (and optionally one model).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ReasoningSpec {
    /// Effort names, low → high. `none` means "thinking off".
    pub efforts: Vec<String>,
    /// Present only when the provider / model takes a token budget; the UI
    /// hides the budget control otherwise.
    pub budget: Option<BudgetRange>,
    /// Thinking can be switched on / off.
    pub toggle: bool,
    /// The lists come from models.dev rather than our static fallback.
    pub from_catalogue: bool,
}

impl ReasoningSpec {
    /// Nothing to choose: no efforts, no budget, no toggle.
    pub fn is_empty(&self) -> bool {
        self.efforts.is_empty() && self.budget.is_none() && !self.toggle
    }

    fn from_model(r: &ModelReasoning, from_catalogue: bool) -> Self {
        Self {
            efforts: r.efforts.clone(),
            budget: r.budget.map(|(min, max)| BudgetRange {
                min,
                max,
                presets: presets(min, max),
            }),
            toggle: r.toggle,
            from_catalogue,
        }
    }
}

fn presets(min: u32, max: Option<u32>) -> Vec<u32> {
    let floor = min.max(1);
    let ceil = max.unwrap_or(u32::MAX);
    let mut out: Vec<u32> = BUDGET_LADDER
        .iter()
        .copied()
        .filter(|b| *b >= floor && *b <= ceil)
        .collect();
    if out.is_empty() {
        out.push(floor.min(ceil));
    }
    out
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

/// What we offer when models.dev has nothing for the provider.
fn fallback(kind: ProviderKind) -> ReasoningSpec {
    let (efforts, budget): (&[&str], Option<(u32, Option<u32>)>) = match kind {
        ProviderKind::Anthropic | ProviderKind::CustomAnthropic | ProviderKind::KimiCoding => (
            &["low", "medium", "high"],
            Some((ANTHROPIC_MIN_BUDGET, None)),
        ),
        ProviderKind::OpenAI => (&["minimal", "low", "medium", "high"], None),
        ProviderKind::Google => (&["low", "medium", "high"], Some((128, Some(32_768)))),
        ProviderKind::OpenRouter => (&["low", "medium", "high"], Some((1_024, None))),
        _ => (&["low", "medium", "high"], None),
    };
    ReasoningSpec {
        efforts: names(efforts),
        budget: budget.map(|(min, max)| BudgetRange {
            min,
            max,
            presets: presets(min, max),
        }),
        toggle: false,
        from_catalogue: false,
    }
}

/// The reasoning options for `kind`; for one `model` when given and known,
/// otherwise everything the provider's models offer, merged.
pub fn spec(kind: ProviderKind, model: Option<&str>) -> ReasoningSpec {
    if let Some(opts) = model.and_then(|m| catalogue::reasoning_options(kind, m)) {
        return ReasoningSpec::from_model(&opts, true);
    }
    let union = catalogue::provider_reasoning_union(kind);
    if union != ModelReasoning::default() {
        return ReasoningSpec::from_model(&union, true);
    }
    fallback(kind)
}

// ─── effort resolution ──────────────────────────────────────────────────────

/// The accepted level closest to `requested`, preferring the lower one on a
/// tie. `None` when `requested` is `none` and the model can't turn thinking
/// off (the caller then sends nothing). An empty `supported` list means the
/// model's levels are unknown: pass the request through.
fn nearest_effort(requested: &str, supported: &[String]) -> Option<String> {
    if supported.is_empty() || supported.iter().any(|s| s == requested) {
        return Some(requested.to_string());
    }
    if requested == "none" {
        return None;
    }
    let want = effort_rank(requested);
    supported
        .iter()
        .filter(|s| s.as_str() != "none")
        .min_by_key(|s| {
            let have = effort_rank(s);
            let distance = want.abs_diff(have);
            (distance, have)
        })
        .cloned()
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

/// `claude-opus-4-7`, `claude-4.7-opus`, `claude-sonnet-5-5` → `(major, minor)`.
/// Eight-digit release dates (`…-20250514`) are not versions.
fn claude_version(id: &str) -> Option<(u32, u32)> {
    let rest = id.to_ascii_lowercase();
    let rest = rest.split("claude-").nth(1)?;
    let mut nums = rest
        .split(['-', '.', '@', ':'])
        .filter_map(|t| (t.len() <= 2).then(|| t.parse::<u32>().ok()).flatten());
    let major = nums.next()?;
    Some((major, nums.next().unwrap_or(0)))
}

#[derive(Debug, PartialEq, Eq)]
enum AnthropicStyle {
    /// `thinking: {type: adaptive}` + `output_config.effort` (4.6 and later).
    Adaptive,
    /// Opus 4.5: an explicit budget *and* an effort.
    Hybrid,
    /// `thinking: {type: enabled, budget_tokens}`.
    Budget,
}

fn anthropic_style(model: &str, opts: Option<&ModelReasoning>) -> AnthropicStyle {
    let lower = model.to_ascii_lowercase();
    if lower.contains("opus-4-5") || lower.contains("opus-4.5") {
        return AnthropicStyle::Hybrid;
    }
    if let Some(o) = opts {
        if !o.efforts.is_empty() {
            return AnthropicStyle::Adaptive;
        }
        if o.budget.is_some() {
            return AnthropicStyle::Budget;
        }
    }
    match claude_version(model) {
        Some((major, minor)) if major > 4 || (major == 4 && minor >= 6) => AnthropicStyle::Adaptive,
        // An unversioned Claude id is a new one.
        None if lower.contains("claude-") => AnthropicStyle::Adaptive,
        _ => AnthropicStyle::Budget,
    }
}

/// Effort names a Claude accepts when models.dev is silent about it.
fn claude_default_efforts(model: &str) -> Vec<String> {
    match claude_version(model) {
        Some((major, minor)) if major > 4 || (major == 4 && minor >= 7) || major >= 5 => {
            names(&["low", "medium", "high", "xhigh", "max"])
        }
        Some((4, 6)) => names(&["low", "medium", "high", "max"]),
        _ => names(&["low", "medium", "high"]),
    }
}

/// The budget an effort name stands for on a model that takes only a budget.
fn effort_to_budget(effort: &str) -> u32 {
    match effort {
        "minimal" => 1_024,
        "low" => 4_096,
        "medium" => 16_384,
        _ => 32_768,
    }
}

fn clamp_budget(budget: u32, range: Option<(u32, Option<u32>)>) -> u32 {
    let (min, max) = range.unwrap_or((ANTHROPIC_MIN_BUDGET, None));
    let min = min.max(ANTHROPIC_MIN_BUDGET);
    let b = budget.max(min);
    max.map_or(b, |m| b.min(m.max(min)))
}

fn lower_anthropic(
    model: &str,
    choice: &ProviderReasoning,
    opts: Option<&ModelReasoning>,
) -> Option<Value> {
    let style = anthropic_style(model, opts);
    let effort = choice.effort.as_deref();
    match style {
        AnthropicStyle::Adaptive | AnthropicStyle::Hybrid => {
            let supported = opts
                .filter(|o| !o.efforts.is_empty())
                .map_or_else(|| claude_default_efforts(model), |o| o.efforts.clone());
            // Effort-capable models take only an effort; a lone budget has
            // nothing to apply to.
            let e = nearest_effort(effort?, &supported);
            let Some(e) = e else {
                return Some(json!({ "thinking": { "type": "disabled" } }));
            };
            if e == "none" {
                // Some models default thinking on; saying nothing leaves it on.
                return Some(json!({ "thinking": { "type": "disabled" } }));
            }
            let thinking = if style == AnthropicStyle::Hybrid {
                let budget = clamp_budget(
                    choice.budget_tokens.unwrap_or(16_000),
                    opts.and_then(|o| o.budget),
                );
                json!({ "type": "enabled", "budget_tokens": budget })
            } else {
                json!({ "type": "adaptive" })
            };
            Some(json!({ "thinking": thinking, "output_config": { "effort": e } }))
        }
        AnthropicStyle::Budget => {
            if effort == Some("none") {
                return None;
            }
            let budget = choice
                .budget_tokens
                .or_else(|| effort.map(effort_to_budget))?;
            let budget = clamp_budget(budget, opts.and_then(|o| o.budget));
            Some(json!({ "thinking": { "type": "enabled", "budget_tokens": budget } }))
        }
    }
}

// ─── the other families ─────────────────────────────────────────────────────

fn supported_or(opts: Option<&ModelReasoning>, default: &[&str]) -> Vec<String> {
    match opts {
        Some(o) if !o.efforts.is_empty() => o.efforts.clone(),
        // Listed with no effort levels (a toggle, or a budget only): none to name.
        Some(_) => Vec::new(),
        None => names(default),
    }
}

fn lower_openai(
    choice: &ProviderReasoning,
    opts: Option<&ModelReasoning>,
    oauth_codex: bool,
) -> Option<Value> {
    let supported = supported_or(opts, &["minimal", "low", "medium", "high"]);
    if supported.is_empty() {
        return None;
    }
    let e = nearest_effort(choice.effort.as_deref()?, &supported)?;
    Some(if oauth_codex {
        // The Codex Responses endpoint rejects top-level `reasoning_effort`.
        json!({ "reasoning": { "effort": e } })
    } else {
        json!({ "reasoning_effort": e })
    })
}

fn lower_compat(choice: &ProviderReasoning, opts: Option<&ModelReasoning>) -> Option<Value> {
    let supported = supported_or(opts, &["low", "medium", "high"]);
    if supported.is_empty() {
        return None;
    }
    let e = nearest_effort(choice.effort.as_deref()?, &supported)?;
    Some(json!({ "reasoning_effort": e }))
}

fn lower_openrouter(choice: &ProviderReasoning, opts: Option<&ModelReasoning>) -> Option<Value> {
    let supported = supported_or(opts, &["minimal", "low", "medium", "high", "xhigh"]);
    let mut node = Map::new();
    if let Some(e) = choice.effort.as_deref().and_then(|e| {
        (!supported.is_empty())
            .then(|| nearest_effort(e, &supported))
            .flatten()
    }) {
        node.insert("effort".into(), json!(e));
    } else if let Some(b) = choice.budget_tokens {
        // OpenRouter takes an effort *or* a token cap, not both.
        node.insert("max_tokens".into(), json!(b));
    }
    (!node.is_empty()).then(|| json!({ "reasoning": node }))
}

/// Gemini's request shape depends on the model (budget on 2.5, level on 3+),
/// which only the provider can see: pass the choice through untouched for it to
/// translate and gate.
fn lower_gemini(choice: &ProviderReasoning) -> Option<Value> {
    let mut node = Map::new();
    if let Some(e) = &choice.effort {
        node.insert("effort".into(), json!(e));
    }
    if let Some(b) = choice.budget_tokens {
        node.insert("budget_tokens".into(), json!(b));
    }
    (!node.is_empty()).then(|| json!({ "reasoning": node }))
}

// ─── entry points ───────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum Family {
    Anthropic,
    Gemini,
    OpenAi,
    OpenRouter,
    Compat,
}

fn family(kind: ProviderKind, wire: Wire) -> Family {
    match kind {
        ProviderKind::Anthropic | ProviderKind::CustomAnthropic | ProviderKind::KimiCoding => {
            Family::Anthropic
        }
        ProviderKind::Google => Family::Gemini,
        ProviderKind::OpenAI => Family::OpenAi,
        ProviderKind::OpenRouter => Family::OpenRouter,
        // The gateways serve each model on its native wire; Go has no Gemini route.
        ProviderKind::OpencodeZen | ProviderKind::OpencodeGo => match wire {
            Wire::AnthropicMessages => Family::Anthropic,
            Wire::Gemini if kind == ProviderKind::OpencodeZen => Family::Gemini,
            _ => Family::Compat,
        },
        _ => Family::Compat,
    }
}

/// Request fields for `choice` on `model`, merged into the provider request as
/// `provider_options`. `None` when nothing should be sent: no choice made, a
/// model with no reasoning, or an effort the model can't act on.
pub fn lower(
    kind: ProviderKind,
    model: &str,
    choice: &ProviderReasoning,
    oauth_codex: bool,
) -> Option<Value> {
    if choice.is_empty() {
        return None;
    }
    let opts = catalogue::reasoning_options(kind, model);
    let non_reasoning = catalogue::capabilities(kind, model).is_some_and(|c| !c.reasoning);
    lower_with(
        kind,
        model,
        catalogue::wire(kind, model),
        choice,
        oauth_codex,
        opts.as_deref(),
        non_reasoning,
    )
}

/// [`lower`] with the catalogue lookups supplied (testable without the
/// process-global catalogue).
pub fn lower_with(
    kind: ProviderKind,
    model: &str,
    wire: Wire,
    choice: &ProviderReasoning,
    oauth_codex: bool,
    opts: Option<&ModelReasoning>,
    non_reasoning: bool,
) -> Option<Value> {
    if choice.is_empty() {
        return None;
    }
    // A model models.dev says doesn't reason (and lists no options) gets none.
    if non_reasoning && opts.is_none_or(|o| *o == ModelReasoning::default()) {
        return None;
    }
    match family(kind, wire) {
        Family::Anthropic => lower_anthropic(model, choice, opts),
        Family::Gemini => lower_gemini(choice),
        Family::OpenAi => lower_openai(choice, opts, oauth_codex),
        Family::OpenRouter => lower_openrouter(choice, opts),
        Family::Compat => lower_compat(choice, opts),
    }
}

#[cfg(test)]
mod tests;
