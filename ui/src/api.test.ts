// Unit tests for the typed `api` wrapper. Verifies that each method maps
// to the right Tauri command name with the right argument shape — a wire
// break here is exactly the kind of regression that's hard to spot in a
// running app because the backend silently no-ops on unknown commands.

import { describe, it, expect, beforeEach } from "vitest";
import { setMockInvoke, resetMockInvoke } from "./test/tauri-mock";
import { api } from "./api";

type Captured = { cmd: string; args?: Record<string, unknown> };

function captureNext(retval: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    return retval;
  });
  return { calls };
}

beforeEach(() => {
  resetMockInvoke();
});

describe("ping / updater plumbing", () => {
  it("ping → 'ping' with no args", async () => {
    const cap = captureNext({ name: "ferrisscope" });
    await api.ping();
    expect(cap.calls[0]?.cmd).toBe("ping");
    expect(cap.calls[0]?.args).toBeUndefined();
  });

  it("checkForUpdate → 'check_for_update'", async () => {
    const cap = captureNext({ kind: "up_to_date" });
    await api.checkForUpdate();
    expect(cap.calls[0]?.cmd).toBe("check_for_update");
  });

  it("applyUpdate forwards the release object verbatim", async () => {
    const cap = captureNext(undefined);
    const release = {
      version: "0.2.0",
      htmlUrl: "https://example.invalid/r",
      assetName: "fs-linux-x64.AppImage",
      downloadUrl: "https://example.invalid/dl",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await api.applyUpdate(release as any);
    expect(cap.calls[0]?.cmd).toBe("apply_update");
    expect(cap.calls[0]?.args).toEqual({ release });
  });
});

describe("contexts + connect", () => {
  it("listContexts → 'list_contexts' with no args", async () => {
    const cap = captureNext([]);
    await api.listContexts();
    expect(cap.calls[0]?.cmd).toBe("list_contexts");
  });

  it("connectContext passes name + connectId in camelCase", async () => {
    const cap = captureNext({ serverVersion: "v1.31.4", nodeCount: 1 });
    await api.connectContext("default::ctx-a", "abc-123");
    expect(cap.calls[0]?.cmd).toBe("connect_context");
    expect(cap.calls[0]?.args).toEqual({
      name: "default::ctx-a",
      connectId: "abc-123",
    });
  });
});

describe("subscribeResource", () => {
  it("defaults namespaceFilter to null", async () => {
    const cap = captureNext({ ok: true });
    await api.subscribeResource("ctx", "pods");
    expect(cap.calls[0]?.cmd).toBe("subscribe_resource");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "pods",
      namespaceFilter: null,
    });
  });

  it("forwards explicit namespaceFilter", async () => {
    const cap = captureNext({ ok: true });
    await api.subscribeResource("ctx", "pods", "default");
    expect(cap.calls[0]?.args?.namespaceFilter).toBe("default");
  });
});

describe("applyResource (SSA)", () => {
  it("ships the partial-object payload + force flag", async () => {
    const cap = captureNext({ kind: "applied", resource_version: "42" });
    const fields = { data: { KEY: "B" } };
    await api.applyResource("ctx", "configmaps", "default", "cm", fields, false);
    expect(cap.calls[0]?.cmd).toBe("apply_resource_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "configmaps",
      namespace: "default",
      name: "cm",
      fields,
      force: false,
    });
  });

  it("force=true is the conflict-takeover path", async () => {
    const cap = captureNext({ kind: "applied" });
    await api.applyResource("ctx", "configmaps", "default", "cm", {}, true);
    expect(cap.calls[0]?.args?.force).toBe(true);
  });
});

describe("deleteResource", () => {
  it("force-delete sends gracePeriodSeconds: 0", async () => {
    const cap = captureNext(undefined);
    await api.deleteResource("ctx", "pods", "default", "stuck", 0);
    expect(cap.calls[0]?.cmd).toBe("delete_resource_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "pods",
      namespace: "default",
      name: "stuck",
      gracePeriodSeconds: 0,
    });
  });

  it("default-grace sends gracePeriodSeconds: null", async () => {
    const cap = captureNext(undefined);
    await api.deleteResource("ctx", "pods", "default", "x", null);
    expect(cap.calls[0]?.args?.gracePeriodSeconds).toBeNull();
  });

  it("cluster-scoped resources pass namespace: null", async () => {
    const cap = captureNext(undefined);
    await api.deleteResource("ctx", "nodes", null, "worker-1", null);
    expect(cap.calls[0]?.args?.namespace).toBeNull();
  });
});

