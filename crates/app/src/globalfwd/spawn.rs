//! Spawn the privileged helper **elevated**, set up its IPC endpoint, and
//! connect+handshake. One prompt per app session (the helper is long-lived).
//!
//! Elevation primitive per platform:
//! - **Linux** — `pkexec` (polkit GUI prompt).
//! - **macOS** — `osascript … with administrator privileges`.
//! - **Windows** — PowerShell `Start-Process -Verb RunAs -Wait` (UAC).
//!
//! None of these forward stdin to the elevated child, and an unprivileged
//! parent can't signal a root child — so parent-death/teardown rides on the app
//! closing the single IPC control connection (the helper exits the moment it
//! drops). See `crates/helper/src/lib.rs`.
//!
//! The elevated binary only execs *after* the user clears the prompt, so the
//! connect loop is human-paced: it retries until the endpoint becomes
//! connectable, the elevation child exits (cancel / auth fail), or
//! [`ELEVATION_CONNECT_TIMEOUT`] elapses. A short fixed deadline here is the bug
//! that surfaces as "failed to connect to IPC" while the password box is still
//! open.
//!
//! The token is a fresh per-spawn secret; combined with an owner-only socket
//! directory it is the auth boundary.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tokio::process::{Child, Command};

use crate::globalfwd::client::HelperClient;

pub(crate) struct SpawnedHelper {
    /// The elevation child (pkexec/osascript/powershell). Kept so we can attempt
    /// to kill it on shutdown — though an unprivileged parent generally can't
    /// signal a root child, so the real teardown trigger is the app closing the
    /// IPC connection (the helper exits when its control connection drops).
    pub(crate) child: Child,
    pub(crate) client: HelperClient,
}

/// Path to the binary to elevate. The helper is embedded in *this* binary as a
/// multi-call subcommand, so we relaunch our own executable with [`HELPER_ARG`].
/// `FERRISSCOPE_HELPER_BIN` overrides it (dev: point at a standalone
/// `cargo build`-ed `ferrisscope-helper`).
fn resolve_helper_bin() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("FERRISSCOPE_HELPER_BIN") {
        return Ok(PathBuf::from(p));
    }
    std::env::current_exe().context("resolving current executable for helper relaunch")
}

/// Args for the elevated relaunch. When relaunching our own binary we prepend
/// the [`HELPER_ARG`] marker; the standalone override binary takes only the
/// flags (its `main` parses from argv[1]).
///
/// The token is passed by **file path**, never inline: a root child's argv is
/// world-readable via `/proc/PID/cmdline` (and `ps`), so an inline `--token`
/// would leak the auth secret to every local user. The file lives in the
/// owner-only (0700) runtime dir and is 0600; the helper reads and unlinks it.
fn helper_args(
    endpoint: &str,
    token_file: &Path,
    hosts_backup: &Path,
    embedded: bool,
) -> Vec<String> {
    let mut args = Vec::new();
    if embedded {
        args.push(crate::globalfwd::HELPER_ARG.to_string());
    }
    args.extend([
        "--endpoint".into(),
        endpoint.into(),
        "--token-file".into(),
        token_file.display().to_string(),
        "--hosts-backup".into(),
        hosts_backup.display().to_string(),
    ]);
    args
}

/// Create a directory fail-closed at mode 0700 and *verify* it. The helper
/// socket is created world-writable (0666) by the root helper; its only access
/// control is this parent directory. A silently-failed chmod (the old
/// `set_permissions(...).ok()`) would expose the socket to other local uids, so
/// we refuse to proceed unless the directory is provably 0700 and owned by us.
#[cfg(unix)]
fn ensure_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if dir.exists() {
        // Pre-existing (e.g. `$XDG_RUNTIME_DIR/ferrisscope` from a prior run):
        // tighten in case it was created with a looser umask. `chmod` only
        // succeeds for the owner, so a directory planted by another uid is
        // rejected here with `EPERM` rather than silently trusted.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("setting 0700 on {}", dir.display()))?;
    } else {
        // `mode(0o700)` is applied atomically by `mkdir`; 0700 has no group/other
        // bits, so no umask can loosen it.
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .with_context(|| format!("creating {}", dir.display()))?;
    }
    // Fail closed: prove the directory is 0700 before we trust it to gate the
    // world-writable socket.
    let mode = std::fs::metadata(dir)
        .with_context(|| format!("stat {}", dir.display()))?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o700 {
        bail!(
            "refusing to use runtime dir {} with mode {mode:o} (need 0700): \
             the helper socket would be reachable by other local users",
            dir.display()
        );
    }
    Ok(())
}

