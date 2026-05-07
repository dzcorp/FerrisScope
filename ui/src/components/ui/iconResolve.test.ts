import { describe, it, expect } from "vitest";
import { resolveKindIcon, splitKindTokens } from "./iconResolve";
import { CrdIcons, Icons, KindIcons } from "./icons";

describe("splitKindTokens", () => {
  it("splits PascalCase into lowercased tokens", () => {
    expect(splitKindTokens("HelmRelease")).toEqual(["helm", "release"]);
    expect(splitKindTokens("CertificateRequest")).toEqual([
      "certificate",
      "request",
    ]);
    expect(splitKindTokens("VolumeSnapshotClass")).toEqual([
      "volume",
      "snapshot",
      "class",
    ]);
  });

  it("handles consecutive capitals (acronyms) correctly", () => {
    expect(splitKindTokens("HTTPRoute")).toEqual(["http", "route"]);
    expect(splitKindTokens("OCIRepository")).toEqual(["oci", "repository"]);
    expect(splitKindTokens("APIService")).toEqual(["api", "service"]);
  });

  it("treats dots, dashes and underscores as separators", () => {
    expect(splitKindTokens("foo.bar_baz-qux")).toEqual([
      "foo",
      "bar",
      "baz",
      "qux",
    ]);
  });
});

