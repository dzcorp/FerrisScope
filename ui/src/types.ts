// Mirror of the Rust types returned by Tauri commands.
// Kept hand-written until tauri-specta is wired in.

export type AppInfo = {
  name: string;
  version: string;
};

// Dev-only memory readout for the header HUD. `rss_bytes` is the Rust process's
// resident set; null on platforms where we don't read it (macOS/Windows).
export type DevMemoryStats = {
  rss_bytes: number | null;
};

// Before/after snapshot from a forced mimalloc collect — see
// `dev_compact_memory`. Used by the dev HUD chip to show how much RSS
// the allocator was holding in unreturned arena pages.
export type CompactMemoryResult = {
  rss_before: number | null;
  rss_after: number | null;
  mi_current_commit: number;
  mi_peak_commit: number;
  clusters: number;
  per_cluster: ClusterMemoryInfo[];
  search_indices: number;
  port_forwards: number;
  terminals: number;
  log_streams: number;
  active_connects: number;
  fleet_in_flight: number;
  fleet_cached: number;
  rss_anon_kb: number;
  rss_file_kb: number;
};

export type ClusterMemoryInfo = {
  cluster_id: string;
  kinds_active: number;
  subscribers_total: number;
  metrics_active: boolean;
  search_index_active: boolean;
};

// How this build was installed. Matches Rust `updater::InstallMethod`.
//   - "app_image" / "mac_os_app_bundle" / "windows_nsis" → in-app updater can apply directly
//   - "aur_bin" / "apt_deb" / "rpm_dnf" / "homebrew"     → render `update_hint` instead
//   - "unknown"                                          → operator-placed binary; show releases page
export type InstallMethod =
  | "app_image"
  | "aur_bin"
  | "apt_deb"
  | "rpm_dnf"
  | "mac_os_app_bundle"
  | "homebrew"
  | "windows_nsis"
  | "unknown";

export type UpdaterInfo = {
  current_version: string;
  releases_url: string;
  target: string | null;
  // false when the install method is system-package-managed (aur_bin /
  // apt_deb / rpm_dnf / homebrew) or when the binary is at an unknown path.
  // The frontend surfaces `update_hint` instead of the apply button.
  supported: boolean;
  unsupported_reason: string | null;
  install_method: InstallMethod;
  // Operator-facing command for system-package installs. null on
  // self-updateable methods (apply button) and on `unknown` (releases page).
  update_hint: string | null;
};

export type ReleaseInfo = {
  version: string;
  html_url: string;
  asset_name: string;
  download_url: string;
};

export type UpdateCheckOutcome =
  | { kind: "up_to_date"; latest_version: string; html_url: string }
  | { kind: "update_available"; release: ReleaseInfo };

export type ContextInfo = {
  /// Stable opaque id, e.g. "default::minikube" or "<sourceUuid>::prod-1".
  /// Use this as the cluster_id for every command. The display name is `name`.
  id: string;
  name: string;
  cluster: string;
  user: string | null;
  namespace: string | null;
  is_current: boolean;
  group: string;
  source_id: string;
  source_path: string | null;
};

export type KubeconfigSourceKind = "file" | "folder" | "ssh";

export type SshAuthInput =
  | { kind: "password"; password: string }
  | { kind: "privatekey"; path: string; passphrase?: string | null }
  | { kind: "agent" }
  | { kind: "defaultkeys" };

// Persisted shape of the SSH config — secrets live in the OS keychain, not
// here. `known_host_fingerprint` is captured on first connect (TOFU) and
// pinned for subsequent connects.
export type SshSourceConfig = {
  host: string;
  port: number;
  user: string;
  auth:
    | { kind: "password" }
    | { kind: "privatekey"; path: string; has_passphrase: boolean }
    | { kind: "agent" }
    | { kind: "defaultkeys" };
  remote_kubeconfig: string | null;
  known_host_fingerprint: string | null;
};

export type KubeconfigSource = {
  id: string;
  path: string;
  kind: KubeconfigSourceKind;
  group_override: string | null;
  enabled: boolean;
  ssh?: SshSourceConfig | null;
};

export type SshSourceInput = {
  host: string;
  port: number;
  user: string;
  auth: SshAuthInput;
  remote_kubeconfig?: string | null;
  group_override?: string | null;
};

export type SshTestResult = {
  detected_path: string;
  contexts: string[];
  fingerprint: string | null;
};

export type KubeconfigSettings = {
  default_disabled: boolean;
  last_picked_dir: string | null;
  sources: KubeconfigSource[];
};

// Persisted per-(cluster, kind) table state. The map key is
// `${clusterId}::${kindId}`; one global file lives at
// `<config>/table_views.json`.
export type TableSortEntry = { id: string; desc: boolean };
export type TableView = {
  sorting: TableSortEntry[];
  column_sizing: Record<string, number>;
};
export type TableViewsFile = {
  views: Record<string, TableView>;
};

// Persisted user preferences. Stored at `<config>/prefs.json` next to
// sources/table_views/fleet. Field shape mirrors `crates/core/src/prefs.rs`.
// `selected_namespaces` is a sorted array on the wire (Set on the frontend).
export type PrefsThemeMode = "light" | "dark";
/// Theme record. `id` selects a theme from the bundled registry; `palette_id`
/// picks a palette within it; `mode` chooses the light/dark variant.
/// `overrides` is a free-form bag the Customize UI fills in — kept opaque on
/// the wire so a future schema bump on the override side doesn't break the
/// outer Prefs round-trip.
export type PrefsThemeRecord = {
  id: string;
  palette_id: string;
  mode: PrefsThemeMode;
  overrides: unknown;
};
/// Legacy bare-string form of `prefs.theme` from before the theme record
/// landed. Kept as a wire alternative so the frontend can read older
/// prefs.json files written by Rust binaries that haven't migrated yet —
/// the Rust `parse()` handles the on-disk migration, this alias just keeps
/// the TS type honest for transitional builds.
export type PrefsTheme = PrefsThemeRecord | PrefsThemeMode;
export type PrefsDensity = "compact" | "comfortable" | "spacious";
export type PrefsFleetView = "tiles" | "mini" | "rows";
export type PrefsRailMode = "auto" | "pinned" | "collapsed";
export type PrefsSettings = {
  refresh_sec: number;
  confirm_destructive: boolean;
  show_system_ns: boolean;
  density: PrefsDensity;
  mono_tables: boolean;
  refresh_on_launch: boolean;
  ui_scale: number;
  fleet_view: PrefsFleetView;
};
export type PrefsUiState = {
  selected_context: string | null;
  selected_kind_id: string | null;
  selected_namespaces: string[];
  rail_mode: PrefsRailMode;
  /// Persisted dock pane sizes. `null` ⇒ use the first-launch default.
  dock_size_right: number | null;
  dock_size_bottom: number | null;
};
/// Background update-check state. Mirrors `crates/core/src/prefs.rs::UpdateState`.
/// Persisted so the "v… available" mark on Settings → About survives restarts,
/// and so "Skip this version" is durable until a strictly-newer release ships.
export type PrefsUpdateState = {
  last_known_version: string | null;
  last_seen_version: string | null;
  last_check_at: number;
  auto_check_enabled: boolean;
};
/// Which Prom-API-compatible TSDB the discovered Service appears to be
/// running. Inferred from labels on the backend; only the probe (`up`
/// query) is authoritative for "speaks Prom API". Drives the chart badge.
export type PromBackend =
  | "prometheus"
  | "victoriametrics"
  | "thanos"
  | "mimir"
  | "cortex"
  | "m3"
  | "promscale"
  | "unknown";

export type PromTarget = {
  namespace: string;
  service: string;
  port: number;
  scheme: string;
  /// Inferred backend kind. Older cache entries written before this field
  /// existed deserialize as `"prometheus"` via the Rust `#[serde(default)]`.
  backend: PromBackend;
};
export type Prefs = {
  theme: PrefsTheme;
  settings: PrefsSettings;
  ui: PrefsUiState;
  update: PrefsUpdateState;
};

