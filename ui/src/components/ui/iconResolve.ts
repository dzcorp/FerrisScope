// Icon resolution for Kubernetes resource kinds.
//
// Lookup order (first hit wins):
//   1. KindIcons[kind]                — built-in K8s kinds + Gateway API + Helm
//   2. CRD_OVERRIDES[group]?.[kind]   — curated (group, kind) for popular CRDs
//   3. token heuristic on `kind`      — PascalCase split → keyword → glyph
//   4. group heuristic on `group`     — ecosystem hint (e.g. monitoring.coreos.com → flame)
//   5. Icons.crdGeneric               — hexagon-with-bracket fallback
//
// Returns a `ReactElement` ready to drop into the rail / palette / detail
// header. Pure and synchronous — table-driven, no React state.

import type { ReactElement } from "react";
import type { Category } from "../../types";
import { CrdIcons, Icons, KindIcons } from "./icons";

// Curated (group → kind → CrdIcons|KindIcons|Icons key) map for ecosystems
// we don't promote to backend well-known overrides. Cosmetic only.
//
// Resolution: the value is looked up in CrdIcons first, then KindIcons, then
// Icons. This lets us reuse existing glyphs (e.g. `bell` for Alertmanager) or
// reference ecosystem-specific glyphs (e.g. `Prometheus`) without duplicating
// SVG paths.
const CRD_OVERRIDES: Record<string, Record<string, string>> = {
  // cert-manager
  "cert-manager.io": {
    Certificate: "Certificate",
    CertificateRequest: "CertificateRequest",
    Issuer: "Issuer",
    ClusterIssuer: "ClusterIssuer",
  },
  "acme.cert-manager.io": {
    Challenge: "Challenge",
    Order: "Order",
  },

  // prometheus-operator
  "monitoring.coreos.com": {
    Prometheus: "Prometheus",
    PrometheusAgent: "PrometheusAgent",
    PrometheusRule: "PrometheusRule",
    Alertmanager: "Alertmanager",
    AlertmanagerConfig: "AlertmanagerConfig",
    ServiceMonitor: "ServiceMonitor",
    PodMonitor: "PodMonitor",
    Probe: "Probe",
    ScrapeConfig: "ScrapeConfig",
    ThanosRuler: "ThanosRuler",
  },

  // Flux toolkit
  "kustomize.toolkit.fluxcd.io": {
    Kustomization: "Kustomization",
  },
  "helm.toolkit.fluxcd.io": {
    HelmRelease: "HelmRelease", // already in KindIcons
  },
  "source.toolkit.fluxcd.io": {
    Bucket: "Bucket",
    GitRepository: "GitRepository",
    HelmRepository: "HelmRepository",
    HelmChart: "HelmChart", // already in KindIcons
    OCIRepository: "OCIRepository",
  },
  "notification.toolkit.fluxcd.io": {
    Alert: "Alert",
    Provider: "Provider",
    Receiver: "Receiver",
  },
  "image.toolkit.fluxcd.io": {
    ImageRepository: "ImageRepository",
    ImagePolicy: "ImagePolicy",
    ImageUpdateAutomation: "ImageUpdateAutomation",
  },

  // K8s snapshot
  "snapshot.storage.k8s.io": {
    VolumeSnapshot: "VolumeSnapshot",
    VolumeSnapshotClass: "VolumeSnapshotClass",
    VolumeSnapshotContent: "VolumeSnapshotContent",
  },

  // Multi-cluster services
  "multicluster.x-k8s.io": {
    ServiceExport: "ServiceExport",
    ServiceImport: "ServiceImport",
  },

  // Argo
  "argoproj.io": {
    Application: "Application",
    ApplicationSet: "ApplicationSet",
    AppProject: "AppProject",
    Workflow: "Workflow",
    WorkflowTemplate: "Workflow",
    ClusterWorkflowTemplate: "Workflow",
    Rollout: "Rollout",
    AnalysisRun: "Probe",
    AnalysisTemplate: "Probe",
  },

  // Tekton
  "tekton.dev": {
    Pipeline: "Pipeline",
    PipelineRun: "PipelineRun",
    Task: "Task",
    TaskRun: "TaskRun",
    ClusterTask: "ClusterTask",
  },

  // Velero
  "velero.io": {
    Backup: "Backup",
    Restore: "Restore",
    Schedule: "Schedule",
    BackupStorageLocation: "BackupStorageLocation",
    VolumeSnapshotLocation: "VolumeSnapshotLocation",
  },

  // Cilium
  "cilium.io": {
    CiliumNetworkPolicy: "CiliumNetworkPolicy",
    CiliumClusterwideNetworkPolicy: "CiliumNetworkPolicy",
    CiliumIdentity: "CiliumIdentity",
    CiliumEndpoint: "CiliumEndpoint",
  },

  // Istio (multiple groups)
  "networking.istio.io": {
    VirtualService: "VirtualService",
    DestinationRule: "DestinationRule",
    ServiceEntry: "ServiceEntry",
    Gateway: "Gateway", // KindIcons.Gateway
    Sidecar: "Gateway",
  },
  "security.istio.io": {
    AuthorizationPolicy: "AuthorizationPolicy",
    PeerAuthentication: "PeerAuthentication",
    RequestAuthentication: "AuthorizationPolicy",
  },

  // Crossplane
  "apiextensions.crossplane.io": {
    Composition: "Composition",
    CompositeResourceDefinition: "CompositeResourceDefinition",
  },
  "pkg.crossplane.io": {
    Provider: "Provider",
    Configuration: "Composition",
    Function: "Composition",
  },

  // Kyverno (kyverno.io / policies.kyverno.io / reports.kyverno.io / wgpolicyk8s.io)
  "kyverno.io": {
    Policy: "Role", // shield
    ClusterPolicy: "Role",
    CleanupPolicy: "CleanupPolicy",
    ClusterCleanupPolicy: "CleanupPolicy",
    PolicyException: "PolicyException",
    UpdateRequest: "ProvisioningRequest",
    GlobalContextEntry: "GlobalContextEntry",
  },
  "policies.kyverno.io": {
    ValidatingPolicy: "ValidatingWebhookConfiguration",
    MutatingPolicy: "MutatingWebhookConfiguration",
    GeneratingPolicy: "Composition",
    DeletingPolicy: "CleanupPolicy",
    ImageValidatingPolicy: "ImagePolicy",
    PolicyException: "PolicyException",
    NamespacedValidatingPolicy: "ValidatingWebhookConfiguration",
    NamespacedMutatingPolicy: "MutatingWebhookConfiguration",
    NamespacedGeneratingPolicy: "Composition",
    NamespacedDeletingPolicy: "CleanupPolicy",
    NamespacedImageValidatingPolicy: "ImagePolicy",
  },
  "reports.kyverno.io": {
    EphemeralReport: "EphemeralReport",
    ClusterEphemeralReport: "EphemeralReport",
  },
  "wgpolicyk8s.io": {
    PolicyReport: "PolicyReport",
    ClusterPolicyReport: "PolicyReport",
  },

  // RabbitMQ (rabbitmq.com)
  "rabbitmq.com": {
    Binding: "Binding",
    Exchange: "Exchange",
    Federation: "Federation",
    Permission: "Permission",
    Policy: "Role",
    Queue: "Queue",
    RabbitmqCluster: "RabbitmqCluster",
    SchemaReplication: "Federation",
    Shovel: "Shovel",
    SuperStream: "SuperStream",
    TopicPermission: "Permission",
    User: "User",
    Vhost: "VirtualHost",
  },

  // VictoriaMetrics (operator.victoriametrics.com)
  "operator.victoriametrics.com": {
    VLAgent: "PrometheusAgent",
    VLCluster: "VMCluster",
    VLogs: "VictoriaMetrics",
    VLSingle: "VMSingle",
    VMAgent: "PrometheusAgent",
    VMAlertmanagerConfig: "AlertmanagerConfig",
    VMAlertmanager: "Alertmanager",
    VMAlert: "Alertmanager",
    VMAnomaly: "VMAnomaly",
    VMAuth: "Permission",
    VMCluster: "VMCluster",
    VMDistributed: "VMCluster",
    VMNodeScrape: "ScrapeConfig",
    VMPodScrape: "PodMonitor",
    VMProbe: "Probe",
    VMRule: "PrometheusRule",
    VMScrapeConfig: "ScrapeConfig",
    VMServiceScrape: "ServiceMonitor",
    VMSingle: "VMSingle",
    VMStaticScrape: "ScrapeConfig",
    VMUser: "User",
    VTCluster: "VMCluster",
    VTSingle: "VMSingle",
  },

  // Envoy XDS (envoyxds.io)
  "envoyxds.io": {
    Cluster: "EnvoyCluster",
    Endpoint: "Endpoint",
    Listener: "Listener",
    Route: "EnvoyRoute",
    TLSSecret: "TLSSecret",
  },

  // Istio extras — config / extensions / telemetry / networking
  "extensions.istio.io": {
    WasmPlugin: "WasmPlugin",
  },
  "telemetry.istio.io": {
    Telemetry: "Telemetry",
  },
  "config.istio.io": {
    Adapter: "WasmPlugin",
    AttributeManifest: "Composition",
    Handler: "ProxyConfig",
    HTTPAPISpec: "VirtualService",
    HTTPAPISpecBinding: "Binding",
    Instance: "Composition",
    QuotaSpec: "ResourceQuota",
    QuotaSpecBinding: "Binding",
    Rule: "PrometheusRule",
    Template: "Composition",
  },
  // Add to existing networking.istio.io entries (merge below).

  // GKE / Google Cloud
  "cloud.google.com": {
    BackendConfig: "BackendConfig",
    ComputeClass: "ComputeClass",
  },
  "networking.gke.io": {
    FrontendConfig: "FrontendConfig",
    GKENetworkParamSet: "Topology",
    ManagedCertificate: "ManagedCertificate",
    Network: "NetworkPolicy",
    NodeTopology: "Topology",
    ServiceAttachment: "Endpoint",
    ServiceNetworkEndpointGroup: "Endpoint",
  },
  "security.cloud.google.com": {
    GKEClusterTrustBundle: "TLSSecret",
    TrustConfig: "TLSSecret",
    WorkloadCertificateConfig: "Certificate",
  },
  "auto.gke.io": {
    AllowlistedV2Workload: "Allowlist",
    AllowlistedWorkload: "Allowlist",
    AllowlistSynchronizer: "Allowlist",
    WorkloadAllowlist: "Allowlist",
  },
  "warden.gke.io": {
    Audit: "Audit",
  },
  "node.gke.io": {
    GCPResourceAllowlist: "Allowlist",
  },
  "internal.autoscaling.gke.io": {
    CapacityRequest: "ProvisioningRequest",
  },
  "nodemanagement.gke.io": {
    UpdateInfo: "Telemetry",
  },
  "hub.gke.io": {
    Membership: "Membership",
  },
  "datalayer.gke.io": {
    GCPDataSource: "Bucket",
  },

  // Other ecosystems
  "dragonflydb.io": {
    Dragonfly: "DatabaseInstance",
  },
  "ricoberger.de": {
    VaultSecret: "VaultSecret",
  },
  "monitoring.grafana.com": {
    PodLogs: "logs", // reuse Icons.logs
  },
  "autoscaling.x-k8s.io": {
    ProvisioningRequest: "ProvisioningRequest",
  },
};

