//! SSH client for "remote kubeconfig" sources.
//!
//! Wraps `russh` (pure-Rust async SSH-2) into three operations we need:
//!
//!   1. **Connect + authenticate.** Password, private-key (with optional
//!      passphrase), or ssh-agent. Host-key verification is layered:
//!      `~/.ssh/known_hosts` first, then a per-source pinned fingerprint
//!      (TOFU on first connect). A mismatch is hard-fail.
//!   2. **Exec.** `cat`, `printenv KUBECONFIG`, etc. Bounded read budget so a
//!      pathological remote can't OOM us.
//!   3. **Direct-tcpip tunnel.** Opens a local TCP listener on `127.0.0.1:0`,
//!      pipes each accepted connection through a fresh `direct-tcpip` channel
//!      to the apiserver. Returned `TunnelHandle` aborts the listener task on
//!      drop, taking the SSH channel down with it.
//!
//! The whole thing is `Tauri`-free; concrete `Cluster::connect_ssh` lives in
//! `cluster.rs` and wraps this.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{
    self,
    key::{KeyPair, PublicKey},
};
// `PublicKeyBase64` is only consumed by the Unix-only ssh-agent path; importing
// it unconditionally on Windows triggers `unused_imports` under `-D warnings`.
#[cfg(unix)]
use russh::keys::PublicKeyBase64;
use russh::ChannelMsg;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::sources::{
    keyring_account_key_passphrase, keyring_account_password, SshAuth, SshSourceConfig,
    KEYRING_SERVICE,
};
use crate::{Error, Result};

/// Hard ceiling on remote-file reads (kubeconfig fetch, env probes). Real
/// kubeconfigs are kilobytes; this stops a hostile remote from streaming
/// gigabytes into our heap before we notice.
const MAX_REMOTE_READ_BYTES: usize = 8 * 1024 * 1024;

/// Wall-clock budget for the connect handshake (TCP + KEX + auth). Longer than
/// most reasonable links so satellite / cellular operators can succeed; short
/// enough that an unreachable host doesn't pin a UI worker.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Wall-clock budget for one exec call. Sized for the native node-SSH
/// fallback tool (`fs_node_ssh_exec`) which is the heaviest user — operators
/// run things like `journalctl --since=10min` or `crictl ps` over this and
/// 10s tripped on the slow ones. The kubeconfig-fetch callers (`cat $KUBE…`,
/// `echo $HOME`) finish in well under a second so they don't notice the
/// looser ceiling. The agent's outer per-tool timeout (60s) still bounds
/// runaway invocations.
const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// Server inactivity timeout. Sent to russh; the SSH session disconnects on
/// silence past this. Long enough that an idle reflector doesn't drop the
/// tunnel between user clicks; short enough that a half-dead host gives up.
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(60 * 5);

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_status: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecResult {
    pub fn stdout_str(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }
    pub fn stderr_str(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stderr)
    }
    pub fn ok(&self) -> bool {
        self.exit_status == Some(0)
    }
}

/// Verifier shared between the russh handler and the outer `connect`. Captures
/// the offered server fingerprint so the caller can persist it on first
/// successful connect, and decides whether to accept the key.
struct HostKeyVerifier {
    /// Pinned `sha256:<base64nopad>` fingerprint from `SshSourceConfig`.
    /// `None` enables TOFU + known_hosts behaviour for first connect.
    pinned: Option<String>,
    host: String,
    port: u16,
    /// Filled with the offered fingerprint regardless of the verdict. Read by
    /// the outer code after a successful connect to persist on the source so
    /// subsequent connects pin against it.
    captured: Arc<Mutex<Option<String>>>,
}

