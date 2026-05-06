//! User-managed kubeconfig sources (files, folders, and remote SSH hosts).
//!
//! The default kubeconfig (KUBECONFIG env / ~/.kube/config) is implicit and
//! always considered. This module persists *additional* sources the user has
//! pointed us at:
//!
//!   * `File`   — a single kubeconfig.
//!   * `Folder` — flat-scanned directory.
//!   * `Ssh`    — a remote Linux host we SSH into, fetch its kubeconfig from,
//!     and tunnel the apiserver through.
//!
//! Persistence is a single hand-rolled JSON file at
//! `<config-dir>/sources.json`. On Linux that's `~/.config/ferrisscope/`.
//!
//! **Secrets never land in this file.** Passwords and key passphrases live in
//! the OS keychain via the `keyring` crate; `SshAuth` only stores opaque
//! references that point at those entries. Removing a source must also delete
//! the matching keychain entries (see `delete_source_secrets`).

use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::fs;
use uuid::Uuid;

/// `keyring` service name. One namespace under which every per-source secret
/// is stored; the `account` slot keys to the source uuid + secret kind.
pub const KEYRING_SERVICE: &str = "ferrisscope";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    File,
    Folder,
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthKind {
    Password,
    PrivateKey,
    Agent,
    DefaultKeys,
}

/// SSH authentication descriptor.
///
/// Only non-secret fields are persisted. The actual password / passphrase
/// lives in the keychain under `(KEYRING_SERVICE, "<source-id>:password")`
/// or `(KEYRING_SERVICE, "<source-id>:key-passphrase")`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuth {
    /// Password auth. The actual password is stored under
    /// `(KEYRING_SERVICE, "<source-id>:password")`.
    Password,
    /// Public-key auth. `path` is the **local** filesystem path of the
    /// private key (e.g. `~/.ssh/id_ed25519`). If the key is encrypted, the
    /// passphrase is stored under
    /// `(KEYRING_SERVICE, "<source-id>:key-passphrase")` and
    /// `has_passphrase` is `true`.
    PrivateKey {
        path: PathBuf,
        #[serde(default)]
        has_passphrase: bool,
    },
    /// Hand off to the running ssh-agent (`SSH_AUTH_SOCK`). No secrets.
    Agent,
    /// Try the standard private-key locations in `~/.ssh/` in order:
    /// `id_ed25519`, `id_ecdsa`, `id_rsa`. The first one that authenticates
    /// wins. Encrypted keys are skipped (we don't have a passphrase here);
    /// for those use the explicit `PrivateKey` variant or `Agent`.
    DefaultKeys,
}

impl SshAuth {
    pub fn auth_kind(&self) -> SshAuthKind {
        match self {
            SshAuth::Password => SshAuthKind::Password,
            SshAuth::PrivateKey { .. } => SshAuthKind::PrivateKey,
            SshAuth::Agent => SshAuthKind::Agent,
            SshAuth::DefaultKeys => SshAuthKind::DefaultKeys,
        }
    }
}

/// Per-source SSH config. `host` may be an IP or DNS name; the rewritten
/// kubeconfig's `tls-server-name` always carries the *original* server name
/// from the remote kubeconfig (unrelated to this `host`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshSourceConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// Manual override for the remote kubeconfig path. `None` means "auto
    /// detect": probe `$KUBECONFIG` via a login shell, fall back to
    /// `$HOME/.kube/config`.
    #[serde(default)]
    pub remote_kubeconfig: Option<String>,
    /// Pinned host fingerprint (TOFU). Format is `sha256:<base64>` matching
    /// what `ssh-keyscan -t ed25519 host | ssh-keygen -lf -` prints. Set on
    /// first successful connect; subsequent connects fail-hard on mismatch.
    #[serde(default)]
    pub known_host_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KubeconfigSource {
    pub id: String,
    /// File path for `File` / `Folder`. For `Ssh`, this is the *local*
    /// display label (e.g. `user@host:port`); the real connection details
    /// live in `ssh`. Kept as a path so existing UI rows that just print
    /// `src.path` keep rendering something useful for SSH sources too.
    pub path: PathBuf,
    pub kind: SourceKind,
    /// Operator-supplied group name. `None` falls back to: folder basename
    /// for a Folder source, the literal "Custom" for a File source, or
    /// `host` for an SSH source.
    pub group_override: Option<String>,
    pub enabled: bool,
    /// Populated iff `kind == Ssh`. Absent for file / folder sources so old
    /// JSON files keep deserialising.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshSourceConfig>,
}

