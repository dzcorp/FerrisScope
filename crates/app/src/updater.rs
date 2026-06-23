// GitHub-Releases updater. Targets the artifacts the release workflow
// (.github/workflows/release.yml) actually publishes:
//
//   * Linux x64/arm64  → *-linux-{arch}.AppImage   (self-replace)
//   * macOS x64/arm64  → *-macos-{arch}.dmg        (mount → copy → swap)
//   * Windows x64      → *-windows-x64.exe         (NSIS silent install)
//
// .deb / .rpm / .msi are owned by the system package manager (or MSI's own
// install state) and refused here on purpose. On Windows we update via the
// NSIS installer because it knows how to terminate the running app, replace
// the install dir, and relaunch — the same `tauri build` produces both .exe
// and .msi, but only the NSIS path is wired to the updater.
//
// On-disk identifiers are the lowercase technical names per CLAUDE.md
// (`ferrisscope`, `FerrisScope.app`).

use semver::Version;
use serde::Deserialize;
use serde::Serialize;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
#[cfg(target_os = "macos")]
use tempfile::TempDir;

const GITHUB_RELEASES_API: &str = "https://api.github.com/repos/dzcorp/FerrisScope/releases/latest";
const GITHUB_RELEASES_PAGE: &str = "https://github.com/dzcorp/FerrisScope/releases";
const APPLY_UPDATE_FLAG: &str = "--apply-update";
#[cfg(target_os = "macos")]
const BINARY_NAME: &str = "ferrisscope";
#[cfg(target_os = "macos")]
const MACOS_BUNDLE_NAME: &str = "FerrisScope.app";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ReleaseInfo {
    pub(crate) version: String,
    pub(crate) html_url: String,
    pub(crate) asset_name: String,
    pub(crate) download_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CheckOutcome {
    UpToDate {
        latest_version: String,
        html_url: String,
    },
    UpdateAvailable {
        release: ReleaseInfo,
    },
}

#[derive(Debug)]
struct ApplyUpdateCommand {
    parent_pid: u32,
    staging_root: PathBuf,
    package_root: PathBuf,
    install_root: PathBuf,
    relaunch_executable: PathBuf,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
    // Release-notes fields. Optional so the leaner `check_latest_release`
    // deserialize (and older releases with empty bodies) keep working.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

pub(crate) fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub(crate) fn releases_page_url() -> &'static str {
    GITHUB_RELEASES_PAGE
}

/// How this binary was installed on the user's system. The updater branches
/// on this so a system-package install (AUR, apt, dnf, brew) shows the
/// operator the right `pacman -Syu` / `apt update` / `brew upgrade` command
/// instead of trying — and failing — to swap the binary out from under the
/// package manager.
///
/// Detected at runtime via path heuristics + filesystem probes; never relies
/// on a build-time flag because we ship a single binary across multiple
/// install paths (the same `.deb` is what AUR re-packages, the same Linux
/// build also ships as an AppImage).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InstallMethod {
    /// Linux: `$APPIMAGE` env var is set — we're running as an AppImage.
    /// The in-app self-replace + relaunch flow handles this.
    AppImage,
    /// Linux: installed by the AUR `ferrisscope-bin` package — `pacman` knows
    /// the file. Update via `pacman -Syu` / `yay -Syu`.
    AurBin,
    /// Linux: installed by `apt` from a `.deb`. Update via `apt update &&
    /// apt upgrade ferrisscope` (or rebuild the .deb manually since the
    /// upstream source is GitHub Releases).
    AptDeb,
    /// Linux: installed by `dnf` / `yum` / `zypper` from an `.rpm`.
    RpmDnf,
    /// macOS: launched from a `.app` bundle that the in-app DMG flow can swap.
    MacOsAppBundle,
    /// macOS: installed via Homebrew (`brew install --cask ferrisscope` or
    /// similar); update via `brew upgrade ferrisscope`.
    Homebrew,
    /// Windows: installed by the NSIS installer the in-app updater knows how
    /// to run.
    WindowsNsis,
    /// Couldn't determine — probably a one-off binary the user dropped on
    /// PATH. We don't try to update; we point at the GitHub releases page.
    Unknown,
}

impl InstallMethod {
    /// Whether the in-app updater can actually apply an update for this
    /// install method, or whether it should defer to the system tool.
    pub(crate) fn supports_in_app_apply(self) -> bool {
        matches!(
            self,
            Self::AppImage | Self::MacOsAppBundle | Self::WindowsNsis
        )
    }

    /// Operator-facing command to update via the system's package manager.
    /// `None` for self-updateable methods (the UI shows the apply button) and
    /// for `Unknown` (the UI points at the releases page instead).
    pub(crate) fn update_hint(self) -> Option<&'static str> {
        match self {
            Self::AurBin => {
                Some("yay -Syu ferrisscope-bin   # or: paru / pacman -Syu after refresh")
            }
            Self::AptDeb => Some(
                "Download the latest .deb from the releases page and \
                 `sudo apt install ./ferrisscope-*-linux-x64.deb`",
            ),
            Self::RpmDnf => Some(
                "Download the latest .rpm from the releases page and \
                 `sudo dnf install ferrisscope-*-linux-x64.rpm`",
            ),
            Self::Homebrew => Some("brew upgrade ferrisscope"),
            Self::AppImage | Self::MacOsAppBundle | Self::WindowsNsis | Self::Unknown => None,
        }
    }
}

pub(crate) fn detect_install_method() -> InstallMethod {
    detect_install_method_inner(
        std::env::consts::OS,
        std::env::current_exe().ok().as_deref(),
        std::env::var_os("APPIMAGE").is_some(),
    )
}

fn detect_install_method_inner(
    os: &str,
    current_exe: Option<&Path>,
    appimage_env_set: bool,
) -> InstallMethod {
    match os {
        "linux" => detect_linux(current_exe, appimage_env_set),
        "macos" => detect_macos(current_exe),
        "windows" => InstallMethod::WindowsNsis,
        _ => InstallMethod::Unknown,
    }
}

fn detect_linux(current_exe: Option<&Path>, appimage_env_set: bool) -> InstallMethod {
    // The AppImage runtime always sets $APPIMAGE to the .AppImage's path,
    // even before `exec`-ing the embedded binary. Cheapest, most reliable
    // signal — check first.
    if appimage_env_set {
        return InstallMethod::AppImage;
    }
    let Some(exe) = current_exe else {
        return InstallMethod::Unknown;
    };
    // Only system-managed locations need the package-DB probes. A binary at
    // /usr/local/bin or ~/.local/bin is operator-placed and will never be
    // owned by pacman/dpkg/rpm.
    if !exe.starts_with("/usr/bin") && !exe.starts_with("/usr/lib") {
        return InstallMethod::Unknown;
    }
    // Pacman's local DB is the cheapest probe — a single dir lookup. We
    // accept either `ferrisscope-bin` (AUR) or `ferrisscope` (a hypothetical
    // -src package) as evidence.
    if has_pacman_owner("ferrisscope-bin") || has_pacman_owner("ferrisscope") {
        return InstallMethod::AurBin;
    }
    // dpkg keeps a status file at /var/lib/dpkg/status. A file at
    // /var/lib/dpkg/info/ferrisscope.list listing the binary path is the
    // cheaper, more direct signal.
    if Path::new("/var/lib/dpkg/info/ferrisscope.list").is_file() {
        return InstallMethod::AptDeb;
    }
    // RPM-based: the database lives under /var/lib/rpm (Fedora ≤35 / RHEL)
    // or /usr/lib/sysimage/rpm (Fedora ≥36). We don't try to query rpmdb
    // (would require shelling out); just use the same dpkg-equivalent
    // heuristic — if the host has rpm and our binary lives in /usr/bin,
    // we're most likely an rpm install.
    if Path::new("/var/lib/rpm").is_dir() || Path::new("/usr/lib/sysimage/rpm").is_dir() {
        return InstallMethod::RpmDnf;
    }
    InstallMethod::Unknown
}