#[async_trait::async_trait]
impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        // russh's PublicKey::fingerprint is base64-nopad SHA-256; prefix with
        // `sha256:` so the persisted form is unambiguous.
        let offered = format!("sha256:{}", server_public_key.fingerprint());
        *self.captured.lock().await = Some(offered.clone());

        if let Some(pinned) = self.pinned.as_deref() {
            if pinned == offered {
                tracing::debug!(host = %self.host, "ssh: server key matches pinned fingerprint");
                return Ok(true);
            }
            tracing::error!(
                host = %self.host,
                pinned,
                offered,
                "ssh: server key MISMATCH — refusing connect"
            );
            return Ok(false);
        }

        // No pinned fingerprint yet: try ~/.ssh/known_hosts. If the host is
        // present and matches, accept. Otherwise fall through to TOFU.
        match keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => {
                tracing::debug!(host = %self.host, "ssh: server key matches known_hosts");
                Ok(true)
            }
            Ok(false) => {
                tracing::info!(
                    host = %self.host,
                    fingerprint = %offered,
                    "ssh: TOFU — accepting and pinning fingerprint on first connect"
                );
                Ok(true)
            }
            Err(e) => {
                // `KeyChanged` means known_hosts already has a *different* key
                // for this host — refuse, same as `ssh` would.
                tracing::error!(
                    host = %self.host,
                    error = %e,
                    "ssh: known_hosts check failed — refusing connect"
                );
                Ok(false)
            }
        }
    }
}

/// Live SSH session. Kept alive for as long as a `Cluster::connect_ssh`
/// cluster (or a kubeconfig fetch) is using it. Drop the `Arc<SshSession>`
/// to tear the session down — pending tunnels go with it.
pub struct SshSession {
    handle: Handle<HostKeyVerifier>,
    captured_fingerprint: Arc<Mutex<Option<String>>>,
    user: String,
    host: String,
    port: u16,
}

impl SshSession {
    pub fn user(&self) -> &str {
        &self.user
    }
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Fingerprint observed during the handshake. Available after `connect`
    /// returns. The caller persists it on the source if it wasn't already
    /// pinned, so subsequent connects fail-hard on a different key.
    pub async fn captured_fingerprint(&self) -> Option<String> {
        self.captured_fingerprint.lock().await.clone()
    }

    /// Connect, verify host key, authenticate. `source_id` keys the keychain
    /// lookup for password / passphrase secrets — pass the source's stable
    /// uuid (`KubeconfigSource::id`).
    pub async fn connect(cfg: &SshSourceConfig, source_id: &str) -> Result<Self> {
        let captured = Arc::new(Mutex::new(None::<String>));
        let verifier = HostKeyVerifier {
            pinned: cfg.known_host_fingerprint.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
            captured: captured.clone(),
        };

        let client_config = client::Config {
            inactivity_timeout: Some(INACTIVITY_TIMEOUT),
            ..client::Config::default()
        };
        let client_config = Arc::new(client_config);

        let connect_fut = client::connect(client_config, (cfg.host.as_str(), cfg.port), verifier);
        let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connect_fut).await {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Err(Error::Ssh(format!("connect: {e}"))),
            Err(_) => {
                return Err(Error::Ssh(format!(
                    "connect: timed out after {}s",
                    CONNECT_TIMEOUT.as_secs()
                )))
            }
        };

        authenticate(&mut handle, cfg, source_id).await?;

