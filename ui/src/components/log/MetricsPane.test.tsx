// Pure helpers of the aggregated metrics pane. The pane's render behaviour
// (totals, cluster chips, unavailable callout) is covered in
// LogPanel.test.tsx through the Metrics tab.

import { describe, it, expect } from "vitest";
import { formatCpuMilli, formatMemMib, joinPodMetrics } from "./MetricsPane";
import type { MetricsSnapshot } from "../../types";

function snap(
  pods: Record<string, { cpu_milli: number; mem_mib: number }>,
): MetricsSnapshot {
  return {
    pods: Object.fromEntries(
      Object.entries(pods).map(([k, v]) => {
        const [namespace = "", name = ""] = k.split("/");
        return [k, { namespace, name, ...v }];
      }),
    ),
    cluster: null,
    pod_volumes: {},
    pvcs: {},
    available: true,
    volumes_available: false,
    fetched_at_unix_ms: 1,
  };
}

describe("joinPodMetrics", () => {
  it("joins by cluster + namespace/name and leaves misses null", () => {
    const rows = joinPodMetrics(
      [
        { clusterId: "a", namespace: "default", name: "x", containers: [] },
        { clusterId: "a", namespace: "default", name: "missing", containers: [] },
        { clusterId: "b", namespace: "default", name: "x", containers: [] },
      ],
      {
        a: snap({ "default/x": { cpu_milli: 10, mem_mib: 20 } }),
        b: snap({ "default/x": { cpu_milli: 30, mem_mib: 40 } }),
      },
    );
    expect(rows[0]!.metric?.cpu_milli).toBe(10);
    expect(rows[1]!.metric).toBeNull();
    // Same namespace/name on another cluster joins against that cluster's
    // snapshot — never cross-cluster.
    expect(rows[2]!.metric?.cpu_milli).toBe(30);
  });

  it("returns null metrics when the cluster has no snapshot yet", () => {
    const rows = joinPodMetrics(
      [{ clusterId: "a", namespace: "ns", name: "x", containers: [] }],
      {},
    );
    expect(rows[0]!.metric).toBeNull();
  });
});

describe("formatters", () => {
  it("upgrades units at 1000m / 1024Mi", () => {
    expect(formatCpuMilli(999)).toBe("999m");
    expect(formatCpuMilli(1500)).toBe("1.5 cores");
    expect(formatMemMib(1023)).toBe("1023 Mi");
    expect(formatMemMib(2048)).toBe("2.0 Gi");
  });
});