// Late-merge: networking.istio.io has both legacy curated entries above and
// extras added now. We extend the existing record in place.
Object.assign(CRD_OVERRIDES["networking.istio.io"]!, {
  EnvoyFilter: "EnvoyFilter",
  ProxyConfig: "ProxyConfig",
  Sidecar: "Sidecar",
  WorkloadEntry: "WorkloadEntry",
  WorkloadGroup: "WorkloadGroup",
});

// Token-pattern heuristic. Matches against PascalCase-split tokens of `kind`.
// Order matters — first hit wins, so put more specific tokens before broader
// ones (e.g. `certificaterequest` before `request`).
//
// Each rule: list of tokens that must all be present (AND), and the icon
// name to return.
type TokenRule = { tokens: string[]; icon: string };

const TOKEN_RULES: TokenRule[] = [
  // Cert-manager-flavoured names
  { tokens: ["certificate", "request"], icon: "CertificateRequest" },
  { tokens: ["certificate"], icon: "Certificate" },
  { tokens: ["cert"], icon: "Certificate" },
  { tokens: ["cluster", "issuer"], icon: "ClusterIssuer" },
  { tokens: ["issuer"], icon: "Issuer" },
  { tokens: ["challenge"], icon: "Challenge" },

  // Prometheus / observability
  { tokens: ["prometheus", "rule"], icon: "PrometheusRule" },
  { tokens: ["prometheus"], icon: "Prometheus" },
  { tokens: ["alertmanager"], icon: "Alertmanager" },
  { tokens: ["alert"], icon: "Alert" },
  { tokens: ["service", "monitor"], icon: "ServiceMonitor" },
  { tokens: ["pod", "monitor"], icon: "PodMonitor" },
  { tokens: ["scrape"], icon: "ScrapeConfig" },
  { tokens: ["probe"], icon: "Probe" },
  { tokens: ["monitor"], icon: "ServiceMonitor" },
  { tokens: ["thanos"], icon: "ThanosRuler" },

  // Flux / source
  { tokens: ["kustomization"], icon: "Kustomization" },
  { tokens: ["bucket"], icon: "Bucket" },
  { tokens: ["git", "repository"], icon: "GitRepository" },
  { tokens: ["helm", "release"], icon: "HelmRelease" },
  { tokens: ["helm", "chart"], icon: "HelmChart" },
  { tokens: ["helm"], icon: "HelmRepository" },
  { tokens: ["oci", "repository"], icon: "OCIRepository" },
  { tokens: ["image", "policy"], icon: "ImagePolicy" },
  { tokens: ["image", "update"], icon: "ImageUpdateAutomation" },
  { tokens: ["image", "repository"], icon: "ImageRepository" },
  { tokens: ["repository"], icon: "GitRepository" },

  // Snapshots / backup
  { tokens: ["volume", "snapshot", "class"], icon: "VolumeSnapshotClass" },
  { tokens: ["volume", "snapshot", "content"], icon: "VolumeSnapshotContent" },
  { tokens: ["volume", "snapshot"], icon: "VolumeSnapshot" },
  { tokens: ["snapshot", "class"], icon: "VolumeSnapshotClass" },
  { tokens: ["snapshot"], icon: "VolumeSnapshot" },
  { tokens: ["backup", "storage", "location"], icon: "BackupStorageLocation" },
  { tokens: ["backup"], icon: "Backup" },
  { tokens: ["restore"], icon: "Restore" },
  { tokens: ["schedule"], icon: "Schedule" },

  // Multi-cluster / services
  { tokens: ["service", "export"], icon: "ServiceExport" },
  { tokens: ["service", "import"], icon: "ServiceImport" },
  { tokens: ["service", "entry"], icon: "ServiceEntry" },

  // Argo / workflows
  { tokens: ["application", "set"], icon: "ApplicationSet" },
  { tokens: ["app", "project"], icon: "AppProject" },
  { tokens: ["application"], icon: "Application" },
  { tokens: ["workflow"], icon: "Workflow" },
  { tokens: ["rollout"], icon: "Rollout" },

  // Tekton / pipelines
  { tokens: ["pipeline", "run"], icon: "PipelineRun" },
  { tokens: ["pipeline"], icon: "Pipeline" },
  { tokens: ["task", "run"], icon: "TaskRun" },
  { tokens: ["cluster", "task"], icon: "ClusterTask" },
  { tokens: ["task"], icon: "Task" },

  // Crossplane
  { tokens: ["composition"], icon: "Composition" },
  { tokens: ["composite"], icon: "CompositeResourceDefinition" },

  // Istio / routing
  { tokens: ["virtual", "service"], icon: "VirtualService" },
  { tokens: ["destination", "rule"], icon: "DestinationRule" },
  { tokens: ["authorization", "policy"], icon: "AuthorizationPolicy" },
  { tokens: ["peer", "authentication"], icon: "PeerAuthentication" },
  { tokens: ["request", "authentication"], icon: "AuthorizationPolicy" },

  // Cilium-flavoured
  { tokens: ["cilium", "network", "policy"], icon: "CiliumNetworkPolicy" },
  { tokens: ["cilium", "identity"], icon: "CiliumIdentity" },
  { tokens: ["cilium", "endpoint"], icon: "CiliumEndpoint" },
  { tokens: ["cilium"], icon: "CiliumEndpoint" },

  // Kyverno / policy reports / generic policy decorations
  { tokens: ["cleanup", "policy"], icon: "CleanupPolicy" },
  { tokens: ["policy", "exception"], icon: "PolicyException" },
  { tokens: ["policy", "report"], icon: "PolicyReport" },
  { tokens: ["ephemeral", "report"], icon: "EphemeralReport" },
  { tokens: ["validating", "policy"], icon: "ValidatingWebhookConfiguration" },
  { tokens: ["mutating", "policy"], icon: "MutatingWebhookConfiguration" },
  { tokens: ["generating", "policy"], icon: "Composition" },
  { tokens: ["deleting", "policy"], icon: "CleanupPolicy" },
  {
    tokens: ["image", "validating", "policy"],
    icon: "ImagePolicy",
  },
  { tokens: ["update", "request"], icon: "ProvisioningRequest" },
  { tokens: ["global", "context"], icon: "GlobalContextEntry" },
  { tokens: ["report"], icon: "Report" },
  { tokens: ["allowlist"], icon: "Allowlist" },
  { tokens: ["whitelist"], icon: "Allowlist" },
  { tokens: ["audit"], icon: "Audit" },

  // RabbitMQ / messaging
  { tokens: ["queue"], icon: "Queue" },
  { tokens: ["exchange"], icon: "Exchange" },
  { tokens: ["binding"], icon: "Binding" },
  { tokens: ["federation"], icon: "Federation" },
  { tokens: ["shovel"], icon: "Shovel" },
  { tokens: ["super", "stream"], icon: "SuperStream" },
  { tokens: ["stream"], icon: "SuperStream" },
  { tokens: ["topic", "permission"], icon: "Permission" },
  { tokens: ["permission"], icon: "Permission" },
  { tokens: ["vhost"], icon: "VirtualHost" },
  { tokens: ["virtual", "host"], icon: "VirtualHost" },
  { tokens: ["user"], icon: "User" },

  // Istio extras (config / extensions / telemetry)
  { tokens: ["envoy", "filter"], icon: "EnvoyFilter" },
  { tokens: ["proxy", "config"], icon: "ProxyConfig" },
  { tokens: ["sidecar"], icon: "Sidecar" },
  { tokens: ["wasm"], icon: "WasmPlugin" },
  { tokens: ["plugin"], icon: "WasmPlugin" },
  { tokens: ["telemetry"], icon: "Telemetry" },
  { tokens: ["workload", "entry"], icon: "WorkloadEntry" },
  { tokens: ["workload", "group"], icon: "WorkloadGroup" },

  // VictoriaMetrics — VM<X> / VL<X> / VT<X> tokens hit after split.
  { tokens: ["vmanomaly"], icon: "VMAnomaly" },
  { tokens: ["vmcluster"], icon: "VMCluster" },
  { tokens: ["vmsingle"], icon: "VMSingle" },
  { tokens: ["vmagent"], icon: "PrometheusAgent" },
  { tokens: ["vmalertmanager"], icon: "Alertmanager" },
  { tokens: ["vmalert"], icon: "Alertmanager" },
  { tokens: ["vmrule"], icon: "PrometheusRule" },
  { tokens: ["vmprobe"], icon: "Probe" },
  { tokens: ["vmscrapeconfig"], icon: "ScrapeConfig" },
  { tokens: ["vmpodscrape"], icon: "PodMonitor" },
  { tokens: ["vmservicescrape"], icon: "ServiceMonitor" },
  { tokens: ["vmnodescrape"], icon: "ScrapeConfig" },
  { tokens: ["vmstaticscrape"], icon: "ScrapeConfig" },
  { tokens: ["vmuser"], icon: "User" },
  { tokens: ["vmauth"], icon: "Permission" },

  // Envoy XDS / proxy
  { tokens: ["listener"], icon: "Listener" },
  { tokens: ["endpoint"], icon: "Endpoint" },
  { tokens: ["tls", "secret"], icon: "TLSSecret" },

  // Cloud / GKE / managed resources
  { tokens: ["managed", "certificate"], icon: "ManagedCertificate" },
  { tokens: ["frontend", "config"], icon: "FrontendConfig" },
  { tokens: ["backend", "config"], icon: "BackendConfig" },
  { tokens: ["compute", "class"], icon: "ComputeClass" },
  { tokens: ["capacity", "request"], icon: "ProvisioningRequest" },
  { tokens: ["provisioning", "request"], icon: "ProvisioningRequest" },
  { tokens: ["membership"], icon: "Membership" },
  { tokens: ["topology"], icon: "Topology" },
  { tokens: ["network", "endpoint"], icon: "Endpoint" },
  { tokens: ["service", "attachment"], icon: "Endpoint" },
  { tokens: ["trust", "bundle"], icon: "TLSSecret" },
  { tokens: ["trust", "config"], icon: "TLSSecret" },
  { tokens: ["update", "info"], icon: "Telemetry" },
  { tokens: ["data", "source"], icon: "Bucket" },

  // Vault
  { tokens: ["vault", "secret"], icon: "VaultSecret" },
  { tokens: ["vault"], icon: "VaultSecret" },

  // Logs (Grafana / generic)
  { tokens: ["pod", "logs"], icon: "logs" },
  { tokens: ["logs"], icon: "logs" },

  // Anomaly / alerting catch-alls
  { tokens: ["anomaly"], icon: "warn" },

  // ──────────────────────────────────────────────────────────────────
  // Generic-word rules — universal English nouns that appear in CRD
  // names regardless of vendor. More-specific rules must come first.
  // ──────────────────────────────────────────────────────────────────

  // Operator framework / OLM
  { tokens: ["catalog", "source"], icon: "CatalogSource" },
  { tokens: ["package", "catalog"], icon: "Catalog" },
  { tokens: ["package", "manifest"], icon: "Catalog" },
  { tokens: ["install", "plan"], icon: "InstallPlan" },
  { tokens: ["cluster", "service", "version"], icon: "ClusterServiceVersion" },
  { tokens: ["service", "version"], icon: "ClusterServiceVersion" },
  { tokens: ["operator"], icon: "Addon" },
  { tokens: ["addon"], icon: "Addon" },
  { tokens: ["add", "on"], icon: "Addon" },
  { tokens: ["package"], icon: "Bundle" },
  { tokens: ["bundle"], icon: "Bundle" },

  // Knative-style eventing / messaging
  { tokens: ["broker"], icon: "Broker" },
  { tokens: ["trigger"], icon: "Trigger" },
  { tokens: ["sink"], icon: "Sink" },
  { tokens: ["source"], icon: "Source" },
  { tokens: ["subscription"], icon: "Subscription" },
  { tokens: ["topic"], icon: "Topic" },
  { tokens: ["channel"], icon: "Channel" },
  { tokens: ["event"], icon: "Trigger" },

  // Functions / serverless
  { tokens: ["function"], icon: "FunctionGlyph" },
  { tokens: ["lambda"], icon: "FunctionGlyph" },

  // Catalog / image catalog / registry / index
  { tokens: ["image", "catalog"], icon: "ImageCatalog" },
  { tokens: ["catalog"], icon: "Catalog" },
  { tokens: ["registry"], icon: "Catalog" },
  { tokens: ["inventory"], icon: "Catalog" },
  { tokens: ["index"], icon: "Catalog" },
  { tokens: ["manifest"], icon: "Order" },

  // Failover / leader / quorum / replication topology
  { tokens: ["failover"], icon: "Failover" },
  { tokens: ["quorum"], icon: "Quorum" },
  { tokens: ["leader"], icon: "Leader" },
  { tokens: ["primary"], icon: "Leader" },
  { tokens: ["secondary"], icon: "Pool" },
  { tokens: ["standby"], icon: "Pool" },
  { tokens: ["election"], icon: "Quorum" },
  { tokens: ["consensus"], icon: "Quorum" },
  { tokens: ["replica"], icon: "ReplicaSet" },
  { tokens: ["replication"], icon: "Federation" },
  { tokens: ["shard"], icon: "Pool" },
  { tokens: ["partition"], icon: "Pool" },
  { tokens: ["pool"], icon: "Pool" },

  // Multi-tenancy / org / project / workspace / environment / region
  { tokens: ["tenant"], icon: "Tenant" },
  { tokens: ["organization"], icon: "Tenant" },
  { tokens: ["org"], icon: "Tenant" },
  { tokens: ["workspace"], icon: "Folder" },
  { tokens: ["environment"], icon: "Environment" },
  { tokens: ["env"], icon: "Environment" },
  { tokens: ["region"], icon: "Region" },
  { tokens: ["zone"], icon: "Region" },
  { tokens: ["domain"], icon: "Environment" },

  // Templates / profiles / presets
  { tokens: ["template"], icon: "Template" },
  { tokens: ["profile"], icon: "Template" },
  { tokens: ["preset"], icon: "Template" },
  { tokens: ["spec"], icon: "Template" },

  // ML / data / experiment
  { tokens: ["model"], icon: "Model" },
  { tokens: ["dataset"], icon: "Bucket" },
  { tokens: ["experiment"], icon: "Probe" },
  { tokens: ["feature"], icon: "Model" },
  { tokens: ["training"], icon: "Workflow" },
  { tokens: ["inference"], icon: "Workflow" },

  // Mesh / proxy / loadbalancer / tunnel
  { tokens: ["service", "mesh"], icon: "Mesh" },
  { tokens: ["mesh"], icon: "Mesh" },
  { tokens: ["proxy"], icon: "ProxyConfig" },
  { tokens: ["load", "balancer"], icon: "LoadBalancer" },
  { tokens: ["loadbalancer"], icon: "LoadBalancer" },
  { tokens: ["balancer"], icon: "LoadBalancer" },
  { tokens: ["tunnel"], icon: "Channel" },
  { tokens: ["vpn"], icon: "Channel" },

  // DB / data ops
  { tokens: ["migration"], icon: "Migration" },
  { tokens: ["schema"], icon: "Template" },
  { tokens: ["table"], icon: "Mesh" },
  { tokens: ["collection"], icon: "Bucket" },
  { tokens: ["document"], icon: "ConfigMap" },
  { tokens: ["query"], icon: "search" },

  // Telemetry / observability
  { tokens: ["dashboard"], icon: "Dashboard" },
  { tokens: ["panel"], icon: "Dashboard" },
  { tokens: ["chart"], icon: "Telemetry" },
  { tokens: ["trace"], icon: "Trace" },
  { tokens: ["span"], icon: "Trace" },
  { tokens: ["metric"], icon: "Telemetry" },

  // Security / sessions / credentials
  { tokens: ["session"], icon: "Schedule" },
  { tokens: ["token"], icon: "Issuer" },
  { tokens: ["credential"], icon: "Secret" },
  { tokens: ["grant"], icon: "Permission" },
  { tokens: ["scan"], icon: "ScrapeConfig" },
  { tokens: ["finding"], icon: "Report" },
  { tokens: ["vulnerability"], icon: "warn" },
  { tokens: ["compliance"], icon: "PolicyReport" },

  // Build / release / version
  { tokens: ["build", "config"], icon: "BackendConfig" },
  { tokens: ["build"], icon: "Workflow" },
  { tokens: ["release"], icon: "HelmRelease" },
  { tokens: ["version"], icon: "ClusterServiceVersion" },
  { tokens: ["deployment", "config"], icon: "Deployment" },

  // Networking generics
  { tokens: ["dns"], icon: "Environment" },
  { tokens: ["domain"], icon: "Environment" },
  { tokens: ["record"], icon: "ConfigMap" },
  { tokens: ["ip", "address"], icon: "Endpoint" },
  { tokens: ["ip", "pool"], icon: "Pool" },
  { tokens: ["subnet"], icon: "NetworkPolicy" },
  { tokens: ["vpc"], icon: "NetworkPolicy" },
  { tokens: ["firewall"], icon: "Role" },
  { tokens: ["nat"], icon: "Channel" },

  // Cluster topology — last resort if nothing more specific matched.
  { tokens: ["cluster"], icon: "cluster" },
  { tokens: ["instance"], icon: "DatabaseInstance" },
  { tokens: ["node"], icon: "Node" },
  { tokens: ["host"], icon: "Node" },
  { tokens: ["account"], icon: "User" },
  { tokens: ["membership"], icon: "Membership" },

  // Generic database CRDs (Postgresql, MongoDB, MySQL, Redis, etc.)
  { tokens: ["database"], icon: "DatabaseInstance" },
  { tokens: ["postgres"], icon: "DatabaseInstance" },
  { tokens: ["postgresql"], icon: "DatabaseInstance" },
  { tokens: ["mysql"], icon: "DatabaseInstance" },
  { tokens: ["mongo"], icon: "DatabaseInstance" },
  { tokens: ["redis"], icon: "DatabaseInstance" },
  { tokens: ["kafka"], icon: "DatabaseInstance" },
  { tokens: ["elastic"], icon: "DatabaseInstance" },

  // Broader concept fallbacks — use existing K8s glyphs for shape parity
  { tokens: ["network", "policy"], icon: "NetworkPolicy" },
  { tokens: ["policy"], icon: "Role" }, // shield
  { tokens: ["identity"], icon: "CiliumIdentity" },
  { tokens: ["provider"], icon: "Provider" },
  { tokens: ["receiver"], icon: "Receiver" },
  { tokens: ["route"], icon: "VirtualService" },
  { tokens: ["gateway"], icon: "Gateway" },
  { tokens: ["secret"], icon: "Secret" },
  { tokens: ["config"], icon: "ConfigMap" },
  { tokens: ["volume"], icon: "PersistentVolume" },
  { tokens: ["storage"], icon: "StorageClass" },
];

