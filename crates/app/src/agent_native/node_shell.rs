//! Node-shell native tool family.
//!
//! Lets the agent open a privileged shell pinned to a node, run commands
//! against the host filesystem (via `chroot /host`), and close it down. Three
//! tools — open / exec / close — share a per-chat session table so the model
//! can hold a session id across multiple turns.
//!
//! Implementation: we create a debug pod that mounts the node's root at
//! `/host`, runs `sleep infinity`, and pins to the target node via
//! `nodeName`. Commands run via `pods.exec(name, ["/usr/sbin/chroot", "/host",
//! "sh", "-c", <cmd>], …)`. Close deletes the pod (foreground propagation,
//! grace period 0 — we're not gentle, the pod is ephemeral).
//!
//! All three tools are classified as **Write**: opening a privileged debug
//! pod is destructive in spirit (it grants the agent root on the node), and
//! the approval bridge in `agent.rs` will gate it accordingly.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{AttachParams, DeleteParams, PostParams, WatchEvent, WatchParams};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::agent_native::{read_capped, ChatClusterRef};
use crate::state::AppState;

/// Default image for the debug pod. Matches the operator-facing terminal
/// node-debug flow (`ResourceTable.tsx::openNodeDebugTab` — `kubectl debug
/// --image=alpine:3.20 --profile=sysadmin`) so behavior is consistent
/// whether the operator opens a shell themselves or asks the agent to.
/// Alpine ships `chroot` on PATH (at `/usr/sbin/chroot`), apk for installing
/// extras inside the container if the agent needs them, and BusyBox shell —
/// it's the de-facto debug image in the K8s ecosystem.
const DEFAULT_DEBUG_IMAGE: &str = "alpine:3.20";

/// Namespace the debug pod lives in. Hard-coded to `default` to avoid having
/// to ensure-exists a namespace at tool-call time. Operators can override per
/// call via the `namespace` arg.
const DEFAULT_DEBUG_NAMESPACE: &str = "default";

/// Cap on captured stdout/stderr. Keeps the LLM transcript bounded when the
/// model asks for `cat /var/log/foo` against a 50MB file. Caller can chunk
/// with `head` / `tail` if they want more.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Per-call exec timeout. The shell session itself lives until close; this
/// just bounds one command. Long-running probes should be wrapped in
/// `timeout` server-side or a tighter caller-supplied `timeout_seconds`.
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(240);

/// Pod startup timeout for `open`. Includes image-pull on first use; alpine
/// is small (~7 MB) but a fresh node still needs ~30s on a slow registry.
const POD_READY_TIMEOUT: Duration = Duration::from_secs(120);

/// Server-side TTL on the debug pod via `activeDeadlineSeconds`. The
/// kube-apiserver terminates the pod after this many seconds regardless of
/// whether the agent or operator remembered to close the session — covers
/// crashes, force-quits, model amnesia, and the chat outliving its
/// usefulness. Sized to clearly outlive a single exec running near
/// `DEFAULT_EXEC_TIMEOUT` (240s) plus pod ready (~30s) so a long
/// investigation doesn't have its pod yanked mid-command.
const POD_TTL_SECONDS: i64 = 900;

/// One open node-shell session. The pod field is the actual pod name on the
/// cluster (we generate it ourselves rather than letting the API server
/// `generateName` it, so we can return it predictably from `open`).
///
/// `cluster_id` is the active cluster snapshotted at open time, NOT the
/// chat's current `ChatClusterRef::active`. If the agent switches contexts
/// after open, exec/close still reach the cluster the debug pod was created
/// in — otherwise we'd leak pods on the original cluster and 404 on the new
/// one.
#[derive(Debug, Clone)]
struct Session {
    pod_name: String,
    namespace: String,
    cluster_id: String,
}

/// Per-chat shell sessions, keyed by the id we hand out. `Arc<Mutex<…>>` so
/// the three tool structs all see the same table.
#[derive(Clone, Default)]
pub(crate) struct NodeShellSessions {
    inner: Arc<Mutex<HashMap<String, Session>>>,
}