/// Source of a cached Prometheus target. `User` choices are sticky across
/// auto-detect cycles; `Auto` entries are replaced whenever the cached
/// target stops responding to `up`.
export type PromSource = "user" | "auto";

export type PromCacheEntry = {
  target: PromTarget;
  source: PromSource;
  /// Wall-clock when the target last answered `up` successfully. 0 = never
  /// validated (a freshly user-saved target before its first `up`).
  last_validated_at_unix_ms: number;
};

/// Payload of the `prometheus://changed` event. `entry: null` means
/// detection ran and found nothing (or wiped a stale Auto entry).
export type PromChangedEvent = {
  cluster_id: string;
  entry: PromCacheEntry | null;
};

export type ClusterInfo = {
  server_version: string;
  node_count: number;
};

// Per-cluster apiserver heartbeat status. The backend probes `/version`
// every 5s; after 30s of consecutive failures it flips the cluster to
// `unavailable` and tears down its watchers + metrics service. Recovery
// is operator-driven (Reconnect button → `reconnect_cluster` then
// `connect_context`). There is no intermediate "degraded" state on the
// wire — the backend keeps it internal until the threshold trips.
export type ClusterHealthStatus = "healthy" | "unavailable";

export type ClusterHealthEvent = {
  status: ClusterHealthStatus;
  // Last error reason when `status === "unavailable"`. Surfaced verbatim
  // in the banner; not user-friendly text but operator-debuggable.
  reason: string | null;
};

export type Category =
  | "Workloads"
  | "Network"
  | "Config"
  | "Storage"
  | "Access"
  | "Cluster"
  | "Apps"
  | "CustomResources";

export type ColumnKind = "text" | "number" | "age" | "phase";

export type ColumnDef = {
  id: string;
  header: string;
  kind?: ColumnKind;
};

export type ResourceKind = {
  id: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  category: Category;
  columns: ColumnDef[];
};

/// A row produced by the backend projection. Always contains `uid`; remaining
/// keys correspond to the kind's registered columns. Pod rows additionally
/// carry `containers` for the logs side panel.
export type ResourceRow = {
  uid: string;
  [key: string]: unknown;
};

export type ResourceDelta =
  | { kind: "upsert"; row: ResourceRow }
  | { kind: "delete"; uid: string }
  // Emitted once after the watcher's initial sync completes. The table uses
  // this to drop the loading spinner — without it, an empty kind would
  // briefly flash an "empty cluster" message while the watcher was still
  // listing.
  | { kind: "init_done" };

export type SubscribeResult = {
  rows: ResourceRow[];
  // True when the watcher has already finished its initial sync at the
  // moment we subscribed. False = expect an `init_done` delta later.
  init_done: boolean;
};

// Result row from the per-cluster search index. `blob` is the original
// projected row (same shape as `ResourceRow`) so the palette can render
// inline metadata (status, age) without a second round-trip. `score` is
// FTS5 bm25; lower = more relevant.
export type SearchHit = {
  kind_id: string;
  uid: string;
  namespace: string | null;
  name: string;
  blob: ResourceRow;
  score: number;
};

export type LogEvent =
  | { kind: "line"; text: string }
  | { kind: "batch"; lines: string[] }
  | { kind: "lagged"; dropped: number }
  | { kind: "ended"; reason: string };

// Terminal sessions stream PTY output over a per-session Channel<TerminalEvent>
// (no global event bus). `data` chunks are base64-encoded raw PTY bytes; `exit`
// fires once when the child process closes.
export type TerminalEvent =
  | { kind: "data"; b64: string }
  | { kind: "exit"; code: number };

export type PodMetric = {
  namespace: string;
  name: string;
  cpu_milli: number;
  mem_mib: number;
};

export type ClusterMetrics = {
  cpu_used_milli: number;
  cpu_capacity_milli: number;
  mem_used_mib: number;
  mem_capacity_mib: number;
};

export type VolumeMetric = {
  pod_namespace: string;
  pod_name: string;
  volume_name: string;
  pvc_namespace: string | null;
  pvc_name: string | null;
  used_bytes: number;
  capacity_bytes: number;
  available_bytes: number;
  used_inodes: number;
  capacity_inodes: number;
};

export type MetricsSnapshot = {
  pods: Record<string, PodMetric>;
  cluster: ClusterMetrics | null;
  /// Pod volumes from kubelet stats/summary, keyed by `"{ns}/{pod}"`.
  pod_volumes: Record<string, VolumeMetric[]>;
  /// PVCs keyed by `"{ns}/{claim}"`. Only populated for claims actually
  /// mounted by at least one pod — unmounted claims have no kubelet stats.
  pvcs: Record<string, VolumeMetric>;
  /// metrics-server (CPU / memory) availability.
  available: boolean;
  /// kubelet stats/summary (volumes) availability.
  volumes_available: boolean;
  fetched_at_unix_ms: number;
};

// ── Pod detail (summary tab) ───────────────────────────────────────────────
// Mirrors the Lens overlay layout: a pod-level label/value section + a list
// of per-container cards. Fetched on demand via `get_pod_detail_cmd`, not
// streamed over the watcher bus.

export type ContainerKind = "init" | "main" | "sidecar";

export type PodOwnerRef = {
  kind: string;
  name: string;
};

export type PodToleration = {
  key: string | null;
  operator: string | null;
  value: string | null;
  effect: string | null;
  toleration_seconds: number | null;
};

export type PodCondition = {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
};

export type ContainerPort = {
  name: string | null;
  container_port: number;
  protocol: string | null;
};

// `from` is null for a literal `value` entry, otherwise carries the full
// ref details so the editor can display and round-trip the source without
// a second fetch. Wire shape is the tagged-union JSON produced by
// `crates/kube-ext/src/kinds/pod_template.rs::project_env_var`.
export type EnvValueFrom =
  | {
      kind: "configMapKeyRef";
      // Per the Kubernetes API, a ConfigMap ref's `name` is required; we
      // mirror the Rust `Option<String>` defensively.
      name: string | null;
      key: string;
      optional: boolean;
    }
  | {
      kind: "secretKeyRef";
      name: string | null;
      key: string;
      optional: boolean;
    }
  | {
      kind: "fieldRef";
      // e.g. "metadata.name", "status.podIP", "spec.nodeName".
      field_path: string;
      api_version: string | null;
    }
  | {
      kind: "resourceFieldRef";
      // Optional — defaults to the current container when omitted on apply.
      container_name: string | null;
      // e.g. "limits.cpu", "requests.memory", "limits.ephemeral-storage".
      resource: string;
      // Quantity string ("1m", "1Mi"). Null = apiserver default ("1").
      divisor: string | null;
    };

export type ContainerEnv = {
  name: string;
  value: string | null;
  from: EnvValueFrom | null;
};

// envFrom imports an entire ConfigMap or Secret as env. Each key in the
// source becomes an env var in the container, optionally prefixed.
export type ContainerEnvFrom = {
  // configMapRef / secretRef — discriminator for the source variant.
  kind: "configMapRef" | "secretRef";
  // Empty when the projected source had no name field — frontend treats
  // this as a malformed entry to be repaired by the operator.
  name: string;
  optional: boolean;
  // Prefix applied to every imported key. Null when not set.
  prefix: string | null;
};

export type ContainerMount = {
  name: string;
  mount_path: string;
  read_only: boolean;
  sub_path: string | null;
};

export type ContainerResources = {
  requests: Record<string, string> | null;
  limits: Record<string, string> | null;
};

export type ContainerLastState =
  | {
      kind: "terminated";
      reason: string | null;
      exit_code: number;
      signal: number | null;
      started_at: string | null;
      finished_at: string | null;
      message: string | null;
    }
  | {
      kind: "waiting";
      reason: string | null;
      message: string | null;
    };

