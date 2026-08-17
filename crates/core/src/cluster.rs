//! Per-context cluster connection.
//!
//! Holds a `kube::Client` keyed to a single kubeconfig context. Supervisor /
//! reflector machinery lands in M0.4 — for now this is just enough to prove
//! we can talk to an apiserver.

use crate::sync::LockExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use std::time::Duration;

use http::{header::ACCEPT_ENCODING, HeaderValue};
use hyper::rt::{Read, Write};
use hyper_timeout::TimeoutConnector;
use hyper_util::client::legacy::{
    connect::{Connection, HttpConnector},
    Builder as LegacyBuilder,
};
use hyper_util::rt::TokioExecutor;
use k8s_openapi::api::core::v1::Node;
use kube::{
    api::{Api, ListParams},
    client::{AuthError, Body, ClientBuilder, ConfigExt, DynBody},
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use serde::Serialize;
use tower::{BoxError, Service, ServiceBuilder, ServiceExt as _};
use tower_http::{
    decompression::DecompressionLayer, set_header::SetRequestHeaderLayer, ServiceExt as _,
};

use crate::exec_auth::{self, redact_and_truncate};
use crate::sources::SshSourceConfig;
use crate::ssh::{SshSession, TunnelHandle};
use crate::{Error, Result};

// --- Watch-connection liveness -------------------------------------------
//
// Root cause of "a Deployment deleted+recreated by external CI/CD never shows
// up, but its Pod does": kube-rs negotiates **HTTP/1.1** to the apiserver
// (kube-client's rustls connector enables ALPN `http/1.1` only — see
// `ConfigExt::rustls_https_connector_with_connector`, config_ext.rs:248), so
// every watch rides its **own** TCP connection with no multiplexing. A busy
// Pods watch keeps its socket full of traffic; an idle Deployments watch sits
// silent, and a NAT box / cloud L4 LB / conntrack table (AWS NLB ~350 s, GCP
// ~600 s, conntrack ~5 min) silently evicts the idle flow half-open. The
// default `HttpConnector` sets **no** SO_KEEPALIVE, so the kernel never probes;
// kube's only backstop was the coarse 295 s `TimeoutConnector` read-timeout,
// and the recreate is missed until then (if it fires at all).
//
// TCP keepalive fixes both halves: probing every [`TCP_KEEPALIVE_INTERVAL`]
// keeps the NAT mapping warm (so the flow is never evicted), and on a path that
// has actually died the probes go unanswered and error the socket within
// ~[`TCP_KEEPALIVE_IDLE`] + retries — kube-rs's `default_backoff()` then
// reconnects and re-LISTs, surfacing the recreate.

/// Idle time before the kernel sends the first TCP keepalive probe.
const TCP_KEEPALIVE_IDLE: Duration = Duration::from_secs(30);

/// Gap between TCP keepalive probes once they start. Also the cadence at which
/// an *idle-but-healthy* connection is kept warm through NAT.
const TCP_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

/// Unacked probes before the socket is declared dead. With idle 30 s + 10 s ×
/// 3, a severed idle watch surfaces an error in ~60 s instead of ~11 min (the
/// OS default) or 295 s (kube's read-timeout).
const TCP_KEEPALIVE_RETRIES: u32 = 3;

/// HTTP/2 keepalive-while-idle. **Inert today** — kube 3.1 negotiates HTTP/1.1
/// to the apiserver (above), so no H2 connection exists to ping. Kept as
/// zero-cost future-proofing: if a future kube/feature enables H2 ALPN, these
/// PINGs become the h2-equivalent of the TCP keepalive above. Interval must be
/// `>` [`H2_KEEPALIVE_TIMEOUT`] so a missed ACK is acted on before the next.
const H2_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// PING-ACK deadline for [`H2_KEEPALIVE_INTERVAL`] (inert under HTTP/1.1).
const H2_KEEPALIVE_TIMEOUT: Duration = Duration::from_secs(20);

/// Build a `kube::Client` equivalent to `ClientBuilder::try_from(config)`'s
/// default stack, **plus** TCP keepalive on the socket (the watch-liveness fix —
/// see the const docs above) and inert-today H2 keepalive, **plus** the two
/// compression layers below.
///
/// * [`SetRequestHeaderLayer`] adds `Accept-Encoding: gzip` to every request so
///   the apiserver can compress the body. Measured ratio on real Pod LIST
///   responses is ~7×; the typed reflector's "kubectl is way faster" gap is
///   almost entirely this header. `if_not_present` lets a caller disable
///   compression per-call (e.g. the bench's identity variants) by setting its
///   own header.
/// * [`DecompressionLayer`] transparently inflates `Content-Encoding: gzip`
///   responses so kube-rs's deserialiser sees plain JSON.
///
/// kube 3.1 exposes no keepalive knob (the hyper client is built privately
/// inside `make_generic_builder`), so we re-assemble the generic stack through
/// the public [`ConfigExt`] extension API. This mirrors kube-client's
/// `make_generic_builder` (builder.rs) — base-uri + auth (exec/oidc/oauth) +
/// extra-headers layers over a rustls + timeout connector — with keepalive
/// injected and our compression layers as the outermost wrappers.
///
/// One intentional behavioural delta vs. `try_from`: `Config::exec_identity_pem`
/// is `pub(crate)`, so we cannot set `ClientBuilder::with_valid_until` for
/// exec-credential expiry. That clock is redundant here — every reconnect
/// rebuilds `Config` (so auth is re-resolved) and reflectors re-LIST on 401.
fn build_compressed_client(config: Config) -> Result<Client> {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    // TCP keepalive — the operative liveness fix (see the const docs above).
    http.set_keepalive(Some(TCP_KEEPALIVE_IDLE));
    http.set_keepalive_interval(Some(TCP_KEEPALIVE_INTERVAL));
    http.set_keepalive_retries(Some(TCP_KEEPALIVE_RETRIES));

    // Mirror kube's `ClientBuilder::try_from` proxy dispatch, restricted to the
    // features this workspace enables: `http-proxy` only (no `socks5`). Each arm
    // hands a concrete connector to the generic `finish_kube_client`.
    match config.proxy_url.clone() {
        Some(proxy_url) if proxy_url.scheme_str() == Some("http") => {
            let mut connector =
                hyper_util::client::legacy::connect::proxy::Tunnel::new(proxy_url.clone(), http);
            if let Some(authority) = proxy_url.authority() {
                if let Some((userinfo, _)) = authority.as_str().split_once('@') {
                    use base64::Engine as _;
                    let value = format!(
                        "Basic {}",
                        base64::engine::general_purpose::STANDARD.encode(userinfo)
                    );
                    if let Ok(header) = HeaderValue::from_str(&value) {
                        connector = connector.with_auth(header);
                    }
                }
            }
            finish_kube_client(connector, config)
        }
        Some(proxy_url) => Err(Error::Invalid(format!(
            "unsupported proxy scheme in {proxy_url} (only http proxies are supported)"
        ))),
        None => finish_kube_client(http, config),
    }
}

/// Assemble the kube tower stack over `connector` (which already carries TCP
/// keepalive), adding the inert-today H2 keepalive and the gzip compression
/// layers. Generic over the connector so the proxy and no-proxy paths share one
/// body (the connector types differ — `Tunnel<HttpConnector>` vs
/// `HttpConnector`). Bounds mirror kube-client's `make_generic_builder<H>`.
fn finish_kube_client<H>(connector: H, config: Config) -> Result<Client>
where
    H: 'static + Clone + Send + Sync + Service<http::Uri>,
    H::Response: 'static + Connection + Read + Write + Send + Unpin,
    H::Future: 'static + Send,
    H::Error: 'static + Send + Sync + std::error::Error,
{
    let default_ns = config.default_namespace.clone();
    let auth_layer = config.auth_layer()?;

    // TLS via the public ConfigExt, then kube's connect/read/write timeouts.
    let https = config.rustls_https_connector_with_connector(connector)?;
    let mut timeout = TimeoutConnector::new(https);
    timeout.set_connect_timeout(config.connect_timeout);
    timeout.set_read_timeout(config.read_timeout);
    timeout.set_write_timeout(config.write_timeout);

    // H2 keepalive-while-idle. Inert under kube's HTTP/1.1 ALPN; the live
    // liveness fix is the TCP keepalive on the connector. See const docs.
    let mut hyper_builder = LegacyBuilder::new(TokioExecutor::new());
    hyper_builder
        .http2_keep_alive_interval(H2_KEEPALIVE_INTERVAL)
        .http2_keep_alive_timeout(H2_KEEPALIVE_TIMEOUT)
        .http2_keep_alive_while_idle(true);
    let hyper_client: hyper_util::client::legacy::Client<_, Body> = hyper_builder.build(timeout);

    // Tower stack. Our two compression layers go OUTERMOST (first in the
    // builder) so they wrap kube's base-uri/auth/extra-headers exactly as the
    // previous `try_from(..).with_layer(..).with_layer(..)` did. kube's own
    // `gzip` feature is off in this workspace, so this is the sole
    // decompression layer — no double-inflate.
    let service = ServiceBuilder::new()
        .layer(SetRequestHeaderLayer::if_not_present(
            ACCEPT_ENCODING,
            HeaderValue::from_static("gzip"),
        ))
        .layer(DecompressionLayer::new())
        .layer(config.base_uri_layer())
        .option_layer(auth_layer)
        .layer(config.extra_headers_layer()?)
        .map_err(BoxError::from)
        .service(hyper_client);

    let service = service
        .map_response_body(|body| {
            Box::new(http_body_util::BodyExt::map_err(body, BoxError::from)) as Box<DynBody>
        })
        .boxed();

    Ok(ClientBuilder::new(service, default_ns).build())
}

/// The exec-credential plugin command configured for `context_name`'s user, if
/// any (e.g. `gke-gcloud-auth-plugin`). Looked up off the parsed kubeconfig so
/// an opaque ENOENT from kube-rs's `auth_exec` can be turned into an actionable
/// "plugin X not found on PATH" message — kube-rs surfaces only the raw
/// `io::Error`, not the command or an install hint.
fn exec_plugin_for_context(kc: &Kubeconfig, context_name: &str) -> Option<String> {
    let user = kc
        .contexts
        .iter()
        .find(|c| c.name == context_name)
        .and_then(|c| c.context.as_ref())
        .and_then(|ctx| ctx.user.clone())?;
    kc.auth_infos
        .iter()
        .find(|a| a.name == user)
        .and_then(|a| a.auth_info.as_ref())
        .and_then(|ai| ai.exec.as_ref())
        .and_then(|e| e.command.clone())
}

/// If `err`'s source chain bottoms out in an `io::ErrorKind::NotFound` (the
/// signature of a kubeconfig exec auth plugin missing from `PATH`) and we know
/// the plugin command, replace the opaque kube error with an actionable one.
/// Gated strictly on `NotFound` so a `PermissionDenied` plugin (a different
/// failure) is never mislabelled as "not found".
fn enrich_exec_error(err: Error, exec_command: Option<String>) -> Error {
    // ENOENT — plugin binary missing from PATH (spawn failure). Highest
    // priority: a missing binary and a non-zero exit are distinct failures, and
    // "not found" is the more actionable label, so it wins when both could match.
    if io_not_found_in_chain(&err) {
        if let Some(command) = exec_command {
            let hint = exec_install_hint(&command);
            return Error::ExecPluginNotFound { command, hint };
        }
        return err;
    }
    // Plugin ran but exited non-zero. kube-rs has the stderr in `AuthExecRun`,
    // but its `Display` prints `{out:?}` (raw byte arrays). Reformat to readable,
    // redacted, truncated UTF-8 so the operator sees the real cause.
    if let Some((command, code, stderr)) = auth_exec_run_in_chain(&err) {
        return Error::ExecPluginFailed {
            command,
            code,
            stderr,
        };
    }
    err
}

/// Walk the source chain for kube-rs's [`AuthError::AuthExecRun`] (the plugin
/// ran and exited non-zero). Returns `(command, exit-code-string, readable
/// stderr)`. The plugin's stderr is captured by kube-rs but only Debug-printed
/// as raw bytes; we decode it lossily, redact credential material, and truncate.
fn auth_exec_run_in_chain(
    err: &(dyn std::error::Error + 'static),
) -> Option<(String, String, String)> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(AuthError::AuthExecRun { cmd, status, out }) = e.downcast_ref::<AuthError>() {
            let code = status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| status.to_string());
            // Prefer stderr (human error messages); fall back to stdout (some
            // plugins emit the failure there).
            let raw = if out.stderr.is_empty() {
                String::from_utf8_lossy(&out.stdout)
            } else {
                String::from_utf8_lossy(&out.stderr)
            };
            return Some((cmd.clone(), code, redact_and_truncate(&raw)));
        }
        cur = e.source();
    }
    None
}