fn has_pacman_owner(pkg: &str) -> bool {
    // Pacman's local DB is `/var/lib/pacman/local/<pkg>-<ver>-<rel>/`. We
    // don't know the version, so glob via `read_dir` and prefix-match.
    let local = Path::new("/var/lib/pacman/local");
    let prefix = format!("{pkg}-");
    let Ok(entries) = std::fs::read_dir(local) else {
        return false;
    };
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            // Real package dirs are `<name>-<ver>-<rel>`. Reject prefix
            // matches that aren't followed by a version segment so a
            // package called `ferrisscope-binutils` doesn't get
            // misclassified as `ferrisscope-bin`.
            if let Some(rest) = name.strip_prefix(&prefix) {
                if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                    return true;
                }
            }
        }
    }
    false
}

fn detect_macos(current_exe: Option<&Path>) -> InstallMethod {
    let Some(exe) = current_exe else {
        return InstallMethod::Unknown;
    };
    let s = exe.to_string_lossy();
    // Homebrew Cellar lives under `/opt/homebrew/Cellar` (Apple silicon) or
    // `/usr/local/Cellar` (Intel). Either side, the `brew --prefix` symlink
    // sits one of those two places.
    if s.contains("/Cellar/") || s.starts_with("/opt/homebrew/") {
        return InstallMethod::Homebrew;
    }
    // Anything inside an `*.app` bundle — `/Applications/FerrisScope.app/...`
    // or a user-local install — is updateable by the in-app DMG flow.
    if exe
        .ancestors()
        .any(|a| a.extension().and_then(|e| e.to_str()) == Some("app"))
    {
        return InstallMethod::MacOsAppBundle;
    }
    InstallMethod::Unknown
}

pub(crate) fn supported_target_label() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("macos", "x86_64") => Ok("macos-x64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("windows", "x86_64") => Ok("windows-x64"),
        (os, arch) => Err(format!("Updater is not supported on {os}/{arch}.")),
    }
}

/// Called from main() before Tauri starts. If our argv requests the macOS
/// apply step, do the file swap and exit. (Linux uses self-replace + relaunch
/// in-process and never re-enters this path.)
pub(crate) fn maybe_run_apply_update_from_args() -> Result<bool, String> {
    let mut args = std::env::args_os();
    let _ = args.next();
    let Some(flag) = args.next() else {
        return Ok(false);
    };
    if flag != APPLY_UPDATE_FLAG {
        return Ok(false);
    }
    let command = parse_apply_update_command(args.collect())?;
    run_apply_update_command(&command)?;
    Ok(true)
}

pub(crate) fn check_latest_release() -> Result<CheckOutcome, String> {
    let asset_suffix = asset_suffix()?;
    let body = http_get_text(GITHUB_RELEASES_API, true)?;
    let release: GitHubRelease = serde_json::from_str(&body)
        .map_err(|err| format!("Invalid GitHub release response: {err}"))?;

    let latest_version = normalize_version(&release.tag_name)?;
    let latest = Version::parse(&latest_version)
        .map_err(|err| format!("Invalid release version '{latest_version}': {err}"))?;
    let current = Version::parse(current_version())
        .map_err(|err| format!("Invalid current version '{}': {err}", current_version()))?;

    if latest <= current {
        return Ok(CheckOutcome::UpToDate {
            latest_version,
            html_url: release.html_url,
        });
    }

    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name.ends_with(asset_suffix))
        .ok_or_else(|| {
            format!(
                "Latest release does not contain a {} asset.",
                supported_target_label().unwrap_or("supported")
            )
        })?;

    Ok(CheckOutcome::UpdateAvailable {
        release: ReleaseInfo {
            version: latest_version,
            html_url: release.html_url,
            asset_name: asset.name,
            download_url: asset.browser_download_url,
        },
    })
}

// ── Release notes ────────────────────────────────────────────────────────────
//
// Dynamic "What's new" for the About panel. We read the GitHub *list* endpoint
// (not just /latest), parse each release body's "What's Changed" section into
// structured change items, and keep only releases strictly newer than the
// installed build. The bundle is cached on disk (next to prefs.json) and
// revalidated with an ETag so opening About doesn't hammer the API.

const GITHUB_RELEASES_LIST_API: &str =
    "https://api.github.com/repos/dzcorp/FerrisScope/releases?per_page=100";
/// Serve cached notes without a network round-trip for this long; matches the
/// 6h background update-check cadence. Past this we revalidate with the ETag,
/// so a 304 still costs no download.
const NOTES_CACHE_TTL_MS: u64 = 6 * 60 * 60 * 1000;

/// One parsed bullet from a release's "What's Changed" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ChangeItem {
    /// Conventional-commit type: `feat` / `fix` / `refactor` / `docs` / `perf`
    /// / `chore` / … or `other` when the title isn't conventional.
    pub(crate) kind: String,
    /// Conventional-commit scope (`watch`, `port-forward`), if present.
    pub(crate) scope: Option<String>,
    /// Human-readable subject with the type/scope prefix and PR tail stripped.
    pub(crate) text: String,
    /// PR number parsed from the `… in …/pull/N` tail (or `(#N)`).
    pub(crate) pr: Option<u64>,
    /// Author login parsed from the `… by @login …` tail.
    pub(crate) author: Option<String>,
}

/// One release newer than the installed build, with its parsed changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReleaseNote {
    pub(crate) version: String,
    pub(crate) tag: String,
    pub(crate) name: Option<String>,
    pub(crate) published_at: Option<String>,
    pub(crate) html_url: String,
    pub(crate) changes: Vec<ChangeItem>,
}

/// What `get_release_notes` returns to the frontend. `releases` is newest-first
/// and contains only versions strictly greater than `current_version`, so an
/// up-to-date install yields an empty list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReleaseNotesBundle {
    pub(crate) current_version: String,
    pub(crate) latest_version: Option<String>,
    pub(crate) releases: Vec<ReleaseNote>,
    pub(crate) fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotesCacheEntry {
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    fetched_at: u64,
    bundle: ReleaseNotesBundle,
}

