//! Per-context cluster connection.
//!
//! Holds a `kube::Client` keyed to a single kubeconfig context. Supervisor /
//! reflector machinery lands in M0.4 — for now this is just enough to prove
//! we can talk to an apiserver.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use http::{header::ACCEPT_ENCODING, HeaderValue};
use k8s_openapi::api::core::v1::Node;
use kube::{
    api::{Api, ListParams},
    client::ClientBuilder,
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use serde::Serialize;
use tower_http::{decompression::DecompressionLayer, set_header::SetRequestHeaderLayer};

use crate::sources::SshSourceConfig;
use crate::ssh::{SshSession, TunnelHandle};
use crate::{Error, Result};

/// Wrap the default kube `ClientBuilder` with two layers:
///
/// * [`SetRequestHeaderLayer`] adds `Accept-Encoding: gzip` to every
///   request so the apiserver can compress the body. Measured ratio on
///   real Pod LIST responses is ~7×; the typed reflector's "kubectl is
///   way faster" gap is almost entirely this header.
/// * [`DecompressionLayer`] transparently inflates `Content-Encoding:
///   gzip` responses so kube-rs's deserialiser sees plain JSON. Without
///   this layer, asking for gzip would just give us garbage bytes.
///
/// `if_not_present` on the request layer means a caller that wants to
/// disable compression for a specific call (e.g. the bench's identity
/// variants) can still set its own `Accept-Encoding` header.
fn build_compressed_client(config: Config) -> Result<Client> {
    let builder = ClientBuilder::try_from(config)?
        .with_layer(&DecompressionLayer::new())
        .with_layer(&SetRequestHeaderLayer::if_not_present(
            ACCEPT_ENCODING,
            HeaderValue::from_static("gzip"),
        ));
    Ok(builder.build())
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterInfo {
    /// e.g. `v1.30.4`
    pub server_version: String,
    pub node_count: usize,
}

/// How the watcher should perform its initial sync. Chosen per cluster from
/// the apiserver version: `WatchList` (KEP-3157, GA in 1.32, beta-on in 1.27)
/// streams items one at a time, eliminating the "wait for the first page"
/// stall; older apiservers fall back to paged LIST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListStrategy {
    /// `InitialListStrategy::StreamingList` — items arrive as a watch.
    Streaming,
    /// `InitialListStrategy::ListWatch` with a small page size so per-page
    /// `InitApply` events still drip in fast.
    Paged,
}

/// How many distinct watcher-Clients (HTTP/2 connection pools) to keep per
/// cluster. Each watcher is round-robin assigned one of these clients
/// instead of minting a fresh pool on every subscribe. Sharing across all
/// watchers (size 1) was observed to stall large LIST responses behind a
/// long-running watch on the same H2 connection; minting per-watcher (the
/// previous behaviour) cost ~30 connection pools per active cluster on a
/// fully-browsed UI. A small fixed pool gets the LIST/watch isolation
/// benefit without the per-kind footprint.
const WATCHER_CLIENT_POOL_SIZE: usize = 4;

pub struct Cluster {
    pub context_name: String,
    client: Client,
    /// Cloned Config so we can mint fresh `Client` instances for the
    /// watcher pool (see [`WATCHER_CLIENT_POOL_SIZE`]).
    config: Config,
    /// Pool of watcher-dedicated clients. Lazily filled on first request;
    /// each call to [`Self::watcher_client`] hands back the next slot via
    /// round-robin so reflectors share H2 pools across kinds without all
    /// of them piling onto a single connection.
    watcher_pool: Mutex<Vec<Client>>,
    watcher_pool_cursor: AtomicUsize,
    /// Cached after the first successful `info()` call. `None` until then —
    /// callers that need it before info has run will see `Paged` (the
    /// pessimistic / always-supported choice).
    list_strategy: std::sync::OnceLock<ListStrategy>,
    /// SSH session backing this cluster, if any. Held purely so the session
    /// lives at least as long as the cluster — the kube `Client` opens TCP
    /// to a localhost port served by the SSH tunnel below, and dropping the
    /// session here yanks both. Held behind `Arc` because `SshSession`
    /// already gets shared with `open_tunnel`'s spawned task.
    ssh: Option<Arc<SshSession>>,
    /// Active local tunnel for the apiserver. Drop aborts the listener task,
    /// closing every in-flight `direct-tcpip` channel.
    tunnel: Option<TunnelHandle>,
}

impl Cluster {
    /// Build a client for the named context out of the user's kubeconfig.
    /// `source_path = None` reads the default kubeconfig (env / ~/.kube/config);
    /// `Some(path)` loads from that specific file (used for user-added sources).
    pub async fn connect(context_name: &str, source_path: Option<&Path>) -> Result<Self> {
        let kubeconfig = match source_path {
            Some(p) => Kubeconfig::read_from(p)?,
            None => Kubeconfig::read()?,
        };
        let options = KubeConfigOptions {
            context: Some(context_name.to_owned()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let client = build_compressed_client(config.clone())?;
        Ok(Self {
            context_name: context_name.to_owned(),
            client,
            config,
            watcher_pool: Mutex::new(Vec::with_capacity(WATCHER_CLIENT_POOL_SIZE)),
            watcher_pool_cursor: AtomicUsize::new(0),
            list_strategy: std::sync::OnceLock::new(),
            ssh: None,
            tunnel: None,
        })
    }

    /// Build a client for the named context that lives on a remote Linux host
    /// reachable via SSH. The remote kubeconfig is fetched, its `cluster.server`
    /// rewritten to point at a local TCP listener, and an SSH `direct-tcpip`
    /// tunnel is set up between the listener and the apiserver's real
    /// `host:port`. The TLS handshake still uses the apiserver's original
    /// hostname (via `tls-server-name`) so cert validation remains intact.
    ///
    /// The returned `Cluster` owns the SSH session + tunnel; dropping it tears
    /// both down.
    pub async fn connect_ssh(
        context_name: &str,
        cfg: &SshSourceConfig,
        source_id: &str,
    ) -> Result<Self> {
        // 1. Open the SSH session (this also captures the host fingerprint
        //    for TOFU pinning — the caller persists it back on the source).
        let session = Arc::new(SshSession::connect(cfg, source_id).await?);

        // 2. Pull the remote kubeconfig.
        let mut kubeconfig = crate::kubeconfig::fetch_ssh_kubeconfig(source_id, cfg).await?;

        // 3. Find the named context's cluster entry and parse its server URL.
        let cluster_name = kubeconfig
            .contexts
            .iter()
            .find_map(|c| {
                if c.name == context_name {
                    c.context.as_ref().map(|x| x.cluster.clone())
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                Error::ContextNotFound(format!(
                    "{context_name} (in remote kubeconfig from {})",
                    cfg.host
                ))
            })?;

        let cluster_entry = kubeconfig
            .clusters
            .iter_mut()
            .find(|c| c.name == cluster_name)
            .ok_or_else(|| {
                Error::Invalid(format!(
                    "cluster {cluster_name} not found in remote kubeconfig"
                ))
            })?;

        let cluster_inner = cluster_entry
            .cluster
            .as_mut()
            .ok_or_else(|| Error::Invalid(format!("cluster {cluster_name} has no body")))?;

        let original_server = cluster_inner
            .server
            .clone()
            .ok_or_else(|| Error::Invalid(format!("cluster {cluster_name} has no server URL")))?;

        let (target_host, target_port, original_scheme) = parse_server_url(&original_server)?;

        // 4. Open the SSH tunnel — local 127.0.0.1:0 ↔ remote target_host:target_port.
        let tunnel = session
            .open_tunnel(target_host.clone(), target_port)
            .await?;
        let local_port = tunnel.local_port();

        // 5. Rewrite the kubeconfig in place: server → localhost tunnel,
        //    tls-server-name → original host (so SNI + cert verify still
        //    behave as if we were talking to the apiserver directly).
        cluster_inner.server = Some(format!("{original_scheme}://127.0.0.1:{local_port}"));
        if cluster_inner.tls_server_name.is_none() {
            cluster_inner.tls_server_name = Some(target_host.clone());
        }

        tracing::info!(
            ssh_host = %cfg.host,
            target = %format!("{target_host}:{target_port}"),
            local_port,
            "ssh: tunnel ready, building kube client"
        );

        // 6. Build the kube Config + Client off the rewritten kubeconfig.
        let options = KubeConfigOptions {
            context: Some(context_name.to_owned()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let client = build_compressed_client(config.clone())?;

        Ok(Self {
            context_name: context_name.to_owned(),
            client,
            config,
            watcher_pool: Mutex::new(Vec::with_capacity(WATCHER_CLIENT_POOL_SIZE)),
            watcher_pool_cursor: AtomicUsize::new(0),
            list_strategy: std::sync::OnceLock::new(),
            ssh: Some(session),
            tunnel: Some(tunnel),
        })
    }

    /// Apiserver version + node count. Used as a proof-of-life check, not a
    /// steady-state read. The two round-trips run concurrently — they're
    /// independent and on the connect path, where every millisecond is visible
    /// to the operator staring at the "Connecting…" spinner.
    pub async fn info(&self) -> Result<ClusterInfo> {
        let nodes: Api<Node> = Api::all(self.client.clone());
        let lp = ListParams::default();
        let started = std::time::Instant::now();
        let (version, list) = tokio::try_join!(self.client.apiserver_version(), nodes.list(&lp),)?;
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "cluster.info: version + nodes"
        );
        // Pick a strategy. Version is just a pre-filter — the live probe
        // is what decides whether we actually use Streaming, because GKE
        // / EKS / AKS happily ship 1.32+ apiservers with the WatchList
        // feature gate disabled. Skip the probe entirely if version
        // already excludes Streaming (saves the round-trip on older
        // clusters).
        let from_version = strategy_from_version(&version.git_version);
        let strategy = if from_version == ListStrategy::Streaming
            && probe_streaming_supported(&self.client).await
        {
            ListStrategy::Streaming
        } else {
            ListStrategy::Paged
        };
        let _ = self.list_strategy.set(strategy);
        tracing::info!(
            context = %self.context_name,
            server_version = %version.git_version,
            ?from_version,
            ?strategy,
            "cluster.info: list strategy chosen"
        );
        Ok(ClusterInfo {
            server_version: version.git_version,
            node_count: list.items.len(),
        })
    }

    pub fn client(&self) -> Client {
        self.client.clone()
    }

    /// Local port the SSH tunnel is listening on, if this cluster was built
    /// via `connect_ssh`. Used by the agent's MCP-child wiring to write a
    /// scratch kubeconfig pointing at the same tunnel.
    pub fn tunnel_local_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(TunnelHandle::local_port)
    }

    /// SSH session details (user / host / port) backing this cluster, if any.
    /// Useful for diagnostics — we never need to reconnect via this; the
    /// session is held alive on `self`.
    pub fn ssh_target(&self) -> Option<(String, String, u16)> {
        self.ssh
            .as_ref()
            .map(|s| (s.user().to_owned(), s.host().to_owned(), s.port()))
    }

    /// Build a fresh `kube::Client` from the original Config, with its own
    /// HTTP/2 connection pool. Used by long-running watchers so a stalled
    /// LIST on one stream can't block another, and so the watcher's H2
    /// connection isn't shared with one-shot calls (`apiserver_version`,
    /// node lists, prometheus discovery, etc.) that may hold open streams
    /// or trigger flow-control penalties on this connection. Cheap on
    /// success — auth is already resolved on the Config.
    pub fn new_client(&self) -> Result<Client> {
        build_compressed_client(self.config.clone())
    }

    /// Hand back a watcher-dedicated client from the round-robin pool.
    /// Lazily fills the pool up to [`WATCHER_CLIENT_POOL_SIZE`] entries on
    /// demand; subsequent calls cycle through the slots so multiple
    /// reflectors share a small fixed set of H2 connections instead of
    /// one each. Falls back to the shared client on builder failure
    /// rather than failing the subscribe.
    pub fn watcher_client(&self) -> Client {
        let mut pool = self
            .watcher_pool
            .lock()
            .expect("watcher client pool poisoned");
        if pool.len() < WATCHER_CLIENT_POOL_SIZE {
            match build_compressed_client(self.config.clone()) {
                Ok(c) => pool.push(c),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "watcher_client: build failed, falling back to shared client"
                    );
                    return self.client.clone();
                }
            }
        }
        let idx = self.watcher_pool_cursor.fetch_add(1, Ordering::Relaxed) % pool.len();
        pool[idx].clone()
    }

    /// Watcher initial-list strategy for this cluster. Currently always
    /// `Paged` — see [`strategy_from_version`] for why we don't
    /// auto-promote to `Streaming` based on apiserver version.
    pub fn list_strategy(&self) -> ListStrategy {
        self.list_strategy
            .get()
            .copied()
            .unwrap_or(ListStrategy::Paged)
    }
}

/// Cheap pre-filter: rule out apiservers that *can't* support `WatchList`
/// regardless of feature gate. `WatchList` is alpha in 1.27, beta in 1.30,
/// default-on in 1.32. Anything older is unambiguously `Paged`.
///
/// **A 1.32+ result is not authoritative** — managed Kubernetes (GKE,
/// EKS, AKS) commonly disables the feature gate even on recent apiservers,
/// so `Streaming` here is just a hint. `probe_streaming_supported` does
/// the live check that decides for real.
fn strategy_from_version(git_version: &str) -> ListStrategy {
    let Some((major, minor)) = parse_major_minor(git_version) else {
        return ListStrategy::Paged;
    };
    if (major, minor) >= (1, 32) {
        ListStrategy::Streaming
    } else {
        ListStrategy::Paged
    }
}

/// Live probe: ask the apiserver for a watch with `sendInitialEvents=true`
/// against a tiny resource (one namespace) and inspect the response. If
/// the apiserver answers `422 Forbidden: sendInitialEvents is forbidden`
/// the feature gate is off — fall back to `Paged`. Anything else (200 or
/// even a different error) is treated as "supports it" / "not our
/// problem"; the watcher will surface real errors during normal operation.
///
/// Bounded by a short timeout because a slow apiserver here would block
/// connect's strategy-decision phase. We re-use `connect_context`'s
/// existing 15s wall-clock budget for everything else, so the probe
/// caps itself to keep that intact.
async fn probe_streaming_supported(client: &Client) -> bool {
    use http::Request;
    use kube::client::Body;
    use std::time::Duration;
    use tokio::time::timeout;

    // `limit=1` keeps the response small if the apiserver does honour the
    // request; `timeoutSeconds=1` makes the apiserver close its side
    // promptly so we don't have to drop a long-lived stream.
    let uri = "/api/v1/namespaces?\
        watch=true&\
        sendInitialEvents=true&\
        allowWatchBookmarks=true&\
        resourceVersionMatch=NotOlderThan&\
        resourceVersion=0&\
        limit=1&\
        timeoutSeconds=1";
    let req = match Request::builder().method("GET").uri(uri).body(Vec::new()) {
        Ok(r) => r,
        Err(_) => return false,
    };

    let send_fut = client.send(req.map(Body::from));
    let resp = match timeout(Duration::from_secs(2), send_fut).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "streaming probe: send failed");
            return false;
        }
        Err(_) => {
            tracing::debug!("streaming probe: timed out");
            return false;
        }
    };
    let status = resp.status();
    if status.is_success() {
        // 200 means apiserver accepted the request and is opening the
        // watch stream. Drop it — we just wanted the verdict.
        return true;
    }
    // 422 Invalid + the magic "sendInitialEvents is forbidden" marker is
    // the unambiguous "feature gate disabled" answer. Other errors
    // (auth, RBAC, etc.) we treat as "don't downgrade" — the user-facing
    // watcher will surface the same problem with better context.
    if status.as_u16() == 422 {
        // Body usually contains the marker string. We don't bother
        // parsing the JSON — substring check is enough.
        let body = resp.into_body();
        use http_body_util::BodyExt;
        if let Ok(collected) = body.collect().await {
            let bytes = collected.to_bytes();
            let s = std::str::from_utf8(&bytes).unwrap_or("");
            if s.contains("sendInitialEvents") {
                tracing::info!(
                    "streaming probe: apiserver reports WatchList feature \
                     gate disabled; using Paged"
                );
                return false;
            }
        }
    }
    // Default to "supported" so we don't mask other errors as a
    // capability fail. The watcher's own error handling will catch
    // real apiserver problems.
    true
}