export type ContainerSecurity = {
  privileged: boolean | null;
  allow_privilege_escalation: boolean | null;
  read_only_root_filesystem: boolean | null;
  run_as_user: number | null;
  run_as_group: number | null;
  run_as_non_root: boolean | null;
  capabilities_add: string[];
  capabilities_drop: string[];
};

export type ContainerProbe = {
  // http-get / tcp-socket / exec / grpc / unknown
  type: string;
  // Pre-formatted target string ("http://:8123/ping", ":9000", "cat /tmp/ok").
  target: string | null;
  delay: number | null;
  timeout: number | null;
  period: number | null;
  success: number | null;
  failure: number | null;
};

export type PodVolume = {
  name: string;
  // Tag for the source variant (configMap / secret / persistentVolumeClaim /
  // projected / emptyDir / hostPath / downwardAPI / csi / nfs / …). Surfaced
  // verbatim so the UI can colour or group by it later.
  kind: string;
  // For variants backed by a referenced object (configMap.name,
  // secret.secretName, persistentVolumeClaim.claimName, …) — null for
  // in-place sources like emptyDir or downwardAPI.
  source_name: string | null;
  // Kubernetes Kind name to navigate to when the operator clicks the
  // referenced source. Null when there's nothing browseable behind it.
  target_kind: string | null;
  // Opaque round-trip blob — the full Volume object (sans `name`) as
  // received from the apiserver. The editor splices this back unchanged
  // when the operator keeps a volume across edits, so unsupported source
  // fields (projected.sources, configMap.items, …) survive.
  raw: Record<string, unknown> | null;
};

export type ContainerDetail = {
  name: string;
  kind: ContainerKind;
  image: string | null;
  image_id: string | null;
  container_id: string | null;
  image_pull_policy: string | null;
  command: string[] | null;
  args: string[] | null;
  state: string;
  reason: string | null;
  ready: boolean;
  started: boolean | null;
  started_at: string | null;
  restart_count: number;
  last_state: ContainerLastState | null;
  ports: ContainerPort[];
  env: ContainerEnv[];
  env_from: ContainerEnvFrom[];
  mounts: ContainerMount[];
  liveness: ContainerProbe | null;
  readiness: ContainerProbe | null;
  startup: ContainerProbe | null;
  resources: ContainerResources | null;
  security: ContainerSecurity | null;
};

export type PodDetail = {
  name: string;
  namespace: string | null;
  uid: string | null;
  created_at: string | null;
  labels: [string, string][];
  annotations: [string, string][];
  controlled_by: PodOwnerRef | null;
  // Same shape as WorkloadMeta.managers — see FieldManagerInfo.
  managers: FieldManagerInfo[];
  status_phase: string | null;
  status_reason: string | null;
  status_message: string | null;
  node: string | null;
  host_ips: string[];
  pod_ips: string[];
  service_account: string | null;
  qos_class: string | null;
  termination_grace_period_s: number | null;
  priority_class: string | null;
  tolerations: PodToleration[];
  conditions: PodCondition[];
  containers: ContainerDetail[];
  volumes: PodVolume[];
  totals: PodResourceTotals;
  scheduling: PodScheduling | null;
  security: PodSecurity | null;
  image_pull_secrets: string[];
  owners: PodOwner[];
  restart_policy: string | null;
};

export type PodResourceTotals = {
  requests: Record<string, string>;
  limits: Record<string, string>;
};

export type PodOwner = {
  kind: string;
  name: string;
  controller: boolean;
};

export type PodAffinitySummary = {
  required_terms: number;
  preferred_terms: number;
};

export type PodAffinity = {
  node_affinity: PodAffinitySummary | null;
  pod_affinity: PodAffinitySummary | null;
  pod_anti_affinity: PodAffinitySummary | null;
};

export type PodTopologySpread = {
  max_skew: number;
  topology_key: string;
  when_unsatisfiable: string;
  min_domains: number | null;
};

export type PodScheduling = {
  node_selector: [string, string][];
  topology_spread: PodTopologySpread[];
  affinity: PodAffinity | null;
  scheduler_name: string | null;
  priority: number | null;
  runtime_class: string | null;
};

export type PodSecurity = {
  run_as_user: number | null;
  run_as_group: number | null;
  run_as_non_root: boolean | null;
  fs_group: number | null;
  fs_group_change_policy: string | null;
  supplemental_groups: number[] | null;
  seccomp_profile_type: string | null;
  se_linux_type: string | null;
  host_network: boolean | null;
  host_pid: boolean | null;
  host_ipc: boolean | null;
  share_process_namespace: boolean | null;
};

export type RestartedWorkload = {
  kind: string;
  namespace: string;
  name: string;
  // Names of selected pods that mapped to this owner (post-dedup).
  pods: string[];
};

export type RestartFailure = {
  namespace: string;
  pod: string;
  error: string;
};

export type RestartPodsReport = {
  patched: RestartedWorkload[];
  failures: RestartFailure[];
};

// Drain report: per-pod outcome of `kubectl drain`-equivalent. `evicted` lists
// successful evictions ("ns/name"); `skipped` carries DaemonSet pods, mirror
// pods, and bare pods (when `force` was false); `failures` carries everything
// else (most commonly PDB violations).
export type DrainSkipped = {
  namespace: string;
  pod: string;
  reason: string;
};

export type DrainFailure = {
  namespace: string;
  pod: string;
  error: string;
};

export type DrainReport = {
  evicted: string[];
  skipped: DrainSkipped[];
  failures: DrainFailure[];
};

// ── Workload detail (Deployment, ReplicaSet, StatefulSet, DaemonSet, Job,
// CronJob) ─────────────────────────────────────────────────────────────────
// All workload kinds share a common metadata header + a pod-template summary.
// Per-kind shapes diverge in the middle (replicas / completions / schedule).

export type WorkloadOwnerRef = {
  kind: string;
  name: string;
};

// One row of `metadata.managedFields`, deduped by (manager, operation).
// Used by the detail-panel header to surface "this resource is reconciled
// by Flux/Argo/Helm/etc" so the operator isn't surprised by SSA conflicts
// on edit. `time` is the most-recent touch by that manager (ISO 8601).
export type FieldManagerInfo = {
  manager: string;
  // "Apply" | "Update" | "" — `Apply` typically means an automation tool
  // using SSA (kustomize-controller, argocd-application-controller, helm,
  // flux, kapp-controller). `Update` means an old-style PUT/PATCH.
  operation: string;
  time: string | null;
};

export type WorkloadMeta = {
  name: string;
  namespace: string | null;
  uid: string | null;
  created_at: string | null;
  labels: [string, string][];
  annotations: [string, string][];
  controlled_by: WorkloadOwnerRef | null;
  generation: number | null;
  // Aggregated `metadata.managedFields` view. Empty when the apiserver
  // doesn't return managedFields (older clusters, certain CRDs).
  managers: FieldManagerInfo[];
};

export type LabelSelectorSummary = {
  match_labels: [string, string][];
  match_expressions: number;
};

export type WorkloadCondition = {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  last_transition_time: string | null;
};

export type WorkloadContainerSummary = {
  name: string;
  kind: ContainerKind;
  image: string | null;
  image_pull_policy: string | null;
  ports: ContainerPort[];
  env: ContainerEnv[];
  env_from: ContainerEnvFrom[];
  mounts: ContainerMount[];
  requests: Record<string, string> | null;
  limits: Record<string, string> | null;
  command: string[] | null;
  args: string[] | null;
};

export type PodTemplateSummary = {
  labels: [string, string][];
  annotations_count: number;
  containers: WorkloadContainerSummary[];
  service_account: string | null;
  restart_policy: string | null;
  node_selector: [string, string][];
  tolerations_count: number;
  volumes: PodVolume[];
  image_pull_secrets: string[];
  priority_class: string | null;
  host_network: boolean | null;
  host_pid: boolean | null;
  host_ipc: boolean | null;
};

