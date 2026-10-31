import { describe, it, expect } from "vitest";
import { clusterAllocationQuery, ksmQuery, parseClusterAllocation } from "./promql";

describe("ksmQuery", () => {
  it("queries kube-state-metrics v2 with the v1 name as fallback", () => {
    expect(ksmQuery("requests", "cpu", 'namespace="a",pod="p"')).toBe(
      '(sum(kube_pod_container_resource_requests{namespace="a",pod="p",resource="cpu"}) or sum(kube_pod_container_resource_requests_cpu_cores{namespace="a",pod="p"})) * 1000',
    );
    expect(ksmQuery("allocatable", "memory", 'node="n1"')).toBe(
      '(sum(kube_node_status_allocatable{node="n1",resource="memory"}) or sum(kube_node_status_allocatable_memory_bytes{node="n1"})) / (1024*1024)',
    );
  });

  it("drops the selector for cluster totals", () => {
    expect(ksmQuery("limits", "cpu", "")).toBe(
      '(sum(kube_pod_container_resource_limits{resource="cpu"}) or sum(kube_pod_container_resource_limits_cpu_cores)) * 1000',
    );
  });

  it("applies a workload owner join to both metric generations", () => {
    const q = ksmQuery("requests", "memory", 'namespace="a"', "(OWN)");
    expect(q.match(/\* on\(namespace,pod\) group_left\(\) \(OWN\)/g)).toHaveLength(2);
  });
});

describe("cluster allocation", () => {
  it("tags all six totals in one instant query", () => {
    const q = clusterAllocationQuery();
    expect(q.match(/label_replace\(/g)).toHaveLength(6);
    for (const k of ["cpuRequests", "cpuLimits", "cpuAllocatable", "memRequests", "memLimits", "memAllocatable"]) {
      expect(q).toContain(`"k", "${k}"`);
    }
  });

  it("parses the tagged vector and leaves missing totals null", () => {
    const a = parseClusterAllocation({
      resultType: "vector",
      result: [
        { metric: { k: "cpuRequests" }, value: [1, "1500"] },
        { metric: { k: "memAllocatable" }, value: [1, "8192"] },
        { metric: { k: "cpuLimits" }, value: [1, "NaN"] },
        { metric: { k: "bogus" }, value: [1, "3"] },
      ],
    });
    expect(a).toEqual({
      cpuRequests: 1500,
      cpuLimits: null,
      cpuAllocatable: null,
      memRequests: null,
      memLimits: null,
      memAllocatable: 8192,
    });
  });

  it("is null without kube-state-metrics or on a malformed response", () => {
    expect(parseClusterAllocation({ resultType: "vector", result: [] })).toBeNull();
    expect(parseClusterAllocation("nope")).toBeNull();
    expect(parseClusterAllocation(null)).toBeNull();
  });
});
