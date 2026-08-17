//! PTY-backed terminal sessions.
//!
//! Each session owns a `portable_pty::PtyPair` driving either:
//!   * the user's local shell with KUBECONFIG pointed at a scratch override
//!     merged with the source kubeconfig, current-context pinned to the
//!     active cluster, or
//!   * a `kubectl exec` against a pod (Pod / Node terminal entry points)
//!     against that same kubeconfig.
//!
//! Output bytes flow over a `tauri::ipc::Channel<TerminalEvent>` supplied by
//! the frontend at `terminal_open_*` time — one channel per session, no
//! global event bus, no string-keyed dispatch. Data chunks are base64 so the
//! payload remains JSON-safe (Tauri's Channel still goes through serde).
//! Exit is signalled with the same channel as a typed `Exit` variant.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub(crate) enum SpawnSpec {
    Shell {
        kubeconfig_path: PathBuf,
        context_name: String,
        default_namespace: Option<String>,
    },
    Exec {
        kubeconfig_path: PathBuf,
        context_name: String,
        namespace: String,
        pod: String,
        container: Option<String>,
        command: Vec<String>,
    },
    /// Run `kubectl <args>` against the scratch kubeconfig. Generic enough
    /// to cover node-debug (`kubectl debug node/<n> -it --image=…`) without
    /// adding a third per-mode branch.
    Kubectl {
        kubeconfig_path: PathBuf,
        context_name: String,
        default_namespace: Option<String>,
        args: Vec<String>,
        /// Optional partial container spec JSON. `kubectl debug --custom`
        /// expects a file path, not inline JSON, so we accept the spec as
        /// a string and write it to a temp file scoped to this session,
        /// then append `--custom=<path>` to the command. Cleaned up with
        /// the scratch kubeconfig when the session closes.
        custom_profile: Option<String>,
        /// Optional pod to delete when the session is closed. Used by node
        /// debug — kubectl debug leaves the debug pod behind on exit, so we
        /// own its lifecycle and tear it down with the terminal tab.
        cleanup: Option<PodCleanup>,
    },
    /// Run `gcloud auth login` to renew a lapsed cloud session.
    ///
    /// The only spec that touches no cluster and writes no scratch kubeconfig:
    /// it exists precisely because the *connect* failed, so there is nothing to
    /// point a kubeconfig at. It runs in a PTY for the same reason the operator
    /// has to run it in a terminal by hand — gcloud refuses to perform an
    /// identity challenge without one.
    CloudLogin {
        /// Account to renew. `None` renews whichever one gcloud has active,
        /// matching an unpinned context's behaviour. Validated at the command
        /// boundary before it reaches this argv.
        account: Option<String>,
    },
}

/// Resource the terminal session owns and must delete when it closes. Today
/// this only describes pods (the only thing we auto-create alongside a
/// session); broaden the variant to an enum if we ever spawn other kinds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PodCleanup {
    pub(crate) cluster_id: String,
    pub(crate) namespace: String,
    pub(crate) name: String,
}

/// Event payload sent over the per-session `Channel<TerminalEvent>`. Tagged
/// (`{ kind: "data", b64 }` / `{ kind: "exit", code }`) so the frontend can
/// dispatch on `kind` — same shape convention as `LogEvent`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum TerminalEvent {
    Data { b64: String },
    Exit { code: i32 },
}

