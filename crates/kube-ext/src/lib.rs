//! ferrisscope-kube-ext
//!
//! Thin helpers on top of `kube-rs`: row projections, resource registry,
//! and a generic reflector that emits JSON-shaped rows so a single Tauri
//! command pair can serve every browseable kind.

pub mod bootstrap;
pub mod fetch;
pub mod kinds;
pub mod portforward;
pub mod registry;
pub mod watcher;
pub mod well_known;

pub use fetch::{
    apply_resource, apply_yaml, delete_resource, discover_crds, drain_node,
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
    helm_available, helm_install_chart, helm_repo_update, helm_uninstall, helm_upgrade,
    list_config_maps_in_namespace, list_persistent_volume_claims_in_namespace, list_pods_on_node,
    list_secrets_in_namespace, restart_pod_owner, restart_pods_owners, restart_workload,
    set_node_cordon, ApplyConflict, ApplyOk, ApplyResult, DocApplyResult, DrainFailure,
    DrainReport, DrainSkipped, FetchError, HelmInstallResult, HelmUpdateAvailable,
    HelmUpgradeResult, RestartFailure, RestartPodsReport, RestartedWorkload, FIELD_MANAGER,
    HELM_CLUSTER_SOURCE,
};
pub use portforward::{
    new_status_channel, snapshot as forward_snapshot, start as start_forward, ForwardEntry,
    ForwardHandle, ForwardStatus, PortForwardError,
};
pub use registry::{
    lookup, registry, Category, ColumnDef, ColumnKind, DiscoveredCrd, DiscoveredPrinterColumn,
    KindSpec, ResourceKind, ResourceKindEntry,
};
pub use watcher::{ResourceDelta, ResourceWatcher};
