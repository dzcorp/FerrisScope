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

const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/yzhelezko/FerrisScope/releases/latest";
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
    assets: Vec<GitHubAsset>,
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

fn format_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::StatusCode(code) => format!("HTTP {code} while contacting GitHub"),
        other => format!("Network error while contacting GitHub: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        asset_suffix, current_version, normalize_version, parse_apply_update_command,
        supported_target_label,
    };
    use std::ffi::OsString;

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
}
