//! Helm install helper.
//!
//! Operators on a fresh machine (most commonly macOS, where GUI apps don't
//! inherit the shell's `PATH` and `brew install helm` lives in
//! `/opt/homebrew/bin`) often don't have `helm` resolvable to the
//! FerrisScope process. This module manages a copy under
//! `<config>/bin/helm[.exe]`. Combined with the macOS PATH augmentation in
//! `main.rs::augment_macos_path` (which prepends the managed-bin dir to
//! `$PATH`), every later `Command::new("helm")` resolves transparently.
//!
//! Source: helm's official archive mirror at `get.helm.sh`. We:
//!   1. Read `https://get.helm.sh/helm-latest-version` for the latest stable
//!      version pointer (returns e.g. `v3.18.0`).
//!   2. Download `https://get.helm.sh/helm-v<X>-<os>-<arch>.tar.gz`.
//!   3. Verify against the matching `.sha256sum` published next to it. The
//!      sha256sum file's first whitespace-separated field is the digest.
//!      Failing the SHA check aborts the install and removes the partial
//!      download — helm runs against the operator's clusters with full
//!      credentials, so silent corruption is not acceptable.
//!   4. Extract `<os>-<arch>/helm` from the tarball into
//!      `<config>/bin/helm[.exe]`.
//!
//! Resolution order used by `detect`:
//!   1. operator-configured absolute path (future setting; currently None)
//!   2. managed install at `<config>/bin/helm[.exe]`
//!   3. `helm` on `$PATH` (caller falls back to OS resolution)

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(not(target_os = "windows"))]
const MANAGED_BINARY_NAME_UNIX: &str = "helm";
#[cfg(target_os = "windows")]
const MANAGED_BINARY_NAME_WINDOWS: &str = "helm.exe";

const LATEST_VERSION_URL: &str = "https://get.helm.sh/helm-latest-version";

// ─── Public detection / install API ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum HelmDetection {
    /// Operator pointed at an absolute path in settings (future).
    Configured { path: String, exists: bool },
    /// We installed it under our config dir.
    Managed {
        path: String,
        version: Option<String>,
    },
    /// `helm` is reachable on `$PATH`.
    OnPath { path: String },
    /// Nothing found anywhere.
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HelmManagedInstallResult {
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

/// Best-effort `which` lookup.
fn which_on_path() -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["helm.exe"]
    } else {
        &["helm"]
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
/// Install / Reinstall / Remove triplet.
pub(crate) fn detect() -> HelmDetection {
    if let Some(managed) = managed_binary_path() {
        if managed.is_file() {
            return HelmDetection::Managed {
                path: managed.display().to_string(),
                version: probe_version(&managed),
            };
        }
    }
    if let Some(found) = which_on_path() {
        return HelmDetection::OnPath {
            path: found.display().to_string(),
        };
    }
    HelmDetection::Missing
}

/// Run `helm version --short` and return its stdout (e.g. `v3.18.0+gabcdef1`).
/// Returns None on any failure — this is purely cosmetic for the settings UI,
/// not load-bearing for install logic.
fn probe_version(binary: &Path) -> Option<String> {
    let out = std::process::Command::new(binary)
        .args(["version", "--short"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ─── Install / uninstall ────────────────────────────────────────────────────

/// Download the latest stable helm for the host's OS+arch, verify SHA-256,
/// extract from the tarball, and write to the managed path. Sync IO; caller
/// wraps in `spawn_blocking`.
pub(crate) fn install_latest_blocking() -> Result<HelmManagedInstallResult, HelmInstallError> {
    let target = managed_binary_path().ok_or(HelmInstallError::NoConfigDir)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(HelmInstallError::Io)?;
    }

    let version = fetch_latest_version()?;
    let os = host_os().ok_or_else(|| HelmInstallError::Unsupported {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    })?;
    let arch = host_arch().ok_or_else(|| HelmInstallError::Unsupported {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    })?;
    let archive_name = archive_name(&version, os, arch);
    let archive_url = format!("https://get.helm.sh/{archive_name}");
    let sha_url = format!("{archive_url}.sha256sum");

    // Pull the expected SHA first — fail fast on a transient mirror outage
    // before downloading the (much larger) tarball.
    let sha_body = http_get_text(&sha_url)?;
    let expected_sha =
        parse_sha256sum(&sha_body).ok_or_else(|| HelmInstallError::ChecksumFormat {
            url: sha_url.clone(),
            got: sha_body.trim().to_string(),
        })?;

    let tmp_dir = tempfile::Builder::new()
        .prefix("ferrisscope-helm-install-")
        .tempdir()
        .map_err(HelmInstallError::Io)?;
    let archive_tmp = tmp_dir.path().join(&archive_name);
    download_to(&archive_url, &archive_tmp)?;

    let actual_sha = sha256_of_file(&archive_tmp).map_err(HelmInstallError::Io)?;
    if actual_sha != expected_sha {
        return Err(HelmInstallError::ChecksumMismatch {
            expected: expected_sha,
            actual: actual_sha,
        });
    }

    // Extract `<os>-<arch>/helm[.exe]` from the gzipped tar archive into a
    // sibling file in the tempdir, then atomically rename onto the target.
    let entry_path = archive_helm_entry(os, arch);
    let extracted_tmp = tmp_dir.path().join("helm.extracted");
    extract_helm_from_archive(&archive_tmp, &entry_path, &extracted_tmp)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&extracted_tmp)
            .map_err(HelmInstallError::Io)?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&extracted_tmp, perms).map_err(HelmInstallError::Io)?;
    }

    let _ = fs::remove_file(&target);
    fs::rename(&extracted_tmp, &target).map_err(HelmInstallError::Io)?;

    Ok(HelmManagedInstallResult {
        path: target.display().to_string(),
        version,
        asset_url: archive_url,
    })
}

