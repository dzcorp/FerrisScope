//! Local TCP → in-cluster pod port forwards.
//!
//! Models `kubectl port-forward`: the operator picks a (Service / Deployment /
//! Pod, remote port) target; the engine binds a local listener and bridges
//! every accepted connection to the apiserver's pod-portforward subresource.
//!
//! Pod selection happens *per connection* for non-Pod targets (Service /
//! workload). That matches kubectl's behaviour and means the listener
//! naturally survives pod restarts — the next connection picks whatever pod
//! is currently ready instead of pinning to the dying one.
//!
//! Each forward owns one [`tokio::task::JoinHandle`] driving the listener.
//! Dropping the [`ForwardHandle`] aborts the task; the listener closes; any
//! in-flight bridges drop naturally on the next read/write error.

use std::sync::Arc;

use ferrisscope_core::portforwards::{ForwardSpec, ForwardTarget};
use futures::future::BoxFuture;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use kube::{
    api::{Api, ListParams},
    Client,
};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;

use crate::log_pods::selector_query;

/// Channel size for status events. Generous — the UI subscribes once and we
/// emit at human pace (start / listening / connection-error / stopped).
const STATUS_BUFFER: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum PortForwardError {
    #[error("kube error: {0}")]
    Kube(#[from] kube::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported target kind: {0}")]
    UnsupportedKind(String),
    #[error("no ready pod found for {kind} {namespace}/{name}")]
    NoReadyPod {
        kind: String,
        namespace: String,
        name: String,
    },
    #[error("cluster unavailable: {0}")]
    ClientUnavailable(String),
    #[error("service {namespace}/{name} has no port matching {port}")]
    ServicePortMismatch {
        namespace: String,
        name: String,
        port: u16,
    },
}

/// Resolves the cluster's client for each new connection, so a forward
/// follows the cluster across reconnects instead of pinning a dead pool.
pub type ClientSource = Arc<dyn Fn() -> BoxFuture<'static, Result<Client, String>> + Send + Sync>;

pub fn fixed_client(client: Client) -> ClientSource {
    Arc::new(move || {
        let client = client.clone();
        Box::pin(async move { Ok(client) })
    })
}

/// Lifecycle state for a single forward. Broadcast on every transition so the
/// UI can render Listening / Reconnecting / Failed without polling.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForwardStatus {
    /// Listener bound, no traffic yet.
    Listening,
    /// Listener bound and at least one connection has succeeded.
    Active,
    /// A connection just failed; listener is still bound, next attempt may
    /// recover. Reason is the bridge / kube error.
    Reconnecting { reason: String },
    /// Listener could not be bound, or pod resolution failed at start. The
    /// entry stays in the registry so the UI can retry.
    Failed { reason: String },
    /// Stopped by user (or by cluster cleanup). Final state — handle is gone.
    Stopped,
}

/// One running (or attempted) forward. Status mutates over time; the spec is
/// immutable for the lifetime of the handle (a re-pin / change-port is a
/// stop + start).
pub struct ForwardHandle {
    pub spec: ForwardSpec,
    pub actual_local_port: u16,
    /// Shared with the listener task — both sides write through the same Arc
    /// so `snapshot()` reads the live state without a separate poll.
    status: Arc<Mutex<ForwardStatus>>,
    /// Kept so future helpers (e.g. force-retry) can re-emit without a
    /// reference to the registry. Currently only the task writes to it.
    #[allow(dead_code)]
    status_tx: broadcast::Sender<(String, ForwardStatus)>,
    task: JoinHandle<()>,
}

impl Drop for ForwardHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ForwardHandle {
    pub async fn status(&self) -> ForwardStatus {
        self.status.lock().await.clone()
    }
}

/// Read-only snapshot the command layer hands to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ForwardEntry {
    pub spec: ForwardSpec,
    pub actual_local_port: u16,
    pub status: ForwardStatus,
}