describe("cordonNode", () => {
  it("cordon=true and false both go through cordon_node_cmd", async () => {
    const cap = captureNext(undefined);
    await api.cordonNode("ctx", "worker-1", true);
    await api.cordonNode("ctx", "worker-1", false);
    expect(cap.calls).toHaveLength(2);
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      name: "worker-1",
      cordon: true,
    });
    expect(cap.calls[1]?.args?.cordon).toBe(false);
  });
});

describe("detail getters", () => {
  it("getPodDetail → get_pod_detail_cmd", async () => {
    const cap = captureNext({});
    await api.getPodDetail("ctx", "default", "p");
    expect(cap.calls[0]?.cmd).toBe("get_pod_detail_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      namespace: "default",
      name: "p",
    });
  });

  it("getNodeDetail (cluster-scoped) only takes clusterId + name", async () => {
    const cap = captureNext({});
    await api.getNodeDetail("ctx", "worker-1");
    expect(cap.calls[0]?.cmd).toBe("get_node_detail_cmd");
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx", name: "worker-1" });
  });
});

describe("getResourceYaml", () => {
  it("namespace null is preserved (cluster-scoped read)", async () => {
    const cap = captureNext("apiVersion: v1\nkind: Node\n...");
    await api.getResourceYaml("ctx", "nodes", null, "worker-1");
    expect(cap.calls[0]?.cmd).toBe("get_resource_yaml_cmd");
    expect(cap.calls[0]?.args?.namespace).toBeNull();
  });
});

// Detail getters all follow one of two shapes (namespaced vs cluster-scoped).
// Rather than write 30 near-identical tests, drive them table-style — that
// way a wire-format break in any one detail command surfaces clearly.

type NsDetailFn = (
  cluster: string,
  ns: string,
  name: string,
) => Promise<unknown>;
type ClDetailFn = (cluster: string, name: string) => Promise<unknown>;

const NS_DETAIL_CASES: Array<[string, NsDetailFn, string]> = [
  ["getDeploymentDetail", api.getDeploymentDetail, "get_deployment_detail_cmd"],
  ["getReplicaSetDetail", api.getReplicaSetDetail, "get_replica_set_detail_cmd"],
  ["getStatefulSetDetail", api.getStatefulSetDetail, "get_stateful_set_detail_cmd"],
  ["getDaemonSetDetail", api.getDaemonSetDetail, "get_daemon_set_detail_cmd"],
  ["getJobDetail", api.getJobDetail, "get_job_detail_cmd"],
  ["getCronJobDetail", api.getCronJobDetail, "get_cron_job_detail_cmd"],
  ["getEventDetail", api.getEventDetail, "get_event_detail_cmd"],
  ["getServiceDetail", api.getServiceDetail, "get_service_detail_cmd"],
  ["getEndpointsDetail", api.getEndpointsDetail, "get_endpoints_detail_cmd"],
  ["getEndpointSliceDetail", api.getEndpointSliceDetail, "get_endpoint_slice_detail_cmd"],
  ["getIngressDetail", api.getIngressDetail, "get_ingress_detail_cmd"],
  ["getNetworkPolicyDetail", api.getNetworkPolicyDetail, "get_network_policy_detail_cmd"],
  ["getConfigMapDetail", api.getConfigMapDetail, "get_config_map_detail_cmd"],
  ["getSecretDetail", api.getSecretDetail, "get_secret_detail_cmd"],
  ["getResourceQuotaDetail", api.getResourceQuotaDetail, "get_resource_quota_detail_cmd"],
  ["getLimitRangeDetail", api.getLimitRangeDetail, "get_limit_range_detail_cmd"],
  ["getPersistentVolumeClaimDetail", api.getPersistentVolumeClaimDetail, "get_persistent_volume_claim_detail_cmd"],
  ["getServiceAccountDetail", api.getServiceAccountDetail, "get_service_account_detail_cmd"],
  ["getRoleDetail", api.getRoleDetail, "get_role_detail_cmd"],
  ["getRoleBindingDetail", api.getRoleBindingDetail, "get_role_binding_detail_cmd"],
  ["getHorizontalPodAutoscalerDetail", api.getHorizontalPodAutoscalerDetail, "get_horizontal_pod_autoscaler_detail_cmd"],
  ["getPodDisruptionBudgetDetail", api.getPodDisruptionBudgetDetail, "get_pod_disruption_budget_detail_cmd"],
  ["getReplicationControllerDetail", api.getReplicationControllerDetail, "get_replication_controller_detail_cmd"],
  ["getLeaseDetail", api.getLeaseDetail, "get_lease_detail_cmd"],
  ["getHelmReleaseDetail", api.getHelmReleaseDetail, "get_helm_release_detail_cmd"],
];