impl NodeShellSessions {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    async fn insert(&self, id: String, sess: Session) {
        self.inner.lock().await.insert(id, sess);
    }

    async fn get(&self, id: &str) -> Option<Session> {
        self.inner.lock().await.get(id).cloned()
    }

    async fn remove(&self, id: &str) -> Option<Session> {
        self.inner.lock().await.remove(id)
    }

    /// Drain every active session. Idempotent: subsequent calls see an empty
    /// table and return an empty Vec.
    async fn drain(&self) -> Vec<Session> {
        let mut g = self.inner.lock().await;
        g.drain().map(|(_, v)| v).collect()
    }
}

// ─── open ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenArgs {
    /// Node name to pin the debug pod to.
    node: String,
    /// Container image. Defaults to `alpine:3.20`.
    #[serde(default)]
    image: Option<String>,
    /// Namespace for the debug pod. Defaults to `default`.
    #[serde(default)]
    namespace: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenResult {
    session_id: String,
    pod: String,
    namespace: String,
    node: String,
    image: String,
}

pub(crate) struct NodeShellOpen {
    app: AppHandle,
    cluster: ChatClusterRef,
    sessions: NodeShellSessions,
}

impl NodeShellOpen {
    pub(crate) fn new(
        app: AppHandle,
        cluster: ChatClusterRef,
        sessions: NodeShellSessions,
    ) -> Self {
        Self {
            app,
            cluster,
            sessions,
        }
    }
}

#[async_trait]
impl NativeTool for NodeShellOpen {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_shell_open".into(),
            description: "Privileged shell on a node via debug pod (host root at /host, \
                chroot for exec). Image defaults to alpine:3.20, namespace `default`. \
                Pod auto-terminates after 5min (TTL); also cleaned on chat close. \
                Always call _close when done. If kubelet/scheduler/CNI is broken so the \
                pod can't be placed, use fs_node_ssh_open instead."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "node": { "type": "string" },
                    "image": { "type": "string", "description": "Defaults to alpine:3.20." },
                    "namespace": { "type": "string", "description": "Defaults to `default`." }
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
        let image = parsed.image.unwrap_or_else(|| DEFAULT_DEBUG_IMAGE.into());
        let namespace = parsed
            .namespace
            .unwrap_or_else(|| DEFAULT_DEBUG_NAMESPACE.into());

        let cluster_id = self.cluster.active().await;
        let client = client_for_id(&self.app, &cluster_id).await?;
        let pod_name = format!("ferrisscope-nodeshell-{}", uuid::Uuid::new_v4().simple());

        let pods: Api<Pod> = Api::namespaced(client.clone(), &namespace);
        let manifest = build_debug_pod(&pod_name, &parsed.node, &image);
        pods.create(&PostParams::default(), &manifest)
            .await
            .map_err(|e| NativeToolError::msg(format!("create debug pod: {e}")))?;

        if let Err(e) = wait_for_running(&pods, &pod_name, POD_READY_TIMEOUT).await {
            // Best-effort cleanup — don't leak a stuck debug pod on the user.
            let _ = pods
                .delete(&pod_name, &DeleteParams::default().grace_period(0))
                .await;
            return Err(e);
        }

        let session_id = format!("ns-{}", uuid::Uuid::new_v4().simple());
        self.sessions
            .insert(
                session_id.clone(),
                Session {
                    pod_name: pod_name.clone(),
                    namespace: namespace.clone(),
                    cluster_id: cluster_id.clone(),
                },
            )
            .await;