pub(crate) struct Session {
    /// Composite cluster id (`ContextInfo::id`) that owns this session —
    /// recorded so a cluster disconnect can close every terminal it owns
    /// (`close_terminals_for_cluster`). For kubectl-debug sessions this is
    /// the same id carried in `cleanup`, but plain Shell / Exec sessions have
    /// no cleanup pod, so this field is their only owner record. It's the id
    /// passed to every `terminal_open_*` command, so the values match the one
    /// `drop_cluster_watchers` is invoked with.
    cluster_id: String,
    master: StdMutex<Box<dyn MasterPty + Send>>,
    writer: StdMutex<Box<dyn Write + Send>>,
    child: StdMutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Scratch files (override kubeconfig, custom-profile JSON, etc.) the
    /// session created and must clean up on close. The merged kubeconfig env
    /// value (override:source) is exported to the child; the file paths
    /// here are just what we created on disk.
    scratch_files: Vec<PathBuf>,
    /// Resource to delete when the session ends. `take`n by `close` so the
    /// caller can run the actual delete with a kube Client; `Drop` doesn't
    /// have async access, so cleanup is a deliberate two-step (registry
    /// returns the descriptor, the command layer fires the delete).
    cleanup: StdMutex<Option<PodCleanup>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        for p in self.scratch_files.drain(..) {
            let _ = std::fs::remove_file(p);
        }
    }
}

impl Session {
    fn write_bytes(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|_| std::io::Error::other("writer poisoned"))?;
        w.write_all(bytes)?;
        w.flush()
    }

    fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        let m = self
            .master
            .lock()
            .map_err(|_| std::io::Error::other("master poisoned"))?;
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| std::io::Error::other(e.to_string()))
    }

    /// Force-kill the PTY child now. Same mechanism as `Session::Drop`, but
    /// callable while other `Arc<Session>` clones are still alive — notably
    /// the output reader thread, which holds a clone until its next read sees
    /// EOF. On a backend-initiated close (cluster disconnect) the frontend may
    /// not have dropped its event channel yet, so `Drop` wouldn't fire and a
    /// plain local shell would keep running; killing the child makes the
    /// reader's next read return EOF, so it exits and releases its clone.
    fn kill_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub(crate) struct TerminalRegistry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalRegistry {
    pub(crate) async fn count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// `extras` is a list of scratch files the caller created on the session's
    /// behalf (e.g. an SSH-tunneled kubeconfig). They get appended to the
    /// session's cleanup list and are removed when the session closes.
    ///
    /// `on_event` is the per-session sink the frontend bound at command-invoke
    /// time. The reader thread sends `TerminalEvent::Data` for every PTY
    /// chunk and a final `TerminalEvent::Exit` when the child closes. If the
    /// channel send fails (frontend dropped, tab unmounted), the reader
    /// stops — there's nothing useful to do with bytes nobody is listening for.
    pub(crate) async fn spawn_with_extras(
        &self,
        cluster_id: String,
        on_event: tauri::ipc::Channel<TerminalEvent>,
        spec: SpawnSpec,
        extras: Vec<PathBuf>,
    ) -> Result<String, String> {
        let id = format!("t{}", SESSION_SEQ.fetch_add(1, Ordering::Relaxed));

        let (cmd, mut scratch_files) = build_command(&id, &spec)?;
        scratch_files.extend(extras);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;
        // Drop the slave so master reads see EOF when the child exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {e}"))?;

        let cleanup = match &spec {
            SpawnSpec::Kubectl { cleanup, .. } => cleanup.clone(),
            _ => None,
        };
        let session = Arc::new(Session {
            cluster_id,
            master: StdMutex::new(pair.master),
            writer: StdMutex::new(writer),
            child: StdMutex::new(child),
            scratch_files,
            cleanup: StdMutex::new(cleanup),
        });

        let id_for_reader = id.clone();
        let session_for_reader = Arc::clone(&session);
        std::thread::spawn(move || {
            forward_output(&on_event, &id_for_reader, reader, session_for_reader);
        });

        self.sessions.lock().await.insert(id.clone(), session);
        Ok(id)
    }

    pub(crate) async fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let map = self.sessions.lock().await;
        let s = map.get(id).ok_or_else(|| format!("no session {id}"))?;
        s.write_bytes(bytes).map_err(|e| e.to_string())
    }

    pub(crate) async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().await;
        let s = map.get(id).ok_or_else(|| format!("no session {id}"))?;
        s.resize(cols, rows).map_err(|e| e.to_string())
    }

    pub(crate) async fn close(&self, id: &str) -> Option<PodCleanup> {
        let (removed, remaining) = {
            let mut map = self.sessions.lock().await;
            let removed = map.remove(id);
            (removed, map.len())
        };
        clear_plugin_slot_if_idle(remaining, &plugin_cache_slot());
        removed.and_then(|s| s.cleanup.lock().ok().and_then(|mut g| g.take()))
    }

    /// Close every terminal session owned by `cluster_id` — the cluster-
    /// disconnect counterpart of `close`. Force-kills each session's PTY
    /// child and returns `(closed_count, cleanups)`, where `cleanups` are the
    /// `PodCleanup` descriptors of the closed sessions that own a debug pod.
    /// The registry has no kube `Client`, so (exactly like `close`) the actual
    /// pod delete is a two-step: this returns the descriptors and the command
    /// layer fires the deletes with a live `Client`. Plain shell / exec
    /// sessions are closed + counted but contribute no descriptor.
    pub(crate) async fn close_terminals_for_cluster(
        &self,
        cluster_id: &str,
    ) -> (usize, Vec<PodCleanup>) {
        let (removed, remaining) = {
            let mut map = self.sessions.lock().await;
            let removed = drain_cluster_sessions(&mut map, cluster_id, |s| s.cluster_id.as_str());
            (removed, map.len())
        };
        clear_plugin_slot_if_idle(remaining, &plugin_cache_slot());
        let closed = removed.len();
        let mut cleanups = Vec::new();
        for session in removed {
            session.kill_child();
            if let Some(c) = session.cleanup.lock().ok().and_then(|mut g| g.take()) {
                cleanups.push(c);
            }
        }
        (closed, cleanups)
    }
}

