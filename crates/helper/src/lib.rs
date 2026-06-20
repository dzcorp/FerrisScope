//! `ferrisscope-helper` — the privileged side of global port-forwarding.
//!
//! Spawned **elevated** (pkexec / osascript / UAC). Speaks the closed IPC
//! protocol from `ferrisscope_core::globalfwd::protocol` over a Unix socket
//! (macOS/Linux) or named pipe (Windows). Creates loopback aliases and edits the
//! system hosts file on request, and tears everything down on `Shutdown`, on the
//! app closing the single IPC control connection (the parent-death signal — no
//! stdin, since elevation doesn't forward it), or on `PurgeStale`.
//!
//! This is a **library** so the main app binary can embed it as a multi-call
//! subcommand (no separate artifact to build/bundle/sign): the app's `main`
//! detects its helper marker arg and calls [`run`], then exits — see
//! `crates/app/src/globalfwd/spawn.rs`. The standalone `ferrisscope-helper`
//! binary (`src/main.rs`) is kept for direct testing.
//!
//! Args (already past any subcommand marker): `--endpoint <socket-or-pipe>
//! --token <secret> --hosts-backup <path> [--hosts-path <path>]`.

mod hosts;
mod netalias;
mod server;
mod state;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use tracing::{info, warn};

use crate::server::Outcome;
use crate::state::HelperState;

struct Args {
    endpoint: String,
    token: String,
    hosts_path: PathBuf,
    hosts_backup: PathBuf,
    /// Optional file the helper appends its tracing to. The helper runs elevated
    /// (osascript/pkexec/UAC), which swallows its stderr — so without this we are
    /// blind to why it wedges or dies. The app passes a path it owns so it can
    /// read the log back.
    log_file: Option<PathBuf>,
}

impl Args {
    fn parse_from<I: IntoIterator<Item = String>>(args: I) -> Result<Self> {
        let mut endpoint = None;
        let mut token = None;
        let mut hosts_path = None;
        let mut hosts_backup = None;
        let mut log_file = None;
        let mut it = args.into_iter();
        while let Some(key) = it.next() {
            let mut val = || it.next().ok_or_else(|| anyhow!("missing value for {key}"));
            match key.as_str() {
                "--endpoint" => endpoint = Some(val()?),
                // Inline token: standalone/debug only (visible in `ps`). Production
                // spawns use `--token-file` so the secret never hits argv.
                "--token" => token = Some(val()?),
                "--token-file" => token = Some(read_token_file(&PathBuf::from(val()?))?),
                "--hosts-path" => hosts_path = Some(PathBuf::from(val()?)),
                "--hosts-backup" => hosts_backup = Some(PathBuf::from(val()?)),
                "--log-file" => log_file = Some(PathBuf::from(val()?)),
                other => return Err(anyhow!("unknown argument: {other}")),
            }
        }
        Ok(Self {
            endpoint: endpoint.ok_or_else(|| anyhow!("--endpoint is required"))?,
            token: token.ok_or_else(|| anyhow!("--token or --token-file is required"))?,
            hosts_path: hosts_path.unwrap_or_else(default_hosts_path),
            hosts_backup: hosts_backup.ok_or_else(|| anyhow!("--hosts-backup is required"))?,
            log_file,
        })
    }
}

fn default_hosts_path() -> PathBuf {
    // cfg'd `let` (not two cfg'd blocks): exactly one binding is active per
    // target, so there's no `return` for clippy to flag and no risk of the
    // function falling off the end when the other branch is cfg'd out.
    #[cfg(windows)]
    let path = {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        PathBuf::from(format!("{root}\\System32\\drivers\\etc\\hosts"))
    };
    #[cfg(not(windows))]
    let path = PathBuf::from("/etc/hosts");
    path
}

fn init_tracing(log_file: Option<&Path>) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    // `try_init` (not `init`): in embedded mode another subscriber might exist;
    // a failure here is harmless — we just won't emit helper logs.
    match log_file {
        // Append to the app-provided file. The helper is spawned elevated, so its
        // stderr goes nowhere visible — the file is our only window into it. Open
        // per-line (the helper logs at human pace, so the cost is irrelevant) and
        // degrade to a sink if the open fails, so logging never aborts the helper.
        Some(path) => {
            let path = path.to_path_buf();
            // Bound growth: the file is append-only across every helper spawn, so
            // without this it would creep up forever. Once past the cap, truncate
            // and start fresh at the next spawn. The cap is generous (the helper
            // emits only a handful of lines per session) so it rarely triggers and
            // recent history survives across spawns until it does.
            const MAX_LOG_BYTES: u64 = 1024 * 1024; // 1 MiB
            if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&path);
            }
            let _ = builder
                .with_ansi(false)
                .with_writer(move || -> Box<dyn std::io::Write> {
                    match std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                    {
                        Ok(f) => Box::new(f),
                        Err(_) => Box::new(std::io::sink()),
                    }
                })
                .try_init();
        }
        None => {
            let _ = builder.with_writer(std::io::stderr).try_init();
        }
    }
}

/// Read the one-time auth token from the file the app wrote (0600, in its
/// owner-only runtime dir), then unlink it so the secret doesn't linger. Passing
/// the token by file rather than on argv keeps it out of `/proc/PID/cmdline`,
/// which is world-readable for this root process. The token is never logged.
fn read_token_file(path: &Path) -> Result<String> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading token file {}", path.display()))?;
    // Best-effort: the app also removes it after the handshake.
    std::fs::remove_file(path).ok();
    let token = raw.trim().to_string();
    if token.is_empty() {
        bail!("token file {} was empty", path.display());
    }
    Ok(token)
}

