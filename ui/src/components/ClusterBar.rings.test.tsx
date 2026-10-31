// Cluster CPU / memory gauges are Freelens-style doughnuts in every theme:
// usage, requests and limits as concentric rings against allocatable, from a
// known Prometheus target. Without one they stay a single ring.

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { ClusterGauges } from "./ClusterBar";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  act(() => useAppStore.setState({ ...initial }));
});

const target = { namespace: "mon", service: "prom", port: 9090, scheme: "http", backend: "prometheus" };
const alloc = {
  resultType: "vector",
  result: [
    ["cpuRequests", "1000"],
    ["cpuLimits", "3000"],
    ["cpuAllocatable", "4000"],
    ["memRequests", "2048"],
    ["memLimits", "4096"],
    ["memAllocatable", "8192"],
  ].map(([k, v]) => ({ metric: { k }, value: [1, v] })),
};

async function mount(themeId: string, calls: string[]) {
  setMockInvoke((cmd) => {
    calls.push(cmd);
    if (cmd === "get_prometheus_target") return { target, source: "auto", last_validated_at_unix_ms: 1 };
    if (cmd === "prometheus_query_instant") return alloc;
    return undefined;
  });
  act(() => {
    useAppStore.getState().setTheme(themeId);
    useAppStore.setState({
      metricsByCluster: {
        c1: {
          pods: {},
          cluster: { cpu_used_milli: 2000, cpu_capacity_milli: 8000, mem_used_mib: 4096, mem_capacity_mib: 16384 },
          pod_volumes: {},
          pvcs: {},
          available: true,
          volumes_available: null,
          fetched_at_unix_ms: 1,
        },
      },
    });
  });
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(<ClusterGauges mode="dark" clusterId="c1" />);
  });
  return r;
}

describe("ClusterGauges rings", () => {
  it("Lens: three rings per gauge, read against allocatable", async () => {
    const r = await mount("lens", []);
    await waitFor(() => expect(r.container.querySelectorAll("g[data-ring]")).toHaveLength(6));
    expect(r.container.textContent).toContain("50%"); // 2000m of 4000m allocatable
    const strokes = [...r.container.querySelectorAll("g[data-ring] circle:nth-child(2)")].map((c) =>
      c.getAttribute("stroke"),
    );
    expect(strokes.slice(0, 3)).toEqual(["#c93dce", "#4caf50", "#00a7a0"]);
  });

  it("Default: status-coloured usage ring plus info requests and muted limits", async () => {
    const r = await mount("default", []);
    await waitFor(() => expect(r.container.querySelectorAll("g[data-ring]")).toHaveLength(6));
    const { tokens } = await import("../theme");
    const t = tokens("dark");
    const strokes = [...r.container.querySelectorAll("g[data-ring] circle:nth-child(2)")].map((c) =>
      c.getAttribute("stroke"),
    );
    // 2000m of 4000m allocatable = 50 %, under the 65 % amber line.
    expect(strokes.slice(0, 3)).toEqual([t.good, t.info, t.textMuted]);
  });

  it("falls back to one ring when there is no Prometheus", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      if (cmd === "get_prometheus_target") return null;
      return undefined;
    });
    act(() => {
      useAppStore.setState({
        metricsByCluster: {
          c1: {
            pods: {},
            cluster: { cpu_used_milli: 2000, cpu_capacity_milli: 8000, mem_used_mib: 4096, mem_capacity_mib: 16384 },
            pod_volumes: {},
            pvcs: {},
            available: true,
            volumes_available: null,
            fetched_at_unix_ms: 1,
          },
        },
      });
    });
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<ClusterGauges mode="dark" clusterId="c1" />);
    });
    expect(r.container.querySelectorAll("g[data-ring]")).toHaveLength(2);
    expect(r.container.textContent).toContain("25%"); // 2000m of 8000m capacity
    expect(calls).not.toContain("prometheus_query_instant");
    expect(calls).not.toContain("prometheus_redetect");
  });
});