/// Remove and return every value in `map` whose owning cluster (via
/// `cluster_of`) equals `cluster_id`. Pulled out as a free generic so the
/// cluster-selection logic is unit-testable without constructing a real
/// `Session` (which needs a live PTY) — same pattern as
/// `state::retain_other_cluster`. Used by `close_terminals_for_cluster`.
fn drain_cluster_sessions<V>(
    map: &mut HashMap<String, V>,
    cluster_id: &str,
    cluster_of: impl Fn(&V) -> &str,
) -> Vec<V> {
    let ids: Vec<String> = map
        .iter()
        .filter(|(_, v)| cluster_of(v) == cluster_id)
        .map(|(id, _)| id.clone())
        .collect();
    ids.into_iter().filter_map(|id| map.remove(&id)).collect()
}

fn forward_output(
    on_event: &tauri::ipc::Channel<TerminalEvent>,
    id: &str,
    mut reader: Box<dyn Read + Send>,
    session: Arc<Session>,
) {
    let mut buf = vec![0u8; 8192];
    // Capture the actual debug-pod name from kubectl's output. We can't pin
    // it up front: `kubectl debug node/...` ignores `metadata.name` in
    // `--custom` (which only applies to the container spec) and auto-names
    // the pod `node-debugger-<node>-<rand>`. The first line of stdout is
    // `Creating debugging pod <name> with container …` — scrape that and
    // patch the session's cleanup descriptor so close() deletes the right
    // pod instead of a guessed name.
    let needs_capture = session
        .cleanup
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.name.is_empty()))
        .unwrap_or(false);
    let mut scan_buf = if needs_capture {
        Some(String::with_capacity(1024))
    } else {
        None
    };
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(sb) = scan_buf.as_mut() {
                    sb.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some(name) = extract_debug_pod_name(sb) {
                        if let Ok(mut g) = session.cleanup.lock() {
                            if let Some(c) = g.as_mut() {
                                tracing::info!(
                                    %id,
                                    pod = %name,
                                    "captured debug pod name for cleanup"
                                );
                                c.name = name;
                            }
                        }
                        scan_buf = None;
                    } else if sb.len() > 4096 {
                        // Bounded buffer — if the line hasn't appeared in
                        // 4 KB of output it never will (kubectl emits it
                        // immediately). Stop scanning to keep memory flat.
                        scan_buf = None;
                    }
                }
                let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                if let Err(e) = on_event.send(TerminalEvent::Data { b64 }) {
                    // Frontend dropped the channel (tab unmounted, window
                    // closed). No point reading more bytes — break and let the
                    // PTY's child get cleaned up via Session::Drop.
                    tracing::debug!(error = %e, %id, "terminal channel send failed; reader exiting");
                    return;
                }
            }
            Err(e) => {
                tracing::debug!(?e, %id, "pty read ended");
                break;
            }
        }
    }
    let _ = on_event.send(TerminalEvent::Exit { code: 0 });
}