/// Entry point. `args` is the helper's own arguments (the caller has already
/// stripped argv[0] and any subcommand marker). Builds a runtime and blocks
/// until the helper exits (Shutdown request or parent death).
pub fn run<I: IntoIterator<Item = String>>(args: I) -> Result<()> {
    // Parse before init_tracing so logs land in the app-provided `--log-file`
    // (the elevated helper's stderr is invisible). A parse failure here is rare
    // (our own argv) and surfaces as a non-zero exit the app detects.
    let parsed = Args::parse_from(args)?;
    init_tracing(parsed.log_file.as_deref());
    info!(endpoint = %parsed.endpoint, "helper starting");
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building helper tokio runtime")?;
    rt.block_on(serve(parsed))
}

/// How long to wait for the app to connect before giving up. The app connects
/// within ~3s of spawn; if it never does (it died during the elevation prompt),
/// we exit rather than linger as an orphaned root process.
const FIRST_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn serve(args: Args) -> Result<()> {
    let state = Arc::new(HelperState::new(
        args.token,
        args.hosts_path,
        args.hosts_backup,
    ));
    listen(&args.endpoint, state).await
}

#[cfg(unix)]
async fn listen(endpoint: &str, state: Arc<HelperState>) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let path = std::path::Path::new(endpoint);
    if path.exists() {
        std::fs::remove_file(path).ok();
    }
    let listener = UnixListener::bind(path).with_context(|| format!("binding {endpoint}"))?;
    // The helper runs as root, so the socket inode is root-owned. 0600 would
    // lock out the unprivileged app entirely. Relax to 0666 — access control is
    // the *parent directory*, which the app created 0700 and owns (and on Linux
    // sits under `$XDG_RUNTIME_DIR`, itself 0700-user). Plus the per-spawn token
    // gates the handshake regardless.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666)).ok();
    info!(endpoint, "helper listening");

    use std::os::fd::AsRawFd;
    // The app holds ONE long-lived control connection for the helper's whole
    // lifetime. We keep accepting (within the connect deadline) until a
    // connection completes a *valid* handshake: a probe — or a hostile client
    // that fails the handshake — must not consume the control slot or trip
    // teardown, otherwise a single stray connect would race the app and kill the
    // feature. Once the authenticated connection ends — a graceful `Shutdown`,
    // or the socket dropping because the app exited/crashed — we tear down and
    // exit. The connection drop is the parent-death signal (pkexec/osascript
    // don't forward stdin, and an unprivileged parent can't signal a root child).
    let deadline = std::time::Instant::now() + FIRST_CONNECT_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            warn!("no authorized client connected within timeout; exiting");
            break;
        }
        match tokio::time::timeout(remaining, listener.accept()).await {
            Ok(Ok((stream, _))) => {
                // Raw fd of the control socket: used to pass privileged-port
                // listeners back to the app via SCM_RIGHTS (`BindListener`).
                let ctl_fd = stream.as_raw_fd();
                match server::serve_connection(stream, state.clone(), Some(ctl_fd)).await {
                    Outcome::Rejected => {
                        warn!("rejected unauthenticated connection; still waiting for the app");
                        continue;
                    }
                    Outcome::Shutdown => info!("shutdown requested; exiting"),
                    Outcome::Continue => info!("control connection closed (app exited); exiting"),
                }
                break;
            }
            Ok(Err(e)) => {
                std::fs::remove_file(path).ok();
                return Err(e).context("accept");
            }
            Err(_) => {
                warn!("no authorized client connected within timeout; exiting");
                break;
            }
        }
    }
    server::teardown(&state).await;
    std::fs::remove_file(path).ok();
    Ok(())
}

#[cfg(windows)]
async fn listen(endpoint: &str, state: Arc<HelperState>) -> Result<()> {
    info!(endpoint, "helper listening (named pipe)");
    // The pipe is created with a security descriptor granting the interactive
    // (medium-IL) app access — the helper runs elevated, so a default-secured
    // pipe would deny the unprivileged client. See `ferrisscope-winpipe-ext`.
    let server = ferrisscope_winpipe_ext::create_first_pipe_instance(endpoint)
        .with_context(|| format!("creating named pipe {endpoint}"))?;
    match tokio::time::timeout(FIRST_CONNECT_TIMEOUT, server.connect()).await {
        // Windows named pipes don't do SCM_RIGHTS fd passing, and the app never
        // sends BindListener there (no privileged-port restriction) → `None`.
        Ok(Ok(())) => serve_until_disconnect(server, &state, None).await,
        Ok(Err(e)) => return Err(e).context("named pipe connect"),
        Err(_) => warn!("no client connected within timeout; exiting"),
    }
    Ok(())
}

/// Serve the single control connection, then tear everything down regardless of
/// how it ended. On `Shutdown` the dispatcher already tore down; teardown is
/// idempotent, so the crash path (connection dropped → `Continue`) cleans up
/// the same way.
///
/// Windows only: the named-pipe name is an unguessable per-spawn UUID and the SD
/// + token gate access, so unlike the unix socket we don't loop-accept — a
/// failed handshake (`Rejected`) just exits, same as a closed connection.
#[cfg(windows)]
async fn serve_until_disconnect<S>(
    stream: S,
    state: &Arc<HelperState>,
    ctl_fd: Option<server::CtlFd>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match server::serve_connection(stream, state.clone(), ctl_fd).await {
        Outcome::Shutdown => info!("shutdown requested; exiting"),
        Outcome::Continue => info!("control connection closed (app exited); exiting"),
        Outcome::Rejected => warn!("rejected unauthenticated connection; exiting"),
    }
    server::teardown(state).await;
}
