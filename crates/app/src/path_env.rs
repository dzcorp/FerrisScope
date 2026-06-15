//! Process `PATH` recovery for GUI launches.
//!
//! A desktop app started from Finder/Dock/Spotlight (macOS) or a
//! `.desktop`/systemd-user unit (Linux) is launched *outside* a login shell,
//! so it inherits a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS)
//! instead of the operator's real shell `PATH`. The rc files (`~/.zprofile`,
//! `~/.zshrc`, …) that add Homebrew, the gcloud SDK, asdf, etc. are never
//! sourced. The result: CLIs the operator installed are invisible to
//! `which::which` and `Command::new("foo")` — including the exec-credential
//! auth plugins kube-rs spawns for GKE / EKS / AKS (`gke-gcloud-auth-plugin`,
//! `aws-iam-authenticator`, `kubelogin`). That is the macOS "Failed to load
//! kube client: auth error: unable to run auth exec: No such file or
//! directory" papercut: it reproduces only in the packaged `.app` (Finder
//! launch), never under `cargo tauri dev` / a terminal launch.
//!
//! [`augment_path`] repairs this once at startup, before any kube `Client` is
//! built and before the helm/kubectl `which` probes fire:
//!   1. If the inherited `PATH` already looks rich (a terminal launch), do the
//!      cheap curated top-up only — no shell spawn.
//!   2. Otherwise recover the operator's real login+interactive shell `PATH`
//!      (`$SHELL -ilc`, hard-timeout, sentinel-delimited) and merge it.
//!   3. Always append a curated fallback list (Homebrew, the gcloud SDK dirs,
//!      Rancher Desktop, our managed-bin dir) as a belt for when shell capture
//!      times out or the tool lives somewhere unusual.
//!
//! No-op on Windows (its GUI `PATH` is not stripped the same way and `-ilc` is
//! meaningless). Tauri-free; the planning logic is pure and unit-tested without
//! a GUI or a real shell by injecting the directory-exists predicate and canned
//! shell output.

/// Recover the operator's real `PATH` (from their login shell) and merge a
/// curated fallback list into the process environment. Idempotent; call once
/// early at startup, on the main thread, before the tokio runtime spins up and
/// before any kube `Client` is built. No-op on Windows.
pub(crate) fn augment_path() {
    #[cfg(not(target_os = "windows"))]
    unix::augment_path();
}

#[cfg(not(target_os = "windows"))]
mod unix {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    /// Sentinel markers wrapped around the captured `env` dump so we can slice
    /// the real output away from rc-file banners / MOTD noise / ANSI.
    const PATH_START: &str = "__FS_PATH_START__";
    const PATH_END: &str = "__FS_PATH_END__";