fn extract_debug_pod_name(s: &str) -> Option<String> {
    let needle = "Creating debugging pod ";
    let idx = s.find(needle)?;
    let after = &s[idx + needle.len()..];
    let end = after.find(|c: char| c.is_whitespace())?;
    let name = &after[..end];
    if name.is_empty() {
        None
    } else {
        Some(name.to_owned())
    }
}

/// Pick a sensible default interactive shell for the host. Honours `SHELL`
/// when set (which is universal on Unix and accurate on macOS), and falls
/// back to per-platform defaults that we know exist:
///   * Unix: `/bin/bash` then `/bin/sh` (busybox / minimal containers).
///   * Windows: PowerShell 7 (`pwsh.exe`) → Windows PowerShell
///     (`powershell.exe`) → cmd. PowerShell renders xterm sequences
///     correctly via the system Console host, so it's a strictly nicer
///     default than cmd. We rely on `CommandBuilder::new` resolving via
///     `%PATH%` so we don't have to hard-code system32 paths.
fn pick_default_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.trim().is_empty() {
            return s;
        }
    }
    // cfg'd `let` (not two cfg'd blocks) so each target has a genuine tail
    // expression — no `return` for clippy to flag as needless when the other
    // branch is cfg'd out.
    #[cfg(target_os = "windows")]
    let shell = {
        let mut found = None;
        for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
            if which_on_path(candidate).is_some() {
                found = Some(candidate.to_owned());
                break;
            }
        }
        // Last-resort absolute path so we never surface "/bin/bash" on
        // Windows even when %PATH% is empty (it isn't, but defence in
        // depth — cmd.exe always lives at this path on every supported
        // Windows version).
        found.unwrap_or_else(|| r"C:\Windows\System32\cmd.exe".to_owned())
    };
    #[cfg(not(target_os = "windows"))]
    let shell = {
        let mut found = None;
        for candidate in ["/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                found = Some(candidate.to_owned());
                break;
            }
        }
        // /bin/sh is mandated by POSIX; if missing, surfacing the error
        // from spawn is more useful than papering over it.
        found.unwrap_or_else(|| "/bin/sh".to_owned())
    };
    shell
}