export type RollingUpdateSummary = {
  type: string;
  max_surge?: string | null;
  max_unavailable?: string | null;
  partition?: number | null;
};

export type DeploymentDetail = {
  meta: WorkloadMeta;
  selector: LabelSelectorSummary | null;
  replicas: {
    desired: number;
    ready: number;
    available: number;
    updated: number;
    unavailable: number;
    current: number;
  };
  strategy: RollingUpdateSummary | null;
  min_ready_seconds: number | null;
  progress_deadline_seconds: number | null;
  revision_history_limit: number | null;
  paused: boolean;
  observed_generation: number | null;
  conditions: WorkloadCondition[];
  pod_template: PodTemplateSummary | null;
};

export type ReplicaSetDetail = {
  meta: WorkloadMeta;
  selector: LabelSelectorSummary | null;
  replicas: {
    desired: number;
    ready: number;
    available: number;
    fully_labeled: number;
    current: number;
  };
  min_ready_seconds: number | null;
  observed_generation: number | null;
  conditions: WorkloadCondition[];
  pod_template: PodTemplateSummary | null;
};

export type StatefulSetVolumeClaimTemplate = {
  name: string;
  storage: string | null;
  access_modes: string[];
  storage_class: string | null;
};

export type StatefulSetDetail = {
  meta: WorkloadMeta;
  selector: LabelSelectorSummary | null;
  replicas: {
    desired: number;
    ready: number;
    available: number;
    current: number;
    updated: number;
  };
  service_name: string | null;
  pod_management_policy: string | null;
  update_strategy: RollingUpdateSummary | null;
  revision_history_limit: number | null;
  min_ready_seconds: number | null;
  current_revision: string | null;
  update_revision: string | null;
  observed_generation: number | null;
  conditions: WorkloadCondition[];
  volume_claim_templates: StatefulSetVolumeClaimTemplate[];
  pod_template: PodTemplateSummary | null;
};

export type DaemonSetDetail = {
  meta: WorkloadMeta;
  selector: LabelSelectorSummary | null;
  replicas: {
    desired_scheduled: number;
    current_scheduled: number;
    ready: number;
    available: number;
    unavailable: number;
    up_to_date: number;
    misscheduled: number;
  };
  min_ready_seconds: number | null;
  revision_history_limit: number | null;
  update_strategy: RollingUpdateSummary | null;
  observed_generation: number | null;
  collision_count: number | null;
  conditions: WorkloadCondition[];
  pod_template: PodTemplateSummary | null;
};

export type JobDetail = {
  meta: WorkloadMeta;
  selector: LabelSelectorSummary | null;
  phase: string;
  completions_desired: number | null;
  parallelism: number | null;
  backoff_limit: number | null;
  active_deadline_seconds: number | null;
  ttl_seconds_after_finished: number | null;
  completion_mode: string | null;
  suspend: boolean;
  manual_selector: boolean;
  status: {
    active: number;
    succeeded: number;
    failed: number;
    ready: number | null;
    terminating: number | null;
  };
  start_time: string | null;
  completion_time: string | null;
  conditions: WorkloadCondition[];
  pod_template: PodTemplateSummary | null;
};

export type CronJobActiveRef = {
  kind: string | null;
  name: string | null;
  namespace: string | null;
};

export type CronJobJobTemplateSummary = {
  completions: number | null;
  parallelism: number | null;
  backoff_limit: number | null;
  active_deadline_seconds: number | null;
  ttl_seconds_after_finished: number | null;
};

export type CronJobDetail = {
  meta: WorkloadMeta;
  schedule: string | null;
  time_zone: string | null;
  suspend: boolean;
  concurrency_policy: string | null;
  starting_deadline_seconds: number | null;
  successful_jobs_history_limit: number | null;
  failed_jobs_history_limit: number | null;
  last_schedule_time: string | null;
  last_successful_time: string | null;
  active: CronJobActiveRef[];
  job_template: CronJobJobTemplateSummary | null;
  pod_template: PodTemplateSummary | null;
};

// ── Cluster-scoped detail (Node / Namespace / Event) ──────────────────────
// Same `meta` shape the workload kinds use, then kind-specific status/spec.

export type NodeAddress = {
  type: string;
  address: string;
};

export type NodeTaint = {
  key: string;
  value: string | null;
  effect: string | null;
  time_added: string | null;
};

export type NodeInfo = {
  kubelet_version: string;
  kube_proxy_version: string;
  container_runtime_version: string;
  os_image: string;
  kernel_version: string;
  operating_system: string;
  architecture: string;
  machine_id: string;
  system_uuid: string;
  boot_id: string;
};

export type NodeDetail = {
  meta: WorkloadMeta;
  phase: string;
  roles: string[];
  unschedulable: boolean;
  provider_id: string | null;
  pod_cidrs: string[];
  addresses: NodeAddress[];
  node_info: NodeInfo | null;
  capacity: Record<string, string>;
  allocatable: Record<string, string>;
  taints: NodeTaint[];
  conditions: WorkloadCondition[];
};

export type NamespaceDetail = {
  meta: WorkloadMeta;
  phase: string;
  finalizers: string[];
  conditions: WorkloadCondition[];
};

export type EventInvolvedObject = {
  api_version: string | null;
  kind: string | null;
  namespace: string | null;
  name: string | null;
  uid: string | null;
  field_path: string | null;
  resource_version: string | null;
};

export type EventSource = {
  component: string | null;
  host: string | null;
};

export type EventSeries = {
  count: number | null;
  last_observed_time: string | null;
};

export type EventDetail = {
  meta: WorkloadMeta;
  type: string;
  reason: string | null;
  message: string | null;
  count: number;
  action: string | null;
  reporting_controller: string | null;
  reporting_instance: string | null;
  first_timestamp: string | null;
  last_timestamp: string | null;
  event_time: string | null;
  involved_object: EventInvolvedObject;
  source: EventSource | null;
  related: EventInvolvedObject | null;
  series: EventSeries | null;
};

// ── Network detail (Service, Endpoints, EndpointSlice, Ingress,
// IngressClass, NetworkPolicy) ─────────────────────────────────────────────

export type ServicePort = {
  name: string | null;
  port: number;
  target_port: string | null;
  node_port: number | null;
  protocol: string;
  app_protocol: string | null;
};

export type LoadBalancerIngressPort = {
  port: number;
  protocol: string | null;
  error: string | null;
};

export type LoadBalancerIngress = {
  ip: string | null;
  hostname: string | null;
  ports: LoadBalancerIngressPort[];
};

export type ServiceDetail = {
  meta: WorkloadMeta;
  type: string;
  cluster_ip: string | null;
  cluster_ips: string[];
  external_ips: string[];
  external_name: string | null;
  session_affinity: string | null;
  internal_traffic_policy: string | null;
  external_traffic_policy: string | null;
  ip_families: string[];
  ip_family_policy: string | null;
  load_balancer_class: string | null;
  load_balancer_source_ranges: string[];
  health_check_node_port: number | null;
  publish_not_ready_addresses: boolean | null;
  allocate_load_balancer_node_ports: boolean | null;
  selector: [string, string][];
  ports: ServicePort[];
  load_balancer_ingress: LoadBalancerIngress[];
};

export type EndpointTargetRef = {
  kind: string | null;
  namespace: string | null;
  name: string | null;
  uid: string | null;
};

export type EndpointAddress = {
  ip: string;
  hostname: string | null;
  node_name: string | null;
  target_ref: EndpointTargetRef | null;
};

export type EndpointPort = {
  name: string | null;
  port: number | null;
  protocol: string;
  app_protocol: string | null;
};

export type EndpointSubset = {
  addresses: EndpointAddress[];
  not_ready_addresses: EndpointAddress[];
  ports: EndpointPort[];
};

