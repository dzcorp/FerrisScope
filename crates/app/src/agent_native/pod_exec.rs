//! `fs_pod_exec` — run a command inside an *existing* pod's container.
//!
//! Distinct from `fs_node_shell_*` (creates a debug pod and chroots into the
//! host) and `fs_node_ssh_*` (direct SSH bypassing kube): this hits a pod
//! the operator already deployed. Common targets are netshoot / busybox
//! sidecars, the operator's own troubleshooting toolbox, an app container
//! the agent wants to inspect from the inside.
//!
//! Argv-only by design — no implicit `sh -c` wrapping. Distroless and
//! scratch-based containers don't ship a shell, so a tool that silently
//! prepends `sh -c` would just fail there. The agent passes the full argv
//! it wants (`["sh","-c","..."]` for shell, `["dig","app.svc.cluster.local"]`
//! direct, etc.) and the description spells that out.

use std::time::Duration;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::core::v1::Pod;
use kube::api::AttachParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::{read_capped, ChatClusterRef};
use crate::state::AppState;

/// Output cap matches `fs_node_shell_exec` so the agent gets a consistent
/// budget regardless of which exec path it picked.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Per-call timeout default. Overridable via `timeout_seconds`. Sized to
/// fit comfortably under the agent loop's 300s ceiling so a tool-level
/// timeout error has a chance to come back instead of the outer wrapper
/// firing first. Long-running diagnostics (`kubectl wait`, multi-second
/// init scripts) commonly land in the 60–180s range.
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Debug, Deserialize)]
struct Args {
    namespace: String,
    name: String,
    /// argv array. `["sh","-c","echo hi"]` for a shell command (won't work
    /// in distroless), `["dig","example.svc.cluster.local"]` for direct
    /// invocation.
    command: Vec<String>,
    /// Container name. Defaults to the first container in the pod spec —
    /// matches `kubectl exec` behaviour.
    #[serde(default)]
    container: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    truncated: bool,
    container: String,
}

pub(crate) struct PodExec {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PodExec {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PodExec {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pod_exec".into(),
            description: "Run a command in an existing pod's container (kubectl exec). \
                argv-only — pass `[\"sh\",\"-c\",\"...\"]` for shell (won't work in \
                distroless / scratch images). Container defaults to the first in \
                the pod spec. Output capped at 64KiB."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" },
                    "command": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
                    "container": { "type": "string" },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 300, "description": "Defaults to 45s." }
                },
                "required": ["namespace", "name", "command"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        if a.command.is_empty() {
            return Err(NativeToolError::msg("command must be non-empty argv"));
        }
        let client = client_for(&self.app, &self.cluster).await?;
        let pods: Api<Pod> = Api::namespaced(client.clone(), &a.namespace);

        // Resolve container name explicitly — the apiserver will guess the
        // first one if we leave it blank, but echoing it in the result lets
        // the model see what it actually hit (especially relevant for
        // multi-container pods where "first" is non-obvious).
        let container = match a.container {
            Some(c) => c,
            None => {
                let pod = pods
                    .get(&a.name)
                    .await
                    .map_err(|e| NativeToolError::msg(format!("get pod: {e}")))?;
                pod.spec
                    .as_ref()
                    .and_then(|s| s.containers.first())
                    .map(|c| c.name.clone())
                    .ok_or_else(|| NativeToolError::msg("pod has no containers"))?
            }
        };

        let timeout = a
            .timeout_seconds
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_EXEC_TIMEOUT);
        let attach = AttachParams::default()
            .container(&container)
            .stdout(true)
            .stderr(true)
            .stdin(false)
            .tty(false);

        let result = Box::pin(tokio::time::timeout(
            timeout,
            run_exec(&pods, &a.name, a.command, attach, &container),
        ))
        .await
        .map_err(|_| {
            NativeToolError::msg(format!("exec timed out after {}s", timeout.as_secs()))
        })??;
        Ok(serde_json::to_value(result).expect("ExecResult serialises"))
    }
}

async fn run_exec(
    pods: &Api<Pod>,
    name: &str,
    cmd: Vec<String>,
    attach: AttachParams,
    container: &str,
) -> Result<ExecResult, NativeToolError> {
    let mut process = pods
        .exec(name, cmd, &attach)
        .await
        .map_err(|e| NativeToolError::msg(format!("exec: {e}")))?;

    let stdout_h = process.stdout();
    let stderr_h = process.stderr();
    let status_h = process.take_status();

    // Streaming cap, not a post-hoc truncate: a runaway exec (find /,
    // dmesg, cat /var/log/*) would otherwise buffer hundreds of MB into
    // the app process before the cap applied. `read_capped` stops
    // appending the moment `buf.len() >= MAX_OUTPUT_BYTES`.
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

    // `truncated` already reflects the streaming cap; the explicit
    // post-hoc `Vec::truncate` that used to live here is unnecessary now
    // that `read_capped` never overshoots `MAX_OUTPUT_BYTES`.
    let truncated = stdout_trunc || stderr_trunc;

    // Same status-decoding logic as fs_node_shell_exec — non-Success without
    // an ExitCode cause means the command never started (binary missing,
    // container exited, …); surface that text in stderr so the model has
    // something to act on.
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
        container: container.to_string(),
    })
}

async fn client_for(app: &AppHandle, cluster: &ChatClusterRef) -> Result<Client, NativeToolError> {
    let id = cluster.active().await;
    let state = app.state::<AppState>();
    let entry = state
        .entry(&id)
        .await
        .map_err(|e| NativeToolError::msg(format!("connect cluster: {e}")))?;
    Ok(entry.cluster.client())
}