struct EtagResponse {
    status: u16,
    etag: Option<String>,
    body: String,
}

/// Parse a release body's "What's Changed" section into structured items.
/// Total — returns an empty Vec on a missing/empty section so older releases
/// (and any future format drift) degrade gracefully rather than panicking.
fn parse_whats_changed(body: &str) -> Vec<ChangeItem> {
    let lower = body.to_ascii_lowercase();
    // GitHub uses a curly apostrophe in "What's Changed"; tolerate both.
    let Some(header) = lower
        .find("what's changed")
        .or_else(|| lower.find("what\u{2019}s changed"))
    else {
        return Vec::new();
    };
    // Skip to the line after the header.
    let after = match body[header..].find('\n') {
        Some(nl) => header + nl + 1,
        None => return Vec::new(),
    };

    let mut items = Vec::new();
    for line in body[after..].lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let low = trimmed.to_ascii_lowercase();
        // Footer or next section ends the list.
        if low.starts_with("**full changelog") || low.starts_with("full changelog") {
            break;
        }
        if trimmed.starts_with('#') {
            break;
        }
        let Some(rest) = trimmed
            .strip_prefix("* ")
            .or_else(|| trimmed.strip_prefix("- "))
            .or_else(|| trimmed.strip_prefix("\u{2022} "))
        else {
            continue;
        };
        items.push(parse_change_line(rest));
    }
    items
}

/// Parse one bullet, e.g.
/// `fix(watch): TCP keepalive by @yzhelezko in https://github.com/o/r/pull/44`.
fn parse_change_line(line: &str) -> ChangeItem {
    let mut text = line.trim().to_string();
    let mut author = None;
    let mut pr = None;

    if let Some(by_idx) = text.rfind(" by @") {
        let tail = text[by_idx + 5..].trim().to_string();
        text = text[..by_idx].trim().to_string();
        if let Some(in_idx) = tail.find(" in ") {
            let who = tail[..in_idx].trim();
            if !who.is_empty() {
                author = Some(who.to_string());
            }
            let url = tail[in_idx + 4..].trim();
            pr = url
                .rsplit('/')
                .next()
                .and_then(|n| n.trim().parse::<u64>().ok());
        } else if !tail.is_empty() {
            author = Some(tail);
        }
    } else if let Some(hash_idx) = text.rfind("(#") {
        // "title (#44)" form.
        let inner = text[hash_idx + 2..].trim_end_matches(')');
        if let Ok(n) = inner.trim().parse::<u64>() {
            pr = Some(n);
            text = text[..hash_idx].trim().to_string();
        }
    }

    let (kind, scope, subject) = split_conventional(&text);
    ChangeItem {
        kind,
        scope,
        text: subject,
        pr,
        author,
    }
}

/// Split a conventional-commit title into (kind, scope, subject). Non-conforming
/// titles fall back to `("other", None, <whole title>)`.
fn split_conventional(text: &str) -> (String, Option<String>, String) {
    if let Some(colon) = text.find(": ") {
        let head = &text[..colon];
        let subject = text[colon + 2..].trim().to_string();
        let (kind_raw, scope) = match (head.find('('), head.find(')')) {
            (Some(open), Some(close)) if close > open => (
                head[..open].to_string(),
                Some(head[open + 1..close].trim().to_string()),
            ),
            _ => (head.to_string(), None),
        };
        if let Some(kind) = normalize_kind(kind_raw.trim_end_matches('!')) {
            return (kind, scope.filter(|s| !s.is_empty()), subject);
        }
    }
    ("other".to_string(), None, text.trim().to_string())
}

/// Recognise the conventional-commit types we group on. Unknown → None
/// (caller maps to `other`).
fn normalize_kind(kind: &str) -> Option<String> {
    let k = kind.trim().to_ascii_lowercase();
    matches!(
        k.as_str(),
        "feat"
            | "fix"
            | "refactor"
            | "perf"
            | "docs"
            | "chore"
            | "test"
            | "build"
            | "ci"
            | "style"
            | "revert"
    )
    .then_some(k)
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Debug builds (`make dev`) run with version `0.1.0`. We use this both to
/// preview the panel one-version-behind and to keep dev cache off the released
/// cache file, so testing in dev never clobbers a real install's cached notes.
fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

fn notes_cache_path() -> Option<PathBuf> {
    // Separate file in dev so a debug run's preview bundle never overwrites the
    // released build's cache (different effective version, different contents).
    let file = if is_dev_build() {
        "release_notes.dev.json"
    } else {
        "release_notes.json"
    };
    directories::ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join(file))
}

