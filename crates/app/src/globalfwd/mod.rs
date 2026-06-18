//! App-side supervisor for global (DNS) port-forwarding.
//!
//! Owns the lazily-spawned privileged [`HelperClient`], the loopback
//! [`IpAllocator`], and the live [`GlobalSession`]s. The actual per-port TCP
//! listeners live in the shared [`PortForwardRegistry`] (same place as Simple
//! forwards) keyed by their global id; this manager tracks which ids and which
//! loopback IP / hostnames belong to which session so teardown is exact.
//!
//! Hosts edits are **declarative**: after any session change we recompute the
//! full set of [`HostEntry`]s across all sessions and send one `HostsApply`, so
//! the helper never reasons about deltas.

mod client;
mod spawn;

/// argv[1] marker that makes the main binary run the privileged helper instead
/// of the GUI (multi-call binary). Shared by `main` (the branch) and `spawn`
/// (the relaunch). Unlikely to collide with a real arg.
pub(crate) const HELPER_ARG: &str = "__fs_helper";

use std::collections::HashMap;
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use ferrisscope_core::globalfwd::hostnames;
use ferrisscope_core::globalfwd::ipalloc::IpAllocator;
use ferrisscope_core::globalfwd::protocol::HostEntry;
use ferrisscope_core::portforwards::{self, ForwardMode, ForwardSpec, ForwardTarget};
use ferrisscope_kube_ext::{start_forward, ForwardStatus};
use futures::StreamExt;
use k8s_openapi::api::core::v1::Service;
use kube::api::ListParams;
use kube::runtime::{watcher, WatchStreamExt};
use kube::{Api, Client};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::globalfwd::spawn::SpawnedHelper;
use crate::state::{AppState, PortForwardRegistry};

/// Lifecycle state of the privileged helper, surfaced to the UI.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum HelperStatus {
    /// Not spawned yet (no global forward enabled this session).
    NotStarted,
    /// Spawned and handshaken.
    Running,
    /// Last spawn/connect attempt failed (e.g. elevation denied).
    Failed { message: String },
}

/// One service's forward within a session.
#[derive(Debug, Clone)]
struct ServiceForward {
    name: String,
    namespace: String,
    local_ip: Ipv4Addr,
    hostnames: Vec<String>,
    ports: Vec<u16>,
    /// Ids of the per-port listeners in the [`PortForwardRegistry`].
    forward_ids: Vec<String>,
}