export type EndpointsDetail = {
  meta: WorkloadMeta;
  subsets: EndpointSubset[];
};

export type EndpointSliceConditions = {
  ready: boolean | null;
  serving: boolean | null;
  terminating: boolean | null;
};

export type EndpointSliceEntry = {
  addresses: string[];
  conditions: EndpointSliceConditions | null;
  hostname: string | null;
  node_name: string | null;
  zone: string | null;
  target_ref: EndpointTargetRef | null;
};

export type EndpointSliceDetail = {
  meta: WorkloadMeta;
  address_type: string;
  service_name: string | null;
  ports: EndpointPort[];
  endpoints: EndpointSliceEntry[];
};

export type IngressBackendService = {
  name: string;
  port_name: string | null;
  port_number: number | null;
};

export type IngressBackendResource = {
  api_group: string | null;
  kind: string;
  name: string;
};

export type IngressBackend = {
  service: IngressBackendService | null;
  resource: IngressBackendResource | null;
};

export type IngressPath = {
  path: string | null;
  path_type: string | null;
  backend: IngressBackend;
};

export type IngressRule = {
  host: string | null;
  paths: IngressPath[];
};

export type IngressTLS = {
  hosts: string[];
  secret_name: string | null;
};

export type IngressDetail = {
  meta: WorkloadMeta;
  ingress_class_name: string | null;
  default_backend: IngressBackend | null;
  tls: IngressTLS[];
  rules: IngressRule[];
  load_balancer_ingress: LoadBalancerIngress[];
};

export type IngressClassParameters = {
  api_group: string | null;
  kind: string;
  name: string;
  namespace: string | null;
  scope: string | null;
};

export type IngressClassDetail = {
  meta: WorkloadMeta;
  controller: string | null;
  parameters: IngressClassParameters | null;
  is_default: boolean;
};

export type NetworkPolicyPort = {
  protocol: string;
  port: string | null;
  end_port: number | null;
};

export type NetworkPolicyIPBlock = {
  cidr: string;
  except: string[];
};

export type NetworkPolicyPeer = {
  ip_block: NetworkPolicyIPBlock | null;
  namespace_selector: LabelSelectorSummary | null;
  pod_selector: LabelSelectorSummary | null;
};

export type NetworkPolicyRule = {
  ports: NetworkPolicyPort[];
  peers: NetworkPolicyPeer[];
};

export type NetworkPolicyDetail = {
  meta: WorkloadMeta;
  pod_selector: LabelSelectorSummary | null;
  policy_types: string[];
  ingress: NetworkPolicyRule[];
  egress: NetworkPolicyRule[];
};

// ── Config detail (ConfigMap, Secret, ResourceQuota, LimitRange) ───────────

export type ConfigMapDataEntry = {
  key: string;
  // For text data the raw string; for binary_data the base64 string the
  // apiserver returned. `binary` discriminates so the UI can label the chip.
  value: string;
  // Decoded byte length — for text it's `value.length` in bytes (utf-8);
  // for binary it's the underlying byte count *before* base64 encoding.
  size: number;
  binary: boolean;
};

export type ConfigMapDetail = {
  meta: WorkloadMeta;
  immutable: boolean;
  data: ConfigMapDataEntry[];
};

// Light projection used by the env-ref picker. Just names + key lists —
// values are deliberately not included (cheaper, and the picker only needs
// to drill from name → key).
export type ConfigMapKeysSummary = {
  name: string;
  keys: string[];
};

export type SecretKeysSummary = {
  name: string;
  keys: string[];
  // Secret type ("Opaque", "kubernetes.io/dockerconfigjson", …). Surfaced so
  // the picker can de-prioritise non-Opaque secrets that operators rarely
  // reference from env.
  type: string;
};

// Light projection used by the volume picker for PersistentVolumeClaim refs.
// `storage_class` and `requested_storage` help disambiguate similarly-named
// claims at a glance.
export type PvcSummary = {
  name: string;
  storage_class: string | null;
  requested_storage: string | null;
};

export type SecretDataEntry = {
  key: string;
  // Base64-encoded value as the apiserver stores it. UI keeps it masked by
  // default; reveal click decodes to show the plaintext. Null means the
  // server returned the value through the write-only `string_data` channel
  // (rare on a fresh GET) and we don't have the base64 form.
  value_b64: string | null;
  // Decoded byte length.
  size: number;
  from_string_data: boolean;
};

export type SecretDetail = {
  meta: WorkloadMeta;
  type_: string;
  immutable: boolean;
  data: SecretDataEntry[];
};

export type HelmReleaseHistoryEntry = {
  revision: number;
  status: string | null;
  updated: string | null;
  description: string | null;
  chart: string | null;
  chart_version: string | null;
  app_version: string | null;
};

export type HelmUpdateAvailable = {
  // Repo name (e.g. "bitnami") this newer version comes from.
  source: string;
  // Newer version available, semver-greater than current.
  version: string;
  app_version: string | null;
};

export type HelmReleaseDetail = {
  name: string;
  namespace: string;
  revision: number;
  status: string | null;
  description: string | null;
  first_deployed: string | null;
  last_deployed: string | null;
  deleted: string | null;
  notes: string | null;
  chart: string | null;
  chart_name: string | null;
  chart_version: string | null;
  app_version: string | null;
  chart_description: string | null;
  chart_home: string | null;
  chart_icon: string | null;
  chart_sources: string[];
  chart_keywords: string[];
  // Operator-supplied values from the last install/upgrade. Free-form JSON.
  values_user: unknown;
  // Default values shipped with the chart.
  values_chart_defaults: unknown;
  manifest: string | null;
  hooks: unknown[];
  history: HelmReleaseHistoryEntry[];
  // True when the host has a `helm` CLI on PATH. Drives whether the
  // upgrade-edit affordance is enabled in the values panel.
  helm_available: boolean;
  // Highest semver-newer version of this chart found in the operator's
  // local helm repo cache, or null when none. Operators run "Update
  // repos" to refresh the cache.
  update_available: HelmUpdateAvailable | null;
};

export type HelmUpgradeResult =
  | {
      kind: "upgraded";
      revision: number;
      status: string | null;
      elapsed_ms: number;
      helm_stdout: string;
    }
  | {
      kind: "failed";
      message: string;
      helm_stderr: string;
      elapsed_ms: number;
    }
  | { kind: "helm_missing" };

export type HelmChartUsedBy = {
  namespace: string;
  name: string;
  revision: number;
  status: string | null;
  updated: string | null;
};

export type HelmChartDetail = {
  // "cluster" for in-cluster charts (extracted from helm release secrets),
  // or the repo name (e.g. "bitnami") for charts from `helm repo list`.
  source: string;
  chart_name: string;
  chart_version: string;
  app_version: string | null;
  description: string | null;
  home: string | null;
  icon: string | null;
  sources: string[];
  keywords: string[];
  // YAML text — the chart's default values, ready to paste into a
  // -f file or edit before install.
  default_values_yaml: string;
  used_by: HelmChartUsedBy[];
  helm_available: boolean;
};

export type HelmInstallResult =
  | {
      kind: "installed";
      revision: number;
      namespace: string;
      release_name: string;
      status: string | null;
      elapsed_ms: number;
      helm_stdout: string;
    }
  | {
      kind: "failed";
      message: string;
      helm_stderr: string;
      elapsed_ms: number;
    }
  | { kind: "helm_missing" };

export type ResourceQuotaEntry = {
  name: string;
  hard: string | null;
  used: string | null;
};

export type ResourceQuotaScopeSelector = {
  scope_name: string;
  operator: string;
  values: string[];
};

export type ResourceQuotaDetail = {
  meta: WorkloadMeta;
  entries: ResourceQuotaEntry[];
  scopes: string[];
  scope_selector: ResourceQuotaScopeSelector[];
};

