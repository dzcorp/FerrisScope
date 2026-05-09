// Typed wrappers around invoke(). Components must go through here — never call
// invoke() with stringly-typed names directly.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AiSettingsPatch,
  AiSettingsWire,
  ApplyResult,
  AppInfo,
  ApprovalDecision,
  ApprovalMode,
  ChatInitialMcp,
  ChatOpenResult,
  ChatTool,
  KubectlDetection,
  KubectlInstallResult,
  ChatEvent,
  ClusterHealthEvent,
  ClusterInfo,
  ClusterProbe,
  ClusterRoleBindingDetail,
  ClusterRoleDetail,
  ConfigMapDetail,
  ConfigMapKeysSummary,
  ContextInfo,
  CronJobDetail,
  DaemonSetDetail,
  DeploymentDetail,
  DocApplyResult,
  DrainReport,
  EndpointSliceDetail,
  EndpointsDetail,
  EventDetail,
  ForwardEntry,
  ForwardStatusEvent,
  ForwardTarget,
  HorizontalPodAutoscalerDetail,
  IngressClassDetail,
  IngressDetail,
  JobDetail,
  KubeconfigSettings,
  KubeconfigSource,
  SshSourceInput,
  SshTestResult,
  LeaseDetail,
  ModelInfo,
  Credential,
  ProviderKind,
  McpServerConfig,
  McpTestResult,
  ProviderTestRequest,
  ProviderTestResult,
  SessionData,
  SessionMeta,
  LimitRangeDetail,
  LogEvent,
  TerminalEvent,
  MetricsSnapshot,
  MutatingWebhookConfigurationDetail,
  NamespaceDetail,
  NetworkPolicyDetail,
  NodeDetail,
  PersistentVolumeClaimDetail,
  PersistentVolumeDetail,
  PodDetail,
  PodDisruptionBudgetDetail,
  PriorityClassDetail,
  ReplicationControllerDetail,
  ValidatingWebhookConfigurationDetail,
  Prefs,
  PromCacheEntry,
  PromChangedEvent,
  PromTarget,
  ReleaseInfo,
  ReplicaSetDetail,
  ResourceDelta,
  ResourceKind,
  ResourceQuotaDetail,
  ResourceRow,
  RestartPodsReport,
  SearchHit,
  RoleBindingDetail,
  RoleDetail,
  HelmChartDetail,
  HelmInstallResult,
  HelmReleaseDetail,
  HelmUpgradeResult,
  PvcSummary,
  SecretDetail,
  SecretKeysSummary,
  ServiceAccountDetail,
  ServiceDetail,
  StatefulSetDetail,
  StorageClassDetail,
  CustomResourceDefinitionDetail,
  CustomResourceDetail,
  SubscribeResult,
  TableView,
  TableViewsFile,
  UpdateCheckOutcome,
  UpdaterInfo,
} from "./types";