#[cfg(target_os = "windows")]
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn build_command(id: &str, spec: &SpawnSpec) -> Result<(CommandBuilder, Vec<PathBuf>), String> {
    match spec {
        SpawnSpec::Shell {
            kubeconfig_path,
            context_name,
            default_namespace,
        } => {
            let (override_path, merged_env) = write_scratch_kubeconfig(
                id,
                kubeconfig_path,
                context_name,
                default_namespace.as_deref(),
            )?;
            let shell = pick_default_shell();
            let mut cmd = CommandBuilder::new(shell);
            apply_common_env(&mut cmd, &merged_env, context_name);
            if let Some(home) = directories::UserDirs::new().map(|u| u.home_dir().to_path_buf()) {
                cmd.cwd(home);
            }
            Ok((cmd, vec![override_path]))
        }
        SpawnSpec::Exec {
            kubeconfig_path,
            context_name,
            namespace,
            pod,
            container,
            command,
        } => {
            let (override_path, merged_env) =
                write_scratch_kubeconfig(id, kubeconfig_path, context_name, Some(namespace))?;
            let mut cmd = CommandBuilder::new("kubectl");
            cmd.arg("exec");
            cmd.arg("-it");
            cmd.arg("-n");
            cmd.arg(namespace);
            if let Some(c) = container {
                cmd.arg("-c");
                cmd.arg(c);
            }
            cmd.arg(pod);
            cmd.arg("--");
            if command.is_empty() {
                cmd.arg("sh");
                cmd.arg("-c");
                cmd.arg("command -v bash >/dev/null 2>&1 && exec bash || exec sh");
            } else {
                for a in command {
                    cmd.arg(a);
                }
            }
            apply_common_env(&mut cmd, &merged_env, context_name);
            Ok((cmd, vec![override_path]))
        }
        SpawnSpec::Kubectl {
            kubeconfig_path,
            context_name,
            default_namespace,
            args,
            custom_profile,
            cleanup: _,
        } => {
            let (override_path, merged_env) = write_scratch_kubeconfig(
                id,
                kubeconfig_path,
                context_name,
                default_namespace.as_deref(),
            )?;
            let mut scratch_files = vec![override_path];
            let mut cmd = CommandBuilder::new("kubectl");
            for a in args {
                cmd.arg(a);
            }
            // `kubectl debug --custom` only accepts a file path. Materialise
            // the JSON the caller passed to a temp file so the flag works,
            // and register the file for cleanup with the session.
            if let Some(json) = custom_profile {
                let path = write_scratch_profile(id, json)?;
                cmd.arg(format!("--custom={}", path.display()));
                scratch_files.push(path);
            }
            apply_common_env(&mut cmd, &merged_env, context_name);
            Ok((cmd, scratch_files))
        }
        SpawnSpec::CloudLogin { account } => {
            let mut cmd = CommandBuilder::new("gcloud");
            cmd.arg("auth");
            cmd.arg("login");
            // `--quiet` answers gcloud's own yes/no questions with their
            // defaults. The one that matters: when the account already has
            // credentials — always true here, since its session merely lapsed —
            // gcloud asks "You are already authenticated … continue (Y/n)?".
            // The browser challenge is not a prompt and still runs; without
            // this flag the session would sit on that question instead.
            cmd.arg("--quiet");
            if let Some(account) = account {
                // One argv element, so a leading `-` inside the value cannot
                // become a separate flag. Validated at the command boundary too.
                cmd.arg(format!("--account={account}"));
            }
            apply_login_env(&mut cmd);
            if let Some(home) = directories::UserDirs::new().map(|u| u.home_dir().to_path_buf()) {
                cmd.cwd(home);
            }
            Ok((cmd, Vec::new()))
        }
    }
}

fn write_scratch_profile(id: &str, json: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("ferrisscope-terminal");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create profile dir: {e}"))?;
    let path = dir.join(format!("{id}-profile.json"));
    std::fs::write(&path, json).map_err(|e| format!("write profile {}: {e}", path.display()))?;
    Ok(path)
}

fn apply_common_env(cmd: &mut CommandBuilder, kubeconfig_env: &str, context_name: &str) {
    cmd.env("KUBECONFIG", kubeconfig_env);
    cmd.env("FERRISSCOPE_CONTEXT", context_name);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for key in [
        "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL",
    ] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    cmd.env("PATH", resolved_path());
}

/// PATH for every PTY child: our managed-bin dir first so a managed kubectl
/// (installed via Settings → Tools) wins over anything the parent shell
/// exposes, then the inherited entries. Always set explicitly so children see a
/// deterministic search order regardless of how the operator launched the app.
fn resolved_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    match crate::kubectl_install::managed_bin_dir() {
        Some(dir) if dir.is_dir() => {
            let mut entries = vec![dir];
            entries.extend(std::env::split_paths(&inherited));
            std::env::join_paths(entries)
                .map(|s| s.into_string().unwrap_or(inherited.clone()))
                .unwrap_or(inherited)
        }
        _ => inherited,
    }
}