/// Remove the managed binary. Idempotent.
pub(crate) fn uninstall_managed() -> Result<(), HelmInstallError> {
    let Some(target) = managed_binary_path() else {
        return Ok(());
    };
    match fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(HelmInstallError::Io(e)),
    }
}

// ─── URL / archive layout helpers (pure, testable) ──────────────────────────

fn archive_name(version: &str, os: &str, arch: &str) -> String {
    let ext = if os == "windows" { "zip" } else { "tar.gz" };
    format!("helm-{version}-{os}-{arch}.{ext}")
}

/// Path inside the tarball where helm lives. helm publishes archives that
/// contain a single top-level dir named `<os>-<arch>/` with `helm` (or
/// `helm.exe`) and licence/readme alongside.
fn archive_helm_entry(os: &str, arch: &str) -> String {
    let bin = if os == "windows" { "helm.exe" } else { "helm" };
    format!("{os}-{arch}/{bin}")
}

/// Parse a `sha256sum -b` style line: `<64-hex>  <filename>`. We only care
/// about the leading digest. Returns None if the leading token isn't a
/// 64-character lowercase hex string.
fn parse_sha256sum(body: &str) -> Option<String> {
    let first_line = body.lines().next()?.trim();
    let token = first_line.split_whitespace().next()?;
    let lowered = token.to_ascii_lowercase();
    if lowered.len() == 64 && lowered.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(lowered)
    } else {
        None
    }
}

// ─── Archive extraction ─────────────────────────────────────────────────────