/// Walk the [`std::error::Error`] source chain looking for an `io::Error` of
/// kind `NotFound`. Depends only on the std error trait + an `io::Error`
/// downcast, so it's robust to kube-rs's internal error-enum shape changing
/// across versions.
fn io_not_found_in_chain(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            if io.kind() == std::io::ErrorKind::NotFound {
                return true;
            }
        }
        cur = e.source();
    }
    false
}

/// Best-effort, actionable install hint keyed off the plugin command name.
/// kube-rs's `ExecConfig` doesn't parse the kubeconfig `installHint`, so we
/// synthesize guidance for the common providers and fall back to a generic
/// PATH explanation.
fn exec_install_hint(command: &str) -> String {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    if base.contains("gke-gcloud-auth-plugin") || base == "gcloud" {
        "install the gcloud CLI and run `gcloud components install gke-gcloud-auth-plugin`, \
         then ensure it is on your PATH"
            .to_owned()
    } else if base.contains("aws-iam-authenticator") {
        "install aws-iam-authenticator and ensure it is on your PATH".to_owned()
    } else if base.contains("aws") {
        "install the AWS CLI v2 and ensure `aws` is on your PATH".to_owned()
    } else if base.contains("kubelogin") {
        "install Azure kubelogin (`az aks install-cli`) and ensure it is on your PATH".to_owned()
    } else {
        format!(
            "ensure `{base}` is installed and on the PATH the app sees — it may resolve in \
             your terminal but not when the app is launched from Finder/Dock"
        )
    }
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
        let mut kubeconfig = match source_path {
            Some(p) => Kubeconfig::read_from(p)?,
            None => Kubeconfig::read()?,
        };
        // Capture the context's exec-plugin command before `kubeconfig` is
        // consumed, so a later ENOENT from that plugin can be turned into an
        // actionable error instead of a raw "No such file or directory".
        let exec_command = exec_plugin_for_context(&kubeconfig, context_name);
        // Run the gcloud auth plugin once ourselves, before kube-rs spawns it
        // per `Client`. Two payoffs: its stderr is ours to read (kube-rs
        // inherits it, so `AuthExecRun` arrives empty), and a success warms the
        // token-cache slot the later spawns read instead of each shelling out to
        // gcloud. See `crate::exec_auth`.
        if let Some(prepared) = exec_auth::prepare(&mut kubeconfig, context_name) {
            match exec_auth::preflight(&prepared).await {
                exec_auth::PreflightOutcome::Failed { code, stderr } => {
                    return Err(exec_auth::failure_error(&prepared, code, stderr));
                }
                exec_auth::PreflightOutcome::Missing => {
                    return Err(Error::ExecPluginNotFound {
                        hint: exec_install_hint(&prepared.command),
                        command: prepared.command,
                    });
                }
                // No information — a spawn that failed for an unrelated reason,
                // or one slower than the preflight budget. Connecting anyway
                // keeps a working cluster reachable; kube-rs gets its own try.
                exec_auth::PreflightOutcome::Inconclusive(why) => tracing::debug!(
                    target: "ferrisscope::auth",
                    context = context_name,
                    "exec preflight inconclusive ({why})"
                ),
                exec_auth::PreflightOutcome::Warmed => {}
            }
        }
        let options = KubeConfigOptions {
            context: Some(context_name.to_owned()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let client = build_compressed_client(config.clone())
            .map_err(|e| enrich_exec_error(e, exec_command))?;
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
        let exec_command = exec_plugin_for_context(&kubeconfig, context_name);
        let options = KubeConfigOptions {
            context: Some(context_name.to_owned()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let client = build_compressed_client(config.clone())
            .map_err(|e| enrich_exec_error(e, exec_command))?;

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
        let mut pool = self.watcher_pool.lock_recover();
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

// ---------------------------------------------------------------------------
// Connection diagnostics (passive / read-only)
//
// Answers "what does the app actually see" without executing the auth plugin
// (kube-rs already surfaces live plugin stderr via `enrich_exec_error`). Reports
// the resolved PATH, whether the context's exec plugin is findable, and which
// cloud/proxy/TLS env vars are present (presence only — never values).
// ---------------------------------------------------------------------------

/// Cloud / proxy / TLS env vars whose *presence* is worth showing the operator
/// when a connection fails. Values are deliberately never read or returned.
const DIAG_ENV_KEYS: &[&str] = &[
    "HOME",
    "USERPROFILE", // Windows HOME equivalent
    "KUBECONFIG",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_ROLE_ARN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "CLOUDSDK_CONFIG",
    "CLOUDSDK_CORE_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CONFIG_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// The exec-credential plugin declared for a context, including its args.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecProbe {
    pub command: String,
    pub args: Vec<String>,
    /// Absolute path the command resolves to on the app's PATH, if found.
    pub resolved_path: Option<String>,
    pub found: bool,
}

/// Presence (not value) of one diagnostic env var.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EnvPresence {
    pub key: String,
    pub present: bool,
}

/// Read-only snapshot of what the app sees for a context's connection.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionDiagnostics {
    /// The process PATH the app will hand to exec plugins, split per entry.
    pub resolved_path: Vec<String>,
    /// The context's exec plugin + whether it's findable. `None` if the context
    /// uses no exec plugin (in-cluster token, client cert, basic auth, …).
    pub exec: Option<ExecProbe>,
    pub env_presence: Vec<EnvPresence>,
}

/// A context's exec-credential plugin as declared in the kubeconfig.
pub struct ExecSpec {
    pub command: String,
    pub args: Vec<String>,
    /// The exec `env` block, flattened to `(name, value)` pairs. These are
    /// applied to the plugin process, so a `CLOUDSDK_CORE_ACCOUNT` here pins the
    /// gcloud identity exactly as an `--account` flag would —
    /// [`crate::cloud_identity::classify`] needs both to classify a context.
    pub env: Vec<(String, String)>,
}

/// Extract a context's exec command + args + env (the args matter for
/// diagnostics: e.g. `gke-gcloud-auth-plugin` vs `gcloud config config-helper`).
fn exec_for_context(kc: &Kubeconfig, context_name: &str) -> Option<ExecSpec> {
    let user = kc
        .contexts
        .iter()
        .find(|c| c.name == context_name)
        .and_then(|c| c.context.as_ref())
        .and_then(|ctx| ctx.user.clone())?;
    let exec = kc
        .auth_infos
        .iter()
        .find(|a| a.name == user)
        .and_then(|a| a.auth_info.as_ref())
        .and_then(|ai| ai.exec.as_ref())?;
    let command = exec.command.clone()?;
    let args = exec.args.clone().unwrap_or_default();
    // kube models the exec env as a list of free-form maps rather than a typed
    // pair, mirroring the `{name, value}` shape the k8s exec spec uses. Entries
    // missing either key are meaningless to the plugin, so drop them.
    let env = exec
        .env
        .as_ref()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| Some((e.get("name")?.clone(), e.get("value")?.clone())))
                .collect()
        })
        .unwrap_or_default();
    Some(ExecSpec { command, args, env })
}