const CL_DETAIL_CASES: Array<[string, ClDetailFn, string]> = [
  ["getNamespaceDetail", api.getNamespaceDetail, "get_namespace_detail_cmd"],
  ["getIngressClassDetail", api.getIngressClassDetail, "get_ingress_class_detail_cmd"],
  ["getPersistentVolumeDetail", api.getPersistentVolumeDetail, "get_persistent_volume_detail_cmd"],
  ["getStorageClassDetail", api.getStorageClassDetail, "get_storage_class_detail_cmd"],
  ["getCustomResourceDefinitionDetail", api.getCustomResourceDefinitionDetail, "get_custom_resource_definition_detail_cmd"],
  ["getClusterRoleDetail", api.getClusterRoleDetail, "get_cluster_role_detail_cmd"],
  ["getClusterRoleBindingDetail", api.getClusterRoleBindingDetail, "get_cluster_role_binding_detail_cmd"],
  ["getPriorityClassDetail", api.getPriorityClassDetail, "get_priority_class_detail_cmd"],
  ["getMutatingWebhookConfigurationDetail", api.getMutatingWebhookConfigurationDetail, "get_mutating_webhook_configuration_detail_cmd"],
  ["getValidatingWebhookConfigurationDetail", api.getValidatingWebhookConfigurationDetail, "get_validating_webhook_configuration_detail_cmd"],
];

describe.each(NS_DETAIL_CASES)("namespaced detail: %s", (_label, fn, cmd) => {
  it(`→ '${cmd}' with { clusterId, namespace, name }`, async () => {
    const cap = captureNext({});
    await fn("ctx", "default", "x");
    expect(cap.calls[0]?.cmd).toBe(cmd);
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      namespace: "default",
      name: "x",
    });
  });
});

describe.each(CL_DETAIL_CASES)("cluster-scoped detail: %s", (_label, fn, cmd) => {
  it(`→ '${cmd}' with { clusterId, name }`, async () => {
    const cap = captureNext({});
    await fn("ctx", "x");
    expect(cap.calls[0]?.cmd).toBe(cmd);
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx", name: "x" });
  });
});

describe("custom resources + well-known detail", () => {
  it("getCustomResourceDetail forwards a null namespace for cluster-scoped CRs", async () => {
    const cap = captureNext({});
    await api.getCustomResourceDetail("ctx", "crd:foo", null, "x");
    expect(cap.calls[0]?.cmd).toBe("get_custom_resource_detail_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "crd:foo",
      namespace: null,
      name: "x",
    });
  });

  it("getWellKnownDetail passes the full wkcrd id verbatim", async () => {
    const cap = captureNext({});
    await api.getWellKnownDetail("ctx", "wkcrd:httproute|gateway.networking.k8s.io|v1|httproutes|HTTPRoute|Namespaced", "default", "r");
    expect(cap.calls[0]?.cmd).toBe("get_well_known_detail_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "wkcrd:httproute|gateway.networking.k8s.io|v1|httproutes|HTTPRoute|Namespaced",
      namespace: "default",
      name: "r",
    });
  });
});

describe("listConfigMapsInNamespace / listSecretsInNamespace / listPvcsInNamespace", () => {
  it("each ships the standard { clusterId, namespace } pair", async () => {
    const cap = captureNext([]);
    await api.listConfigMapsInNamespace("ctx", "default");
    await api.listSecretsInNamespace("ctx", "default");
    await api.listPvcsInNamespace("ctx", "default");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "list_config_maps_in_namespace_cmd",
      "list_secrets_in_namespace_cmd",
      "list_persistent_volume_claims_in_namespace_cmd",
    ]);
    for (const c of cap.calls) {
      expect(c.args).toEqual({ clusterId: "ctx", namespace: "default" });
    }
  });
});