/// Environment for `gcloud auth login`. Deliberately wider than
/// [`apply_common_env`] in one respect: the whole point of the session is that
/// gcloud opens a **browser**, and `xdg-open` needs the desktop-session
/// variables to find one. Proxy and `CLOUDSDK_*` variables come along because
/// gcloud needs them to reach the token endpoint and to resolve which config
/// directory it is renewing credentials in.
fn apply_login_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for key in [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SHELL",
        // Browser launch.
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "DBUS_SESSION_BUS_ADDRESS",
        "BROWSER",
        // gcloud's own configuration and network reach.
        "CLOUDSDK_CONFIG",
        "CLOUDSDK_PYTHON",
        "CLOUDSDK_ACTIVE_CONFIG_NAME",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
        "no_proxy",
        "REQUESTS_CA_BUNDLE",
        "SSL_CERT_FILE",
    ] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    cmd.env("PATH", resolved_path());
}

/// Write a tiny override kubeconfig that pins `current-context` (and
/// optionally a default namespace), then build a `KUBECONFIG=<override>:<source>`
/// merge string. Returns `(override file path, merged env value)` — the
/// override path is for cleanup, the merged value is what we export to the
/// child.
///
/// When `default_namespace` is set, we emit a complete `contexts:` entry that
/// re-states the source context's `cluster` and `user` along with our
/// namespace. This is non-obvious but load-bearing: kubectl's kubeconfig
/// merge does a *struct-level overwrite* on context entries with matching
/// names — an override that only sets `namespace` ends up clobbering the
/// source's cluster/user with empty strings, which makes kubectl fall back
/// to `localhost:8080` ("connection refused"). Copying cluster/user from the
/// source keeps the merged context complete.
/// Where a session's scratch kubeconfig is written.
///
/// Also decides where any credential plugin the session runs caches its token:
/// `gke-gcloud-auth-plugin` writes beside the kubeconfig it resolves, and the
/// scratch file is first in the session's `KUBECONFIG`. Hence
/// [`plugin_cache_slot`] — the slot is a consequence of this directory, not a
/// separate choice.
fn scratch_dir() -> PathBuf {
    directories::ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map_or_else(std::env::temp_dir, |d| d.cache_dir().to_path_buf())
}

/// The gcloud plugin token cache a terminal session's `kubectl` writes.
///
/// Distinct from both `~/.kube/gke_gcloud_auth_plugin_cache` (the operator's own
/// shell) and the per-identity slots in `ferrisscope_core::exec_auth` (the app's
/// kube clients). Three independent slots, which is what keeps them from
/// evicting each other's tokens — but it also means a cache invalidation has to
/// name each one.
pub(crate) fn plugin_cache_slot() -> PathBuf {
    scratch_dir().join("gke_gcloud_auth_plugin_cache")
}

/// Delete the token cache a terminal session left behind, but only once no
/// session can still be using it.
///
/// A live access token has no business outliving the sessions that minted it,
/// and nothing prunes this directory. Sessions share the slot deliberately — a
/// new tab reuses the warm token instead of paying a fresh `gcloud` round trip —
/// so the delete waits for the last one to close.
pub(crate) fn clear_plugin_slot_if_idle(remaining: usize, path: &Path) {
    if remaining > 0 {
        return;
    }
    clear_plugin_slot(path);
}

/// Delete the slot now, whatever is open.
///
/// For invalidation rather than hygiene: an identity pin must not leave a token
/// minted as the previous identity readable, and an open terminal simply re-mints
/// on its next `kubectl`.
pub(crate) fn clear_plugin_slot(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        // Already gone is the normal case (no plugin ran, or a parallel close
        // beat us). Anything else is worth a line but never worth failing a
        // close over.
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(
                path = %path.display(),
                error = %e,
                "terminal token cache cleanup failed"
            );
        }
    }
}

