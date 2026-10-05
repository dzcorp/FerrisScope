//! `agent::settings` — see `agent/mod.rs` for the split rationale.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use directories::ProjectDirs;
use ferrisscope_agent::config::{lenient_kind_map, lenient_kind_set};
use ferrisscope_agent::{AgentSettings, Credential, ProviderConfig, ProviderKind};

use super::{ensure_enabled, ProviderEnabledPatch, ProviderReasoningPatch};
use serde::{Deserialize, Serialize};

fn settings_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("agent_settings.json"))
}

pub(crate) fn sessions_root() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope").map(|p| p.config_dir().join("agent"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct PersistedSettings {
    #[serde(default)]
    pub(crate) settings: AgentSettings,
    /// Per-provider plaintext fallback for the credential. Populated only
    /// when the operator opted into `allow_plaintext_api_key` AND the
    /// keychain backend is unavailable on this host. Each value is the
    /// JSON-serialised [`Credential`]; we don't shorthand "bare key" here
    /// since we'd lose the OAuth refresh-token + account-id fields.
    #[serde(default, deserialize_with = "lenient_kind_map")]
    pub(crate) plaintext_credentials: HashMap<ProviderKind, String>,
    /// Index of providers known to have a stored credential (keychain or
    /// plaintext). Index only — no secrets. Lets us skip the keychain on
    /// providers that have nothing stored, which matters on macOS where
    /// each `get_password` against a real item triggers an ACL prompt.
    #[serde(default, deserialize_with = "lenient_kind_set")]
    pub(crate) configured_providers: HashSet<ProviderKind>,
    /// One-shot: have we backfilled `configured_providers` from the
    /// keychain for an existing install? Pre-`configured_providers`
    /// deployments arrive with the field empty even though their keychain
    /// is full; the first `ai_get_settings` after upgrade does a sweep
    /// and sets this true so we never re-sweep.
    #[serde(default)]
    pub(crate) keychain_index_initialized: bool,
}

pub(crate) async fn load_persisted() -> PersistedSettings {
    let Some(path) = settings_path() else {
        return PersistedSettings::default();
    };
    load_persisted_at(&path).await
}

async fn load_persisted_at(path: &std::path::Path) -> PersistedSettings {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) if !b.is_empty() => b,
        _ => return PersistedSettings::default(),
    };
    // Try the new shape first; on failure, attempt to read the legacy
    // (single-provider) shape and migrate it forward in-memory. The
    // migrated values get written back the first time the operator
    // saves anything.
    match serde_json::from_slice::<PersistedSettings>(&bytes) {
        Ok(mut p) => {
            // Old `api_key_plaintext` field that the modern struct no
            // longer carries: parse it from the raw JSON and migrate it
            // into `plaintext_credentials` under the active provider.
            if let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(legacy_key) = raw.get("api_key_plaintext").and_then(|v| v.as_str()) {
                    if !legacy_key.is_empty() {
                        let cred = Credential::ApiKey {
                            key: legacy_key.to_string(),
                        };
                        if let Ok(json) = serde_json::to_string(&cred) {
                            p.plaintext_credentials
                                .entry(p.settings.active_provider)
                                .or_insert(json);
                        }
                    }
                }
                // Old shape: settings.provider.{kind, base_url}. The
                // modern shape has `active_provider` + `providers` map.
                // The new struct leaves `providers` empty — preserve the
                // base_url override here so operator overrides survive.
                if let Some(legacy_provider) = raw.pointer("/settings/provider") {
                    if let Some(kind_str) = legacy_provider.get("kind").and_then(|x| x.as_str()) {
                        if let Some(kind) = parse_provider_kind(kind_str) {
                            p.settings.active_provider = kind;
                            let base_url = legacy_provider
                                .get("base_url")
                                .and_then(|x| x.as_str())
                                .map(|s| s.to_string())
                                .filter(|s| !s.is_empty());
                            p.settings.providers.entry(kind).or_insert(ProviderConfig {
                                base_url,
                                ..ProviderConfig::default()
                            });
                        }
                    }
                }
            }
            migrate_zen_opt_in(&mut p);
            migrate_global_reasoning(&mut p);
            normalize_active_provider(&mut p);
            p
        }
        Err(e) => {
            // Falling back to defaults is fine for this run, but the next
            // save would overwrite the file and erase everything in it (MCP
            // servers, prompt override…). Keep the unreadable original.
            let backup = path.with_extension("json.bak");
            let kept = tokio::fs::copy(path, &backup).await.is_ok();
            tracing::warn!(error = %e, kept_backup = kept, "agent_settings.json: falling back to default");
            PersistedSettings::default()
        }
    }
}

