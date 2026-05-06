//! Generic MCP-server subprocess.
//!
//! One [`McpProcess`] = one entry in `AgentSettings::mcp_servers`, spawned
//! once per chat. The binary is whatever the operator points at — any
//! MCP-protocol server (filesystem, github, custom). The child is spawned
//! with stdin / stdout piped; we wrap the IO in
//! [`ferrisscope_agent::McpClient`] (JSON-RPC 2.0) and run the MCP
//! initialize handshake before returning.
//!
//! Multiple servers can be configured — `chat_open` walks the enabled list
//! and spawns each one, merging their tool catalogues with the native
//! toolkit under the same approval gate.
//!
//! Kubernetes-flavoured servers benefit from the `KUBECONFIG` env we set
//! (so they target the chat's bound context); non-k8s servers ignore it.
//! Operator-supplied env vars are merged on top and win on key collision.
//!
//! Drop semantics: dropping the [`McpProcess`] kills the child immediately
//! (best effort). The agent runtime drops the whole vector when a chat
//! closes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ferrisscope_agent::config::McpServerConfig;
use ferrisscope_agent::McpClient;
use tokio::process::{Child, Command};

#[derive(Debug)]
pub(crate) enum McpProcessError {
    BinaryNotConfigured,
    Spawn(std::io::Error),
    NoPipes,
    Initialize(ferrisscope_agent::McpError),
    ScratchKubeconfig(String),
}

impl std::fmt::Display for McpProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BinaryNotConfigured => {
                f.write_str("MCP server binary not configured (no `command` set on this entry)")
            }
            Self::Spawn(e) => write!(f, "failed to spawn MCP server: {e}"),
            Self::NoPipes => f.write_str("MCP server stdin/stdout not piped"),
            Self::Initialize(e) => write!(f, "MCP initialize failed: {e}"),
            Self::ScratchKubeconfig(s) => write!(f, "scratch kubeconfig: {s}"),
        }
    }
}

impl std::error::Error for McpProcessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn(e) => Some(e),
            Self::Initialize(e) => Some(e),
            _ => None,
        }
    }
}

/// One running MCP child process + its JSON-RPC client.
pub(crate) struct McpProcess {
    pub(crate) client: Arc<McpClient>,
    /// Owned so dropping the struct kills the child.
    child: Option<Child>,
    /// Per-process context-override kubeconfig file we wrote ourselves.
    /// Cleaned up on drop. The shared external scratch (SSH-tunneled
    /// kubeconfig used by all MCP servers in a chat) is owned by
    /// `ChatRuntime` instead so multiple servers can share it.
    scratch_kubeconfig: Option<PathBuf>,
}