describe("resource kinds / search / index", () => {
  it("listResourceKinds takes no args", async () => {
    const cap = captureNext([]);
    await api.listResourceKinds();
    expect(cap.calls[0]?.cmd).toBe("list_resource_kinds");
    expect(cap.calls[0]?.args).toBeUndefined();
  });

  it("listCustomResourceKinds requires a connected clusterId", async () => {
    const cap = captureNext([]);
    await api.listCustomResourceKinds("ctx");
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx" });
  });

  it("searchClusterIndex forwards query + limit", async () => {
    const cap = captureNext([]);
    await api.searchClusterIndex("ctx", "nginx", 25);
    expect(cap.calls[0]?.cmd).toBe("search_cluster_index");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      query: "nginx",
      limit: 25,
    });
  });

  it("dropClusterWatchers / reconnectCluster / cancelConnect / unsubscribeResource each take their identifier(s)", async () => {
    const cap = captureNext(undefined);
    await api.dropClusterWatchers("ctx");
    await api.reconnectCluster("ctx");
    await api.cancelConnect("conn-1");
    await api.unsubscribeResource("ctx", "pods");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "drop_cluster_watchers",
      "reconnect_cluster",
      "cancel_connect",
      "unsubscribe_resource",
    ]);
    expect(cap.calls[2]?.args).toEqual({ connectId: "conn-1" });
    expect(cap.calls[3]?.args).toEqual({ clusterId: "ctx", kindId: "pods" });
  });
});

describe("node operations", () => {
  it("drainNode forwards force flag", async () => {
    const cap = captureNext({ evicted: [], blocked: [] });
    await api.drainNode("ctx", "worker-1", true);
    expect(cap.calls[0]?.cmd).toBe("drain_node_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      name: "worker-1",
      force: true,
    });
  });

  it("listPodsOnNode uses node (not name) as the key", async () => {
    const cap = captureNext([]);
    await api.listPodsOnNode("ctx", "worker-1");
    expect(cap.calls[0]?.cmd).toBe("list_pods_on_node_cmd");
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx", node: "worker-1" });
  });
});

describe("pod / workload restart", () => {
  it("restartPod returns [ownerKind, ownerName] verbatim", async () => {
    const cap = captureNext(["Deployment", "api"]);
    const out = await api.restartPod("ctx", "default", "api-0");
    expect(out).toEqual(["Deployment", "api"]);
    expect(cap.calls[0]?.cmd).toBe("restart_pod_cmd");
  });

  it("restartPods forwards the [namespace, name] pairs as-is", async () => {
    const cap = captureNext({ restarted: 1, errors: [] });
    await api.restartPods("ctx", [
      ["default", "a-0"],
      ["default", "a-1"],
    ]);
    expect(cap.calls[0]?.cmd).toBe("restart_pods_cmd");
    expect(cap.calls[0]?.args?.pods).toEqual([
      ["default", "a-0"],
      ["default", "a-1"],
    ]);
  });

  it("restartWorkload carries kind + namespace + name", async () => {
    const cap = captureNext(undefined);
    await api.restartWorkload("ctx", "Deployment", "default", "api");
    expect(cap.calls[0]?.cmd).toBe("restart_workload_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kind: "Deployment",
      namespace: "default",
      name: "api",
    });
  });
});

describe("helm", () => {
  it("upgradeHelmRelease defaults chartSource / chartVersion to null", async () => {
    const cap = captureNext({ status: "ok", revision: 2 });
    await api.upgradeHelmRelease("ctx", "default", "rel", "v: 1\n");
    expect(cap.calls[0]?.cmd).toBe("upgrade_helm_release_cmd");
    expect(cap.calls[0]?.args?.chartSource).toBeNull();
    expect(cap.calls[0]?.args?.chartVersion).toBeNull();
  });

  it("upgradeHelmRelease forwards an explicit upgrade target", async () => {
    const cap = captureNext({ status: "ok", revision: 3 });
    await api.upgradeHelmRelease(
      "ctx",
      "default",
      "rel",
      "v: 2\n",
      "bitnami",
      "1.2.3",
    );
    expect(cap.calls[0]?.args?.chartSource).toBe("bitnami");
    expect(cap.calls[0]?.args?.chartVersion).toBe("1.2.3");
  });

  it("installHelmChart packages every arg through", async () => {
    const cap = captureNext({ status: "ok", revision: 1 });
    await api.installHelmChart(
      "ctx",
      "bitnami",
      "default",
      "rel",
      "nginx",
      "13.0.0",
      "v: 1\n",
    );
    expect(cap.calls[0]?.cmd).toBe("install_helm_chart_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      source: "bitnami",
      namespace: "default",
      releaseName: "rel",
      chartName: "nginx",
      chartVersion: "13.0.0",
      valuesYaml: "v: 1\n",
    });
  });

  it("helmRepoUpdate takes no args", async () => {
    const cap = captureNext(3);
    await api.helmRepoUpdate();
    expect(cap.calls[0]?.cmd).toBe("helm_repo_update_cmd");
    expect(cap.calls[0]?.args).toBeUndefined();
  });
});

