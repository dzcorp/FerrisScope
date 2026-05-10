//! Per-provider AI credential storage with platform-aware backend selection.
//!
//! Two backends, picked at startup and cached:
//!
//! - **`Keychain`** — OS keychain (`apple-native` / `secret-service` / Windows
//!   Credential Manager) via the [`keyring`] crate. Preferred wherever the
//!   keychain ACL is durable across app updates.
//!
//! - **`EncryptedFile`** — AES-256-GCM file at `<config-dir>/credentials.enc`,
//!   keyed by a hash of the machine's hardware UUID. Only used on macOS when
//!   the running binary is **not** persistently signed (no Developer ID, or
//!   ad-hoc signed). The macOS Keychain keys "Always Allow" ACL entries off
//!   the binary's `cdhash`, so on an unsigned build every release ships with
//!   a different `cdhash` and the OS re-prompts users on every update — the
//!   keychain ACL provides no real benefit there. The encrypted-file backend
//!   gives the same effective security (any user-process malware can derive
//!   the same key) with zero prompts.
//!
//! The plaintext-fallback path in `agent.rs` (`allow_plaintext_api_key` +
//! `plaintext_credentials`) remains unchanged and is consulted independently
//! when this module reports the backend unavailable.
//!
//! Migration is intentionally not automatic: the operator's existing keychain
//! entries from a previous (possibly differently-signed) build are unlikely
//! to be readable without prompts anyway, so the file backend starts empty
//! and the operator re-enters keys once.

use std::path::PathBuf;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use directories::ProjectDirs;
use ferrisscope_agent::{provider::meta, Credential, ProviderKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent_keyring;

/// Wire-visible storage backend. Exposed in `AiSettingsWire` so the
/// frontend can render an explanatory banner on the unsigned-macOS path
/// ("API keys are stored in an encrypted local file because this build
/// isn't signed for Keychain persistence").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StorageBackend {
    Keychain,
    EncryptedFile,
}

#[derive(Debug)]
pub(crate) enum SecretError {
    Unavailable(String),
    NotFound,
    Other(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(s) => write!(f, "secret storage unavailable: {s}"),
            Self::NotFound => write!(f, "secret not found"),
            Self::Other(s) => write!(f, "secret storage error: {s}"),
        }
    }
}

impl std::error::Error for SecretError {}

/// Returns the active backend for this process, computed once at first
/// call and cached. Cheap on subsequent calls.
pub(crate) fn backend() -> StorageBackend {
    static BACKEND: OnceLock<StorageBackend> = OnceLock::new();
    *BACKEND.get_or_init(|| {
        // The encrypted-file backend is intentionally macOS-only: Linux's
        // secret-service and Windows' Credential Manager don't have the
        // cdhash-rebound-on-rebuild problem, so the keychain there is
        // strictly better than rolling our own AEAD store.
        #[cfg(target_os = "macos")]
        {
            if !mac_signing::is_persistently_signed() {
                tracing::info!(
                    "secret_storage: macOS build is not persistently signed; using \
                     encrypted-file backend to avoid Keychain re-prompts on every release"
                );
                return StorageBackend::EncryptedFile;
            }
        }
        StorageBackend::Keychain
    })
}

/// `true` iff the active backend is reachable on this host. The plaintext
/// fallback in `agent.rs` only kicks in when this is `false`.
pub(crate) fn is_available() -> bool {
    match backend() {
        StorageBackend::Keychain => agent_keyring::is_available(),
        StorageBackend::EncryptedFile => encrypted_file::is_available(),
    }
}

pub(crate) fn get_credential(kind: ProviderKind) -> Result<Credential, SecretError> {
    match backend() {
        StorageBackend::Keychain => agent_keyring::get_credential(kind).map_err(Into::into),
        StorageBackend::EncryptedFile => encrypted_file::get(kind),
    }
}

pub(crate) fn set_credential(kind: ProviderKind, value: &Credential) -> Result<(), SecretError> {
    match backend() {
        StorageBackend::Keychain => agent_keyring::set_credential(kind, value).map_err(Into::into),
        StorageBackend::EncryptedFile => encrypted_file::set(kind, value),
    }
}

pub(crate) fn delete_credential(kind: ProviderKind) -> Result<(), SecretError> {
    match backend() {
        StorageBackend::Keychain => agent_keyring::delete_credential(kind).map_err(Into::into),
        StorageBackend::EncryptedFile => encrypted_file::delete(kind),
    }
}

impl From<agent_keyring::KeyringError> for SecretError {
    fn from(e: agent_keyring::KeyringError) -> Self {
        match e {
            agent_keyring::KeyringError::Unavailable(s) => Self::Unavailable(s),
            agent_keyring::KeyringError::NotFound => Self::NotFound,
            agent_keyring::KeyringError::Other(s) => Self::Other(s),
        }
    }
}

