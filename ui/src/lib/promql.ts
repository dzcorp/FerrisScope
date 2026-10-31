/// kube-state-metrics series for one resource, v2 names with the v1 fallback.
/// `sel` is a PromQL label matcher body (`namespace="a",pod="b"`).
export function ksmQuery(
  kind: "requests" | "limits" | "allocatable" | "capacity",
  resource: "cpu" | "memory",
  sel: string,
  /// Optional `on(namespace,pod)` join (workload owner chain).
  join?: string,
): string {
  const v2 =
    kind === "requests" || kind === "limits"
      ? `kube_pod_container_resource_${kind}`
      : `kube_node_status_${kind}`;
  const v1 = `${v2}_${resource === "cpu" ? "cpu_cores" : "memory_bytes"}`;
  const s = sel ? `${sel},` : "";
  const j = (v: string) => (join ? `${v} * on(namespace,pod) group_left() ${join}` : v);
  const inner = `sum(${j(`${v2}{${s}resource="${resource}"}`)}) or sum(${j(`${v1}${sel ? `{${sel}}` : ""}`)})`;
  return resource === "cpu" ? `(${inner}) * 1000` : `(${inner}) / (1024*1024)`;
}

export type ClusterAllocation = {
  cpuRequests: number | null;
  cpuLimits: number | null;
  cpuAllocatable: number | null;
  memRequests: number | null;
  memLimits: number | null;
  memAllocatable: number | null;
};

const ALLOCATION_KEYS: [keyof ClusterAllocation, Parameters<typeof ksmQuery>[0], "cpu" | "memory"][] = [
  ["cpuRequests", "requests", "cpu"],
  ["cpuLimits", "limits", "cpu"],
  ["cpuAllocatable", "allocatable", "cpu"],
  ["memRequests", "requests", "memory"],
  ["memLimits", "limits", "memory"],
  ["memAllocatable", "allocatable", "memory"],
];

/// One instant query for every cluster total, each tagged with a `k` label.
export function clusterAllocationQuery(): string {
  return ALLOCATION_KEYS.map(
    ([key, kind, res]) => `label_replace(${ksmQuery(kind, res, "")}, "k", "${key}", "", "")`,
  ).join(" or ");
}

/// Parse an instant-vector response; missing series stay null.
export function parseClusterAllocation(data: unknown): ClusterAllocation | null {
  const out: ClusterAllocation = {
    cpuRequests: null,
    cpuLimits: null,
    cpuAllocatable: null,
    memRequests: null,
    memLimits: null,
    memAllocatable: null,
  };
  const result = (data as { result?: { metric?: { k?: string }; value?: [number, string] }[] })?.result;
  if (!Array.isArray(result)) return null;
  let any = false;
  for (const r of result) {
    const k = r.metric?.k as keyof ClusterAllocation | undefined;
    const v = r.value ? Number.parseFloat(r.value[1]) : Number.NaN;
    if (k && k in out && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}