describe("port-forward", () => {
  it("pfStart serialises the full target spec including pinned + requestedLocalPort", async () => {
    const cap = captureNext({
      id: "pf-1",
      cluster_id: "ctx",
      target: { kind: "Pod", namespace: "default", name: "p" },
      remote_port: 80,
      local_port: 8080,
      status: "Active",
      pinned: true,
    });
    await api.pfStart(
      "ctx",
      { kind: "Pod", namespace: "default", name: "p" },
      80,
      8080,
      true,
    );
    expect(cap.calls[0]?.cmd).toBe("pf_start");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      target: { kind: "Pod", namespace: "default", name: "p" },
      remotePort: 80,
      requestedLocalPort: 8080,
      pinned: true,
    });
  });

  it("pfStop / pfList / pfSetAutostart route to their commands", async () => {
    const cap = captureNext(undefined);
    await api.pfStop("pf-1");
    await api.pfList();
    await api.pfSetAutostart("pf-1", false);
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "pf_stop",
      "pf_list",
      "pf_set_autostart",
    ]);
    expect(cap.calls[0]?.args).toEqual({ id: "pf-1" });
    expect(cap.calls[2]?.args).toEqual({ id: "pf-1", pinned: false });
  });
});

describe("kubeconfig sources", () => {
  it("listKubeconfigSources / addKubeconfigSource / removeKubeconfigSource", async () => {
    const cap = captureNext({ sources: [], default_disabled: false });
    await api.listKubeconfigSources();
    await api.addKubeconfigSource("/tmp/foo");
    await api.removeKubeconfigSource("src-1");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "list_kubeconfig_sources",
      "add_kubeconfig_source",
      "remove_kubeconfig_source",
    ]);
    expect(cap.calls[1]?.args).toEqual({ path: "/tmp/foo" });
    expect(cap.calls[2]?.args).toEqual({ id: "src-1" });
  });

  it("updateKubeconfigSource only includes fields the caller set (Option<Option> wire shape)", async () => {
    const cap = captureNext({});
    await api.updateKubeconfigSource("src-1", { enabled: false });
    // group_override is NOT in the patch — leave it alone semantics.
    const patch = cap.calls[0]?.args?.patch as Record<string, unknown>;
    expect(patch).toEqual({ enabled: false });
    expect("group_override" in patch).toBe(false);
  });

  it("updateKubeconfigSource: explicit null clears the override", async () => {
    const cap = captureNext({});
    await api.updateKubeconfigSource("src-1", { groupOverride: null });
    const patch = cap.calls[0]?.args?.patch as Record<string, unknown>;
    expect(patch.group_override).toBeNull();
    expect("enabled" in patch).toBe(false);
  });

  it("setDefaultKubeconfigDisabled is a single bool wire arg", async () => {
    const cap = captureNext(undefined);
    await api.setDefaultKubeconfigDisabled(true);
    expect(cap.calls[0]?.cmd).toBe("set_default_kubeconfig_disabled");
    expect(cap.calls[0]?.args).toEqual({ disabled: true });
  });

  it("deleteKubeconfigContext / setCurrentKubeconfigContext / deleteKubeconfigFile all take clusterId", async () => {
    const cap = captureNext(undefined);
    await api.deleteKubeconfigContext("ctx");
    await api.setCurrentKubeconfigContext("ctx");
    await api.deleteKubeconfigFile("ctx");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "delete_kubeconfig_context",
      "set_current_kubeconfig_context",
      "delete_kubeconfig_file",
    ]);
    for (const c of cap.calls) {
      expect(c.args).toEqual({ clusterId: "ctx" });
    }
  });
});