fn read_notes_cache() -> Option<NotesCacheEntry> {
    let path = notes_cache_path()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_notes_cache(entry: &NotesCacheEntry) -> Result<(), String> {
    let path = notes_cache_path().ok_or("No config dir for release-notes cache")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {e}"))?;
    }
    let data =
        serde_json::to_string(entry).map_err(|e| format!("serialize release-notes cache: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("write release-notes cache: {e}"))
}

/// Build a `ReleaseNotesBundle` from the raw GitHub releases list + the
/// installed version. Pure (no IO) so it's unit-testable against fixtures.
///
/// `preview_one_behind` is the dev affordance: in a debug build the installed
/// version is `0.1.0` (lower than every release), which would otherwise list
/// *every* release as "new" and make the panel impossible to eyeball. When set,
/// we filter as if installed at the second-newest tag, so the panel shows just
/// the newest release — exactly what a real one-version-behind user sees.
/// `current_version` in the returned bundle is always the *real* installed
/// version (cache identity + display depend on it being stable).
fn build_bundle(
    releases: Vec<GitHubRelease>,
    current_str: &str,
    fetched_at: u64,
    preview_one_behind: bool,
) -> ReleaseNotesBundle {
    // First pass: parse every non-draft release into (version, note).
    let mut parsed: Vec<(Version, ReleaseNote)> = Vec::new();
    for r in releases {
        // Skip drafts and prereleases — the updater tracks stable releases only
        // (GitHub's /latest endpoint, which `check_latest_release` uses, does
        // the same), so the notes panel must agree with the update offer.
        if r.draft || r.prerelease {
            continue;
        }
        let Ok(v_str) = normalize_version(&r.tag_name) else {
            continue;
        };
        let Ok(v) = Version::parse(&v_str) else {
            continue;
        };
        let changes = r
            .body
            .as_deref()
            .map(parse_whats_changed)
            .unwrap_or_default();
        parsed.push((
            v,
            ReleaseNote {
                version: v_str,
                tag: r.tag_name,
                name: r.name,
                published_at: r.published_at,
                html_url: r.html_url,
                changes,
            },
        ));
    }

    let latest = parsed.iter().map(|(v, _)| v).max().cloned();

    // Threshold: releases strictly greater than this are "new".
    let threshold: Option<Version> = if preview_one_behind {
        let mut versions: Vec<Version> = parsed.iter().map(|(v, _)| v.clone()).collect();
        versions.sort();
        versions.dedup();
        if versions.len() >= 2 {
            // Second-newest → only the newest release surfaces.
            Some(versions[versions.len() - 2].clone())
        } else {
            // 0 or 1 releases: floor so the single release (if any) shows.
            Some(Version::new(0, 0, 0))
        }
    } else {
        Version::parse(current_str).ok()
    };

    let mut notes: Vec<(Version, ReleaseNote)> = parsed
        .into_iter()
        .filter(|(v, _)| threshold.as_ref().is_none_or(|t| v > t))
        .collect();
    // Newest-first.
    notes.sort_by(|a, b| b.0.cmp(&a.0));

    ReleaseNotesBundle {
        current_version: current_str.to_string(),
        latest_version: latest.map(|v| v.to_string()),
        releases: notes.into_iter().map(|(_, n)| n).collect(),
        fetched_at,
    }
}

/// Fetch (or serve cached) release notes for versions newer than the installed
/// build. `force` skips the freshness window but still sends the ETag, so an
/// unchanged list returns 304 with no body download.
pub(crate) fn fetch_release_notes(force: bool) -> Result<ReleaseNotesBundle, String> {
    let current_str = current_version().to_string();
    let now = now_unix_ms();
    let cache = read_notes_cache();

    if !force {
        if let Some(c) = &cache {
            let fresh = now.saturating_sub(c.fetched_at) < NOTES_CACHE_TTL_MS;
            if fresh && c.bundle.current_version == current_str {
                return Ok(c.bundle.clone());
            }
        }
    }

    let etag = cache.as_ref().and_then(|c| c.etag.clone());
    let resp = http_get_with_etag(GITHUB_RELEASES_LIST_API, etag.as_deref())?;

    if resp.status == 304 {
        if let Some(mut c) = cache {
            // Still current; just stamp it so we don't revalidate every open.
            if c.bundle.current_version == current_str {
                c.fetched_at = now;
                let bundle = c.bundle.clone();
                let _ = write_notes_cache(&c);
                return Ok(bundle);
            }
        }
        return Err("GitHub returned 304 but no usable cached notes were available.".to_string());
    }

    let releases: Vec<GitHubRelease> = serde_json::from_str(&resp.body)
        .map_err(|e| format!("Invalid GitHub releases response: {e}"))?;
    let bundle = build_bundle(releases, &current_str, now, is_dev_build());
    let entry = NotesCacheEntry {
        etag: resp.etag,
        fetched_at: now,
        bundle: bundle.clone(),
    };
    let _ = write_notes_cache(&entry);
    Ok(bundle)
}

pub(crate) fn prepare_and_spawn_update(release: &ReleaseInfo) -> Result<(), String> {
    // Belt-and-braces: the frontend only surfaces the apply button when
    // `UpdaterInfo.supported = true`, but a malicious / out-of-sync caller
    // could still invoke this command. Refuse for any non-self-updateable
    // install method so we don't try to overwrite a system-managed binary.
    let method = detect_install_method();
    if !method.supports_in_app_apply() {
        let hint = method
            .update_hint()
            .map(|h| format!(" Update via: {h}"))
            .unwrap_or_default();
        return Err(format!(
            "This install was placed by another tool ({method:?}); the in-app updater \
             cannot replace it.{hint}"
        ));
    }
    #[cfg(target_os = "linux")]
    {
        apply_linux_appimage_update(release)?;
        // The new AppImage is now spawned; exit so it can take over.
        std::process::exit(0);
    }
    #[cfg(target_os = "macos")]
    {
        apply_macos_dmg_update(release)?;
        // The helper has been spawned; it'll wait for us to exit, swap the
        // bundle, and relaunch. Exit promptly.
        std::process::exit(0);
    }
    #[cfg(target_os = "windows")]
    {
        apply_windows_nsis_update(release)?;
        // NSIS will close us, replace the install, and relaunch.
        std::process::exit(0);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = release;
        Err("Updater is not supported on this platform.".to_string())
    }
}

// --------------------------------------------------------------------------
// Linux: AppImage swap.
// --------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn apply_linux_appimage_update(release: &ReleaseInfo) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let appimage_path = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "Auto-update on Linux only supports the AppImage build. For .deb / .rpm \
             installs, please update via your system package manager (apt / dnf / zypper)."
                .to_string()
        })?;

    if !appimage_path.is_file() {
        return Err(format!(
            "$APPIMAGE points at '{}' but no such file exists.",
            appimage_path.display()
        ));
    }

    // Stage next to the target so the final atomic rename can't hit EXDEV
    // (cross-filesystem rename) when /tmp is on tmpfs and $APPIMAGE lives on
    // the user's home filesystem.
    let appimage_dir = appimage_path
        .parent()
        .ok_or_else(|| "$APPIMAGE has no parent directory.".to_string())?;
    let appimage_name = appimage_path
        .file_name()
        .ok_or_else(|| "$APPIMAGE has no file name.".to_string())?
        .to_string_lossy()
        .to_string();
    let staging_path = appimage_dir.join(format!(".{appimage_name}.new"));

    // Best-effort cleanup of any leftover from a previous failed attempt.
    let _ = fs::remove_file(&staging_path);

    download_to_path(&release.download_url, &staging_path)?;

    // AppImages must be executable to launch.
    let mut perms = fs::metadata(&staging_path)
        .map_err(|err| format!("Failed to stat staged AppImage: {err}"))?
        .permissions();
    perms.set_mode(perms.mode() | 0o755);
    fs::set_permissions(&staging_path, perms)
        .map_err(|err| format!("Failed to chmod staged AppImage: {err}"))?;

    // Atomic rename — Linux keeps the running AppImage's mmap'd inode alive
    // even after the directory entry is replaced.
    fs::rename(&staging_path, &appimage_path).map_err(|err| {
        let _ = fs::remove_file(&staging_path);
        format!("Failed to swap '{}': {err}", appimage_path.display())
    })?;

    // Relaunch the new AppImage so the user keeps a running window.
    Command::new(&appimage_path)
        .spawn()
        .map_err(|err| format!("Failed to relaunch updated AppImage: {err}"))?;

    Ok(())
}

