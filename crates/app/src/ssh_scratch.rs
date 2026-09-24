//! Self-contained scratch kubeconfig for SSH-tunneled clusters.
//!
//! Anything that has to hand a *real file* to an external process (the MCP
//! child, the embedded terminal's `kubectl` / `helm` / shell, helm CLI calls)
//! cannot use the operator's source kubeconfig as-is when the cluster lives
//! on a remote host: the original `cluster.server` URL is unreachable from
//! the operator's machine. We materialise a small per-call YAML that:
//!
//!   1. Carries only the cluster + user + context the call is bound to.
//!   2. Rewrites `cluster.server` to a stable local relay port that forwards
//!      to the live `SshSession`'s tunnel, so the file stays valid when a
//!      reconnect rebuilds the tunnel on a new port.
//!   3. Sets `tls-server-name` to the apiserver's original hostname so SNI
//!      and certificate validation still match the cert presented by the
//!      apiserver — TLS happens above the TCP layer the tunnel rewrites.
//!   4. Pins `current-context` to the bound name (subordinates can layer
//!      another override on top to flip it; merge precedence picks the
//!      override anyway).
//!
//! The cluster must be pre-connected (`AppState::entry`) so the tunnel is
//! alive; this helper handles that. The returned `PathBuf` is owned by the
//! caller — *they* are responsible for deleting the file when done. The
//! terminal session's `scratch_files` and the MCP process's
//! `scratch_kubeconfig` already implement that lifecycle.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, LazyLock};

use tokio::net::{TcpListener, TcpStream};

use directories::ProjectDirs;

use crate::state::AppState;
use ferrisscope_core::kubeconfig;