    /// Hard wall-clock cap on the login-shell spawn. Heavy `oh-my-zsh` / `nvm` /
    /// `conda` setups can take seconds; we must never block startup on them.
    const SHELL_CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);

    /// POSIX shells we can drive with `-ilc 'command -p env'`. `fish` / `nu` /
    /// `elvish` aren't POSIX, so for those we fall back to a standard shell for
    /// the capture (the operator still gets the curated dirs).
    const POSIX_SHELLS: &[&str] = &["bash", "zsh", "sh", "dash", "ksh"];

    pub(super) fn augment_path() {
        let existing: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();

        // Terminal launch → PATH is already rich; skip the (slow) shell spawn
        // and just top up any missing curated dirs. On the rich path we also skip
        // env capture: a rich PATH means a real login shell launched us, so the
        // full environment (AWS_*, CLOUDSDK_*, proxy vars, …) was already
        // inherited — there is nothing to recover.
        let (captured, captured_env) = if path_looks_rich(&existing) {
            tracing::info!(
                target: "ferrisscope::startup",
                "path: rich PATH detected (terminal launch) — skipping login-shell capture"
            );
            (Vec::new(), Vec::new())
        } else {
            match capture_login_shell() {
                Some((p, env)) => {
                    tracing::info!(
                        target: "ferrisscope::startup",
                        "path: recovered {} dir(s) from login shell",
                        p.len()
                    );
                    (p, env)
                }
                None => {
                    tracing::info!(
                        target: "ferrisscope::startup",
                        "path: login-shell capture unavailable — using curated fallback only"
                    );
                    (Vec::new(), Vec::new())
                }
            }
        };

        // Sync whitelisted cloud / proxy / TLS env vars from the login shell so
        // exec-credential plugins see the same environment as the operator's
        // terminal. A found binary still fails auth without e.g. AWS_PROFILE,
        // CLOUDSDK_CONFIG, or HTTPS_PROXY — these are absent on a Dock/.desktop
        // launch. Done independently of the PATH change below so it still runs
        // even if PATH happened to be unchanged. No-op on the rich path.
        apply_shell_env(&captured_env);

        let curated = curated_dirs();
        let (merged, applied) = merge_paths(&captured, &existing, &curated, |p| p.is_dir());

        if merged == existing {
            return;
        }
        match std::env::join_paths(&merged) {
            Ok(joined) => {
                // SAFETY/soundness: `set_var` mutates the process-global env and
                // is only sound while single-threaded. This runs at startup,
                // before the tokio runtime / any `Cluster::connect` / exec
                // spawn. (Edition 2021: still safe. On a future edition-2024
                // bump this becomes `unsafe` — keep the call here, early and
                // single-threaded; don't move or wrap it carelessly.)
                std::env::set_var("PATH", joined);
                let summary = if applied.is_empty() {
                    "(reordered)".to_string()
                } else {
                    applied.join(",")
                };
                tracing::info!(target: "ferrisscope::startup", "path: prepended=[{summary}]");
            }
            Err(e) => {
                tracing::warn!(
                    target: "ferrisscope::startup",
                    "path: could not join entries — leaving PATH untouched ({e})"
                );
            }
        }
    }

    /// Curated fallback directories appended after the captured/inherited
    /// `PATH`. `(path, always_include)` — `always_include` skips the on-disk
    /// check (used for our managed-bin dir, populated *after* startup so
    /// helm/kubectl resolve without a restart). Non-existent dirs are dropped,
    /// so listing macOS + Linux locations together is harmless.
    fn curated_dirs() -> Vec<(PathBuf, bool)> {
        let mut dirs: Vec<(PathBuf, bool)> = vec![
            // Homebrew (Apple silicon) + Intel/manual-install + MacPorts.
            (PathBuf::from("/opt/homebrew/bin"), false),
            (PathBuf::from("/opt/homebrew/sbin"), false),
            (PathBuf::from("/usr/local/bin"), false),
            (PathBuf::from("/usr/local/sbin"), false),
            (PathBuf::from("/opt/local/bin"), false),
            (PathBuf::from("/opt/local/sbin"), false),
            // Homebrew on Linux.
            (PathBuf::from("/home/linuxbrew/.linuxbrew/bin"), false),
            (PathBuf::from("/home/linuxbrew/.linuxbrew/sbin"), false),
            // Homebrew-cask gcloud: the auth plugin lives beside `gcloud` in the
            // SDK's own `bin`, NOT symlinked into `{prefix}/bin` (brew only links
            // `gcloud` itself, never components installed later via
            // `gcloud components install gke-gcloud-auth-plugin`). The SDK
            // extracts to `{prefix}/share/google-cloud-sdk/bin` regardless of the
            // cask name (`google-cloud-sdk` → renamed `gcloud-cli`), so the
            // `share` dir is the stable target; the versioned Caskroom dir is a
            // belt for layouts where `share` isn't populated.
            //
            // Apple Silicon (`/opt/homebrew`):
            (
                PathBuf::from("/opt/homebrew/share/google-cloud-sdk/bin"),
                false,
            ),
            (
                PathBuf::from("/opt/homebrew/Caskroom/gcloud-cli/latest/google-cloud-sdk/bin"),
                false,
            ),
            (
                PathBuf::from(
                    "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin",
                ),
                false,
            ),
            // Intel / `/usr/local`:
            (
                PathBuf::from("/usr/local/share/google-cloud-sdk/bin"),
                false,
            ),
            (
                PathBuf::from("/usr/local/Caskroom/gcloud-cli/latest/google-cloud-sdk/bin"),
                false,
            ),
            (
                PathBuf::from("/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin"),
                false,
            ),
        ];
        if let Ok(home) = std::env::var("HOME") {
            dirs.push((PathBuf::from(format!("{home}/.local/bin")), false));
            // Standalone Google Cloud SDK installer — `gke-gcloud-auth-plugin`
            // lives here. This dir is the most common gap behind the GKE
            // "auth exec: No such file or directory" failure.
            dirs.push((PathBuf::from(format!("{home}/google-cloud-sdk/bin")), false));
            // Rancher Desktop.
            dirs.push((PathBuf::from(format!("{home}/.rd/bin")), false));
        }
        if let Some(managed) = crate::kubectl_install::managed_bin_dir() {
            dirs.push((managed, true));
        }
        dirs
    }

    /// Merge the recovered shell `PATH`, the inherited process `PATH`, and the
    /// curated fallback into one ordered, de-duplicated list. Resolution
    /// priority: captured shell dirs first (the operator's real config), then
    /// the inherited dirs, then curated dirs as a last-resort belt. Returns
    /// `(merged, applied)` where `applied` lists dirs newly introduced relative
    /// to `existing` (for the startup log).
    fn merge_paths(
        captured: &[PathBuf],
        existing: &[PathBuf],
        curated: &[(PathBuf, bool)],
        exists: impl Fn(&Path) -> bool,
    ) -> (Vec<PathBuf>, Vec<String>) {
        use std::collections::HashSet;

        let existing_set: HashSet<&Path> = existing.iter().map(PathBuf::as_path).collect();
        let mut out: Vec<PathBuf> =
            Vec::with_capacity(captured.len() + existing.len() + curated.len());
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut applied: Vec<String> = Vec::new();

        // 1. Recovered shell PATH first (highest resolution priority).
        for p in captured {
            if seen.insert(p.clone()) {
                if !existing_set.contains(p.as_path()) {
                    applied.push(p.display().to_string());
                }
                out.push(p.clone());
            }
        }
        // 2. The inherited process PATH, preserved.
        for p in existing {
            if seen.insert(p.clone()) {
                out.push(p.clone());
            }
        }
        // 3. Curated fallback dirs appended as a belt.
        for (p, always) in curated {
            if seen.contains(p) {
                continue;
            }
            if !*always && !exists(p) {
                continue;
            }
            if !existing_set.contains(p.as_path()) {
                applied.push(p.display().to_string());
            }
            seen.insert(p.clone());
            out.push(p.clone());
        }
        (out, applied)
    }

    /// Heuristic: does `existing` already look like a terminal-launch PATH?
    /// Presence of Homebrew / `~/.local/bin` / the gcloud SDK / linuxbrew means
    /// rc files were sourced — almost certainly not the stripped launchd PATH.
    fn path_looks_rich(existing: &[PathBuf]) -> bool {
        existing.iter().any(|p| {
            let s = p.to_string_lossy();
            s == "/opt/homebrew/bin"
                || s == "/usr/local/bin"
                || s.ends_with("/.local/bin")
                || s.contains("google-cloud-sdk")
                || s.contains("/.linuxbrew/")
        })
    }

    /// Pick the shell to drive the capture. Prefers `$SHELL` when it's a POSIX
    /// shell; otherwise falls back to a standard shell.
    fn pick_capture_shell(
        shell_env: Option<&str>,
        exists: impl Fn(&Path) -> bool,
    ) -> Option<PathBuf> {
        if let Some(sh) = shell_env {
            let path = Path::new(sh);
            let base = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if POSIX_SHELLS.contains(&base) && exists(path) {
                return Some(path.to_path_buf());
            }
        }
        for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            let p = Path::new(fallback);
            if exists(p) {
                return Some(p.to_path_buf());
            }
        }
        None
    }

    /// Recover `PATH` by running the operator's login+interactive shell once.
    /// Returns `None` on any failure (no shell, spawn error, timeout, or
    /// missing sentinels) — the caller falls back to the curated list.
    /// `(KEY, VALUE)` env pairs harvested from the login shell.
    type EnvPairs = Vec<(String, String)>;

    /// Capture the login shell's `PATH` and full environment in a single spawn.
    /// `PATH` is required (we fall back to curated dirs without it); the env map
    /// is best-effort. Returns `(path_dirs, env_pairs)`.
    fn capture_login_shell() -> Option<(Vec<PathBuf>, EnvPairs)> {
        let shell = pick_capture_shell(std::env::var("SHELL").ok().as_deref(), is_executable)?;
        let out = run_shell_capture(&shell, SHELL_CAPTURE_TIMEOUT)?;
        let path = parse_shell_path(&out)?;
        let env = parse_shell_env(&out).unwrap_or_default();
        Some((path, env))
    }

    /// Exact env-var names worth syncing from the login shell. Cloud SDKs and
    /// auth plugins read these; they are absent on a Dock/.desktop launch.
    const ENV_EXACT: &[&str] = &[
        "HOME",
        "KUBECONFIG",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    ];

    /// Prefix families worth syncing (AWS / gcloud / Google / Azure / Kerberos).
    const ENV_PREFIX: &[&str] = &["AWS_", "CLOUDSDK_", "GOOGLE_", "GCP_", "AZURE_", "KRB5"];

    fn is_whitelisted_env(key: &str) -> bool {
        ENV_EXACT.contains(&key) || ENV_PREFIX.iter().any(|p| key.starts_with(p))
    }

    /// Pure selection step (testable without touching the real process env):
    /// keep only whitelisted vars, never `PATH` (handled separately), and only
    /// those not already set in the current process (launch context wins).
    fn select_env_vars(
        captured: &[(String, String)],
        is_set: impl Fn(&str) -> bool,
    ) -> Vec<(String, String)> {
        captured
            .iter()
            .filter(|(k, _)| k != "PATH" && is_whitelisted_env(k) && !is_set(k))
            .cloned()
            .collect()
    }

    /// Merge whitelisted captured vars into the process env (only-if-absent).
    /// Sound for the same reason as the PATH `set_var`: called on the main thread
    /// before the tokio runtime starts and before any cluster connect. Logs only
    /// the var *names* — values may carry secrets or private paths.
    fn apply_shell_env(captured: &[(String, String)]) {
        let to_set = select_env_vars(captured, |k| std::env::var_os(k).is_some());
        if to_set.is_empty() {
            return;
        }
        let names: Vec<&str> = to_set.iter().map(|(k, _)| k.as_str()).collect();
        for (k, v) in &to_set {
            std::env::set_var(k, v);
        }
        tracing::info!(
            target: "ferrisscope::startup",
            "env: synced {} var(s) from login shell: [{}]",
            names.len(),
            names.join(", ")
        );
    }

    /// Slice the `PATH=` value out of a sentinel-wrapped `env` dump. Tolerates
    /// rc-file banner noise before the start marker and ANSI escapes inside.
    fn parse_shell_path(stdout: &str) -> Option<Vec<PathBuf>> {
        let start = stdout.find(PATH_START)? + PATH_START.len();
        let rest = &stdout[start..];
        let end = rest.find(PATH_END)?;
        let slice = strip_ansi(&rest[..end]);
        let line = slice.lines().find(|l| l.starts_with("PATH="))?;
        let value = &line["PATH=".len()..];
        let dirs: Vec<PathBuf> = value
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        if dirs.is_empty() {
            None
        } else {
            Some(dirs)
        }
    }

    /// Parse every `KEY=VALUE` line from the captured `env` dump (same sentinel
    /// slice + ANSI strip as `parse_shell_path`). Lines that don't begin with a
    /// valid shell identifier followed by `=` are skipped (banner noise, and the
    /// continuation lines of rare multi-line values). Returns `None` if the
    /// markers are absent or no pairs were found.
    fn parse_shell_env(stdout: &str) -> Option<Vec<(String, String)>> {
        let start = stdout.find(PATH_START)? + PATH_START.len();
        let rest = &stdout[start..];
        let end = rest.find(PATH_END)?;
        let slice = strip_ansi(&rest[..end]);
        let mut pairs = Vec::new();
        for line in slice.lines() {
            let Some(eq) = line.find('=') else { continue };
            let key = &line[..eq];
            if is_env_key(key) {
                pairs.push((key.to_string(), line[eq + 1..].to_string()));
            }
        }
        if pairs.is_empty() {
            None
        } else {
            Some(pairs)
        }
    }

    /// A valid POSIX-ish env-var name: leading letter/underscore, then
    /// alphanumerics/underscores. Guards against treating banner text containing
    /// `=` (e.g. `foo = bar`) as an env pair.
    fn is_env_key(k: &str) -> bool {
        let mut chars = k.chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    }

    /// Spawn `<shell> -ilc 'printf …; command -p env; printf …'`, draining
    /// stdout on a thread so a large env dump can't deadlock the pipe, and
    /// enforcing a hard timeout (killing the child on expiry so no orphaned
    /// shell lingers). `command -p env` runs the real `env` via a default PATH
    /// so a user-defined `env` function/alias can't corrupt the dump.
    fn run_shell_capture(shell: &Path, timeout: Duration) -> Option<String> {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let script = format!("printf '{PATH_START}'; command -p env; printf '{PATH_END}'");
        let mut child = Command::new(shell)
            .args(["-ilc", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Keep rc files from launching tmux / drawing / blocking on a TTY.
            .env("TERM", "dumb")
            .env("DISABLE_AUTO_UPDATE", "true")
            .env("ZSH_TMUX_AUTOSTART", "false")
            .spawn()
            .ok()?;

        let mut stdout = child.stdout.take()?;
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stdout.read_to_string(&mut buf);
            let _ = tx.send(buf);
        });

        let deadline = Instant::now() + timeout;
        let killed = loop {
            match child.try_wait() {
                Ok(Some(_)) => break false,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break true;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break true;
                }
            }
        };

        let out = rx.recv_timeout(Duration::from_secs(1)).ok();
        let _ = reader.join();
        if killed {
            tracing::warn!(
                target: "ferrisscope::startup",
                "path: login-shell capture timed out after {}s — using fallback",
                timeout.as_secs()
            );
            return None;
        }
        out
    }

    /// Whether `p` is a regular file with any execute bit set.
    fn is_executable(p: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && (m.permissions().mode() & 0o111 != 0))
            .unwrap_or(false)
    }

    /// Remove ANSI CSI escape sequences (`ESC [ … final-byte`). UTF-8 safe.
    fn strip_ansi(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\u{1b}' {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                continue;
            }
            out.push(c);
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn p(s: &str) -> PathBuf {
            PathBuf::from(s)
        }

        #[test]
        fn parse_extracts_path_between_sentinels() {
            let out = format!(
                "oh-my-zsh loading…\nMOTD banner\n{PATH_START}USER=me\n\
                 PATH=/opt/homebrew/bin:/usr/bin:/bin\nSHELL=/bin/zsh\n{PATH_END}\n"
            );
            let dirs = parse_shell_path(&out).expect("should parse");
            assert_eq!(dirs, vec![p("/opt/homebrew/bin"), p("/usr/bin"), p("/bin")]);
        }

        #[test]
        fn parse_strips_ansi() {
            let out = format!("{PATH_START}PATH=/usr/\x1b[0mbin:/bin{PATH_END}");
            let dirs = parse_shell_path(&out).expect("parse");
            assert_eq!(dirs, vec![p("/usr/bin"), p("/bin")]);
        }

        #[test]
        fn parse_none_without_end_sentinel() {
            // Child killed mid-output → no end marker → fall back.
            let out = format!("{PATH_START}PATH=/usr/bin:/bin\n");
            assert!(parse_shell_path(&out).is_none());
        }

        #[test]
        fn parse_none_without_path_line() {
            let out = format!("{PATH_START}USER=me\nSHELL=/bin/zsh\n{PATH_END}");
            assert!(parse_shell_path(&out).is_none());
        }

        #[test]
        fn parse_shell_env_extracts_all_pairs() {
            let out = format!(
                "banner noise\n{PATH_START}USER=me\n\
                 PATH=/opt/homebrew/bin:/usr/bin\n\
                 AWS_PROFILE=prod\nHTTPS_PROXY=http://proxy:8080\n\
                 not an env line\nfoo = spaced\n{PATH_END}\n"
            );
            let env = parse_shell_env(&out).expect("parse env");
            assert!(env.contains(&("USER".to_string(), "me".to_string())));
            assert!(env.contains(&("AWS_PROFILE".to_string(), "prod".to_string())));
            assert!(env.contains(&("HTTPS_PROXY".to_string(), "http://proxy:8080".to_string())));
            // "foo = spaced" has a space before '=' → key "foo " is not a valid
            // identifier → skipped.
            assert!(!env.iter().any(|(k, _)| k == "foo " || k == "foo"));
        }

        #[test]
        fn parse_shell_env_none_without_markers() {
            assert!(parse_shell_env("PATH=/usr/bin\nAWS_PROFILE=x").is_none());
        }

        #[test]
        fn env_whitelist_matches_exact_and_prefix() {
            assert!(is_whitelisted_env("HOME"));
            assert!(is_whitelisted_env("KUBECONFIG"));
            assert!(is_whitelisted_env("HTTPS_PROXY"));
            assert!(is_whitelisted_env("AWS_PROFILE"));
            assert!(is_whitelisted_env("CLOUDSDK_CONFIG"));
            assert!(is_whitelisted_env("GOOGLE_APPLICATION_CREDENTIALS"));
            assert!(is_whitelisted_env("AZURE_CONFIG_DIR"));
            // Not whitelisted — locale, shell identity, arbitrary vars.
            assert!(!is_whitelisted_env("LANG"));
            assert!(!is_whitelisted_env("USER"));
            assert!(!is_whitelisted_env("EDITOR"));
        }

        #[test]
        fn select_env_vars_filters_path_present_and_non_whitelisted() {
            let captured = vec![
                ("PATH".to_string(), "/should/not/leak".to_string()),
                ("AWS_PROFILE".to_string(), "prod".to_string()),
                ("AWS_REGION".to_string(), "us-east-1".to_string()),
                ("HOME".to_string(), "/home/shell".to_string()),
                ("EDITOR".to_string(), "vim".to_string()),
            ];
            // HOME is already set in the launch env → must be skipped (launch wins).
            let already_set = |k: &str| k == "HOME";
            let got = select_env_vars(&captured, already_set);
            let keys: Vec<&str> = got.iter().map(|(k, _)| k.as_str()).collect();
            assert!(keys.contains(&"AWS_PROFILE"));
            assert!(keys.contains(&"AWS_REGION"));
            assert!(!keys.contains(&"PATH")); // never synced here
            assert!(!keys.contains(&"HOME")); // already set
            assert!(!keys.contains(&"EDITOR")); // not whitelisted
        }

        #[test]
        fn is_env_key_rejects_garbage() {
            assert!(is_env_key("AWS_PROFILE"));
            assert!(is_env_key("_FOO"));
            assert!(!is_env_key(""));
            assert!(!is_env_key("1ABC"));
            assert!(!is_env_key("foo "));
            assert!(!is_env_key("a-b"));
        }

        #[test]
        fn stripped_path_is_not_rich() {
            let minimal = vec![p("/usr/bin"), p("/bin"), p("/usr/sbin"), p("/sbin")];
            assert!(!path_looks_rich(&minimal));
        }

        #[test]
        fn homebrew_and_gcloud_paths_are_rich() {
            assert!(path_looks_rich(&[p("/usr/bin"), p("/opt/homebrew/bin")]));
            assert!(path_looks_rich(&[p("/Users/me/.local/bin")]));
            assert!(path_looks_rich(&[p("/Users/me/google-cloud-sdk/bin")]));
            assert!(path_looks_rich(&[p("/home/linuxbrew/.linuxbrew/bin")]));
        }

        #[test]
        fn picks_posix_shell_env_when_present() {
            let got = pick_capture_shell(Some("/bin/zsh"), |path| path == Path::new("/bin/zsh"));
            assert_eq!(got, Some(p("/bin/zsh")));
        }

        #[test]
        fn falls_back_for_non_posix_shell() {
            // fish isn't POSIX → ignore $SHELL, fall back to a standard shell.
            let got = pick_capture_shell(Some("/opt/homebrew/bin/fish"), |path| {
                path == Path::new("/bin/zsh") || path == Path::new("/bin/bash")
            });
            assert_eq!(got, Some(p("/bin/zsh")));
        }

        #[test]
        fn falls_back_when_shell_unset() {
            let got = pick_capture_shell(None, |path| path == Path::new("/bin/bash"));
            assert_eq!(got, Some(p("/bin/bash")));
        }

        #[test]
        fn none_when_no_shell_available() {
            assert_eq!(pick_capture_shell(Some("/bin/zsh"), |_| false), None);
        }

        #[test]
        fn merge_captured_first_then_existing_then_curated() {
            let captured = vec![p("/opt/homebrew/bin"), p("/usr/bin")];
            let existing = vec![p("/usr/bin"), p("/bin")];
            let curated = vec![
                (p("/Users/me/google-cloud-sdk/bin"), false),
                (p("/managed/bin"), true),
                (p("/does/not/exist"), false),
            ];
            let exists = |x: &Path| x == Path::new("/Users/me/google-cloud-sdk/bin");
            let (merged, applied) = merge_paths(&captured, &existing, &curated, exists);
            assert_eq!(
                merged,
                vec![
                    p("/opt/homebrew/bin"),
                    p("/usr/bin"),
                    p("/bin"),
                    p("/Users/me/google-cloud-sdk/bin"),
                    p("/managed/bin"),
                ]
            );
            // /usr/bin and /bin were already in `existing` → not "applied".
            assert_eq!(
                applied,
                vec![
                    "/opt/homebrew/bin".to_string(),
                    "/Users/me/google-cloud-sdk/bin".to_string(),
                    "/managed/bin".to_string(),
                ]
            );
        }

        #[test]
        fn merge_skips_missing_curated_and_leaves_path_unchanged() {
            let captured: Vec<PathBuf> = vec![];
            let existing = vec![p("/usr/bin"), p("/bin")];
            let curated = vec![(p("/opt/homebrew/bin"), false)];
            // Homebrew dir doesn't exist → skipped → PATH unchanged.
            let (merged, applied) = merge_paths(&captured, &existing, &curated, |_| false);
            assert_eq!(merged, existing);
            assert!(applied.is_empty());
        }

        #[test]
        fn merge_no_duplicate_when_curated_already_in_captured() {
            let captured = vec![p("/opt/homebrew/bin")];
            let existing = vec![p("/usr/bin")];
            let curated = vec![(p("/opt/homebrew/bin"), false)];
            let (merged, _) = merge_paths(&captured, &existing, &curated, |_| true);
            assert_eq!(merged, vec![p("/opt/homebrew/bin"), p("/usr/bin")]);
        }

        #[test]
        fn strip_ansi_removes_csi() {
            assert_eq!(strip_ansi("\x1b[1;32mhi\x1b[0m"), "hi");
            assert_eq!(strip_ansi("plain"), "plain");
        }

        #[test]
        fn curated_dirs_cover_brew_cask_gcloud_sdk_bin() {
            // The Homebrew-cask gcloud SDK puts `gke-gcloud-auth-plugin` in the
            // SDK's own `bin` (never symlinked into `{prefix}/bin`). Apple
            // Silicon installs under `/opt/homebrew` — the dir that was missing
            // and caused the GKE "auth exec: No such file or directory" failure
            // even after a clean brew install. Both arches + both cask names
            // (`google-cloud-sdk` → `gcloud-cli`) must be covered.
            let dirs: Vec<PathBuf> = curated_dirs().into_iter().map(|(p, _)| p).collect();
            for want in [
                "/opt/homebrew/share/google-cloud-sdk/bin",
                "/usr/local/share/google-cloud-sdk/bin",
                "/opt/homebrew/Caskroom/gcloud-cli/latest/google-cloud-sdk/bin",
                "/usr/local/Caskroom/gcloud-cli/latest/google-cloud-sdk/bin",
            ] {
                assert!(
                    dirs.contains(&PathBuf::from(want)),
                    "curated_dirs() should include {want}; got {dirs:?}"
                );
            }
        }
    }
}