        Ok(Self {
            handle,
            captured_fingerprint: captured,
            user: cfg.user.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
        })
    }

    /// Run a single command and capture stdout/stderr/exit. Each stream is
    /// capped at [`MAX_REMOTE_READ_BYTES`] — past that we stop appending and
    /// let the channel finish.
    pub async fn exec(&self, command: &str) -> Result<ExecResult> {
        let fut = exec_inner(&self.handle, command);
        match tokio::time::timeout(EXEC_TIMEOUT, fut).await {
            Ok(r) => r,
            Err(_) => Err(Error::Ssh(format!(
                "exec timed out after {}s: {}",
                EXEC_TIMEOUT.as_secs(),
                command
            ))),
        }
    }

    /// Auto-detect the remote kubeconfig path:
    ///
    /// 1. `bash -lc 'echo "$KUBECONFIG"'` — login shell so `.bashrc` /
    ///    `.profile` get sourced. Take the first colon-separated entry.
    /// 2. Fall back to `$HOME/.kube/config` (resolved via `bash -lc 'echo
    ///    "$HOME"'`).
    pub async fn detect_kubeconfig_path(&self) -> Result<String> {
        let env = self.exec(r#"bash -lc 'echo "$KUBECONFIG"'"#).await?;
        if env.ok() {
            let s = env.stdout_str().trim().to_owned();
            if !s.is_empty() {
                if let Some(first) = s.split(':').next() {
                    if !first.is_empty() {
                        return Ok(first.to_owned());
                    }
                }
            }
        }

        let home = self.exec(r#"bash -lc 'echo "$HOME"'"#).await?;
        if !home.ok() {
            return Err(Error::Ssh(format!(
                "could not resolve $HOME on remote: {}",
                home.stderr_str().trim()
            )));
        }
        let h = home.stdout_str().trim().to_owned();
        if h.is_empty() {
            return Err(Error::Ssh("remote $HOME is empty".to_owned()));
        }
        Ok(format!("{h}/.kube/config"))
    }

    /// Read a remote file in full (up to [`MAX_REMOTE_READ_BYTES`]).
    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        // Single-quote the path, escaping any embedded single quotes — the
        // path comes either from auto-detect (trusted) or from the operator's
        // source config, but we treat it as untrusted shell input either way.
        let escaped = path.replace('\'', r"'\''");
        let cmd = format!("cat -- '{escaped}'");
        let r = self.exec(&cmd).await?;
        if !r.ok() {
            return Err(Error::Ssh(format!(
                "read {path}: exit={:?} stderr={}",
                r.exit_status,
                r.stderr_str().trim()
            )));
        }
        Ok(r.stdout)
    }

    /// Open a TCP listener on `127.0.0.1:0`, return the OS-assigned port and a
    /// handle whose `Drop` aborts the accept loop. Each accepted connection is
    /// piped to a fresh `direct-tcpip` channel to `target_host:target_port` on
    /// the remote side.
    pub async fn open_tunnel(
        self: &Arc<Self>,
        target_host: String,
        target_port: u16,
    ) -> Result<TunnelHandle> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| Error::Ssh(format!("tunnel bind: {e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| Error::Ssh(format!("tunnel local_addr: {e}")))?
            .port();

        let session = self.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut local, peer) = match listener.accept().await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error = %e, "ssh tunnel: accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let host_clone = target_host.clone();
                let session_clone = session.clone();
                tokio::spawn(async move {
                    let chan = match session_clone
                        .handle
                        .channel_open_direct_tcpip(
                            host_clone.clone(),
                            u32::from(target_port),
                            "127.0.0.1",
                            u32::from(peer.port()),
                        )
                        .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!(
                                target = %format!("{host_clone}:{target_port}"),
                                error = %e,
                                "ssh tunnel: channel open failed"
                            );
                            let _ = local.shutdown().await;
                            return;
                        }
                    };
                    let mut remote = chan.into_stream();
                    if let Err(e) = tokio::io::copy_bidirectional(&mut local, &mut remote).await {
                        // Most "errors" here are normal half-close behaviour;
                        // log at debug, not warn.
                        tracing::debug!(error = %e, "ssh tunnel: copy_bidirectional ended");
                    }
                });
            }
        });

        Ok(TunnelHandle {
            local_port,
            task: Some(task),
        })
    }

    /// Best-effort graceful disconnect. Drops the underlying handle anyway
    /// when the SshSession does; this just sends a clean SSH disconnect first.
    pub async fn disconnect(&self) {
        if let Err(e) = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
        {
            tracing::debug!(error = %e, "ssh: disconnect failed (ignored)");
        }
    }
}

/// Live tunnel. Drop to tear down the listener (and any in-flight
/// `copy_bidirectional` tasks).
pub struct TunnelHandle {
    pub local_port: u16,
    task: Option<JoinHandle<()>>,
}