export const api = {
  ping: () => invoke<AppInfo>("ping"),
  updaterInfo: () => invoke<UpdaterInfo>("updater_info"),
  checkForUpdate: () => invoke<UpdateCheckOutcome>("check_for_update"),
  applyUpdate: (release: ReleaseInfo) =>
    invoke<void>("apply_update", { release }),
  listContexts: () => invoke<ContextInfo[]>("list_contexts"),
  connectContext: (name: string, connectId: string) =>
    invoke<ClusterInfo>("connect_context", { name, connectId }),
  cancelConnect: (connectId: string) =>
    invoke<void>("cancel_connect", { connectId }),

  listResourceKinds: () => invoke<ResourceKind[]>("list_resource_kinds"),
  // CRD-derived dynamic kinds. Per-cluster (CRDs are cluster-local), so
  // unlike `listResourceKinds` this needs a connected `clusterId`.
  listCustomResourceKinds: (clusterId: string) =>
    invoke<ResourceKind[]>("list_custom_resource_kinds", { clusterId }),
  subscribeResource: (
    clusterId: string,
    kindId: string,
    namespaceFilter: string | null = null,
  ) =>
    invoke<SubscribeResult>("subscribe_resource", {
      clusterId,
      kindId,
      namespaceFilter,
    }),
  unsubscribeResource: (clusterId: string, kindId: string) =>
    invoke<void>("unsubscribe_resource", { clusterId, kindId }),
  // Force-drop every running watcher for a cluster. Use when leaving the
  // cluster (context switch) so we don't carry idle watch streams on the
  // cluster we're no longer viewing — bypasses the per-watcher linger.
  dropClusterWatchers: (clusterId: string) =>
    invoke<void>("drop_cluster_watchers", { clusterId }),
  // Drop the wedged ClusterEntry so the next `connect_context` rebuilds
  // from a fresh kube `Client`. Wired to the unavailable banner's
  // Reconnect button — the cluster's HTTP/2 pool may have stalled and
  // reusing it would just keep failing.
  reconnectCluster: (clusterId: string) =>
    invoke<void>("reconnect_cluster", { clusterId }),
  // Header-palette full-text search across the cluster's index. Returns up
  // to `limit` hits (FTS5 bm25 ranked) or an empty array if the cluster
  // hasn't been connected yet (or its index failed to open).
  searchClusterIndex: (clusterId: string, query: string, limit: number) =>
    invoke<SearchHit[]>("search_cluster_index", { clusterId, query, limit }),
  getResourceYaml: (
    clusterId: string,
    kindId: string,
    namespace: string | null,
    name: string,
  ) =>
    invoke<string>("get_resource_yaml_cmd", {
      clusterId,
      kindId,
      namespace,
      name,
    }),
  getPodDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<PodDetail>("get_pod_detail_cmd", { clusterId, namespace, name }),
  getDeploymentDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<DeploymentDetail>("get_deployment_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getReplicaSetDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<ReplicaSetDetail>("get_replica_set_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getStatefulSetDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<StatefulSetDetail>("get_stateful_set_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getDaemonSetDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<DaemonSetDetail>("get_daemon_set_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getJobDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<JobDetail>("get_job_detail_cmd", { clusterId, namespace, name }),
  getCronJobDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<CronJobDetail>("get_cron_job_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getNodeDetail: (clusterId: string, name: string) =>
    invoke<NodeDetail>("get_node_detail_cmd", { clusterId, name }),
  getNamespaceDetail: (clusterId: string, name: string) =>
    invoke<NamespaceDetail>("get_namespace_detail_cmd", { clusterId, name }),
  getEventDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<EventDetail>("get_event_detail_cmd", { clusterId, namespace, name }),
  getServiceDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<ServiceDetail>("get_service_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getEndpointsDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<EndpointsDetail>("get_endpoints_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getEndpointSliceDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<EndpointSliceDetail>("get_endpoint_slice_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getIngressDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<IngressDetail>("get_ingress_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getIngressClassDetail: (clusterId: string, name: string) =>
    invoke<IngressClassDetail>("get_ingress_class_detail_cmd", {
      clusterId,
      name,
    }),
  getNetworkPolicyDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<NetworkPolicyDetail>("get_network_policy_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getConfigMapDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<ConfigMapDetail>("get_config_map_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getSecretDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<SecretDetail>("get_secret_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  /// Light "name + keys" projection of every ConfigMap in a namespace.
  /// Used by the env-ref picker; not cached (refetched per-open).
  listConfigMapsInNamespace: (clusterId: string, namespace: string) =>
    invoke<ConfigMapKeysSummary[]>("list_config_maps_in_namespace_cmd", {
      clusterId,
      namespace,
    }),
  /// Same shape against Secrets — keys come from `data` only (`string_data`
  /// is write-only and never returned by GET). Values are not included.
  listSecretsInNamespace: (clusterId: string, namespace: string) =>
    invoke<SecretKeysSummary[]>("list_secrets_in_namespace_cmd", {
      clusterId,
      namespace,
    }),
  /// Light projection of every PVC in a namespace. Used by the volume
  /// picker. Carries storage_class + requested_storage for disambiguation.
  listPvcsInNamespace: (clusterId: string, namespace: string) =>
    invoke<PvcSummary[]>("list_persistent_volume_claims_in_namespace_cmd", {
      clusterId,
      namespace,
    }),
  getHelmReleaseDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<HelmReleaseDetail>("get_helm_release_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  upgradeHelmRelease: (
    clusterId: string,
    namespace: string,
    name: string,
    valuesYaml: string,
    // Pass both to override the chart (e.g. for an "Upgrade to 1.2.3"
    // banner click); pass neither to keep the existing chart unchanged
    // (Save edited values).
    chartSource?: string,
    chartVersion?: string,
  ) =>
    invoke<HelmUpgradeResult>("upgrade_helm_release_cmd", {
      clusterId,
      namespace,
      name,
      valuesYaml,
      chartSource: chartSource ?? null,
      chartVersion: chartVersion ?? null,
    }),
  helmRepoUpdate: () => invoke<number>("helm_repo_update_cmd"),
  getHelmChartDetail: (
    clusterId: string,
    source: string,
    chartName: string,
    chartVersion: string,
  ) =>
    invoke<HelmChartDetail>("get_helm_chart_detail_cmd", {
      clusterId,
      source,
      chartName,
      chartVersion,
    }),
  installHelmChart: (
    clusterId: string,
    source: string,
    namespace: string,
    releaseName: string,
    chartName: string,
    chartVersion: string,
    valuesYaml: string,
  ) =>
    invoke<HelmInstallResult>("install_helm_chart_cmd", {
      clusterId,
      source,
      namespace,
      releaseName,
      chartName,
      chartVersion,
      valuesYaml,
    }),
  getResourceQuotaDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<ResourceQuotaDetail>("get_resource_quota_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getLimitRangeDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<LimitRangeDetail>("get_limit_range_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getPersistentVolumeClaimDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<PersistentVolumeClaimDetail>("get_persistent_volume_claim_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getPersistentVolumeDetail: (clusterId: string, name: string) =>
    invoke<PersistentVolumeDetail>("get_persistent_volume_detail_cmd", {
      clusterId,
      name,
    }),
  getStorageClassDetail: (clusterId: string, name: string) =>
    invoke<StorageClassDetail>("get_storage_class_detail_cmd", {
      clusterId,
      name,
    }),
  getCustomResourceDefinitionDetail: (clusterId: string, name: string) =>
    invoke<CustomResourceDefinitionDetail>(
      "get_custom_resource_definition_detail_cmd",
      { clusterId, name },
    ),
  getCustomResourceDetail: (
    clusterId: string,
    kindId: string,
    namespace: string | null,
    name: string,
  ) =>
    invoke<CustomResourceDetail>("get_custom_resource_detail_cmd", {
      clusterId,
      kindId,
      namespace,
      name,
    }),
  getServiceAccountDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<ServiceAccountDetail>("get_service_account_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getRoleDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<RoleDetail>("get_role_detail_cmd", { clusterId, namespace, name }),
  getRoleBindingDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<RoleBindingDetail>("get_role_binding_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getClusterRoleDetail: (clusterId: string, name: string) =>
    invoke<ClusterRoleDetail>("get_cluster_role_detail_cmd", {
      clusterId,
      name,
    }),
  getClusterRoleBindingDetail: (clusterId: string, name: string) =>
    invoke<ClusterRoleBindingDetail>("get_cluster_role_binding_detail_cmd", {
      clusterId,
      name,
    }),
  getHorizontalPodAutoscalerDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<HorizontalPodAutoscalerDetail>(
      "get_horizontal_pod_autoscaler_detail_cmd",
      { clusterId, namespace, name },
    ),
  getPodDisruptionBudgetDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<PodDisruptionBudgetDetail>("get_pod_disruption_budget_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getPriorityClassDetail: (clusterId: string, name: string) =>
    invoke<PriorityClassDetail>("get_priority_class_detail_cmd", {
      clusterId,
      name,
    }),
  getReplicationControllerDetail: (
    clusterId: string,
    namespace: string,
    name: string,
  ) =>
    invoke<ReplicationControllerDetail>(
      "get_replication_controller_detail_cmd",
      { clusterId, namespace, name },
    ),
  getLeaseDetail: (clusterId: string, namespace: string, name: string) =>
    invoke<LeaseDetail>("get_lease_detail_cmd", {
      clusterId,
      namespace,
      name,
    }),
  getMutatingWebhookConfigurationDetail: (clusterId: string, name: string) =>
    invoke<MutatingWebhookConfigurationDetail>(
      "get_mutating_webhook_configuration_detail_cmd",
      { clusterId, name },
    ),
  getValidatingWebhookConfigurationDetail: (clusterId: string, name: string) =>
    invoke<ValidatingWebhookConfigurationDetail>(
      "get_validating_webhook_configuration_detail_cmd",
      { clusterId, name },
    ),
  // Generic detail getter for any well-known dynamic kind (Gateway API,
  // future Argo / Cert-Manager / Istio overrides). The backend resolves
  // the override by parsing `kindId` (the `wkcrd:…` form) and returns the
  // rich projection. Caller picks the right return type.
  getWellKnownDetail: <T>(
    clusterId: string,
    kindId: string,
    namespace: string | null,
    name: string,
  ) =>
    invoke<T>("get_well_known_detail_cmd", {
      clusterId,
      kindId,
      namespace,
      name,
    }),

  // Delete a single resource. `gracePeriodSeconds = 0` is a force delete;
  // `null` uses the kind's default grace period.
  deleteResource: (
    clusterId: string,
    kindId: string,
    namespace: string | null,
    name: string,
    gracePeriodSeconds: number | null,
  ) =>
    invoke<void>("delete_resource_cmd", {
      clusterId,
      kindId,
      namespace,
      name,
      gracePeriodSeconds,
    }),

  // Server-Side Apply with field manager `ferrisscope`. `fields` is the
  // partial object tree we want to own — the backend attaches apiVersion /
  // kind / metadata.name. `force=false` returns a Conflict variant when
  // another manager owns one of the fields; the UI re-invokes with
  // `force=true` after operator confirmation.
  applyResource: (
    clusterId: string,
    kindId: string,
    namespace: string | null,
    name: string,
    fields: Record<string, unknown>,
    force: boolean,
  ) =>
    invoke<ApplyResult>("apply_resource_cmd", {
      clusterId,
      kindId,
      namespace,
      name,
      fields,
      force,
    }),

  // Cordon (cordon=true) or uncordon (false) a node. Patches
  // spec.unschedulable via SSA so consecutive toggles don't conflict.
  cordonNode: (clusterId: string, name: string, cordon: boolean) =>
    invoke<void>("cordon_node_cmd", { clusterId, name, cordon }),

  // Cordon, then evict every pod on the node (DaemonSet + mirror pods are
  // always skipped; bare pods are skipped unless `force=true`). Returns a
  // per-pod report so the UI can surface PDB blocks etc.
  drainNode: (clusterId: string, name: string, force: boolean) =>
    invoke<DrainReport>("drain_node_cmd", { clusterId, name, force }),

  // Pods scheduled on a given node. Same row shape as the pod table watcher.
  listPodsOnNode: (clusterId: string, node: string) =>
    invoke<ResourceRow[]>("list_pods_on_node_cmd", { clusterId, node }),

  // Trigger `kubectl rollout restart`-equivalent for the pod's owning
  // workload (Deployment/STS/DS). Returns [ownerKind, ownerName].
  restartPod: (clusterId: string, namespace: string, name: string) =>
    invoke<[string, string]>("restart_pod_cmd", { clusterId, namespace, name }),

  // Bulk restart. Walks each pod's owner server-side, dedupes by workload,
  // patches each unique workload exactly once with one shared timestamp.
  // Three pods owned by the same Deployment → one rollout, not three.
  restartPods: (clusterId: string, pods: [string, string][]) =>
    invoke<RestartPodsReport>("restart_pods_cmd", { clusterId, pods }),

  // Direct rollout-restart on a workload (Deployment / StatefulSet / DaemonSet).
  // Goes through a JSON merge-patch on the backend — distinct from
  // `applyResource` (SSA), which would null `selector` / `containers` on a
  // partial-payload Deployment apply and get rejected with 422.
  restartWorkload: (
    clusterId: string,
    kind: string,
    namespace: string,
    name: string,
  ) =>
    invoke<void>("restart_workload_cmd", { clusterId, kind, namespace, name }),

  // Logs flow over a Tauri IPC `Channel<LogEvent>` rather than the global
  // event bus — it skips the listener fan-out and the `logs://{id}` string
  // dispatch, which matters for the highest-bandwidth surface in the app.
  // The handler is supplied at start time (channels are bound at invoke); the
  // returned `close` detaches it so late deliveries don't fire after unmount.
  // The backend stream itself is still torn down via `stopLogStream(id)`.
  startLogStream: async (
    clusterId: string,
    namespace: string,
    pod: string,
    container: string | null,
    onEvent: (evt: LogEvent) => void,
  ): Promise<{ streamId: string; close: () => void }> => {
    const channel = new Channel<LogEvent>();
    channel.onmessage = onEvent;
    const streamId = await invoke<string>("start_log_stream", {
      clusterId,
      namespace,
      pod,
      container,
      onEvent: channel,
    });
    return {
      streamId,
      close: () => {
        // No-op handler to drop further messages; the backend stops sending
        // once `stopLogStream` runs, but races between the abort and the last
        // few frames arriving over IPC are real on slow machines.
        channel.onmessage = () => {};
      },
    };
  },
  stopLogStream: (streamId: string) =>
    invoke<void>("stop_log_stream", { streamId }),

  // Metrics-server snapshots — pods (cpu_milli + mem_mib) keyed by uid, plus
  // a cluster aggregate. Returns the cached snapshot if metrics are already
  // running for the cluster. Future updates flow over `metrics://{cluster}`.
  subscribeMetrics: (clusterId: string) =>
    invoke<MetricsSnapshot | null>("subscribe_metrics", { clusterId }),
  unsubscribeMetrics: (clusterId: string) =>
    invoke<void>("unsubscribe_metrics", { clusterId }),

  // Fleet probes — per-context summary cards. Cached to disk; only re-probed
  // hourly unless `force=true`.
  getFleetCache: () =>
    invoke<Record<string, ClusterProbe>>("get_fleet_cache"),
  refreshFleet: (contexts: string[], force = false) =>
    invoke<void>("refresh_fleet", { contexts, force }),

  // Kubeconfig sources — default kubeconfig is implicit; this list is the
  // user-added files / folders that get merged into the fleet view.
  listKubeconfigSources: () =>
    invoke<KubeconfigSettings>("list_kubeconfig_sources"),
  addKubeconfigSource: (path: string) =>
    invoke<KubeconfigSource>("add_kubeconfig_source", { path }),
  addKubeconfigSshSource: (input: SshSourceInput) =>
    invoke<KubeconfigSource>("add_kubeconfig_ssh_source", { input }),
  updateKubeconfigSshSource: (id: string, input: SshSourceInput) =>
    invoke<KubeconfigSource>("update_kubeconfig_ssh_source", { id, input }),
  testSshKubeconfigSource: (input: SshSourceInput) =>
    invoke<SshTestResult>("test_ssh_kubeconfig_source", { input }),
  removeKubeconfigSource: (id: string) =>
    invoke<void>("remove_kubeconfig_source", { id }),
  updateKubeconfigSource: (
    id: string,
    patch: { groupOverride?: string | null; enabled?: boolean },
  ) =>
    invoke<KubeconfigSource>("update_kubeconfig_source", {
      id,
      patch: {
        // The Rust side uses Option<Option<String>>: omit field = "leave alone",
        // present field = "set to this value (null clears)". Serialize matches.
        ...(patch.groupOverride !== undefined
          ? { group_override: patch.groupOverride }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    }),
  setDefaultKubeconfigDisabled: (disabled: boolean) =>
    invoke<void>("set_default_kubeconfig_disabled", { disabled }),

  // Per-context mutations driven from the fleet right-click menu.
  // `cluster_id` is the composite ContextInfo.id ("<sourceId>::<ctxName>").
  deleteKubeconfigContext: (clusterId: string) =>
    invoke<void>("delete_kubeconfig_context", { clusterId }),
  setCurrentKubeconfigContext: (clusterId: string) =>
    invoke<void>("set_current_kubeconfig_context", { clusterId }),
  deleteKubeconfigFile: (clusterId: string) =>
    invoke<void>("delete_kubeconfig_file", { clusterId }),

  // Per-(cluster, kind) table view state. One global JSON file on disk; we
  // hydrate every view at startup and overwrite a single entry on change.
  getTableViews: () => invoke<TableViewsFile>("get_table_views"),
  setTableView: (clusterId: string, kindId: string, view: TableView) =>
    invoke<void>("set_table_view", { clusterId, kindId, view }),

  // User prefs (theme, settings panel values, small UI state). Single file
  // at `<config>/prefs.json`. Hydrated once at startup; the store debounces
  // writes back through setPrefs.
  getPrefs: () => invoke<Prefs>("get_prefs"),
  setPrefs: (prefs: Prefs) => invoke<void>("set_prefs", { prefs }),

  // ── Port forwarding ────────────────────────────────────────────────────
  // Bind a local TCP listener bridged to a pod's portforward subresource.
  // Service / workload targets re-resolve the backing pod per connection so
  // the listener survives pod restarts. `pinned: true` persists the spec
  // across app restarts; ephemeral forwards (default) live in memory only.
  // A duplicate (cluster, target, remote_port) triple returns the existing
  // entry instead of binding a second listener.
  pfStart: (
    clusterId: string,
    target: ForwardTarget,
    remotePort: number,
    requestedLocalPort: number | null,
    pinned: boolean,
  ) =>
    invoke<ForwardEntry>("pf_start", {
      clusterId,
      target,
      remotePort,
      requestedLocalPort,
      pinned,
    }),
  pfStop: (id: string) => invoke<void>("pf_stop", { id }),
  pfList: () => invoke<ForwardEntry[]>("pf_list"),
  // Toggle the pin on an existing forward without tearing the listener down.
  pfSetAutostart: (id: string, pinned: boolean) =>
    invoke<void>("pf_set_autostart", { id, pinned }),

  // Multi-doc YAML apply (Create-from-YAML). Backend never errors as a
  // whole — per-doc results carry status, conflicts, and dry-run flag.
  applyYaml: (
    clusterId: string,
    yaml: string,
    dryRun: boolean,
    force: boolean,
  ) =>
    invoke<DocApplyResult[]>("apply_yaml_cmd", {
      clusterId,
      yaml,
      dryRun,
      force,
    }),

  // ── Terminal (PTY) ─────────────────────────────────────────────────────
  // PTY output flows over a per-session Tauri IPC `Channel<TerminalEvent>`
  // rather than the global event bus — typed payload, no string-keyed
  // dispatch, no listener fan-out per chunk. The wrapper builds the channel,
  // routes `data` / `exit` to the supplied callbacks, and returns the
  // session id plus a `close` that detaches further messages so a late
  // chunk arriving after unmount can't reach a stale `term`. The PTY
  // itself is still torn down via `terminalClose(sessionId)`.
  //
  // Open a local-shell session pinned to the cluster's context. The shell
  // inherits a scratch KUBECONFIG so plain `kubectl` targets the right
  // cluster. `namespace` (when set) becomes the default namespace for that
  // context.
  terminalOpenShell: async (
    clusterId: string,
    namespace: string | null,
    onData: (b64: string) => void,
    onExit: (code: number) => void,
  ): Promise<{ sessionId: string; close: () => void }> => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (evt) => {
      if (evt.kind === "data") onData(evt.b64);
      else onExit(evt.code);
    };
    const sessionId = await invoke<string>("terminal_open_shell", {
      clusterId,
      namespace,
      onEvent: channel,
    });
    return {
      sessionId,
      close: () => {
        channel.onmessage = () => {};
      },
    };
  },

  // Open a `kubectl exec -it` against a pod (Pod / Node entry points).
  // `command` defaults to a shell-detection probe (`bash` or `sh`).
  terminalOpenExec: async (
    clusterId: string,
    namespace: string,
    pod: string,
    container: string | null,
    command: string[] | null,
    onData: (b64: string) => void,
    onExit: (code: number) => void,
  ): Promise<{ sessionId: string; close: () => void }> => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (evt) => {
      if (evt.kind === "data") onData(evt.b64);
      else onExit(evt.code);
    };
    const sessionId = await invoke<string>("terminal_open_exec", {
      clusterId,
      namespace,
      pod,
      container,
      command,
      onEvent: channel,
    });
    return {
      sessionId,
      close: () => {
        channel.onmessage = () => {};
      },
    };
  },

  // Generic kubectl invocation in a PTY. Used for node-debug and any other
  // surface that wants a one-shot kubectl command run inside a real terminal.
  // `cleanup` describes a pod the backend should delete when the session
  // ends — node debug uses this so the debug pod doesn't outlive its tab.
  terminalOpenKubectl: async (
    clusterId: string,
    namespace: string | null,
    args: string[],
    customProfile: string | null,
    cleanup: { clusterId: string; namespace: string; name: string } | null,
    onData: (b64: string) => void,
    onExit: (code: number) => void,
  ): Promise<{ sessionId: string; close: () => void }> => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (evt) => {
      if (evt.kind === "data") onData(evt.b64);
      else onExit(evt.code);
    };
    const sessionId = await invoke<string>("terminal_open_kubectl", {
      clusterId,
      namespace,
      args,
      customProfile,
      cleanup: cleanup
        ? {
            cluster_id: cleanup.clusterId,
            namespace: cleanup.namespace,
            name: cleanup.name,
          }
        : null,
      onEvent: channel,
    });
    return {
      sessionId,
      close: () => {
        channel.onmessage = () => {};
      },
    };
  },

  terminalWrite: (sessionId: string, b64: string) =>
    invoke<void>("terminal_write", { sessionId, b64 }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  terminalClose: (sessionId: string) =>
    invoke<void>("terminal_close", { sessionId }),

  // Hand a URL off to the OS default opener (browser for http(s)). Used by
  // the port-forward "Open" affordance so the operator doesn't have to copy
  // the local address into a browser themselves.
  openExternal: (url: string) => openUrl(url),

  // ── Prometheus (read-only) ─────────────────────────────────────────────
  // Discovery scans Services with the two most-common label conventions
  // (kube-prometheus-stack + the legacy `app=prometheus`); empty array
  // means "none found, configure manually". Selection is persisted in the
  // prefs file under `prometheus_targets[clusterId]`. PromQL queries are
  // proxied through the apiserver — RBAC for `services/proxy` is required.
  discoverPrometheusTargets: (clusterId: string) =>
    invoke<PromTarget[]>("discover_prometheus_targets", { clusterId }),
  // Returns the cached entry: `{ target, source, last_validated_at_unix_ms }`
  // or null. `source: "auto"` means we picked it on connect; `"user"` means
  // the operator picked it in Settings. Either kind is queryable.
  getPrometheusTarget: (clusterId: string) =>
    invoke<PromCacheEntry | null>("get_prometheus_target", { clusterId }),
  setPrometheusTarget: (clusterId: string, target: PromTarget | null) =>
    invoke<void>("set_prometheus_target", { clusterId, target }),
  // Force re-detect. Validates a healthy User entry's freshness; replaces
  // a stale Auto entry; leaves an unhealthy User entry alone.
  prometheusRedetect: (clusterId: string) =>
    invoke<void>("prometheus_redetect", { clusterId }),
  prometheusQueryInstant: (clusterId: string, query: string) =>
    invoke<unknown>("prometheus_query_instant", { clusterId, query }),
  prometheusQueryRange: (
    clusterId: string,
    query: string,
    start: string,
    end: string,
    step: string,
  ) =>
    invoke<unknown>("prometheus_query_range", {
      clusterId,
      query,
      start,
      end,
      step,
    }),

  // ── AI agent ───────────────────────────────────────────────────────────
  // Settings live in `<config-dir>/agent_settings.json`; credentials live
  // in the OS keychain (with optional per-provider plaintext fallback).
  // Credentials never round-trip through `aiGetSettings` — the wire shape
  // only reports `configured: bool` per provider.
  aiGetSettings: () => invoke<AiSettingsWire>("ai_get_settings"),
  aiSetSettings: (patch: AiSettingsPatch) =>
    invoke<AiSettingsWire>("ai_set_settings", { patch }),
  /// Persist a credential for `provider`. Used by the API-key form
  /// (pass `{ type: "api_key", key }`).
  aiSetCredential: (provider: ProviderKind, credential: Credential) =>
    invoke<AiSettingsWire>("ai_set_credential", { provider, credential }),
  aiDeleteCredential: (provider: ProviderKind) =>
    invoke<AiSettingsWire>("ai_delete_credential", { provider }),
  /// OAuth login flow. Long-running: opens a browser, listens on a local
  /// loopback port, awaits the callback, persists the resulting OAuth
  /// credential, then resolves with the refreshed settings.
  aiOauthLogin: (provider: ProviderKind) =>
    invoke<AiSettingsWire>("ai_oauth_login", { provider }),
  aiOauthCancel: () => invoke<void>("ai_oauth_cancel"),
  aiTestProvider: (req: ProviderTestRequest) =>
    invoke<ProviderTestResult>("ai_test_provider", { req }),
  mcpTestServer: (config: McpServerConfig) =>
    invoke<McpTestResult>("mcp_test_server", { config }),
  /// List models for the given provider (defaults to the active provider
  /// when omitted). Provider must already have a credential configured.
  aiListModels: (provider?: ProviderKind) =>
    invoke<ModelInfo[]>("ai_list_models", { provider }),

  // Chat sessions are persisted JSONL files under `<config-dir>/agent/`. A
  // chat is bound to one session + one cluster at open time.
  chatCreateSession: (clusterId: string, model: string | null) =>
    invoke<SessionMeta>("chat_create_session", { clusterId, model }),
  chatListSessions: (clusterId: string | null) =>
    invoke<SessionMeta[]>("chat_list_sessions", { clusterId }),
  chatLoadSession: (sessionId: string) =>
    invoke<SessionData>("chat_load_session", { sessionId }),
  chatRenameSession: (sessionId: string, title: string) =>
    invoke<void>("chat_rename_session", { sessionId, title }),
  chatDeleteSession: (sessionId: string) =>
    invoke<void>("chat_delete_session", { sessionId }),

  // Streaming events flow over a Tauri Channel<ChatEvent>, same shape as
  // start_log_stream — typed, no string event keys, no fan-out cost.
  // Returns the initial MCP status snapshot in-band alongside the chat
  // id so the caller can seed UI state synchronously (avoids a race
  // where the streamed `mcp_status` event arrives after the JS-side
  // state-init effects).
  chatOpen: async (
    sessionId: string,
    onEvent: (evt: ChatEvent) => void,
  ): Promise<{
    chatId: string;
    initialMcp: ChatInitialMcp;
    contextLimit: number;
    usableContext: number;
    close: () => void;
  }> => {
    const channel = new Channel<ChatEvent>();
    channel.onmessage = onEvent;
    const result = await invoke<ChatOpenResult>("chat_open", {
      sessionId,
      onEvent: channel,
    });
    return {
      chatId: result.chat_id,
      initialMcp: {
        nativeToolCount: result.native_tool_count,
        servers: result.mcp_servers,
      },
      contextLimit: result.context_limit,
      usableContext: result.usable_context,
      close: () => {
        channel.onmessage = () => {};
      },
    };
  },
  chatSendMessage: (chatId: string, content: string) =>
    invoke<void>("chat_send_message", { chatId, content }),
  chatCancelStreaming: (chatId: string) =>
    invoke<void>("chat_cancel_streaming", { chatId }),
  chatSetApprovalMode: (chatId: string, mode: ApprovalMode) =>
    invoke<void>("chat_set_approval_mode", { chatId, mode }),
  chatSetModel: (chatId: string, model: string) =>
    invoke<void>("chat_set_model", { chatId, model }),
  chatCompact: (chatId: string) => invoke<void>("chat_compact", { chatId }),
  // Re-emit the chat's current McpStatus through its event channel.
  // Frontend pings on tab-becomes-visible / settings-close so the
  // header tools chip stays in sync with the live runtime even if
  // some other UI flow reset the in-memory `view.mcp` snapshot.
  chatRefreshStatus: (chatId: string) =>
    invoke<void>("chat_refresh_status", { chatId }),
  chatListTools: (chatId: string) =>
    invoke<ChatTool[]>("chat_list_tools", { chatId }),
  chatClose: (chatId: string) => invoke<void>("chat_close", { chatId }),
  chatApproveToolCall: (
    chatId: string,
    toolCallId: string,
    decision: ApprovalDecision,
  ) =>
    invoke<void>("chat_approve_tool_call", {
      chatId,
      toolCallId,
      decision,
    }),
  kubectlGetStatus: () => invoke<KubectlDetection>("kubectl_get_status"),
  kubectlInstallManaged: () =>
    invoke<KubectlInstallResult>("kubectl_install_managed"),
  kubectlUninstallManaged: () => invoke<void>("kubectl_uninstall_managed"),
};

// Tauri restricts event names to [A-Za-z0-9_/:-]. Cluster ids embed the
// kubeconfig context name, which can contain `.`, `@`, `+`, etc. The Rust
// emitter applies the same mapping (commands::sanitize_event_segment) so
// both sides compute the same string and listeners actually fire.
function sanitizeEventSegment(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    out += /[A-Za-z0-9_/:-]/.test(c) ? c : "_";
  }
  return out;
}

export function onResourceDelta(
  clusterId: string,
  kindId: string,
  handler: (delta: ResourceDelta) => void,
): Promise<UnlistenFn> {
  const name = `resource://${sanitizeEventSegment(clusterId)}/${sanitizeEventSegment(kindId)}`;
  // Backend emits batched arrays of deltas; older single-delta payloads
  // are tolerated for forward/back compat. Each entry is fed to the
  // handler in order.
  return listen<ResourceDelta | ResourceDelta[]>(name, (e) => {
    const p = e.payload;
    if (Array.isArray(p)) {
      for (const d of p) handler(d);
    } else {
      handler(p);
    }
  });
}

export function onMetrics(
  clusterId: string,
  handler: (snap: MetricsSnapshot) => void,
): Promise<UnlistenFn> {
  const name = `metrics://${sanitizeEventSegment(clusterId)}`;
  return listen<MetricsSnapshot>(name, (e) => handler(e.payload));
}

// Per-cluster health probe events. Backend emits exactly one
// `unavailable` event per cluster lifetime (after 30s of failed probes)
// and then the probe loop exits — `reconnect_cluster` rebuilds the
// entry and re-spawns a fresh probe via the next `connect_context`.
export function onClusterHealth(
  clusterId: string,
  handler: (evt: ClusterHealthEvent) => void,
): Promise<UnlistenFn> {
  const name = `cluster-health://${sanitizeEventSegment(clusterId)}`;
  return listen<ClusterHealthEvent>(name, (e) => handler(e.payload));
}

// Background `cluster.info` probe completed for a cluster. `connect_context`
// returns immediately after the auth handshake with placeholder values
// (server_version: "", node_count: 0); this event delivers the real numbers
// a moment later so the cluster bar can fill them in without blocking the
// user from clicking into a kind.
export function onClusterInfoChanged(
  clusterId: string,
  handler: (info: ClusterInfo) => void,
): Promise<UnlistenFn> {
  const name = `cluster_info://changed/${sanitizeEventSegment(clusterId)}`;
  return listen<ClusterInfo>(name, (e) => handler(e.payload));
}

export function onFleetProbe(
  handler: (probe: ClusterProbe) => void,
): Promise<UnlistenFn> {
  return listen<ClusterProbe>("fleet://probe", (e) => handler(e.payload));
}

// Port-forward status events. Backend emits `{ id, status }` on every
// transition (Listening / Active / Reconnecting / Failed / Stopped). The
// store reconciles against its `Map<id, ForwardEntry>` hydrated by
// `pfList` — entries removed via `pf_stop` arrive as a `stopped` event so
// the UI can drop them without polling.
export function onPortForwardStatus(
  handler: (event: ForwardStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<ForwardStatusEvent>("portforward://status", (e) =>
    handler(e.payload),
  );
}

// Backend emits this whenever the Prometheus cache changes — most notably
// after the on-connect detect task finishes (success or failure). UI hooks
// listen so the metrics tab lights up without polling. Payload includes
// `cluster_id` so a single global listener can route updates to whichever
// cluster the panel is currently rendering.
export function onPrometheusChanged(
  handler: (e: PromChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<PromChangedEvent>("prometheus://changed", (e) =>
    handler(e.payload),
  );
}

// Backend emits this when the file watcher detects a kubeconfig change
// (default file edited, or a file inside a watched folder added/removed/
// modified, or any user-source mutation). The frontend re-runs listContexts()
// on each tick.
export function onKubeconfigChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>("kubeconfig://changed", () => handler());
}