describe("resolveKindIcon", () => {
  it("returns the built-in glyph for known K8s kinds", () => {
    expect(resolveKindIcon("Pod", "", "Workloads")).toBe(KindIcons.Pod);
    expect(resolveKindIcon("Deployment", "apps", "Workloads")).toBe(
      KindIcons.Deployment,
    );
    expect(resolveKindIcon("HTTPRoute", "gateway.networking.k8s.io", "Network"))
      .toBe(KindIcons.HTTPRoute);
    expect(
      resolveKindIcon(
        "CustomResourceDefinition",
        "apiextensions.k8s.io",
        "Cluster",
      ),
    ).toBe(KindIcons.CustomResourceDefinition);
  });

  it("resolves curated (group, kind) overrides for the screenshot CRDs", () => {
    const cases: Array<[string, string, keyof typeof CrdIcons]> = [
      ["Certificate", "cert-manager.io", "Certificate"],
      ["Issuer", "cert-manager.io", "Issuer"],
      ["ClusterIssuer", "cert-manager.io", "ClusterIssuer"],
      ["CertificateRequest", "cert-manager.io", "CertificateRequest"],
      ["Challenge", "acme.cert-manager.io", "Challenge"],
      ["Order", "acme.cert-manager.io", "Order"],
      ["Prometheus", "monitoring.coreos.com", "Prometheus"],
      ["Alertmanager", "monitoring.coreos.com", "Alertmanager"],
      ["AlertmanagerConfig", "monitoring.coreos.com", "AlertmanagerConfig"],
      ["PodMonitor", "monitoring.coreos.com", "PodMonitor"],
      ["ServiceMonitor", "monitoring.coreos.com", "ServiceMonitor"],
      ["Probe", "monitoring.coreos.com", "Probe"],
      ["PrometheusRule", "monitoring.coreos.com", "PrometheusRule"],
      ["ScrapeConfig", "monitoring.coreos.com", "ScrapeConfig"],
      ["ThanosRuler", "monitoring.coreos.com", "ThanosRuler"],
      ["Kustomization", "kustomize.toolkit.fluxcd.io", "Kustomization"],
      ["Bucket", "source.toolkit.fluxcd.io", "Bucket"],
      ["Alert", "notification.toolkit.fluxcd.io", "Alert"],
      ["Provider", "notification.toolkit.fluxcd.io", "Provider"],
      ["Receiver", "notification.toolkit.fluxcd.io", "Receiver"],
      ["VolumeSnapshot", "snapshot.storage.k8s.io", "VolumeSnapshot"],
      ["VolumeSnapshotClass", "snapshot.storage.k8s.io", "VolumeSnapshotClass"],
      [
        "VolumeSnapshotContent",
        "snapshot.storage.k8s.io",
        "VolumeSnapshotContent",
      ],
      ["ServiceExport", "multicluster.x-k8s.io", "ServiceExport"],
      ["ServiceImport", "multicluster.x-k8s.io", "ServiceImport"],
    ];
    for (const [kind, group, expected] of cases) {
      expect(
        resolveKindIcon(kind, group, "CustomResources"),
        `${kind}@${group}`,
      ).toBe(CrdIcons[expected]);
    }
  });

  it("falls back to the token heuristic when no curated entry exists", () => {
    // Synthetic CRDs from imaginary vendors, not in the curated table.
    expect(
      resolveKindIcon("AcmeCertificate", "acme.example.io", "CustomResources"),
    ).toBe(CrdIcons.Certificate);
    expect(
      resolveKindIcon(
        "VendorBackupSchedule",
        "vendor.example.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.Backup); // "backup" matches before "schedule" (rule order)
    expect(
      resolveKindIcon(
        "WeirdHelmRelease",
        "vendor.example.io",
        "CustomResources",
      ),
    ).toBe(KindIcons.HelmRelease);
    expect(
      resolveKindIcon(
        "CustomDatabase",
        "vendor.example.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.DatabaseInstance);
  });

  it("falls back to the group heuristic when token rules miss", () => {
    // Kind that doesn't trigger any token rule, but its group does.
    expect(
      resolveKindIcon(
        "FooBar",
        "monitoring.coreos.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.Prometheus);
    expect(
      resolveKindIcon("Whatever", "tekton.dev", "CustomResources"),
    ).toBe(CrdIcons.Pipeline);
    expect(
      resolveKindIcon("Anything", "velero.io", "CustomResources"),
    ).toBe(CrdIcons.Backup);
  });

  it("returns the generic CRD glyph as the final fallback", () => {
    expect(
      resolveKindIcon("Mystery", "unknown.example.io", "CustomResources"),
    ).toBe(Icons.crdGeneric);
  });

  it("resolves Kyverno policy/report kinds", () => {
    expect(resolveKindIcon("ClusterPolicy", "kyverno.io", "CustomResources"))
      .toBe(KindIcons.Role);
    expect(
      resolveKindIcon("CleanupPolicy", "kyverno.io", "CustomResources"),
    ).toBe(CrdIcons.CleanupPolicy);
    expect(
      resolveKindIcon("PolicyException", "kyverno.io", "CustomResources"),
    ).toBe(CrdIcons.PolicyException);
    expect(
      resolveKindIcon(
        "ValidatingPolicy",
        "policies.kyverno.io",
        "CustomResources",
      ),
    ).toBe(KindIcons.ValidatingWebhookConfiguration);
    expect(
      resolveKindIcon(
        "MutatingPolicy",
        "policies.kyverno.io",
        "CustomResources",
      ),
    ).toBe(KindIcons.MutatingWebhookConfiguration);
    expect(
      resolveKindIcon(
        "EphemeralReport",
        "reports.kyverno.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.EphemeralReport);
    expect(
      resolveKindIcon("PolicyReport", "wgpolicyk8s.io", "CustomResources"),
    ).toBe(CrdIcons.PolicyReport);
    expect(
      resolveKindIcon(
        "ClusterPolicyReport",
        "wgpolicyk8s.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.PolicyReport);
  });

  it("resolves RabbitMQ kinds via curated overrides", () => {
    expect(resolveKindIcon("Queue", "rabbitmq.com", "CustomResources")).toBe(
      CrdIcons.Queue,
    );
    expect(
      resolveKindIcon("Exchange", "rabbitmq.com", "CustomResources"),
    ).toBe(CrdIcons.Exchange);
    expect(
      resolveKindIcon("Binding", "rabbitmq.com", "CustomResources"),
    ).toBe(CrdIcons.Binding);
    expect(resolveKindIcon("Vhost", "rabbitmq.com", "CustomResources")).toBe(
      CrdIcons.VirtualHost,
    );
    expect(resolveKindIcon("User", "rabbitmq.com", "CustomResources")).toBe(
      CrdIcons.User,
    );
    expect(resolveKindIcon("Shovel", "rabbitmq.com", "CustomResources")).toBe(
      CrdIcons.Shovel,
    );
    expect(
      resolveKindIcon("RabbitmqCluster", "rabbitmq.com", "CustomResources"),
    ).toBe(CrdIcons.RabbitmqCluster);
  });

  it("resolves VictoriaMetrics kinds via curated overrides", () => {
    expect(
      resolveKindIcon(
        "VMCluster",
        "operator.victoriametrics.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.VMCluster);
    expect(
      resolveKindIcon(
        "VMSingle",
        "operator.victoriametrics.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.VMSingle);
    expect(
      resolveKindIcon(
        "VMAnomaly",
        "operator.victoriametrics.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.VMAnomaly);
    expect(
      resolveKindIcon(
        "VMServiceScrape",
        "operator.victoriametrics.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.ServiceMonitor);
    expect(
      resolveKindIcon(
        "VMRule",
        "operator.victoriametrics.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.PrometheusRule);
  });

  it("resolves Envoy XDS kinds", () => {
    expect(
      resolveKindIcon("Cluster", "envoyxds.io", "CustomResources"),
    ).toBe(CrdIcons.EnvoyCluster);
    expect(
      resolveKindIcon("Listener", "envoyxds.io", "CustomResources"),
    ).toBe(CrdIcons.Listener);
    expect(
      resolveKindIcon("Endpoint", "envoyxds.io", "CustomResources"),
    ).toBe(CrdIcons.Endpoint);
    expect(resolveKindIcon("Route", "envoyxds.io", "CustomResources")).toBe(
      CrdIcons.EnvoyRoute,
    );
    expect(
      resolveKindIcon("TLSSecret", "envoyxds.io", "CustomResources"),
    ).toBe(CrdIcons.TLSSecret);
  });

  it("resolves Istio extras", () => {
    expect(
      resolveKindIcon(
        "EnvoyFilter",
        "networking.istio.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.EnvoyFilter);
    expect(
      resolveKindIcon("Sidecar", "networking.istio.io", "CustomResources"),
    ).toBe(CrdIcons.Sidecar);
    expect(
      resolveKindIcon(
        "WorkloadEntry",
        "networking.istio.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.WorkloadEntry);
    expect(
      resolveKindIcon(
        "WasmPlugin",
        "extensions.istio.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.WasmPlugin);
    expect(
      resolveKindIcon(
        "Telemetry",
        "telemetry.istio.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.Telemetry);
  });

  it("resolves GKE / Google Cloud kinds", () => {
    expect(
      resolveKindIcon(
        "ManagedCertificate",
        "networking.gke.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.ManagedCertificate);
    expect(
      resolveKindIcon(
        "ComputeClass",
        "cloud.google.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.ComputeClass);
    expect(
      resolveKindIcon(
        "BackendConfig",
        "cloud.google.com",
        "CustomResources",
      ),
    ).toBe(CrdIcons.BackendConfig);
    expect(
      resolveKindIcon("Membership", "hub.gke.io", "CustomResources"),
    ).toBe(CrdIcons.Membership);
    expect(
      resolveKindIcon(
        "AllowlistedWorkload",
        "auto.gke.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.Allowlist);
  });

  it("resolves generic English nouns via the token heuristic", () => {
    // Simulating arbitrary CRDs whose vendor we don't know — these should
    // resolve by token shape alone.
    const cases: Array<[string, string, unknown]> = [
      ["MyVendorCluster", "vendor.io", KindIcons.cluster ?? Icons.cluster],
      ["FailoverGroup", "vendor.io", CrdIcons.Failover],
      // QuorumQueue is a real RabbitMQ concept; Queue (more specific to messaging)
      // wins over the generic Quorum atom. A bare QuorumGroup falls through.
      ["QuorumQueue", "vendor.io", CrdIcons.Queue],
      ["QuorumGroup", "vendor.io", CrdIcons.Quorum],
      ["MySubscription", "vendor.io", CrdIcons.Subscription],
      ["EventTopic", "vendor.io", CrdIcons.Topic],
      ["MessageChannel", "vendor.io", CrdIcons.Channel],
      ["TenantConfig", "vendor.io", CrdIcons.Tenant],
      ["EnvironmentSpec", "vendor.io", CrdIcons.Environment],
      ["JobTemplate", "vendor.io", CrdIcons.Template],
      ["AIModel", "vendor.io", CrdIcons.Model],
      ["ServiceMesh", "vendor.io", CrdIcons.Mesh],
      ["LoadBalancer", "vendor.io", CrdIcons.LoadBalancer],
      ["DataMigration", "vendor.io", CrdIcons.Migration],
      ["ResourceBundle", "vendor.io", CrdIcons.Bundle],
      ["GrafanaDashboard", "vendor.io", CrdIcons.Dashboard],
      ["Trace", "vendor.io", CrdIcons.Trace],
      ["WorkerPool", "vendor.io", CrdIcons.Pool],
      ["RegionConfig", "vendor.io", CrdIcons.Region],
      ["MyAddon", "vendor.io", CrdIcons.Addon],
      ["EdgeFunction", "vendor.io", CrdIcons.FunctionGlyph],
      ["EventBroker", "vendor.io", CrdIcons.Broker],
      ["Trigger", "vendor.io", CrdIcons.Trigger],
      ["EventSink", "vendor.io", CrdIcons.Sink],
      ["EventSource", "vendor.io", CrdIcons.Source],
      ["ImageCatalog", "vendor.io", CrdIcons.ImageCatalog],
      ["PackageCatalog", "vendor.io", CrdIcons.Catalog],
      ["DockerRegistry", "vendor.io", CrdIcons.Catalog],
      ["LeaderElection", "vendor.io", CrdIcons.Leader], // leader wins (more specific)
      ["ShardConfig", "vendor.io", CrdIcons.Pool],
      ["CatalogSource", "operators.coreos.com", CrdIcons.CatalogSource],
      ["InstallPlan", "operators.coreos.com", CrdIcons.InstallPlan],
      [
        "ClusterServiceVersion",
        "operators.coreos.com",
        CrdIcons.ClusterServiceVersion,
      ],
    ];
    for (const [kind, group, expected] of cases) {
      expect(
        resolveKindIcon(kind, group, "CustomResources"),
        `${kind}@${group}`,
      ).toBe(expected);
    }
  });

  it("resolves Vault, Dragonfly, Grafana, autoscaling kinds", () => {
    expect(
      resolveKindIcon("VaultSecret", "ricoberger.de", "CustomResources"),
    ).toBe(CrdIcons.VaultSecret);
    expect(
      resolveKindIcon("Dragonfly", "dragonflydb.io", "CustomResources"),
    ).toBe(CrdIcons.DatabaseInstance);
    expect(
      resolveKindIcon(
        "PodLogs",
        "monitoring.grafana.com",
        "CustomResources",
      ),
    ).toBe(Icons.logs);
    expect(
      resolveKindIcon(
        "ProvisioningRequest",
        "autoscaling.x-k8s.io",
        "CustomResources",
      ),
    ).toBe(CrdIcons.ProvisioningRequest);
  });
});