describe("fleet probes", () => {
  it("getFleetCache takes no args; refreshFleet defaults force=false", async () => {
    const cap = captureNext({});
    await api.getFleetCache();
    await api.refreshFleet(["a", "b"]);
    expect(cap.calls[0]?.cmd).toBe("get_fleet_cache");
    expect(cap.calls[1]?.cmd).toBe("refresh_fleet");
    expect(cap.calls[1]?.args).toEqual({ contexts: ["a", "b"], force: false });
  });

  it("refreshFleet passes force=true explicitly", async () => {
    const cap = captureNext(undefined);
    await api.refreshFleet(["a"], true);
    expect(cap.calls[0]?.args?.force).toBe(true);
  });
});

describe("metrics + prefs + table views", () => {
  it("subscribeMetrics / unsubscribeMetrics", async () => {
    const cap = captureNext(null);
    await api.subscribeMetrics("ctx");
    await api.unsubscribeMetrics("ctx");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "subscribe_metrics",
      "unsubscribe_metrics",
    ]);
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx" });
  });

  it("getPrefs / setPrefs round-trip the prefs object", async () => {
    const cap = captureNext({});
    const prefs = { theme: { id: "default" } } as unknown as Parameters<
      typeof api.setPrefs
    >[0];
    await api.getPrefs();
    await api.setPrefs(prefs);
    expect(cap.calls[0]?.cmd).toBe("get_prefs");
    expect(cap.calls[1]?.cmd).toBe("set_prefs");
    expect(cap.calls[1]?.args).toEqual({ prefs });
  });

  it("getTableViews / setTableView", async () => {
    const cap = captureNext({ views: {} });
    await api.getTableViews();
    const view = { columns: [], sort: null } as unknown as Parameters<
      typeof api.setTableView
    >[2];
    await api.setTableView("ctx", "pods", view);
    expect(cap.calls[1]?.cmd).toBe("set_table_view");
    expect(cap.calls[1]?.args).toEqual({
      clusterId: "ctx",
      kindId: "pods",
      view,
    });
  });
});

describe("Prometheus", () => {
  it("discoverPrometheusTargets / getPrometheusTarget / setPrometheusTarget / prometheusRedetect", async () => {
    const cap = captureNext(null);
    await api.discoverPrometheusTargets("ctx");
    await api.getPrometheusTarget("ctx");
    await api.setPrometheusTarget("ctx", null);
    await api.prometheusRedetect("ctx");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "discover_prometheus_targets",
      "get_prometheus_target",
      "set_prometheus_target",
      "prometheus_redetect",
    ]);
    expect(cap.calls[2]?.args).toEqual({ clusterId: "ctx", target: null });
  });

  it("prometheusQueryInstant / prometheusQueryRange forward query + window args", async () => {
    const cap = captureNext({});
    await api.prometheusQueryInstant("ctx", "up");
    await api.prometheusQueryRange("ctx", "rate(x[5m])", "1", "2", "15s");
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx", query: "up" });
    expect(cap.calls[1]?.args).toEqual({
      clusterId: "ctx",
      query: "rate(x[5m])",
      start: "1",
      end: "2",
      step: "15s",
    });
  });
});