/// Resolve `target` to a concrete Pod name + container port that can host the
/// portforward subresource. For Service targets we walk EndpointSlice to pick
/// a Ready pod and translate the service port into its `targetPort` (number
/// or named container port). For workload targets we use the workload's label
/// selector.
pub async fn resolve_pod(
    client: &Client,
    target: &ForwardTarget,
    remote_port: u16,
) -> Result<(String, u16), PortForwardError> {
    match target.kind.as_str() {
        "Pod" => Ok((target.name.clone(), remote_port)),
        "Service" => {
            resolve_service_pod(client, &target.namespace, &target.name, remote_port).await
        }
        "Deployment" => {
            resolve_workload_pod::<Deployment>(
                client,
                &target.namespace,
                &target.name,
                remote_port,
                workload_selector_deployment,
            )
            .await
        }
        "StatefulSet" => {
            resolve_workload_pod::<StatefulSet>(
                client,
                &target.namespace,
                &target.name,
                remote_port,
                workload_selector_stateful_set,
            )
            .await
        }
        "DaemonSet" => {
            resolve_workload_pod::<DaemonSet>(
                client,
                &target.namespace,
                &target.name,
                remote_port,
                workload_selector_daemon_set,
            )
            .await
        }
        "ReplicaSet" => {
            resolve_workload_pod::<ReplicaSet>(
                client,
                &target.namespace,
                &target.name,
                remote_port,
                workload_selector_replica_set,
            )
            .await
        }
        "Job" => {
            resolve_workload_pod::<Job>(
                client,
                &target.namespace,
                &target.name,
                remote_port,
                workload_selector_job,
            )
            .await
        }
        other => Err(PortForwardError::UnsupportedKind(other.to_owned())),
    }
}

async fn resolve_service_pod(
    client: &Client,
    namespace: &str,
    name: &str,
    service_port: u16,
) -> Result<(String, u16), PortForwardError> {
    // Step 1 — fetch the Service so we know how the user-facing port maps to
    // the pod-side targetPort. Numeric targetPort: forward straight through.
    // Named targetPort: resolve later against the chosen pod's containers.
    let svc_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = svc_api.get(name).await?;
    let (target_port_num, target_port_name) = svc
        .spec
        .as_ref()
        .and_then(|s| s.ports.as_ref())
        .and_then(|ports| ports.iter().find(|p| p.port == i32::from(service_port)))
        .map(|p| match p.target_port.as_ref() {
            Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(n)) => {
                (Some(*n as u16), None)
            }
            Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s)) => {
                (None, Some(s.clone()))
            }
            // No targetPort declared = same as service port.
            None => (Some(service_port), None),
        })
        .unwrap_or((Some(service_port), None));

    // Step 2 — find a Ready endpoint backed by a Pod. Prefer EndpointSlice
    // (modern, standard since 1.21); fall back to label-selector on the
    // Service if no slice exists yet (rare).
    let slices: Api<EndpointSlice> = Api::namespaced(client.clone(), namespace);
    let label = format!("kubernetes.io/service-name={name}");
    let lp = ListParams::default().labels(&label);
    let list = slices.list(&lp).await?;
    for slice in list.items {
        // k8s-openapi 0.28 made `EndpointSlice.endpoints` an `Option<Vec<_>>`.
        for ep in slice.endpoints.into_iter().flatten() {
            let ready = ep.conditions.as_ref().and_then(|c| c.ready).unwrap_or(true);
            if !ready {
                continue;
            }
            let Some(target_ref) = ep.target_ref else {
                continue;
            };
            if target_ref.kind.as_deref() != Some("Pod") {
                continue;
            }
            let Some(pod_name) = target_ref.name else {
                continue;
            };
            let port = if let Some(n) = target_port_num {
                n
            } else if let Some(named) = target_port_name.as_deref() {
                resolve_named_port(client, namespace, &pod_name, named).await?
            } else {
                service_port
            };
            return Ok((pod_name, port));
        }
    }

    // Fallback path — no slice landed yet. Use the service selector.
    if let Some(selector) = svc.spec.as_ref().and_then(|s| s.selector.as_ref()) {
        let label_str = selector
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(",");
        let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
        let lp = ListParams::default().labels(&label_str);
        let plist = pods.list(&lp).await?;
        if let Some(pod) = plist.items.into_iter().find(pod_is_ready) {
            let pod_name = pod.metadata.name.clone().unwrap_or_default();
            let port = if let Some(n) = target_port_num {
                n
            } else if let Some(named) = target_port_name.as_deref() {
                container_port_by_name(&pod, named).ok_or(
                    PortForwardError::ServicePortMismatch {
                        namespace: namespace.to_owned(),
                        name: name.to_owned(),
                        port: service_port,
                    },
                )?
            } else {
                service_port
            };
            return Ok((pod_name, port));
        }
    }

    Err(PortForwardError::NoReadyPod {
        kind: "Service".to_owned(),
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    })
}