/// All forwards enabled for one query (a namespace, all-namespaces, or a label
/// selector). `id` is the stable session key; `namespace` is a human label for
/// the snapshot (the queried namespace, or "(all namespaces)").
struct GlobalSession {
    id: String,
    cluster_id: String,
    namespace: String,
    services: Vec<ServiceForward>,
    /// Background Service-watch task that keeps `services` in sync with the
    /// cluster (auto-forward new matches, tear down deleted ones). `None` for
    /// single-service sessions and when no `AppHandle` is attached (tests).
    /// Aborted on `disable`.
    watch: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ServiceForwardEntry {
    pub(crate) name: String,
    pub(crate) namespace: String,
    pub(crate) local_ip: String,
    pub(crate) hostnames: Vec<String>,
    pub(crate) ports: Vec<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct GlobalSessionSnapshot {
    pub(crate) id: String,
    pub(crate) cluster_id: String,
    pub(crate) namespace: String,
    pub(crate) services: Vec<ServiceForwardEntry>,
}

/// Stable session id for a query: a namespace (or `*` for all-namespaces) and
/// an optional label selector. Distinct queries never collide.
fn query_session_id(
    cluster_id: &str,
    namespace: Option<&str>,
    label_selector: Option<&str>,
) -> String {
    let ns = namespace.unwrap_or("*");
    let sel = label_selector.unwrap_or("");
    format!("{cluster_id}::q::{ns}::{sel}")
}

/// Build one Global `ForwardSpec` per service port: bind `local_ip:port` and
/// forward to the service's `port` (kube-ext resolves port→pod per connection).
fn service_specs(
    cluster_id: &str,
    namespace: &str,
    svc_name: &str,
    local_ip: Ipv4Addr,
    ports: &[u16],
) -> Vec<ForwardSpec> {
    ports
        .iter()
        .map(|&port| {
            let target = ForwardTarget {
                kind: "Service".to_string(),
                namespace: namespace.to_string(),
                name: svc_name.to_string(),
            };
            ForwardSpec {
                id: portforwards::make_global_id(cluster_id, &target, port),
                cluster_id: cluster_id.to_string(),
                target,
                remote_port: port,
                // Bind the *same* (real) port on the dedicated loopback IP.
                requested_local_port: Some(port),
                autostart: false,
                mode: ForwardMode::Global,
                local_ip: Some(std::net::IpAddr::V4(local_ip)),
            }
        })
        .collect()
}

/// The hosts entry for a service: its loopback IP → all in-cluster DNS variants.
fn host_entry(local_ip: Ipv4Addr, svc_name: &str, namespace: &str) -> HostEntry {
    HostEntry {
        ip: local_ip,
        hostnames: hostnames::variants(svc_name, namespace),
    }
}

/// Service ports worth forwarding, as `(u16)`. Skips ports that don't fit u16.
fn service_ports(svc: &Service) -> Vec<u16> {
    svc.spec
        .as_ref()
        .and_then(|s| s.ports.as_ref())
        .map(|ports| {
            ports
                .iter()
                .filter_map(|p| u16::try_from(p.port).ok())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) struct GlobalForwardManager {
    helper: Mutex<Option<SpawnedHelper>>,
    status: Mutex<HelperStatus>,
    allocator: Mutex<IpAllocator>,
    sessions: Mutex<HashMap<String, GlobalSession>>,
    runtime_dir: PathBuf,
    config_dir: PathBuf,
    /// Set once at startup so background Service-watch tasks can re-enter the
    /// manager + look up the port-forward registry. Absent in unit tests
    /// (watchers are simply not spawned then).
    app: OnceLock<AppHandle>,
}

impl Default for GlobalForwardManager {
    fn default() -> Self {
        // Mirror core's path resolution (`~/.config/ferrisscope/`). The socket
        // lives in the user-private runtime dir when available (Linux
        // `$XDG_RUNTIME_DIR`), else under the config dir.
        let dirs = directories::ProjectDirs::from("dev", "ferrisscope", "ferrisscope");
        let config_dir = dirs
            .as_ref()
            .map(|d| d.config_dir().to_path_buf())
            .unwrap_or_else(|| std::env::temp_dir().join("ferrisscope"));
        let runtime_dir = default_runtime_dir(dirs.as_ref(), &config_dir);
        Self::new(runtime_dir, config_dir)
    }
}

/// Directory that will hold the helper's Unix socket. Must stay short on macOS:
/// a `sockaddr_un.sun_path` caps near 104 bytes, and the directories-crate
/// config path (`~/Library/Application Support/dev.ferrisscope.ferrisscope/run`)
/// already eats ~85 chars before the filename — a long username overflows the
/// bind. Linux has a short `$XDG_RUNTIME_DIR`; Windows uses a named pipe (no
/// path limit), so this only feeds the unix socket.
fn default_runtime_dir(dirs: Option<&directories::ProjectDirs>, config_dir: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let _ = dirs;
        // Short, home-owned dir, created 0700 at spawn time. `.ferrisscope`
        // keeps `~/.ferrisscope/helper.sock` well under sun_path regardless of
        // username length. Falls back to the config dir only if $HOME is unset.
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".ferrisscope");
        }
        config_dir.join("run")
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs.and_then(|d| d.runtime_dir().map(|p| p.join("ferrisscope")))
            .unwrap_or_else(|| config_dir.join("run"))
    }
}

impl GlobalForwardManager {
    pub(crate) fn new(runtime_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            helper: Mutex::new(None),
            status: Mutex::new(HelperStatus::NotStarted),
            allocator: Mutex::new(IpAllocator::new()),
            sessions: Mutex::new(HashMap::new()),
            runtime_dir,
            config_dir,
            app: OnceLock::new(),
        }
    }

    /// Attach the `AppHandle` (called once in `main`'s setup) so background
    /// Service-watch tasks can re-enter the manager and the registry.
    pub(crate) fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub(crate) async fn status(&self) -> HelperStatus {
        self.status.lock().await.clone()
    }

    /// Spawn + connect the helper if not already running. One elevation prompt
    /// per session. Idempotent.
    async fn ensure_helper(&self) -> Result<()> {
        let mut guard = self.helper.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        match spawn::spawn(&self.runtime_dir, &self.config_dir).await {
            Ok(mut spawned) => {
                // Sanity ping.
                if let Err(e) = spawned.client.ping().await {
                    *self.status.lock().await = HelperStatus::Failed {
                        message: e.to_string(),
                    };
                    return Err(e);
                }
                // Crash recovery: now that we hold privilege, clean any hosts
                // block / loopback aliases a previous crashed session left
                // behind, before we apply anything new. Best-effort.
                match spawned.client.purge_stale().await {
                    Ok(ips) if !ips.is_empty() => {
                        info!(
                            count = ips.len(),
                            "purged stale loopback aliases from prior run"
                        );
                    }
                    Ok(_) => {}
                    Err(e) => warn!(error = %e, "stale purge on helper start failed"),
                }
                *guard = Some(spawned);
                *self.status.lock().await = HelperStatus::Running;
                info!("privileged helper ready");
                Ok(())
            }
            Err(e) => {
                *self.status.lock().await = HelperStatus::Failed {
                    message: e.to_string(),
                };
                Err(e)
            }
        }
    }