// Group-token heuristic. Triggered when no rule above matched. We split the
// group on `.` and look for ecosystem keywords.
const GROUP_RULES: { match: string; icon: string }[] = [
  { match: "monitoring.coreos", icon: "Prometheus" },
  { match: "victoriametrics", icon: "VictoriaMetrics" },
  { match: "monitoring", icon: "Prometheus" },
  { match: "prometheus", icon: "Prometheus" },
  { match: "thanos", icon: "ThanosRuler" },
  { match: "fluxcd", icon: "Kustomization" },
  { match: "argoproj", icon: "Application" },
  { match: "tekton", icon: "Pipeline" },
  { match: "velero", icon: "Backup" },
  { match: "cert-manager", icon: "Certificate" },
  { match: "snapshot", icon: "VolumeSnapshot" },
  { match: "cilium", icon: "CiliumEndpoint" },
  { match: "crossplane", icon: "Composition" },
  { match: "istio", icon: "VirtualService" },
  { match: "kyverno", icon: "Role" }, // shield
  { match: "wgpolicyk8s", icon: "PolicyReport" },
  { match: "rabbitmq", icon: "Queue" },
  { match: "envoyxds", icon: "EnvoyCluster" },
  { match: "dragonflydb", icon: "DatabaseInstance" },
  { match: "ricoberger", icon: "VaultSecret" },
  { match: "grafana", icon: "logs" },
  { match: "google.com", icon: "ManagedCertificate" },
  { match: "gke", icon: "ManagedCertificate" },
];

