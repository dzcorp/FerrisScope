use ferrisscope_core::sync::LockExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use std::path::PathBuf;

use ferrisscope_core::cluster::{Cluster, ClusterInfo};
use ferrisscope_core::fleet::{self, ClusterProbe};
use ferrisscope_core::health::ClusterHealthStatus;
use ferrisscope_core::kubeconfig::{self, ContextInfo};
use ferrisscope_core::logs::{LogEvent, LogStream};
use ferrisscope_core::metrics::{MetricsService, MetricsSnapshot};
use ferrisscope_core::portforwards::{self, ForwardSpec, ForwardTarget, PortForwardsFile};
use ferrisscope_core::prefs::{self, Prefs};
use ferrisscope_core::prom_cache::{self, PromCacheEntry, PromSource};
use ferrisscope_core::prometheus::{self, PromTarget};
use ferrisscope_core::sources::{
    self, keyring_account_key_passphrase, keyring_account_password, KubeconfigSource, SshAuth,
    SshSourceConfig,
};
use ferrisscope_core::ssh as ssh_keychain;
use ferrisscope_core::table_views::{self, TableView, TableViewsFile};
use ferrisscope_kube_ext::{
    apply_resource, delete_resource, discover_crds, drain_node, evict_pod,
    get_cluster_role_binding_detail, get_cluster_role_detail, get_config_map_detail,
    get_cron_job_detail, get_custom_resource_definition_detail, get_custom_resource_detail,
    get_daemon_set_detail, get_deployment_detail, get_endpoint_slice_detail, get_endpoints_detail,
    get_event_detail, get_helm_chart_detail, get_helm_release_detail,
    get_horizontal_pod_autoscaler_detail, get_ingress_class_detail, get_ingress_detail,
    get_job_detail, get_lease_detail, get_limit_range_detail,
    get_mutating_webhook_configuration_detail, get_namespace_detail, get_network_policy_detail,
    get_node_detail, get_persistent_volume_claim_detail, get_persistent_volume_detail,
    get_pod_detail, get_pod_disruption_budget_detail, get_priority_class_detail,
    get_replica_set_detail, get_replication_controller_detail, get_resource_quota_detail,
    get_resource_yaml, get_role_binding_detail, get_role_detail, get_secret_detail,
    get_service_account_detail, get_service_detail, get_stateful_set_detail,
    get_storage_class_detail, get_validating_webhook_configuration_detail, get_well_known_detail,
    helm_install_chart, helm_repo_update, helm_uninstall, helm_upgrade,
    list_config_maps_in_namespace, list_namespace_names, list_object_events,
    list_persistent_volume_claims_in_namespace, list_pods_on_node, list_secrets_in_namespace,
    list_services_in_namespace, lookup, merge_patch_resource, registry, restart_pod_owner,
    restart_pods_owners, restart_workload, set_node_cordon, start_forward, ApplyResult,
    DrainReport, ForwardEntry, ForwardStatus, HelmInstallResult, HelmUpgradeResult,
    MergePatchResult, ResourceKind, ResourceKindEntry, RestartPodsReport,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::AgentState;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::state::{AppState, KindSlot};
use crate::terminal::{PodCleanup, SpawnSpec};
use base64::Engine;

#[derive(Debug, Serialize)]
pub(crate) struct AppInfo {
    pub(crate) name: &'static str,
    pub(crate) version: &'static str,
}

#[tauri::command]
pub(crate) fn ping() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct DevMemoryStats {
    /// Resident set size of the main (Rust) process, in bytes. `None` on
    /// platforms where we can't cheaply read it without pulling in a sysinfo
    /// dep — currently macOS / Windows. The WebKit subprocess is not included.
    pub(crate) rss_bytes: Option<u64>,
}

/// Dev-only memory introspection for the header HUD. Reads `/proc/self/status`
/// on Linux; returns `None` elsewhere. Cheap enough to poll at ~1Hz.
#[tauri::command]
pub(crate) fn dev_memory_stats() -> DevMemoryStats {
    #[cfg(target_os = "linux")]
    {
        DevMemoryStats {
            rss_bytes: read_linux_vmrss_bytes(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        DevMemoryStats { rss_bytes: None }
    }
}

#[cfg(target_os = "linux")]
fn read_linux_vmrss_bytes() -> Option<u64> {
    read_linux_status_kb("VmRSS").map(|kb| kb.saturating_mul(1024))
}

#[cfg(target_os = "linux")]
fn read_linux_status_kb(prefix: &str) -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(prefix) {
            // Format: "<prefix>:\t   12345 kB". `strip_prefix` left a `:`,
            // then whitespace, then number, then ` kB`.
            let rest = rest.strip_prefix(':').unwrap_or(rest);
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb);
        }
    }
    None
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
#[allow(clippy::struct_field_names)] // matches /proc/self/status field names
pub(crate) struct LinuxRssBreakdown {
    /// Heap + uncommitted private mappings — what mimalloc holds.
    pub(crate) anon_kb: u64,
    /// Shared libraries + mmap'd files (sqlite WAL, etc.).
    pub(crate) file_kb: u64,
    /// SysV / POSIX shared memory.
    pub(crate) shmem_kb: u64,
}

#[cfg(target_os = "linux")]
fn read_linux_rss_breakdown() -> LinuxRssBreakdown {
    LinuxRssBreakdown {
        anon_kb: read_linux_status_kb("RssAnon").unwrap_or(0),
        file_kb: read_linux_status_kb("RssFile").unwrap_or(0),
        shmem_kb: read_linux_status_kb("RssShmem").unwrap_or(0),
    }
}

#[cfg(not(target_os = "linux"))]
fn read_linux_rss_breakdown() -> LinuxRssBreakdown {
    LinuxRssBreakdown::default()
}

#[derive(Debug, Serialize)]
pub(crate) struct CompactMemoryResult {
    pub(crate) rss_before: Option<u64>,
    pub(crate) rss_after: Option<u64>,
    /// mimalloc's own view of allocator-reserved memory. Difference
    /// between this and OS RSS tells you what the allocator is sitting
    /// on vs. what's actually in live Rust objects.
    pub(crate) mi_current_commit: u64,
    pub(crate) mi_peak_commit: u64,
    /// Number of cached `ClusterEntry`s in the state map.
    pub(crate) clusters: usize,
    /// Per-cluster breakdown: id, number of active `KindSlot`s,
    /// number of subscribers across them, search-index registered y/n.
    pub(crate) per_cluster: Vec<ClusterMemoryInfo>,
    /// Catch-all counts of other top-level state that could retain
    /// per-cluster Arcs after the entry itself was removed.
    pub(crate) search_indices: usize,
    pub(crate) port_forwards: usize,
    pub(crate) terminals: usize,
    pub(crate) log_streams: usize,
    pub(crate) active_connects: usize,
    pub(crate) fleet_in_flight: usize,
    pub(crate) fleet_cached: usize,
    pub(crate) rss_anon_kb: u64,
    pub(crate) rss_file_kb: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ClusterMemoryInfo {
    pub(crate) cluster_id: String,
    pub(crate) kinds_active: usize,
    pub(crate) subscribers_total: usize,
    pub(crate) metrics_active: bool,
    pub(crate) search_index_active: bool,
}

/// Force mimalloc to release retained pages back to the OS, and
/// report a per-cluster breakdown of what backend state is currently
/// held. Used by the dev HUD to localise where memory is going.
///
/// If `rss_after` is close to `rss_before`, the previous high-water
/// is real Rust state (look at `per_cluster` for the load), not
/// allocator fragmentation. If `mi_current_commit` is much larger
/// than the live working set we expect, that's still the allocator
/// holding pages (force-collect should have moved them; if it didn't,
/// the pages are still actually committed because real allocations
/// reference them).
#[tauri::command]
pub(crate) async fn dev_compact_memory(
    state: State<'_, AppState>,
) -> Result<CompactMemoryResult, String> {
    #[cfg(target_os = "linux")]
    let rss_before = read_linux_vmrss_bytes();
    #[cfg(not(target_os = "linux"))]
    let rss_before: Option<u64> = None;

    ferrisscope_mimalloc_ext::collect(true);

    #[cfg(target_os = "linux")]
    let rss_after = read_linux_vmrss_bytes();
    #[cfg(not(target_os = "linux"))]
    let rss_after: Option<u64> = None;

    let mi = ferrisscope_mimalloc_ext::process_info();

    // Per-cluster breakdown — kept brief (counts only). Probing each
    // cluster's `kinds` map requires its async mutex; iterate the
    // snapshot one entry at a time so we don't sit on the state's
    // outer mutex for the duration.
    let snap = state.entries_snapshot().await;
    let clusters = snap.len();
    let mut per_cluster = Vec::with_capacity(clusters);
    let search_active: std::collections::HashSet<String> =
        state.search_indices.lock().await.keys().cloned().collect();
    for (id, entry) in snap {
        let (kinds_active, subscribers_total) = {
            let kinds = entry.kinds.lock().await;
            let active = kinds.values().filter(|s| s.watcher.is_some()).count();
            let subs = kinds.values().map(|s| s.subscribers).sum::<usize>();
            (active, subs)
        };
        let metrics_active = entry.metrics.lock().await.service.is_some();
        let search_index_active = search_active.contains(&id);
        per_cluster.push(ClusterMemoryInfo {
            cluster_id: id,
            kinds_active,
            subscribers_total,
            metrics_active,
            search_index_active,
        });
    }

    let port_forwards = state.portforwards.by_id.lock().await.len();
    let terminals = state.terminals.count().await;
    let log_streams = state.log_stream_count().await;
    let active_connects = state.active_connect_count().await;
    let (fleet_in_flight, fleet_cached) = {
        let g = state.fleet.lock().await;
        (g.in_flight.len(), g.map.len())
    };

    tracing::info!(
        rss_before_kb = rss_before.map(|b| b / 1024),
        rss_after_kb = rss_after.map(|b| b / 1024),
        delta_kb = rss_before
            .zip(rss_after)
            .map(|(b, a)| (b as i64 - a as i64) / 1024),
        mi_current_commit_kb = mi.current_commit / 1024,
        mi_peak_commit_kb = mi.peak_commit / 1024,
        clusters,
        search_indices = search_active.len(),
        port_forwards,
        terminals,
        log_streams,
        active_connects,
        fleet_cached,
        ?per_cluster,
        "dev_compact_memory: forced mimalloc collect + state snapshot"
    );

    let breakdown = read_linux_rss_breakdown();
    Ok(CompactMemoryResult {
        rss_before,
        rss_after,
        mi_current_commit: mi.current_commit as u64,
        mi_peak_commit: mi.peak_commit as u64,
        clusters,
        per_cluster,
        search_indices: search_active.len(),
        port_forwards,
        terminals,
        log_streams,
        active_connects,
        fleet_in_flight,
        fleet_cached,
        rss_anon_kb: breakdown.anon_kb,
        rss_file_kb: breakdown.file_kb,
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct UpdaterInfo {
    pub(crate) current_version: &'static str,
    pub(crate) releases_url: &'static str,
    pub(crate) target: Option<&'static str>,
    /// `false` when the install method can't be auto-applied — typically a
    /// system-package install (AUR / apt / dnf / brew) or a binary the user
    /// dropped on PATH manually. The frontend renders `update_hint` instead
    /// of the apply button when this is false.
    pub(crate) supported: bool,
    pub(crate) unsupported_reason: Option<String>,
    /// How this binary was installed. Always populated; the frontend uses it
    /// to decide between the apply-now button and a "run this command" hint.
    pub(crate) install_method: crate::updater::InstallMethod,
    /// Operator-facing command for system-package installs. `None` when the
    /// install method is self-updateable or genuinely unknown.
    pub(crate) update_hint: Option<&'static str>,
}

#[tauri::command]
pub(crate) fn updater_info() -> UpdaterInfo {
    let (target, target_err) = match crate::updater::supported_target_label() {
        Ok(label) => (Some(label), None),
        Err(e) => (None, Some(e)),
    };
    let install_method = crate::updater::detect_install_method();
    // `supported` is the AND of "we can identify the platform target" and
    // "the install method's ABI is one we can swap in-place". A system
    // package install (AUR/.deb/.rpm/Homebrew) is intentionally NOT
    // supported even though we know the platform — the package manager
    // owns the file and the in-app updater would either fail to write
    // /usr/bin/ferrisscope (perm denied) or fight with pacman.
    let in_app = install_method.supports_in_app_apply();
    let (supported, unsupported_reason) = match (&target, target_err, in_app) {
        (Some(_), _, true) => (true, None),
        (Some(_), _, false) => (
            false,
            Some("Installed via a system package manager — update via that tool.".into()),
        ),
        (None, Some(e), _) => (false, Some(e)),
        (None, None, _) => (
            false,
            Some("Updater is not supported on this platform.".into()),
        ),
    };
    let update_hint = install_method.update_hint();
    UpdaterInfo {
        current_version: crate::updater::current_version(),
        releases_url: crate::updater::releases_page_url(),
        target,
        supported,
        unsupported_reason,
        install_method,
        update_hint,
    }
}

#[tauri::command]
pub(crate) async fn check_for_update() -> Result<crate::updater::CheckOutcome, String> {
    tokio::task::spawn_blocking(crate::updater::check_latest_release)
        .await
        .map_err(|e| format!("update check task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn apply_update(release: crate::updater::ReleaseInfo) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::updater::prepare_and_spawn_update(&release))
        .await
        .map_err(|e| format!("apply-update task failed: {e}"))?
}

/// Dynamic "What's new" notes for the About panel: every release newer than the
/// installed build, newest-first, with parsed change items. Disk-cached and
/// ETag-revalidated; `force` skips the freshness window (still ETag-guarded).
#[tauri::command]
pub(crate) async fn get_release_notes_cmd(
    force: bool,
) -> Result<crate::updater::ReleaseNotesBundle, String> {
    tokio::task::spawn_blocking(move || crate::updater::fetch_release_notes(force))
        .await
        .map_err(|e| format!("release-notes task failed: {e}"))?
}

// ── kubectl install / detection ──────────────────────────────────────────

#[tauri::command]
pub(crate) async fn kubectl_get_status() -> Result<crate::kubectl_install::KubectlDetection, String>
{
    Ok(crate::kubectl_install::detect())
}

#[tauri::command]
pub(crate) async fn kubectl_install_managed(
) -> Result<crate::kubectl_install::KubectlInstallResult, String> {
    tokio::task::spawn_blocking(crate::kubectl_install::install_latest_blocking)
        .await
        .map_err(|e| format!("kubectl install task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn kubectl_uninstall_managed() -> Result<(), String> {
    tokio::task::spawn_blocking(crate::kubectl_install::uninstall_managed)
        .await
        .map_err(|e| format!("kubectl uninstall task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

// ── helm install / detection ─────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn helm_get_status() -> Result<crate::helm_install::HelmDetection, String> {
    Ok(crate::helm_install::detect())
}

#[tauri::command]
pub(crate) async fn helm_install_managed(
) -> Result<crate::helm_install::HelmManagedInstallResult, String> {
    tokio::task::spawn_blocking(crate::helm_install::install_latest_blocking)
        .await
        .map_err(|e| format!("helm install task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn helm_uninstall_managed() -> Result<(), String> {
    tokio::task::spawn_blocking(crate::helm_install::uninstall_managed)
        .await
        .map_err(|e| format!("helm uninstall task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn list_contexts(state: State<'_, AppState>) -> Result<Vec<ContextInfo>, String> {
    let sources = state.sources.lock().await;
    kubeconfig::list_contexts(&sources).map_err(|e| e.to_string())
}

/// Passive, read-only connection diagnostics for a context: the PATH the app
/// sees, whether the context's exec plugin is findable, and which cloud/proxy/
/// TLS env vars are present. Does NOT execute the plugin (live plugin stderr is
/// already surfaced on connect failure). Backs the "Diagnose connection" UI.
#[tauri::command]
pub(crate) async fn diagnose_connection_cmd(
    name: String,
    state: State<'_, AppState>,
) -> Result<ferrisscope_core::cluster::ConnectionDiagnostics, String> {
    let context_name = kubeconfig::context_name_from_id(&name).to_owned();
    let source_path = {
        let s = state.sources.lock().await;
        kubeconfig::source_path_for(&name, &s)
    };
    // Reads the kubeconfig from disk → keep off the async worker.
    tokio::task::spawn_blocking(move || {
        ferrisscope_core::cluster::diagnose_context(&context_name, source_path.as_deref())
    })
    .await
    .map_err(|e| format!("diagnostics task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Explain a *failed* connect when the cause looks like the "wrong Google
/// account" trap: a context whose `gke-gcloud-auth-plugin` entry carries no
/// `--account`, on a machine with several gcloud accounts, hitting an RBAC 403.
///
/// Returns `None` for every other failure — the caller renders nothing. Runs
/// only after a connect has already failed, so the kubeconfig + gcloud config
/// reads never touch the happy path.
///
/// SSH-sourced contexts are skipped: their kubeconfig lives on the remote host,
/// so a local exec entry (and a local gcloud install) says nothing about them.
#[tauri::command]
pub(crate) async fn connect_hint_cmd(
    name: String,
    error: String,
    state: State<'_, AppState>,
) -> Result<Option<ferrisscope_core::cloud_identity::ConnectHint>, String> {
    let context_name = kubeconfig::context_name_from_id(&name).to_owned();
    let (is_ssh, source_path) = {
        let s = state.sources.lock().await;
        (
            kubeconfig::ssh_for(&name, &s).is_some(),
            kubeconfig::resolve_path_for(&name, &s),
        )
    };
    if is_ssh {
        return Ok(None);
    }
    // `resolve_path_for` is `None` only when the id names no source we know —
    // a stale panel for a source the operator has since removed, or an SSH
    // source with a null `ssh` block. Reading the *default* kubeconfig in that
    // case would classify whatever context happens to share the name and
    // produce a confident note about the wrong cluster, so render nothing.
    //
    // Resolving to a concrete file (rather than passing `None` and letting
    // kube-rs merge every `KUBECONFIG` entry) also keeps this in step with the
    // pin, which can only ever write one file: if the failing context lives in
    // the second entry of a multi-file `KUBECONFIG`, the lookup misses here and
    // no note is offered, instead of offering a pin that always fails.
    let Some(source_path) = source_path else {
        return Ok(None);
    };
    // Reads the kubeconfig + gcloud config dir from disk → keep off the async
    // worker, same as `diagnose_connection_cmd`.
    tokio::task::spawn_blocking(move || {
        ferrisscope_core::cloud_identity::hint_for_context(
            &context_name,
            Some(source_path.as_path()),
            &error,
        )
    })
    .await
    .map_err(|e| format!("connect hint task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Pin a context's exec entry to an explicit cloud identity — a gcloud
/// `--account` or an AWS `AWS_PROFILE`, whichever the exec command calls for.
///
/// The kubeconfig is backed up before the first edit. For gcloud (and only
/// gcloud) the pin also drops `~/.kube/gke_gcloud_auth_plugin_cache`, which can
/// still be holding a token minted under the previous identity; see
/// `cloud_identity::pin_identity`. Azure is refused there — kubelogin has no
/// per-context account flag.
///
/// Refuses SSH-sourced contexts — the kubeconfig being described lives on
/// another host and isn't ours to rewrite.
#[tauri::command]
pub(crate) async fn pin_cloud_identity_cmd(
    name: String,
    identity: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let context_name = kubeconfig::context_name_from_id(&name).to_owned();
    let (is_ssh, source_path) = {
        let s = state.sources.lock().await;
        (
            kubeconfig::ssh_for(&name, &s).is_some(),
            kubeconfig::resolve_path_for(&name, &s),
        )
    };
    if is_ssh {
        return Err(
            "this context comes from a remote kubeconfig over SSH — pin the identity on that host"
                .to_owned(),
        );
    }
    // `resolve_path_for` applies the default-kubeconfig fallback *only* for
    // ids from the implicit default source. Falling back on a bare
    // `source_path_for` miss would be wrong three ways out of four: an unknown
    // source id, a removed source, and an SSH source whose `ssh` block is null
    // (representable — the field is `#[serde(default)] Option`, so the
    // `is_ssh` check above misses it) would each rewrite the operator's *local*
    // kubeconfig for a context that does not live there.
    let path = source_path.ok_or_else(|| {
        format!("could not locate the kubeconfig file backing {name} — nothing was written")
    })?;
    tokio::task::spawn_blocking(move || {
        ferrisscope_core::cloud_identity::pin_identity(&path, &context_name, &identity)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("pin identity task failed: {e}"))?
}

/// Wall-clock budget for `connect_context`. Long enough for slow auth plugins
/// (gke/aws/oidc shell out and can be sluggish on a cold cache) but short
/// enough that a wedged apiserver doesn't pin the panel forever. The frontend
/// can also abort early via `cancel_connect`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Connect to the named context and return basic cluster info as a
/// proof of life. Used by the UI to confirm the kubeconfig works before
/// any reflectors are spun up.
///
/// `connect_id` is an opaque, frontend-generated nonce per attempt so the UI
/// can call `cancel_connect(connect_id)` to drop the in-flight future. Two
/// successive attempts must use distinct ids; the second clobbers the first
/// in the map (and the first becomes uncancellable, which is fine — it'll
/// either land soon or hit the timeout).
#[tauri::command]
pub(crate) async fn connect_context(
    name: String,
    connect_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClusterInfo, String> {
    let (tx, rx) = oneshot::channel::<()>();
    state.connects.lock().await.insert(connect_id.clone(), tx);

    let context_name = kubeconfig::context_name_from_id(&name).to_owned();
    let ssh_lookup = {
        let s = state.sources.lock().await;
        kubeconfig::ssh_for(&name, &s)
    };
    let source_path = if ssh_lookup.is_none() {
        let s = state.sources.lock().await;
        kubeconfig::source_path_for(&name, &s)
    } else {
        None
    };

    // Connect path: auth handshake + a single apiserver_version round trip
    // as proof of life. We used to skip the apiserver call here (info() ran
    // in the background) because it cost 1-2s before the user could click
    // Pods — but on a broken apiserver the watcher's LIST silently retries
    // forever and the UI hangs on "Loading…", so we'd rather pay the
    // round-trip up front and fail fast with a clean error than show a
    // false "connected" state. The version is discarded; the cluster.info
    // background probe still fills in node count + version on a separate
    // round-trip after we return (so the cluster bar's placeholders flip
    // to real values without blocking the operator from clicking a kind).
    let work = async move {
        let started = std::time::Instant::now();
        let cluster = if let Some((source_id, cfg)) = ssh_lookup {
            Cluster::connect_ssh(&context_name, &cfg, &source_id)
                .await
                .map_err(|e| e.to_string())?
        } else {
            Cluster::connect(&context_name, source_path.as_deref())
                .await
                .map_err(|e| e.to_string())?
        };
        let auth_done = started.elapsed();
        // Inner liveness budget. Smaller than the outer CONNECT_TIMEOUT so
        // the error message says "apiserver did not respond in 8s" instead
        // of the ambiguous "timed out after 15s" — operators can tell the
        // difference between a wedged auth plugin and a wedged apiserver.
        //
        // Uses the canonical `liveness_probe` (real LIST namespaces
        // limit=1) so connect agrees with the background heartbeat and
        // the fleet card on what "alive" means. /version and /api can
        // both succeed against a cluster that hangs on real LIST/WATCH
        // (etcd dead, watch broken, LB in front of dead replicas);
        // the LIST exercises exactly the path the eager namespaces
        // watcher is about to fire.
        const LIVENESS_TIMEOUT: Duration = Duration::from_secs(8);
        let probe_started = std::time::Instant::now();
        tokio::time::timeout(
            LIVENESS_TIMEOUT,
            ferrisscope_core::health::liveness_probe(&cluster.client()),
        )
        .await
        .map_err(|_| {
            format!(
                "apiserver did not respond within {}s — cluster may be unreachable, etcd is down, or the endpoint is wrong",
                LIVENESS_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("apiserver liveness probe failed: {e}"))?;
        tracing::info!(
            context = %context_name,
            auth_ms = auth_done.as_millis() as u64,
            probe_ms = probe_started.elapsed().as_millis() as u64,
            total_ms = started.elapsed().as_millis() as u64,
            "connect_context: Cluster::connect + liveness probe ok"
        );
        Ok::<_, String>(cluster)
    };

    let result: Result<Cluster, String> = tokio::select! {
        biased;
        _ = rx => Err("cancelled".to_owned()),
        r = timeout(CONNECT_TIMEOUT, work) => match r {
            Ok(inner) => inner,
            Err(_) => Err(format!("timed out after {}s", CONNECT_TIMEOUT.as_secs())),
        }
    };

    state.connects.lock().await.remove(&connect_id);

    // Mirror the connect outcome onto the fleet card right away so the
    // landing screen flips green/red without waiting for the next
    // `refresh_fleet` cycle. Preserves any cached numbers (nodes/pods/
    // metrics) on failure — operators want to see "last known good"
    // alongside the red dot, not blank cells. Operator-cancelled
    // connects don't update the card; they're a UX choice, not a
    // statement about cluster health.
    let outcome_for_fleet = match &result {
        Ok(_) => Some((true, None)),
        Err(e) if e == "cancelled" => None,
        Err(e) => Some((false, Some(e.clone()))),
    };
    if let Some((healthy, err)) = outcome_for_fleet {
        record_fleet_health(&app, &state.fleet, &name, healthy, err).await;
    }

    match result {
        Ok(cluster) => {
            // Cache the connected cluster so the next `state.entry(...)` call
            // (e.g. inside `subscribe_resource` when the operator clicks a
            // kind) reuses this client instead of re-running `Cluster::connect`.
            let entry = state.insert_connected(name.clone(), cluster).await;
            // Health forwarder is wired separately via its own CAS so
            // it also runs on the lazy-connect path (eager namespaces
            // subscribe before connect_context). Cheap no-op if already
            // claimed by an earlier command.
            wire_cluster_health(&app, &name, entry.clone());
            // Hold one internal subscriber on `(cluster, "namespaces", All)`
            // for the entry's lifetime so the top-right namespace dropdown
            // stays live across cluster reconnects and React lifecycle
            // races. CAS-gated; no-op on a StrictMode double-fire. See
            // `pin_cluster_namespaces`.
            pin_cluster_namespaces(&app, &name);
            // Connect-time probes (cluster.info background fetch + bench)
            // run exactly once per cluster. The CAS in `claim_connect_probes`
            // guarantees that even if `connect_context` fires twice (React
            // StrictMode in dev, or fast operator clicks) or if the entry
            // was previously created lazily by `state.entry()` from another
            // command path, only the first caller through this code spawns
            // the probes.
            if entry.claim_connect_probes() {
                spawn_cluster_info_probe(app.clone(), name.clone(), entry.clone());
                // Open the search index alongside the first probe so a
                // re-claim (StrictMode double-fire) doesn't reopen the file.
                // If the open fails (DB locked, disk full…) we log and
                // continue — search is a non-essential overlay; cluster
                // browsing still works without it.
                // Drop any handle left from a previous entry (reconnect_cluster
                // keeps the index registered across the teardown) BEFORE
                // reopening, so two writer connections never target the same
                // file beyond the brief window the busy_timeout covers.
                let _ = state.remove_search_index(&name).await;
                match ferrisscope_core::search::SearchIndex::open(&name) {
                    Ok(index) => {
                        state.insert_search_index(name.clone(), index.clone()).await;
                        spawn_search_bootstrap(name.clone(), entry.clone(), index);
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            cluster_id = %name,
                            "search index: open failed; search disabled for this cluster",
                        );
                    }
                }
            } else {
                tracing::info!(
                    cluster_id = %name,
                    "connect_context: probes already claimed, skipping"
                );
            }
            // Return placeholder ClusterInfo immediately so the UI flips
            // to "connected" and lets the operator click into a kind. The
            // real values land via the event a moment later.
            Ok(ClusterInfo {
                server_version: String::new(),
                node_count: 0,
            })
        }
        Err(e) => Err(e),
    }
}

fn spawn_search_bootstrap(
    cluster_id: String,
    entry: Arc<crate::state::ClusterEntry>,
    index: Arc<ferrisscope_core::search::SearchIndex>,
) {
    /// If the existing index has been refreshed within this window, the
    /// LIST is skipped entirely. Tuned for tab-flipping ergonomics — fast
    /// fleet round-trips reuse what's already on disk; longer absences
    /// (after-lunch, next-morning) re-bootstrap so the inline preview in
    /// search hits stays close to the live cluster state.
    const FRESH_WINDOW: Duration = Duration::from_mins(5);

    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();

        // Freshness gate. Failure to query (e.g. writer task already
        // closed) is treated as "not fresh" so we still attempt the
        // bootstrap — it's better to refresh on a transient hiccup than
        // to silently skip and leave search hits stale.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        let fresh_window_ms = i64::try_from(FRESH_WINDOW.as_millis()).unwrap_or(i64::MAX);
        match index.newest_updated_at().await {
            Ok(Some(ts)) if now_ms.saturating_sub(ts) < fresh_window_ms => {
                tracing::info!(
                    cluster_id = %cluster_id,
                    age_ms = now_ms.saturating_sub(ts),
                    "search index: fresh, skipping bootstrap"
                );
                return;
            }
            Ok(Some(ts)) => {
                tracing::debug!(
                    cluster_id = %cluster_id,
                    age_ms = now_ms.saturating_sub(ts),
                    "search index: stale, refreshing"
                );
            }
            Ok(None) => {
                tracing::debug!(
                    cluster_id = %cluster_id,
                    "search index: empty, running first-time bootstrap"
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    cluster_id = %cluster_id,
                    "search index: freshness query failed; bootstrapping anyway"
                );
            }
        }

        let client = entry.cluster.client();
        // Sink closures feed rows directly into the search-index writer.
        // The writer batches internally so we don't need our own buffering
        // at the bootstrap layer. `retain` fires per completely-listed kind
        // and tombstones rows missing from the listing — objects deleted
        // while nothing was watching stop matching searches.
        let upsert = |kind_id: &str, uid: &str, row: &serde_json::Value| {
            index.upsert(kind_id, uid, row);
        };
        let retain = |kind_id: &str, uids: Vec<String>| {
            index.retain(kind_id, uids);
        };
        let n = ferrisscope_kube_ext::bootstrap::bootstrap_default(client, &upsert, &retain).await;
        tracing::info!(
            cluster_id = %cluster_id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            rows = n,
            "search index: bootstrap complete"
        );
    });
}

/// Spawn the health-event forwarder for `cluster_id` exactly once per
/// `ClusterEntry` lifetime. Safe to call from every command that
/// touches `state.entry()` — the CAS in `claim_health_wiring` makes
/// repeat calls cheap no-ops. Without this on lazy-connect paths
/// (App's eager namespaces subscribe runs before `connect_context`),
/// the probe runs but its `Unavailable` event never reaches the UI.
fn wire_cluster_health(app: &AppHandle, cluster_id: &str, entry: Arc<crate::state::ClusterEntry>) {
    if entry.claim_health_wiring() {
        let handle =
            spawn_health_forwarder(app.clone(), cluster_id.to_owned(), entry.health.clone());
        // Stash on the entry so teardown paths can abort it. The CAS in
        // `claim_health_wiring` already guarantees we only get here
        // once per entry lifetime, but be defensive — replace any
        // stale handle and abort it instead of leaking the task.
        if let Some(old) = entry.health_forwarder.lock_recover().replace(handle) {
            tracing::warn!(
                cluster_id = %cluster_id,
                "wire_cluster_health: replaced a pre-existing forwarder handle"
            );
            old.abort();
        }
    }
}

/// Install an always-on internal subscriber on `(cluster, "namespaces", All)`
/// so the reflector stays alive for the lifetime of the entry. The top-right
/// namespace dropdown (and any other UI that wants a live namespace list)
/// then sees deltas immediately without depending on the frontend keeping
/// its own subscription alive across cluster reconnects / React lifecycle
/// quirks / 60 s linger windows. The internal subscriber count is released
/// implicitly when `drop_cluster_watchers` / `tear_down_unhealthy` force-
/// abort every watcher and the entry is removed; a fresh `connect_context`
/// re-fires this on the rebuilt entry.
///
/// CAS-gated so a duplicate `connect_context` (StrictMode double-fire, fast
/// operator click) doesn't add a second pin and leak one subscriber count
/// past teardown. The actual subscribe runs in a spawned task so this
/// helper stays non-async and the caller (a connect path that already paid
/// for client / TLS / probe round trips) doesn't have to wait on the
/// slot-bump round trip.
fn pin_cluster_namespaces(app: &AppHandle, cluster_id: &str) {
    let app = app.clone();
    let cluster_id = cluster_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        // Capture the entry Arc here and reuse it for the subscribe.
        // Going through `subscribe_resource_inner` (which calls
        // `state.entry()`) would lazy-reconnect if the operator
        // disconnected between our spawn and this point — leaking a
        // new entry whose `namespaces_pinned` we can't claim (we
        // already claimed on the now-gone entry) and whose watcher
        // would run forever with no UI consumer.
        let Some(entry) = state.get_existing(&cluster_id).await else {
            return;
        };
        if !entry.claim_namespaces_pinning() {
            return;
        }
        if let Err(e) =
            subscribe_resource_with_entry(&cluster_id, "namespaces", None, &app, entry).await
        {
            // Lazy-failure rather than hard-failure: the frontend's
            // belt-and-braces App.tsx subscribe will still try its own
            // path. Worth a warn so the operator can correlate the
            // top-right going stale with the underlying cluster issue.
            tracing::warn!(
                error = %e,
                cluster_id = %cluster_id,
                "pin_cluster_namespaces: internal subscribe failed"
            );
        }
    });
}

/// Update the fleet cache entry for `cluster_id` with the latest
/// connect outcome and emit `fleet://probe` so the landing screen
/// re-renders the card. Preserves all summary fields on a failed
/// connect (nodes / pods / metrics from the last successful probe stay
/// visible alongside the red dot — operators want last-known-good, not
/// blank cells). On success this only flips the `healthy` flag and
/// timestamp; the per-context detail probe (`refresh_fleet`) refreshes
/// the numbers on its own slower cadence.
async fn record_fleet_health(
    app: &AppHandle,
    fleet: &Arc<tokio::sync::Mutex<crate::state::FleetCache>>,
    cluster_id: &str,
    healthy: bool,
    error: Option<String>,
) {
    let mut g = fleet.lock().await;
    let entry = g
        .map
        .entry(cluster_id.to_owned())
        .or_insert_with(|| ClusterProbe {
            context_name: cluster_id.to_owned(),
            ..Default::default()
        });
    entry.healthy = Some(healthy);
    entry.last_error = error;
    entry.fetched_at_unix_ms = fleet::now_ms();
    let stored = entry.clone();
    let snapshot = g.map.clone();
    drop(g);
    fleet::save_cache(&snapshot).await;
    if let Err(e) = app.emit("fleet://probe", &stored) {
        tracing::warn!(error = %e, ?cluster_id, "failed to emit fleet probe");
    }
}

fn spawn_cluster_info_probe(
    app: AppHandle,
    cluster_id: String,
    entry: Arc<crate::state::ClusterEntry>,
) {
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        match entry.cluster.info().await {
            Ok(info) => {
                tracing::info!(
                    cluster_id = %cluster_id,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "cluster_info_probe: ok"
                );
                let event_name = format!(
                    "cluster_info://changed/{}",
                    sanitize_event_segment(&cluster_id),
                );
                if let Err(e) = app.emit(&event_name, &info) {
                    tracing::warn!(
                        error = %e,
                        cluster_id = %cluster_id,
                        "cluster_info_probe: emit failed"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    cluster_id = %cluster_id,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "cluster_info_probe: failed"
                );
            }
        }
    });
}

/// Abort an in-flight `connect_context` keyed by its `connect_id`. Idempotent
/// — silently no-ops if the attempt has already completed (the entry was
/// removed by the connector's own cleanup).
#[tauri::command]
pub(crate) async fn cancel_connect(
    connect_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(tx) = state.connects.lock().await.remove(&connect_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// Every kind the UI can browse. Returned as static metadata so the frontend
/// can build navigation + table column headers without hard-coding anything.
#[tauri::command]
pub(crate) fn list_resource_kinds() -> Vec<ResourceKind> {
    registry().into_iter().map(|e| e.meta).collect()
}

/// CRD-derived dynamic kinds for a connected cluster. Each entry is a
/// `CustomResourceDefinition` reduced to its preferred (storage / served)
/// version, with a synthetic id encoding the GVK so subsequent
/// subscribe / get-yaml / apply / delete calls can reconstruct the
/// dynamic API target without re-discovery.
///
/// Discovery runs every time the rail asks (cheap one-shot list call). If
/// that becomes a bottleneck we'll cache by `cluster_id`.
#[tauri::command]
pub(crate) async fn list_custom_resource_kinds(
    cluster_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ResourceKind>, String> {
    let entry = state.entry(&cluster_id).await?;
    let crds = discover_crds(entry.cluster.client())
        .await
        .map_err(|e| e.to_string())?;
    Ok(crds
        .into_iter()
        .map(ResourceKindEntry::from_dynamic_crd)
        .map(|e| e.meta)
        .collect())
}

/// Subscribe to live deltas for `(cluster_id, kind_id)`.
///
/// Increments the slot's refcount; starts the reflector + delta forwarder on
/// the first subscribe. Returns the current snapshot — the frontend reconciles
/// further changes from `resource://{cluster_id}/{kind_id}` events.
///
/// `namespace_filter` is applied to the snapshot only; the underlying watcher
/// always observes all namespaces (M1 simplification — per-namespace watchers
/// land later if needed).
/// Result of [`subscribe_resource`]. `rows` is the current snapshot;
/// `init_done` reports whether the underlying watcher has completed its
/// initial sync. The frontend uses `init_done` to decide whether to keep
/// the loading spinner up: if a late subscriber's snapshot is empty *and*
/// `init_done = false`, the watcher hasn't finished listing yet and rows
/// will arrive via deltas. If `init_done = true` and the snapshot is
/// empty, the kind genuinely has no instances and the empty-state UI
/// should render immediately.
#[derive(Debug, Serialize)]
pub(crate) struct SubscribeResult {
    /// Pre-serialised rows straight out of the watcher cache. `RowJson`
    /// splices its stored bytes into the command response instead of being
    /// re-encoded, so a 5000-row snapshot costs ~0.2 ms and one `Vec` of
    /// pointers rather than ~35 ms and a 22 MiB transient `Value` copy.
    pub(crate) rows: Vec<ferrisscope_kube_ext::RowJson>,
    pub(crate) init_done: bool,
}

/// How long a watcher stays alive after its last subscriber unmounts. Lets
/// the operator flip kinds (Pods → Deployments → Pods) back and forth
/// without re-paying the LIST round trip on every switch — the second
/// click finds a still-running watcher and renders from its in-memory
/// snapshot instantly. Only the *initial* connect for a kind costs a LIST.
///
/// Tradeoff: each lingering watcher holds an open WATCH stream (one HTTP
/// connection in the kube `Client` pool) and continues to receive event
/// deltas it has no UI consumer for. 60 s is short enough that a stray
/// idle tab doesn't accumulate forever, long enough that normal navigation
/// stays warm.
const WATCHER_LINGER: std::time::Duration = std::time::Duration::from_mins(1);

#[tauri::command]
pub(crate) async fn subscribe_resource(
    cluster_id: String,
    kind_id: String,
    namespaces: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SubscribeResult, String> {
    subscribe_resource_inner(&cluster_id, &kind_id, namespaces.as_deref(), &app, &state).await
}

/// Body of `subscribe_resource` parameterised over borrowed types so
/// internal callers (the always-on namespaces pin) can share the
/// slot-bump / forwarder-spawn logic without going through Tauri's
/// command dispatch. The `#[tauri::command]` wrapper above is a thin
/// adapter — no logic of its own. Lazy-resolves the entry (this is
/// the eager App.tsx-subscribe path that fires before
/// `connect_context`); callers that already hold the entry and
/// must NOT lazy-reconnect (the namespaces pin, racing against a
/// cluster disconnect) should use `subscribe_resource_with_entry`.
pub(crate) async fn subscribe_resource_inner(
    cluster_id: &str,
    kind_id: &str,
    namespaces: Option<&[String]>,
    app: &AppHandle,
    state: &AppState,
) -> Result<SubscribeResult, String> {
    let entry = state.entry(cluster_id).await?;
    subscribe_resource_with_entry(cluster_id, kind_id, namespaces, app, entry).await
}

/// Slot-bump / forwarder-spawn for an already-resolved
/// `Arc<ClusterEntry>`. Use this when you've non-creatingly looked
/// up the entry (via `state.get_existing`) and want to *avoid* the
/// lazy-reconnect path inside `state.entry()` — typically because
/// you're racing a teardown and a reconnect would leak the new
/// entry. The Tauri-facing `subscribe_resource_inner` is a thin
/// lazy-resolve wrapper over this.
pub(crate) async fn subscribe_resource_with_entry(
    cluster_id: &str,
    kind_id: &str,
    namespaces: Option<&[String]>,
    app: &AppHandle,
    entry: Arc<crate::state::ClusterEntry>,
) -> Result<SubscribeResult, String> {
    let started = std::time::Instant::now();
    let kind = lookup(kind_id).ok_or_else(|| format!("unknown kind: {kind_id}"))?;
    // Lazy-connect callers (App's eager namespaces subscribe runs
    // before connect_context) need the health forwarder wired here so
    // probe events reach the UI. CAS-guarded — cheap no-op when
    // connect_context has already wired it.
    wire_cluster_health(app, cluster_id, entry.clone());
    if entry.unavailable.load(Ordering::SeqCst) {
        // Cluster has been declared unavailable by the health probe and
        // its watchers + metrics service have been torn down. Refuse to
        // re-spawn against the wedged client; the operator must hit
        // Reconnect (which drops the entry and lets the next
        // `connect_context` rebuild from a fresh client) first.
        return Err(format!(
            "cluster {cluster_id} is unavailable — reconnect first"
        ));
    }
    // Derive the watcher scope from the frontend's namespace selection.
    // Cluster-scoped kinds ignore the selection upstream (the registry
    // coerces to `All`), so it doesn't hurt to pass the raw scope here
    // — the registry's `from_*_spec` closures do the right thing.
    let scope = match namespaces {
        Some(list) if kind.meta.namespaced => ferrisscope_kube_ext::NsScope::from_selection(list),
        _ => ferrisscope_kube_ext::NsScope::All,
    };
    let after_entry = started.elapsed().as_millis() as u64;
    let mut slots = entry.kinds.lock().await;
    let slot_key = (kind_id.to_owned(), scope.clone());
    let slot = slots
        .entry(slot_key.clone())
        .or_insert_with(KindSlot::empty);

    // If a linger-shutdown task was scheduled (subscribers had dropped to
    // zero and the watcher was about to be torn down), abort it. The
    // existing watcher stays alive for this re-subscribe — that's the
    // whole point of the linger window. Distinct scopes have distinct
    // slots, so an `All` linger doesn't shield a `ns:foo` re-subscribe
    // from a fresh LIST (and vice-versa) — each scope warms up once.
    let mut cancelled_linger = false;
    if let Some(h) = slot.shutdown_handle.take() {
        h.abort();
        cancelled_linger = true;
    }

    let mut started_watcher = false;
    let watcher = if let Some(w) = &slot.watcher {
        w.clone()
    } else {
        let strategy = entry.cluster.list_strategy();
        // Pull from the per-cluster watcher pool (round-robin across a
        // small fixed set of H2 connections) instead of minting a fresh
        // client per subscribe. Sharing the *single* shared client was
        // observed to stall LIST behind a long-running watch; minting
        // per-kind cost ~30 connection pools per cluster on a
        // fully-browsed UI. The pool is the middle ground.
        let client = entry.cluster.watcher_client();
        let w = (kind.start)(client, scope.clone(), strategy);
        spawn_resource_forwarder(
            app.clone(),
            cluster_id.to_owned(),
            kind_id.to_owned(),
            scope.clone(),
            w.clone(),
        );
        slot.watcher = Some(w.clone());
        started_watcher = true;
        w
    };
    slot.subscribers += 1;

    // The watcher is already namespace-scoped at the apiserver when
    // `scope = One(ns)`; no client-side filter needed. For `All` (multi-
    // select or all-namespaces), the frontend filters rows against the
    // selected set. We deliberately do not filter on the multi-select
    // case here — the frontend already does it.
    let rows = watcher.snapshot();
    let init_done = watcher.init_done();
    tracing::info!(
        cluster_id = %cluster_id,
        kind_id = %kind_id,
        scope = %scope.key(),
        entry_ms = after_entry,
        total_ms = started.elapsed().as_millis() as u64,
        started_watcher,
        cancelled_linger,
        snapshot_rows = rows.len(),
        init_done,
        "subscribe_resource"
    );
    Ok(SubscribeResult { rows, init_done })
}

/// Decrement the refcount for `(cluster_id, kind_id)`. When it hits zero
/// the watcher does **not** drop immediately — it lingers for
/// [`WATCHER_LINGER`] so that flipping kinds (e.g. Pods → Deployments →
/// Pods) doesn't re-pay the LIST round trip. A subsequent
/// `subscribe_resource` within the linger window aborts the shutdown task
/// and re-uses the still-running watcher. Only when the linger expires
/// with subscribers still at zero does the `Arc<ResourceWatcher>` drop
/// (and its `Drop` impl aborts the reflector task).
#[tauri::command]
pub(crate) async fn unsubscribe_resource(
    cluster_id: String,
    kind_id: String,
    namespaces: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Non-creating lookup: if the cluster was already torn down (the
    // operator left the cluster and `drop_cluster_watchers` ran first),
    // there is nothing to unsubscribe from. Using `state.entry()` here
    // would lazy-reconnect — phantom-reviving the cluster we just
    // tore down and undoing the teardown's memory win.
    let Some(entry) = state.get_existing(&cluster_id).await else {
        return Ok(());
    };
    // Resolve scope the same way subscribe did, so we hit the right slot.
    // Cluster-scoped kinds get coerced to `All` in the registry layer; we
    // do the same here to avoid creating a phantom `ns:foo` slot that no
    // subscribe ever matched.
    let kind_namespaced = lookup(&kind_id).is_some_and(|k| k.meta.namespaced);
    let scope = match namespaces.as_deref() {
        Some(list) if kind_namespaced => ferrisscope_kube_ext::NsScope::from_selection(list),
        _ => ferrisscope_kube_ext::NsScope::All,
    };
    let slot_key = (kind_id.clone(), scope.clone());
    let mut slots = entry.kinds.lock().await;
    if let Some(slot) = slots.get_mut(&slot_key) {
        slot.subscribers = slot.subscribers.saturating_sub(1);
        if slot.subscribers == 0 {
            // Replace any prior pending shutdown (shouldn't normally
            // happen — subscribers went 0 → +N → 0 — but defensive).
            if let Some(prev) = slot.shutdown_handle.take() {
                prev.abort();
            }
            let entry_for_task = entry.clone();
            let key_for_task = slot_key.clone();
            let cluster_for_task = cluster_id.clone();
            // Use `tokio::spawn` (not `tauri::async_runtime::spawn`) so the
            // returned handle's type matches `KindSlot::shutdown_handle`.
            let handle = tokio::spawn(async move {
                tokio::time::sleep(WATCHER_LINGER).await;
                let mut slots = entry_for_task.kinds.lock().await;
                let Some(slot) = slots.get_mut(&key_for_task) else {
                    return;
                };
                if slot.subscribers != 0 {
                    // A new subscriber arrived between the timer firing
                    // and us re-acquiring the lock — they should have
                    // aborted us, but if the abort raced the sleep
                    // completing, just bail out here. The slot's
                    // shutdown_handle is still pointing at *this* task,
                    // which has now exited; the new subscriber's
                    // `take().abort()` becomes a no-op.
                    return;
                }
                tracing::info!(
                    cluster_id = %cluster_for_task,
                    kind_id = %key_for_task.0,
                    scope = %key_for_task.1.key(),
                    linger_secs = WATCHER_LINGER.as_secs(),
                    "watcher: linger expired, dropping"
                );
                slot.watcher.take();
                slot.shutdown_handle.take();
                slots.remove(&key_for_task);
            });
            slot.shutdown_handle = Some(handle);
            tracing::debug!(
                cluster_id = %cluster_id,
                kind_id = %kind_id,
                scope = %scope.key(),
                linger_secs = WATCHER_LINGER.as_secs(),
                "watcher: subscribers=0, scheduling linger shutdown"
            );
        }
    }
    Ok(())
}

/// Force-drop every kind watcher for `cluster_id`, ignoring linger windows.
/// Called when the operator switches to a different cluster — the previous
/// cluster's watchers should release their kube `Client` connections + the
/// apiserver-side watch slots immediately, not 60 s later. Returns the
/// number of watchers torn down (purely for the log line).
async fn drop_all_kind_watchers(state: &AppState, cluster_id: &str) -> usize {
    // Non-creating: if the cluster isn't cached we have nothing to
    // tear down. Using `state.entry()` here would lazy-reconnect (full
    // `Cluster::connect` round trip — TLS, exec-auth plugin, the lot)
    // just to drop watchers that never existed.
    let Some(entry) = state.get_existing(cluster_id).await else {
        return 0;
    };
    let mut slots = entry.kinds.lock().await;
    let mut dropped = 0;
    for (_kind, slot) in slots.iter_mut() {
        if let Some(h) = slot.shutdown_handle.take() {
            h.abort();
        }
        if slot.watcher.take().is_some() {
            dropped += 1;
        }
        slot.subscribers = 0;
    }
    slots.clear();
    drop(slots);

    // Abort the per-cluster event forwarders. Each holds an `Arc` that
    // pins its broadcast source (`ClusterHealth` / `MetricsService`)
    // alive — without abort, the forwarder's `rx.recv()` blocks
    // forever and the source's task + kube `Client` HTTP keepalive
    // stay resident. See `ClusterEntry::health_forwarder` rustdoc for
    // the retention-cycle write-up.
    if let Some(h) = entry.health_forwarder.lock_recover().take() {
        h.abort();
    }
    if let Some(h) = entry.metrics_forwarder.lock_recover().take() {
        h.abort();
    }
    // Also tear down the metrics service itself so the next
    // `subscribe_metrics` against this cluster (after reconnect) starts
    // from a fresh poll task instead of reusing a dangling Arc.
    {
        let mut slot = entry.metrics.lock().await;
        slot.subscribers = 0;
        slot.service.take();
    }

    dropped
}

/// Mark the cluster unavailable and tear down its live data plane —
/// kind watchers (refcount → 0, reflector tasks abort) and metrics
/// service (Drop aborts the polling task). Keeps the `ClusterEntry` in
/// the map so the frontend's last-known rows aren't orphaned and
/// `subscribe_*` calls return a clean "unavailable" error instead of
/// silently re-spawning watchers against the wedged client. Recovery
/// is `reconnect_cluster`, which drops the entry and lets the next
/// `connect_context` rebuild from a fresh client.
async fn tear_down_unhealthy(state: &AppState, cluster_id: &str) {
    // Non-creating: see `drop_all_kind_watchers`.
    let Some(entry) = state.get_existing(cluster_id).await else {
        return;
    };
    // Set the gate first so any subscribe_* arriving during teardown
    // bails out early rather than racing the Arc drop.
    entry.unavailable.store(true, Ordering::SeqCst);
    let dropped = drop_all_kind_watchers(state, cluster_id).await;
    let metrics_dropped = {
        let mut slot = entry.metrics.lock().await;
        slot.subscribers = 0;
        slot.service.take().is_some()
    };
    tracing::warn!(
        cluster_id = %cluster_id,
        watchers_dropped = dropped,
        metrics_dropped,
        "tear_down_unhealthy: cluster unavailable, data plane torn down"
    );
}

/// Header-palette search across the cluster's index.
///
/// Returns up to `limit` hits sorted by FTS5 bm25 (lower = more
/// relevant). Returns an empty vector — never an error — if the
/// cluster has no registered index (not yet connected, or the index
/// failed to open at connect time). The palette gracefully shows zero
/// results rather than a scary toast in that case.
#[tauri::command]
pub(crate) async fn search_cluster_index(
    cluster_id: String,
    query: String,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<ferrisscope_core::search::SearchHit>, String> {
    let Some(index) = state.search_index_for(&cluster_id).await else {
        return Ok(Vec::new());
    };
    index
        .search(&query, limit as usize)
        .await
        .map_err(|e| e.to_string())
}

/// Spawn the background GC loop that prunes the per-cluster search
/// indices on a fixed schedule. Single task for the whole app — it
/// snapshots the registered indices each tick so newly-connected
/// clusters get swept without restarting the loop.
pub(crate) fn spawn_search_index_gc(handle: AppHandle) {
    use std::time::Duration;
    /// Tick cadence — at 10 min we trade a bit of disk for not waking
    /// up an idle laptop too often.
    const TICK: Duration = Duration::from_mins(10);
    /// Tombstones older than this are hard-deleted. A flapping pod
    /// re-upserted within the window flips `deleted_at` back to NULL,
    /// so this only purges genuinely-gone rows.
    const TOMBSTONE_AGE: Duration = Duration::from_hours(24);
    /// Rows last seen alive longer ago than this are dropped — bounds
    /// disk for kinds the operator opened once and never returned to.
    const STALE_AGE: Duration = Duration::from_hours(168);
    /// Initial delay to keep the GC out of cold-start contention with
    /// connect / probe / bootstrap.
    const STARTUP_DELAY: Duration = Duration::from_mins(1);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            let state = handle.state::<AppState>();
            let snapshot: Vec<(String, Arc<ferrisscope_core::search::SearchIndex>)> = {
                let map = state.search_indices.lock().await;
                map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
            };
            for (cluster_id, index) in snapshot {
                match index.gc(TOMBSTONE_AGE, STALE_AGE).await {
                    Ok(stats) => {
                        if stats.tombstones_purged > 0 || stats.stale_purged > 0 {
                            tracing::info!(
                                cluster_id = %cluster_id,
                                tombstones = stats.tombstones_purged,
                                stale = stats.stale_purged,
                                "search index: gc"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            cluster_id = %cluster_id,
                            "search index: gc failed"
                        );
                    }
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Drop every still-running watcher for the named cluster. Frontend
/// invokes this when the operator switches contexts so we don't pay
/// idle-watcher cost on the cluster they just left.
///
/// The on-disk search index file is **kept** on context switch — the
/// next reconnect reopens it and the bootstrap LIST refreshes the rows
/// in place, so search results survive a fleet-switch round trip. Use
/// `forget_cluster_search_index` (called from the kubeconfig source-removal
/// path) to actually delete the file.
#[tauri::command]
pub(crate) async fn drop_cluster_watchers(
    cluster_id: String,
    state: State<'_, AppState>,
    agent_state: State<'_, AgentState>,
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
) -> Result<(), String> {
    // Close any chats bound to this cluster FIRST, while its kube `Client` is
    // still alive, so each chat's `on_chat_close` can delete its debug pods and
    // disconnect node-SSH sessions instead of leaking them (the frontend's own
    // `chat_close` may never arrive on a backend-initiated disconnect, and the
    // pods' TTL would otherwise be the only backstop).
    let chats_closed = agent_state.close_chats_for_cluster(&cluster_id).await;
    // Tear down any global (DNS) forward sessions for this cluster: stop their
    // listeners, drop loopback aliases, strip their /etc/hosts entries. Done
    // here (not relying on app-exit) so a disconnect doesn't leave dead
    // listeners + stale hosts entries pointing at a gone cluster.
    gf.disable_cluster(&state.portforwards, &cluster_id).await;
    // Abort log streams + log-pod watches owned by this cluster so their reader
    // tasks stop retrying against the torn-down apiserver (the frontend's panel
    // close may never arrive on a backend-initiated disconnect).
    let logs_dropped = state.drop_cluster_logs(&cluster_id).await;
    // Close terminal sessions (PTYs) owned by this cluster so they don't keep
    // running after the operator leaves the tab, and delete each session's
    // debug pod (kubectl-debug leaves it behind). Done BEFORE `remove_cluster`
    // so the kube `Client` is still alive for the deletes — same ordering
    // rationale as the chat close above.
    let (terminals_closed, term_cleanups) = state
        .terminals
        .close_terminals_for_cluster(&cluster_id)
        .await;
    if !term_cleanups.is_empty() {
        match state.get_existing(&cluster_id).await {
            Some(entry) => {
                let client = entry.cluster.client();
                for cleanup in term_cleanups {
                    spawn_delete_cleanup_pod(client.clone(), cleanup);
                }
            }
            None => tracing::warn!(
                cluster_id = %cluster_id,
                "terminal cleanup: cluster entry already gone; debug pods may orphan (server-side TTL is the backstop)"
            ),
        }
    }
    // Stop UNPINNED simple port-forwards for this cluster. Pinned forwards are
    // persisted to portforwards.json and intentionally survive a disconnect
    // (they re-attach on the next connect), so only ephemeral ones are torn
    // down here.
    let forwards_stopped = state.portforwards.stop_cluster_forwards(&cluster_id).await;
    let dropped = drop_all_kind_watchers(&state, &cluster_id).await;
    let removed = state.remove_cluster(&cluster_id).await.is_some();
    // Drop the in-memory search-index handle. The writer task flushes its
    // pending batch and exits, SQLite releases its WAL locks, the file
    // stays on disk. Reconnecting calls `SearchIndex::open` which opens
    // the existing file and the bootstrap LIST refreshes rows in place.
    let index_closed = state.remove_search_index(&cluster_id).await.is_some();
    // The printer-column cache is keyed by cluster-independent `crd:` ids, so
    // an entry may be shared by other connected clusters — we can only safely
    // reclaim it once NO cluster remains connected (nothing can reference it
    // then). It repopulates on the next connect's CRD discovery.
    let cleared_crd_columns = state.cluster_count().await == 0;
    if cleared_crd_columns {
        ferrisscope_kube_ext::clear_printer_column_cache();
    }
    tracing::info!(
        cluster_id = %cluster_id,
        chats_closed,
        logs_dropped,
        terminals_closed,
        forwards_stopped,
        dropped,
        removed,
        index_closed,
        cleared_crd_columns,
        "drop_cluster_watchers: cluster left, watchers torn down"
    );
    // Tearing down a cluster frees a lot of memory in a short window:
    // the watcher row caches, the kube `Client` HTTP/2 pool, TLS
    // state, the search-index writer task, and the broadcast
    // retention rings. Without prompting, mimalloc holds those pages
    // in its arenas until its next opportunistic collect (minutes),
    // so RSS plateaus at the high-water mark. Force a collect so the
    // operator returning to the fleet sees the real working set, not
    // the arena overhang.
    ferrisscope_mimalloc_ext::collect(true);
    Ok(())
}

/// Tear down everything for `cluster_id` so the very next `connect_context`
/// rebuilds from a fresh `Cluster` (and a fresh kube `Client` HTTP/2 pool).
/// Called from the unavailable-banner Reconnect button: the existing client
/// may be wedged after the apiserver hiccup, and reusing it would just keep
/// failing. Search index is preserved (the writer task exits on `Drop`, the
/// SQLite file stays on disk and is reopened by `connect_context`).
#[tauri::command]
pub(crate) async fn reconnect_cluster(
    cluster_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // The fresh `connect_context` rebuilds the kube `Client`; the old log
    // streams / watches hold the wedged one, so abort them here too.
    let logs_dropped = state.drop_cluster_logs(&cluster_id).await;
    let dropped = drop_all_kind_watchers(&state, &cluster_id).await;
    let removed = state.remove_cluster(&cluster_id).await.is_some();
    tracing::info!(
        cluster_id = %cluster_id,
        logs_dropped,
        dropped,
        removed,
        "reconnect_cluster: entry dropped, awaiting fresh connect_context"
    );
    // Same rationale as `drop_cluster_watchers`: return freed pages to
    // the OS so the post-reconnect RSS doesn't pile on top of the
    // pre-reconnect high-water.
    ferrisscope_mimalloc_ext::collect(true);
    Ok(())
}

/// Permanently delete the per-cluster search index file. Called from the
/// kubeconfig source-removal path when the cluster will not be coming
/// back. Idempotent — succeeds silently if no file exists.
#[tauri::command]
pub(crate) async fn forget_cluster_search_index(
    cluster_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Drop any in-memory handle first so the writer flushes and SQLite
    // releases the WAL locks before we delete the files.
    let _ = state.remove_search_index(&cluster_id).await;
    if let Err(e) = ferrisscope_core::search::SearchIndex::drop_files(&cluster_id) {
        tracing::warn!(
            error = %e,
            cluster_id = %cluster_id,
            "search index: drop_files failed"
        );
        return Err(e.to_string());
    }
    tracing::info!(
        cluster_id = %cluster_id,
        "search index: forgotten (file removed)"
    );
    Ok(())
}

fn spawn_resource_forwarder(
    app: AppHandle,
    cluster_id: String,
    kind_id: String,
    scope: ferrisscope_kube_ext::NsScope,
    watcher: Arc<ferrisscope_kube_ext::ResourceWatcher>,
) {
    // Take exclusive drain access. Single-consumer by design — the
    // previous broadcast-based pipe lost events under load and is gone.
    let drainer = watcher.take_drainer();
    let event_name = resource_event_name(&cluster_id, &kind_id, &scope);
    tauri::async_runtime::spawn(async move {
        // Two-phase batching:
        //
        // - Init phase (until the watcher signals `InitDone` for this
        //   kind): 16 ms debounce so the table paints progressively as
        //   the apiserver streams the first list.
        //
        // - Steady phase (after InitDone): 1 s debounce so a pod that
        //   flips status 40×/s produces one row update per second
        //   instead of forty. Same uid-coalescing keeps payload small.
        //
        // Backpressure is natural: while we're inside `emit` for batch
        // N, the watcher keeps writing into the dirty channel; batch
        // N+1 sees the accumulated state in one drain. Unlike the prior
        // 256-slot broadcast ring, nothing is dropped under load — the
        // operator no longer sees Pods stall at ~2000 of 3000+ on big
        // clusters, and a CRD list with 6000+ instances paints
        // progressively instead of waiting for the whole sync to land.
        //
        // Per-emit cap: by-uid coalescing bounds a *steady* batch to the
        // distinct uids touched in the debounce window, but the *initial*
        // list has one distinct uid per object — so a 6000-instance CRD
        // coalesces to a 6000-row drain. Emitting that in one shot
        // serialises a multi-MB JSON payload and lands as a single giant
        // React reconcile. `drain_capped(MAX_EMIT_DELTAS)` slices each wake
        // into bounded chunks (holding `init_done` until the maps are fully
        // drained); `yield_now` between chunks keeps one kind's init burst
        // from monopolising the executor while other forwarders wait.
        const INIT_WINDOW: Duration = Duration::from_millis(16);
        const STEADY_WINDOW: Duration = Duration::from_secs(1);
        // Max Upsert+Delete deltas per emitted batch. Bounds the per-message
        // serialize + IPC copy cost and the size of any single frame the
        // webview must reconcile. Steady-state batches are far smaller, so
        // this only bites during the initial-sync burst.
        const MAX_EMIT_DELTAS: usize = 1000;

        let started = std::time::Instant::now();
        let mut forwarded = 0u64;
        let mut first_forwarded = false;
        let mut steady = false;

        loop {
            if !drainer.wait_for_change().await {
                tracing::info!(
                    cluster_id = %cluster_id,
                    kind_id = %kind_id,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    forwarded,
                    "forwarder: drainer closed, exiting"
                );
                return;
            }

            let window = if steady { STEADY_WINDOW } else { INIT_WINDOW };
            tokio::time::sleep(window).await;

            // Resolve the search index per wake, not once at spawn: watchers
            // can start before `connect_context` registers the index (eager
            // namespaces subscribe, the pinned-namespaces watcher, lazy
            // connects), and a reconnect can replace the handle — a captured
            // `Option` would keep this forwarder feeding nothing (or a dead
            // writer) for its whole lifetime.
            let search_index = app.state::<AppState>().search_index_for(&cluster_id).await;

            // Drain-and-emit in bounded chunks. One wake can have accumulated
            // far more than MAX_EMIT_DELTAS during init; `drain_capped` slices
            // it so each `emit` carries a bounded payload. The inner loop ends
            // when the channel is empty for this wake (the common steady-state
            // case is one chunk + one cheap empty drain).
            loop {
                let drained = drainer.drain_capped(MAX_EMIT_DELTAS);
                if drained.is_empty() {
                    break;
                }

                let init_done_in_batch = drained.init_done;
                let mut batch: Vec<ferrisscope_kube_ext::ResourceDelta> =
                    Vec::with_capacity(drained.delta_count() + usize::from(init_done_in_batch));
                // Fan every Upsert / Delete into the per-cluster search index
                // when one is registered, as we build the emit batch — the
                // drain map's key *is* the uid and the `Row` carries the
                // hoisted `namespace` / `name`, so the index never has to
                // re-parse or re-encode the row. The index handle is
                // `Option`al so a cluster whose index failed to open keeps
                // browsing without breaking. `InitDone` is bus-only.
                for (uid, row) in drained.upserts {
                    if let (Some(index), Some(name)) = (search_index.as_ref(), row.name.as_deref())
                    {
                        index.upsert_raw(
                            &kind_id,
                            &uid,
                            row.namespace.as_deref(),
                            name,
                            row.json.get(),
                        );
                    }
                    batch.push(ferrisscope_kube_ext::ResourceDelta::Upsert { row: row.json });
                }
                for uid in drained.deletes {
                    if let Some(index) = search_index.as_ref() {
                        index.delete(&kind_id, &uid);
                    }
                    batch.push(ferrisscope_kube_ext::ResourceDelta::Delete { uid });
                }
                if init_done_in_batch {
                    batch.push(ferrisscope_kube_ext::ResourceDelta::InitDone);
                }

                let n = batch.len();
                if let Err(e) = app.emit(&event_name, &batch) {
                    tracing::warn!(error = %e, ?cluster_id, ?kind_id, "failed to emit batch");
                }
                forwarded += n as u64;

                if !first_forwarded {
                    first_forwarded = true;
                    tracing::info!(
                        cluster_id = %cluster_id,
                        kind_id = %kind_id,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        first_batch = n,
                        phase = if steady { "steady" } else { "init" },
                        "forwarder: first batch emitted to webview"
                    );
                } else if forwarded.is_multiple_of(500) || forwarded < 200 {
                    tracing::debug!(
                        cluster_id = %cluster_id,
                        kind_id = %kind_id,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        forwarded,
                        last_batch = n,
                        phase = if steady { "steady" } else { "init" },
                        "forwarder: emit progress"
                    );
                }

                if init_done_in_batch {
                    tracing::info!(
                        cluster_id = %cluster_id,
                        kind_id = %kind_id,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        forwarded,
                        "forwarder: init_done emitted, switching to steady-phase batching"
                    );
                    steady = true;
                    // Init-sync allocates a lot of transient memory: typed
                    // `Pod`/`Deployment`/… structs from kube-rs are
                    // deserialised, projected to `Value`, then dropped;
                    // intermediate JSON serialisations for IPC are emitted
                    // then freed. The allocator (mimalloc) often holds
                    // those arena pages until its next opportunistic
                    // collect — which can be minutes. Force one now so the
                    // operator sees RSS settle to the steady-state working
                    // set, not the high-water mark of the init burst.
                    ferrisscope_mimalloc_ext::collect(false);
                }

                // Yield between chunks so a capped init burst paints
                // progressively and one kind's huge initial sync doesn't
                // starve other forwarders sharing this executor.
                tokio::task::yield_now().await;
            }
        }
    });
}

fn resource_event_name(
    cluster_id: &str,
    kind_id: &str,
    scope: &ferrisscope_kube_ext::NsScope,
) -> String {
    // Slashes are fine in Tauri event names; we already use this scheme for pods://.
    // Scope segment lets one (cluster, kind) tuple serve multiple watchers
    // simultaneously (e.g. ResourceTable scoped to `default` and a cluster-
    // overview detail panel wanting all Pods).
    format!(
        "resource://{}/{}/{}",
        sanitize_event_segment(cluster_id),
        sanitize_event_segment(kind_id),
        sanitize_event_segment(&scope.key()),
    )
}

/// Tauri restricts event names to `[A-Za-z0-9_/:-]`. Cluster ids carry the
/// kubeconfig context name verbatim (e.g. `default::yurii.zheliezko@itandtel.cloud`),
/// which can contain `.` / `@` / `+` / etc. Map every disallowed byte to `_`
/// so the event name is always accepted. The frontend mirrors this in
/// `api.ts` so subscribers compute the same string.
///
/// Collisions are theoretically possible (two ids that differ only in
/// disallowed characters sanitize to the same string) but vanishingly rare
/// for real kubeconfigs; accept the tradeoff over more invasive escaping.
pub(crate) fn sanitize_event_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    out
}

/// Fetch the live YAML for a single resource via the dynamic API. Used by
/// the read-only YAML detail panel; the caller can re-invoke this command
/// when the watcher emits an Upsert for the displayed uid.
#[tauri::command]
pub(crate) async fn get_resource_yaml_cmd(
    cluster_id: String,
    kind_id: String,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let entry = state.entry(&cluster_id).await?;
    get_resource_yaml(
        entry.cluster.client(),
        &kind_id,
        namespace.as_deref(),
        &name,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Generate a Tauri detail command that resolves the cluster entry and forwards
/// to the matching `get_<kind>_detail` fetch fn, mapping its `FetchError` to a
/// `String` for the frontend. Three scopes mirror the fetch fns' signatures:
///
/// - `namespaced` → `(cluster_id, namespace, name)` → `inner(client, &namespace, &name)`
/// - `cluster`    → `(cluster_id, name)`            → `inner(client, &name)`
/// - `dynamic`    → `(cluster_id, kind_id, namespace?, name)` → `inner(client, &kind_id, namespace.as_deref(), &name)`
///
/// Command names are spelled out (not synthesized from the inner fn) so they
/// stay greppable: `main.rs`'s `generate_handler!` references each by literal
/// ident, and a reader searching for `get_pod_detail_cmd` must land here. The
/// inner-fn name and command name share a stem by convention — keep them in
/// sync. Wrong scope (arity/type mismatch with the inner fn) and wrong command
/// name (unresolved ident in `generate_handler!`) both fail to compile.
macro_rules! detail_cmd {
    ($(#[$m:meta])* $cmd:ident => $inner:ident, namespaced) => {
        $(#[$m])*
        #[tauri::command]
        pub(crate) async fn $cmd(
            cluster_id: String,
            namespace: String,
            name: String,
            state: State<'_, AppState>,
        ) -> Result<Value, String> {
            let entry = state.entry(&cluster_id).await?;
            $inner(entry.cluster.client(), &namespace, &name)
                .await
                .map_err(|e| e.to_string())
        }
    };
    ($(#[$m:meta])* $cmd:ident => $inner:ident, cluster) => {
        $(#[$m])*
        #[tauri::command]
        pub(crate) async fn $cmd(
            cluster_id: String,
            name: String,
            state: State<'_, AppState>,
        ) -> Result<Value, String> {
            let entry = state.entry(&cluster_id).await?;
            $inner(entry.cluster.client(), &name)
                .await
                .map_err(|e| e.to_string())
        }
    };
    ($(#[$m:meta])* $cmd:ident => $inner:ident, dynamic) => {
        $(#[$m])*
        #[tauri::command]
        pub(crate) async fn $cmd(
            cluster_id: String,
            kind_id: String,
            namespace: Option<String>,
            name: String,
            state: State<'_, AppState>,
        ) -> Result<Value, String> {
            let entry = state.entry(&cluster_id).await?;
            $inner(entry.cluster.client(), &kind_id, namespace.as_deref(), &name)
                .await
                .map_err(|e| e.to_string())
        }
    };
}

detail_cmd! {
    /// Rich pod detail projection used by the summary tab in the detail panel.
    /// Separate from `get_resource_yaml_cmd` so the YAML view can keep using the
    /// dynamic API while the summary view gets a structured shape.
    get_pod_detail_cmd => get_pod_detail, namespaced
}
detail_cmd! { get_deployment_detail_cmd => get_deployment_detail, namespaced }
detail_cmd! { get_replica_set_detail_cmd => get_replica_set_detail, namespaced }
detail_cmd! { get_stateful_set_detail_cmd => get_stateful_set_detail, namespaced }
detail_cmd! { get_daemon_set_detail_cmd => get_daemon_set_detail, namespaced }
detail_cmd! { get_job_detail_cmd => get_job_detail, namespaced }
detail_cmd! { get_cron_job_detail_cmd => get_cron_job_detail, namespaced }
detail_cmd! { get_node_detail_cmd => get_node_detail, cluster }
detail_cmd! { get_namespace_detail_cmd => get_namespace_detail, cluster }
detail_cmd! { get_event_detail_cmd => get_event_detail, namespaced }

/// Events attached to one object, filtered by UID at the apiserver. A
/// namespaced target uses a namespaced Event API so pod detail does not require
/// cluster-wide Event permissions or wait for every namespace to load.
#[tauri::command]
pub(crate) async fn list_object_events_cmd(
    cluster_id: String,
    namespace: Option<String>,
    uid: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let entry = state.entry(&cluster_id).await?;
    list_object_events(entry.cluster.client(), namespace.as_deref(), &uid)
        .await
        .map_err(|e| e.to_string())
}

detail_cmd! { get_service_detail_cmd => get_service_detail, namespaced }
detail_cmd! { get_endpoints_detail_cmd => get_endpoints_detail, namespaced }
detail_cmd! { get_endpoint_slice_detail_cmd => get_endpoint_slice_detail, namespaced }
detail_cmd! { get_ingress_detail_cmd => get_ingress_detail, namespaced }
detail_cmd! { get_ingress_class_detail_cmd => get_ingress_class_detail, cluster }
detail_cmd! { get_network_policy_detail_cmd => get_network_policy_detail, namespaced }
detail_cmd! { get_config_map_detail_cmd => get_config_map_detail, namespaced }
detail_cmd! { get_secret_detail_cmd => get_secret_detail, namespaced }

/// Light "name + keys" projection of every ConfigMap in a namespace, used
/// by the env-ref picker. Issues one apiserver list per call — no caching;
/// the picker is opened on demand and wants fresh data each time.
#[tauri::command]
pub(crate) async fn list_config_maps_in_namespace_cmd(
    cluster_id: String,
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let entry = state.entry(&cluster_id).await?;
    list_config_maps_in_namespace(entry.cluster.client(), &namespace)
        .await
        .map_err(|e| e.to_string())
}

/// Light "name + storage_class + requested_storage" projection of every
/// PVC in a namespace, used by the volume picker. Same on-demand shape as
/// the ConfigMap / Secret variants — no caching.
#[tauri::command]
pub(crate) async fn list_persistent_volume_claims_in_namespace_cmd(
    cluster_id: String,
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let entry = state.entry(&cluster_id).await?;
    list_persistent_volume_claims_in_namespace(entry.cluster.client(), &namespace)
        .await
        .map_err(|e| e.to_string())
}

/// Same shape as `list_config_maps_in_namespace_cmd`, against Secrets. Keys
/// come from `data` only (`string_data` is write-only and never returned by
/// GET). Values are not included.
#[tauri::command]
pub(crate) async fn list_secrets_in_namespace_cmd(
    cluster_id: String,
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let entry = state.entry(&cluster_id).await?;
    list_secrets_in_namespace(entry.cluster.client(), &namespace)
        .await
        .map_err(|e| e.to_string())
}

/// Namespace names in a cluster, sorted. Backs the namespace picker in the
/// new-port-forward form. One-shot — no caching.
#[tauri::command]
pub(crate) async fn list_namespaces_cmd(
    cluster_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let entry = state.entry(&cluster_id).await?;
    list_namespace_names(entry.cluster.client())
        .await
        .map_err(|e| e.to_string())
}

/// Service names + ports in a namespace, used by the port-forward form's
/// Service picker (and remote-port dropdown). One-shot — no caching.
#[tauri::command]
pub(crate) async fn list_services_in_namespace_cmd(
    cluster_id: String,
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let entry = state.entry(&cluster_id).await?;
    list_services_in_namespace(entry.cluster.client(), &namespace)
        .await
        .map_err(|e| e.to_string())
}

detail_cmd! { get_helm_release_detail_cmd => get_helm_release_detail, namespaced }

/// Detail for a single chart row. `source` is `"cluster"` for charts
/// derived from existing helm releases or a repo name for charts from
/// the operator's `helm repo list`.
#[tauri::command]
pub(crate) async fn get_helm_chart_detail_cmd(
    cluster_id: String,
    source: String,
    chart_name: String,
    chart_version: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let entry = state.entry(&cluster_id).await?;
    get_helm_chart_detail(entry.cluster.client(), &source, &chart_name, &chart_version)
        .await
        .map_err(|e| e.to_string())
}

/// Install a new release. `source` switches the chart-resolution path:
/// `cluster` extracts from an existing release secret; a repo name passes
/// `<repo>/<chart>` to helm directly so it pulls from its own cache.
#[tauri::command]
pub(crate) async fn install_helm_chart_cmd(
    cluster_id: String,
    source: String,
    namespace: String,
    release_name: String,
    chart_name: String,
    chart_version: String,
    values_yaml: String,
    state: State<'_, AppState>,
) -> Result<HelmInstallResult, String> {
    let (kubeconfig_path, context_name, scratch) =
        resolve_kubeconfig(&state, &cluster_id, "helm").await?;
    let entry = state.entry(&cluster_id).await?;
    let result = helm_install_chart(
        entry.cluster.client(),
        &context_name,
        Some(&kubeconfig_path),
        &source,
        &namespace,
        &release_name,
        &chart_name,
        &chart_version,
        &values_yaml,
    )
    .await
    .map_err(|e| e.to_string());
    cleanup_scratch_paths(&scratch);
    result
}

/// Run `helm upgrade <release> <chart-from-secret> -n <ns> -f <values>`.
/// `values_yaml` is the operator-edited User values (the `values_user`
/// section of the detail panel). The chart is materialised from the
/// existing release secret on the host filesystem so this works without
/// any helm-repo configuration.
///
/// Resolves the kubeconfig path + context name the same way the PTY does
/// (`resolve_kubeconfig`), so the helm CLI talks to exactly the cluster
/// the operator is currently looking at — not whatever `kubectl
/// current-context` happens to be.
/// Upgrade a release. Optional `chart_source` + `chart_version` switch
/// the chart-resolution path: when both are provided, helm pulls
/// `<source>/<chart-name>` at `<version>` from its repo cache; when
/// either is absent, the existing chart files embedded in the release
/// secret are used (preserve current chart, change values only).
#[tauri::command]
pub(crate) async fn upgrade_helm_release_cmd(
    cluster_id: String,
    namespace: String,
    name: String,
    values_yaml: String,
    chart_source: Option<String>,
    chart_version: Option<String>,
    state: State<'_, AppState>,
) -> Result<HelmUpgradeResult, String> {
    let (kubeconfig_path, context_name, scratch) =
        resolve_kubeconfig(&state, &cluster_id, "helm").await?;
    let entry = state.entry(&cluster_id).await?;
    let override_pair = match (&chart_source, &chart_version) {
        (Some(s), Some(v)) => Some((s.as_str(), v.as_str())),
        _ => None,
    };
    let result = helm_upgrade(
        entry.cluster.client(),
        &context_name,
        Some(&kubeconfig_path),
        &namespace,
        &name,
        &values_yaml,
        override_pair,
    )
    .await
    .map_err(|e| e.to_string());
    cleanup_scratch_paths(&scratch);
    result
}

/// Run `helm repo update`. Best-effort refresh of the operator's local
/// helm repo cache so `update_available` indicators in release details
/// reflect freshly-published versions. Slow (network); the UI shows a
/// spinner. Returns the elapsed time so the toast can confirm work.
#[tauri::command]
pub(crate) async fn helm_repo_update_cmd() -> Result<u64, String> {
    helm_repo_update().await.map_err(|e| e.to_string())
}

detail_cmd! { get_resource_quota_detail_cmd => get_resource_quota_detail, namespaced }
detail_cmd! { get_limit_range_detail_cmd => get_limit_range_detail, namespaced }
detail_cmd! { get_persistent_volume_claim_detail_cmd => get_persistent_volume_claim_detail, namespaced }
detail_cmd! { get_persistent_volume_detail_cmd => get_persistent_volume_detail, cluster }
detail_cmd! { get_storage_class_detail_cmd => get_storage_class_detail, cluster }
detail_cmd! { get_custom_resource_definition_detail_cmd => get_custom_resource_definition_detail, cluster }
detail_cmd! { get_custom_resource_detail_cmd => get_custom_resource_detail, dynamic }
detail_cmd! { get_service_account_detail_cmd => get_service_account_detail, namespaced }
detail_cmd! { get_role_detail_cmd => get_role_detail, namespaced }
detail_cmd! { get_role_binding_detail_cmd => get_role_binding_detail, namespaced }
detail_cmd! { get_cluster_role_detail_cmd => get_cluster_role_detail, cluster }
detail_cmd! { get_cluster_role_binding_detail_cmd => get_cluster_role_binding_detail, cluster }
detail_cmd! { get_horizontal_pod_autoscaler_detail_cmd => get_horizontal_pod_autoscaler_detail, namespaced }
detail_cmd! { get_pod_disruption_budget_detail_cmd => get_pod_disruption_budget_detail, namespaced }
detail_cmd! { get_priority_class_detail_cmd => get_priority_class_detail, cluster }
detail_cmd! { get_replication_controller_detail_cmd => get_replication_controller_detail, namespaced }
detail_cmd! { get_lease_detail_cmd => get_lease_detail, namespaced }
detail_cmd! { get_mutating_webhook_configuration_detail_cmd => get_mutating_webhook_configuration_detail, cluster }
detail_cmd! { get_validating_webhook_configuration_detail_cmd => get_validating_webhook_configuration_detail, cluster }
detail_cmd! {
    /// Detail fetch for any well-known dynamic kind (Gateway API, etc). The
    /// frontend passes the kind's `wkcrd:` id; the backend resolves the
    /// override and returns the rich projection.
    get_well_known_detail_cmd => get_well_known_detail, dynamic
}

/// Trigger a `kubectl rollout restart`-equivalent for the workload owning
/// the named pod. Returns `(owner_kind, owner_name)`.
#[tauri::command]
pub(crate) async fn restart_pod_cmd(
    cluster_id: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(String, String), String> {
    let entry = state.entry(&cluster_id).await?;
    restart_pod_owner(entry.cluster.client(), &namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Trigger a `kubectl rollout restart`-equivalent directly on a workload by
/// kind. Distinct path from SSA `apply_resource_cmd` because rollout-restart
/// must use a JSON merge-patch — SSA on a Deployment with only the annotation
/// set causes the apiserver to null `selector` / `containers` (which are
/// immutable / required, so it rejects with 422).
#[tauri::command]
pub(crate) async fn restart_workload_cmd(
    cluster_id: String,
    kind: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entry = state.entry(&cluster_id).await?;
    restart_workload(entry.cluster.client(), &kind, &namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Bulk rollout restart. Walks each pod's owner, dedupes by workload, and
/// patches each unique workload exactly once with a single shared timestamp.
/// Three pods owned by the same Deployment → one rollout, not three.
#[tauri::command]
pub(crate) async fn restart_pods_cmd(
    cluster_id: String,
    pods: Vec<(String, String)>,
    state: State<'_, AppState>,
) -> Result<RestartPodsReport, String> {
    let entry = state.entry(&cluster_id).await?;
    restart_pods_owners(entry.cluster.client(), pods)
        .await
        .map_err(|e| e.to_string())
}

/// Server-Side Apply with field manager `ferrisscope`. The frontend sends
/// only the field tree it owns; SSA tracks ownership server-side so two
/// successive applies merge cleanly with the existing object.
///
/// `force = false` (default) returns `ApplyResult::Conflict` when another
/// manager owns a field we tried to write — the UI surfaces a confirm step
/// and re-invokes with `force = true` if the operator agrees to take over.
#[tauri::command]
pub(crate) async fn apply_resource_cmd(
    cluster_id: String,
    kind_id: String,
    namespace: Option<String>,
    name: String,
    fields: Value,
    force: bool,
    state: State<'_, AppState>,
) -> Result<ApplyResult, String> {
    let entry = state.entry(&cluster_id).await?;
    apply_resource(
        entry.cluster.client(),
        &kind_id,
        namespace.as_deref(),
        &name,
        fields,
        force,
    )
    .await
    .map_err(|e| e.to_string())
}

/// `kubectl edit`-style save for the YAML manifest tab. Applies an RFC 7386
/// JSON merge patch (adds + edits + `null` deletions). Distinct from
/// `apply_resource_cmd` (SSA): the free-form manifest editor wants explicit
/// deletions and last-write-wins rather than per-field ownership tracking.
///
/// `resource_version = Some(rv)` enforces optimistic concurrency (returns
/// `MergePatchResult::Stale` on a 409 if the object moved on); `None` is the
/// UI's explicit "apply anyway" overwrite.
#[tauri::command]
pub(crate) async fn merge_patch_resource_cmd(
    cluster_id: String,
    kind_id: String,
    namespace: Option<String>,
    name: String,
    patch: Value,
    resource_version: Option<String>,
    state: State<'_, AppState>,
) -> Result<MergePatchResult, String> {
    let entry = state.entry(&cluster_id).await?;
    merge_patch_resource(
        entry.cluster.client(),
        &kind_id,
        namespace.as_deref(),
        &name,
        patch,
        resource_version.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Delete a single resource. `grace_period_seconds = Some(0)` is a force
/// delete; `None` uses the kind's default. The reflector observes the
/// removal and emits a Delete delta on its own — the UI does not need to
/// optimistically update.
///
/// Synthetic kinds get bespoke handling:
///   * `helm_releases` → `helm uninstall <release> -n <ns>`. Going
///     through helm cleans up BOTH the rendered K8s resources and the
///     release secrets. A raw secret-delete would leak the workloads.
///   * `helm_charts` → rejected. A chart row is a synthetic catalog
///     entry, not a single object — there's nothing to delete. To remove
///     a chart from the catalog the operator uninstalls the underlying
///     releases.
#[tauri::command]
pub(crate) async fn delete_resource_cmd(
    cluster_id: String,
    kind_id: String,
    namespace: Option<String>,
    name: String,
    grace_period_seconds: Option<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if kind_id == "helm_charts" {
        return Err(
            "Charts can't be deleted directly. Uninstall the releases that use this chart instead."
                .to_owned(),
        );
    }
    if kind_id == "helm_releases" {
        let ns = namespace
            .as_deref()
            .ok_or_else(|| "helm release requires a namespace".to_owned())?;
        let (kubeconfig_path, context_name, scratch) =
            resolve_kubeconfig(&state, &cluster_id, "helm").await?;
        let result = helm_uninstall(&context_name, Some(&kubeconfig_path), ns, &name)
            .await
            .map_err(|e| e.to_string());
        cleanup_scratch_paths(&scratch);
        return result;
    }
    let entry = state.entry(&cluster_id).await?;
    delete_resource(
        entry.cluster.client(),
        &kind_id,
        namespace.as_deref(),
        &name,
        grace_period_seconds,
    )
    .await
    .map_err(|e| e.to_string())
}

// ---- Node operations ------------------------------------------------------

/// Cordon (`cordon=true`) or uncordon (`cordon=false`) a node by SSA-patching
/// `spec.unschedulable`. Returns once the apiserver has accepted the patch;
/// the watcher will surface the new phase asynchronously.
#[tauri::command]
pub(crate) async fn cordon_node_cmd(
    cluster_id: String,
    name: String,
    cordon: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entry = state.entry(&cluster_id).await?;
    set_node_cordon(entry.cluster.client(), &name, cordon)
        .await
        .map_err(|e| e.to_string())
}

/// Cordon then evict every pod scheduled on the node. DaemonSet-managed and
/// mirror pods are always skipped; bare pods are skipped unless `force=true`.
/// Eviction respects PDBs server-side, so PDB blocks surface as per-pod
/// failures in the report rather than aborting the whole drain.
#[tauri::command]
pub(crate) async fn drain_node_cmd(
    cluster_id: String,
    name: String,
    force: bool,
    state: State<'_, AppState>,
) -> Result<DrainReport, String> {
    let entry = state.entry(&cluster_id).await?;
    drain_node(entry.cluster.client(), &name, force)
        .await
        .map_err(|e| e.to_string())
}

/// Pods currently scheduled on `node`. Same row shape the pod table watcher
/// emits — the frontend can render it with the existing pod row component.
#[tauri::command]
pub(crate) async fn list_pods_on_node_cmd(
    cluster_id: String,
    node: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let entry = state.entry(&cluster_id).await?;
    list_pods_on_node(entry.cluster.client(), &node)
        .await
        .map_err(|e| e.to_string())
}

/// Gracefully evict a single pod via the policy/v1 Eviction subresource
/// (PDB-aware). A blocked eviction (429) surfaces as the apiserver's own
/// disruption-budget message so the frontend can toast it verbatim.
#[tauri::command]
pub(crate) async fn evict_pod_cmd(
    cluster_id: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entry = state.entry(&cluster_id).await?;
    evict_pod(entry.cluster.client(), &namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

// ---- Logs (Pod-specific) -------------------------------------------------

static STREAM_COUNTER: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub(crate) async fn start_log_stream(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    // When true, stream the previously-terminated container instance instead
    // of the live one (crash diagnosis — see issue #63). One-shot, no follow.
    previous: bool,
    // First-open live tail: `Some(n)` = last n lines, `None` = whole available
    // history. Ignored on the `previous` path (always dumped in full).
    tail_lines: Option<i64>,
    on_event: tauri::ipc::Channel<LogEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let entry = state.entry(&cluster_id).await?;
    let stream = LogStream::start(
        entry.cluster.client(),
        &namespace,
        &pod,
        container.as_deref(),
        previous,
        tail_lines,
    )
    .map_err(|e| e.to_string())?;

    let id = format!("s{}", STREAM_COUNTER.fetch_add(1, Ordering::Relaxed));
    spawn_log_forwarder(on_event, id.clone(), stream.clone());
    state
        .insert_log_stream(id.clone(), cluster_id, stream)
        .await;
    Ok(id)
}

#[tauri::command]
pub(crate) async fn stop_log_stream(
    stream_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.remove_log_stream(&stream_id).await;
    Ok(())
}

/// Expand a mixed pod/workload selection into the concrete pods the
/// aggregated logs/metrics panel should observe. One call per cluster — the
/// frontend groups its selection by `clusterId` and merges the results.
#[tauri::command]
pub(crate) async fn resolve_log_pods_cmd(
    cluster_id: String,
    targets: Vec<ferrisscope_kube_ext::LogPodTarget>,
    state: State<'_, AppState>,
) -> Result<ferrisscope_kube_ext::ResolvedLogPods, String> {
    let entry = state.entry(&cluster_id).await?;
    Ok(ferrisscope_kube_ext::resolve_log_pods(entry.cluster.client(), &targets).await)
}

/// Write `contents` to `path`. Used by the log panel's "Download" action —
/// the path always comes from the OS save dialog, so it's user-chosen.
#[tauri::command]
pub(crate) async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("write {path}: {e}"))
}

/// Maximum lines to coalesce into a single `LogEvent::Batch` frame.
/// Caps allocation + IPC payload size; on a noisy pod we expect to hit
/// this rather than the time-bound.
const LOG_BATCH_MAX: usize = 64;

/// Forward log events directly over a `tauri::ipc::Channel` rather than the
/// global event bus. Channels are typed, skip the listener fan-out, and avoid
/// the `format!("logs://{id}")` string-keyed dispatch — measurably cheaper for
/// the highest-bandwidth surface in the app. The frontend supplies the
/// `Channel<LogEvent>` at `start_log_stream` time; we send into it until the
/// stream ends or the channel reports a send error (frontend dropped).
///
/// Consecutive `Line` events get coalesced into a `Batch` frame whenever the
/// broadcast queue has backlog. The initial 200-line tail burst would
/// otherwise hit the JS main thread as 200 separate JSON-parse + dispatch
/// hops; batching pulls that down to ~3-4 frames and unfreezes the panel
/// on open of a chatty pod.
fn spawn_log_forwarder(
    channel: tauri::ipc::Channel<LogEvent>,
    stream_id: String,
    stream: Arc<LogStream>,
) {
    let mut rx = stream.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            // Block on the first event. Most of the time on a quiet stream
            // we send exactly one Line and loop back here immediately.
            let first = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    if channel.send(LogEvent::Lagged { dropped: n }).is_err() {
                        return;
                    }
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(?stream_id, "log forwarder exiting (broadcast closed)");
                    return;
                }
            };

            // Hot path: first event is a Line. Try to drain any backlog
            // (synchronously, no await) and ship as one Batch frame.
            if let LogEvent::Line { text } = first {
                let mut lines: Vec<String> = Vec::with_capacity(8);
                lines.push(text);
                let mut trailing: Option<LogEvent> = None;
                while lines.len() < LOG_BATCH_MAX {
                    match rx.try_recv() {
                        Ok(LogEvent::Line { text }) => lines.push(text),
                        Ok(other) => {
                            trailing = Some(other);
                            break;
                        }
                        Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                        Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                            trailing = Some(LogEvent::Lagged { dropped: n });
                            break;
                        }
                        Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                            // Flush what we have, then exit after the loop.
                            trailing = Some(LogEvent::Ended {
                                reason: "stream closed".to_owned(),
                            });
                            break;
                        }
                    }
                }
                let payload = if lines.len() == 1 {
                    LogEvent::Line {
                        text: lines.pop().expect("len==1"),
                    }
                } else {
                    LogEvent::Batch { lines }
                };
                if channel.send(payload).is_err() {
                    tracing::warn!(
                        ?stream_id,
                        "log forwarder exiting (channel send failed; frontend likely dropped)"
                    );
                    return;
                }
                if let Some(t) = trailing {
                    let is_end = matches!(&t, LogEvent::Ended { .. });
                    if channel.send(t).is_err() {
                        return;
                    }
                    if is_end {
                        return;
                    }
                }
            } else {
                // Non-Line first event: ship as-is.
                let is_end = matches!(&first, LogEvent::Ended { .. });
                if let Err(e) = channel.send(first) {
                    tracing::warn!(
                        error = %e,
                        ?stream_id,
                        "log forwarder exiting (channel send failed; frontend likely dropped)"
                    );
                    return;
                }
                if is_end {
                    return;
                }
            }
        }
    });
}

/// Start a live watch over a workload's pods for the logs panel. Returns a
/// watch id; pod add/remove deltas (and an initial `InitDone`) arrive on
/// `on_event`. Single-pod targets are not watched here — the frontend resolves
/// those with the one-shot `resolve_log_pods` fast path, so this rejects them
/// (and other non-workload kinds) via `start_log_pod_watch`.
#[tauri::command]
pub(crate) async fn watch_log_pods(
    cluster_id: String,
    target: ferrisscope_kube_ext::LogPodTarget,
    on_event: tauri::ipc::Channel<ferrisscope_kube_ext::LogPodEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let entry = state.entry(&cluster_id).await?;
    // Use a watcher-pool client: this is a long-lived watch, not a one-shot
    // call, so it should share the pool that carries the resource reflectors
    // (and now inherits their TCP keepalive).
    let watch = ferrisscope_kube_ext::start_log_pod_watch(entry.cluster.watcher_client(), &target)
        .await
        .map_err(|e| e.to_string())?;
    let id = format!("lpw{}", STREAM_COUNTER.fetch_add(1, Ordering::Relaxed));
    spawn_log_pod_forwarder(on_event, id.clone(), watch.clone());
    state
        .insert_log_pod_watch(id.clone(), cluster_id, watch)
        .await;
    Ok(id)
}

#[tauri::command]
pub(crate) async fn unwatch_log_pods(
    watch_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Dropping the Arc aborts the watch task (LogPodWatch::Drop).
    state.remove_log_pod_watch(&watch_id).await;
    Ok(())
}

/// Bridge a [`ferrisscope_kube_ext::LogPodWatch`] broadcast to the frontend
/// channel. Exits when the frontend drops the channel or the watch is torn
/// down. No batching: pod-set churn is low-frequency.
fn spawn_log_pod_forwarder(
    channel: tauri::ipc::Channel<ferrisscope_kube_ext::LogPodEvent>,
    watch_id: String,
    watch: Arc<ferrisscope_kube_ext::LogPodWatch>,
) {
    let mut rx = watch.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if channel.send(ev).is_err() {
                        tracing::debug!(
                            ?watch_id,
                            "log pod forwarder exiting (channel send failed; frontend dropped)"
                        );
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // Pod-set deltas aren't idempotent snapshots, but a 256-slot
                    // ring vs. seconds-apart pod churn makes overrun practically
                    // impossible; the next watcher relist re-syncs the set if it
                    // ever happens. Log and keep going.
                    tracing::warn!(?watch_id, dropped = n, "log pod forwarder lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(?watch_id, "log pod forwarder exiting (watch closed)");
                    return;
                }
            }
        }
    });
}

// ---- Metrics (cluster + per-pod via metrics-server) -----------------------

/// Subscribe to metrics-server snapshots for `cluster_id`.
///
/// Increments the metrics slot refcount; starts the polling service on the
/// first subscribe. Returns the cached snapshot if one exists so the UI can
/// render immediately. Future snapshots arrive over `metrics://{cluster_id}`.
#[tauri::command]
pub(crate) async fn subscribe_metrics(
    cluster_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<MetricsSnapshot>, String> {
    let entry = state.entry(&cluster_id).await?;
    wire_cluster_health(&app, &cluster_id, entry.clone());
    if entry.unavailable.load(Ordering::SeqCst) {
        return Err(format!(
            "cluster {cluster_id} is unavailable — reconnect first"
        ));
    }
    let mut slot = entry.metrics.lock().await;
    let svc = if let Some(s) = &slot.service {
        s.clone()
    } else {
        let s = MetricsService::start(entry.cluster.client());
        let handle = spawn_metrics_forwarder(app.clone(), cluster_id.clone(), s.clone());
        // Stash handle on the entry so teardown can abort it. Replace
        // any stale handle (shouldn't exist because we only spawn when
        // service was None, but be defensive — a stray handle would
        // pin the next service via JoinHandle ↔ task captures).
        if let Some(old) = entry.metrics_forwarder.lock_recover().replace(handle) {
            old.abort();
        }
        slot.service = Some(s.clone());
        s
    };
    slot.subscribers += 1;
    // Unwrap the Arc shape into the wire type. The Arc only lives between
    // the service and its subscribers; the Tauri boundary needs an owned
    // value to serialise.
    Ok(svc.snapshot().await.map(|a| (*a).clone()))
}

#[tauri::command]
pub(crate) async fn unsubscribe_metrics(
    cluster_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Non-creating lookup — see `unsubscribe_resource` for rationale.
    let Some(entry) = state.get_existing(&cluster_id).await else {
        return Ok(());
    };
    let mut slot = entry.metrics.lock().await;
    slot.subscribers = slot.subscribers.saturating_sub(1);
    if slot.subscribers == 0 {
        // Dropping the Arc aborts the polling task via MetricsService::Drop —
        // but only once the *forwarder* releases its clone too. Abort it
        // first so the chain unwinds: forwarder dies → its Arc drops →
        // entry's Arc drops next → MetricsService::Drop runs → poll task
        // aborts. Without this we'd leak the poll task + metrics-server
        // HTTP keepalive for the rest of the cluster's session.
        if let Some(h) = entry.metrics_forwarder.lock_recover().take() {
            h.abort();
        }
        slot.service.take();
    }
    Ok(())
}

// ---- Fleet probes (per-cluster summary cards) -----------------------------

#[tauri::command]
pub(crate) async fn get_fleet_cache(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, ClusterProbe>, String> {
    let fleet = state.fleet.clone();
    let mut g = fleet.lock().await;
    if !g.loaded {
        g.map = fleet::load_cache().await;
        g.loaded = true;
    }
    Ok(g.map.clone())
}

/// Refresh probes for the given contexts. By default only stale entries
/// (older than [`fleet::STALE_AFTER_MS`]) are re-probed; pass `force=true` to
/// re-probe everything. Probes run in the background — each completion
/// emits `fleet://probe`. The command itself returns immediately.
#[tauri::command]
pub(crate) async fn refresh_fleet(
    contexts: Vec<String>,
    force: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let fleet = state.fleet.clone();
    {
        let mut g = fleet.lock().await;
        if !g.loaded {
            g.map = fleet::load_cache().await;
            g.loaded = true;
        }
    }

    for ctx in contexts {
        let stale = {
            let g = fleet.lock().await;
            if g.in_flight.contains(&ctx) {
                continue;
            }
            match g.map.get(&ctx) {
                Some(p) => force || fleet::is_stale(p),
                None => true,
            }
        };
        if !stale {
            continue;
        }
        {
            let mut g = fleet.lock().await;
            g.in_flight.insert(ctx.clone());
        }

        let (source_path, ssh_probe): (Option<PathBuf>, Option<fleet::ProbeSsh>) = {
            let s = state.sources.lock().await;
            if let Some((source_id, cfg)) = kubeconfig::ssh_for(&ctx, &s) {
                (None, Some(fleet::ProbeSsh { source_id, cfg }))
            } else {
                (kubeconfig::source_path_for(&ctx, &s), None)
            }
        };
        let context_name = kubeconfig::context_name_from_id(&ctx).to_owned();
        let app_clone = app.clone();
        let fleet_clone = fleet.clone();
        tauri::async_runtime::spawn(async move {
            // The probe stores its result under `context_name` for cache
            // continuity; we override it to the composite id so the UI map
            // can look it up by what it actually passed.
            let mut probe =
                fleet::probe(&context_name, source_path.as_deref(), ssh_probe.as_ref()).await;
            probe.context_name = ctx.clone();
            let mut g = fleet_clone.lock().await;
            g.in_flight.remove(&ctx);
            // Only overwrite the existing entry if the probe actually
            // landed on something. A failed probe leaves the cached values
            // alone but updates `healthy` / `last_error` so the UI can
            // show a stale-looking card.
            let stored = if probe.healthy == Some(true) {
                g.map.insert(ctx.clone(), probe.clone());
                probe
            } else if let Some(existing) = g.map.get_mut(&ctx) {
                existing.healthy = probe.healthy;
                existing.last_error = probe.last_error.clone();
                existing.fetched_at_unix_ms = probe.fetched_at_unix_ms;
                existing.clone()
            } else {
                g.map.insert(ctx.clone(), probe.clone());
                probe
            };
            let snapshot = g.map.clone();
            drop(g);
            fleet::save_cache(&snapshot).await;
            if let Err(e) = app_clone.emit("fleet://probe", &stored) {
                tracing::warn!(error = %e, "failed to emit fleet probe");
            }
        });
    }

    Ok(())
}

// ---- Kubeconfig sources ---------------------------------------------------

#[derive(Debug, Serialize)]
pub(crate) struct KubeconfigSettings {
    pub(crate) default_disabled: bool,
    pub(crate) last_picked_dir: Option<PathBuf>,
    pub(crate) sources: Vec<KubeconfigSource>,
}

#[tauri::command]
pub(crate) async fn list_kubeconfig_sources(
    state: State<'_, AppState>,
) -> Result<KubeconfigSettings, String> {
    let s = state.sources.lock().await;
    Ok(KubeconfigSettings {
        default_disabled: s.default_disabled,
        last_picked_dir: s.last_picked_dir.clone(),
        sources: s.sources.clone(),
    })
}

#[tauri::command]
pub(crate) async fn add_kubeconfig_source(
    path: PathBuf,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<KubeconfigSource, String> {
    let new = sources::new_source(&path).map_err(|e| e.to_string())?;
    {
        let mut s = state.sources.lock().await;
        // Refuse duplicates by exact path.
        if s.sources.iter().any(|x| x.path == new.path) {
            return Err(format!("source already added: {}", new.path.display()));
        }
        // Remember the parent directory for the next "Add" dialog.
        let parent_for_dialog = if new.path.is_dir() {
            Some(new.path.clone())
        } else {
            new.path.parent().map(std::path::Path::to_path_buf)
        };
        if let Some(p) = parent_for_dialog {
            s.last_picked_dir = Some(p);
        }
        s.sources.push(new.clone());
        sources::save(&s).await.map_err(|e| e.to_string())?;
    }
    reconfigure_and_notify(&app, &state).await;
    Ok(new)
}

#[tauri::command]
pub(crate) async fn remove_kubeconfig_source(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut s = state.sources.lock().await;
        s.sources.retain(|x| x.id != id);
        sources::save(&s).await.map_err(|e| e.to_string())?;
    }
    // Clean up SSH-source side state: keychain entries + cached kubeconfig.
    // Cheap, harmless to call for non-SSH sources (the keychain accounts
    // simply don't exist).
    sources::delete_source_secrets(&id);
    kubeconfig::forget_ssh_cache(&id);
    reconfigure_and_notify(&app, &state).await;
    Ok(())
}

#[derive(Debug, Default, serde::Deserialize)]
pub(crate) struct SourcePatch {
    // Tri-state on purpose (JSON Merge Patch semantics): absent = don't
    // touch, `null` = clear the override, `"value"` = set to that string.
    #[serde(default)]
    #[allow(clippy::option_option)]
    pub(crate) group_override: Option<Option<String>>,
    #[serde(default)]
    pub(crate) enabled: Option<bool>,
}

#[tauri::command]
pub(crate) async fn update_kubeconfig_source(
    id: String,
    patch: SourcePatch,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<KubeconfigSource, String> {
    let updated = {
        let mut s = state.sources.lock().await;
        let src = s
            .sources
            .iter_mut()
            .find(|x| x.id == id)
            .ok_or_else(|| format!("source not found: {id}"))?;
        if let Some(group) = patch.group_override {
            // Treat empty string as "clear override".
            src.group_override = group.filter(|g| !g.trim().is_empty());
        }
        if let Some(enabled) = patch.enabled {
            src.enabled = enabled;
        }
        let updated = src.clone();
        sources::save(&s).await.map_err(|e| e.to_string())?;
        updated
    };
    reconfigure_and_notify(&app, &state).await;
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn set_default_kubeconfig_disabled(
    disabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut s = state.sources.lock().await;
        s.default_disabled = disabled;
        sources::save(&s).await.map_err(|e| e.to_string())?;
    }
    reconfigure_and_notify(&app, &state).await;
    Ok(())
}

/// Delete a single context entry (and its dangling cluster / user references)
/// from the kubeconfig file backing `cluster_id`. Operates on default and
/// custom files alike. Errors when removing this context would empty the
/// file — the caller is expected to offer the file-delete path instead.
#[tauri::command]
pub(crate) async fn delete_kubeconfig_context(
    cluster_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let context_name = kubeconfig::context_name_from_id(&cluster_id).to_owned();
    let path = {
        let s = state.sources.lock().await;
        kubeconfig::resolve_path_for(&cluster_id, &s)
    }
    .ok_or_else(|| "no kubeconfig file resolvable for this context".to_owned())?;
    tokio::task::spawn_blocking(move || kubeconfig::delete_context_in_file(&path, &context_name))
        .await
        .map_err(|e| format!("rewrite task failed: {e}"))?
        .map_err(|e| e.to_string())?;
    // Cluster is gone for good — drop its in-memory handle and delete the
    // search-index file. Best-effort; deletion failure shouldn't block the
    // kubeconfig operation that already succeeded.
    let _ = state.remove_search_index(&cluster_id).await;
    if let Err(e) = ferrisscope_core::search::SearchIndex::drop_files(&cluster_id) {
        tracing::warn!(
            error = %e,
            cluster_id = %cluster_id,
            "search index: drop_files failed during context delete"
        );
    }
    reconfigure_and_notify(&app, &state).await;
    Ok(())
}

/// Set `current-context:` in the kubeconfig file backing `cluster_id`. Only
/// meaningful for the default kubeconfig — `kubectl use-context` reads it from
/// there. Custom-file contexts can call this too; it just edits *their* file.
#[tauri::command]
pub(crate) async fn set_current_kubeconfig_context(
    cluster_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let context_name = kubeconfig::context_name_from_id(&cluster_id).to_owned();
    let path = {
        let s = state.sources.lock().await;
        kubeconfig::resolve_path_for(&cluster_id, &s)
    }
    .ok_or_else(|| "no kubeconfig file resolvable for this context".to_owned())?;
    tokio::task::spawn_blocking(move || {
        kubeconfig::set_current_context_in_file(&path, &context_name)
    })
    .await
    .map_err(|e| format!("rewrite task failed: {e}"))?
    .map_err(|e| e.to_string())?;
    reconfigure_and_notify(&app, &state).await;
    Ok(())
}

/// Delete an entire custom kubeconfig file from disk. Refuses to touch the
/// default kubeconfig (operator should remove that via the OS / kubectl, not
/// us). When the file is the sole content of a single-file source, the
/// matching `KubeconfigSource` entry is also removed; folder-source files just
/// get unlinked and the next scan won't see them.
#[tauri::command]
pub(crate) async fn delete_kubeconfig_file(
    cluster_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (source_id, _) = cluster_id
        .split_once("::")
        .ok_or_else(|| format!("malformed cluster id: {cluster_id}"))?;
    if source_id == kubeconfig::DEFAULT_SOURCE_ID {
        return Err("Refusing to delete the default kubeconfig file.".to_owned());
    }
    let path = {
        let s = state.sources.lock().await;
        kubeconfig::source_path_for(&cluster_id, &s)
    }
    .ok_or_else(|| "no kubeconfig file resolvable for this context".to_owned())?;

    {
        let path = path.clone();
        tokio::task::spawn_blocking(move || std::fs::remove_file(&path))
            .await
            .map_err(|e| format!("delete task failed: {e}"))?
            .map_err(|e| e.to_string())?;
    }

    // If this was a single-file source (id has no `/<filename>` suffix), drop
    // the source entry too — keeping it would surface a permanent "file
    // missing" warn line. Folder-source children stay; the watcher rescan
    // will simply not list them.
    if !source_id.contains('/') {
        let mut s = state.sources.lock().await;
        s.sources.retain(|x| x.id != source_id);
        sources::save(&s).await.map_err(|e| e.to_string())?;
    }

    reconfigure_and_notify(&app, &state).await;
    Ok(())
}

// ---- SSH kubeconfig sources -----------------------------------------------
//
// SSH sources are persisted next to file/folder ones in `sources.json`. The
// extra surface here is the *secret* side: passwords and key passphrases are
// written to the OS keychain via the `keyring` crate before the source row
// is saved, and deleted on remove. The ssh.rs module reads them back during
// `Cluster::connect_ssh` keyed by the source uuid.
//
// The "test connection" flow is exposed separately so the operator can verify
// the host is reachable + the kubeconfig is parseable before committing the
// source row to the fleet view.

/// Inputs for adding / testing an SSH source. Mirrors `SshSourceConfig` but
/// carries the secrets inline so we can stash them in the keychain.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct SshSourceInput {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) auth: SshAuthInput,
    /// Optional override; `None` means auto-detect the remote kubeconfig path.
    pub(crate) remote_kubeconfig: Option<String>,
    pub(crate) group_override: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum SshAuthInput {
    Password {
        password: String,
    },
    PrivateKey {
        path: PathBuf,
        passphrase: Option<String>,
    },
    Agent,
    /// Try the standard private-key locations under `~/.ssh/`. Encrypted
    /// keys without a known passphrase get skipped — fall back to `Agent`
    /// or explicit `PrivateKey` for those.
    DefaultKeys,
}

impl SshSourceInput {
    /// Validate the inputs, returning a clean error before we touch the
    /// keychain. The cheaper checks live up front so we don't leak partial
    /// state on a typo. `require_secrets` is true for add (where an empty
    /// password is meaningless) and false for edit (where empty means
    /// "keep the existing keychain entry").
    fn validate(&self, require_secrets: bool) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("host must not be empty".to_owned());
        }
        if self.user.trim().is_empty() {
            return Err("user must not be empty".to_owned());
        }
        if self.port == 0 {
            return Err("port must be > 0".to_owned());
        }
        if let SshAuthInput::PrivateKey { path, .. } = &self.auth {
            if !path.exists() {
                return Err(format!("private key not found: {}", path.display()));
            }
        }
        if require_secrets {
            if let SshAuthInput::Password { password } = &self.auth {
                if password.is_empty() {
                    return Err("password is required".to_owned());
                }
            }
        }
        Ok(())
    }
}

/// Result of the test-connection flow. Surfaced verbatim to the UI so the
/// operator sees the detected kubeconfig path + every importable context.
#[derive(Debug, Serialize)]
pub(crate) struct SshTestResult {
    pub(crate) detected_path: String,
    pub(crate) contexts: Vec<String>,
    /// Captured fingerprint (TOFU). Will be persisted on the source the next
    /// time the operator hits Save (or, for `add_kubeconfig_ssh_source`, is
    /// already on the saved record).
    pub(crate) fingerprint: Option<String>,
}

/// Persist secrets under the keychain accounts associated with `source_id`.
/// Idempotent — re-saving an existing source overwrites prior entries
/// instead of leaking new ones.
///
/// Empty / `None` password and passphrase strings are skipped, **not** written
/// as empty entries. This is what makes edit mode safe: the operator can
/// leave the password field blank and the existing keychain secret is kept.
/// Add mode is responsible for refusing empty inputs upfront via `validate`.
fn write_ssh_secrets(source_id: &str, auth: &SshAuthInput) -> Result<(), String> {
    match auth {
        SshAuthInput::Password { password } if !password.is_empty() => {
            ssh_keychain::write_keychain_secret(&keyring_account_password(source_id), password)
                .map_err(|e| e.to_string())?;
        }
        SshAuthInput::PrivateKey {
            passphrase: Some(p),
            ..
        } if !p.is_empty() => {
            ssh_keychain::write_keychain_secret(&keyring_account_key_passphrase(source_id), p)
                .map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(())
}

fn ssh_auth_from_input(auth: &SshAuthInput) -> SshAuth {
    match auth {
        SshAuthInput::Password { .. } => SshAuth::Password,
        SshAuthInput::PrivateKey { path, passphrase } => SshAuth::PrivateKey {
            path: path.clone(),
            has_passphrase: passphrase.as_deref().is_some_and(|s| !s.is_empty()),
        },
        SshAuthInput::Agent => SshAuth::Agent,
        SshAuthInput::DefaultKeys => SshAuth::DefaultKeys,
    }
}

/// Open a one-shot SSH session, fetch the kubeconfig, list its contexts, and
/// tear down. Used by the UI's "Test connection" button before the operator
/// commits the source. Does NOT persist anything.
#[tauri::command]
pub(crate) async fn test_ssh_kubeconfig_source(
    input: SshSourceInput,
) -> Result<SshTestResult, String> {
    // `test` is invoked from add and edit. In edit mode the modal can leave
    // the password field blank ("keep current"); we don't have access to the
    // existing source here so we accept an empty password and let the SSH
    // handshake fail with a clean message if no secret is on file.
    input.validate(false)?;

    // Use a throwaway uuid for the keychain stash — the real source id only
    // exists after Save. We clean up the temp keychain entries unconditionally
    // at the end so this doesn't leave orphans.
    let temp_id = format!("test-{}", uuid::Uuid::new_v4());
    write_ssh_secrets(&temp_id, &input.auth)?;

    let cfg = SshSourceConfig {
        host: input.host.clone(),
        port: input.port,
        user: input.user.clone(),
        auth: ssh_auth_from_input(&input.auth),
        remote_kubeconfig: input.remote_kubeconfig.clone(),
        known_host_fingerprint: None,
    };

    let outcome = test_inner(&cfg, &temp_id).await;
    sources::delete_source_secrets(&temp_id);
    outcome.map_err(|e| e.to_string())
}

async fn test_inner(
    cfg: &SshSourceConfig,
    source_id: &str,
) -> ferrisscope_core::Result<SshTestResult> {
    let session = ferrisscope_core::ssh::SshSession::connect(cfg, source_id).await?;
    let detected_path = match cfg.remote_kubeconfig.as_deref() {
        Some(p) if !p.trim().is_empty() => p.trim().to_owned(),
        _ => session.detect_kubeconfig_path().await?,
    };
    let bytes = session.read_file(&detected_path).await?;
    let fingerprint = session.captured_fingerprint().await;
    session.disconnect().await;

    let kc: kube::config::Kubeconfig = serde_yaml::from_slice(&bytes)?;
    let contexts: Vec<String> = kc.contexts.iter().map(|c| c.name.clone()).collect();
    Ok(SshTestResult {
        detected_path,
        contexts,
        fingerprint,
    })
}

#[tauri::command]
pub(crate) async fn add_kubeconfig_ssh_source(
    input: SshSourceInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<KubeconfigSource, String> {
    input.validate(true)?;

    // Pre-bake the eventual source. We need its id to key the keychain
    // entries, and we want to test-connect once *before* persisting so a
    // bad credential / unreachable host doesn't leave a stuck row.
    let auth_kind = ssh_auth_from_input(&input.auth);
    let cfg = SshSourceConfig {
        host: input.host.trim().to_owned(),
        port: input.port,
        user: input.user.trim().to_owned(),
        auth: auth_kind,
        remote_kubeconfig: input
            .remote_kubeconfig
            .as_ref()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
        known_host_fingerprint: None,
    };
    let source = sources::new_ssh_source(cfg);
    let source_id = source.id.clone();

    // Stash secrets keyed by the real source id, then run the same test as
    // the standalone `test_ssh_kubeconfig_source` to verify and capture the
    // fingerprint. If anything fails, drop the secrets so the OS keychain
    // doesn't accumulate dead entries from failed adds.
    if let Err(e) = write_ssh_secrets(&source_id, &input.auth) {
        sources::delete_source_secrets(&source_id);
        return Err(e);
    }
    let test = match test_inner(
        source
            .ssh
            .as_ref()
            .expect("new_ssh_source produced an Ssh kind"),
        &source_id,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            sources::delete_source_secrets(&source_id);
            return Err(e.to_string());
        }
    };

    // Pin the captured fingerprint + apply the optional group override now
    // that we know the source is good.
    let mut source = source;
    if let Some(ssh) = source.ssh.as_mut() {
        ssh.known_host_fingerprint.clone_from(&test.fingerprint);
    }
    if let Some(g) = input.group_override.as_ref().map(|s| s.trim().to_owned()) {
        if !g.is_empty() {
            source.group_override = Some(g);
        }
    }

    {
        let mut s = state.sources.lock().await;
        // Refuse exact (host, port, user) duplicates. We don't dedupe on host
        // alone — the same machine reached via two users / ports is two
        // distinct sources from the operator's perspective.
        let new_ssh = source
            .ssh
            .as_ref()
            .ok_or_else(|| "internal: ssh cfg missing".to_owned())?;
        if s.sources.iter().any(|x| {
            x.ssh.as_ref().is_some_and(|cfg| {
                cfg.host == new_ssh.host && cfg.port == new_ssh.port && cfg.user == new_ssh.user
            })
        }) {
            sources::delete_source_secrets(&source_id);
            return Err(format!(
                "an SSH source for {} already exists",
                source.path.display()
            ));
        }
        s.sources.push(source.clone());
        sources::save(&s).await.map_err(|e| e.to_string())?;
    }

    // Refetch + cache the kubeconfig under the real source id (we discarded
    // the test-connection one). Done in the background so the UI returns
    // promptly; the listing path will pick it up on the next call.
    let cfg_for_bg = source.ssh.clone().expect("ssh cfg present");
    let id_for_bg = source_id.clone();
    tauri::async_runtime::spawn(async move {
        match kubeconfig::fetch_ssh_kubeconfig(&id_for_bg, &cfg_for_bg).await {
            Ok(kc) => kubeconfig::cache_ssh_kubeconfig(&id_for_bg, kc),
            Err(e) => {
                tracing::warn!(source_id = %id_for_bg, error = %e, "ssh: post-add cache fetch failed");
            }
        }
    });

    reconfigure_and_notify(&app, &state).await;
    Ok(source)
}

/// Update an existing SSH kubeconfig source in place. Validates, rewrites the
/// keychain entries (overwriting prior secrets for the same source_id), runs
/// the same test-connect flow as `add_kubeconfig_ssh_source` to verify the
/// new credentials, refreshes the pinned fingerprint, and persists.
///
/// Source id stays stable so any open clusters / cached views keyed by the
/// composite `<source_id>::<context>` continue to resolve. Existing keychain
/// entries are deleted up front to flush stale secrets when the operator
/// switches auth modes (e.g. password → ssh-agent → key).
#[tauri::command]
pub(crate) async fn update_kubeconfig_ssh_source(
    id: String,
    input: SshSourceInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<KubeconfigSource, String> {
    // Edit mode allows empty password / passphrase to mean "keep the existing
    // keychain entry". The keychain rewrite below is conditional accordingly.
    input.validate(false)?;

    // Snapshot the existing source so we can roll back the keychain on
    // failure. Refusing to update a non-SSH source keeps the UI honest —
    // the edit modal only opens for SSH rows in the first place.
    let prior = {
        let s = state.sources.lock().await;
        s.sources.iter().find(|x| x.id == id).cloned()
    };
    let prior = prior.ok_or_else(|| format!("source not found: {id}"))?;
    if prior.kind != sources::SourceKind::Ssh {
        return Err("update_kubeconfig_ssh_source called on a non-SSH source".to_owned());
    }
    let prior_ssh = prior
        .ssh
        .as_ref()
        .ok_or_else(|| "internal: prior SSH source missing ssh cfg".to_owned())?;

    let new_cfg = SshSourceConfig {
        host: input.host.trim().to_owned(),
        port: input.port,
        user: input.user.trim().to_owned(),
        auth: ssh_auth_from_input(&input.auth),
        remote_kubeconfig: input
            .remote_kubeconfig
            .as_ref()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
        // Don't carry the previous fingerprint forward — host / port may have
        // changed and the next test-connect captures the new one. If the user
        // didn't change those, TOFU still re-pins on the very next handshake.
        known_host_fingerprint: None,
    };

    // Refuse to clash with another row. The check excludes `id` itself so
    // an in-place edit (no host/user change) still passes.
    {
        let s = state.sources.lock().await;
        let collision = s.sources.iter().any(|x| {
            x.id != id
                && x.ssh.as_ref().is_some_and(|cfg| {
                    cfg.host == new_cfg.host && cfg.port == new_cfg.port && cfg.user == new_cfg.user
                })
        });
        if collision {
            return Err(format!(
                "another SSH source for {}@{}:{} already exists",
                new_cfg.user, new_cfg.host, new_cfg.port
            ));
        }
    }

    // Switching auth modes flushes the prior keychain (the old entries are
    // for a different mode; leaving them around is leak-only). Same-mode
    // edits keep the existing entries unless the operator explicitly typed
    // a new secret — that's what `write_ssh_secrets` skips for empty inputs.
    let mode_changed = prior_ssh.auth.auth_kind() != new_cfg.auth.auth_kind();
    if mode_changed {
        sources::delete_source_secrets(&id);
    }
    if let Err(e) = write_ssh_secrets(&id, &input.auth) {
        return Err(format!(
            "{e} (keychain write failed; existing entries may be in a partial state)"
        ));
    }

    // Verify the new credentials before persisting. A failure here keeps the
    // *persisted* row unchanged. Best-effort: if the operator changed auth
    // mode and the test failed, we *can't* roll back the keychain (we
    // don't have the prior plaintexts). Surface that clearly.
    let test = match test_inner(&new_cfg, &id).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(
                source_id = %id,
                error = %e,
                mode_changed,
                "ssh: update verification failed"
            );
            let hint = if mode_changed {
                "\n(auth mode change required clearing prior keychain entries; please re-enter the credential and save again)"
            } else {
                ""
            };
            return Err(format!("{e}{hint}"));
        }
    };

    let mut updated = prior.clone();
    let mut next_cfg = new_cfg.clone();
    next_cfg.known_host_fingerprint = test.fingerprint.clone();
    updated.ssh = Some(next_cfg);
    updated.path = std::path::PathBuf::from(format!(
        "{}@{}:{}",
        new_cfg.user, new_cfg.host, new_cfg.port
    ));
    updated.group_override = input
        .group_override
        .as_ref()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    {
        let mut s = state.sources.lock().await;
        if let Some(slot) = s.sources.iter_mut().find(|x| x.id == id) {
            *slot = updated.clone();
            sources::save(&s).await.map_err(|e| e.to_string())?;
        } else {
            // The source disappeared between the snapshot and now (operator
            // hit Remove in another window). Roll back the keychain we just
            // wrote.
            sources::delete_source_secrets(&id);
            return Err("source disappeared during update".to_owned());
        }
    }

    // Drop the old cached kubeconfig and refetch under the new config. Done
    // in the background so the UI returns promptly.
    kubeconfig::forget_ssh_cache(&id);
    let cfg_for_bg = updated.ssh.clone().expect("ssh cfg present");
    let id_for_bg = id.clone();
    tauri::async_runtime::spawn(async move {
        match kubeconfig::fetch_ssh_kubeconfig(&id_for_bg, &cfg_for_bg).await {
            Ok(kc) => kubeconfig::cache_ssh_kubeconfig(&id_for_bg, kc),
            Err(e) => {
                tracing::warn!(source_id = %id_for_bg, error = %e, "ssh: post-update cache fetch failed");
            }
        }
    });

    reconfigure_and_notify(&app, &state).await;
    Ok(updated)
}

// ── Table views ─────────────────────────────────────────────────────────────
//
// Per-(cluster, kind) sort + column-width state. Single global file
// (`<config>/table_views.json`) — no separate state held in `AppState`; we
// read fresh and write back on each mutation. The file is small (one entry
// per table the operator has touched), so the I/O cost is fine.

#[tauri::command]
pub(crate) async fn get_table_views() -> Result<TableViewsFile, String> {
    Ok(table_views::load().await)
}

#[tauri::command]
pub(crate) async fn set_table_view(
    cluster_id: String,
    kind_id: String,
    view: TableView,
) -> Result<(), String> {
    let mut file = table_views::load().await;
    let key = table_views::key(&cluster_id, &kind_id);
    if view.sorting.is_empty() && view.column_sizing.is_empty() {
        file.views.remove(&key);
    } else {
        file.views.insert(key, view);
    }
    table_views::save(&file).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── Prefs ───────────────────────────────────────────────────────────────────
//
// Theme + settings panel values + small selection state. Single global file
// (`<config>/prefs.json`). Same load-on-startup / overwrite-on-set pattern
// as table_views; the file is small so re-serialising on each mutation is
// fine.

#[tauri::command]
pub(crate) async fn get_prefs() -> Result<Prefs, String> {
    Ok(prefs::load().await)
}

/// Save user prefs. Full-document overwrite: every `Prefs` subtree (theme,
/// settings, ui, update, virtual_contexts) is frontend-authoritative — the
/// debounced setPrefs builds the complete payload via `buildPrefsPayload`.
/// Prometheus targets live in their own `prometheus.json`, so there is no
/// backend-owned subtree left to protect.
///
/// History: this used to merge field-by-field into the on-disk copy to
/// protect a backend-written subtree. That merge silently dropped any field
/// added later — `virtual_contexts` and `update` never reached disk, which
/// is exactly how "saved virtual contexts vanish on restart" happened. If a
/// backend-owned subtree ever returns, give it its own file or its own
/// command; do NOT reintroduce a partial merge here.
#[tauri::command]
pub(crate) async fn set_prefs(prefs: Prefs) -> Result<(), String> {
    prefs::save(&prefs).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Recompute the watcher's path set + emit `kubeconfig://changed` so the UI
/// re-runs `list_contexts`. Called after any source mutation. Also stops any
/// port-forwards whose cluster vanished (source removed / disabled / default
/// kubeconfig disabled) so we don't keep listeners pointing at clusters the
/// operator no longer has a config for.
async fn reconfigure_and_notify(app: &AppHandle, state: &State<'_, AppState>) {
    let paths: Vec<PathBuf> = {
        let s = state.sources.lock().await;
        kubeconfig::resolved_sources(&s)
            .into_iter()
            .map(|r| r.path)
            .collect()
    };
    if let Some(w) = state.kubeconfig_watcher.lock().await.as_ref() {
        w.reconfigure(&paths);
    }
    cleanup_orphaned_forwards(state).await;
    let _ = app.emit("kubeconfig://changed", ());
}

// ---- Multi-doc YAML apply (Create-from-YAML) ------------------------------

/// Apply every YAML document in `yaml` against `cluster_id` via SSA. The
/// helper never errors as a whole — per-doc outcomes come back as a vector
/// so the UI can render partial success / per-doc conflicts.
#[tauri::command]
pub(crate) async fn apply_yaml_cmd(
    cluster_id: String,
    yaml: String,
    dry_run: bool,
    force: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ferrisscope_kube_ext::DocApplyResult>, String> {
    let entry = state.entry(&cluster_id).await?;
    Ok(ferrisscope_kube_ext::apply_yaml(entry.cluster.client(), &yaml, dry_run, force).await)
}

// ---- Terminal (PTY) -------------------------------------------------------

/// Resolve `cluster_id` into a concrete kubeconfig path + context name for
/// any caller that hands the path to an external CLI (helm, kubectl, the
/// embedded terminal's shell). For SSH-sourced clusters this materialises a
/// rewritten scratch pointing at the local tunnel port — the original
/// remote `cluster.server` URL isn't reachable from the operator's machine.
///
/// `prefix` is the filename leader for the SSH scratch (so `ls <cache>/`
/// makes the owner obvious: `term`, `helm`). The third tuple element is the
/// list of paths the caller must clean up when done — empty for non-SSH
/// (the source file is operator-owned), `[scratch]` for SSH.
async fn resolve_kubeconfig(
    state: &State<'_, AppState>,
    cluster_id: &str,
    prefix: &str,
) -> Result<(PathBuf, String, Vec<PathBuf>), String> {
    let context_name = kubeconfig::context_name_from_id(cluster_id).to_owned();
    let app_state: &AppState = state.inner();

    // SSH path: the source file is just a synthetic "user@host:port" label;
    // we have to mint a real file pointing at the tunnel.
    if let Some(scratch) =
        crate::ssh_scratch::materialize_if_needed(cluster_id, &context_name, prefix, app_state)
            .await
    {
        return Ok((scratch.clone(), context_name, vec![scratch]));
    }

    // Non-SSH: the source file (or the implicit default) IS the file.
    let path = {
        let s = state.sources.lock().await;
        kubeconfig::source_path_for(cluster_id, &s)
    }
    .or_else(kubeconfig::default_kubeconfig_path)
    .ok_or_else(|| "no kubeconfig file resolvable for this context".to_owned())?;
    Ok((path, context_name, Vec::new()))
}

/// Best-effort delete each scratch path. Logged failures only — these files
/// are tiny and live in the cache dir; a stale one is annoying but not
/// data-loss. For cluster-resident state see the per-call cleanup paths.
fn cleanup_scratch_paths(paths: &[PathBuf]) {
    for p in paths {
        if let Err(e) = std::fs::remove_file(p) {
            // ENOENT just means "already gone" (a parallel cleanup beat us
            // to it, or the cache was wiped); log at debug.
            if e.kind() == std::io::ErrorKind::NotFound {
                continue;
            }
            tracing::debug!(path = %p.display(), error = %e, "scratch cleanup failed");
        }
    }
}

#[tauri::command]
pub(crate) async fn terminal_open_shell(
    cluster_id: String,
    namespace: Option<String>,
    on_event: tauri::ipc::Channel<crate::terminal::TerminalEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, context_name, extras) = resolve_kubeconfig(&state, &cluster_id, "term").await?;
    state
        .terminals
        .spawn_with_extras(
            cluster_id,
            on_event,
            SpawnSpec::Shell {
                kubeconfig_path: path,
                context_name,
                default_namespace: namespace,
            },
            extras,
        )
        .await
}

#[tauri::command]
pub(crate) async fn terminal_open_exec(
    cluster_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Option<Vec<String>>,
    on_event: tauri::ipc::Channel<crate::terminal::TerminalEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, context_name, extras) = resolve_kubeconfig(&state, &cluster_id, "term").await?;
    state
        .terminals
        .spawn_with_extras(
            cluster_id,
            on_event,
            SpawnSpec::Exec {
                kubeconfig_path: path,
                context_name,
                namespace,
                pod,
                container,
                command: command.unwrap_or_default(),
            },
            extras,
        )
        .await
}

#[tauri::command]
pub(crate) async fn terminal_open_kubectl(
    cluster_id: String,
    namespace: Option<String>,
    args: Vec<String>,
    custom_profile: Option<String>,
    cleanup: Option<PodCleanup>,
    on_event: tauri::ipc::Channel<crate::terminal::TerminalEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (path, context_name, extras) = resolve_kubeconfig(&state, &cluster_id, "term").await?;
    state
        .terminals
        .spawn_with_extras(
            cluster_id,
            on_event,
            SpawnSpec::Kubectl {
                kubeconfig_path: path,
                context_name,
                default_namespace: namespace,
                args,
                custom_profile,
                cleanup,
            },
            extras,
        )
        .await
}

#[tauri::command]
pub(crate) async fn terminal_write(
    session_id: String,
    b64: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64: {e}"))?;
    state.terminals.write(&session_id, &bytes).await
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.terminals.resize(&session_id, cols, rows).await
}

/// Best-effort background delete of a terminal session's cleanup pod
/// (kubectl-debug / node-debug leaves the debug pod behind on exit). Fired as
/// a detached task so a slow or failing delete never blocks tab teardown or
/// cluster disconnect. Shared by `terminal_close` (one tab) and
/// `drop_cluster_watchers` (every terminal owned by a cluster the operator just
/// left). A `404` is logged at info (already gone, not a leak); anything else
/// at warn (possible leak — the pod's server-side TTL / activeDeadline is the
/// backstop). An empty name means the pod's name was never captured from
/// kubectl output; there's nothing safe to delete, so we just surface it.
fn spawn_delete_cleanup_pod(client: kube::Client, cleanup: PodCleanup) {
    if cleanup.name.is_empty() {
        tracing::warn!(
            cluster = %cleanup.cluster_id,
            namespace = %cleanup.namespace,
            "terminal cleanup: debug pod name was never captured — possible leak"
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        match ferrisscope_kube_ext::delete_resource(
            client,
            "pods",
            Some(&cleanup.namespace),
            &cleanup.name,
            Some(0),
        )
        .await
        {
            Ok(_) => tracing::info!(
                namespace = %cleanup.namespace,
                name = %cleanup.name,
                "terminal cleanup: deleted debug pod"
            ),
            // 404 is expected if the pod was already collected (kubectl debug
            // had failed to create it, the user deleted it manually, namespace
            // GC fired, …). Log at info, not warn — it's not a leak.
            Err(e) if format!("{e}").contains("NotFound") => tracing::info!(
                namespace = %cleanup.namespace,
                name = %cleanup.name,
                "terminal cleanup: debug pod already gone"
            ),
            Err(e) => tracing::warn!(
                error = %e,
                namespace = %cleanup.namespace,
                name = %cleanup.name,
                "terminal cleanup: failed to delete debug pod"
            ),
        }
    });
}

#[tauri::command]
pub(crate) async fn terminal_close(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(c) = state.terminals.close(&session_id).await {
        // Fire-and-forget: the operator already moved on (closed the tab), and
        // a delete failure shouldn't block tab teardown. `entry` reuses the
        // (normally still-connected) cluster's client; the delete itself runs
        // in a detached task via `spawn_delete_cleanup_pod`.
        match state.entry(&c.cluster_id).await {
            Ok(entry) => spawn_delete_cleanup_pod(entry.cluster.client(), c),
            Err(e) => tracing::warn!(error = %e, "terminal cleanup: cluster gone"),
        }
    }
    Ok(())
}

/// Bridge the per-cluster `ClusterHealth` broadcast to a Tauri event so
/// the frontend can flip into an unavailable banner at the same moment
/// the data plane gets torn down. Spawned once per cluster from the
/// `claim_connect_probes` block. The probe loop self-terminates after
/// emitting `Unavailable`, which closes the broadcast and exits this
/// task — `reconnect_cluster` rebuilds the entry, re-spawning a fresh
/// forwarder via the next `connect_context`.
///
/// **Lifetime / memory.** Captures `Arc<ClusterHealth>` (not the full
/// `Arc<ClusterEntry>` we used to take) so a forgotten abort can't pin
/// the whole `Cluster` + kube `Client` HTTP/2 pool. The returned
/// `JoinHandle` is stored on `ClusterEntry::health_forwarder` and
/// aborted by `drop_cluster_watchers` / `tear_down_unhealthy`; without
/// the abort the forwarder's `rx.recv()` blocks forever (the only
/// `Sender` lives inside the captured `ClusterHealth`), which keeps
/// `ClusterHealth` and its probe task resident even after the entry
/// has been removed from the state map.
fn spawn_health_forwarder(
    app: AppHandle,
    cluster_id: String,
    health: Arc<ferrisscope_core::health::ClusterHealth>,
) -> tauri::async_runtime::JoinHandle<()> {
    let mut rx = health.subscribe();
    let event_name = format!("cluster-health://{}", sanitize_event_segment(&cluster_id));
    tauri::async_runtime::spawn(async move {
        // Replay the current health snapshot so a forwarder spawned
        // *after* the probe already declared `Unavailable` (entry was
        // lazily created via `state.entry()` by some non-`connect_context`
        // path; the probe ran for 30s+; only now does the operator
        // click into the cluster and trigger the forwarder spawn) still
        // gets the UI into the right state. The broadcast channel does
        // not buffer past events.
        let snap = health.snapshot().await;
        if health_status_triggers_teardown(&snap.status) {
            tracing::warn!(
                ?cluster_id,
                reason = ?snap.reason,
                "spawn_health_forwarder: cluster already unavailable on subscribe — replaying"
            );
            // Emit BEFORE teardown — see the live-path note below.
            if let Err(e) = app.emit(&event_name, &snap) {
                tracing::warn!(error = %e, ?cluster_id, "failed to emit cluster health");
            }
            spawn_unhealthy_teardown(app.clone(), cluster_id.clone());
            return;
        }
        loop {
            match rx.recv().await {
                Ok(evt) => {
                    if health_status_triggers_teardown(&evt.status) {
                        // Emit the unavailable event BEFORE tearing down. The
                        // teardown aborts THIS forwarder (drop_all_kind_watchers
                        // takes the health_forwarder handle), and tearing down
                        // first would cancel this task — at the first await
                        // inside the teardown, after the self-abort — before the
                        // emit ran, leaving the operator with no "cluster down"
                        // banner. Detaching the teardown (below) also lets it
                        // complete in full regardless of this forwarder's fate;
                        // the gate (`unavailable`) is still set synchronously at
                        // the top of tear_down_unhealthy, so in-flight
                        // subscribe_* calls bail out a beat later.
                        if let Err(e) = app.emit(&event_name, &evt) {
                            tracing::warn!(error = %e, ?cluster_id, "failed to emit cluster health");
                        }
                        spawn_unhealthy_teardown(app.clone(), cluster_id.clone());
                        return;
                    }
                    if let Err(e) = app.emit(&event_name, &evt) {
                        tracing::warn!(error = %e, ?cluster_id, "failed to emit cluster health");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(?cluster_id, "cluster health forwarder exiting");
                    return;
                }
            }
        }
    })
}

/// Whether a health status should trigger a data-plane teardown. Today only
/// `Unavailable` does; pulled out so the replay and live paths in
/// [`spawn_health_forwarder`] agree and the policy is unit-testable.
fn health_status_triggers_teardown(status: &ClusterHealthStatus) -> bool {
    matches!(status, ClusterHealthStatus::Unavailable)
}

/// Tear down an unhealthy cluster's data plane on a detached task. Called from
/// the health forwarder, which must NOT run [`tear_down_unhealthy`] inline:
/// the teardown aborts the health forwarder itself (via
/// [`drop_all_kind_watchers`]), so an inline call would cancel the forwarder
/// mid-teardown — at the first await after the self-abort — leaving the
/// unavailable emit unsent and the metrics service un-dropped. Detaching lets
/// the teardown complete regardless of the forwarder being aborted.
fn spawn_unhealthy_teardown(app: AppHandle, cluster_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        tear_down_unhealthy(state.inner(), &cluster_id).await;
    });
}

/// **Lifetime / memory.** The returned `JoinHandle` is stored on
/// `ClusterEntry::metrics_forwarder` and aborted by
/// `drop_cluster_watchers` / `tear_down_unhealthy`. Subscribing here
/// holds an `Arc<MetricsService>` clone alive — without explicit abort
/// the service (and its poll task) would survive `slot.service.take()`
/// in `unsubscribe_metrics`, because the forwarder's clone keeps the
/// refcount > 0 and the broadcast `Sender` therefore never drops. The
/// abort breaks that cycle so `MetricsService::Drop` actually runs.
fn spawn_metrics_forwarder(
    app: AppHandle,
    cluster_id: String,
    svc: Arc<MetricsService>,
) -> tauri::async_runtime::JoinHandle<()> {
    let mut rx = svc.subscribe();
    // Drop the strong ref before entering the async block — the
    // subscription survives via `rx` alone (broadcast receivers don't
    // hold the sender alive), so capturing `svc` would re-introduce
    // the retention cycle this signature was redesigned to avoid.
    drop(svc);
    let event_name = format!("metrics://{}", sanitize_event_segment(&cluster_id));
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(snap) => {
                    // `snap` is an `Arc<MetricsSnapshot>`; deref through
                    // serde — no clone of the underlying snapshot.
                    if let Err(e) = app.emit(&event_name, &*snap) {
                        tracing::warn!(error = %e, ?cluster_id, "failed to emit metrics");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Single-snapshot value; no harm in dropping a stale one.
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(?cluster_id, "metrics forwarder exiting");
                    return;
                }
            }
        }
    })
}

// ── Port forwarding ────────────────────────────────────────────────────────
//
// Local TCP listener bridged to the apiserver's pod-portforward subresource.
// One handle per `(cluster, target, remote_port)` triple; a duplicate
// `pf_start` returns the existing entry instead of binding a second listener.
//
// `pinned` (renamed from spec.autostart at the IPC boundary so the backend's
// internal flag stays clearly named) controls persistence: pinned forwards
// land in `<config>/portforwards.json` and re-bind at the next launch.
// Ephemeral forwards live in memory only.
//
// Cluster cleanup: when a kubeconfig source is removed, disabled, or the
// default kubeconfig is disabled, every forward whose `cluster_id` no longer
// resolves to a connectable context is stopped and (if pinned) removed from
// disk. See `cleanup_orphaned_forwards`.

#[tauri::command]
pub(crate) async fn pf_start(
    cluster_id: String,
    target: ForwardTarget,
    remote_port: u16,
    requested_local_port: Option<u16>,
    pinned: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ForwardEntry, String> {
    let id = portforwards::make_id(&cluster_id, &target, remote_port);
    {
        // Dedupe: a duplicate start returns the existing entry. The frontend
        // gets back the same id + actual_local_port so its UI lookup works.
        let map = state.portforwards.by_id.lock().await;
        if let Some(existing) = map.get(&id) {
            return Ok(ferrisscope_kube_ext::forward_snapshot(existing).await);
        }
    }
    let entry_arc = state.entry(&cluster_id).await?;
    let spec = ForwardSpec {
        id: id.clone(),
        cluster_id: cluster_id.clone(),
        target,
        remote_port,
        requested_local_port,
        autostart: pinned,
        // Simple tier: bind 127.0.0.1 (local_ip None). Global forwards go
        // through the dedicated gf_* path, not pf_start.
        mode: Default::default(),
        local_ip: None,
    };
    let handle = start_forward(
        entry_arc.cluster.client(),
        spec,
        None, // Simple forward: bind in-process.
        state.portforwards.status_tx.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;
    let snapshot = ferrisscope_kube_ext::forward_snapshot(&handle).await;
    state
        .portforwards
        .by_id
        .lock()
        .await
        .insert(id.clone(), handle);
    if pinned {
        persist_forwards(&state).await;
    }
    // Status forwarder is mounted once at startup (see `spawn_pf_status_forwarder`),
    // so we don't need to spawn one per start.
    let _ = app;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn pf_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let removed = state.portforwards.by_id.lock().await.remove(&id);
    if let Some(handle) = removed {
        let was_pinned = handle.spec.autostart;
        // Drop aborts the listener task. Emit Stopped so the UI can update
        // without waiting for a status event from the (now-dead) task.
        let _ = state
            .portforwards
            .status_tx
            .send((id.clone(), ForwardStatus::Stopped));
        drop(handle);
        // The pin override map otherwise keeps a tiny entry per id forever.
        // Drop it now that the forward is gone.
        state.portforwards.pin_overrides.lock().await.remove(&id);
        if was_pinned {
            persist_forwards(&state).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn pf_list(state: State<'_, AppState>) -> Result<Vec<ForwardEntry>, String> {
    let map = state.portforwards.by_id.lock().await;
    let mut out = Vec::with_capacity(map.len());
    for handle in map.values() {
        out.push(ferrisscope_kube_ext::forward_snapshot(handle).await);
    }
    Ok(out)
}

/// Toggle the pin flag on an existing forward. Pinned forwards are persisted
/// to `portforwards.json`; unpinning removes them from the file but keeps the
/// listener running until the operator stops it.
/// Toggle the pin flag on an existing forward. Pinned forwards are persisted
/// to `portforwards.json`; unpinning removes them from the file but keeps the
/// listener running until the operator stops it explicitly.
///
/// Pin state lives in `pin_overrides` rather than the spec because the spec
/// is immutable once cloned into the listener task — this lets us flip pin
/// without tearing the listener down.
#[tauri::command]
pub(crate) async fn pf_set_autostart(
    id: String,
    pinned: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let map = state.portforwards.by_id.lock().await;
        if !map.contains_key(&id) {
            return Err(format!("no forward {id}"));
        }
    }
    state
        .portforwards
        .pin_overrides
        .lock()
        .await
        .insert(id, pinned);
    persist_forwards(&state).await;
    Ok(())
}

// ---- Global (DNS) forwards ----------------------------------------------
//
// These route through the privileged helper (loopback aliases + /etc/hosts) via
// the `GlobalForwardManager` managed state. Unlike `pf_*`, global sessions are
// session-scoped (not persisted across restarts) in v1; crash leftovers are
// cleaned by the helper's `PurgeStale` the next time it's spawned.

#[tauri::command]
pub(crate) async fn gf_enable_namespace(
    cluster_id: String,
    namespace: String,
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
    state: State<'_, AppState>,
) -> Result<crate::globalfwd::GlobalSessionSnapshot, String> {
    let namespace = namespace.trim();
    if namespace.is_empty() {
        return Err("namespace is required".into());
    }
    let entry = state.entry(&cluster_id).await?;
    let client = entry.cluster.client();
    gf.enable_namespace(client, &state.portforwards, &cluster_id, namespace)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn gf_enable_service(
    cluster_id: String,
    namespace: String,
    name: String,
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
    state: State<'_, AppState>,
) -> Result<crate::globalfwd::GlobalSessionSnapshot, String> {
    let namespace = namespace.trim();
    let name = name.trim();
    if namespace.is_empty() {
        return Err("namespace is required".into());
    }
    if name.is_empty() {
        return Err("service name is required".into());
    }
    let entry = state.entry(&cluster_id).await?;
    let client = entry.cluster.client();
    gf.enable_service(client, &state.portforwards, &cluster_id, namespace, name)
        .await
        .map_err(|e| e.to_string())
}

/// Enable a global forward by query: `namespace = None` → all namespaces;
/// `label_selector = Some("k=v,k2")` → filter. Covers kubefwd `-A` / `-l`.
#[tauri::command]
pub(crate) async fn gf_enable_query(
    cluster_id: String,
    namespace: Option<String>,
    label_selector: Option<String>,
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
    state: State<'_, AppState>,
) -> Result<crate::globalfwd::GlobalSessionSnapshot, String> {
    // Normalize blank inputs to `None`: an empty namespace means "all
    // namespaces", and an empty selector means "match everything" — passing the
    // empty string through would instead hit `Api::namespaced("")` / an empty
    // field selector and error at the apiserver.
    let namespace = namespace
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let label_selector = label_selector
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let entry = state.entry(&cluster_id).await?;
    let client = entry.cluster.client();
    gf.enable_query(
        client,
        &state.portforwards,
        &cluster_id,
        namespace,
        label_selector,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn gf_disable(
    id: String,
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    gf.disable(&state.portforwards, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn gf_list(
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
) -> Result<Vec<crate::globalfwd::GlobalSessionSnapshot>, String> {
    Ok(gf.list().await)
}

#[tauri::command]
pub(crate) async fn gf_helper_status(
    gf: State<'_, crate::globalfwd::GlobalForwardManager>,
) -> Result<crate::globalfwd::HelperStatus, String> {
    Ok(gf.status().await)
}

/// Persist every currently-pinned forward to `portforwards.json`. Called
/// after start/stop/pin transitions.
///
/// `requested_local_port` is overwritten with the actually-bound port for
/// pinned entries — so a restart re-binds the *same* local port the operator
/// already opened in their browser. Without this, an operator who pins a
/// chip-opened forward (which started on an ephemeral port) would come back
/// to a different port after restart and every cached browser tab would 404.
pub(crate) async fn persist_forwards(state: &State<'_, AppState>) {
    let map = state.portforwards.by_id.lock().await;
    let overrides = state.portforwards.pin_overrides.lock().await;
    let specs: Vec<ForwardSpec> = map
        .values()
        .filter_map(|h| {
            let pinned = overrides
                .get(&h.spec.id)
                .copied()
                .unwrap_or(h.spec.autostart);
            if pinned {
                let mut s = h.spec.clone();
                s.autostart = true;
                s.requested_local_port = Some(h.actual_local_port);
                Some(s)
            } else {
                None
            }
        })
        .collect();
    drop(overrides);
    drop(map);
    if let Err(e) = portforwards::save(&PortForwardsFile {
        version: portforwards::CURRENT_VERSION,
        specs,
    })
    .await
    {
        tracing::warn!(error = %e, "persist port-forwards");
    }
}

/// Stop every forward whose `cluster_id` is no longer resolvable. Called
/// after kubeconfig source mutations (remove / disable / default-disable).
/// Pinned forwards are also removed from `portforwards.json` so they don't
/// resurrect on the next launch with the same vanished cluster.
pub(crate) async fn cleanup_orphaned_forwards(state: &State<'_, AppState>) {
    let live: std::collections::HashSet<String> = {
        let s = state.sources.lock().await;
        kubeconfig::list_contexts(&s)
            .map(|cs| cs.into_iter().map(|c| c.id).collect())
            .unwrap_or_default()
    };
    let mut to_remove: Vec<String> = Vec::new();
    {
        let map = state.portforwards.by_id.lock().await;
        for (id, handle) in map.iter() {
            if !live.contains(&handle.spec.cluster_id) {
                to_remove.push(id.clone());
            }
        }
    }
    if to_remove.is_empty() {
        return;
    }
    {
        let mut map = state.portforwards.by_id.lock().await;
        for id in &to_remove {
            if let Some(handle) = map.remove(id) {
                let _ = state
                    .portforwards
                    .status_tx
                    .send((id.clone(), ForwardStatus::Stopped));
                drop(handle);
            }
        }
    }
    persist_forwards(state).await;
}

/// Restore persisted forwards at startup. Each pinned spec is re-started;
/// failures (cluster unreachable, port taken) come back as Failed entries so
/// the UI can show them and let the operator retry / unpin.
pub(crate) async fn restore_persisted_forwards(state: &State<'_, AppState>, app: &AppHandle) {
    let file = portforwards::load().await;
    for spec in file.specs {
        let id = spec.id.clone();
        // Pre-record the pin override so it survives subsequent saves.
        state
            .portforwards
            .pin_overrides
            .lock()
            .await
            .insert(id.clone(), true);
        match state.entry(&spec.cluster_id).await {
            Ok(entry) => {
                match start_forward(
                    entry.cluster.client(),
                    spec.clone(),
                    // Persisted forwards are Simple-tier (global sessions are
                    // re-established via gf_*, not restored here) → bind in-process.
                    None,
                    state.portforwards.status_tx.clone(),
                )
                .await
                {
                    Ok(handle) => {
                        state.portforwards.by_id.lock().await.insert(id, handle);
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "portforward://status",
                            serde_json::json!({
                                "id": id,
                                "status": { "kind": "failed", "reason": e.to_string() },
                            }),
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "portforward://status",
                    serde_json::json!({
                        "id": id,
                        "status": { "kind": "failed", "reason": format!("cluster offline: {e}") },
                    }),
                );
            }
        }
    }
}

/// Mount the bridge that forwards every port-forward status event onto the
/// `portforward://status` Tauri channel. Called once at startup. Payload is
/// just `{ id, status }` — the UI maintains a parallel `Map<id, ForwardEntry>`
/// hydrated by `pf_list`, so it can resolve everything else locally.
pub(crate) fn spawn_pf_status_forwarder_handle(app: AppHandle) {
    // Subscribe synchronously so the receiver exists before any emitter
    // could send. The State lookup is cheap and only runs once.
    let state = app.state::<AppState>();
    let mut rx = state.portforwards.status_tx.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok((id, status)) => {
                    let _ = app.emit(
                        "portforward://status",
                        serde_json::json!({ "id": id, "status": status }),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

/// `restore_persisted_forwards` wrapper that takes a tauri State so `main()`
/// can call it without manually building one.
pub(crate) async fn restore_persisted_forwards_state(state: &State<'_, AppState>, app: &AppHandle) {
    restore_persisted_forwards(state, app).await;
}

// ── Prometheus integration (read-only, auto-detected) ──────────────────────
//
// Discovery + PromQL queries proxied through the apiserver. The active
// target per cluster lives in the on-disk cache (`prometheus.json`); on
// every `connect_context` we kick off a background detect task that
// validates the cached target (or runs discovery if we don't have one /
// the cached one is stale) and emits `prometheus://changed` so the UI
// can wire up panels without polling.
//
// User-picked targets (via Settings → Use) are stored with `source: User`
// and are never auto-replaced — the operator's choice persists across
// outages, just with a freshness flag the UI surfaces.

#[tauri::command]
pub(crate) async fn discover_prometheus_targets(
    cluster_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<PromTarget>, String> {
    let entry = state.entry(&cluster_id).await?;
    prometheus::discover(entry.cluster.client())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_prometheus_target(
    cluster_id: String,
) -> Result<Option<PromCacheEntry>, String> {
    Ok(prom_cache::get(&cluster_id).await)
}

/// Set or clear (`target = None`) the active Prometheus for a cluster as a
/// *user* choice. User choices are sticky across detect cycles — only an
/// explicit clear removes them. Validation is the operator's responsibility
/// (Settings → Test); we don't pre-validate here so an offline Prometheus
/// can still be saved for later.
#[tauri::command]
pub(crate) async fn set_prometheus_target(
    cluster_id: String,
    target: Option<PromTarget>,
) -> Result<(), String> {
    match target {
        Some(t) => {
            let entry = PromCacheEntry {
                target: t,
                source: PromSource::User,
                last_validated_at_unix_ms: 0,
            };
            prom_cache::set(&cluster_id, entry)
                .await
                .map_err(|e| e.to_string())
        }
        None => prom_cache::clear(&cluster_id)
            .await
            .map_err(|e| e.to_string()),
    }
}

/// Force a re-detect even if a cached target exists. Replaces an `Auto`
/// entry; refreshes the validation timestamp on a healthy `User` entry; if
/// a `User` entry is unreachable, leaves it in place (the operator can
/// clear it manually via Settings if they want re-discovery).
#[tauri::command]
pub(crate) async fn prometheus_redetect(
    cluster_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entry = state.entry(&cluster_id).await?;
    let client = entry.cluster.client();
    spawn_prometheus_detect(app, cluster_id, client);
    Ok(())
}

#[tauri::command]
pub(crate) async fn prometheus_query_instant(
    cluster_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let target = require_target(&cluster_id).await?;
    let entry = state.entry(&cluster_id).await?;
    prometheus::query_instant(entry.cluster.client(), &target, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn prometheus_query_range(
    cluster_id: String,
    query: String,
    start: String,
    end: String,
    step: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let target = require_target(&cluster_id).await?;
    let entry = state.entry(&cluster_id).await?;
    prometheus::query_range(entry.cluster.client(), &target, &query, &start, &end, &step)
        .await
        .map_err(|e| e.to_string())
}

async fn require_target(cluster_id: &str) -> Result<PromTarget, String> {
    prom_cache::get(cluster_id)
        .await
        .map(|e| e.target)
        .ok_or_else(|| {
            "no Prometheus target configured for this cluster — pick one in Settings".to_owned()
        })
}

/// Spawn the detect-on-connect task. Idempotent w.r.t. the cache: a healthy
/// cached entry only refreshes its `last_validated_at_unix_ms`; an `Auto`
/// entry that fails validation is replaced by the next discovered candidate
/// that does validate; a `User` entry that fails validation is left alone
/// (we emit it anyway so the UI can flag it).
/// Skip the live `validate` round-trip if the cached entry was confirmed
/// healthy this recently. Keeps the lazy first-metrics-tab-open detect off
/// the apiserver-proxy path when we already validated the same target a
/// moment ago; we re-validate after this window so a Prometheus that
/// vanished overnight still gets re-detected.
const PROM_VALIDATE_RECENT_MS: i64 = 5 * 60 * 1_000;

pub(crate) fn spawn_prometheus_detect(app: AppHandle, cluster_id: String, client: kube::Client) {
    tauri::async_runtime::spawn(async move {
        run_prometheus_detect(app, cluster_id, client).await;
    });
}

async fn run_prometheus_detect(app: AppHandle, cluster_id: String, client: kube::Client) {
    let cached = prom_cache::get(&cluster_id).await;
    if let Some(mut e) = cached {
        // Recently validated → trust it, skip the round-trip. Operator can
        // force a re-detect from Settings if they really want one.
        let now = prom_cache::now_ms();
        if e.last_validated_at_unix_ms > 0
            && now.saturating_sub(e.last_validated_at_unix_ms) < PROM_VALIDATE_RECENT_MS
        {
            emit_prom_changed(&app, &cluster_id, Some(&e));
            return;
        }
        let healthy = prometheus::validate(client.clone(), &e.target)
            .await
            .is_ok();
        if healthy {
            e.last_validated_at_unix_ms = now;
            let _ = prom_cache::set(&cluster_id, e.clone()).await;
            emit_prom_changed(&app, &cluster_id, Some(&e));
            return;
        }
        if e.source == PromSource::User {
            tracing::warn!(
                cluster_id = %cluster_id,
                target = %e.target.id(),
                "user-selected Prometheus target failed validation; not auto-replacing"
            );
            // Don't bump the timestamp — the UI uses staleness to flag it.
            emit_prom_changed(&app, &cluster_id, Some(&e));
            return;
        }
        tracing::info!(
            cluster_id = %cluster_id,
            target = %e.target.id(),
            "auto-detected Prometheus stale; re-running discovery"
        );
    }

    let candidates = match prometheus::discover(client.clone()).await {
        Ok(c) => c,
        Err(err) => {
            tracing::debug!(error = %err, cluster_id = %cluster_id, "prometheus discovery failed");
            // No cache change; emit absence so the UI can render
            // "discovery failed" if it cares.
            emit_prom_changed(&app, &cluster_id, None);
            return;
        }
    };

    for c in candidates {
        if prometheus::validate(client.clone(), &c).await.is_ok() {
            let entry = PromCacheEntry {
                target: c,
                source: PromSource::Auto,
                last_validated_at_unix_ms: prom_cache::now_ms(),
            };
            let _ = prom_cache::set(&cluster_id, entry.clone()).await;
            emit_prom_changed(&app, &cluster_id, Some(&entry));
            return;
        }
    }

    // No candidate validated. Wipe any stale Auto entry so the UI doesn't
    // keep pretending one is configured.
    let _ = prom_cache::clear(&cluster_id).await;
    emit_prom_changed(&app, &cluster_id, None);
}

fn emit_prom_changed(app: &AppHandle, cluster_id: &str, entry: Option<&PromCacheEntry>) {
    let _ = app.emit(
        "prometheus://changed",
        serde_json::json!({
            "cluster_id": cluster_id,
            "entry": entry,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::{health_status_triggers_teardown, resource_event_name, sanitize_event_segment};
    use ferrisscope_core::health::ClusterHealthStatus;

    #[test]
    fn detail_cmd_invocations_forward_to_same_stem_inner_fn() {
        // The `detail_cmd!` macro can't catch a same-signature mis-wire — e.g.
        // `detail_cmd! { get_pod_detail_cmd => get_service_detail, namespaced }`
        // compiles cleanly (both inner fns share the namespaced signature) but
        // silently returns the wrong kind's data. The compiler guards command
        // names (via `main.rs`'s `generate_handler!`) and arity/types (via the
        // inner fn signature); this guards the remaining convention: every
        // invocation forwards `get_<x>_detail_cmd` to `get_<x>_detail`. We parse
        // this very source file so a future mis-wire fails here, not in prod.
        const SRC: &str = include_str!("commands.rs");
        let mut checked = 0usize;
        for line in SRC.lines() {
            let Some((lhs, rhs)) = line.split_once("=>") else {
                continue;
            };
            let Some((inner, scope)) = rhs.trim_start().split_once(',') else {
                continue;
            };
            // Restrict to `detail_cmd!` scope lines: the token after the inner
            // fn must be exactly one of the three scope keywords (an inline
            // invocation ends `, namespaced }`; a doc'd one puts the `}` on the
            // next line). Match arms / closures elsewhere with `=>` don't fit
            // this `<ident>, (namespaced|cluster|dynamic)` shape.
            let scope = scope.trim().trim_end_matches('}').trim();
            if !matches!(scope, "namespaced" | "cluster" | "dynamic") {
                continue;
            }
            let inner = inner.trim();
            let cmd = lhs.split_whitespace().last().unwrap_or("");
            assert_eq!(
                cmd,
                format!("{inner}_cmd"),
                "detail_cmd! forwards `{cmd}` to `{inner}`; command name must be \
                 `<inner>_cmd` (same stem) or the wrong kind's data is served"
            );
            checked += 1;
        }
        // Guard against the parser silently matching nothing (e.g. if the macro
        // call syntax changes) — a passing-by-vacuity test is worse than none.
        assert!(
            checked >= 30,
            "expected to validate the detail_cmd! catalogue (>=30 invocations), \
             only saw {checked} — has the macro syntax changed?"
        );
    }

    #[test]
    fn only_unavailable_triggers_teardown() {
        // The health forwarder tears down the data plane (and stops itself)
        // only on Unavailable; a Healthy event just re-emits. If a new status
        // variant is added, this test forces a deliberate decision here.
        assert!(health_status_triggers_teardown(
            &ClusterHealthStatus::Unavailable
        ));
        assert!(!health_status_triggers_teardown(
            &ClusterHealthStatus::Healthy
        ));
    }

    #[test]
    fn sanitize_event_segment_keeps_allowed_alphabet() {
        // Tauri allows [A-Za-z0-9_/:-].
        assert_eq!(sanitize_event_segment("abcXYZ_-/:09"), "abcXYZ_-/:09");
    }

    #[test]
    fn sanitize_event_segment_replaces_disallowed_chars() {
        // Real-world kubeconfig context names break Tauri's regex without this.
        assert_eq!(
            sanitize_event_segment("default::user@itandtel.cloud"),
            "default::user_itandtel_cloud"
        );
        assert_eq!(sanitize_event_segment("a b c"), "a_b_c");
        assert_eq!(sanitize_event_segment("user+tag"), "user_tag");
    }

    #[test]
    fn sanitize_event_segment_handles_non_ascii() {
        // Non-ASCII characters are disallowed by Tauri — every codepoint
        // collapses to one underscore (we iterate by char, not byte).
        let out = sanitize_event_segment("ürl");
        assert_eq!(out.len(), 3);
        assert_eq!(out, "_rl");
    }

    #[test]
    fn sanitize_event_segment_idempotent() {
        let once = sanitize_event_segment("default::user@host");
        let twice = sanitize_event_segment(&once);
        assert_eq!(once, twice, "second pass must be a no-op");
    }

    #[test]
    fn sanitize_event_segment_empty_input() {
        assert_eq!(sanitize_event_segment(""), "");
    }

    #[test]
    fn resource_event_name_uses_canonical_scheme() {
        // The frontend mirror in api.ts (`onResourceDelta` +
        // `nsScopeKey`) must compute the same string; changing this
        // format is a wire break — events go to a channel nobody listens
        // on and the table never updates.
        assert_eq!(
            resource_event_name(
                "default::cluster",
                "pods",
                &ferrisscope_kube_ext::NsScope::All
            ),
            "resource://default::cluster/pods/all"
        );
        assert_eq!(
            resource_event_name(
                "default::cluster",
                "pods",
                &ferrisscope_kube_ext::NsScope::One("kube-system".to_owned()),
            ),
            "resource://default::cluster/pods/ns:kube-system"
        );
        assert_eq!(
            resource_event_name(
                "ctx@host.tld",
                "wkcrd:gateways|gateway.networking.k8s.io|v1|gateways|Gateway|ns",
                &ferrisscope_kube_ext::NsScope::All,
            ),
            "resource://ctx_host_tld/wkcrd:gateways_gateway_networking_k8s_io_v1_gateways_Gateway_ns/all"
        );
    }
}