describe("AI agent + chat", () => {
  it("aiGetSettings / aiSetSettings / aiSetCredential / aiDeleteCredential / aiOauthLogin / aiOauthCancel / aiTestProvider / aiListModels / mcpTestServer", async () => {
    const cap = captureNext({});
    await api.aiGetSettings();
    await api.aiSetSettings({} as Parameters<typeof api.aiSetSettings>[0]);
    await api.aiSetCredential("anthropic", { type: "api_key", key: "k" } as Parameters<typeof api.aiSetCredential>[1]);
    await api.aiDeleteCredential("anthropic");
    await api.aiOauthLogin("anthropic");
    await api.aiOauthCancel();
    await api.aiTestProvider({} as Parameters<typeof api.aiTestProvider>[0]);
    await api.aiListModels("anthropic");
    await api.mcpTestServer({} as Parameters<typeof api.mcpTestServer>[0]);
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "ai_get_settings",
      "ai_set_settings",
      "ai_set_credential",
      "ai_delete_credential",
      "ai_oauth_login",
      "ai_oauth_cancel",
      "ai_test_provider",
      "ai_list_models",
      "mcp_test_server",
    ]);
    expect(cap.calls[2]?.args?.provider).toBe("anthropic");
    expect(cap.calls[7]?.args).toEqual({ provider: "anthropic" });
  });

  it("aiListModels without provider arg sends provider: undefined (active provider)", async () => {
    const cap = captureNext([]);
    await api.aiListModels();
    expect(cap.calls[0]?.args).toEqual({ provider: undefined });
  });

  it("chat session lifecycle commands", async () => {
    const cap = captureNext({});
    await api.chatCreateSession("ctx", "claude-opus-4-7");
    await api.chatListSessions("ctx");
    await api.chatListSessions(null);
    await api.chatLoadSession("s-1");
    await api.chatRenameSession("s-1", "renamed");
    await api.chatDeleteSession("s-1");
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "chat_create_session",
      "chat_list_sessions",
      "chat_list_sessions",
      "chat_load_session",
      "chat_rename_session",
      "chat_delete_session",
    ]);
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx", model: "claude-opus-4-7" });
    expect(cap.calls[2]?.args).toEqual({ clusterId: null });
    expect(cap.calls[4]?.args).toEqual({ sessionId: "s-1", title: "renamed" });
  });

  it("chat runtime commands forward chatId / decision payloads", async () => {
    const cap = captureNext(undefined);
    await api.chatSendMessage("c-1", "hi");
    await api.chatCancelStreaming("c-1");
    await api.chatSetApprovalMode("c-1", "review" as Parameters<typeof api.chatSetApprovalMode>[1]);
    await api.chatSetModel("c-1", "claude-opus-4-7");
    await api.chatCompact("c-1");
    await api.chatRefreshStatus("c-1");
    await api.chatListTools("c-1");
    await api.chatClose("c-1");
    await api.chatApproveToolCall("c-1", "tc-1", "allow" as Parameters<typeof api.chatApproveToolCall>[2]);
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "chat_send_message",
      "chat_cancel_streaming",
      "chat_set_approval_mode",
      "chat_set_model",
      "chat_compact",
      "chat_refresh_status",
      "chat_list_tools",
      "chat_close",
      "chat_approve_tool_call",
    ]);
    expect(cap.calls[0]?.args).toEqual({ chatId: "c-1", content: "hi" });
    expect(cap.calls[2]?.args).toEqual({ chatId: "c-1", mode: "review" });
    expect(cap.calls[8]?.args).toEqual({
      chatId: "c-1",
      toolCallId: "tc-1",
      decision: "allow",
    });
  });
});

describe("kubectl management", () => {
  it("kubectlGetStatus / kubectlInstallManaged / kubectlUninstallManaged", async () => {
    const cap = captureNext({});
    await api.kubectlGetStatus();
    await api.kubectlInstallManaged();
    await api.kubectlUninstallManaged();
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "kubectl_get_status",
      "kubectl_install_managed",
      "kubectl_uninstall_managed",
    ]);
  });
});

describe("helm management", () => {
  it("helmGetStatus / helmInstallManaged / helmUninstallManaged", async () => {
    const cap = captureNext({});
    await api.helmGetStatus();
    await api.helmInstallManaged();
    await api.helmUninstallManaged();
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "helm_get_status",
      "helm_install_managed",
      "helm_uninstall_managed",
    ]);
  });
});

describe("applyYaml / dev memory", () => {
  it("applyYaml forwards dryRun + force flags", async () => {
    const cap = captureNext([]);
    await api.applyYaml("ctx", "kind: Pod\n", true, false);
    expect(cap.calls[0]?.cmd).toBe("apply_yaml_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      yaml: "kind: Pod\n",
      dryRun: true,
      force: false,
    });
  });

  it("dev memory diag commands take no args", async () => {
    const cap = captureNext({});
    await api.devMemoryStats();
    await api.devCompactMemory();
    await api.updaterInfo();
    expect(cap.calls.map((c) => c.cmd)).toEqual([
      "dev_memory_stats",
      "dev_compact_memory",
      "updater_info",
    ]);
    for (const c of cap.calls) expect(c.args).toBeUndefined();
  });
});