async fn resolve_named_port(
    client: &Client,
    namespace: &str,
    pod_name: &str,
    named: &str,
) -> Result<u16, PortForwardError> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = pods.get(pod_name).await?;
    container_port_by_name(&pod, named).ok_or(PortForwardError::ServicePortMismatch {
        namespace: namespace.to_owned(),
        name: pod_name.to_owned(),
        port: 0,
    })
}

fn container_port_by_name(pod: &Pod, named: &str) -> Option<u16> {
    pod.spec.as_ref().and_then(|s| {
        s.containers.iter().find_map(|c| {
            c.ports.as_ref().and_then(|ps| {
                ps.iter()
                    .find(|p| p.name.as_deref() == Some(named))
                    .map(|p| p.container_port as u16)
            })
        })
    })
}

fn pod_is_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
        .unwrap_or(false)
        && pod
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .map(|p| p == "Running")
            .unwrap_or(false)
}

// ── Workload selectors ────────────────────────────────────────────────────

type SelectorFn<W> = fn(&W) -> Option<String>;

async fn resolve_workload_pod<W>(
    client: &Client,
    namespace: &str,
    name: &str,
    remote_port: u16,
    selector_fn: SelectorFn<W>,
) -> Result<(String, u16), PortForwardError>
where
    W: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope, DynamicType = ()>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
{
    let api: Api<W> = Api::namespaced(client.clone(), namespace);
    let workload = api.get(name).await?;
    let label_str = selector_fn(&workload).ok_or_else(|| PortForwardError::NoReadyPod {
        kind: std::any::type_name::<W>().to_owned(),
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    })?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default().labels(&label_str);
    let list = pods.list(&lp).await?;
    let pod =
        list.items
            .into_iter()
            .find(pod_is_ready)
            .ok_or_else(|| PortForwardError::NoReadyPod {
                kind: std::any::type_name::<W>().to_owned(),
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            })?;
    let pod_name = pod.metadata.name.clone().unwrap_or_default();
    Ok((pod_name, remote_port))
}

// Selector serialisation is shared with the log-pod resolver. A local copy
// here used to read `matchLabels` only, so an expression-bearing selector
// either resolved to nothing or, worse, over-matched and forwarded to a pod
// the workload doesn't own.
fn workload_selector_deployment(d: &Deployment) -> Option<String> {
    selector_query(&d.spec.as_ref()?.selector)
}
fn workload_selector_stateful_set(s: &StatefulSet) -> Option<String> {
    selector_query(&s.spec.as_ref()?.selector)
}
fn workload_selector_daemon_set(d: &DaemonSet) -> Option<String> {
    selector_query(&d.spec.as_ref()?.selector)
}
fn workload_selector_replica_set(r: &ReplicaSet) -> Option<String> {
    selector_query(&r.spec.as_ref()?.selector)
}
fn workload_selector_job(j: &Job) -> Option<String> {
    selector_query(j.spec.as_ref()?.selector.as_ref()?)
}

// ── Engine ────────────────────────────────────────────────────────────────