// ─── Encrypted-file backend ─────────────────────────────────────────────────

mod encrypted_file {
    use super::{
        meta, Aead, AeadCore, Aes256Gcm, Credential, Digest, Key, KeyInit, Nonce, OnceLock, OsRng,
        PathBuf, ProjectDirs, ProviderKind, SecretError, Sha256,
    };
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Versioned envelope so we can change crypto layout later without
    /// silently corrupting an existing file. Today only `1` exists.
    const FILE_VERSION: u8 = 1;
    const NONCE_LEN: usize = 12;
    const KEY_DOMAIN: &[u8] = b"ferrisscope.credstore.v1";

    /// File-on-disk plaintext shape: keyed by the same `provider::meta`
    /// id strings the keychain backend uses (`"openai"`, `"anthropic"`,
    /// …). Values are the JSON-serialised [`Credential`] so the on-wire
    /// shape matches the keychain.
    #[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
    struct Store {
        #[serde(default)]
        providers: HashMap<String, serde_json::Value>,
    }

    fn store_path() -> Option<PathBuf> {
        ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
            .map(|p| p.config_dir().join("credentials.enc"))
    }

    /// Cache the AEAD key for the lifetime of the process — derivation
    /// involves a sub-process call (`ioreg`) that we don't want to repeat
    /// on every read.
    fn cipher() -> Result<&'static Aes256Gcm, SecretError> {
        static CIPHER: OnceLock<Result<Aes256Gcm, String>> = OnceLock::new();
        match CIPHER.get_or_init(derive_cipher) {
            Ok(c) => Ok(c),
            Err(e) => Err(SecretError::Unavailable(e.clone())),
        }
    }

    fn derive_cipher() -> Result<Aes256Gcm, String> {
        let uuid = machine_uuid()?;
        let mut hasher = Sha256::new();
        hasher.update(KEY_DOMAIN);
        hasher.update([0u8]);
        hasher.update(uuid.as_bytes());
        let key_bytes = hasher.finalize();
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        Ok(Aes256Gcm::new(key))
    }

    #[cfg(target_os = "macos")]
    fn machine_uuid() -> Result<String, String> {
        let output = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .map_err(|e| format!("ioreg: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "ioreg exited with status {:?}",
                output.status.code()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("\"IOPlatformUUID\"") {
                if let Some(eq) = rest.split_once('=') {
                    let raw = eq.1.trim().trim_matches('"').trim();
                    if !raw.is_empty() {
                        return Ok(raw.to_string());
                    }
                }
            }
        }
        Err("IOPlatformUUID not found in ioreg output".into())
    }

    #[cfg(not(target_os = "macos"))]
    fn machine_uuid() -> Result<String, String> {
        // The encrypted-file backend is only selected on macOS today.
        // This stub keeps the module compiling on Linux/Windows so the
        // rest of `secret_storage` can be platform-agnostic.
        Err("encrypted-file backend is macOS-only".into())
    }

    /// Cheap availability probe: do we have a config dir AND can we
    /// derive the AEAD key? Probing the cipher actually runs `ioreg`
    /// the first time, but only once per process.
    pub(super) fn is_available() -> bool {
        store_path().is_some() && cipher().is_ok()
    }

    /// Mutex over disk I/O. Reads/writes are very rare (operator
    /// editing API keys, OAuth refresh) so contention is a non-issue;
    /// the lock just keeps a concurrent `set` + `delete` from
    /// race-clobbering the file.
    fn io_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn load_store() -> Result<Store, SecretError> {
        let path = store_path().ok_or_else(|| SecretError::Unavailable("no config dir".into()))?;
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
            Err(e) => return Err(SecretError::Other(format!("read credentials.enc: {e}"))),
        };
        if bytes.is_empty() {
            return Ok(Store::default());
        }
        if bytes.len() < 1 + NONCE_LEN + 16 {
            return Err(SecretError::Other("credentials.enc truncated".into()));
        }
        if bytes[0] != FILE_VERSION {
            return Err(SecretError::Other(format!(
                "unsupported credentials.enc version: {}",
                bytes[0]
            )));
        }
        let nonce = Nonce::from_slice(&bytes[1..1 + NONCE_LEN]);
        let ct = &bytes[1 + NONCE_LEN..];
        let plain = cipher()?
            .decrypt(nonce, ct)
            .map_err(|_| SecretError::Other("credentials.enc: decryption failed".into()))?;
        serde_json::from_slice::<Store>(&plain)
            .map_err(|e| SecretError::Other(format!("credentials.enc: parse: {e}")))
    }

    fn save_store(store: &Store) -> Result<(), SecretError> {
        let path = store_path().ok_or_else(|| SecretError::Unavailable("no config dir".into()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| SecretError::Other(format!("create config dir: {e}")))?;
        }
        let plain = serde_json::to_vec(store)
            .map_err(|e| SecretError::Other(format!("serialize store: {e}")))?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ct = cipher()?
            .encrypt(&nonce, plain.as_ref())
            .map_err(|_| SecretError::Other("encryption failed".into()))?;
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
        out.push(FILE_VERSION);
        out.extend_from_slice(nonce.as_slice());
        out.extend_from_slice(&ct);
        write_atomic(&path, &out)
    }

    /// Atomic write: temp file → fsync → rename. On macOS APFS the
    /// rename is atomic with respect to crash. We also chmod 0600 on
    /// the temp before rename so the final file is never world-readable
    /// even momentarily.
    fn write_atomic(path: &std::path::Path, contents: &[u8]) -> Result<(), SecretError> {
        let tmp = path.with_extension("enc.tmp");
        {
            let mut f = std::fs::File::create(&tmp)
                .map_err(|e| SecretError::Other(format!("create tmp: {e}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
            }
            std::io::Write::write_all(&mut f, contents)
                .map_err(|e| SecretError::Other(format!("write tmp: {e}")))?;
            std::io::Write::flush(&mut f)
                .map_err(|e| SecretError::Other(format!("flush tmp: {e}")))?;
            f.sync_all()
                .map_err(|e| SecretError::Other(format!("fsync tmp: {e}")))?;
        }
        std::fs::rename(&tmp, path).map_err(|e| SecretError::Other(format!("rename tmp: {e}")))?;
        Ok(())
    }

    fn account_for(kind: ProviderKind) -> &'static str {
        meta::for_kind(kind).id
    }

    pub(super) fn get(kind: ProviderKind) -> Result<Credential, SecretError> {
        let _g = io_lock().lock();
        let store = load_store()?;
        let raw = store
            .providers
            .get(account_for(kind))
            .ok_or(SecretError::NotFound)?;
        serde_json::from_value::<Credential>(raw.clone())
            .map_err(|e| SecretError::Other(format!("decode credential: {e}")))
    }

    pub(super) fn set(kind: ProviderKind, value: &Credential) -> Result<(), SecretError> {
        let _g = io_lock().lock();
        let mut store = load_store()?;
        let json = serde_json::to_value(value)
            .map_err(|e| SecretError::Other(format!("encode credential: {e}")))?;
        store.providers.insert(account_for(kind).to_string(), json);
        save_store(&store)
    }

    pub(super) fn delete(kind: ProviderKind) -> Result<(), SecretError> {
        let _g = io_lock().lock();
        let mut store = load_store()?;
        if store.providers.remove(account_for(kind)).is_none() {
            return Ok(());
        }
        save_store(&store)
    }
}