export type LimitRangeItem = {
  type_: string;
  max: [string, string][];
  min: [string, string][];
  default: [string, string][];
  default_request: [string, string][];
  max_limit_request_ratio: [string, string][];
};

export type LimitRangeDetail = {
  meta: WorkloadMeta;
  limits: LimitRangeItem[];
};

// ── Storage detail (PersistentVolumeClaim, PersistentVolume, StorageClass) ──

export type ObjectRefSummary = {
  kind: string;
  name: string;
  namespace: string | null;
  api_group: string | null;
};

export type PVCDataSourceRef = {
  kind: string | null;
  name: string | null;
  api_group: string | null;
  namespace: string | null;
};

export type PVCAllocatedResources = [string, string][];

export type PersistentVolumeClaimDetail = {
  meta: WorkloadMeta;
  phase: string;
  volume_name: string | null;
  storage_class: string | null;
  access_modes: string[];
  volume_mode: string | null;
  requested_storage: string | null;
  capacity: string | null;
  allocated_resources: PVCAllocatedResources;
  data_source: { kind: string | null; name: string | null; api_group: string | null } | null;
  data_source_ref: PVCDataSourceRef | null;
  selector: LabelSelectorSummary;
  conditions: WorkloadCondition[];
};

export type PVClaimRef = {
  kind: string | null;
  namespace: string | null;
  name: string | null;
  uid: string | null;
};

export type PersistentVolumeDetail = {
  meta: WorkloadMeta;
  phase: string;
  phase_message: string | null;
  phase_reason: string | null;
  capacity: string | null;
  access_modes: string[];
  reclaim_policy: string | null;
  storage_class: string | null;
  volume_mode: string | null;
  mount_options: string[];
  claim_ref: PVClaimRef | null;
  // Volume backend type — "CSI", "HostPath", "NFS", "Local", … — and a one-
  // line operator-friendly summary (driver+handle for CSI, server:path for
  // NFS, etc.). Either may be null when the source variant is exotic.
  source_type: string | null;
  source_summary: string | null;
  node_affinity: { term_count: number; keys: string[] };
};

export type StorageClassDetail = {
  meta: WorkloadMeta;
  provisioner: string;
  reclaim_policy: string | null;
  binding_mode: string | null;
  allow_volume_expansion: boolean | null;
  is_default: boolean;
  parameters: [string, string][];
  mount_options: string[];
  allowed_topologies: { term_count: number; keys: string[] };
};

// ── CustomResourceDefinition detail ────────────────────────────────────────

export type CustomResourceDefinitionPrinterColumn = {
  name: string;
  type: string;
  json_path: string;
  description: string | null;
};

export type CustomResourceDefinitionVersion = {
  name: string;
  served: boolean;
  storage: boolean;
  deprecated: boolean;
  deprecation_warning: string | null;
  printer_columns: CustomResourceDefinitionPrinterColumn[];
};

export type CustomResourceDefinitionDetail = {
  meta: WorkloadMeta;
  group: string;
  scope: string;
  names: {
    kind: string;
    list_kind: string | null;
    plural: string;
    singular: string | null;
    short_names: string[];
    categories: string[];
  };
  versions: CustomResourceDefinitionVersion[];
  conversion_strategy: string | null;
};

// ── Generic custom-resource detail ─────────────────────────────────────────
//
// Returned for any kind that doesn't have a hand-written summary — currently
// every CRD-backed kind that isn't in the well-known list. Carries the live
// object plus the CRD's openAPIV3Schema (spec + status branches) so the
// renderer can label, describe, and order fields.

export type CustomResourceSchemaNode = {
  // Subset of OpenAPI v3 we render. Anything we don't recognise just shows
  // up as a leaf with the JSON value formatted inline.
  type?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  properties?: Record<string, CustomResourceSchemaNode>;
  items?: CustomResourceSchemaNode;
  required?: string[];
  // Indexed signature so unknown OpenAPI fields don't break TS strict mode.
  [k: string]: unknown;
};

export type CustomResourcePrinterColumn = {
  name: string;
  json_path: string;
  type: string;
  description: string | null;
};

export type CustomResourceDetail = {
  meta: WorkloadMeta;
  // Full live object as returned by the apiserver (apiVersion / kind /
  // metadata / spec / status / …). The renderer reaches into `spec` and
  // `status` and walks them against the schema.
  object: Record<string, unknown>;
  schema: {
    spec: CustomResourceSchemaNode | null;
    status: CustomResourceSchemaNode | null;
  } | null;
  printer_columns: CustomResourcePrinterColumn[];
  kind: string;
  group: string;
  version: string;
  scope: "Namespaced" | "Cluster";
};

// ── RBAC detail (ServiceAccount, Role/ClusterRole, RoleBinding/ClusterRoleBinding) ──

export type ServiceAccountSecretRef = {
  kind: string;
  name: string;
  namespace: string | null;
};

export type ServiceAccountDetail = {
  meta: WorkloadMeta;
  automount_service_account_token: boolean | null;
  secrets: ServiceAccountSecretRef[];
  image_pull_secrets: string[];
};

export type PolicyRule = {
  api_groups: string[];
  resources: string[];
  resource_names: string[];
  verbs: string[];
  non_resource_urls: string[];
};

export type RoleDetail = {
  meta: WorkloadMeta;
  rules: PolicyRule[];
};

export type ClusterRoleAggregationRule = {
  selector_count: number;
  match_labels: [string, string][];
};

export type ClusterRoleDetail = {
  meta: WorkloadMeta;
  rules: PolicyRule[];
  aggregation_rule: ClusterRoleAggregationRule | null;
};

export type RoleRefSummary = {
  kind: string;
  name: string;
  api_group: string;
};

export type RoleBindingSubject = {
  kind: string;
  name: string;
  namespace: string | null;
  api_group: string | null;
};

export type RoleBindingDetail = {
  meta: WorkloadMeta;
  role_ref: RoleRefSummary;
  subjects: RoleBindingSubject[];
};

export type ClusterRoleBindingDetail = RoleBindingDetail;

// ── HorizontalPodAutoscaler ────────────────────────────────────────────────

export type HpaScaleTargetRef = {
  api_version: string | null;
  kind: string;
  name: string;
};

export type HpaMetricTarget = {
  type: string;
  average_utilization: number | null;
  average_value: string | null;
  value: string | null;
};

export type HpaMetric = {
  type: string;
  name?: string;
  target?: HpaMetricTarget;
  metric_name?: string;
};

export type HpaCondition = {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  last_transition_time: string | null;
};

export type HorizontalPodAutoscalerDetail = {
  meta: WorkloadMeta;
  scale_target_ref: HpaScaleTargetRef | null;
  min_replicas: number | null;
  max_replicas: number;
  current_replicas: number | null;
  desired_replicas: number | null;
  last_scale_time: string | null;
  metrics: HpaMetric[];
  conditions: HpaCondition[];
};

// ── PodDisruptionBudget ────────────────────────────────────────────────────

export type PdbCondition = {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  last_transition_time: string;
};

export type PodDisruptionBudgetDetail = {
  meta: WorkloadMeta;
  min_available: string | null;
  max_unavailable: string | null;
  unhealthy_pod_eviction_policy: string | null;
  selector: LabelSelectorSummary | null;
  current_healthy: number;
  desired_healthy: number;
  expected_pods: number;
  disruptions_allowed: number;
  conditions: PdbCondition[];
};

// ── PriorityClass ──────────────────────────────────────────────────────────

export type PriorityClassDetail = {
  meta: WorkloadMeta;
  value: number;
  global_default: boolean;
  preemption_policy: string | null;
  description: string | null;
};

// ── ReplicationController ──────────────────────────────────────────────────

export type ReplicationControllerCondition = {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  last_transition_time: string | null;
};

