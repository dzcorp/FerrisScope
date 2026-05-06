//! Per-provider credential storage. Uses the OS keychain (`secret-service`
//! on Linux, Keychain on macOS, Credential Manager on Windows) via the
//! `keyring` crate. Each provider gets its own entry under the same
//! service name; the password slot holds a JSON-serialised
//! [`ferrisscope_agent::Credential`] (the same shape opencode uses in
//! its `auth.json`, so an operator could in principle copy values
//! between tools by hand).
//!
//! When the keychain backend is unavailable on the host, callers can opt
//! in (via `AgentSettings::allow_plaintext_api_key`) to a plaintext
//! fallback in `prefs.json`. The fallback is keyed by provider too —
//! see `agent.rs` for the `plaintext_credentials` map.

use ferrisscope_agent::{provider::meta, Credential, ProviderKind};

const SERVICE: &str = "ferrisscope";

#[derive(Debug)]
pub(crate) enum KeyringError {
    Unavailable(String),
    NotFound,
    Other(String),
}

impl std::fmt::Display for KeyringError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(s) => write!(f, "keyring backend unavailable: {s}"),
            Self::NotFound => write!(f, "keyring entry not found"),
            Self::Other(s) => write!(f, "keyring backend error: {s}"),
        }
    }
}

impl std::error::Error for KeyringError {}

fn account_for(kind: ProviderKind) -> &'static str {
    meta::for_kind(kind).id
}

fn entry(kind: ProviderKind) -> Result<keyring::Entry, KeyringError> {
    keyring::Entry::new(SERVICE, account_for(kind)).map_err(|e| match e {
        keyring::Error::PlatformFailure(err) => KeyringError::Unavailable(err.to_string()),
        other => KeyringError::Other(other.to_string()),
    })
}

pub(crate) fn get_credential(kind: ProviderKind) -> Result<Credential, KeyringError> {
    let e = entry(kind)?;
    match e.get_password() {
        Ok(s) => decode_credential(&s, kind).map_err(KeyringError::Other),
        Err(keyring::Error::NoEntry) => Err(KeyringError::NotFound),
        Err(keyring::Error::PlatformFailure(err)) => {
            Err(KeyringError::Unavailable(err.to_string()))
        }
        Err(other) => Err(KeyringError::Other(other.to_string())),
    }
}

pub(crate) fn set_credential(kind: ProviderKind, value: &Credential) -> Result<(), KeyringError> {
    let e = entry(kind)?;
    let json = serde_json::to_string(value).map_err(|err| KeyringError::Other(err.to_string()))?;
    e.set_password(&json).map_err(|err| match err {
        keyring::Error::PlatformFailure(err) => KeyringError::Unavailable(err.to_string()),
        other => KeyringError::Other(other.to_string()),
    })
}

pub(crate) fn delete_credential(kind: ProviderKind) -> Result<(), KeyringError> {
    let e = entry(kind)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(keyring::Error::PlatformFailure(err)) => {
            Err(KeyringError::Unavailable(err.to_string()))
        }
        Err(other) => Err(KeyringError::Other(other.to_string())),
    }
}

/// Decode a raw keychain string into a `Credential`. Accepts both the
/// modern JSON shape AND a legacy "bare API key" string — the latter is
/// what pre-multi-provider FerrisScope versions wrote into the keychain
/// (under the single `openrouter` account). Migrating users see their
/// OpenRouter credential preserved without re-entry.
fn decode_credential(raw: &str, kind: ProviderKind) -> Result<Credential, String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        serde_json::from_str::<Credential>(trimmed).map_err(|e| e.to_string())
    } else if trimmed.is_empty() {
        Err("empty credential".into())
    } else {
        // Legacy: was a bare API key. Wrap it. Logging at debug only —
        // this is a one-time per-key event on first read after upgrade.
        tracing::debug!(provider = ?kind, "migrating legacy bare-key credential to JSON");
        Ok(Credential::ApiKey {
            key: trimmed.to_string(),
        })
    }
}

/// Convenience: `Ok(true)` if the keyring backend is reachable on this
/// platform. Used by the settings page to show the plaintext-fallback
/// toggle only when keychain access genuinely failed.
pub(crate) fn is_available() -> bool {
    // Cheap probe: try to construct an entry. The `keyring` crate doesn't
    // attempt to talk to the backend until you call `get/set/delete`, so
    // we issue a `get_password()` against a dummy service+account and
    // accept `NoEntry` as "available".
    match keyring::Entry::new(SERVICE, "_probe_") {
        Ok(e) => match e.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => true,
            Err(_) => false,
        },
        Err(_) => false,
    }
}
