//! kubectl install helper.
//!
//! Operators on a fresh machine often don't have `kubectl` on `$PATH`.
//! This module manages a copy under `<config>/bin/kubectl[.exe]` so the
//! embedded terminal's `kubectl exec` / `kubectl ...` tabs work out of the
//! box. The terminal already prepends `<config>/bin/` to `$PATH` for child
//! processes, so once a managed kubectl is in place every terminal session
//! resolves it transparently.
//!
//! Source: kubectl's official mirror at `dl.k8s.io`. We:
//!   1. Read `https://dl.k8s.io/release/stable.txt` for the latest stable
//!      version pointer (returns e.g. `v1.32.1`).
//!   2. Download `https://dl.k8s.io/release/<v>/bin/<os>/<arch>/kubectl[.exe]`.
//!   3. Verify against the matching `.sha256` published next to the binary.
//!      Failing the SHA check aborts the install and removes the partial
//!      file — kubectl talks to the operator's clusters with their full
//!      credentials, so silent corruption is not acceptable.
//!
//! Resolution order used by `resolved_path`:
//!   1. operator-configured absolute path (future setting; currently None)
//!   2. managed install at `<config>/bin/kubectl[.exe]`
//!   3. `kubectl` on `$PATH` (caller falls back to OS resolution)

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(not(target_os = "windows"))]
const MANAGED_BINARY_NAME_UNIX: &str = "kubectl";
#[cfg(target_os = "windows")]
const MANAGED_BINARY_NAME_WINDOWS: &str = "kubectl.exe";

const STABLE_TXT: &str = "https://dl.k8s.io/release/stable.txt";

// ─── Public detection / install API ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum KubectlDetection {
    /// Operator pointed at an absolute path in settings (future).
    Configured { path: String, exists: bool },
    /// We installed it under our config dir.
    Managed {
        path: String,
        version: Option<String>,
    },
    /// `kubectl` is reachable on `$PATH`.
    OnPath { path: String },
    /// Nothing found anywhere.
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct KubectlInstallResult {
    pub(crate) path: String,
    pub(crate) version: String,
    pub(crate) asset_url: String,
}

/// Returns the OS-specific path under `<config>/bin/` we will install to.
pub(crate) fn managed_binary_path() -> Option<PathBuf> {
    let dirs = ProjectDirs::from("dev", "ferrisscope", "ferrisscope")?;
    let mut p = dirs.config_dir().to_path_buf();
    p.push("bin");
    #[cfg(target_os = "windows")]
    {
        p.push(MANAGED_BINARY_NAME_WINDOWS);
    }
    #[cfg(not(target_os = "windows"))]
    {
        p.push(MANAGED_BINARY_NAME_UNIX);
    }
    Some(p)
}

/// The directory we install managed third-party binaries into. Exposed so
/// the terminal can prepend it to `$PATH` for child processes.
pub(crate) fn managed_bin_dir() -> Option<PathBuf> {
    let dirs = ProjectDirs::from("dev", "ferrisscope", "ferrisscope")?;
    let mut p = dirs.config_dir().to_path_buf();
    p.push("bin");
    Some(p)
}