impl KubeconfigSource {
    pub fn effective_group(&self) -> String {
        if let Some(g) = self.group_override.as_ref() {
            return g.clone();
        }
        match self.kind {
            SourceKind::Folder => self
                .path
                .file_name()
                .and_then(|s| s.to_str())
                .map_or_else(|| "Folder".to_owned(), str::to_owned),
            SourceKind::File => "Custom".to_owned(),
            SourceKind::Ssh => self
                .ssh
                .as_ref()
                .map_or_else(|| "SSH".to_owned(), |c| c.host.clone()),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourcesFile {
    #[serde(default)]
    pub default_disabled: bool,
    #[serde(default)]
    pub last_picked_dir: Option<PathBuf>,
    #[serde(default)]
    pub sources: Vec<KubeconfigSource>,
}

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("sources.json"))
}

pub async fn load() -> SourcesFile {
    let Some(path) = config_path() else {
        return SourcesFile::default();
    };
    let data = match fs::read_to_string(&path).await {
        Ok(d) => d,
        Err(_) => return SourcesFile::default(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

pub async fn save(file: &SourcesFile) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let data = serde_json::to_string_pretty(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(&path, data).await?;
    Ok(())
}

pub fn new_source(path: impl AsRef<Path>) -> std::io::Result<KubeconfigSource> {
    let path = path.as_ref().to_path_buf();
    let meta = std::fs::metadata(&path)?;
    let kind = if meta.is_dir() {
        SourceKind::Folder
    } else {
        SourceKind::File
    };
    Ok(KubeconfigSource {
        id: Uuid::new_v4().to_string(),
        path,
        kind,
        group_override: None,
        enabled: true,
        ssh: None,
    })
}

/// Construct a fresh SSH source. Caller is expected to write the password /
/// passphrase to the keychain *before* persisting if `auth` references one
/// (so the source isn't saved with a dangling keychain ref).
pub fn new_ssh_source(cfg: SshSourceConfig) -> KubeconfigSource {
    let label = format!("{}@{}:{}", cfg.user, cfg.host, cfg.port);
    KubeconfigSource {
        id: Uuid::new_v4().to_string(),
        path: PathBuf::from(label),
        kind: SourceKind::Ssh,
        group_override: None,
        enabled: true,
        ssh: Some(cfg),
    }
}

/// Keychain account slot for a given source's password. Stable so updates
/// overwrite the same entry instead of leaking a new one each time.
pub fn keyring_account_password(source_id: &str) -> String {
    format!("{source_id}:password")
}

/// Keychain account slot for a private-key passphrase.
pub fn keyring_account_key_passphrase(source_id: &str) -> String {
    format!("{source_id}:key-passphrase")
}

/// Best-effort: drop every keychain entry that might belong to `source_id`.
/// Called when the source is removed. Errors are logged, not propagated —
/// a stuck keychain entry is annoying but not data-loss.
pub fn delete_source_secrets(source_id: &str) {
    for account in [
        keyring_account_password(source_id),
        keyring_account_key_passphrase(source_id),
    ] {
        match keyring::Entry::new(KEYRING_SERVICE, &account) {
            Ok(entry) => {
                if let Err(e) = entry.delete_credential() {
                    // `NoEntry` is the common case (we tried to delete a
                    // ref that was never set, e.g. for an Agent-auth source).
                    tracing::debug!(
                        source_id,
                        account,
                        error = %e,
                        "keychain delete: entry absent or unreachable"
                    );
                }
            }
            Err(e) => tracing::warn!(
                source_id,
                account,
                error = %e,
                "keychain handle: open failed"
            ),
        }
    }
}