/// Build and persist a tunneled scratch kubeconfig for `cluster_id` if it's an
/// SSH source. Returns `None` for non-SSH clusters (the regular source path
/// is fine), and on any failure (logged) — the caller should fall through to
/// whatever it does for non-SSH clusters and surface the error in context.
///
/// `prefix` is the filename leader so `ls <cache>/` makes it obvious which
/// subsystem owns the file: `mcp`, `term`, `helm`. Files include the OS pid +
/// a uuid so concurrent calls don't collide.
pub(crate) async fn materialize_if_needed(
    cluster_id: &str,
    context_name: &str,
    prefix: &str,
    state: &AppState,
) -> Option<PathBuf> {
    let ssh_lookup = {
        let s = state.sources.lock().await;
        kubeconfig::ssh_for(cluster_id, &s)
    };
    let (source_id, _cfg) = ssh_lookup?;

    // Pre-connect so the tunnel exists. Failure here means the SSH cluster
    // can't be reached at all — the caller should treat that as fatal.
    let entry = match state.entry(cluster_id).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(cluster_id, error = %e, "ssh-scratch: pre-connect failed");
            return None;
        }
    };
    publish_tunnel_port(cluster_id, entry.cluster.tunnel_local_port()?);
    let local_port = match stable_port(cluster_id).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(cluster_id, error = %e, "ssh-scratch: relay bind failed");
            return None;
        }
    };

    // Re-pull the parsed kubeconfig. `Cluster::connect_ssh` already fetched
    // it once but doesn't store the parsed form, only the built `kube::Config`.
    // The fetch is a single SSH exec + cat — ~50 ms on a warm session, fine
    // for a one-shot per call.
    let kc_owned = match fetch_remote_kubeconfig(&source_id, state).await {
        Some(k) => k,
        None => return None,
    };

    let yaml = match build_scratch_yaml(&kc_owned, context_name, local_port) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(cluster_id, error = %e, "ssh-scratch: build failed");
            return None;
        }
    };

    let dir = ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map_or_else(std::env::temp_dir, |d| d.cache_dir().to_path_buf());
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, "ssh-scratch: mkdir cache failed");
        return None;
    }
    let path = dir.join(format!(
        "{prefix}-ssh-{}-{}.yaml",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(e) = std::fs::write(&path, yaml) {
        tracing::warn!(error = %e, path = %path.display(), "ssh-scratch: write failed");
        return None;
    }
    Some(path)
}

/// A stable local port per SSH cluster that relays to whichever tunnel is
/// current. Scratch kubeconfigs point here, so a terminal opened before a
/// reconnect (which rebuilds the tunnel on a new port) keeps working.
struct Relay {
    upstream: Arc<AtomicU16>,
    port: Option<u16>,
}

static RELAYS: LazyLock<std::sync::Mutex<HashMap<String, Relay>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn relays() -> std::sync::MutexGuard<'static, HashMap<String, Relay>> {
    RELAYS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record the live tunnel port for `cluster_id`. Called whenever a cluster
/// entry is (re)built.
pub(crate) fn publish_tunnel_port(cluster_id: &str, port: u16) {
    relays()
        .entry(cluster_id.to_owned())
        .or_insert_with(|| Relay {
            upstream: Arc::new(AtomicU16::new(port)),
            port: None,
        })
        .upstream
        .store(port, Ordering::SeqCst);
}

async fn stable_port(cluster_id: &str) -> std::io::Result<u16> {
    let upstream = {
        let map = relays();
        let relay = map
            .get(cluster_id)
            .ok_or_else(|| std::io::Error::other("no tunnel published"))?;
        if let Some(port) = relay.port {
            return Ok(port);
        }
        relay.upstream.clone()
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut map = relays();
    let relay = map
        .get_mut(cluster_id)
        .ok_or_else(|| std::io::Error::other("no tunnel published"))?;
    // Lost a race with a concurrent caller: keep theirs, drop our listener.
    if let Some(existing) = relay.port {
        return Ok(existing);
    }
    relay.port = Some(port);
    tokio::spawn(run_relay(listener, upstream));
    Ok(port)
}

async fn run_relay(listener: TcpListener, upstream: Arc<AtomicU16>) {
    loop {
        let mut inbound = match listener.accept().await {
            Ok((sock, _)) => sock,
            Err(e) => {
                tracing::warn!(error = %e, "ssh-scratch relay: accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };
        let port = upstream.load(Ordering::SeqCst);
        tokio::spawn(async move {
            match TcpStream::connect(("127.0.0.1", port)).await {
                Ok(mut out) => {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut out).await;
                }
                Err(e) => {
                    tracing::debug!(error = %e, port, "ssh-scratch relay: tunnel unreachable");
                }
            }
        });
    }
}

async fn fetch_remote_kubeconfig(
    source_id: &str,
    state: &AppState,
) -> Option<kube::config::Kubeconfig> {
    let cfg = {
        let s = state.sources.lock().await;
        s.sources
            .iter()
            .find(|x| x.id == source_id)
            .and_then(|x| x.ssh.clone())
    };
    let cfg = cfg?;
    match kubeconfig::fetch_ssh_kubeconfig(source_id, &cfg).await {
        Ok(kc) => Some(kc),
        Err(e) => {
            tracing::warn!(source_id, error = %e, "ssh-scratch: kubeconfig refetch failed");
            None
        }
    }
}

fn build_scratch_yaml(
    kc: &kube::config::Kubeconfig,
    context_name: &str,
    local_port: u16,
) -> Result<String, String> {
    let named_ctx = kc
        .contexts
        .iter()
        .find(|c| c.name == context_name)
        .ok_or_else(|| format!("context {context_name} missing in remote kubeconfig"))?;
    let context_inner = named_ctx
        .context
        .as_ref()
        .ok_or_else(|| format!("context {context_name} has no body"))?;
    let cluster_name = context_inner.cluster.clone();
    let user_name = context_inner.user.clone();

    let mut named_cluster = kc
        .clusters
        .iter()
        .find(|c| c.name == cluster_name)
        .cloned()
        .ok_or_else(|| format!("cluster {cluster_name} missing in remote kubeconfig"))?;
    let cluster_inner = named_cluster
        .cluster
        .as_mut()
        .ok_or_else(|| format!("cluster {cluster_name} has no body"))?;
    let original_server = cluster_inner
        .server
        .clone()
        .ok_or_else(|| format!("cluster {cluster_name} has no server URL"))?;
    let original_host = original_host_from_url(&original_server)?;

    let scheme = if original_server.starts_with("http://") {
        "http"
    } else {
        "https"
    };
    cluster_inner.server = Some(format!("{scheme}://127.0.0.1:{local_port}"));
    if cluster_inner.tls_server_name.is_none() {
        cluster_inner.tls_server_name = Some(original_host);
    }

    let user_named = user_name
        .as_deref()
        .and_then(|name| kc.auth_infos.iter().find(|u| u.name == name))
        .cloned();

    let scratch = kube::config::Kubeconfig {
        kind: Some("Config".to_owned()),
        api_version: Some("v1".to_owned()),
        clusters: vec![named_cluster],
        auth_infos: user_named.into_iter().collect(),
        contexts: vec![named_ctx.clone()],
        current_context: Some(context_name.to_owned()),
        preferences: None,
        extensions: None,
        // kube 4.0 added a flattened catch-all for unknown top-level keys.
        other: Default::default(),
    };
    serde_yaml::to_string(&scratch).map_err(|e| format!("serialize: {e}"))
}

fn original_host_from_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| format!("unsupported scheme: {url}"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    if let Some(after) = authority.strip_prefix('[') {
        let close = after.find(']').ok_or_else(|| "malformed IPv6".to_owned())?;
        return Ok(after[..close].to_owned());
    }
    Ok(match authority.rsplit_once(':') {
        Some((h, _)) => h.to_owned(),
        None => authority.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn greeter(msg: &'static [u8]) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let _ = s.write_all(msg).await;
            }
        });
        port
    }

    async fn read_via(port: u16) -> Vec<u8> {
        let mut s = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let mut buf = vec![0u8; 3];
        s.read_exact(&mut buf).await.expect("read");
        buf
    }

    #[tokio::test]
    async fn relay_follows_the_tunnel_across_a_reconnect() {
        let id = "test::relay-follows";
        publish_tunnel_port(id, greeter(b"old").await);
        let stable = stable_port(id).await.expect("relay");
        assert_eq!(read_via(stable).await, b"old");

        publish_tunnel_port(id, greeter(b"new").await);
        assert_eq!(stable_port(id).await.expect("relay"), stable);
        assert_eq!(read_via(stable).await, b"new");
    }

    #[tokio::test]
    async fn no_relay_without_a_published_tunnel() {
        assert!(stable_port("test::never-published").await.is_err());
    }
}