impl TunnelHandle {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

async fn exec_inner(handle: &Handle<HostKeyVerifier>, command: &str) -> Result<ExecResult> {
    let mut chan = handle
        .channel_open_session()
        .await
        .map_err(|e| Error::Ssh(format!("channel_open_session: {e}")))?;
    chan.exec(true, command)
        .await
        .map_err(|e| Error::Ssh(format!("exec({command}): {e}")))?;

    let mut stdout = Vec::with_capacity(4 * 1024);
    let mut stderr = Vec::with_capacity(1024);
    let mut exit = None;
    let mut overflowed = false;

    while let Some(msg) = chan.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                if stdout.len() < MAX_REMOTE_READ_BYTES {
                    let take = MAX_REMOTE_READ_BYTES - stdout.len();
                    if data.len() <= take {
                        stdout.extend_from_slice(&data);
                    } else {
                        stdout.extend_from_slice(&data[..take]);
                        overflowed = true;
                    }
                }
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                if stderr.len() < MAX_REMOTE_READ_BYTES {
                    let take = MAX_REMOTE_READ_BYTES - stderr.len();
                    if data.len() <= take {
                        stderr.extend_from_slice(&data);
                    } else {
                        stderr.extend_from_slice(&data[..take]);
                        overflowed = true;
                    }
                }
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit = Some(exit_status);
                // Don't break — server may still flush remaining Data frames.
            }
            ChannelMsg::Eof | ChannelMsg::Close => {}
            _ => {}
        }
    }

    if overflowed {
        tracing::warn!(
            command,
            cap = MAX_REMOTE_READ_BYTES,
            "ssh: exec output truncated"
        );
    }

    Ok(ExecResult {
        exit_status: exit,
        stdout,
        stderr,
    })
}

async fn authenticate(
    handle: &mut Handle<HostKeyVerifier>,
    cfg: &SshSourceConfig,
    source_id: &str,
) -> Result<()> {
    match &cfg.auth {
        SshAuth::Password => {
            let secret = read_secret(&keyring_account_password(source_id))
                .ok_or_else(|| Error::Ssh("password not found in keychain".to_owned()))?;
            let ok = handle
                .authenticate_password(cfg.user.clone(), secret)
                .await
                .map_err(|e| Error::Ssh(format!("authenticate_password: {e}")))?;
            if !ok {
                return Err(Error::Ssh("password authentication rejected".to_owned()));
            }
        }
        SshAuth::PrivateKey {
            path,
            has_passphrase,
        } => {
            let passphrase = if *has_passphrase {
                Some(
                    read_secret(&keyring_account_key_passphrase(source_id)).ok_or_else(|| {
                        Error::Ssh("key passphrase not found in keychain".to_owned())
                    })?,
                )
            } else {
                None
            };
            let key = load_secret_key(path, passphrase.as_deref())?;
            let ok = handle
                .authenticate_publickey(cfg.user.clone(), Arc::new(key))
                .await
                .map_err(|e| Error::Ssh(format!("authenticate_publickey: {e}")))?;
            if !ok {
                return Err(Error::Ssh("public-key authentication rejected".to_owned()));
            }
        }
        SshAuth::Agent => {
            authenticate_agent(handle, &cfg.user).await?;
        }
        SshAuth::DefaultKeys => {
            authenticate_default_keys(handle, &cfg.user).await?;
        }
    }
    Ok(())
}

/// Try every standard private-key path under `~/.ssh/` in order. First key
/// that the apiserver accepts wins. Keys that fail to load (e.g. encrypted
/// without a passphrase, malformed, missing) are skipped silently.
async fn authenticate_default_keys(handle: &mut Handle<HostKeyVerifier>, user: &str) -> Result<()> {
    let home = match directories::UserDirs::new().and_then(|d| d.home_dir().to_path_buf().into()) {
        Some(p) => p as std::path::PathBuf,
        None => {
            return Err(Error::Ssh(
                "no home directory; cannot scan ~/.ssh/".to_owned(),
            ))
        }
    };
    let candidates = ["id_ed25519", "id_ecdsa", "id_rsa"];
    let mut tried_any = false;
    for name in candidates {
        let path = home.join(".ssh").join(name);
        if !path.is_file() {
            continue;
        }
        let key = match keys::load_secret_key(&path, None) {
            Ok(k) => k,
            Err(e) => {
                tracing::debug!(path = %path.display(), error = %e, "default-keys: skip (load failed)");
                continue;
            }
        };
        tried_any = true;
        match handle
            .authenticate_publickey(user.to_owned(), Arc::new(key))
            .await
        {
            Ok(true) => {
                tracing::debug!(path = %path.display(), "default-keys: authenticated");
                return Ok(());
            }
            Ok(false) => {
                tracing::debug!(path = %path.display(), "default-keys: rejected");
                continue;
            }
            Err(e) => {
                tracing::debug!(path = %path.display(), error = %e, "default-keys: errored");
                continue;
            }
        }
    }
    if !tried_any {
        return Err(Error::Ssh(
            "no usable private key found in ~/.ssh/ (looked for id_ed25519, id_ecdsa, id_rsa)"
                .to_owned(),
        ));
    }
    Err(Error::Ssh(
        "no key in ~/.ssh/ was accepted by the server".to_owned(),
    ))
}