/// Write the one-time token to `path` at 0600 (unix) so only the owner — and
/// root, who runs the helper — can read it.
#[cfg(unix)]
fn write_token_file(path: &Path, token: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("creating token file {}", path.display()))?;
    f.write_all(token.as_bytes())
        .with_context(|| format!("writing token file {}", path.display()))?;
    Ok(())
}

/// Windows: the token file lives in the per-user config dir, whose ACL already
/// restricts it to the current user; the elevated (high-IL) helper can still
/// read it. The per-spawn token gates the handshake regardless of file ACLs.
#[cfg(windows)]
fn write_token_file(path: &Path, token: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, token).with_context(|| format!("writing token file {}", path.display()))
}

/// Spawn + connect. `runtime_dir` is a user-private directory for the socket;
/// `config_dir` holds the hosts backup.
pub(crate) async fn spawn(runtime_dir: &Path, config_dir: &Path) -> Result<SpawnedHelper> {
    let token = uuid::Uuid::new_v4().to_string();
    let hosts_backup = config_dir.join("hosts.backup");
    let bin = resolve_helper_bin()?;
    // Embedded (the common case): relaunch our own binary with the marker. Only
    // a `FERRISSCOPE_HELPER_BIN` override targets a standalone helper binary.
    let embedded = std::env::var_os("FERRISSCOPE_HELPER_BIN").is_none();

    #[cfg(unix)]
    let (endpoint, token_file, mut command) = {
        // Owner-only socket directory, created fail-closed: this is the socket's
        // only access control (see `ensure_private_dir`).
        ensure_private_dir(runtime_dir)?;
        let sock = runtime_dir.join("helper.sock");
        let endpoint = sock.display().to_string();
        // A `sockaddr_un.sun_path` caps near 104 bytes. Fail with a clear
        // message rather than a cryptic bind error on a pathological home path
        // (the runtime dir is already short on macOS — see `default_runtime_dir`
        // — and `$XDG_RUNTIME_DIR` on Linux).
        if endpoint.len() >= 104 {
            bail!(
                "helper socket path too long ({} bytes, max ~104): {endpoint}",
                endpoint.len()
            );
        }
        let token_file = runtime_dir.join("helper.token");
        write_token_file(&token_file, &token)?;
        let args = helper_args(&endpoint, &token_file, &hosts_backup, embedded);
        let cmd = build_command(&bin, &args)?;
        (endpoint, token_file, cmd)
    };

    #[cfg(windows)]
    let (endpoint, token_file, mut command) = {
        let _ = runtime_dir;
        let endpoint = format!(r"\\.\pipe\ferrisscope-helper-{}", uuid::Uuid::new_v4());
        let token_file = config_dir.join("helper.token");
        write_token_file(&token_file, &token)?;
        let args = helper_args(&endpoint, &token_file, &hosts_backup, embedded);
        let cmd = build_command(&bin, &args)?;
        (endpoint, token_file, cmd)
    };

    let mut child = command
        .spawn()
        .with_context(|| format!("spawning elevated helper {}", bin.display()))?;

    // Connect + handshake. The helper reads the token file at startup, *before*
    // its socket/pipe becomes connectable, so once `connect_with_retry` succeeds
    // the token file has already been consumed — we can drop our copy below
    // regardless of outcome (the helper also unlinks it on read).
    let connected = async {
        let (stream, ctl_fd) = connect_with_retry(&endpoint, &mut child)
            .await
            .context("connecting to helper IPC endpoint")?;
        HelperClient::handshake(stream, &token, ctl_fd)
            .await
            .context("helper handshake")
    }
    .await;

    let _ = std::fs::remove_file(&token_file);

    match connected {
        Ok(client) => Ok(SpawnedHelper { child, client }),
        Err(e) => {
            // Don't leave the elevated child (or its pkexec/osascript/runas
            // wrapper) lingering after a failed connect/handshake. Best-effort:
            // we may lack permission to signal a root child directly, but the
            // unprivileged launcher wrapper is ours to kill, and the helper also
            // self-exits once this control connection never materialises.
            let _ = child.start_kill();
            Err(e)
        }
    }
}

#[cfg(target_os = "linux")]
fn build_command(bin: &Path, args: &[String]) -> Result<Command> {
    // pkexec runs the program as root after a polkit prompt. It stays alive as
    // the parent of the root child, so its exit is our "prompt cancelled" signal.
    let mut cmd = Command::new("pkexec");
    cmd.arg(bin).args(args);
    Ok(cmd)
}