export type ReplicationControllerDetail = {
  meta: WorkloadMeta;
  replicas: number | null;
  min_ready_seconds: number | null;
  selector: [string, string][];
  current: number;
  ready: number | null;
  available: number | null;
  fully_labeled: number | null;
  observed_generation: number | null;
  conditions: ReplicationControllerCondition[];
};

// ── Lease ──────────────────────────────────────────────────────────────────

export type LeaseDetail = {
  meta: WorkloadMeta;
  holder_identity: string | null;
  lease_duration_seconds: number | null;
  lease_transitions: number | null;
  acquire_time: string | null;
  renew_time: string | null;
};

// ── Mutating / Validating Webhook Configurations ───────────────────────────

export type WebhookServiceRef = {
  name: string;
  namespace: string;
  path: string | null;
  port: number | null;
};

export type WebhookClientConfig = {
  service: WebhookServiceRef | null;
  url: string | null;
  ca_bundle_present: boolean;
};

export type WebhookRule = {
  api_groups: string[];
  api_versions: string[];
  resources: string[];
  operations: string[];
  scope: string | null;
};

export type AdmissionWebhook = {
  name: string;
  client_config: WebhookClientConfig;
  rules: WebhookRule[];
  failure_policy: string | null;
  match_policy: string | null;
  side_effects: string | null;
  timeout_seconds: number | null;
  admission_review_versions: string[] | null;
  reinvocation_policy?: string | null;
};

export type MutatingWebhookConfigurationDetail = {
  meta: WorkloadMeta;
  webhooks: AdmissionWebhook[];
};

export type ValidatingWebhookConfigurationDetail = {
  meta: WorkloadMeta;
  webhooks: AdmissionWebhook[];
};

// ── Gateway API (well-known CRDs) ──────────────────────────────────────────

export type GatewayCondition = {
  type: string | null;
  status: string | null;
  reason: string | null;
  message: string | null;
  last_transition_time: string | null;
};

export type GatewayClassDetail = {
  meta: WorkloadMeta;
  controller: string | null;
  description: string | null;
  parameters_ref: unknown | null;
  conditions: GatewayCondition[];
};

export type GatewayListener = {
  name: string | null;
  protocol: string | null;
  port: number | null;
  hostname: string | null;
  tls_mode: string | null;
  allowed_routes: unknown | null;
};

export type GatewayAddress = {
  type: string | null;
  value: string | null;
};

export type GatewayListenerStatus = {
  name: string | null;
  attached_routes: number | null;
  conditions: GatewayCondition[];
};

export type GatewayDetail = {
  meta: WorkloadMeta;
  gateway_class_name: string | null;
  listeners: GatewayListener[];
  addresses: GatewayAddress[];
  listener_status: GatewayListenerStatus[];
  conditions: GatewayCondition[];
};

export type RouteParentRef = {
  group: string | null;
  kind: string | null;
  namespace: string | null;
  name: string | null;
  section_name: string | null;
  port: number | null;
};

export type RouteBackend = {
  name: string;
  namespace: string | null;
  port: number | null;
  weight: number | null;
};

export type RouteRule = {
  matches: number;
  backends: RouteBackend[];
  filters: number;
};

export type RouteParentStatus = {
  controller: string | null;
  parent: RouteParentRef | null;
  conditions: GatewayCondition[];
};

export type RouteDetail = {
  meta: WorkloadMeta;
  hostnames: string[];
  parent_refs: RouteParentRef[];
  rules: RouteRule[];
  parent_status: RouteParentStatus[];
};

export type ReferenceGrantFrom = {
  group: string | null;
  kind: string | null;
  namespace: string | null;
};

export type ReferenceGrantTo = {
  group: string | null;
  kind: string | null;
  name: string | null;
};

export type ReferenceGrantDetail = {
  meta: WorkloadMeta;
  from: ReferenceGrantFrom[];
  to: ReferenceGrantTo[];
};

// ── Server-Side Apply result ───────────────────────────────────────────────

export type ApplyOk = {
  resource_version: string | null;
};

export type ApplyConflict = {
  conflict: true;
  // Other field managers (kubectl, Argo, an operator) that own conflicting
  // fields. May be empty when the apiserver didn't include manager names.
  managers: string[];
  // Conflicting field paths (`.spec.hard.cpu`). May be empty.
  fields: string[];
  // Raw status message — always populated.
  message: string;
};

// Tagged on `kind` so callers can branch on success vs. conflict without
// special-casing 409s themselves.
export type ApplyResult =
  | { kind: "applied"; resource_version: string | null }
  | ({ kind: "conflict" } & Omit<ApplyConflict, "conflict">);

// Per-doc result from the multi-doc YAML apply path. Tagged on `status`.
export type DocApplyResult =
  | {
      status: "applied";
      kind: string;
      api_version: string;
      name: string;
      namespace: string | null;
      resource_version: string | null;
      dry_run: boolean;
    }
  | {
      status: "conflict";
      kind: string;
      api_version: string;
      name: string;
      namespace: string | null;
      managers: string[];
      fields: string[];
      message: string;
    }
  | {
      status: "error";
      kind: string;
      api_version: string;
      name: string;
      namespace: string | null;
      message: string;
    };

export type ClusterProbe = {
  context_name: string;
  server_version: string | null;
  nodes: number | null;
  pods: number | null;
  cpu_used_milli: number | null;
  cpu_capacity_milli: number | null;
  mem_used_mib: number | null;
  mem_capacity_mib: number | null;
  healthy: boolean | null;
  fetched_at_unix_ms: number;
  last_error: string | null;
};

// ── Port forwarding ────────────────────────────────────────────────────────
//
// Backend: `crates/core/src/portforwards.rs` + `crates/kube-ext/src/
// portforward.rs`. `id` is deterministic
// `"<cluster>::<kind>/<ns>/<name>:<remote_port>"` — re-starting a duplicate
// triple returns the same id rather than binding twice.

export type ForwardTarget = {
  // Apiserver kind name: "Pod" | "Service" | "Deployment" | "StatefulSet" |
  // "DaemonSet" | "ReplicaSet" | "Job".
  kind: string;
  namespace: string;
  name: string;
};

export type ForwardSpec = {
  id: string;
  cluster_id: string;
  target: ForwardTarget;
  remote_port: number;
  requested_local_port: number | null;
  // Pinned forwards survive app restart (live in
  // `<config>/portforwards.json`). Ephemeral forwards don't.
  autostart: boolean;
};

export type ForwardStatus =
  | { kind: "listening" }
  | { kind: "active" }
  | { kind: "reconnecting"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "stopped" };

export type ForwardEntry = {
  spec: ForwardSpec;
  actual_local_port: number;
  status: ForwardStatus;
};

// Status-only event payload. The id resolves against the local
// `Map<id, ForwardEntry>` the store keeps in sync via `pfList`.
export type ForwardStatusEvent = {
  id: string;
  status: ForwardStatus;
};

// ── Settings deep-linking ───────────────────────────────────────────────────
// Tab id + optional anchor inside that tab. Passed through
// `openSettings(target?)` so callers (chat picker popovers, status overlays)
// can land the operator directly on a specific control instead of dropping
// them on the General tab and making them hunt.

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "kubeconfig"
  | "observability"
  | "ai"
  | "tools"
  | "shortcuts"
  | "about";

/// Anchor value matched against `data-fs-anchor` attributes on the
/// rendered section. The settings panel scrolls the matching element
/// into view (and pulses it briefly) once the target tab mounts. Free-
/// form string so individual sections can grow their own anchors
/// without a central registry — the worst case for an unknown anchor
/// is "we land on the right tab without scrolling further".
export type SettingsTarget = {
  section: SettingsSectionId;
  anchor?: string;
};

// ── AI agent ────────────────────────────────────────────────────────────────
// Mirror of `crates/agent` + `crates/app/src/agent.rs` wire types.