impl McpProcess {
    /// Spawn the configured binary, do the MCP `initialize` handshake, and
    /// return a ready client.
    ///
    /// `config.command` is required — empty returns
    /// [`McpProcessError::BinaryNotConfigured`]. There is no PATH fallback;
    /// chat_open simply skips the spawn when no command is configured.
    ///
    /// **Context pinning.** When `kubeconfig_path` is set, we write a tiny
    /// per-chat override file with `current-context: <context_name>` and
    /// build a `KUBECONFIG=<override>:<source>` merge string for the child.
    /// Kubeconfig merge precedence makes the override's `current-context`
    /// win, while the source supplies the cluster + user definitions. This
    /// guarantees the MCP server targets the chat's bound context even if
    /// the source file has a different `current-context:` (very common in
    /// the fleet view, where a single kubeconfig holds many contexts).
    /// When `context_name` is `None` we fall back to plain
    /// `KUBECONFIG=<source>` and let the source's `current-context` win.
    ///
    /// `external_scratch` lets the caller hand in a fully-formed
    /// self-contained kubeconfig (e.g. one rewritten for an SSH-tunneled
    /// cluster) — when set, it overrides the merge logic above and the file
    /// is the sole `KUBECONFIG` value. The scratch is borrowed; the caller
    /// (`ChatRuntime`) owns its lifetime so multiple MCP servers in the same
    /// chat can share it without racing on cleanup.
    pub(crate) async fn spawn(
        config: &McpServerConfig,
        kubeconfig_path: Option<&PathBuf>,
        context_name: Option<&str>,
        external_scratch: Option<&Path>,
    ) -> Result<Self, McpProcessError> {
        let bin = config.command.trim();
        if bin.is_empty() {
            return Err(McpProcessError::BinaryNotConfigured);
        }

        // Build the KUBECONFIG value the child should see, plus the
        // per-process override scratch path (None when we didn't need to
        // write one). The external scratch is borrowed — caller owns
        // its lifetime so multiple MCP servers in the same chat can
        // share it without duplicating the file.
        let (kubeconfig_env, scratch) = if let Some(scratch) = external_scratch {
            (Some(scratch.display().to_string()), None)
        } else {
            match (kubeconfig_path, context_name) {
                (Some(src), Some(ctx)) => {
                    let scratch = write_context_override(src, ctx)?;
                    let sep = if cfg!(windows) { ';' } else { ':' };
                    (
                        Some(format!("{}{}{}", scratch.display(), sep, src.display())),
                        Some(scratch),
                    )
                }
                (Some(src), None) => (Some(src.display().to_string()), None),
                (None, _) => (None, None),
            }
        };

        let mut cmd = Command::new(bin);
        if !config.args.is_empty() {
            cmd.args(&config.args);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // KUBECONFIG goes in first; operator-supplied env vars merge on top
        // so an explicit KUBECONFIG override (e.g. for a server that wants
        // a different file) wins.
        if let Some(env_value) = &kubeconfig_env {
            cmd.env("KUBECONFIG", env_value);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| {
            // If spawn fails, the scratch file we just wrote is dead weight.
            if let Some(p) = &scratch {
                let _ = std::fs::remove_file(p);
            }
            McpProcessError::Spawn(e)
        })?;

        let stdin = child.stdin.take().ok_or(McpProcessError::NoPipes)?;
        let stdout = child.stdout.take().ok_or(McpProcessError::NoPipes)?;
        // Drain stderr so we don't fill the pipe buffer and stall the child
        // when it logs noisily. Lines go to our `tracing` log at debug level.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain_stderr(stderr));
        }

        let client = McpClient::new(stdin, stdout);

        // Initialize is a fast handshake; cap the wait so a wedged binary
        // surfaces as an error rather than a hang.
        let init = tokio::time::timeout(
            Duration::from_secs(20),
            client.initialize("ferrisscope", env!("CARGO_PKG_VERSION")),
        )
        .await;
        match init {
            Ok(Ok(_)) => Ok(Self {
                client,
                child: Some(child),
                scratch_kubeconfig: scratch,
            }),
            Ok(Err(e)) => {
                let _ = child.kill().await;
                if let Some(p) = scratch {
                    let _ = std::fs::remove_file(p);
                }
                Err(McpProcessError::Initialize(e))
            }
            Err(_) => {
                let _ = child.kill().await;
                if let Some(p) = scratch {
                    let _ = std::fs::remove_file(p);
                }
                Err(McpProcessError::Initialize(
                    ferrisscope_agent::McpError::InvalidResponse("MCP initialize timed out".into()),
                ))
            }
        }
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // start_kill is non-blocking; the OS reaps via kill_on_drop too
            // but starting it here gives a faster signal.
            let _ = child.start_kill();
        }
        if let Some(p) = self.scratch_kubeconfig.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Write a tiny override kubeconfig that pins `current-context`. The MCP
/// server is launched with `KUBECONFIG=<override>:<source>` so the merge
/// resolves the chosen context's cluster + user from the source while the
/// override forces `current-context` to the one the chat is bound to.
fn write_context_override(source: &Path, context_name: &str) -> Result<PathBuf, McpProcessError> {
    let dir = directories::ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map_or_else(std::env::temp_dir, |d| d.cache_dir().to_path_buf());
    std::fs::create_dir_all(&dir)
        .map_err(|e| McpProcessError::ScratchKubeconfig(format!("mkdir cache: {e}")))?;
    let path = dir.join(format!(
        "mcp-{}-{}.yaml",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    let body = format!(
        "apiVersion: v1\nkind: Config\ncurrent-context: {ctx}\n",
        ctx = yaml_scalar(context_name)
    );
    std::fs::write(&path, body)
        .map_err(|e| McpProcessError::ScratchKubeconfig(format!("write: {e}")))?;
    let _ = source; // referenced via the merged KUBECONFIG env value, not by us
    Ok(path)
}

/// Quote a YAML scalar conservatively. Context names may contain `:`, `@`,
/// `/` (e.g. EKS ARNs), so always emit double-quoted with `"` escaped — keeps
/// the override file valid no matter what the operator named their context.
fn yaml_scalar(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

async fn drain_stderr(stderr: tokio::process::ChildStderr) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut buf = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match buf.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    tracing::debug!(target: "mcp", "{trimmed}");
                }
            }
        }
    }
}