#[cfg(target_os = "macos")]
fn build_command(bin: &Path, args: &[String]) -> Result<Command> {
    // osascript elevates via the standard macOS auth dialog. Build a shell
    // command string; quote each token for the embedded AppleScript string.
    let mut shell = shell_quote(&bin.display().to_string());
    for a in args {
        shell.push(' ');
        shell.push_str(&shell_quote(a));
    }
    // Escape for the AppleScript double-quoted string literal.
    let escaped = shell.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{escaped}\" with administrator privileges");
    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg(script);
    Ok(cmd)
}

#[cfg(target_os = "windows")]
fn build_command(bin: &Path, args: &[String]) -> Result<Command> {
    // PowerShell Start-Process -Verb RunAs triggers UAC.
    let arg_list = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    // `-Wait` keeps this PowerShell process alive until the elevated helper
    // exits, so `child.try_wait()` is a valid "UAC declined / helper gone"
    // signal in `connect_with_retry`. Without it Start-Process returns
    // immediately and we'd misread the launch as a failed elevation.
    let ps = format!(
        "Start-Process -Verb RunAs -Wait -FilePath '{}' -ArgumentList {}",
        bin.display().to_string().replace('\'', "''"),
        arg_list
    );
    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile").arg("-Command").arg(ps);
    Ok(cmd)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn build_command(_bin: &Path, _args: &[String]) -> Result<Command> {
    bail!("elevation is not supported on this platform")
}

#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    // Single-quote for the shell; close/escape embedded single quotes.
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Upper bound on how long we wait for the helper's endpoint to become
/// connectable. The helper binary only starts *after* the user clears the
/// elevation prompt, which is human-paced — so this has to comfortably cover
/// someone fishing a password out of a manager, not just the helper's own
/// startup. We bail early the moment the elevation child exits (cancel / auth
/// fail), so this ceiling is only reached if the prompt is left untouched.
const ELEVATION_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Poll interval between connect attempts while the prompt is up.
const CONNECT_POLL: std::time::Duration = std::time::Duration::from_millis(120);

#[cfg(unix)]
async fn connect_with_retry(
    endpoint: &str,
    child: &mut Child,
) -> Result<(Box<dyn crate::globalfwd::client::Transport>, Option<i32>)> {
    use std::os::fd::AsRawFd;
    use tokio::net::UnixStream;
    let deadline = std::time::Instant::now() + ELEVATION_CONNECT_TIMEOUT;
    loop {
        if let Ok(s) = UnixStream::connect(endpoint).await {
            // Keep the raw fd for SCM_RIGHTS fd passing (BindListener).
            let fd = s.as_raw_fd();
            return Ok((Box::new(s), Some(fd)));
        }
        // The helper only binds its socket *after* elevation succeeds, so a
        // failed connect is expected while the prompt is up. But if the
        // elevation child has exited, the prompt was cancelled / auth failed (or
        // the binary couldn't exec) — stop waiting and surface it instead of
        // spinning for the full ceiling.
        if let Some(status) = child.try_wait().context("polling elevation child")? {
            bail!(
                "elevation exited before the helper became reachable (status: {status}); \
                 the password prompt was likely cancelled or authentication failed"
            );
        }
        if std::time::Instant::now() >= deadline {
            bail!(
                "helper socket never became connectable within {}s",
                ELEVATION_CONNECT_TIMEOUT.as_secs()
            );
        }
        tokio::time::sleep(CONNECT_POLL).await;
    }
}

#[cfg(windows)]
async fn connect_with_retry(
    endpoint: &str,
    child: &mut Child,
) -> Result<(Box<dyn crate::globalfwd::client::Transport>, Option<i32>)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let deadline = std::time::Instant::now() + ELEVATION_CONNECT_TIMEOUT;
    loop {
        if let Ok(s) = ClientOptions::new().open(endpoint) {
            // Named pipes don't do SCM_RIGHTS; no fd to carry (and BindListener
            // is never used on Windows).
            return Ok((Box::new(s), None));
        }
        // `Start-Process -Wait` keeps the PowerShell child alive for the
        // helper's whole lifetime, so its exit before we connect means UAC was
        // declined (or the launch failed) — bail rather than spin.
        if let Some(status) = child.try_wait().context("polling elevation child")? {
            bail!(
                "elevation exited before the helper became reachable (status: {status}); \
                 the UAC prompt was likely declined"
            );
        }
        if std::time::Instant::now() >= deadline {
            bail!(
                "helper pipe never became connectable within {}s",
                ELEVATION_CONNECT_TIMEOUT.as_secs()
            );
        }
        tokio::time::sleep(CONNECT_POLL).await;
    }
}