fn extract_helm_from_archive(
    archive: &Path,
    entry_path: &str,
    dest: &Path,
) -> Result<(), HelmInstallError> {
    use std::io::copy;

    let f = File::open(archive).map_err(HelmInstallError::Io)?;
    let decoder = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(decoder);

    for entry in tar.entries().map_err(HelmInstallError::Io)? {
        let mut entry = entry.map_err(HelmInstallError::Io)?;
        // `entry.path()` borrows internal state — convert eagerly so we can
        // also write to the entry below.
        let entry_inner_path = entry.path().map_err(HelmInstallError::Io)?.into_owned();
        if entry_inner_path == Path::new(entry_path) {
            let mut out = File::create(dest).map_err(HelmInstallError::Io)?;
            copy(&mut entry, &mut out).map_err(HelmInstallError::Io)?;
            return Ok(());
        }
    }
    Err(HelmInstallError::ArchiveMissingEntry {
        entry: entry_path.to_string(),
    })
}

// ─── HTTP / version selection ───────────────────────────────────────────────

fn fetch_latest_version() -> Result<String, HelmInstallError> {
    let body = http_get_text(LATEST_VERSION_URL)?;
    let v = body.trim().to_string();
    // Sanity-check shape: e.g. `v3.18.0`. Strict enough to catch a wrong
    // mirror (HTML page) without rejecting future bumps.
    if !v.starts_with('v') || v.len() < 4 || v.len() > 24 {
        return Err(HelmInstallError::VersionFormat { got: v });
    }
    Ok(v)
}

fn host_os() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        // helm uses `darwin`, not `macos`.
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

fn download_to(url: &str, path: &Path) -> Result<(), HelmInstallError> {
    let mut response = http_get_reader(url)?;
    let mut out = File::create(path).map_err(HelmInstallError::Io)?;
    io::copy(&mut response, &mut out).map_err(HelmInstallError::Io)?;
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

fn http_get_text(url: &str) -> Result<String, HelmInstallError> {
    let mut reader = http_get_reader(url)?;
    let mut body = String::new();
    use std::io::Read;
    reader
        .read_to_string(&mut body)
        .map_err(HelmInstallError::Io)?;
    Ok(body)
}

fn http_get_reader(url: &str) -> Result<Box<dyn io::Read>, HelmInstallError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into();
    let request = agent
        .get(url)
        .header("User-Agent", "ferrisscope-helm-installer");
    let response = match request.call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => {
            return Err(HelmInstallError::Http {
                code,
                body: String::new(),
            });
        }
        Err(other) => return Err(HelmInstallError::Transport(other.to_string())),
    };
    let (_, body) = response.into_parts();
    Ok(Box::new(body.into_reader()))
}

// ─── Errors ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub(crate) enum HelmInstallError {
    NoConfigDir,
    Unsupported { os: String, arch: String },
    Io(io::Error),
    Http { code: u16, body: String },
    Transport(String),
    VersionFormat { got: String },
    ChecksumFormat { url: String, got: String },
    ChecksumMismatch { expected: String, actual: String },
    ArchiveMissingEntry { entry: String },
}

impl std::fmt::Display for HelmInstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoConfigDir => f.write_str("could not resolve config directory"),
            Self::Unsupported { os, arch } => {
                write!(f, "helm install not supported on {os}/{arch}")
            }
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Http { code, body } => write!(f, "HTTP {code}: {body}"),
            Self::Transport(s) => write!(f, "network: {s}"),
            Self::VersionFormat { got } => {
                write!(f, "unexpected helm-latest-version content: {got:?}")
            }
            Self::ChecksumFormat { url, got } => {
                write!(f, "unexpected sha256sum content from {url}: {got:?}")
            }
            Self::ChecksumMismatch { expected, actual } => {
                write!(
                    f,
                    "helm SHA-256 mismatch — expected {expected}, got {actual}. \
                     The download was discarded; try again."
                )
            }
            Self::ArchiveMissingEntry { entry } => {
                write!(f, "helm archive did not contain expected entry: {entry}")
            }
        }
    }
}

