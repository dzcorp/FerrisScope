//! `agent::credentials` — see `agent/mod.rs` for the split rationale.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use ferrisscope_agent::provider::openai_codex::CredentialSink;
use ferrisscope_agent::{Credential, ProviderKind};

use crate::secret_storage;

use super::{load_persisted, save_persisted, PersistedSettings};

// ─── Credential cache ───────────────────────────────────────────────────────
//
// The keychain is expensive on macOS: each `get_password` against a real
// item can trigger an ACL prompt. Without caching, every `ai_get_settings`
// (settings page open, AI chat open, provider list re-render) hammers the
// keychain once per provider — historically 11 prompts every time.
//
// We mitigate three ways:
//   1. `CRED_CACHE` — process-singleton in-memory map. Populated on first
//      read, invalidated on write/delete. Subsequent reads skip the keychain.
//   2. `PersistedSettings::configured_providers` — disk-persistent index of
//      which providers have something stored. We never query the keychain
//      for providers absent from the index (would prompt for nothing).
//   3. `KEYCHAIN_AVAILABLE` — caches the cheap probe so we don't re-run it
//      on every settings load.

/// Cache slot semantics:
///   * key absent  → never looked up
///   * `Some(None)`  → looked up, nothing stored
///   * `Some(Some(c))` → looked up, found
fn cred_cache() -> &'static std::sync::Mutex<HashMap<ProviderKind, Option<Credential>>> {
    static CRED_CACHE: OnceLock<std::sync::Mutex<HashMap<ProviderKind, Option<Credential>>>> =
        OnceLock::new();
    CRED_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

// `Option<Option<_>>` is exactly the right shape: outer `None` = never
// looked up; inner `None` = looked up, nothing stored. A custom enum
// would be the same three states under a different name.
#[allow(clippy::option_option)]
fn cache_get(kind: ProviderKind) -> Option<Option<Credential>> {
    cred_cache().lock().ok()?.get(&kind).cloned()
}

fn cache_set(kind: ProviderKind, value: Option<Credential>) {
    if let Ok(mut g) = cred_cache().lock() {
        g.insert(kind, value);
    }
}

/// Cached `secret_storage::is_available()`. The underlying probe is
/// cheap (a `get_password` against a non-existent item, or an `ioreg`
/// lookup for the encrypted-file backend), but there's no reason to
/// re-run it on every settings read.
pub(crate) fn secret_storage_available_cached() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(secret_storage::is_available)
}

/// One-time backfill for installs that predate `configured_providers`.
/// Sweeps every provider, populating both the on-disk index and the
/// in-memory cache from whatever's already in the active secret backend
/// (or the plaintext fallback). After this runs once, subsequent
/// `read_credential` calls only touch storage for providers actually
/// in the index.
///
/// Mutates `p` in place; caller is responsible for `save_persisted`.
async fn backfill_credential_index(p: &mut PersistedSettings) {
    let allow_plaintext = p.settings.allow_plaintext_api_key;
    for kind in ProviderKind::all() {
        let mut found: Option<Credential> = None;
        if let Ok(c) = secret_storage::get_credential(*kind) {
            found = Some(c);
        } else if allow_plaintext {
            if let Some(json) = p.plaintext_credentials.get(kind) {
                if let Ok(c) = serde_json::from_str::<Credential>(json) {
                    found = Some(c);
                }
            }
        }
        if let Some(c) = found {
            p.configured_providers.insert(*kind);
            cache_set(*kind, Some(c));
        } else {
            cache_set(*kind, None);
        }
    }
    p.keychain_index_initialized = true;
}

