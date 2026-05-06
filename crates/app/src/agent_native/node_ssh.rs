//! Node-SSH native tool family.
//!
//! Direct SSH from the operator's machine to a Kubernetes node. Three tools —
//! open / exec / close — share a per-chat session table just like the
//! `fs_node_shell_*` family, with one important difference:
//!
//! **This is the fallback path when `fs_node_shell_*` can't get there.** The
//! debug-pod approach needs a working kubelet + scheduler + networking on the
//! target node. When that's broken (kubelet not reporting, container runtime
//! dead, CNI failing, node `NotReady` for hours, scheduler can't place the
//! pod) the agent has no host-shell option. SSH bypasses all of that — it
//! just needs sshd on the node and a key the operator can use.
//!
//! Auth is hard-coded to [`SshAuth::DefaultKeys`] — the same keys the
//! operator's plain `ssh` CLI would try (`~/.ssh/id_ed25519`, `id_ecdsa`,
//! `id_rsa`). No password prompt, no per-call passphrase, no keychain access:
//! if the operator can `ssh user@node` from their terminal, the agent can
//! too. Anything richer (per-source credentials, agent socket, encrypted
//! keys) belongs in a kubeconfig source, not in a triage shortcut.
//!
//! Host-key verification is delegated to [`SshSession`]: `~/.ssh/known_hosts`
//! first, TOFU on first connect (logged at info level, not persisted — every
//! session re-verifies). This matches `ssh -o StrictHostKeyChecking=accept-new`
//! semantics.
//!
//! Address + user defaults come from the Node object itself: prefer
//! `ExternalIP`, fall back to `InternalIP`; user inferred from
//! `node_info.os_image` (`core` for Fedora CoreOS / Flatcar / RHCOS,
//! `ubuntu` / `ec2-user` / `cloud-user` / `admin` for the obvious distros,
//! `root` otherwise). Operator/agent can override any of these.
//!
//! All three tools are classified **Write**: an open SSH session into a
//! production node is exactly the kind of action that warrants the operator
//! confirming with the approval gate.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_core::sources::{SshAuth, SshSourceConfig};
use ferrisscope_core::ssh::SshSession;
use k8s_openapi::api::core::v1::Node;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::state::AppState;

/// Default SSH port. Overridable per call.
const DEFAULT_SSH_PORT: u16 = 22;

/// Cap on captured stdout/stderr per `_exec` call. Mirrors the node-shell
/// 64 KiB budget so the agent's tool-result accounting stays consistent
/// across the two fallback paths. The underlying `SshSession::exec` already
/// caps each stream at 8 MiB to defend the heap; this is the further
/// LLM-transcript cap on top.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Fallback per-call exec timeout. The operator can pass `timeout_seconds`
/// to bound a specific command tighter; SSH itself has its own 10s exec
/// budget inside `SshSession`, but stitching together longer command
/// lifetimes (e.g. journalctl --since=1h) is a normal use case for this
/// fallback path, so the outer timeout is the larger of the two.
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(60);

/// One open node-SSH session.
struct Session {
    /// Live SSH session. Held in `Arc` because `SshSession::open_tunnel` (not
    /// used here, but the type API requires it) takes `&Arc<Self>`; arc-ing
    /// at the table level keeps the type uniform regardless of how a future
    /// caller uses the session.
    ssh: Arc<SshSession>,
    /// User/host/port preserved for diagnostics in `_exec` / `_close` results.
    user: String,
    host: String,
    port: u16,
}

#[derive(Clone, Default)]
pub(crate) struct NodeSshSessions {
    inner: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

impl NodeSshSessions {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    async fn insert(&self, id: String, sess: Arc<Session>) {
        self.inner.lock().await.insert(id, sess);
    }

    async fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.inner.lock().await.get(id).cloned()
    }

    async fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.inner.lock().await.remove(id)
    }

    async fn drain(&self) -> Vec<Arc<Session>> {
        let mut g = self.inner.lock().await;
        g.drain().map(|(_, v)| v).collect()
    }
}

// ─── open ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenArgs {
    /// Node name (`metadata.name` of the Node). Used to look up addresses and
    /// `os_image` when `host` / `user` aren't supplied.
    node: String,
    /// SSH user. If absent, inferred from `node.status.node_info.os_image`.
    #[serde(default)]
    user: Option<String>,
    /// Host or IP. If absent, the first `ExternalIP` from `node.status.addresses`
    /// is used; otherwise the first `InternalIP`. Useful as an override when
    /// the apiserver-reported address isn't reachable from the operator (e.g.
    /// behind a jump-host).
    #[serde(default)]
    host: Option<String>,
    /// Port. Defaults to 22.
    #[serde(default)]
    port: Option<u16>,
}

