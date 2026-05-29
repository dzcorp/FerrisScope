//! `agent::settings` — see `agent/mod.rs` for the split rationale.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use directories::ProjectDirs;
use ferrisscope_agent::{AgentSettings, Credential, ProviderConfig, ProviderKind};
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
    #[serde(default)]
    pub(crate) plaintext_credentials: HashMap<ProviderKind, String>,
    /// Index of providers known to have a stored credential (keychain or
    /// plaintext). Index only — no secrets. Lets us skip the keychain on
    /// providers that have nothing stored, which matters on macOS where
    /// each `get_password` against a real item triggers an ACL prompt.
    #[serde(default)]
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
    let bytes = match tokio::fs::read(&path).await {
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
                // Default handling on the new struct keeps `active_provider`
                // at OpenRouter and leaves `providers` empty — preserve
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
                            p.settings
                                .providers
                                .entry(kind)
                                .or_insert(ProviderConfig { base_url });
                        }
                    }
                }
            }
            p
        }
        Err(e) => {
            tracing::warn!(error = %e, "agent_settings.json: falling back to default");
            PersistedSettings::default()
        }
    }
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