/// Expand one candidate into the forms a spawn would actually try. On Windows a
/// bare `foo` resolves to `foo.exe`/`foo.cmd`/… via PATHEXT (which `Command::new`
/// applies), so the diagnostic must do the same or it falsely reports a present
/// `.exe` as missing. On unix the command is taken verbatim.
fn path_candidates(base: PathBuf) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut v = vec![base.clone()];
        if base.extension().is_none() {
            let exts =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                let mut p = base.clone().into_os_string();
                p.push(ext);
                v.push(PathBuf::from(p));
            }
        }
        v
    }
    #[cfg(not(windows))]
    {
        vec![base]
    }
}

/// Resolve a command against the app's current PATH the same way a spawn would:
/// an absolute / path-bearing command is checked directly; a bare name is
/// scanned across PATH entries (applying PATHEXT on Windows). Returns the
/// resolved file, or `None` if missing.
fn resolve_in_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') || command.contains(std::path::MAIN_SEPARATOR) {
        return path_candidates(PathBuf::from(command))
            .into_iter()
            .find(|p| p.is_file());
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .flat_map(|dir| path_candidates(dir.join(command)))
        .find(|cand| cand.is_file())
}

/// The exec-credential plugin declared for a context, read fresh off disk.
/// `Ok(None)` when the context authenticates without one (token, client cert,
/// in-cluster). Backs [`crate::cloud_identity::hint_for_context`].
///
/// # Errors
///
/// Propagates kubeconfig read/parse failures.
pub fn exec_spec_for_context(
    context_name: &str,
    source_path: Option<&Path>,
) -> Result<Option<ExecSpec>> {
    let kubeconfig = match source_path {
        Some(p) => Kubeconfig::read_from(p)?,
        None => Kubeconfig::read()?,
    };
    Ok(exec_for_context(&kubeconfig, context_name))
}