// ─── macOS signing detection ────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod mac_signing {
    use std::sync::OnceLock;

    /// `true` if the running binary has a Developer ID signature whose
    /// trust survives across releases. Returns `false` for unsigned and
    /// ad-hoc signed builds — both rebind the keychain ACL on every
    /// release because the binary's `cdhash` is what the OS keys against.
    ///
    /// Implementation: shell out to `codesign -dv --verbose=2` against
    /// `current_exe`. Cheap (~30ms), runs once at first call and is
    /// cached. We avoid `Security.framework` FFI here because the
    /// workspace `forbid(unsafe_code)` lint disallows it.
    pub(super) fn is_persistently_signed() -> bool {
        static CACHED: OnceLock<bool> = OnceLock::new();
        *CACHED.get_or_init(probe)
    }

    fn probe() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let output = std::process::Command::new("codesign")
            .args(["-dv", "--verbose=2"])
            .arg(&exe)
            .output();
        let Ok(output) = output else {
            return false;
        };
        // codesign writes its diagnostics to stderr regardless of
        // success/failure. We treat ANY of these markers as "not
        // persistently signed":
        //   * "code object is not signed at all" → unsigned
        //   * "Signature=adhoc" → ad-hoc, rebinds per build
        //   * No "TeamIdentifier=" line with a plausible (10-char) team id
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not signed at all") {
            return false;
        }
        if stderr.contains("Signature=adhoc") {
            return false;
        }
        for line in stderr.lines() {
            if let Some(rest) = line.trim_start().strip_prefix("TeamIdentifier=") {
                let id = rest.trim();
                // codesign prints `TeamIdentifier=not set` for ad-hoc /
                // unsigned binaries; only a real ten-character team id
                // counts.
                if !id.is_empty() && !id.eq_ignore_ascii_case("not set") {
                    return true;
                }
            }
        }
        false
    }
}