export type ProviderKind =
  | "opencode_zen"
  | "open_router"
  | "anthropic"
  | "openai"
  | "zai"
  | "minimax"
  | "groq"
  | "deepseek"
  | "mistral"
  | "together"
  | "ollama";

export type AuthMode = "api_key" | "oauth";

export type Credential =
  | { type: "api_key"; key: string }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires_at_unix_ms: number;
      account_id?: string | null;
    };

export type ProviderStatusWire = {
  kind: ProviderKind;
  id: string;
  display_name: string;
  default_base_url: string;
  base_url_override: string | null;
  auth_modes: AuthMode[];
  auth_mode: AuthMode | null;
  configured: boolean;
  account_label: string | null;
};

export type ApprovalMode = "approve_per_write" | "allow_all_writes";

export type ReasoningEffort = "low" | "medium" | "high";

/// Universal reasoning / extended-thinking knobs. Mapped to each
/// provider's native shape at request time (Anthropic `thinking`,
/// OpenAI `reasoning_effort`, OpenRouter `reasoning`, …).
export type ReasoningSettings = {
  effort?: ReasoningEffort | null;
  budget_tokens?: number | null;
};

/// One operator-configured external MCP server. Each entry produces one
/// child process per chat; the JSON shape mirrors `mcpServers` in
/// Claude Desktop / Cursor so configs copy-paste between tools.
export type McpServerConfig = {
  /// Stable id from the backend. Used as the React key and as the address
  /// for per-server status updates over the chat event stream.
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
};

export type AiSettingsWire = {
  active_provider: ProviderKind;
  providers: Record<ProviderKind, ProviderStatusWire>;
  default_model: string | null;
  default_approval_mode: ApprovalMode;
  system_prompt_override: string | null;
  allow_plaintext_api_key: boolean;
  keychain_available: boolean;
  mcp_servers: McpServerConfig[];
  /// Legacy single-binary path. Read-only on the wire — the editor only
  /// writes through `mcp_servers`. Frontend hides it once `mcp_servers`
  /// is non-empty.
  mcp_binary_path: string | null;
  reasoning: ReasoningSettings;
};

export type ProviderBaseUrlPatch = {
  provider: ProviderKind;
  base_url: string;
};

export type AiSettingsPatch = {
  active_provider?: ProviderKind;
  provider_base_url?: ProviderBaseUrlPatch;
  default_model?: string;
  default_approval_mode?: ApprovalMode;
  system_prompt_override?: string;
  allow_plaintext_api_key?: boolean;
  /// Whole-list replace. Pass `[]` to clear all servers.
  mcp_servers?: McpServerConfig[];
  mcp_binary_path?: string;
  /// Whole-object replace; pass an object with `null` fields to clear.
  reasoning?: ReasoningSettings;
};

export type ProviderTestRequest = {
  provider: ProviderKind;
  base_url: string | null;
  api_key: string;
};

export type ProviderTestResult = {
  ok: boolean;
  model_count: number;
  error: string | null;
};

/// Result of a one-shot MCP-server validation: spawn, initialize,
/// `tools/list`, kill. Returned by `api.mcpTestServer`.
export type McpTestResult = {
  ok: boolean;
  tool_count: number;
  /// Up to a dozen tool names from the catalogue. Empty on failure.
  tool_names: string[];
  error: string | null;
};

export type ModelInfo = {
  id: string;
  name: string | null;
  context_length: number | null;
};

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type AgentChatMessage = {
  role: MessageRole;
  content: string;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string | null;
  name?: string | null;
};

export type SessionMeta = {
  id: string;
  cluster_id: string;
  title: string;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  provider_kind?: ProviderKind;
  model: string;
  approval_mode: ApprovalMode;
  temperature?: number | null;
  max_tokens?: number | null;
  provider_options?: unknown;
  /// Most recent provider-reported total_tokens. Populated by the
  /// backend when a Usage event lands; used by the chat header to
  /// show the running count immediately on reopen without waiting
  /// for the next round's Usage event.
  last_total_tokens?: number | null;
};

export type SessionEventWire =
  | { kind: "message"; message: AgentChatMessage; ts: number }
  | {
      kind: "approval";
      tool_call_id: string;
      decision: "approved" | "denied" | "approved_always";
      ts: number;
    }
  | {
      kind: "session_update";
      update: {
        title?: string;
        model?: string;
        approval_mode?: ApprovalMode;
        temperature?: number | null;
        max_tokens?: number | null;
      };
      ts: number;
    }
  | {
      kind: "tool_result";
      call: AgentToolCall;
      result: string;
      error?: string;
      ts: number;
    };

export type SessionData = {
  meta: SessionMeta;
  events: SessionEventWire[];
};

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "other";

export type ApprovalDecision = "approved" | "denied" | "approved_always";

export type ChatTool = {
  name: string;
  description: string | null;
  category: "read" | "write" | "unknown";
  input_schema: unknown;
  /// Where this tool came from. `"native"` for in-process tools; the MCP
  /// server's name (from `McpServerConfig.name`) otherwise.
  source: string;
};

/// Per-server status row in `mcp_status` events. Re-emitted on every
/// status update with the full per-server snapshot — frontend treats the
/// most recent event as authoritative.
export type McpServerStatusWire = {
  id: string;
  name: string;
  available: boolean;
  tool_count: number;
  message: string | null;
};

/// In-band return shape from `chat_open`. Bundles the chat id with the
/// initial MCP-status snapshot so callers can seed `view.mcp`
/// synchronously without depending on the streamed `mcp_status` event
/// landing first (Tauri channel events sent during the same invoke can
/// arrive after the JS-side state-init effects). Field names are
/// snake_case to match the Rust serialization.
export type ChatOpenResult = {
  chat_id: string;
  native_tool_count: number;
  mcp_servers: McpServerStatusWire[];
  /// Model context window in tokens (resolved through models.dev). The UI
  /// renders `<used> / <limit>` in the chat input footer using this. `0`
  /// means the catalogue hadn't loaded yet — caller should treat as
  /// "unknown" and only render the used count.
  context_limit: number;
  /// Usable window after the reserved output buffer. The auto-compaction
  /// trigger fires against this, not the raw context — surfacing it lets
  /// the UI show a percentage that matches what the trigger reads.
  usable_context: number;
};

/// Camel-cased projection of `ChatOpenResult`'s mcp fields, returned by
/// `api.chatOpen` so the caller doesn't have to remap snake_case
/// inline. Mirrors the shape of the streamed `mcp_status` event so it
/// can flow through the same `applyChatEvent` reducer path.
export type ChatInitialMcp = {
  nativeToolCount: number;
  servers: McpServerStatusWire[];
};

// kubectl install / detection wire shape.
export type KubectlDetection =
  | { kind: "configured"; path: string; exists: boolean }
  | { kind: "managed"; path: string; version: string | null }
  | { kind: "on_path"; path: string }
  | { kind: "missing" };

export type KubectlInstallResult = {
  path: string;
  version: string;
  asset_url: string;
};

export type ChatEvent =
  | { type: "assistant_start"; message_id: string }
  | { type: "token_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args_delta"; id: string; json_delta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "assistant_end"; message_id: string; finish_reason: FinishReason }
  | { type: "tool_execution_start"; tool_call_id: string; name: string }
  | {
      type: "tool_result";
      tool_call_id: string;
      name: string;
      content: string;
      is_error: boolean;
    }
  | {
      type: "mcp_status";
      servers: McpServerStatusWire[];
      native_tool_count: number;
    }
  | {
      type: "approval_request";
      tool_call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "usage";
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      context_limit: number;
      usable_context: number;
    }
  | {
      type: "context_limit";
      context_limit: number;
      usable_context: number;
    }
  | {
      type: "compaction_started";
      tokens_before: number;
      head_message_count: number;
    }
  | {
      type: "compaction_completed";
      summary_chars: number;
      summary: string;
    }
  | { type: "error"; message: string }
  | { type: "title_updated"; title: string };