    /// Borrow the live helper client. Errors if not spawned.
    async fn helper_add_loopback(&self, ip: Ipv4Addr) -> Result<()> {
        let mut guard = self.helper.lock().await;
        let spawned = guard
            .as_mut()
            .ok_or_else(|| anyhow!("helper not running"))?;
        spawned.client.add_loopback(ip).await
    }

    async fn helper_del_loopback(&self, ip: Ipv4Addr) -> Result<()> {
        let mut guard = self.helper.lock().await;
        let spawned = guard
            .as_mut()
            .ok_or_else(|| anyhow!("helper not running"))?;
        spawned.client.del_loopback(ip).await
    }

    async fn helper_hosts_apply(&self, entries: Vec<HostEntry>) -> Result<()> {
        let mut guard = self.helper.lock().await;
        let spawned = guard
            .as_mut()
            .ok_or_else(|| anyhow!("helper not running"))?;
        spawned.client.hosts_apply(entries).await
    }

    /// Recompute the full hosts entry set across all sessions and apply it.
    async fn reapply_hosts(&self) -> Result<()> {
        let entries = self.all_host_entries().await;
        self.helper_hosts_apply(entries).await
    }

    async fn all_host_entries(&self) -> Vec<HostEntry> {
        let sessions = self.sessions.lock().await;
        let mut entries = Vec::new();
        for session in sessions.values() {
            for svc in &session.services {
                if !svc.hostnames.is_empty() {
                    entries.push(host_entry(svc.local_ip, &svc.name, &svc.namespace));
                }
            }
        }
        // Strip bare service labels that collide across services (same name in
        // different namespaces/clusters) so the hosts block can't silently
        // misroute to whichever line was written last; the namespace-qualified
        // names stay. See `hostnames::drop_ambiguous_bare_names`.
        {
            let mut lists: Vec<&mut Vec<String>> =
                entries.iter_mut().map(|e| &mut e.hostnames).collect();
            hostnames::drop_ambiguous_bare_names(&mut lists);
        }
        entries
    }

    /// Enable global forwarding for every service in `namespace`.
    pub(crate) async fn enable_namespace(
        &self,
        client: Client,
        registry: &PortForwardRegistry,
        cluster_id: &str,
        namespace: &str,
    ) -> Result<GlobalSessionSnapshot> {
        self.enable_query(client, registry, cluster_id, Some(namespace), None)
            .await
    }