#[derive(Debug, Serialize)]
struct OpenResult {
    session_id: String,
    node: String,
    user: String,
    host: String,
    port: u16,
    /// `"ExternalIP"`, `"InternalIP"`, or `"explicit"` when the operator
    /// supplied a `host` override.
    address_type: String,
    /// `"sha256:<base64>"` host fingerprint observed during the handshake.
    /// Surfaced so the operator can sanity-check first-connect TOFU. Always
    /// `Some` after a successful connect.
    fingerprint: Option<String>,
}

pub(crate) struct NodeSshOpen {
    app: AppHandle,
    cluster_id: String,
    sessions: NodeSshSessions,
}

impl NodeSshOpen {
    pub(crate) fn new(app: AppHandle, cluster_id: String, sessions: NodeSshSessions) -> Self {
        Self {
            app,
            cluster_id,
            sessions,
        }
    }
}

#[async_trait]
impl NativeTool for NodeSshOpen {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_ssh_open".into(),
            description: "Direct SSH to a node. Fallback to fs_node_shell_open when \
                the debug-pod path is broken (kubelet/scheduler/CNI down, node NotReady). \
                Uses operator's default keys (~/.ssh/id_ed25519|ecdsa|rsa); known_hosts + TOFU. \
                user auto-picked from os_image (core/ubuntu/ec2-user/cloud-user/admin/root); \
                host from addresses (ExternalIP > InternalIP). Always call _close when done."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "node": { "type": "string" },
                    "user": { "type": "string", "description": "Override auto-detected user." },
                    "host": { "type": "string", "description": "Override auto-detected address." },
                    "port": { "type": "integer", "minimum": 1, "maximum": 65535 }
                },
                "required": ["node"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let parsed: OpenArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let port = parsed.port.unwrap_or(DEFAULT_SSH_PORT);

        // Look up the Node only if we need addresses or user inference. If
        // the operator supplied both `host` and `user`, skip the round-trip.
        let need_node_lookup = parsed.host.is_none() || parsed.user.is_none();
        let node_obj = if need_node_lookup {
            let client = client_for(&self.app, &self.cluster_id).await?;
            let api: Api<Node> = Api::all(client);
            Some(
                api.get(&parsed.node)
                    .await
                    .map_err(|e| NativeToolError::msg(format!("get node {}: {e}", parsed.node)))?,
            )
        } else {
            None
        };

        let (host, address_type) = match parsed.host {
            Some(h) => (h, "explicit".to_string()),
            None => pick_address(node_obj.as_ref().expect("looked up above"))?,
        };
        let user = match parsed.user {
            Some(u) => u,
            None => default_user_for_os(node_obj.as_ref().expect("looked up above"))
                .unwrap_or("root")
                .to_string(),
        };

        let cfg = SshSourceConfig {
            host: host.clone(),
            port,
            user: user.clone(),
            auth: SshAuth::DefaultKeys,
            remote_kubeconfig: None,
            known_host_fingerprint: None,
        };
        // `source_id` is only consulted by SshSession for keychain lookups
        // (password / private-key passphrase). DefaultKeys never reads it, so
        // any unique stable string works.
        let source_id = format!("agent-node-ssh-{}", uuid::Uuid::new_v4().simple());
        let session = SshSession::connect(&cfg, &source_id)
            .await
            .map_err(|e| NativeToolError::msg(format!("ssh connect: {e}")))?;
        let fingerprint = session.captured_fingerprint().await;
        let session = Arc::new(session);

        let session_id = format!("nssh-{}", uuid::Uuid::new_v4().simple());
        self.sessions
            .insert(
                session_id.clone(),
                Arc::new(Session {
                    ssh: session,
                    user: user.clone(),
                    host: host.clone(),
                    port,
                }),
            )
            .await;

        Ok(serde_json::to_value(OpenResult {
            session_id,
            node: parsed.node,
            user,
            host,
            port,
            address_type,
            fingerprint,
        })
        .expect("OpenResult serialises"))
    }

    async fn on_chat_close(&self) {
        let sessions = self.sessions.drain().await;
        if sessions.is_empty() {
            return;
        }
        for sess in sessions {
            sess.ssh.disconnect().await;
            tracing::info!(host = %sess.host, user = %sess.user,
                "node-ssh cleanup: disconnected session");
        }
    }
}

// ─── exec ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ExecArgs {
    session_id: String,
    /// Shell command. Passed straight to the remote login shell — same
    /// semantics as `ssh user@host '<command>'`.
    command: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    /// SSH exit status. `-1` if the channel closed without one (signal-killed,
    /// connection dropped) — distinguishable from a real `exit 255`.
    exit_code: i32,
    truncated: bool,
}

pub(crate) struct NodeSshExec {
    sessions: NodeSshSessions,
}

impl NodeSshExec {
    pub(crate) fn new(sessions: NodeSshSessions) -> Self {
        Self { sessions }
    }
}