impl std::error::Error for HelmInstallError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn archive_name_picks_extension_per_os() {
        assert_eq!(
            archive_name("v3.18.0", "linux", "amd64"),
            "helm-v3.18.0-linux-amd64.tar.gz"
        );
        assert_eq!(
            archive_name("v3.18.0", "darwin", "arm64"),
            "helm-v3.18.0-darwin-arm64.tar.gz"
        );
        assert_eq!(
            archive_name("v3.18.0", "windows", "amd64"),
            "helm-v3.18.0-windows-amd64.zip"
        );
    }

    #[test]
    fn archive_helm_entry_picks_binary_per_os() {
        assert_eq!(archive_helm_entry("linux", "amd64"), "linux-amd64/helm");
        assert_eq!(archive_helm_entry("darwin", "arm64"), "darwin-arm64/helm");
        assert_eq!(
            archive_helm_entry("windows", "amd64"),
            "windows-amd64/helm.exe"
        );
    }

    #[test]
    fn parse_sha256sum_accepts_canonical_form() {
        // sha256sum's default output: "<64-hex>  <filename>\n"
        let body = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890  helm-v3.18.0-darwin-arm64.tar.gz\n";
        assert_eq!(
            parse_sha256sum(body).as_deref(),
            Some("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890")
        );
    }

    #[test]
    fn parse_sha256sum_accepts_uppercase() {
        let body = "ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890  foo\n";
        assert_eq!(
            parse_sha256sum(body).as_deref(),
            Some("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890")
        );
    }

    #[test]
    fn parse_sha256sum_rejects_html_body() {
        let body = "<!doctype html>\n<html>nope</html>\n";
        assert!(parse_sha256sum(body).is_none());
    }

    #[test]
    fn parse_sha256sum_rejects_short_digest() {
        let body = "deadbeef  foo\n";
        assert!(parse_sha256sum(body).is_none());
    }

    #[test]
    fn extract_helm_from_archive_pulls_named_entry() {
        // Build a tiny in-memory tar.gz containing the expected entry,
        // then verify we extract its contents to the destination file.
        let tmp = tempfile::Builder::new()
            .prefix("ferrisscope-helm-extract-test-")
            .tempdir()
            .unwrap();
        let archive_path = tmp.path().join("archive.tar.gz");
        let dest = tmp.path().join("helm.out");
        let payload = b"#!/fake/helm\nhello\n";

        {
            let f = File::create(&archive_path).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_path("linux-amd64/helm").unwrap();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append(&header, &payload[..]).unwrap();
            // Throw in a sibling file to make sure the loop keeps scanning
            // past unrelated entries (and stops at the right one).
            let mut sibling = tar::Header::new_gnu();
            sibling.set_path("linux-amd64/LICENSE").unwrap();
            sibling.set_size(3);
            sibling.set_mode(0o644);
            sibling.set_cksum();
            builder.append(&sibling, &b"MIT"[..]).unwrap();
            builder.finish().unwrap();
            let mut gz = builder.into_inner().unwrap();
            gz.flush().unwrap();
            gz.finish().unwrap();
        }

        extract_helm_from_archive(&archive_path, "linux-amd64/helm", &dest).unwrap();
        let extracted = fs::read(&dest).unwrap();
        assert_eq!(extracted, payload);
    }

    #[test]
    fn extract_helm_from_archive_errors_when_entry_missing() {
        let tmp = tempfile::Builder::new()
            .prefix("ferrisscope-helm-extract-missing-")
            .tempdir()
            .unwrap();
        let archive_path = tmp.path().join("archive.tar.gz");
        let dest = tmp.path().join("helm.out");

        {
            let f = File::create(&archive_path).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_path("something-else/README").unwrap();
            header.set_size(3);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"hey"[..]).unwrap();
            builder.finish().unwrap();
            let mut gz = builder.into_inner().unwrap();
            gz.flush().unwrap();
            gz.finish().unwrap();
        }

        let err = extract_helm_from_archive(&archive_path, "linux-amd64/helm", &dest).unwrap_err();
        assert!(matches!(
            err,
            HelmInstallError::ArchiveMissingEntry { ref entry } if entry == "linux-amd64/helm"
        ));
    }
}