        Ok(serde_json::to_value(OpenResult {
            session_id,
            pod: pod_name,
            namespace,
            node: parsed.node,
            image,
        })
        .expect("OpenResult serialises"))
    }

    /// Drain the per-chat session table and delete every debug pod we ever
    /// opened. Idempotent: NodeShellExec / NodeShellClose share the same
    /// table, so if either of them happens to also implement this hook later
    /// they'd find an empty map. Best-effort: we log delete failures but
    /// never propagate — close must complete even when the apiserver is
    /// flaky.
    async fn on_chat_close(&self) {
        let sessions = self.sessions.drain().await;
        if sessions.is_empty() {
            return;
        }
        // Each session captured the cluster it was opened against, so
        // a switched-context chat still cleans up debug pods in the
        // right cluster instead of trying to delete them in the
        // currently-active one.
        for sess in sessions {
            let client = match client_for_id(&self.app, &sess.cluster_id).await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, pod = %sess.pod_name, cluster = %sess.cluster_id,
                        "node-shell cleanup: cluster unreachable, leaking debug pod (TTL will reap)");
                    continue;
                }
            };
            let pods: Api<Pod> = Api::namespaced(client, &sess.namespace);
            match pods
                .delete(&sess.pod_name, &DeleteParams::default().grace_period(0))
                .await
            {
                Ok(_) => tracing::info!(pod = %sess.pod_name, namespace = %sess.namespace,
                    "node-shell cleanup: deleted debug pod"),
                Err(e) if format!("{e}").contains("NotFound") => {
                    tracing::info!(pod = %sess.pod_name,
                        "node-shell cleanup: debug pod already gone");
                }
                Err(e) => tracing::warn!(error = %e, pod = %sess.pod_name,
                    "node-shell cleanup: delete failed (TTL will reap)"),
            }
        }
    }
}

// ─── exec ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ExecArgs {
    session_id: String,
    /// Shell command to run inside `chroot /host sh -c '<command>'`. Multi-
    /// line scripts are fine.
    command: String,
    /// Optional override for the per-call timeout.
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    truncated: bool,
}

pub(crate) struct NodeShellExec {
    app: AppHandle,
    sessions: NodeShellSessions,
}

impl NodeShellExec {
    pub(crate) fn new(app: AppHandle, sessions: NodeShellSessions) -> Self {
        Self { app, sessions }
    }
}

#[async_trait]
impl NativeTool for NodeShellExec {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_shell_exec".into(),
            description: "Run a command in an open node-shell session (`chroot /host sh -c \
                '<cmd>'` — paths are host-side). Output capped at 64KiB."
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

        // Use the session's pinned cluster — a context switch since open
        // mustn't redirect exec to the wrong cluster.
        let client = client_for_id(&self.app, &sess.cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &sess.namespace);

        let timeout = parsed
            .timeout_seconds
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_EXEC_TIMEOUT);

        // argv[0] = `chroot` (PATH-resolved, not absolute) — busybox /
        // alpine / debian / ubuntu all expose it on PATH but at different
        // absolute paths (busybox: /bin/chroot, alpine/debian: /usr/sbin).
        // Using an absolute path means the kubelet can't find the binary on
        // a busybox container and the exec fails to start with no captured
        // output. PATH lookup is portable.
        let exec_args = vec![
            "chroot".to_string(),
            "/host".to_string(),
            "sh".to_string(),
            "-c".to_string(),
            parsed.command.clone(),
        ];
        let attach = AttachParams::default()
            .stdout(true)
            .stderr(true)
            .stdin(false)
            .tty(false);

        let result =
            tokio::time::timeout(timeout, run_exec(&pods, &sess.pod_name, exec_args, attach))
                .await
                .map_err(|_| {
                    NativeToolError::msg(format!("exec timed out after {}s", timeout.as_secs()))
                })??;

        Ok(serde_json::to_value(result).expect("ExecResult serialises"))
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
    pod: Option<String>,
    namespace: Option<String>,
}

pub(crate) struct NodeShellClose {
    app: AppHandle,
    sessions: NodeShellSessions,
}

impl NodeShellClose {
    pub(crate) fn new(app: AppHandle, sessions: NodeShellSessions) -> Self {
        Self { app, sessions }
    }
}