// --------------------------------------------------------------------------
// macOS: DMG mount → copy bundle → spawn helper to swap.
// --------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn apply_macos_dmg_update(release: &ReleaseInfo) -> Result<(), String> {
    let temp_dir = TempDir::new().map_err(|err| format!("Failed to create temp dir: {err}"))?;
    let staging_root = temp_dir.keep();

    let dmg_path = staging_root.join(&release.asset_name);
    download_to_path(&release.download_url, &dmg_path)?;

    let mount_point = staging_root.join("mount");
    fs::create_dir_all(&mount_point)
        .map_err(|err| format!("Failed to prepare mount point: {err}"))?;

    let status = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount_point)
        .arg(&dmg_path)
        .status()
        .map_err(|err| format!("Failed to invoke hdiutil attach: {err}"))?;
    if !status.success() {
        return Err("hdiutil attach failed for the downloaded DMG.".to_string());
    }

    let mounted_app = mount_point.join(MACOS_BUNDLE_NAME);
    if !mounted_app.is_dir() {
        let _ = Command::new("hdiutil")
            .args(["detach", "-quiet"])
            .arg(&mount_point)
            .status();
        return Err(format!(
            "Mounted DMG does not contain '{MACOS_BUNDLE_NAME}' at its root."
        ));
    }

    let staged_app = staging_root.join(MACOS_BUNDLE_NAME);
    let cp_status = Command::new("cp")
        .arg("-R")
        .arg(&mounted_app)
        .arg(&staged_app)
        .status()
        .map_err(|err| format!("Failed to invoke cp: {err}"))?;

    let _ = Command::new("hdiutil")
        .args(["detach", "-quiet"])
        .arg(&mount_point)
        .status();

    if !cp_status.success() {
        return Err("Failed to copy app bundle from DMG.".to_string());
    }

    let helper_executable = staged_app.join("Contents/MacOS").join(BINARY_NAME);
    if !helper_executable.is_file() {
        return Err(format!(
            "Staged app bundle is missing its executable at '{}'.",
            helper_executable.display()
        ));
    }

    let install_target = current_install_target()?;
    spawn_apply_helper(
        &helper_executable,
        std::process::id(),
        &staging_root,
        &staged_app,
        &install_target.install_root,
        &install_target.relaunch_executable,
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
struct InstallTarget {
    install_root: PathBuf,
    relaunch_executable: PathBuf,
}

#[cfg(target_os = "macos")]
fn current_install_target() -> Result<InstallTarget, String> {
    let current_executable = std::env::current_exe()
        .map_err(|err| format!("Failed to locate current executable: {err}"))?;
    let app_root = macos_app_bundle_root(&current_executable).ok_or_else(|| {
        "Auto-update on macOS requires the app to run from a .app bundle.".to_string()
    })?;
    Ok(InstallTarget {
        relaunch_executable: app_root.join("Contents/MacOS").join(BINARY_NAME),
        install_root: app_root,
    })
}

#[cfg(target_os = "macos")]
fn macos_app_bundle_root(path: &Path) -> Option<PathBuf> {
    for ancestor in path.ancestors() {
        if ancestor
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
        {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn spawn_apply_helper(
    helper_executable: &Path,
    parent_pid: u32,
    staging_root: &Path,
    package_root: &Path,
    install_root: &Path,
    relaunch_executable: &Path,
) -> Result<(), String> {
    let helper_dir = helper_executable
        .parent()
        .ok_or_else(|| "Updater helper executable does not have a parent directory.".to_string())?;

    Command::new(helper_executable)
        .arg(APPLY_UPDATE_FLAG)
        .arg(parent_pid.to_string())
        .arg(staging_root)
        .arg(package_root)
        .arg(install_root)
        .arg(relaunch_executable)
        .current_dir(helper_dir)
        .spawn()
        .map_err(|err| format!("Failed to launch updater helper: {err}"))?;
    Ok(())
}

// --------------------------------------------------------------------------
// Windows: download NSIS .exe → spawn detached in passive mode.
// The NSIS installer Tauri produces (mode `passive`) terminates the running
// app, replaces the install directory, and relaunches the new binary. We
// download the asset to %TEMP% and spawn it detached so this process can
// exit cleanly without holding files open.
// --------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn apply_windows_nsis_update(release: &ReleaseInfo) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    // Stage in %TEMP% — the NSIS installer self-deletes on success, but
    // we keep the path stable in case the user retries after a failure.
    let temp_dir = std::env::temp_dir().join(format!("ferrisscope-update-{}", std::process::id()));
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to prepare update staging dir: {err}"))?;

    let installer_path = temp_dir.join(&release.asset_name);
    download_to_path(&release.download_url, &installer_path)?;

    // CREATE_NO_WINDOW (0x0800_0000) | DETACHED_PROCESS (0x0000_0008) so
    // the installer survives our exit and doesn't flash a console window.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    Command::new(&installer_path)
        // Tauri's NSIS template accepts /P for passive (progress UI, no
        // prompts). /S would be fully silent — we prefer the progress
        // bar so the user sees the update happening.
        .arg("/P")
        .arg("/R") // restart app after install
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| format!("Failed to launch Windows installer: {err}"))?;

    Ok(())
}

// --------------------------------------------------------------------------
// Helper-process apply path (macOS only — Linux doesn't use this).
// --------------------------------------------------------------------------

fn parse_apply_update_command(args: Vec<OsString>) -> Result<ApplyUpdateCommand, String> {
    if args.len() != 5 {
        return Err("Updater helper received an invalid argument set.".to_string());
    }

    let parent_pid = args[0]
        .to_string_lossy()
        .parse::<u32>()
        .map_err(|err| format!("Invalid parent pid for updater helper: {err}"))?;

    Ok(ApplyUpdateCommand {
        parent_pid,
        staging_root: PathBuf::from(&args[1]),
        package_root: PathBuf::from(&args[2]),
        install_root: PathBuf::from(&args[3]),
        relaunch_executable: PathBuf::from(&args[4]),
    })
}

fn run_apply_update_command(command: &ApplyUpdateCommand) -> Result<(), String> {
    wait_for_process_exit(command.parent_pid)?;
    sync_package_contents(&command.package_root, &command.install_root)?;
    if let Some(parent) = command.install_root.parent() {
        let _ = std::env::set_current_dir(parent);
    } else {
        let _ = std::env::set_current_dir(&command.install_root);
    }
    relaunch_updated_app(&command.relaunch_executable)?;
    cleanup_staging_root(&command.staging_root);
    Ok(())
}

fn normalize_version(tag: &str) -> Result<String, String> {
    let normalized = tag.trim().trim_start_matches('v');
    if normalized.is_empty() {
        return Err("Release tag does not contain a version.".to_string());
    }
    Ok(normalized.to_string())
}

fn asset_suffix() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("-linux-x64.AppImage"),
        ("linux", "aarch64") => Ok("-linux-arm64.AppImage"),
        ("macos", "x86_64") => Ok("-macos-x64.dmg"),
        ("macos", "aarch64") => Ok("-macos-arm64.dmg"),
        ("windows", "x86_64") => Ok("-windows-x64.exe"),
        _ => Err(supported_target_label().unwrap_err()),
    }
}

