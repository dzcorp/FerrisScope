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

/// Build the per-chat native registry. Tools close over `AppHandle` (cheap
/// clone, internally ref-counted) and the chat's `cluster_id`; AppState is
/// fetched per-call via `app.state::<AppState>()` so we don't need to thread
/// an `Arc<AppState>` through the system.
pub(crate) fn build_registry(app: AppHandle, cluster_id: String) -> NativeRegistry {
    let mut reg = NativeRegistry::new();

    // Node shell family — privileged, three-tool session lifecycle.
    let sessions = node_shell::NodeShellSessions::new();
    reg.register(Arc::new(node_shell::NodeShellOpen::new(
        app.clone(),
        cluster_id.clone(),
        sessions.clone(),
    )));
    reg.register(Arc::new(node_shell::NodeShellExec::new(
        app.clone(),
        cluster_id.clone(),
        sessions.clone(),
    )));
    reg.register(Arc::new(node_shell::NodeShellClose::new(
        app.clone(),
        cluster_id.clone(),
        sessions,
    )));

    // Node-SSH family — fallback to node-shell when the kubelet/scheduler
    // path can't reach the host. Direct SSH from the operator's machine
    // using `~/.ssh/id_*` default keys.
    let ssh_sessions = node_ssh::NodeSshSessions::new();
    reg.register(Arc::new(node_ssh::NodeSshOpen::new(
        app.clone(),
        cluster_id.clone(),
        ssh_sessions.clone(),
    )));
    reg.register(Arc::new(node_ssh::NodeSshExec::new(ssh_sessions.clone())));
    reg.register(Arc::new(node_ssh::NodeSshClose::new(ssh_sessions)));

    // Read-only synthesis tools.
    reg.register(Arc::new(workload::WorkloadSummary::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(diagnose::PodDiagnose::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(diagnose::NodeDiagnose::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(metrics::MetricsPod::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(metrics::MetricsNode::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(prom::PrometheusQuery::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(logs::LogsTail::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(helm::HelmList::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(helm::HelmReleaseGet::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(helm::HelmHistory::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(helm::HelmInstall::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(helm::HelmUninstall::new(
        app.clone(),
        cluster_id.clone(),
    )));

    // Generic K8s primitives — what the external MCP server used to
    // provide. Pods (list/get/delete/run), arbitrary resources by GVK
    // (list/get/delete/scale/apply-from-yaml), namespaces, events,
    // node-side kubelet logs + stats summary, and config introspection.
    reg.register(Arc::new(pods::PodsList::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(pods::PodsGet::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(pods::PodsDelete::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(pods::PodsRun::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesList::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesGet::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesDelete::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesScale::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(resources::ResourcesApply::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(events::EventsList::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(namespaces::NamespacesList::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(nodes_kubelet::NodesLog::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(nodes_kubelet::NodesStatsSummary::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(config_view::ConfigurationView::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(config_view::ConfigurationContextsList::new(
        app.clone(),
        cluster_id.clone(),
    )));

    // Port-forward control. Operator-owned: `on_chat_close` does NOT tear
    // these down (forwards opened by the agent live on in the dock).
    reg.register(Arc::new(portforward::PortForwardList::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(portforward::PortForwardOpen::new(
        app.clone(),
        cluster_id.clone(),
    )));
    reg.register(Arc::new(portforward::PortForwardClose::new(
        app.clone(),
        cluster_id.clone(),
    )));

    // HTTP probe — no per-cluster state, so no AppHandle/cluster_id capture.
    reg.register(Arc::new(http_fetch::HttpFetch::new()));

    // Pause — stateless sleep helper for poll loops.
    reg.register(Arc::new(pause::Pause::new()));

    // Rollout snapshot — pairs with fs_pause for deploy/sts/ds wait loops.
    reg.register(Arc::new(rollout::RolloutStatus::new(
        app.clone(),
        cluster_id.clone(),
    )));

    // SubjectAccessReview wrapper.
    reg.register(Arc::new(can_i::CanI::new(app.clone(), cluster_id.clone())));

    // SSA apply — write-category, approval-gated. The agent's only
    // mutate-an-arbitrary-resource lever (port-forwards / shells excluded).
    reg.register(Arc::new(apply::ApplyResource::new(
        app.clone(),
        cluster_id.clone(),
    )));

    // Pod exec — kubectl-exec equivalent against an existing pod.
    reg.register(Arc::new(pod_exec::PodExec::new(app, cluster_id)));

    reg
}