// Split a PascalCase / camelCase / dotted / underscored kind name into
// lowercased tokens. `HelmRelease` → `["helm", "release"]`.
// `HTTPSGateway` → `["https", "gateway"]`.
export function splitKindTokens(kind: string): string[] {
  return kind
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);
}

function lookupGlyph(name: string): ReactElement | undefined {
  if (name in CrdIcons) return CrdIcons[name];
  if (name in KindIcons) return KindIcons[name];
  if (name in Icons) return Icons[name as keyof typeof Icons];
  return undefined;
}

export function resolveKindIcon(
  kind: string,
  group: string,
  _category: Category,
): ReactElement {
  // 1) Built-in / Gateway API / Helm — exact match.
  const builtin = KindIcons[kind];
  if (builtin) return builtin;

  // 2) Curated (group, kind) override.
  const groupOverride = CRD_OVERRIDES[group]?.[kind];
  if (groupOverride) {
    const g = lookupGlyph(groupOverride);
    if (g) return g;
  }

  // 3) Token heuristic on the kind name.
  const tokens = splitKindTokens(kind);
  const tokenSet = new Set(tokens);
  for (const rule of TOKEN_RULES) {
    if (rule.tokens.every((t) => tokenSet.has(t))) {
      const g = lookupGlyph(rule.icon);
      if (g) return g;
    }
  }

  // 4) Group heuristic — search for ecosystem keywords in the group string.
  const groupLc = group.toLowerCase();
  for (const rule of GROUP_RULES) {
    if (groupLc.includes(rule.match)) {
      const g = lookupGlyph(rule.icon);
      if (g) return g;
    }
  }

  // 5) Final fallback — generic CRD glyph (hexagon-with-bracket).
  return Icons.crdGeneric;
}