fn wait_for_process_exit(pid: u32) -> Result<(), String> {
    const MAX_WAIT_STEPS: usize = 600;
    for _ in 0..MAX_WAIT_STEPS {
        if !process_exists(pid) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Timed out waiting for the running app process to exit.".to_string())
}

#[cfg(target_os = "linux")]
fn process_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(target_os = "macos")]
fn process_exists(pid: u32) -> bool {
    Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn process_exists(pid: u32) -> bool {
    // Windows `tasklist` is the lowest-friction polite check that doesn't
    // require linking the WinAPI directly. Output includes the pid only
    // while the process is alive.
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains(&format!("\"{pid}\""))
        }
        Err(_) => false,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn process_exists(_pid: u32) -> bool {
    false
}

fn sync_package_contents(source_root: &Path, install_root: &Path) -> Result<(), String> {
    fs::create_dir_all(install_root).map_err(|err| {
        format!(
            "Failed to create install root '{}': {err}",
            install_root.display()
        )
    })?;

    let entries = fs::read_dir(source_root).map_err(|err| {
        format!(
            "Failed to read extracted package '{}': {err}",
            source_root.display()
        )
    })?;
    for entry in entries {
        let entry =
            entry.map_err(|err| format!("Failed to read extracted package entry: {err}"))?;
        let source_path = entry.path();
        let destination_path = install_root.join(entry.file_name());
        sync_path(&source_path, &destination_path)?;
    }
    remove_stale_entries(source_root, install_root);
    Ok(())
}

fn sync_path(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_dir() {
        if destination.exists() && destination.is_file() {
            fs::remove_file(destination).map_err(|err| {
                format!(
                    "Failed to remove file blocking directory update '{}': {err}",
                    destination.display()
                )
            })?;
        }
        fs::create_dir_all(destination).map_err(|err| {
            format!(
                "Failed to create directory '{}': {err}",
                destination.display()
            )
        })?;
        let entries = fs::read_dir(source)
            .map_err(|err| format!("Failed to read directory '{}': {err}", source.display()))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("Failed to read directory entry: {err}"))?;
            sync_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
        remove_stale_entries(source, destination);
    } else if source.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!("Failed to create directory '{}': {err}", parent.display())
            })?;
        }
        if destination.exists() {
            if destination.is_dir() {
                fs::remove_dir_all(destination).map_err(|err| {
                    format!(
                        "Failed to remove directory blocking file update '{}': {err}",
                        destination.display()
                    )
                })?;
            } else {
                remove_or_rename_old(destination)?;
            }
        }
        retry_io(3, Duration::from_millis(200), || {
            fs::copy(source, destination)
        })
        .map_err(|err| {
            format!(
                "Failed to copy '{}' to '{}': {err}",
                source.display(),
                destination.display()
            )
        })?;
        copy_permissions(source, destination)?;
    }
    Ok(())
}

fn remove_stale_entries(source: &Path, destination: &Path) {
    let Ok(dest_entries) = fs::read_dir(destination) else {
        return;
    };
    for dest_entry in dest_entries.flatten() {
        let name = dest_entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.ends_with(".fs-update-old") {
            continue;
        }
        if source.join(&name).exists() {
            continue;
        }
        let stale = dest_entry.path();
        if stale.is_dir() {
            let _ = fs::remove_dir_all(&stale);
        } else {
            let _ = remove_or_rename_old(&stale);
        }
    }
}

fn remove_or_rename_old(path: &Path) -> Result<(), String> {
    if retry_io(2, Duration::from_millis(150), || fs::remove_file(path)).is_ok() {
        return Ok(());
    }

    let mut old_path = path.as_os_str().to_os_string();
    old_path.push(".fs-update-old");
    let old_path = PathBuf::from(old_path);
    let _ = retry_io(2, Duration::from_millis(150), || fs::remove_file(&old_path));
    fs::rename(path, &old_path).map_err(|err| {
        format!(
            "Failed to move locked file '{}' to '{}': {err}",
            path.display(),
            old_path.display()
        )
    })
}

fn retry_io<T>(
    retries: usize,
    delay: Duration,
    mut op: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let mut last_err = None;
    for i in 0..=retries {
        match op() {
            Ok(val) => return Ok(val),
            Err(err) => {
                last_err = Some(err);
                if i < retries {
                    thread::sleep(delay);
                }
            }
        }
    }
    Err(last_err.unwrap())
}

pub(crate) fn cleanup_old_update_files() {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let Some(install_dir) = current_exe.parent() else {
        return;
    };
    cleanup_old_files_in(install_dir);
}

fn cleanup_old_files_in(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            cleanup_old_files_in(&path);
        } else if path.to_string_lossy().ends_with(".fs-update-old") {
            let _ = fs::remove_file(&path);
        }
    }
}

fn copy_permissions(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::metadata(source).map_err(|err| {
        format!(
            "Failed to read source permissions '{}': {err}",
            source.display()
        )
    })?;
    fs::set_permissions(destination, metadata.permissions()).map_err(|err| {
        format!(
            "Failed to set permissions on '{}': {err}",
            destination.display()
        )
    })?;
    Ok(())
}

fn relaunch_updated_app(path: &Path) -> Result<(), String> {
    let mut command = Command::new(path);
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    command
        .spawn()
        .map_err(|err| format!("Failed to relaunch updated app '{}': {err}", path.display()))?;
    Ok(())
}

fn cleanup_staging_root(staging_root: &Path) {
    let _ = fs::remove_dir_all(staging_root);
}

fn download_to_path(url: &str, path: &Path) -> Result<(), String> {
    let mut response = http_get_response(url, false)?;
    let mut output =
        File::create(path).map_err(|err| format!("Failed to create download target: {err}"))?;
    io::copy(&mut response, &mut output)
        .map_err(|err| format!("Failed to write downloaded update: {err}"))?;
    Ok(())
}

fn http_get_text(url: &str, json: bool) -> Result<String, String> {
    let response = http_get_response(url, json)?;
    let mut body = String::new();
    let mut reader = response;
    use std::io::Read;
    reader
        .read_to_string(&mut body)
        .map_err(|err| format!("Failed to read HTTP response body: {err}"))?;
    Ok(body)
}

fn http_get_response(url: &str, json: bool) -> Result<Box<dyn io::Read>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let mut request = agent
        .get(url)
        .header("User-Agent", &format!("ferrisscope/{}", current_version()));
    if json {
        request = request.header("Accept", "application/vnd.github+json");
    }
    let (_, body) = request.call().map_err(format_http_error)?.into_parts();
    Ok(Box::new(body.into_reader()))
}

/// GET that keeps the status code + ETag header so callers can do conditional
/// requests. Sends `If-None-Match` when `if_none_match` is set; a 304 returns an
/// empty body (caller reuses its cache). 304 is not an error here — ureq only
/// maps >= 400 to `Error::StatusCode`.
fn http_get_with_etag(url: &str, if_none_match: Option<&str>) -> Result<EtagResponse, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let mut request = agent
        .get(url)
        .header("User-Agent", &format!("ferrisscope/{}", current_version()))
        .header("Accept", "application/vnd.github+json");
    if let Some(etag) = if_none_match {
        request = request.header("If-None-Match", etag);
    }
    let (parts, body) = request.call().map_err(format_http_error)?.into_parts();
    let status = parts.status.as_u16();
    let etag = parts
        .headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let text = if status == 304 {
        String::new()
    } else {
        use std::io::Read;
        let mut s = String::new();
        body.into_reader()
            .read_to_string(&mut s)
            .map_err(|err| format!("Failed to read HTTP response body: {err}"))?;
        s
    };
    Ok(EtagResponse {
        status,
        etag,
        body: text,
    })
}