#[async_trait]
impl NativeTool for NodeShellClose {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_node_shell_close".into(),
            description: "Close a node-shell session and delete the debug pod. Idempotent.".into(),
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
                pod: None,
                namespace: None,
            })
            .expect("CloseResult serialises"));
        };

        let client = client_for_id(&self.app, &sess.cluster_id).await?;
        let pods: Api<Pod> = Api::namespaced(client, &sess.namespace);
        // Grace period 0 + foreground: don't pay the 30s tail latency, the
        // pod is privileged and the user wants it gone.
        let _ = pods
            .delete(&sess.pod_name, &DeleteParams::default().grace_period(0))
            .await
            .map_err(|e| NativeToolError::msg(format!("delete debug pod: {e}")))?;

        Ok(serde_json::to_value(CloseResult {
            closed: true,
            pod: Some(sess.pod_name),
            namespace: Some(sess.namespace),
        })
        .expect("CloseResult serialises"))
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async fn client_for_id(app: &AppHandle, cluster_id: &str) -> Result<Client, NativeToolError> {
    let state = app.state::<AppState>();
    let entry = state
        .entry(cluster_id)
        .await
        .map_err(|e| NativeToolError::msg(format!("connect cluster: {e}")))?;
    Ok(entry.cluster.client())
}

/// Build the debug-pod manifest. Mirrors what `kubectl debug node/<n>` emits:
/// hostNetwork / hostPID / hostIPC, privileged, root mounted at `/host`,
/// node selector pinned. We don't tolerate everything (DiskPressure, etc.)
/// because the operator picked a specific node — failing fast is better than
/// silently scheduling somewhere else.
fn build_debug_pod(name: &str, node: &str, image: &str) -> Pod {
    serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "labels": {
                "app.kubernetes.io/managed-by": "ferrisscope",
                "ferrisscope.dev/role": "node-shell"
            }
        },
        "spec": {
            "nodeName": node,
            "hostNetwork": true,
            "hostPID": true,
            "hostIPC": true,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": POD_TTL_SECONDS,
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{
                "name": "shell",
                "image": image,
                "command": ["sleep", "infinity"],
                "securityContext": {
                    "privileged": true,
                    "runAsUser": 0
                },
                "volumeMounts": [{
                    "name": "host",
                    "mountPath": "/host"
                }]
            }],
            "volumes": [{
                "name": "host",
                "hostPath": { "path": "/", "type": "Directory" }
            }]
        }
    }))
    .expect("static pod manifest is valid")
}