/// Returns the credential for `kind`, preferring the keychain. Falls back
/// to the plaintext store iff the operator opted in. Returns `None` if
/// neither source has anything.
///
/// Reads go through the in-memory cache and skip storage entirely for
/// providers not in `configured_providers`. This is what keeps macOS
/// quiet: we never `get_password` against a provider the operator has
/// never configured.
pub(crate) async fn read_credential(kind: ProviderKind) -> Option<Credential> {
    if let Some(slot) = cache_get(kind) {
        return slot;
    }

    let mut p = load_persisted().await;

    // Pre-`configured_providers` install: do the one-time sweep so we
    // know which providers have something worth reading.
    if !p.keychain_index_initialized {
        backfill_credential_index(&mut p).await;
        let _ = save_persisted(&p).await;
        // Sweep populated the cache for every provider — re-check.
        if let Some(slot) = cache_get(kind) {
            return slot;
        }
    }

    if !p.configured_providers.contains(&kind) {
        cache_set(kind, None);
        return None;
    }

    let result = match secret_storage::get_credential(kind) {
        Ok(c) => Some(c),
        Err(_) if p.settings.allow_plaintext_api_key => p
            .plaintext_credentials
            .get(&kind)
            .and_then(|json| serde_json::from_str::<Credential>(json).ok()),
        Err(_) => None,
    };
    cache_set(kind, result.clone());
    result
}

/// Effective credential for `kind` — the operator-configured one when
/// set, otherwise the provider's public-fallback key when it has one
/// (OpenCode Zen's free tier). This is what every chat / model-listing
/// path should call: it lets a fresh install hit the free models on
/// first run without forcing the operator through Settings → AI.
pub(crate) async fn effective_credential(kind: ProviderKind) -> Option<Credential> {
    if let Some(c) = read_credential(kind).await {
        return Some(c);
    }
    kind.public_fallback_key().map(|key| Credential::ApiKey {
        key: key.to_string(),
    })
}

pub(crate) async fn write_credential(kind: ProviderKind, cred: &Credential) -> Result<(), String> {
    let mut p = load_persisted().await;
    let mut dirty = false;

    if secret_storage_available_cached() {
        secret_storage::set_credential(kind, cred).map_err(|e| e.to_string())?;
        // If a plaintext copy lingers from a prior plaintext-only
        // setup, drop it so the secret-storage backend stays the
        // single source of truth.
        if p.plaintext_credentials.remove(&kind).is_some() {
            dirty = true;
        }
    } else {
        if !p.settings.allow_plaintext_api_key {
            return Err(
                "no secret storage backend available and plaintext storage is not enabled".into(),
            );
        }
        let json = serde_json::to_string(cred).map_err(|e| e.to_string())?;
        p.plaintext_credentials.insert(kind, json);
        dirty = true;
    }

    if p.configured_providers.insert(kind) {
        dirty = true;
    }
    if !p.keychain_index_initialized {
        // First write also satisfies the migration flag — anything we
        // didn't see during this write isn't ours to claim.
        p.keychain_index_initialized = true;
        dirty = true;
    }
    if dirty {
        save_persisted(&p).await.map_err(|e| e.to_string())?;
    }
    cache_set(kind, Some(cred.clone()));
    Ok(())
}

pub(crate) async fn clear_credential(kind: ProviderKind) -> Result<(), String> {
    let _ = secret_storage::delete_credential(kind);
    let mut p = load_persisted().await;
    let mut dirty = false;
    if p.plaintext_credentials.remove(&kind).is_some() {
        dirty = true;
    }
    if p.configured_providers.remove(&kind) {
        dirty = true;
    }
    if dirty {
        save_persisted(&p).await.map_err(|e| e.to_string())?;
    }
    cache_set(kind, None);
    Ok(())
}

/// Build the credential-rotation sink the OpenAI Codex provider uses to
/// persist refreshed access tokens. The sink is wired up at provider-
/// build time so a refresh during `stream_completion` writes the new
/// token straight to the keychain — the next chat turn picks it up
/// without the operator noticing.
pub(crate) fn make_credential_sink(kind: ProviderKind) -> CredentialSink {
    Arc::new(move |cred: Credential| {
        // Best-effort: log on failure but don't block the in-flight
        // call. The token is still good for the duration of the
        // current request; operator just gets an extra refresh on the
        // next turn if persistence failed.
        let kind = kind;
        tauri::async_runtime::spawn(async move {
            if let Err(e) = write_credential(kind, &cred).await {
                tracing::warn!(?kind, error = %e, "failed to persist refreshed credential");
            }
        });
    })
}