fn format_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::StatusCode(code) => format!("HTTP {code} while contacting GitHub"),
        other => format!("Network error while contacting GitHub: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        asset_suffix, build_bundle, current_version, normalize_version, parse_apply_update_command,
        parse_change_line, parse_whats_changed, split_conventional, supported_target_label,
        GitHubRelease,
    };
    use std::ffi::OsString;

    fn fixture_releases() -> Vec<GitHubRelease> {
        // `json!` strings carry real newlines (from `\n`), so `parse_whats_changed`
        // sees genuine line breaks — a raw string literal would not.
        let v = serde_json::json!([
            {"tag_name":"v1.0.27","html_url":"https://x/v1.0.27","name":"v1.0.27","published_at":"2026-06-20T00:00:00Z","prerelease":false,"draft":false,
             "body":"## What's Changed\n* feat(a): newest by @u in https://x/pull/45"},
            {"tag_name":"v1.0.26","html_url":"https://x/v1.0.26","name":"v1.0.26","prerelease":false,"draft":false,
             "body":"## What's Changed\n* fix(b): middle by @u in https://x/pull/44"},
            {"tag_name":"v1.0.25","html_url":"https://x/v1.0.25","prerelease":false,"draft":false,"body":""},
            {"tag_name":"v1.0.28-rc1","html_url":"https://x/rc","prerelease":true,"draft":false,
             "body":"## What's Changed\n* feat(z): pre by @u in https://x/pull/99"},
            {"tag_name":"v9.9.9","html_url":"https://x/draft","prerelease":false,"draft":true,
             "body":"## What's Changed\n* feat(z): draft by @u in https://x/pull/100"}
        ]);
        serde_json::from_value(v).expect("valid releases fixture")
    }

    #[test]
    fn strips_v_prefix() {
        assert_eq!(normalize_version("v1.2.3").unwrap(), "1.2.3");
        assert_eq!(normalize_version("1.2.3").unwrap(), "1.2.3");
        assert_eq!(normalize_version("  v0.4.0\n").unwrap(), "0.4.0");
    }

    #[test]
    fn normalize_version_rejects_empty_tag() {
        assert!(normalize_version("").is_err());
        assert!(normalize_version("v").is_err());
        assert!(normalize_version("   ").is_err());
    }

    #[test]
    fn current_version_is_a_real_semver() {
        // Crate version is a build-time constant; if it's malformed we'd
        // never publish. The test exists to keep semver::Version on the
        // hook for changes to Cargo's CARGO_PKG_VERSION shape.
        let v = current_version();
        semver::Version::parse(v).unwrap_or_else(|_| panic!("CARGO_PKG_VERSION not semver: {v}"));
    }

    #[test]
    fn asset_suffix_matches_release_workflow() {
        // Sanity-check that the suffixes stay in sync with what
        // .github/workflows/release.yml actually publishes.
        let s = asset_suffix().unwrap_or("");
        assert!(s.starts_with('-'), "expected leading dash, got: {s}");
        let ext = std::path::Path::new(s).extension().and_then(|e| e.to_str());
        assert!(
            ext.is_some_and(|e| e.eq_ignore_ascii_case("AppImage")
                || e.eq_ignore_ascii_case("dmg")
                || e.eq_ignore_ascii_case("exe")),
            "expected .AppImage / .dmg / .exe suffix, got: {s}"
        );
    }

    #[test]
    fn supported_target_labels_match_asset_suffix() {
        // Sanity: the user-facing target label and the asset suffix agree
        // on platform spelling, so error messages match the artifacts.
        let label = supported_target_label().unwrap_or("");
        let suffix = asset_suffix().unwrap_or("");
        assert!(
            suffix.contains(label),
            "asset suffix {suffix:?} should contain target label {label:?}"
        );
    }

    #[test]
    fn parse_apply_update_command_requires_five_args() {
        // Wrong arity is a programmer error in spawn_apply_helper but the
        // helper must refuse rather than crash.
        for n in [0usize, 1, 2, 3, 4, 6, 10] {
            let args: Vec<OsString> = (0..n).map(|i| OsString::from(i.to_string())).collect();
            assert!(
                parse_apply_update_command(args).is_err(),
                "n={n} must be rejected"
            );
        }
    }

    #[test]
    fn parse_apply_update_command_accepts_valid_input() {
        let args = vec![
            OsString::from("12345"),
            OsString::from("/tmp/staging"),
            OsString::from("/tmp/staging/FerrisScope.app"),
            OsString::from("/Applications/FerrisScope.app"),
            OsString::from("/Applications/FerrisScope.app/Contents/MacOS/ferrisscope"),
        ];
        let cmd = parse_apply_update_command(args).unwrap();
        assert_eq!(cmd.parent_pid, 12345);
        assert!(cmd.staging_root.ends_with("staging"));
        assert!(cmd.relaunch_executable.ends_with("ferrisscope"));
    }

    use super::{detect_install_method_inner, InstallMethod};
    use std::path::Path;

    #[test]
    fn install_method_classifies_self_updateable_correctly() {
        assert!(InstallMethod::AppImage.supports_in_app_apply());
        assert!(InstallMethod::MacOsAppBundle.supports_in_app_apply());
        assert!(InstallMethod::WindowsNsis.supports_in_app_apply());
        assert!(!InstallMethod::AurBin.supports_in_app_apply());
        assert!(!InstallMethod::AptDeb.supports_in_app_apply());
        assert!(!InstallMethod::RpmDnf.supports_in_app_apply());
        assert!(!InstallMethod::Homebrew.supports_in_app_apply());
        assert!(!InstallMethod::Unknown.supports_in_app_apply());
    }

    #[test]
    fn update_hint_set_for_system_packages_only() {
        // Self-updateable methods: no command hint — the apply button does it.
        assert!(InstallMethod::AppImage.update_hint().is_none());
        assert!(InstallMethod::MacOsAppBundle.update_hint().is_none());
        assert!(InstallMethod::WindowsNsis.update_hint().is_none());
        // Unknown: don't suggest a command we can't be sure about.
        assert!(InstallMethod::Unknown.update_hint().is_none());
        // System-package methods: hint is non-empty and references the right tool.
        assert!(InstallMethod::AurBin.update_hint().unwrap().contains("yay"));
        assert!(InstallMethod::AptDeb.update_hint().unwrap().contains("apt"));
        assert!(InstallMethod::RpmDnf.update_hint().unwrap().contains("dnf"));
        assert!(InstallMethod::Homebrew
            .update_hint()
            .unwrap()
            .starts_with("brew "));
    }

    #[test]
    fn detect_macos_app_bundle_when_run_from_dot_app() {
        let exe = Path::new("/Applications/FerrisScope.app/Contents/MacOS/ferrisscope");
        assert_eq!(
            detect_install_method_inner("macos", Some(exe), false),
            InstallMethod::MacOsAppBundle
        );
    }

    #[test]
    fn detect_macos_homebrew() {
        // Apple silicon prefix.
        let exe = Path::new("/opt/homebrew/Cellar/ferrisscope/0.1.0/bin/ferrisscope");
        assert_eq!(
            detect_install_method_inner("macos", Some(exe), false),
            InstallMethod::Homebrew
        );
        // Intel prefix.
        let exe2 = Path::new("/usr/local/Cellar/ferrisscope/0.1.0/bin/ferrisscope");
        assert_eq!(
            detect_install_method_inner("macos", Some(exe2), false),
            InstallMethod::Homebrew
        );
    }

    #[test]
    fn detect_macos_unknown_when_no_marker() {
        let exe = Path::new("/Users/me/bin/ferrisscope");
        assert_eq!(
            detect_install_method_inner("macos", Some(exe), false),
            InstallMethod::Unknown
        );
    }

    #[test]
    fn detect_windows_assumes_nsis() {
        // We don't probe the registry on Windows; if the binary is running
        // at all, the NSIS install path is what we know how to update.
        assert_eq!(
            detect_install_method_inner(
                "windows",
                Some(Path::new("C:\\Program Files\\FerrisScope\\ferrisscope.exe")),
                false,
            ),
            InstallMethod::WindowsNsis
        );
    }

    #[test]
    fn detect_linux_appimage_via_env_var() {
        // appimage_env_set=true wins regardless of the exe path — even if a
        // binary lives at /usr/bin for testing, $APPIMAGE means we're
        // running through the AppImage runtime.
        let got =
            detect_install_method_inner("linux", Some(Path::new("/usr/bin/ferrisscope")), true);
        assert_eq!(got, InstallMethod::AppImage);
    }

    #[test]
    fn detect_linux_unknown_for_user_local_paths() {
        // Operator-placed binaries (e.g. ~/.local/bin) aren't owned by any
        // package manager — return Unknown so the UI shows the releases
        // page rather than a misleading pacman/apt hint.
        for p in [
            "/home/user/bin/ferrisscope",
            "/usr/local/bin/ferrisscope",
            "/opt/ferrisscope/ferrisscope",
        ] {
            assert_eq!(
                detect_install_method_inner("linux", Some(Path::new(p)), false),
                InstallMethod::Unknown,
                "{p} should classify as Unknown"
            );
        }
    }

    #[test]
    fn parse_apply_update_command_rejects_non_numeric_pid() {
        let args = vec![
            OsString::from("not-a-pid"),
            OsString::from("/a"),
            OsString::from("/b"),
            OsString::from("/c"),
            OsString::from("/d"),
        ];
        assert!(parse_apply_update_command(args).is_err());
    }

    // ── Release notes ────────────────────────────────────────────────────────

    #[test]
    fn parse_whats_changed_extracts_bullets() {
        let body = "Some intro blurb.\n\n\
            ## What's Changed\n\
            * fix(watch): TCP keepalive on watch sockets by @yzhelezko in https://github.com/dzcorp/FerrisScope/pull/44\n\
            * feat(port-forward): global DNS forwarding by @yzhelezko in https://github.com/dzcorp/FerrisScope/pull/45\n\n\
            **Full Changelog**: https://github.com/dzcorp/FerrisScope/compare/v1.0.26...v1.0.27";
        let items = parse_whats_changed(body);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, "fix");
        assert_eq!(items[0].scope.as_deref(), Some("watch"));
        assert_eq!(items[0].text, "TCP keepalive on watch sockets");
        assert_eq!(items[0].pr, Some(44));
        assert_eq!(items[0].author.as_deref(), Some("yzhelezko"));
        assert_eq!(items[1].kind, "feat");
        assert_eq!(items[1].scope.as_deref(), Some("port-forward"));
        assert_eq!(items[1].pr, Some(45));
    }

    #[test]
    fn parse_whats_changed_tolerates_missing_section() {
        // Older releases ship empty bodies / install boilerplate only.
        assert!(parse_whats_changed("").is_empty());
        assert!(parse_whats_changed("Download the AppImage below.").is_empty());
        // Curly apostrophe variant is still recognised.
        let curly = "## What\u{2019}s Changed\n* chore: bump deps by @bot in https://x/pull/9";
        let items = parse_whats_changed(curly);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "chore");
        assert_eq!(items[0].pr, Some(9));
    }

    #[test]
    fn parse_whats_changed_stops_at_next_heading() {
        let body = "## What's Changed\n* fix: a by @u in https://x/pull/1\n## New Contributors\n* @newbie made their first contribution";
        let items = parse_whats_changed(body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "a");
    }

    #[test]
    fn parse_change_line_handles_hash_form_and_plain() {
        let hash = parse_change_line("feat(ui): nicer about panel (#123)");
        assert_eq!(hash.kind, "feat");
        assert_eq!(hash.scope.as_deref(), Some("ui"));
        assert_eq!(hash.text, "nicer about panel");
        assert_eq!(hash.pr, Some(123));
        assert!(hash.author.is_none());

        // Non-conventional title → "other", whole text preserved.
        let plain = parse_change_line("Update README by @docsbot in https://x/pull/7");
        assert_eq!(plain.kind, "other");
        assert!(plain.scope.is_none());
        assert_eq!(plain.text, "Update README");
        assert_eq!(plain.author.as_deref(), Some("docsbot"));
        assert_eq!(plain.pr, Some(7));
    }

    #[test]
    fn split_conventional_recognises_types_and_breaking_marker() {
        assert_eq!(
            split_conventional("refactor(core)!: drop legacy path"),
            (
                "refactor".into(),
                Some("core".into()),
                "drop legacy path".into()
            )
        );
        assert_eq!(
            split_conventional("docs: tidy"),
            ("docs".into(), None, "tidy".into())
        );
        // Unknown type prefix is not treated as conventional.
        assert_eq!(
            split_conventional("wip(thing): half done"),
            ("other".into(), None, "wip(thing): half done".into())
        );
    }

    #[test]
    fn build_bundle_filters_to_newer_stable_releases() {
        let bundle = build_bundle(fixture_releases(), "1.0.25", 1000, false);
        // 1.0.26 and 1.0.27 are newer than 1.0.25; rc + draft excluded.
        let versions: Vec<&str> = bundle.releases.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(versions, vec!["1.0.27", "1.0.26"]); // newest-first
                                                        // latest_version reflects the newest *stable* release.
        assert_eq!(bundle.latest_version.as_deref(), Some("1.0.27"));
        assert_eq!(bundle.current_version, "1.0.25");
        assert_eq!(bundle.fetched_at, 1000);
    }

    #[test]
    fn build_bundle_up_to_date_is_empty() {
        let bundle = build_bundle(fixture_releases(), "1.0.27", 0, false);
        assert!(bundle.releases.is_empty());
        assert_eq!(bundle.latest_version.as_deref(), Some("1.0.27"));
    }

    #[test]
    fn build_bundle_dev_preview_shows_only_newest() {
        // Dev build (real version 0.1.0) would otherwise list every release.
        // Preview mode pretends we're at the second-newest tag → only newest.
        let bundle = build_bundle(fixture_releases(), "0.1.0", 0, true);
        let versions: Vec<&str> = bundle.releases.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(versions, vec!["1.0.27"]);
        // Real installed version is preserved for cache identity / display.
        assert_eq!(bundle.current_version, "0.1.0");
    }
}