/// Start a listener for `spec`. Returns the handle and the actual bound local
/// port (resolved when `requested_local_port` was None or 0).
///
/// `clients` is consulted per connection (see [`ClientSource`]).
///
/// `prebound` lets the caller supply an already-bound listening socket instead
/// of binding here. Global (DNS) forwards use this on Linux for privileged
/// service ports (<1024): the elevated helper binds the socket and passes the fd
/// to the app, which the app then drives. When `None`, we bind `spec`'s address
/// ourselves (every Simple forward, and every high-port / non-Linux global one).
pub async fn start(
    clients: ClientSource,
    spec: ForwardSpec,
    prebound: Option<std::net::TcpListener>,
    status_tx: broadcast::Sender<(String, ForwardStatus)>,
) -> Result<Arc<ForwardHandle>, PortForwardError> {
    let listener = match prebound {
        // Pre-bound by the helper (privileged port): adopt it. It was created
        // blocking; tokio needs it non-blocking.
        Some(std_listener) => {
            std_listener.set_nonblocking(true)?;
            TcpListener::from_std(std_listener)?
        }
        // `local_ip` is `None` for Simple forwards → bind 127.0.0.1 exactly as
        // before. Global forwards pass their allocated per-service loopback IP
        // (somewhere in 127.0.0.0/8), which is already reachable (Linux loops the
        // whole /8; the helper has aliased it on macOS/Windows).
        None => {
            let ip = spec
                .local_ip
                .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
            let bind_addr = std::net::SocketAddr::new(ip, spec.requested_local_port.unwrap_or(0));
            TcpListener::bind(bind_addr).await?
        }
    };
    let actual_local_port = listener.local_addr()?.port();

    let id = spec.id.clone();
    let target = spec.target.clone();
    let remote_port = spec.remote_port;
    let status = Arc::new(Mutex::new(ForwardStatus::Listening));
    let _ = status_tx.send((id.clone(), ForwardStatus::Listening));

    let status_for_task = status.clone();
    let tx_for_task = status_tx.clone();
    let id_for_task = id.clone();

    let task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((sock, _peer)) => {
                    let clients = clients.clone();
                    let target = target.clone();
                    let id = id_for_task.clone();
                    let tx = tx_for_task.clone();
                    let status = status_for_task.clone();
                    tokio::spawn(async move {
                        if let Err(e) = bridge_one(&clients, &target, remote_port, sock).await {
                            let st = ForwardStatus::Reconnecting {
                                reason: e.to_string(),
                            };
                            *status.lock().await = st.clone();
                            let _ = tx.send((id, st));
                        } else {
                            let st = ForwardStatus::Active;
                            *status.lock().await = st.clone();
                            let _ = tx.send((id, st));
                        }
                    });
                }
                Err(e) => {
                    let st = ForwardStatus::Failed {
                        reason: format!("accept: {e}"),
                    };
                    *status_for_task.lock().await = st.clone();
                    let _ = tx_for_task.send((id_for_task.clone(), st));
                    return;
                }
            }
        }
    });

    Ok(Arc::new(ForwardHandle {
        spec,
        actual_local_port,
        status,
        status_tx,
        task,
    }))
}

async fn bridge_one(
    clients: &ClientSource,
    target: &ForwardTarget,
    remote_port: u16,
    mut sock: tokio::net::TcpStream,
) -> Result<(), PortForwardError> {
    let client = clients()
        .await
        .map_err(PortForwardError::ClientUnavailable)?;
    let (pod_name, pod_port) = resolve_pod(&client, target, remote_port).await?;
    let pods: Api<Pod> = Api::namespaced(client, &target.namespace);
    let mut pf = pods.portforward(&pod_name, &[pod_port]).await?;
    let mut upstream = pf
        .take_stream(pod_port)
        .ok_or_else(|| PortForwardError::NoReadyPod {
            kind: target.kind.clone(),
            namespace: target.namespace.clone(),
            name: pod_name.clone(),
        })?;
    // copy_bidirectional propagates closure on either side. Failures (broken
    // pipe, pod exit) bubble back to the caller as Err so the listener can
    // surface the reason.
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await?;
    let _ = sock.shutdown().await;
    Ok(())
}

/// Snapshot view used by `pf_list`. Pulls the current status off the handle.
pub async fn snapshot(handle: &ForwardHandle) -> ForwardEntry {
    ForwardEntry {
        spec: handle.spec.clone(),
        actual_local_port: handle.actual_local_port,
        status: handle.status().await,
    }
}

/// Whether a Simple forward could bind `127.0.0.1:<port>` right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalPortProbe {
    Free,
    InUse,
    /// Bindable, but another listener on `addr` would answer `localhost:<port>`
    /// for some clients (IPv6 `::1`, or a wildcard the OS lets us shadow).
    Shadowed {
        addr: String,
    },
    /// Privileged (<1024 without the capability) or, on Windows, an excluded range.
    PermissionDenied,
    Error {
        message: String,
    },
}

/// Ports scanned upward for a suggestion before falling back to an OS pick.
const SUGGEST_SCAN: u16 = 32;

async fn try_bind(addr: std::net::SocketAddr) -> std::io::Result<()> {
    TcpListener::bind(addr).await.map(drop)
}