    /// Enable global forwarding for services matching a query: an optional
    /// namespace (`None` = all namespaces) and an optional label selector —
    /// kubefwd's `-A` / `-l`. Each matched Service is forwarded under its own
    /// namespace, which matters for all-namespaces queries.
    pub(crate) async fn enable_query(
        &self,
        client: Client,
        registry: &PortForwardRegistry,
        cluster_id: &str,
        namespace: Option<&str>,
        label_selector: Option<&str>,
    ) -> Result<GlobalSessionSnapshot> {
        self.ensure_helper().await?;

        let id = query_session_id(cluster_id, namespace, label_selector);
        // Re-enabling the same query is a refresh: tear the old session down
        // first (aborts its watch task, frees its IPs + hosts) so we don't leak
        // the previous watcher or double-bind.
        if self.sessions.lock().await.contains_key(&id) {
            let _ = self.disable(registry, &id).await;
        }

        let api: Api<Service> = match namespace {
            Some(ns) => Api::namespaced(client.clone(), ns),
            None => Api::all(client.clone()),
        };
        let mut lp = ListParams::default();
        if let Some(sel) = label_selector {
            if !sel.is_empty() {
                lp = lp.labels(sel);
            }
        }
        let svcs = api
            .list(&lp)
            .await
            .map_err(|e| anyhow!("listing services: {e}"))?;

        let mut services: Vec<ServiceForward> = Vec::new();
        for svc in svcs {
            let Some(name) = svc.metadata.name.clone() else {
                continue;
            };
            // Each service is forwarded under ITS OWN namespace — an
            // all-namespaces list spans namespaces.
            let ns = svc
                .metadata
                .namespace
                .clone()
                .or_else(|| namespace.map(str::to_string))
                .unwrap_or_default();
            if ns.is_empty() {
                continue;
            }
            let ports = service_ports(&svc);
            if ports.is_empty() {
                continue;
            }
            match self
                .start_service(client.clone(), registry, cluster_id, &ns, &name, &ports)
                .await
            {
                Ok(sf) => services.push(sf),
                Err(e) => warn!(service = %name, error = %e, "skipping service in global forward"),
            }
        }

        let ns_label = namespace.unwrap_or("(all namespaces)").to_string();
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                id.clone(),
                GlobalSession {
                    id: id.clone(),
                    cluster_id: cluster_id.to_string(),
                    namespace: ns_label.clone(),
                    services,
                    watch: None,
                },
            );
        }
        self.reapply_hosts().await?;

        // Keep the session live: watch Services matching this query and
        // forward/teardown as they appear/disappear. For all-namespaces this
        // also picks up services in namespaces created *after* enable.
        if let Some(app) = self.app.get() {
            let handle = self.spawn_service_watch(
                app.clone(),
                client.clone(),
                cluster_id.to_string(),
                id.clone(),
                namespace.map(str::to_string),
                label_selector.map(str::to_string),
            );
            if let Some(sess) = self.sessions.lock().await.get_mut(&id) {
                sess.watch = Some(handle);
            }
        }

        Ok(self
            .snapshot_of(&id)
            .await
            .unwrap_or(GlobalSessionSnapshot {
                id,
                cluster_id: cluster_id.to_string(),
                namespace: ns_label,
                services: vec![],
            }))
    }

    /// Spawn the background Service-watch for a query session. Reconciles:
    /// `Apply`/`InitApply` → forward if not already; `Delete` → tear down; and
    /// on `InitDone` (a relist after a watch gap) removes any forwarded service
    /// no longer present, catching deletes missed while disconnected.
    fn spawn_service_watch(
        &self,
        app: AppHandle,
        client: Client,
        cluster_id: String,
        session_id: String,
        namespace: Option<String>,
        label_selector: Option<String>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let api: Api<Service> = match namespace.as_deref() {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::all(client.clone()),
            };
            let mut cfg = watcher::Config::default();
            if let Some(sel) = label_selector.as_deref() {
                if !sel.is_empty() {
                    cfg = cfg.labels(sel);
                }
            }
            let mut stream = watcher(api, cfg).default_backoff().boxed();
            // Names seen during the current Init→InitDone relist window.
            let mut init_seen: Option<HashSet<(String, String)>> = None;

            while let Some(ev) = stream.next().await {
                let gf = app.state::<GlobalForwardManager>();
                // If the session is gone (disabled), stop watching.
                if gf.session_absent(&session_id).await {
                    break;
                }
                let state = app.state::<AppState>();
                match ev {
                    Ok(watcher::Event::Init) => init_seen = Some(HashSet::new()),
                    Ok(watcher::Event::InitApply(svc)) => {
                        if let (Some(set), Some(n), Some(ns)) = (
                            init_seen.as_mut(),
                            svc.metadata.name.clone(),
                            svc.metadata.namespace.clone(),
                        ) {
                            set.insert((ns, n));
                        }
                        gf.watch_apply(
                            client.clone(),
                            &state.portforwards,
                            &cluster_id,
                            &session_id,
                            &svc,
                        )
                        .await;
                    }
                    Ok(watcher::Event::InitDone) => {
                        if let Some(set) = init_seen.take() {
                            gf.watch_reconcile_init(&state.portforwards, &session_id, &set)
                                .await;
                        }
                    }
                    Ok(watcher::Event::Apply(svc)) => {
                        gf.watch_apply(
                            client.clone(),
                            &state.portforwards,
                            &cluster_id,
                            &session_id,
                            &svc,
                        )
                        .await;
                    }
                    Ok(watcher::Event::Delete(svc)) => {
                        gf.watch_delete(&state.portforwards, &session_id, &svc)
                            .await;
                    }
                    Err(e) => {
                        warn!(error = %e, session = %session_id, "global-forward service watch error");
                    }
                }
            }
        })
    }

    async fn session_absent(&self, session_id: &str) -> bool {
        !self.sessions.lock().await.contains_key(session_id)
    }

    /// Watch reconcile: forward a service if it matches and isn't already
    /// forwarded in `session_id`.
    async fn watch_apply(
        &self,
        client: Client,
        registry: &PortForwardRegistry,
        cluster_id: &str,
        session_id: &str,
        svc: &Service,
    ) {
        let Some(name) = svc.metadata.name.clone() else {
            return;
        };
        let ns = svc.metadata.namespace.clone().unwrap_or_default();
        if ns.is_empty() {
            return;
        }
        let ports = service_ports(svc);
        if ports.is_empty() {
            return;
        }
        // Already forwarded in this session? (also confirms the session lives)
        {
            let sessions = self.sessions.lock().await;
            let Some(sess) = sessions.get(session_id) else {
                return;
            };
            if sess
                .services
                .iter()
                .any(|s| s.name == name && s.namespace == ns)
            {
                return;
            }
        }
        match self
            .start_service(client, registry, cluster_id, &ns, &name, &ports)
            .await
        {
            Ok(sf) => {
                // Re-check under the lock before registering: `start_service`
                // awaited (IP alloc, helper RPCs, kube), during which the session
                // could have been disabled, or another apply could have
                // registered the same service. In either case the forward we
                // just started is orphaned — discard it so its IP/alias/listeners
                // don't leak (the old code silently dropped `sf` and leaked all
                // three when the session had vanished).
                let mut sessions = self.sessions.lock().await;
                match sessions.get_mut(session_id) {
                    Some(sess)
                        if !sess
                            .services
                            .iter()
                            .any(|s| s.name == name && s.namespace == ns) =>
                    {
                        sess.services.push(sf);
                        drop(sessions);
                        let _ = self.reapply_hosts().await;
                        info!(service = %name, namespace = %ns, "global-forward picked up new service");
                    }
                    _ => {
                        drop(sessions);
                        self.discard_service(registry, sf).await;
                    }
                }
            }
            Err(e) => warn!(service = %name, error = %e, "watch: failed to forward new service"),
        }
    }

    /// Watch reconcile: tear down a deleted service's forward.
    async fn watch_delete(&self, registry: &PortForwardRegistry, session_id: &str, svc: &Service) {
        let name = svc.metadata.name.clone().unwrap_or_default();
        let ns = svc.metadata.namespace.clone().unwrap_or_default();
        self.teardown_service(registry, session_id, &ns, &name)
            .await;
    }

    /// Watch reconcile on relist: drop forwarded services that are no longer in
    /// the freshly-listed set `seen` (catches deletes missed during a gap).
    async fn watch_reconcile_init(
        &self,
        registry: &PortForwardRegistry,
        session_id: &str,
        seen: &HashSet<(String, String)>,
    ) {
        let stale: Vec<(String, String)> = {
            let sessions = self.sessions.lock().await;
            let Some(sess) = sessions.get(session_id) else {
                return;
            };
            sess.services
                .iter()
                .filter(|s| !seen.contains(&(s.namespace.clone(), s.name.clone())))
                .map(|s| (s.namespace.clone(), s.name.clone()))
                .collect()
        };
        for (ns, name) in stale {
            self.teardown_service(registry, session_id, &ns, &name)
                .await;
        }
    }

    /// Stop one service's forwards within a session, drop its alias + IP, and
    /// re-apply hosts. Shared by `watch_delete` and `watch_reconcile_init`.
    async fn teardown_service(
        &self,
        registry: &PortForwardRegistry,
        session_id: &str,
        ns: &str,
        name: &str,
    ) {
        let removed = {
            let mut sessions = self.sessions.lock().await;
            let Some(sess) = sessions.get_mut(session_id) else {
                return;
            };
            sess.services
                .iter()
                .position(|s| s.name == name && s.namespace == ns)
                .map(|pos| sess.services.remove(pos))
        };
        let Some(sf) = removed else {
            return;
        };
        self.discard_service(registry, sf).await;
        let _ = self.reapply_hosts().await;
        info!(service = %name, namespace = %ns, "global-forward dropped deleted service");
    }

    /// Release everything a `ServiceForward` owns — its listeners, loopback
    /// alias, and IP allocation — without touching session membership or
    /// re-applying the hosts block (callers handle those). Used both when a
    /// service is removed from a session and to undo a forward we started but
    /// then lost a race to register (see `watch_apply`).
    async fn discard_service(&self, registry: &PortForwardRegistry, sf: ServiceForward) {
        for fid in &sf.forward_ids {
            if let Some(handle) = registry.by_id.lock().await.remove(fid) {
                let _ = registry
                    .status_tx
                    .send((fid.clone(), ForwardStatus::Stopped));
                drop(handle);
            }
        }
        let _ = self.helper_del_loopback(sf.local_ip).await;
        self.allocator.lock().await.release(sf.local_ip);
    }

    /// Enable global forwarding for a single named service. Stored under its own
    /// per-service session id so it can be disabled independently.
    pub(crate) async fn enable_service(
        &self,
        client: Client,
        registry: &PortForwardRegistry,
        cluster_id: &str,
        namespace: &str,
        svc_name: &str,
    ) -> Result<GlobalSessionSnapshot> {
        self.ensure_helper().await?;
        let api: Api<Service> = Api::namespaced(client.clone(), namespace);
        let svc = api
            .get(svc_name)
            .await
            .map_err(|e| anyhow!("getting service {svc_name}: {e}"))?;
        let ports = service_ports(&svc);
        if ports.is_empty() {
            return Err(anyhow!("service {svc_name} exposes no ports"));
        }
        let sf = self
            .start_service(client, registry, cluster_id, namespace, svc_name, &ports)
            .await?;
        let id = format!("{cluster_id}::svc::{namespace}/{svc_name}");
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                id.clone(),
                GlobalSession {
                    id: id.clone(),
                    cluster_id: cluster_id.to_string(),
                    namespace: namespace.to_string(),
                    services: vec![sf],
                    // Single named service → no live watch (it's pinned to one
                    // target, not a query). Deletion is surfaced via the
                    // forward's own status, not auto-reconciled.
                    watch: None,
                },
            );
        }
        self.reapply_hosts().await?;
        self.snapshot_of(&id)
            .await
            .ok_or_else(|| anyhow!("session vanished after insert"))
    }

    /// Allocate an IP, bring up the alias, and start one listener per port.
    async fn start_service(
        &self,
        client: Client,
        registry: &PortForwardRegistry,
        cluster_id: &str,
        namespace: &str,
        svc_name: &str,
        ports: &[u16],
    ) -> Result<ServiceForward> {
        let ip = {
            let mut alloc = self.allocator.lock().await;
            alloc.allocate(cluster_id, namespace)?
        };
        if let Err(e) = self.helper_add_loopback(ip).await {
            self.allocator.lock().await.release(ip);
            return Err(e);
        }

        let specs = service_specs(cluster_id, namespace, svc_name, ip, ports);
        let mut forward_ids = Vec::new();
        for spec in specs {
            let id = spec.id.clone();
            // Privileged ports (<1024) can't be bound by the unprivileged app on
            // Linux — have the helper bind and pass the socket. Everything else
            // binds in-process.
            let prebound = self.prebind_privileged(&spec).await;
            match start_forward(client.clone(), spec, prebound, registry.status_tx.clone()).await {
                Ok(handle) => {
                    registry.by_id.lock().await.insert(id.clone(), handle);
                    forward_ids.push(id);
                }
                Err(e) => warn!(forward = %id, error = %e, "failed to start global listener"),
            }
        }

        // Every listener failed: don't leak the IP + loopback alias, and don't
        // write a hosts entry that resolves to an address where nothing is
        // listening. Undo and surface the failure to the caller (enable_query
        // logs+skips it; a single named enable_service propagates it to the UI).
        if forward_ids.is_empty() {
            let _ = self.helper_del_loopback(ip).await;
            self.allocator.lock().await.release(ip);
            return Err(anyhow!(
                "no listeners could be started for {namespace}/{svc_name} (all {} port(s) failed)",
                ports.len()
            ));
        }

        Ok(ServiceForward {
            name: svc_name.to_string(),
            namespace: namespace.to_string(),
            local_ip: ip,
            hostnames: hostnames::variants(svc_name, namespace),
            ports: ports.to_vec(),
            forward_ids,
        })
    }

    /// On **Linux**, ask the helper to bind a privileged (<1024) service port and
    /// pass the listening socket back via SCM_RIGHTS — the unprivileged app
    /// can't bind those itself. High ports bind in-process; macOS and Windows
    /// don't restrict low ports, so they always bind in-process too. Returns
    /// `None` (→ in-process bind) for anything that doesn't need the helper, and
    /// also on helper error (the in-process attempt then surfaces the failure).
    #[cfg_attr(not(target_os = "linux"), allow(clippy::unused_async))]
    async fn prebind_privileged(&self, spec: &ForwardSpec) -> Option<std::net::TcpListener> {
        #[cfg(target_os = "linux")]
        {
            let port = spec.requested_local_port.unwrap_or(0);
            if port == 0 || port >= 1024 {
                return None;
            }
            let std::net::IpAddr::V4(ip) = spec.local_ip? else {
                return None;
            };
            let mut guard = self.helper.lock().await;
            let Some(spawned) = guard.as_mut() else {
                warn!(port, "helper not running; cannot bind privileged port");
                return None;
            };
            match spawned.client.bind_listener(ip, port).await {
                Ok(listener) => Some(listener),
                Err(e) => {
                    warn!(%ip, port, error = %e, "helper failed to bind privileged port; falling back to in-process bind (likely to fail)");
                    None
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = spec;
            None
        }
    }

    /// Tear down a session: stop its listeners, drop aliases, free IPs, and
    /// re-apply hosts without it.
    pub(crate) async fn disable(&self, registry: &PortForwardRegistry, id: &str) -> Result<()> {
        let session = self.sessions.lock().await.remove(id);
        let Some(session) = session else {
            return Ok(());
        };
        // Stop the live Service-watch first so it can't re-forward mid-teardown.
        if let Some(watch) = &session.watch {
            watch.abort();
        }
        for svc in &session.services {
            for fid in &svc.forward_ids {
                if let Some(handle) = registry.by_id.lock().await.remove(fid) {
                    let _ = registry
                        .status_tx
                        .send((fid.clone(), ForwardStatus::Stopped));
                    drop(handle);
                }
            }
            let ip = svc.local_ip;
            let _ = self.helper_del_loopback(ip).await;
            self.allocator.lock().await.release(ip);
        }
        // Best-effort: re-apply remaining hosts (helper may be gone already).
        let _ = self.reapply_hosts().await;
        Ok(())
    }

    /// Tear down every global session belonging to `cluster_id` — called when a
    /// cluster disconnects so its forwards don't linger with dead listeners and
    /// stale hosts entries. No-op if the cluster had none.
    pub(crate) async fn disable_cluster(&self, registry: &PortForwardRegistry, cluster_id: &str) {
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().await;
            sessions
                .values()
                .filter(|s| s.cluster_id == cluster_id)
                .map(|s| s.id.clone())
                .collect()
        };
        for id in ids {
            let _ = self.disable(registry, &id).await;
        }
    }

    pub(crate) async fn list(&self) -> Vec<GlobalSessionSnapshot> {
        let sessions = self.sessions.lock().await;
        sessions.values().map(snapshot_of_session).collect()
    }

    async fn snapshot_of(&self, id: &str) -> Option<GlobalSessionSnapshot> {
        let sessions = self.sessions.lock().await;
        sessions.get(id).map(snapshot_of_session)
    }

    /// On shutdown / cluster switch: ask the helper to tear everything down and
    /// drop the child (closing its stdin → parent-death cleanup on Linux).
    pub(crate) async fn shutdown(&self) {
        let mut guard = self.helper.lock().await;
        if let Some(spawned) = guard.as_mut() {
            let _ = spawned.client.shutdown().await;
            // Ensure the elevated child actually dies. On Linux dropping it
            // closes stdin (parent-death watch), but on macOS/Windows there's
            // no stdin pipe, so kill explicitly.
            let _ = spawned.child.start_kill();
        }
        *guard = None;
        // Abort every session's watch task before dropping them — dropping a
        // JoinHandle does NOT cancel the task.
        let mut sessions = self.sessions.lock().await;
        for sess in sessions.values() {
            if let Some(watch) = &sess.watch {
                watch.abort();
            }
        }
        sessions.clear();
        drop(sessions);
        *self.status.lock().await = HelperStatus::NotStarted;
    }
}