/// Best-effort `which` lookup.
fn which_on_path() -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["kubectl.exe"]
    } else {
        &["kubectl"]
    };
    for dir in std::env::split_paths(&path_env) {
        for name in candidates {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Probe the operator's environment. Used by settings to render an
/// Install / Reinstall / Remove triplet, and (in the future) by the agent
/// runtime if we need an absolute path.
pub(crate) fn detect() -> KubectlDetection {
    if let Some(managed) = managed_binary_path() {
        if managed.is_file() {
            return KubectlDetection::Managed {
                path: managed.display().to_string(),
                version: probe_version(&managed),
            };
        }
    }
    if let Some(found) = which_on_path() {
        return KubectlDetection::OnPath {
            path: found.display().to_string(),
        };
    }
    KubectlDetection::Missing
}

/// Run `kubectl version --client -o json` and pull `clientVersion.gitVersion`.
/// Returns None on any failure — this is purely cosmetic for the settings UI,
/// not load-bearing for install logic.
fn probe_version(binary: &Path) -> Option<String> {
    let out = std::process::Command::new(binary)
        .args(["version", "--client", "-o", "json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    #[derive(Deserialize)]
    struct V {
        #[serde(rename = "clientVersion")]
        client: Option<Inner>,
    }
    #[derive(Deserialize)]
    struct Inner {
        #[serde(rename = "gitVersion")]
        git_version: Option<String>,
    }
    let v: V = serde_json::from_slice(&out.stdout).ok()?;
    v.client.and_then(|c| c.git_version)
}

// ─── Install / uninstall ────────────────────────────────────────────────────

/// Download the latest stable kubectl for the host's OS+arch, verify SHA-256,
/// and write to the managed path. Sync IO; caller wraps in `spawn_blocking`.
pub(crate) fn install_latest_blocking() -> Result<KubectlInstallResult, KubectlInstallError> {
    let target = managed_binary_path().ok_or(KubectlInstallError::NoConfigDir)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(KubectlInstallError::Io)?;
    }

    let version = fetch_stable_version()?;
    let os = host_os().ok_or_else(|| KubectlInstallError::Unsupported {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    })?;
    let arch = host_arch().ok_or_else(|| KubectlInstallError::Unsupported {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    })?;
    let binary_name = if cfg!(target_os = "windows") {
        "kubectl.exe"
    } else {
        "kubectl"
    };
    let binary_url = format!("https://dl.k8s.io/release/{version}/bin/{os}/{arch}/{binary_name}");
    let sha_url = format!("{binary_url}.sha256");

    // Pull the expected SHA first — fail fast on a transient mirror outage
    // before downloading the (much larger) binary.
    let expected_sha = http_get_text(&sha_url, false)?.trim().to_ascii_lowercase();
    if expected_sha.len() != 64 || !expected_sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(KubectlInstallError::ChecksumFormat {
            url: sha_url,
            got: expected_sha,
        });
    }

    let tmp = target.with_extension("download");
    download_to(&binary_url, &tmp)?;

    let actual_sha = sha256_of_file(&tmp).map_err(KubectlInstallError::Io)?;
    if actual_sha != expected_sha {
        let _ = fs::remove_file(&tmp);
        return Err(KubectlInstallError::ChecksumMismatch {
            expected: expected_sha,
            actual: actual_sha,
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)
            .map_err(KubectlInstallError::Io)?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&tmp, perms).map_err(KubectlInstallError::Io)?;
    }

    let _ = fs::remove_file(&target);
    fs::rename(&tmp, &target).map_err(KubectlInstallError::Io)?;

    Ok(KubectlInstallResult {
        path: target.display().to_string(),
        version,
        asset_url: binary_url,
    })
}

/// Remove the managed binary. Idempotent.
pub(crate) fn uninstall_managed() -> Result<(), KubectlInstallError> {
    let Some(target) = managed_binary_path() else {
        return Ok(());
    };
    match fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(KubectlInstallError::Io(e)),
    }
}

// ─── HTTP / version selection ───────────────────────────────────────────────

fn fetch_stable_version() -> Result<String, KubectlInstallError> {
    let body = http_get_text(STABLE_TXT, false)?;
    let v = body.trim().to_string();
    // Sanity-check shape: e.g. `v1.32.1`. Strict enough to catch a wrong
    // mirror (HTML page) without rejecting future minor bumps.
    if !v.starts_with('v') || v.len() < 4 || v.len() > 24 {
        return Err(KubectlInstallError::VersionFormat { got: v });
    }
    Ok(v)
}

fn host_os() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        // kubectl uses `darwin`, not `macos`.
        Some("darwin")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else {
        None
    }
}

fn host_arch() -> Option<&'static str> {
    if cfg!(target_arch = "x86_64") {
        Some("amd64")
    } else if cfg!(target_arch = "aarch64") {
        Some("arm64")
    } else {
        None
    }
}

fn download_to(url: &str, path: &Path) -> Result<(), KubectlInstallError> {
    let mut response = http_get_reader(url)?;
    let mut out = File::create(path).map_err(KubectlInstallError::Io)?;
    io::copy(&mut response, &mut out).map_err(KubectlInstallError::Io)?;
    Ok(())
}

fn sha256_of_file(path: &Path) -> io::Result<String> {
    use std::io::Read;
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut hex, "{byte:02x}").expect("writing to String never fails");
    }
    Ok(hex)
}

fn http_get_text(url: &str, _json: bool) -> Result<String, KubectlInstallError> {
    let mut reader = http_get_reader(url)?;
    let mut body = String::new();
    use std::io::Read;
    reader
        .read_to_string(&mut body)
        .map_err(KubectlInstallError::Io)?;
    Ok(body)
}

fn http_get_reader(url: &str) -> Result<Box<dyn io::Read>, KubectlInstallError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into();
    let request = agent
        .get(url)
        .header("User-Agent", "ferrisscope-kubectl-installer");
    let response = match request.call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => {
            return Err(KubectlInstallError::Http {
                code,
                body: String::new(),
            });
        }
        Err(other) => return Err(KubectlInstallError::Transport(other.to_string())),
    };
    let (_, body) = response.into_parts();
    Ok(Box::new(body.into_reader()))
}

// ─── Errors ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub(crate) enum KubectlInstallError {
    NoConfigDir,
    Unsupported { os: String, arch: String },
    Io(io::Error),
    Http { code: u16, body: String },
    Transport(String),
    VersionFormat { got: String },
    ChecksumFormat { url: String, got: String },
    ChecksumMismatch { expected: String, actual: String },
}

impl std::fmt::Display for KubectlInstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoConfigDir => f.write_str("could not resolve config directory"),
            Self::Unsupported { os, arch } => {
                write!(f, "kubectl install not supported on {os}/{arch}")
            }
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Http { code, body } => write!(f, "HTTP {code}: {body}"),
            Self::Transport(s) => write!(f, "network: {s}"),
            Self::VersionFormat { got } => {
                write!(f, "unexpected stable.txt content: {got:?}")
            }
            Self::ChecksumFormat { url, got } => {
                write!(f, "unexpected sha256 content from {url}: {got:?}")
            }
            Self::ChecksumMismatch { expected, actual } => {
                write!(
                    f,
                    "kubectl SHA-256 mismatch — expected {expected}, got {actual}. \
                     The download was discarded; try again."
                )
            }
        }
    }
}

impl std::error::Error for KubectlInstallError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}