fn write_scratch_kubeconfig(
    id: &str,
    source: &Path,
    context_name: &str,
    default_namespace: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir cache: {e}"))?;
    let path = dir.join(format!("term-{id}-{}.yaml", std::process::id()));

    let mut doc = serde_yaml::Mapping::new();
    doc.insert(
        serde_yaml::Value::String("apiVersion".into()),
        serde_yaml::Value::String("v1".into()),
    );
    doc.insert(
        serde_yaml::Value::String("kind".into()),
        serde_yaml::Value::String("Config".into()),
    );
    doc.insert(
        serde_yaml::Value::String("current-context".into()),
        serde_yaml::Value::String(context_name.into()),
    );
    if let Some(ns) = default_namespace {
        // Pull the source context's cluster + user so the override entry is
        // complete. Best-effort: if the source can't be parsed or the name
        // doesn't match, we still emit `namespace` alone — that path keeps
        // the previous (broken-on-merge) shape rather than failing the
        // terminal launch outright.
        let (src_cluster, src_user) = source_context_cluster_user(source, context_name);

        let mut ctx_inner = serde_yaml::Mapping::new();
        if let Some(c) = src_cluster {
            ctx_inner.insert(
                serde_yaml::Value::String("cluster".into()),
                serde_yaml::Value::String(c),
            );
        }
        if let Some(u) = src_user {
            ctx_inner.insert(
                serde_yaml::Value::String("user".into()),
                serde_yaml::Value::String(u),
            );
        }
        ctx_inner.insert(
            serde_yaml::Value::String("namespace".into()),
            serde_yaml::Value::String(ns.into()),
        );
        let mut ctx = serde_yaml::Mapping::new();
        ctx.insert(
            serde_yaml::Value::String("name".into()),
            serde_yaml::Value::String(context_name.into()),
        );
        ctx.insert(
            serde_yaml::Value::String("context".into()),
            serde_yaml::Value::Mapping(ctx_inner),
        );
        doc.insert(
            serde_yaml::Value::String("contexts".into()),
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(ctx)]),
        );
    }

    let body = serde_yaml::to_string(&serde_yaml::Value::Mapping(doc))
        .map_err(|e| format!("serialize kubeconfig: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write scratch kubeconfig: {e}"))?;

    let sep = if cfg!(windows) { ';' } else { ':' };
    let merged = format!("{}{}{}", path.display(), sep, source.display());
    Ok((path, merged))
}

