//! Native (in-process) tools exposed to the agent.
//!
//! These run alongside the external MCP server and are merged into the same
//! tool catalogue the LLM sees. Each tool closes over whatever app state it
//! needs (the cluster's `kube::Client`, the per-chat shell registry, etc.) at
//! build time, so dispatch in `agent.rs` is a flat name lookup.
//!
//! **Always-on contract.** `build_registry` is invoked unconditionally on
//! `chat_open` — native tools must work even when the external MCP server
//! failed to spawn. Per-tool errors surface as `is_error: true` results, never
//! as panics.

use std::sync::Arc;

use ferrisscope_agent::NativeRegistry;
use tauri::AppHandle;
use tokio::sync::RwLock;

pub(crate) mod apply;
pub(crate) mod can_i;
pub(crate) mod config_view;
pub(crate) mod diagnose;
pub(crate) mod events;
pub(crate) mod helm;
pub(crate) mod http_fetch;
pub(crate) mod logs;
pub(crate) mod metrics;
pub(crate) mod namespaces;
pub(crate) mod node_shell;
pub(crate) mod node_ssh;
pub(crate) mod nodes_kubelet;
pub(crate) mod pause;
pub(crate) mod pod_exec;
pub(crate) mod pods;
pub(crate) mod portforward;
pub(crate) mod prom;
pub(crate) mod resources;
pub(crate) mod rollout;
pub(crate) mod workload;

/// Per-chat cluster context shared across every native tool.
///
/// `origin` is the cluster the chat was opened against — stable for the
/// chat's lifetime; it's what the chat is "bound to" for storage, auto-title,
/// the MCP child's `KUBECONFIG`, and port-forward ownership filtering.
///
/// `active` is what stateless tools target on each call. Defaults to `origin`.
/// `fs_configuration_use_context` rebinds it for the rest of the chat (or
/// until rebound again) so the operator can stay parked on cluster A in the UI
/// while the agent investigates clusters B/C without the operator having to
/// open a new chat per cluster.
///
/// Stateful tools (node-shell at minimum) snapshot the active id at open time
/// into their session struct so in-flight sessions keep targeting their
/// origin cluster even after a switch.
pub(crate) struct ChatClusterCtx {
    origin: String,
    /// Session id this ctx belongs to. Carried so
    /// `fs_configuration_use_context` can persist the switch into the
    /// session JSONL without an extra plumbing layer.
    session_id: String,
    active: RwLock<String>,
}

impl ChatClusterCtx {
    /// Build the per-chat context.
    ///
    /// `restored_active` is the persisted active-cluster override (from
    /// `SessionMeta::active_cluster_id`) — when present and resolvable
    /// against the current sources, the chat re-opens on the agent's
    /// last target rather than reverting to origin. Pass `None` for new
    /// chats or when the saved override doesn't resolve any longer.
    pub(crate) fn new(
        origin: String,
        session_id: String,
        restored_active: Option<String>,
    ) -> Arc<Self> {
        let active = restored_active.unwrap_or_else(|| origin.clone());
        Arc::new(Self {
            origin,
            session_id,
            active: RwLock::new(active),
        })
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) async fn active(&self) -> String {
        self.active.read().await.clone()
    }

    pub(crate) async fn set_active(&self, id: String) {
        *self.active.write().await = id;
    }
}

pub(crate) type ChatClusterRef = Arc<ChatClusterCtx>;