/// Listeners the 127.0.0.1 bind doesn't collide with but that still serve
/// `localhost`. Linux already refuses 127.0.0.1 under a `*:<port>` listener;
/// macOS (SO_REUSEADDR) and Windows let the specific bind shadow it.
fn shadow_addrs(port: u16) -> impl Iterator<Item = std::net::SocketAddr> {
    let v6 = std::net::SocketAddr::new(std::net::Ipv6Addr::LOCALHOST.into(), port);
    let any = (!cfg!(target_os = "linux"))
        .then(|| std::net::SocketAddr::new(std::net::Ipv4Addr::UNSPECIFIED.into(), port));
    std::iter::once(v6).chain(any)
}

/// Probe with the exact bind `start` performs (tokio sets SO_REUSEADDR, so a
/// port with only TIME_WAIT sockets reads as free, as it would at start).
/// Advisory only — another process can take the port before `start` runs.
pub async fn probe_local_port(port: u16) -> LocalPortProbe {
    let addr = std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), port);
    if let Err(e) = try_bind(addr).await {
        return match e.kind() {
            std::io::ErrorKind::AddrInUse => LocalPortProbe::InUse,
            std::io::ErrorKind::PermissionDenied => LocalPortProbe::PermissionDenied,
            _ => LocalPortProbe::Error {
                message: e.to_string(),
            },
        };
    }
    for addr in shadow_addrs(port) {
        // Other failures (no IPv6, privileged) say nothing about a listener.
        if matches!(try_bind(addr).await, Err(e) if e.kind() == std::io::ErrorKind::AddrInUse) {
            return LocalPortProbe::Shadowed {
                addr: addr.to_string(),
            };
        }
    }
    LocalPortProbe::Free
}

/// A free unprivileged port near `port`: 80 → 8080, 443 → 8443, 8080 → 8081….
/// Falls back to an OS-assigned port when the whole scan window is taken.
pub async fn suggest_local_port(port: u16) -> Option<u16> {
    let first = if port < 1024 {
        port + 8000
    } else {
        port.saturating_add(1)
    };
    for p in (first..=u16::MAX).take(usize::from(SUGGEST_SCAN)) {
        if p != port && probe_local_port(p).await == LocalPortProbe::Free {
            return Some(p);
        }
    }
    let addr = std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), 0);
    let listener = TcpListener::bind(addr).await.ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

/// Construct a fresh broadcast channel for status events. The registry holds
/// the sender; the command layer hands receivers to the Tauri event forwarder.
pub fn new_status_channel() -> broadcast::Sender<(String, ForwardStatus)> {
    broadcast::channel(STATUS_BUFFER).0
}