fn snapshot_of_session(session: &GlobalSession) -> GlobalSessionSnapshot {
    GlobalSessionSnapshot {
        id: session.id.clone(),
        cluster_id: session.cluster_id.clone(),
        namespace: session.namespace.clone(),
        services: session
            .services
            .iter()
            .map(|s| ServiceForwardEntry {
                name: s.name.clone(),
                namespace: s.namespace.clone(),
                local_ip: s.local_ip.to_string(),
                hostnames: s.hostnames.clone(),
                ports: s.ports.clone(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_session_id_distinguishes_scope_and_selector() {
        let ns = query_session_id("ctx", Some("default"), None);
        let all = query_session_id("ctx", None, None);
        let sel = query_session_id("ctx", Some("default"), Some("app=api"));
        assert_eq!(ns, "ctx::q::default::");
        assert_eq!(all, "ctx::q::*::");
        assert_eq!(sel, "ctx::q::default::app=api");
        // namespace, all-namespaces, and selector queries are all distinct.
        assert_ne!(ns, all);
        assert_ne!(ns, sel);
        assert_ne!(all, sel);
        // stable across clusters
        assert_ne!(
            query_session_id("a", Some("ns"), None),
            query_session_id("b", Some("ns"), None)
        );
    }

    // macOS resolves to `$HOME/.ferrisscope` (env-dependent); on every other
    // platform with no ProjectDirs we fall back to `<config>/run`.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn default_runtime_dir_falls_back_to_config_run() {
        let cfg = Path::new("/tmp/ferrisscope-cfg");
        assert_eq!(default_runtime_dir(None, cfg), cfg.join("run"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn default_runtime_dir_is_short_on_macos() {
        // Whatever it resolves to, the resulting socket path must fit sun_path.
        let cfg = Path::new("/tmp/ferrisscope-cfg");
        let dir = default_runtime_dir(None, cfg);
        let sock = dir.join("helper.sock");
        assert!(
            sock.display().to_string().len() < 104,
            "socket path too long: {}",
            sock.display()
        );
    }

    #[test]
    fn service_specs_bind_real_port_on_loopback_ip() {
        let ip = Ipv4Addr::new(127, 1, 0, 1);
        let specs = service_specs("ctx", "default", "api", ip, &[80, 443]);
        assert_eq!(specs.len(), 2);
        for (spec, port) in specs.iter().zip([80u16, 443]) {
            assert_eq!(spec.mode, ForwardMode::Global);
            assert_eq!(spec.remote_port, port);
            assert_eq!(spec.requested_local_port, Some(port));
            assert_eq!(spec.local_ip, Some(std::net::IpAddr::V4(ip)));
            assert_eq!(spec.target.kind, "Service");
            assert!(spec.id.contains("::global::"));
        }
        // Distinct ids per port.
        assert_ne!(specs[0].id, specs[1].id);
    }

    #[test]
    fn host_entry_carries_dns_variants() {
        let e = host_entry(Ipv4Addr::new(127, 1, 0, 1), "api", "default");
        assert_eq!(e.ip, Ipv4Addr::new(127, 1, 0, 1));
        assert!(e.hostnames.contains(&"api".to_string()));
        assert!(e
            .hostnames
            .contains(&"api.default.svc.cluster.local".to_string()));
    }

    #[test]
    fn service_ports_extracts_and_filters() {
        let svc: Service = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "api" },
            "spec": { "ports": [ { "port": 80 }, { "port": 8443 } ] }
        }))
        .unwrap();
        assert_eq!(service_ports(&svc), vec![80, 8443]);

        let no_ports: Service = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "x" }, "spec": {}
        }))
        .unwrap();
        assert!(service_ports(&no_ports).is_empty());
    }

    fn service_forward(name: &str, ns: &str, ip: Ipv4Addr) -> ServiceForward {
        ServiceForward {
            name: name.to_string(),
            namespace: ns.to_string(),
            local_ip: ip,
            hostnames: hostnames::variants(name, ns),
            ports: vec![80],
            forward_ids: vec![format!("{ns}/{name}")],
        }
    }

    fn session_with(id: &str, services: Vec<ServiceForward>) -> GlobalSession {
        GlobalSession {
            id: id.to_string(),
            cluster_id: "ctx".to_string(),
            namespace: "(all namespaces)".to_string(),
            services,
            watch: None,
        }
    }

    // The manager is constructible without a cluster or helper (helper starts
    // `None`), and `all_host_entries` only reads `sessions` + runs the pure
    // dedup — so we can exercise the collision fix end-to-end here.
    #[tokio::test]
    async fn all_host_entries_drops_bare_name_colliding_across_sessions() {
        let gf =
            GlobalForwardManager::new(PathBuf::from("/tmp/fs-rt"), PathBuf::from("/tmp/fs-cfg"));
        {
            let mut sessions = gf.sessions.lock().await;
            sessions.insert(
                "s1".into(),
                session_with(
                    "s1",
                    vec![service_forward(
                        "api",
                        "default",
                        Ipv4Addr::new(127, 1, 0, 1),
                    )],
                ),
            );
            sessions.insert(
                "s2".into(),
                session_with(
                    "s2",
                    vec![service_forward(
                        "api",
                        "kube-system",
                        Ipv4Addr::new(127, 1, 0, 2),
                    )],
                ),
            );
        }
        let entries = gf.all_host_entries().await;
        assert_eq!(entries.len(), 2);
        // The ambiguous bare `api` is gone from every entry...
        for e in &entries {
            assert!(
                !e.hostnames.contains(&"api".to_string()),
                "bare name must be dropped when it collides: {:?}",
                e.hostnames
            );
        }
        // ...but each remains reachable via its namespace-qualified name.
        assert!(entries
            .iter()
            .any(|e| e.hostnames.contains(&"api.default".to_string())));
        assert!(entries
            .iter()
            .any(|e| e.hostnames.contains(&"api.kube-system".to_string())));
    }

    #[tokio::test]
    async fn all_host_entries_keeps_unique_bare_name() {
        let gf =
            GlobalForwardManager::new(PathBuf::from("/tmp/fs-rt"), PathBuf::from("/tmp/fs-cfg"));
        {
            let mut sessions = gf.sessions.lock().await;
            sessions.insert(
                "s1".into(),
                session_with(
                    "s1",
                    vec![service_forward(
                        "api",
                        "default",
                        Ipv4Addr::new(127, 1, 0, 1),
                    )],
                ),
            );
        }
        let entries = gf.all_host_entries().await;
        assert_eq!(entries.len(), 1);
        assert!(entries[0].hostnames.contains(&"api".to_string()));
    }
}