/// Capped variant of `read_to_end` — drains `r` into `buf` until it would
/// exceed `cap` bytes, then stops appending and returns `(written, true)`
/// so the caller can mark the result `truncated`. Subsequent stream data
/// is silently consumed (best-effort drain) to let the remote side finish
/// cleanly, but bounded by `DRAIN_CAP` so a pathological writer can't keep
/// us looping forever.
///
/// Why this exists: kube-rs's `AttachedProcess` exposes async `AsyncRead`
/// handles for exec'd commands; calling `read_to_end` on them buffers the
/// *entire* command output into `buf` before we get a chance to truncate
/// it. A runaway `dmesg`, `find /`, or journal dump streams hundreds of MB
/// into the app process — the post-hoc truncate to 64 KiB defeats its own
/// purpose. This helper applies the cap *during* the read so the Vec
/// never grows past `cap + a small slack`.
pub(crate) async fn read_capped<R>(r: &mut R, buf: &mut Vec<u8>, cap: usize) -> bool
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    // Drain at most this much extra after hitting the cap before bailing.
    // Lets the remote side flush its protocol epilogue without letting a
    // gigabit writer pin us to the loop indefinitely.
    const DRAIN_CAP: usize = 1024 * 1024;

    let mut chunk = [0u8; 8 * 1024];
    let mut truncated = false;
    let mut drained = 0usize;
    loop {
        match r.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() >= cap {
                    truncated = true;
                    drained += n;
                    if drained >= DRAIN_CAP {
                        break;
                    }
                    continue;
                }
                let take = (cap - buf.len()).min(n);
                buf.extend_from_slice(&chunk[..take]);
                if take < n {
                    truncated = true;
                    drained += n - take;
                    if drained >= DRAIN_CAP {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    truncated
}

/// Build the per-chat native registry. Tools close over `AppHandle` (cheap
/// clone, internally ref-counted) and a shared `ChatClusterRef`; AppState is
/// fetched per-call via `app.state::<AppState>()` so we don't need to thread
/// an `Arc<AppState>` through the system.
pub(crate) fn build_registry(app: AppHandle, cluster: ChatClusterRef) -> NativeRegistry {
    let mut reg = NativeRegistry::new();

    // Node shell family — privileged, three-tool session lifecycle.
    let sessions = node_shell::NodeShellSessions::new();
    reg.register(Arc::new(node_shell::NodeShellOpen::new(
        app.clone(),
        cluster.clone(),
        sessions.clone(),
    )));
    reg.register(Arc::new(node_shell::NodeShellExec::new(
        app.clone(),
        sessions.clone(),
    )));
    reg.register(Arc::new(node_shell::NodeShellClose::new(
        app.clone(),
        sessions,
    )));

    // Node-SSH family — fallback to node-shell when the kubelet/scheduler
    // path can't reach the host. Direct SSH from the operator's machine
    // using `~/.ssh/id_*` default keys.
    let ssh_sessions = node_ssh::NodeSshSessions::new();
    reg.register(Arc::new(node_ssh::NodeSshOpen::new(
        app.clone(),
        cluster.clone(),
        ssh_sessions.clone(),
    )));
    reg.register(Arc::new(node_ssh::NodeSshExec::new(ssh_sessions.clone())));
    reg.register(Arc::new(node_ssh::NodeSshClose::new(ssh_sessions)));

    // Read-only synthesis tools.
    reg.register(Arc::new(workload::WorkloadSummary::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(diagnose::PodDiagnose::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(diagnose::NodeDiagnose::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(metrics::MetricsPod::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(metrics::MetricsNode::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(prom::PrometheusQuery::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(logs::LogsTail::new(app.clone(), cluster.clone())));
    reg.register(Arc::new(helm::HelmList::new(app.clone(), cluster.clone())));
    reg.register(Arc::new(helm::HelmReleaseGet::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(helm::HelmHistory::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(helm::HelmInstall::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(helm::HelmUninstall::new(
        app.clone(),
        cluster.clone(),
    )));

    // Generic K8s primitives — what the external MCP server used to
    // provide. Pods (list/get/delete/run), arbitrary resources by GVK
    // (list/get/delete/scale/apply-from-yaml), namespaces, events,
    // node-side kubelet logs + stats summary, and config introspection.
    reg.register(Arc::new(pods::PodsList::new(app.clone(), cluster.clone())));
    reg.register(Arc::new(pods::PodsGet::new(app.clone(), cluster.clone())));
    reg.register(Arc::new(pods::PodsDelete::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(pods::PodsRun::new(app.clone(), cluster.clone())));
    reg.register(Arc::new(resources::ResourcesList::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesGet::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesDelete::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesScale::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesApply::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(events::EventsList::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(namespaces::NamespacesList::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(nodes_kubelet::NodesLog::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(nodes_kubelet::NodesStatsSummary::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(config_view::ConfigurationView::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(config_view::ConfigurationContextsList::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(config_view::ConfigurationUseContext::new(
        app.clone(),
        cluster.clone(),
    )));

    // Port-forward control. Operator-owned: `on_chat_close` does NOT tear
    // these down (forwards opened by the agent live on in the dock).
    reg.register(Arc::new(portforward::PortForwardList::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(portforward::PortForwardOpen::new(
        app.clone(),
        cluster.clone(),
    )));
    reg.register(Arc::new(portforward::PortForwardClose::new(app.clone())));

    // HTTP probe — no per-cluster state, so no AppHandle/cluster capture.
    reg.register(Arc::new(http_fetch::HttpFetch::new()));

    // Pause — stateless sleep helper for poll loops.
    reg.register(Arc::new(pause::Pause::new()));

    // Rollout snapshot — pairs with fs_pause for deploy/sts/ds wait loops.
    reg.register(Arc::new(rollout::RolloutStatus::new(
        app.clone(),
        cluster.clone(),
    )));

    // SubjectAccessReview wrapper.
    reg.register(Arc::new(can_i::CanI::new(app.clone(), cluster.clone())));

    // SSA apply — write-category, approval-gated. The agent's only
    // mutate-an-arbitrary-resource lever (port-forwards / shells excluded).
    reg.register(Arc::new(apply::ApplyResource::new(
        app.clone(),
        cluster.clone(),
    )));

    // Pod exec — kubectl-exec equivalent against an existing pod.
    reg.register(Arc::new(pod_exec::PodExec::new(app, cluster)));

    reg
}