/// Look up `(cluster, user)` for `context_name` in the source kubeconfig.
/// Returns `(None, None)` on any parse failure or missing context — callers
/// fall back to emitting an incomplete override (matches the prior behaviour
/// for that edge case).
fn source_context_cluster_user(
    source: &Path,
    context_name: &str,
) -> (Option<String>, Option<String>) {
    let kc = match kube::config::Kubeconfig::read_from(source) {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!(?source, error = %e, "scratch kubeconfig: source parse failed");
            return (None, None);
        }
    };
    for entry in kc.contexts {
        if entry.name == context_name {
            let ctx = match entry.context {
                Some(c) => c,
                None => return (None, None),
            };
            let cluster = if ctx.cluster.is_empty() {
                None
            } else {
                Some(ctx.cluster)
            };
            let user = ctx.user.filter(|u| !u.is_empty());
            return (cluster, user);
        }
    }
    tracing::warn!(?source, %context_name, "scratch kubeconfig: context not found in source");
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::{build_command, SpawnSpec};
    use std::collections::HashMap;

    fn argv(spec: &SpawnSpec) -> Vec<String> {
        let (cmd, scratch) = build_command("t0", spec).expect("build");
        assert!(
            scratch.is_empty(),
            "a login session owns no scratch files to clean up"
        );
        cmd.get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_token_slot_sits_beside_the_scratch_kubeconfig() {
        // Not an arbitrary path: the gcloud plugin caches beside whichever
        // kubeconfig it resolves, and the scratch file is first in the session's
        // KUBECONFIG. If these two ever diverge, cleanup silently stops finding
        // the file it is supposed to remove.
        let slot = super::plugin_cache_slot();
        assert_eq!(slot.parent(), Some(super::scratch_dir().as_path()));
        assert_eq!(
            slot.file_name().and_then(|n| n.to_str()),
            Some("gke_gcloud_auth_plugin_cache")
        );
    }

    #[test]
    fn the_token_slot_survives_a_close_while_other_sessions_hold_it() {
        // Sessions share the slot on purpose — a second tab reuses the warm
        // token instead of paying another gcloud round trip.
        let dir = tempfile::tempdir().expect("tempdir");
        let slot = dir.path().join("gke_gcloud_auth_plugin_cache");
        std::fs::write(&slot, "{}").expect("write");

        super::clear_plugin_slot_if_idle(1, &slot);
        assert!(slot.exists(), "a live session still needs this token");

        super::clear_plugin_slot_if_idle(0, &slot);
        assert!(
            !slot.exists(),
            "an access token must not outlive the last session that could use it"
        );
    }

    #[test]
    fn clearing_an_absent_slot_is_not_an_error() {
        // The common case: no plugin ever ran, or a parallel close won the race.
        let dir = tempfile::tempdir().expect("tempdir");
        super::clear_plugin_slot_if_idle(0, &dir.path().join("never-written"));
        super::clear_plugin_slot(&dir.path().join("never-written"));
    }

    #[test]
    fn an_identity_pin_clears_the_slot_even_with_terminals_open() {
        // Invalidation, not hygiene: after a pin, a token minted as the previous
        // identity must stop being served. An open terminal just re-mints.
        let dir = tempfile::tempdir().expect("tempdir");
        let slot = dir.path().join("gke_gcloud_auth_plugin_cache");
        std::fs::write(&slot, "{}").expect("write");
        super::clear_plugin_slot(&slot);
        assert!(!slot.exists());
    }

    #[test]
    fn cloud_login_runs_gcloud_non_interactively_for_one_account() {
        let args = argv(&SpawnSpec::CloudLogin {
            account: Some("a@example.com".to_owned()),
        });
        assert_eq!(
            args,
            vec![
                "gcloud",
                "auth",
                "login",
                // Without this, gcloud stops on "you are already authenticated,
                // continue (Y/n)?" — always the case here, since the account's
                // session merely lapsed — and the PTY would hang.
                "--quiet",
                "--account=a@example.com",
            ]
        );
    }

    #[test]
    fn cloud_login_without_an_account_renews_the_active_one() {
        let args = argv(&SpawnSpec::CloudLogin { account: None });
        assert_eq!(args, vec!["gcloud", "auth", "login", "--quiet"]);
        assert!(
            !args.iter().any(|a| a.starts_with("--account")),
            "an unpinned context must not have an account invented for it"
        );
    }

    #[test]
    fn an_account_cannot_smuggle_a_second_flag_into_the_argv() {
        // The command boundary validates this value, but the argv shape is the
        // structural guarantee: one element, so `-` inside it is data.
        let args = argv(&SpawnSpec::CloudLogin {
            account: Some("--update-adc x".to_owned()),
        });
        assert_eq!(args.len(), 5);
        assert_eq!(args[4], "--account=--update-adc x");
    }

    #[test]
    fn drain_cluster_sessions_removes_only_named_cluster() {
        // Values stand in for `Arc<Session>`; the selector returns each
        // value's owning cluster id. A real `Session` needs a live PTY, so we
        // exercise the pure selection logic exactly as `state.rs` tests
        // `retain_other_cluster`.
        let mut map: HashMap<String, String> = HashMap::new();
        map.insert("t1".into(), "c1".into());
        map.insert("t2".into(), "c1".into());
        map.insert("t3".into(), "c2".into());

        // Closing c1 drains its two sessions and leaves c2's alone.
        let drained = super::drain_cluster_sessions(&mut map, "c1", |v| v.as_str());
        assert_eq!(drained.len(), 2, "both c1 sessions drained");
        assert_eq!(map.len(), 1, "only c2 left");
        assert!(map.contains_key("t3"));

        // A cluster with no sessions drains nothing and leaves the map intact.
        let none = super::drain_cluster_sessions(&mut map, "c-absent", |v| v.as_str());
        assert!(none.is_empty());
        assert_eq!(map.len(), 1);
    }
}