#[async_trait]
impl NativeTool for NodeSshExec {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_ssh_exec".into(),
            description: "Run a command over an open node-SSH session (like `ssh user@host \
                '<cmd>'`). No /host chroot. Output capped at 64KiB."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" },
                    "command": { "type": "string" },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 600, "description": "Defaults to 60s." }
                },
                "required": ["session_id", "command"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let parsed: ExecArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let sess = self
            .sessions
            .get(&parsed.session_id)
            .await
            .ok_or_else(|| NativeToolError::msg("session_id not found (already closed?)"))?;

        let timeout = parsed
            .timeout_seconds
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_EXEC_TIMEOUT);

        let exec_fut = sess.ssh.exec(&parsed.command);
        let result = tokio::time::timeout(timeout, exec_fut)
            .await
            .map_err(|_| {
                NativeToolError::msg(format!("exec timed out after {}s", timeout.as_secs()))
            })?
            .map_err(|e| NativeToolError::msg(format!("exec: {e}")))?;

        let mut stdout = result.stdout;
        let mut stderr = result.stderr;
        let mut truncated = false;
        if stdout.len() > MAX_OUTPUT_BYTES {
            stdout.truncate(MAX_OUTPUT_BYTES);
            truncated = true;
        }
        if stderr.len() > MAX_OUTPUT_BYTES {
            stderr.truncate(MAX_OUTPUT_BYTES);
            truncated = true;
        }

        let exit_code = result.exit_status.map_or(-1, |c| c as i32);

        Ok(serde_json::to_value(ExecResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
            truncated,
        })
        .expect("ExecResult serialises"))
    }
}

// ─── close ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CloseArgs {
    session_id: String,
}

#[derive(Debug, Serialize)]
struct CloseResult {
    closed: bool,
    user: Option<String>,
    host: Option<String>,
    port: Option<u16>,
}

pub(crate) struct NodeSshClose {
    sessions: NodeSshSessions,
}

impl NodeSshClose {
    pub(crate) fn new(sessions: NodeSshSessions) -> Self {
        Self { sessions }
    }
}

#[async_trait]
impl NativeTool for NodeSshClose {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_ssh_close".into(),
            description: "Close a node-SSH session. Idempotent.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" }
                },
                "required": ["session_id"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let parsed: CloseArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let Some(sess) = self.sessions.remove(&parsed.session_id).await else {
            return Ok(serde_json::to_value(CloseResult {
                closed: false,
                user: None,
                host: None,
                port: None,
            })
            .expect("CloseResult serialises"));
        };
        sess.ssh.disconnect().await;
        Ok(serde_json::to_value(CloseResult {
            closed: true,
            user: Some(sess.user.clone()),
            host: Some(sess.host.clone()),
            port: Some(sess.port),
        })
        .expect("CloseResult serialises"))
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async fn client_for(app: &AppHandle, cluster_id: &str) -> Result<Client, NativeToolError> {
    let state = app.state::<AppState>();
    let entry = state
        .entry(cluster_id)
        .await
        .map_err(|e| NativeToolError::msg(format!("connect cluster: {e}")))?;
    Ok(entry.cluster.client())
}

/// Pick a reachable address for SSH. Prefers `ExternalIP` (operator-routable
/// in the typical case) over `InternalIP` (only routable for on-prem / VPN /
/// kind / shared VPC). Returns `(address, address_type_label)`.
fn pick_address(node: &Node) -> Result<(String, String), NativeToolError> {
    let addrs = node
        .status
        .as_ref()
        .and_then(|s| s.addresses.as_ref())
        .ok_or_else(|| NativeToolError::msg("node has no status.addresses"))?;
    for a in addrs {
        if a.type_ == "ExternalIP" && !a.address.is_empty() {
            return Ok((a.address.clone(), "ExternalIP".to_string()));
        }
    }
    for a in addrs {
        if a.type_ == "InternalIP" && !a.address.is_empty() {
            return Ok((a.address.clone(), "InternalIP".to_string()));
        }
    }
    Err(NativeToolError::msg(
        "node has no ExternalIP or InternalIP — pass `host` explicitly",
    ))
}

/// Best-effort default user from the node's `os_image` string. Match against
/// the substrings the major immutable-OS / cloud-image distros put in there;
/// fall back to `root` otherwise. The agent can always override with `user`.
fn default_user_for_os(node: &Node) -> Option<&'static str> {
    let os = node
        .status
        .as_ref()?
        .node_info
        .as_ref()?
        .os_image
        .to_lowercase();
    if os.contains("fedora coreos") || os.contains("flatcar") || os.contains("rhcos") {
        Some("core")
    } else if os.contains("ubuntu") {
        Some("ubuntu")
    } else if os.contains("amazon linux") {
        Some("ec2-user")
    } else if os.contains("debian") {
        Some("admin")
    } else if os.contains("rhel")
        || os.contains("red hat")
        || os.contains("rocky")
        || os.contains("alma")
        || os.contains("centos")
    {
        Some("cloud-user")
    } else {
        Some("root")
    }
}