/// Watch the pod until phase=Running (or Failed, for a fast error). Returns
/// on first matching event; bails after `timeout`.
async fn wait_for_running(
    pods: &Api<Pod>,
    name: &str,
    timeout: Duration,
) -> Result<(), NativeToolError> {
    let wp = WatchParams::default()
        .fields(&format!("metadata.name={name}"))
        .timeout(timeout.as_secs().min(u64::from(u32::MAX)) as u32);
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(NativeToolError::msg(
                "debug pod did not reach Running in time",
            ));
        }
        let mut stream = pods
            .watch(&wp, "0")
            .await
            .map_err(|e| NativeToolError::msg(format!("watch debug pod: {e}")))?
            .boxed();
        loop {
            let item =
                tokio::time::timeout(deadline - tokio::time::Instant::now(), stream.try_next())
                    .await;
            let evt = match item {
                Ok(Ok(Some(e))) => e,
                Ok(Ok(None)) => break, // server closed the watch — re-establish
                Ok(Err(e)) => {
                    return Err(NativeToolError::msg(format!("watch error: {e}")));
                }
                Err(_) => {
                    return Err(NativeToolError::msg(
                        "debug pod did not reach Running in time",
                    ));
                }
            };
            if let WatchEvent::Modified(p) | WatchEvent::Added(p) = evt {
                let phase = p
                    .status
                    .as_ref()
                    .and_then(|s| s.phase.as_deref())
                    .unwrap_or("");
                match phase {
                    "Running" => return Ok(()),
                    "Failed" | "Succeeded" => {
                        let reason = p
                            .status
                            .as_ref()
                            .and_then(|s| s.reason.clone())
                            .unwrap_or_else(|| phase.to_string());
                        return Err(NativeToolError::msg(format!(
                            "debug pod terminated before Running: {reason}"
                        )));
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn run_exec(
    pods: &Api<Pod>,
    pod_name: &str,
    cmd: Vec<String>,
    attach: AttachParams,
) -> Result<ExecResult, NativeToolError> {
    let mut process = pods
        .exec(pod_name, cmd, &attach)
        .await
        .map_err(|e| NativeToolError::msg(format!("exec: {e}")))?;

    // `stdout()` / `stderr()` / `take_status()` each move their handle out
    // of the process struct; pull them all up front so the three drains can
    // run concurrently without re-borrowing `process`.
    let stdout_h = process.stdout();
    let stderr_h = process.stderr();
    let status_h = process.take_status();

    // Drain stdout and stderr concurrently — serially risks the duplex buffer
    // filling on the side we're not yet reading and back-pressuring the
    // server-side message loop. Each side is capped at `MAX_OUTPUT_BYTES`
    // *during* the read (`read_capped`), not after — a runaway command
    // (find /, journalctl -k, dmesg) would otherwise buffer hundreds of
    // MB of node output into the app process before the cap applied.
    let stdout_fut = async move {
        let mut buf = Vec::with_capacity(4096);
        let mut trunc = false;
        if let Some(mut out) = stdout_h {
            trunc = read_capped(&mut out, &mut buf, MAX_OUTPUT_BYTES).await;
        }
        (buf, trunc)
    };
    let stderr_fut = async move {
        let mut buf = Vec::with_capacity(1024);
        let mut trunc = false;
        if let Some(mut err) = stderr_h {
            trunc = read_capped(&mut err, &mut buf, MAX_OUTPUT_BYTES).await;
        }
        (buf, trunc)
    };
    let status_fut = async move {
        match status_h {
            Some(fut) => fut.await,
            None => None,
        }
    };

    let ((stdout_buf, stdout_trunc), (mut stderr_buf, stderr_trunc), status) =
        futures::join!(stdout_fut, stderr_fut, status_fut);

    let truncated = stdout_trunc || stderr_trunc;

    // Parse the apiserver's exec status. Three shapes matter:
    //   1. Success → exit 0.
    //   2. Failure with an `ExitCode` cause → the actual non-zero exit.
    //   3. Failure WITHOUT an `ExitCode` cause → the command never started
    //      (binary not found in container, container died, etc.). The
    //      apiserver gives us a `message` and `reason` instead. Surface
    //      those in stderr so the caller has something to debug — silently
    //      returning `exit=1, stderr=""` was the bug that masked
    //      "absolute chroot path doesn't exist in busybox".
    let mut exit_code = 0;
    if let Some(s) = status {
        if s.status.as_deref() != Some("Success") {
            let exit_cause = s
                .details
                .as_ref()
                .and_then(|d| d.causes.as_ref())
                .and_then(|c| {
                    c.iter()
                        .find(|cause| cause.reason.as_deref() == Some("ExitCode"))
                })
                .and_then(|cause| cause.message.as_ref())
                .and_then(|m| m.parse::<i32>().ok());
            if let Some(code) = exit_cause {
                exit_code = code;
            } else {
                exit_code = 1;
                if stderr_buf.is_empty() {
                    let reason = s.reason.as_deref().unwrap_or("");
                    let message = s.message.as_deref().unwrap_or("");
                    let detail = match (reason, message) {
                        ("", "") => "exec failed (no status detail from apiserver)".to_string(),
                        ("", m) => format!("exec failed: {m}"),
                        (r, "") => format!("exec failed ({r})"),
                        (r, m) => format!("exec failed ({r}): {m}"),
                    };
                    stderr_buf.extend_from_slice(detail.as_bytes());
                }
            }
        }
    }

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout_buf).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_buf).into_owned(),
        exit_code,
        truncated,
    })
}