fn parse_major_minor(s: &str) -> Option<(u32, u32)> {
    // Strip a leading 'v' if present, then split on '.' / '-' / '+'.
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut parts = s.split(['.', '-', '+']);
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Parse a kubeconfig `cluster.server` URL into `(host, port, scheme)`. The
/// kube apiserver is always either `http` or `https`; anything else is
/// rejected. Default ports follow the scheme (80 for http, 443 for https).
fn parse_server_url(url: &str) -> Result<(String, u16, String)> {
    let trimmed = url.trim();
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else {
        return Err(Error::Invalid(format!(
            "unsupported scheme in server url: {url}"
        )));
    };
    // Strip any path (`/k8s`, …); we only need authority for the tunnel.
    let authority = rest.split('/').next().unwrap_or(rest);
    // IPv6 literal: `[::1]:6443`.
    if let Some(after_bracket) = authority.strip_prefix('[') {
        let close = after_bracket
            .find(']')
            .ok_or_else(|| Error::Invalid(format!("malformed IPv6 in server url: {url}")))?;
        let host = after_bracket[..close].to_owned();
        let port_part = &after_bracket[close + 1..];
        let port = if let Some(p) = port_part.strip_prefix(':') {
            p.parse::<u16>()
                .map_err(|e| Error::Invalid(format!("bad port in {url}: {e}")))?
        } else if scheme == "https" {
            443
        } else {
            80
        };
        return Ok((host, port, scheme.to_owned()));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p
                .parse()
                .map_err(|e| Error::Invalid(format!("bad port in {url}: {e}")))?;
            (h.to_owned(), port)
        }
        None => (
            authority.to_owned(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    if host.is_empty() {
        return Err(Error::Invalid(format!("empty host in server url: {url}")));
    }
    Ok((host, port, scheme.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_from_version_handles_common_shapes() {
        assert_eq!(strategy_from_version("v1.32.0"), ListStrategy::Streaming);
        assert_eq!(strategy_from_version("v1.33.4"), ListStrategy::Streaming);
        assert_eq!(strategy_from_version("v1.31.5"), ListStrategy::Paged);
        assert_eq!(
            strategy_from_version("v1.30.4-gke.1234"),
            ListStrategy::Paged
        );
        assert_eq!(strategy_from_version("1.27.0"), ListStrategy::Paged);
        assert_eq!(strategy_from_version("v2.0.0"), ListStrategy::Streaming);
        assert_eq!(strategy_from_version("garbage"), ListStrategy::Paged);
        assert_eq!(strategy_from_version(""), ListStrategy::Paged);
    }

    #[test]
    fn parse_server_url_common_shapes() {
        assert_eq!(
            parse_server_url("https://10.0.0.1:6443").unwrap(),
            ("10.0.0.1".to_owned(), 6443, "https".to_owned())
        );
        assert_eq!(
            parse_server_url("https://k8s.example.com").unwrap(),
            ("k8s.example.com".to_owned(), 443, "https".to_owned())
        );
        assert_eq!(
            parse_server_url("http://api.local:8080/k8s").unwrap(),
            ("api.local".to_owned(), 8080, "http".to_owned())
        );
        assert_eq!(
            parse_server_url("https://[::1]:6443").unwrap(),
            ("::1".to_owned(), 6443, "https".to_owned())
        );
        assert!(parse_server_url("ftp://nope:21").is_err());
        assert!(parse_server_url("https://:6443").is_err());
    }
}