/// Installs that predate the provider switch used Zen's free tier
/// implicitly. Pin it on for the ones actually relying on it (active
/// provider, or a stored key) so the upgrade doesn't cut them off; everyone
/// else gets the opt-in default. An explicit operator choice is never
/// overridden, so this is idempotent.
fn migrate_zen_opt_in(p: &mut PersistedSettings) {
    let zen = ProviderKind::OpencodeZen;
    let undecided = p
        .settings
        .providers
        .get(&zen)
        .is_none_or(|c| c.enabled.is_none());
    let in_use = p.settings.active_provider == zen
        || p.configured_providers.contains(&zen)
        || p.plaintext_credentials.contains_key(&zen);
    if undecided && in_use {
        p.settings.providers.entry(zen).or_default().enabled = Some(true);
    }
}

/// Reasoning used to be one global effort (low / medium / high) and budget.
/// Effort names differ per provider, so it is saved per provider now: hand the
/// old values to every provider the operator has connected (and the active
/// one) that has no choice of its own, then retire the global. Idempotent.
fn migrate_global_reasoning(p: &mut PersistedSettings) {
    if p.settings.reasoning.is_empty() {
        return;
    }
    let mut targets: Vec<ProviderKind> = p.configured_providers.iter().copied().collect();
    targets.push(p.settings.active_provider);
    for kind in targets {
        if !p.settings.provider_reasoning.contains_key(&kind) {
            let legacy = p.settings.effective_reasoning(kind);
            p.settings.provider_reasoning.insert(kind, legacy);
        }
    }
    p.settings.reasoning = ferrisscope_agent::ReasoningSettings::default();
}

/// Largest budget the UI can ask for; anything beyond is a typo, not a choice.
const MAX_BUDGET_TOKENS: u32 = 1_000_000;

/// Validate and apply a reasoning patch: the effort must look like a level
/// name (`xhigh`, `max`, …) — the lists are the provider's, so the exact set
/// isn't checked here — and the budget must be sane. An empty choice removes
/// the provider's entry.
pub(crate) fn apply_provider_reasoning(
    p: &mut PersistedSettings,
    patch: &ProviderReasoningPatch,
) -> Result<(), String> {
    let effort = patch
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty());
    if let Some(e) = effort {
        let ok = e.len() <= 16
            && e.starts_with(|c: char| c.is_ascii_lowercase())
            && e.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !ok {
            return Err(format!("invalid reasoning effort `{e}`"));
        }
    }
    let budget = patch.budget_tokens.filter(|b| *b > 0);
    if budget.is_some_and(|b| b > MAX_BUDGET_TOKENS) {
        return Err(format!(
            "reasoning budget is too large (max {MAX_BUDGET_TOKENS})"
        ));
    }
    let choice = ferrisscope_agent::config::ProviderReasoning {
        effort: effort.map(str::to_owned),
        budget_tokens: budget,
    };
    if choice.is_empty() {
        p.settings.provider_reasoning.remove(&patch.provider);
    } else {
        p.settings.provider_reasoning.insert(patch.provider, choice);
    }
    Ok(())
}