/// SSH-agent auth uses a Unix-domain socket (`$SSH_AUTH_SOCK`). russh-keys
/// only exposes `AgentClient::connect_env()` on Unix; Windows would need
/// Pageant via a named pipe (`AgentClient::<PageantStream>::connect_pageant`)
/// which we haven't wired up. CLAUDE.md flags Windows as out of scope for
/// v1; until that lands, the agent path returns a clean error on non-Unix
/// targets so the rest of the app still compiles.
#[cfg(unix)]
async fn authenticate_agent(handle: &mut Handle<HostKeyVerifier>, user: &str) -> Result<()> {
    let mut agent = keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| Error::Ssh(format!("ssh-agent connect: {e}")))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| Error::Ssh(format!("ssh-agent identities: {e}")))?;
    if identities.is_empty() {
        return Err(Error::Ssh("ssh-agent has no identities".to_owned()));
    }
    for id in identities {
        let id_label = id.public_key_base64();
        let (a, result) = handle.authenticate_future(user.to_owned(), id, agent).await;
        agent = a;
        match result {
            Ok(true) => return Ok(()),
            Ok(false) => {
                tracing::debug!(key = %id_label, "ssh-agent: identity rejected");
                continue;
            }
            Err(e) => {
                tracing::debug!(key = %id_label, error = %e, "ssh-agent: identity errored");
                continue;
            }
        }
    }
    Err(Error::Ssh(
        "no ssh-agent identity was accepted by the server".to_owned(),
    ))
}

#[cfg(not(unix))]
async fn authenticate_agent(_handle: &mut Handle<HostKeyVerifier>, _user: &str) -> Result<()> {
    Err(Error::Ssh(
        "ssh-agent authentication is not yet supported on this platform; \
         use a private key, default keys, or a password instead"
            .to_owned(),
    ))
}

fn load_secret_key(path: &Path, passphrase: Option<&str>) -> Result<KeyPair> {
    keys::load_secret_key(path, passphrase)
        .map_err(|e| Error::Ssh(format!("load private key {}: {e}", path.display())))
}

/// Look up a secret in the OS keyring. Returns `None` for a missing entry,
/// `Some` for a present one. Errors other than absence are logged.
fn read_secret(account: &str) -> Option<String> {
    match keyring::Entry::new(KEYRING_SERVICE, account) {
        Ok(entry) => match entry.get_password() {
            Ok(s) => Some(s),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                tracing::warn!(account, error = %e, "keychain read failed");
                None
            }
        },
        Err(e) => {
            tracing::warn!(account, error = %e, "keychain handle open failed");
            None
        }
    }
}

/// Read a secret keyed by a fully-qualified account name. Used by the caller
/// (commands.rs) which knows the source id and constructs the account via
/// `sources::keyring_account_*`.
pub fn read_keychain_secret(account: &str) -> Option<String> {
    read_secret(account)
}

/// Write a secret to the OS keychain.
pub fn write_keychain_secret(account: &str, value: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| Error::Ssh(format!("keychain handle: {e}")))?;
    entry
        .set_password(value)
        .map_err(|e| Error::Ssh(format!("keychain write: {e}")))
}