#[cfg(test)]
mod tests {
    use super::*;

    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement};
    use std::collections::BTreeMap;

    async fn held_port() -> (TcpListener, u16) {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        (l, port)
    }

    #[tokio::test]
    async fn probe_reports_held_then_released_port() {
        let (l, port) = held_port().await;
        assert_eq!(probe_local_port(port).await, LocalPortProbe::InUse);
        drop(l);
        assert_eq!(probe_local_port(port).await, LocalPortProbe::Free);
    }

    #[tokio::test]
    async fn ipv6_localhost_listener_reads_as_shadowed() {
        let Ok(l) = TcpListener::bind("[::1]:0").await else {
            return; // no IPv6 loopback on this host
        };
        let port = l.local_addr().expect("addr").port();
        assert!(matches!(
            probe_local_port(port).await,
            LocalPortProbe::Shadowed { addr } if addr == format!("[::1]:{port}")
        ));
    }

    #[cfg(not(target_os = "linux"))]
    #[tokio::test]
    async fn wildcard_listener_is_shadowed_or_in_use() {
        let l = TcpListener::bind("0.0.0.0:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        assert_ne!(probe_local_port(port).await, LocalPortProbe::Free);
    }

    #[tokio::test]
    async fn suggestion_skips_the_busy_port_and_is_bindable() {
        let (_l, port) = held_port().await;
        let s = suggest_local_port(port).await.expect("suggestion");
        assert_ne!(s, port);
        assert!(s >= 1024);
        assert_eq!(probe_local_port(s).await, LocalPortProbe::Free);
    }

    #[tokio::test]
    async fn privileged_port_suggests_the_8000_offset_neighbourhood() {
        let s = suggest_local_port(80).await.expect("suggestion");
        assert!(s >= 1024, "never suggest a privileged port, got {s}");
    }

    #[tokio::test]
    async fn suggestion_near_the_top_of_the_range_does_not_overflow() {
        let s = suggest_local_port(u16::MAX).await.expect("suggestion");
        assert_ne!(s, u16::MAX);
    }

    fn deployment(sel: LabelSelector) -> Deployment {
        Deployment {
            spec: Some(k8s_openapi::api::apps::v1::DeploymentSpec {
                selector: sel,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The bug this shares `selector_query` to fix: a local serialiser read
    /// `matchLabels` only, so an expression term vanished and the query
    /// widened — port-forward then bridged traffic to a pod outside the
    /// workload.
    #[test]
    fn workload_selector_emits_both_labels_and_expressions() {
        let mut labels = BTreeMap::new();
        labels.insert("app".to_owned(), "web".to_owned());
        let q = workload_selector_deployment(&deployment(LabelSelector {
            match_labels: Some(labels),
            match_expressions: Some(vec![LabelSelectorRequirement {
                key: "tier".to_owned(),
                operator: "NotIn".to_owned(),
                values: Some(vec!["canary".to_owned()]),
            }]),
        }))
        .expect("selector serialises");

        assert!(q.contains("app=web"), "lost matchLabels: {q}");
        assert!(q.contains("tier notin (canary)"), "lost expression: {q}");
    }

    /// An expression-only selector used to serialise to `None` (no forward at
    /// all); it now produces a real set-based query.
    #[test]
    fn workload_selector_handles_expression_only_selectors() {
        let q = workload_selector_deployment(&deployment(LabelSelector {
            match_labels: None,
            match_expressions: Some(vec![LabelSelectorRequirement {
                key: "app".to_owned(),
                operator: "In".to_owned(),
                values: Some(vec!["web".to_owned(), "api".to_owned()]),
            }]),
        }));
        assert_eq!(q.as_deref(), Some("app in (web,api)"));
    }

    /// An operator we don't understand must refuse the whole selector rather
    /// than drop the term — dropping a restricting term widens the match.
    #[test]
    fn workload_selector_refuses_an_unknown_operator() {
        let mut labels = BTreeMap::new();
        labels.insert("app".to_owned(), "web".to_owned());
        let q = workload_selector_deployment(&deployment(LabelSelector {
            match_labels: Some(labels),
            match_expressions: Some(vec![LabelSelectorRequirement {
                key: "tier".to_owned(),
                operator: "GreaterThan".to_owned(),
                values: Some(vec!["3".to_owned()]),
            }]),
        }));
        assert_eq!(
            q, None,
            "must not fall back to the widened matchLabels query"
        );
    }

    #[tokio::test]
    async fn each_connection_asks_the_source_for_a_fresh_client() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let clients: ClientSource = {
            let calls = calls.clone();
            Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err("reconnecting".to_owned()) })
            })
        };
        let spec = ForwardSpec {
            id: "pf".to_owned(),
            cluster_id: "c".to_owned(),
            target: ForwardTarget {
                kind: "Pod".to_owned(),
                namespace: "ns".to_owned(),
                name: "p".to_owned(),
            },
            remote_port: 80,
            requested_local_port: None,
            autostart: false,
            mode: Default::default(),
            local_ip: None,
        };
        let tx = new_status_channel();
        let mut rx = tx.subscribe();
        let handle = start(clients, spec, None, tx)
            .await
            .expect("listener binds");
        let addr = ("127.0.0.1", handle.actual_local_port);
        for _ in 0..2 {
            let _conn = tokio::net::TcpStream::connect(addr).await.expect("connect");
            loop {
                let (_, st) = rx.recv().await.expect("status");
                if let ForwardStatus::Reconnecting { reason } = st {
                    assert!(
                        reason.contains("cluster unavailable: reconnecting"),
                        "{reason}"
                    );
                    break;
                }
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// No spec at all — total, not a panic.
    #[test]
    fn workload_selector_tolerates_a_specless_object() {
        assert_eq!(workload_selector_deployment(&Deployment::default()), None);
    }
}