/// Apply the enable switch and the active-provider choice from one patch.
/// The switch goes first so a patch that enables a provider and makes it
/// active in one go is judged against the new state; picking a disabled
/// provider as active is refused.
pub(crate) fn apply_provider_switch(
    p: &mut PersistedSettings,
    enabled: Option<&ProviderEnabledPatch>,
    active: Option<ProviderKind>,
) -> Result<(), String> {
    if let Some(pe) = enabled {
        p.settings.providers.entry(pe.provider).or_default().enabled = Some(pe.enabled);
    }
    if let Some(kind) = active {
        ensure_enabled(kind, &p.settings)?;
        p.settings.active_provider = kind;
    }
    Ok(())
}

/// Normalise an operator-typed base URL: empty clears the override, anything
/// else must be a bare `http(s)://host[:port][/path]` — no credentials,
/// query or fragment (the API path is appended to it) — and loses its
/// trailing slashes.
pub(crate) fn validate_base_url(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let url = url::Url::parse(raw).map_err(|e| format!("invalid base URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("base URL must start with http:// or https://".into());
    }
    if url.host_str().is_none() {
        return Err("base URL has no host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("don't put credentials in the base URL — use the API key field".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("base URL can't carry a query string or fragment".into());
    }
    Ok(Some(raw.trim_end_matches('/').to_string()))
}

/// Keep `active_provider` on an enabled provider. When it isn't, move to the
/// first enabled provider that has a credential, else the first enabled one,
/// and drop `default_model` — it names a model of the provider we left.
/// Returns whether anything changed.
pub(crate) fn normalize_active_provider(p: &mut PersistedSettings) -> bool {
    if p.settings.is_provider_enabled(p.settings.active_provider) {
        return false;
    }
    let enabled = || {
        ProviderKind::all()
            .iter()
            .copied()
            .filter(|k| p.settings.is_provider_enabled(*k))
    };
    let next = enabled()
        .find(|k| p.configured_providers.contains(k))
        .or_else(|| enabled().next());
    let Some(next) = next else {
        return false;
    };
    p.settings.active_provider = next;
    p.settings.default_model = None;
    true
}

fn parse_provider_kind(s: &str) -> Option<ProviderKind> {
    serde_json::from_value::<ProviderKind>(serde_json::Value::String(s.to_string())).ok()
}

pub(crate) async fn save_persisted(p: &PersistedSettings) -> std::io::Result<()> {
    let Some(path) = settings_path() else {
        return Ok(());
    };
    let bytes = serde_json::to_vec_pretty(p)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    ferrisscope_agent::atomic_write::atomic_write(&path, &bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_enabled(p: &mut PersistedSettings, kind: ProviderKind, enabled: Option<bool>) {
        p.settings.providers.entry(kind).or_default().enabled = enabled;
    }

    fn rpatch(
        provider: ProviderKind,
        effort: Option<&str>,
        budget: Option<u32>,
    ) -> ProviderReasoningPatch {
        ProviderReasoningPatch {
            provider,
            effort: effort.map(Into::into),
            budget_tokens: budget,
        }
    }

    #[test]
    fn a_reasoning_patch_stores_a_trimmed_effort_and_budget_for_that_provider_only() {
        let mut p = PersistedSettings::default();
        apply_provider_reasoning(&mut p, &rpatch(ProviderKind::OpenAI, Some(" xhigh "), None))
            .unwrap();
        apply_provider_reasoning(&mut p, &rpatch(ProviderKind::Anthropic, None, Some(8192)))
            .unwrap();
        let o = p.settings.effective_reasoning(ProviderKind::OpenAI);
        assert_eq!(
            (o.effort.as_deref(), o.budget_tokens),
            (Some("xhigh"), None)
        );
        let a = p.settings.effective_reasoning(ProviderKind::Anthropic);
        assert_eq!((a.effort, a.budget_tokens), (None, Some(8192)));
        assert!(p
            .settings
            .effective_reasoning(ProviderKind::Groq)
            .is_empty());
    }

    #[test]
    fn an_empty_reasoning_patch_clears_the_provider() {
        let mut p = PersistedSettings::default();
        apply_provider_reasoning(
            &mut p,
            &rpatch(ProviderKind::OpenAI, Some("high"), Some(4096)),
        )
        .unwrap();
        apply_provider_reasoning(&mut p, &rpatch(ProviderKind::OpenAI, Some(""), Some(0))).unwrap();
        assert!(!p
            .settings
            .provider_reasoning
            .contains_key(&ProviderKind::OpenAI));
        assert!(p
            .settings
            .effective_reasoning(ProviderKind::OpenAI)
            .is_empty());
    }

    #[test]
    fn nonsense_efforts_and_budgets_are_refused_without_touching_state() {
        let mut p = PersistedSettings::default();
        for bad in ["High", "high effort", "x".repeat(17).as_str(), "../x", "1x"] {
            let err =
                apply_provider_reasoning(&mut p, &rpatch(ProviderKind::OpenAI, Some(bad), None))
                    .unwrap_err();
            assert!(err.contains("invalid reasoning effort"), "{bad}: {err}");
        }
        let err =
            apply_provider_reasoning(&mut p, &rpatch(ProviderKind::OpenAI, None, Some(5_000_000)))
                .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(p.settings.provider_reasoning.is_empty());
        for ok in ["none", "minimal", "xhigh", "max", "x-high", "level_2"] {
            apply_provider_reasoning(&mut p, &rpatch(ProviderKind::OpenAI, Some(ok), None))
                .unwrap();
        }
    }

    #[test]
    fn the_global_reasoning_setting_moves_to_the_connected_and_active_providers() {
        use ferrisscope_agent::{ReasoningEffort, ReasoningSettings};
        let mut p = PersistedSettings::default();
        p.settings.active_provider = ProviderKind::OpenAI;
        p.configured_providers.insert(ProviderKind::Anthropic);
        p.settings.reasoning = ReasoningSettings {
            effort: Some(ReasoningEffort::Medium),
            budget_tokens: Some(16_384),
        };
        // One provider already chose for itself: that wins.
        p.settings.provider_reasoning.insert(
            ProviderKind::Anthropic,
            ferrisscope_agent::config::ProviderReasoning {
                effort: Some("max".into()),
                budget_tokens: None,
            },
        );
        migrate_global_reasoning(&mut p);
        assert!(p.settings.reasoning.is_empty(), "the global is retired");
        let open = p.settings.provider_reasoning[&ProviderKind::OpenAI].clone();
        assert_eq!(
            (open.effort.as_deref(), open.budget_tokens),
            (Some("medium"), Some(16_384))
        );
        assert_eq!(
            p.settings.provider_reasoning[&ProviderKind::Anthropic]
                .effort
                .as_deref(),
            Some("max")
        );
        // Providers that weren't connected don't get one…
        assert!(!p
            .settings
            .provider_reasoning
            .contains_key(&ProviderKind::Groq));
        // …and running it again changes nothing.
        let once = serde_json::to_string(&p).unwrap();
        migrate_global_reasoning(&mut p);
        assert_eq!(once, serde_json::to_string(&p).unwrap());
    }

    fn switch(provider: ProviderKind, enabled: bool) -> ProviderEnabledPatch {
        ProviderEnabledPatch { provider, enabled }
    }

    #[tokio::test]
    async fn unreadable_settings_file_is_backed_up_before_defaults_take_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_settings.json");
        let corrupt = br#"{ "settings": { "mcp_servers": "not a list" } }"#;
        std::fs::write(&path, corrupt).unwrap();

        let p = load_persisted_at(&path).await;

        assert_eq!(p.settings.active_provider, ProviderKind::default());
        let backup = std::fs::read(dir.path().join("agent_settings.json.bak")).unwrap();
        assert_eq!(backup, corrupt);
    }

    #[tokio::test]
    async fn missing_or_empty_settings_file_loads_defaults_without_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_settings.json");
        let _ = load_persisted_at(&path).await;
        std::fs::write(&path, b"").unwrap();
        let _ = load_persisted_at(&path).await;
        assert!(!dir.path().join("agent_settings.json.bak").exists());
    }

    #[tokio::test]
    async fn legacy_zen_user_stays_enabled_through_a_real_file_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_settings.json");
        std::fs::write(
            &path,
            br#"{ "settings": { "active_provider": "opencode_zen", "default_approval_mode": "approve_per_write" } }"#,
        )
        .unwrap();
        let p = load_persisted_at(&path).await;
        assert!(p.settings.is_provider_enabled(ProviderKind::OpencodeZen));
        assert_eq!(p.settings.active_provider, ProviderKind::OpencodeZen);
    }

    #[test]
    fn base_url_empty_clears_and_trailing_slashes_are_trimmed() {
        assert_eq!(validate_base_url("   "), Ok(None));
        assert_eq!(
            validate_base_url(" https://gw.example.com/v1/// "),
            Ok(Some("https://gw.example.com/v1".to_string()))
        );
        assert_eq!(
            validate_base_url("http://localhost:11434/v1"),
            Ok(Some("http://localhost:11434/v1".to_string()))
        );
    }

    #[test]
    fn base_url_rejects_garbage_schemes_credentials_and_query() {
        for bad in [
            "gw.example.com/v1",
            "ftp://gw.example.com",
            "file:///etc/passwd",
            "https://user:pw@gw.example.com/v1",
            "https://gw.example.com/v1?key=1",
            "https://gw.example.com/v1#frag",
            "https://",
        ] {
            assert!(validate_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn unknown_providers_in_a_newer_settings_file_do_not_wipe_it() {
        let p: PersistedSettings = serde_json::from_str(
            r#"{
                "settings": {
                    "active_provider": "from_the_future",
                    "providers": { "from_the_future": {}, "groq": { "enabled": true } },
                    "default_approval_mode": "approve_per_write",
                    "system_prompt_override": "keep me"
                },
                "plaintext_credentials": { "from_the_future": "{}", "groq": "{}" },
                "configured_providers": ["from_the_future", "groq"]
            }"#,
        )
        .unwrap();
        assert_eq!(
            p.settings.system_prompt_override.as_deref(),
            Some("keep me")
        );
        assert_eq!(p.settings.providers.len(), 1);
        assert_eq!(p.plaintext_credentials.len(), 1);
        assert_eq!(p.configured_providers, HashSet::from([ProviderKind::Groq]));
    }

    #[test]
    fn enabling_and_activating_in_one_patch_succeeds() {
        let mut p = PersistedSettings::default();
        let zen = ProviderKind::OpencodeZen;
        apply_provider_switch(&mut p, Some(&switch(zen, true)), Some(zen)).unwrap();
        assert!(p.settings.is_provider_enabled(zen));
        assert_eq!(p.settings.active_provider, zen);
    }

    #[test]
    fn activating_a_disabled_provider_is_refused_and_leaves_state_alone() {
        let mut p = PersistedSettings::default();
        let err = apply_provider_switch(&mut p, None, Some(ProviderKind::OpencodeZen)).unwrap_err();
        assert!(err.contains("disabled"), "{err}");
        assert_eq!(p.settings.active_provider, ProviderKind::default());
    }

    #[test]
    fn disabling_the_active_provider_then_normalizing_moves_off_it() {
        let mut p = PersistedSettings::default();
        let active = p.settings.active_provider;
        apply_provider_switch(&mut p, Some(&switch(active, false)), None).unwrap();
        assert!(normalize_active_provider(&mut p));
        assert_ne!(p.settings.active_provider, active);
        assert!(p.settings.is_provider_enabled(p.settings.active_provider));
    }

    #[test]
    fn upgrade_keeps_zen_on_when_it_is_the_active_provider() {
        let mut p = PersistedSettings::default();
        p.settings.active_provider = ProviderKind::OpencodeZen;
        migrate_zen_opt_in(&mut p);
        assert!(p.settings.is_provider_enabled(ProviderKind::OpencodeZen));
    }

    #[test]
    fn upgrade_keeps_zen_on_when_a_key_is_stored() {
        let mut p = PersistedSettings::default();
        p.configured_providers.insert(ProviderKind::OpencodeZen);
        migrate_zen_opt_in(&mut p);
        assert!(p.settings.is_provider_enabled(ProviderKind::OpencodeZen));
    }

    #[test]
    fn upgrade_leaves_zen_off_when_unused() {
        let mut p = PersistedSettings::default();
        p.settings.active_provider = ProviderKind::Anthropic;
        migrate_zen_opt_in(&mut p);
        assert!(!p.settings.is_provider_enabled(ProviderKind::OpencodeZen));
        assert!(
            !p.settings
                .providers
                .contains_key(&ProviderKind::OpencodeZen),
            "no entry is created for an unused provider"
        );
    }

    #[test]
    fn migration_never_overrides_an_explicit_choice() {
        let mut p = PersistedSettings::default();
        p.settings.active_provider = ProviderKind::OpencodeZen;
        set_enabled(&mut p, ProviderKind::OpencodeZen, Some(false));
        migrate_zen_opt_in(&mut p);
        assert!(!p.settings.is_provider_enabled(ProviderKind::OpencodeZen));
    }

    #[test]
    fn migration_is_idempotent() {
        let mut p = PersistedSettings::default();
        p.configured_providers.insert(ProviderKind::OpencodeZen);
        migrate_zen_opt_in(&mut p);
        let once = serde_json::to_string(&p).unwrap();
        migrate_zen_opt_in(&mut p);
        assert_eq!(once, serde_json::to_string(&p).unwrap());
    }

    #[test]
    fn disabled_active_provider_moves_to_a_configured_enabled_one() {
        let mut p = PersistedSettings::default();
        p.settings.active_provider = ProviderKind::OpenAI;
        p.settings.default_model = Some("gpt-5".into());
        p.configured_providers.insert(ProviderKind::Anthropic);
        set_enabled(&mut p, ProviderKind::OpenAI, Some(false));
        assert!(normalize_active_provider(&mut p));
        assert_eq!(p.settings.active_provider, ProviderKind::Anthropic);
        assert_eq!(p.settings.default_model, None);
    }

    #[test]
    fn disabled_active_provider_falls_back_to_first_enabled_when_none_configured() {
        let mut p = PersistedSettings::default();
        set_enabled(&mut p, ProviderKind::OpenAI, Some(false));
        assert!(normalize_active_provider(&mut p));
        assert_eq!(p.settings.active_provider, ProviderKind::Anthropic);
    }

    #[test]
    fn disabled_zen_is_never_chosen_as_fallback() {
        let mut p = PersistedSettings::default();
        for kind in ProviderKind::all() {
            if *kind != ProviderKind::OpencodeZen {
                set_enabled(&mut p, *kind, Some(false));
            }
        }
        p.settings.active_provider = ProviderKind::OpenAI;
        // Nothing enabled except default-off Zen: stay put rather than
        // silently switching the operator onto the free tier.
        assert!(!normalize_active_provider(&mut p));
        assert_eq!(p.settings.active_provider, ProviderKind::OpenAI);
    }

    #[test]
    fn enabled_active_provider_is_untouched() {
        let mut p = PersistedSettings::default();
        p.settings.default_model = Some("gpt-5".into());
        assert!(!normalize_active_provider(&mut p));
        assert_eq!(p.settings.default_model.as_deref(), Some("gpt-5"));
    }
}