/// Build a read-only [`ConnectionDiagnostics`] for a context. Reads the
/// kubeconfig and inspects the process env/PATH; never executes the plugin.
pub fn diagnose_context(
    context_name: &str,
    source_path: Option<&Path>,
) -> Result<ConnectionDiagnostics> {
    let kubeconfig = match source_path {
        Some(p) => Kubeconfig::read_from(p)?,
        None => Kubeconfig::read()?,
    };
    let exec = exec_for_context(&kubeconfig, context_name).map(|spec| {
        let resolved = resolve_in_path(&spec.command);
        ExecProbe {
            found: resolved.is_some(),
            resolved_path: resolved.map(|p| p.display().to_string()),
            command: spec.command,
            args: spec.args,
        }
    });
    let resolved_path = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.display().to_string())
                .collect()
        })
        .unwrap_or_default();
    let env_presence = DIAG_ENV_KEYS
        .iter()
        .map(|k| EnvPresence {
            key: (*k).to_string(),
            present: std::env::var_os(k).is_some(),
        })
        .collect();
    Ok(ConnectionDiagnostics {
        resolved_path,
        exec,
        env_presence,
    })
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

    #[test]
    fn h2_keepalive_timeout_below_interval() {
        // A missed PING ACK must be acted on before the next ping is queued.
        assert!(H2_KEEPALIVE_TIMEOUT < H2_KEEPALIVE_INTERVAL);
    }

    // `ClientBuilder::build()` spawns a `tower::Buffer` worker, so these need a
    // running reactor even though no network I/O happens.
    #[tokio::test]
    async fn build_compressed_client_assembles_plain_config() {
        // Exercises the whole reassembled connector/TLS/timeout/tower stack with
        // keepalive — the principal risk is whether this type stack assembles
        // (and that the rustls connector builds without a process crypto
        // provider, since our hand-rolled path skips kube's `try_from`).
        let config = Config::new("https://127.0.0.1:6443".parse().unwrap());
        assert!(build_compressed_client(config).is_ok());
    }

    #[tokio::test]
    async fn build_compressed_client_assembles_http_proxy_config() {
        let mut config = Config::new("https://127.0.0.1:6443".parse().unwrap());
        config.proxy_url = Some("http://127.0.0.1:3128".parse().unwrap());
        assert!(build_compressed_client(config).is_ok());
    }

    #[test]
    fn build_compressed_client_rejects_unsupported_proxy() {
        // socks5 is not enabled in this workspace; the dispatch must reject it
        // rather than silently fall through to a direct connection.
        let mut config = Config::new("https://127.0.0.1:6443".parse().unwrap());
        config.proxy_url = Some("socks5://127.0.0.1:1080".parse().unwrap());
        assert!(matches!(
            build_compressed_client(config),
            Err(Error::Invalid(_))
        ));
    }

    /// A synthetic error that wraps an `io::Error` in its source chain, to
    /// exercise `io_not_found_in_chain` without depending on kube-rs internals.
    #[derive(Debug)]
    struct Wrap(std::io::Error);
    impl std::fmt::Display for Wrap {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "wrap")
        }
    }
    impl std::error::Error for Wrap {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn io_not_found_walks_the_source_chain() {
        let not_found = Wrap(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(io_not_found_in_chain(&not_found));
        // A different io error in the chain must not match.
        let denied = Wrap(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(!io_not_found_in_chain(&denied));
        // A non-io error with no io source must not match.
        assert!(!io_not_found_in_chain(&Error::Invalid("nope".into())));
    }

    #[test]
    fn enrich_exec_error_only_relabels_not_found_with_a_command() {
        // NotFound + known command → actionable ExecPluginNotFound.
        let e = enrich_exec_error(
            Error::Io(std::io::Error::from(std::io::ErrorKind::NotFound)),
            Some("gke-gcloud-auth-plugin".to_owned()),
        );
        match e {
            Error::ExecPluginNotFound { command, hint } => {
                assert_eq!(command, "gke-gcloud-auth-plugin");
                assert!(hint.contains("gke-gcloud-auth-plugin"));
            }
            other => panic!("expected ExecPluginNotFound, got {other:?}"),
        }
        // PermissionDenied → left untouched (not relabelled as "not found").
        assert!(!matches!(
            enrich_exec_error(
                Error::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
                Some("gke-gcloud-auth-plugin".to_owned()),
            ),
            Error::ExecPluginNotFound { .. }
        ));
        // NotFound but no known plugin command → left untouched.
        assert!(!matches!(
            enrich_exec_error(
                Error::Io(std::io::Error::from(std::io::ErrorKind::NotFound)),
                None,
            ),
            Error::ExecPluginNotFound { .. }
        ));
    }

    #[test]
    fn exec_install_hint_is_provider_specific() {
        assert!(exec_install_hint("gke-gcloud-auth-plugin").contains("gcloud components install"));
        assert!(exec_install_hint("gcloud").contains("gcloud components install"));
        assert!(
            exec_install_hint("/abs/path/aws-iam-authenticator").contains("aws-iam-authenticator")
        );
        assert!(exec_install_hint("kubelogin").contains("kubelogin"));
        // Unknown plugin → generic PATH guidance naming the binary.
        let generic = exec_install_hint("/opt/tools/my-custom-auth");
        assert!(generic.contains("my-custom-auth"));
        assert!(generic.contains("PATH"));
    }

    #[test]
    fn exec_plugin_for_context_resolves_command_via_user() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: gke
clusters:
- name: c
  cluster:
    server: https://1.2.3.4
contexts:
- name: gke
  context:
    cluster: c
    user: gke-user
- name: no-exec
  context:
    cluster: c
    user: token-user
users:
- name: gke-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
- name: token-user
  user:
    token: abc
"#;
        let kc = Kubeconfig::from_yaml(yaml).expect("parse kubeconfig");
        assert_eq!(
            exec_plugin_for_context(&kc, "gke"),
            Some("gke-gcloud-auth-plugin".to_owned())
        );
        // A context whose user has no exec stanza → None.
        assert_eq!(exec_plugin_for_context(&kc, "no-exec"), None);
        // Unknown context → None.
        assert_eq!(exec_plugin_for_context(&kc, "missing"), None);
    }

    #[test]
    fn exec_for_context_extracts_command_args_and_env() {
        let yaml = r#"
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: { server: https://1.2.3.4 }
contexts:
- name: aws
  context: { cluster: c, user: aws-user }
- name: gke
  context: { cluster: c, user: gke-user }
users:
- name: aws-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "prod"]
- name: gke-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      env:
      - name: CLOUDSDK_CORE_ACCOUNT
        value: a@example.com
      - name: BROKEN
"#;
        let kc = Kubeconfig::from_yaml(yaml).expect("parse kubeconfig");
        let spec = exec_for_context(&kc, "aws").expect("exec present");
        assert_eq!(spec.command, "aws");
        assert_eq!(
            spec.args,
            vec!["eks", "get-token", "--cluster-name", "prod"]
        );
        assert!(spec.env.is_empty());

        let spec = exec_for_context(&kc, "gke").expect("exec present");
        // The `{name}`-only entry carries no value, so it's dropped rather than
        // surfaced as an empty-valued pin.
        assert_eq!(
            spec.env,
            vec![(
                "CLOUDSDK_CORE_ACCOUNT".to_owned(),
                "a@example.com".to_owned()
            )]
        );
        assert!(spec.args.is_empty());

        assert!(exec_for_context(&kc, "missing").is_none());
    }

    #[test]
    fn resolve_in_path_handles_absolute_and_missing() {
        // An absolute path to a real file resolves to itself.
        let mut tmp = std::env::temp_dir();
        tmp.push(format!("fs-diag-probe-{}", std::process::id()));
        std::fs::write(&tmp, b"#!/bin/sh\n").expect("write temp");
        let abs = tmp.display().to_string();
        assert_eq!(resolve_in_path(&abs), Some(tmp.clone()));
        std::fs::remove_file(&tmp).ok();
        // A bare name that doesn't exist anywhere on PATH → None.
        assert!(resolve_in_path("fs-definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn diagnose_context_reports_exec_and_env_presence() {
        let yaml = r#"
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: { server: https://1.2.3.4 }
contexts:
- name: gke
  context: { cluster: c, user: gke-user }
users:
- name: gke-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
"#;
        let mut path = std::env::temp_dir();
        path.push(format!("fs-diag-kubeconfig-{}.yaml", std::process::id()));
        std::fs::write(&path, yaml).expect("write kubeconfig");

        let diag = diagnose_context("gke", Some(path.as_path())).expect("diagnose");
        std::fs::remove_file(&path).ok();

        let exec = diag.exec.expect("exec probe present");
        assert_eq!(exec.command, "gke-gcloud-auth-plugin");
        // Plugin almost certainly not installed in CI → found=false, no path.
        assert_eq!(exec.found, exec.resolved_path.is_some());
        // Env presence covers the full diagnostic key set, values never leaked.
        assert_eq!(diag.env_presence.len(), DIAG_ENV_KEYS.len());
        assert!(diag.env_presence.iter().any(|e| e.key == "HOME"));
    }

    // kube-rs surfaces a non-zero plugin exit as `AuthError::AuthExecRun`, which
    // carries the captured `Output`. Build one and assert we reformat it into a
    // readable `ExecPluginFailed`. `ExitStatus` is only constructible via the
    // unix extension trait, so gate on unix (our only shipping targets).
    #[cfg(unix)]
    #[test]
    fn enrich_reformats_auth_exec_run_into_readable_failure() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(1 << 8); // exit code 1
        let out = std::process::Output {
            status,
            stdout: Vec::new(),
            stderr: b"ERROR: (gcloud.auth) reauth required\ntoken=eyJhbGciABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n".to_vec(),
        };
        let auth = AuthError::AuthExecRun {
            cmd: "gke-gcloud-auth-plugin".to_owned(),
            status,
            out,
        };
        // Wrap in the real error path: kube::Error::Auth → our Error::Kube.
        let err = Error::Kube(kube::Error::Auth(auth));
        // No exec_command passed — the command must come from AuthExecRun itself,
        // proving the path works even when we couldn't pre-extract the plugin.
        match enrich_exec_error(err, None) {
            Error::ExecPluginFailed {
                command,
                code,
                stderr,
            } => {
                assert_eq!(command, "gke-gcloud-auth-plugin");
                assert_eq!(code, "1");
                assert!(stderr.contains("reauth required"));
                assert!(!stderr.contains("eyJhbGci"));
            }
            other => panic!("expected ExecPluginFailed, got {other:?}"),
        }
    }
}
