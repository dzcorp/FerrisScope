// Pod and node charts add kube-state-metrics reference series when the
// cluster has them, and stay usage-only when it doesn't.

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import { resetEventMock } from "../../test/tauri-event-mock";
import { useAppStore } from "../../store";
import { MetricsTab } from "./MetricsTab";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  act(() => useAppStore.setState({ ...initial }));
});

const target = { namespace: "mon", service: "prom", port: 9090, scheme: "http", backend: "prometheus" };
const matrix = (v: number) => ({
  resultType: "matrix",
  result: [{ values: Array.from({ length: 10 }, (_, i) => [1_700_000_000 + i * 60, String(v + i)]) }],
});

function mockProm(withKsm: boolean, seen: string[]) {
  setMockInvoke((cmd, args) => {
    if (cmd === "get_prometheus_target") return { target, source: "auto", last_validated_at_unix_ms: 1 };
    if (cmd === "prometheus_query_range") {
      const q = (args as { query: string }).query;
      seen.push(q);
      if (q.includes("kube_")) return withKsm ? matrix(500) : { resultType: "matrix", result: [] };
      return matrix(100);
    }
    if (cmd === "subscribe_metrics") return null;
    return undefined;
  });
}

const legend = (c: HTMLElement) => [...c.querySelectorAll("svg text")].map((n) => n.textContent);

describe("MetricsTab kube-state-metrics series", () => {
  it("pod CPU and memory carry Requests and Limits", async () => {
    const seen: string[] = [];
    mockProm(true, seen);
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<MetricsTab mode="dark" clusterId="c1" kind="pod" namespace="default" name="api-1" />);
    });
    await waitFor(() => expect(legend(r.container)).toContain("Requests"));
    expect(legend(r.container)).toContain("Limits");
    expect(legend(r.container)).toContain("Usage");
    expect(seen.some((q) => q.includes('kube_pod_container_resource_limits{namespace="default",pod="api-1",resource="memory"}'))).toBe(true);
  });

  it("stays usage-only without kube-state-metrics", async () => {
    mockProm(false, []);
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<MetricsTab mode="dark" clusterId="c1" kind="pod" namespace="default" name="api-1" />);
    });
    await waitFor(() => expect(r.container.querySelectorAll("svg path").length).toBeGreaterThan(0));
    expect(legend(r.container)).not.toContain("Requests");
  });

  it("node shows allocation charts only when kube-state-metrics answers", async () => {
    mockProm(true, []);
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<MetricsTab mode="dark" clusterId="c1" kind="node" name="n1" />);
    });
    await waitFor(() => expect(r.container.textContent).toContain("CPU allocation"));
    expect(legend(r.container)).toEqual(expect.arrayContaining(["Allocatable", "Capacity", "Requests"]));
    cleanup();
    mockProm(false, []);
    await act(async () => {
      r = render(<MetricsTab mode="dark" clusterId="c1" kind="node" name="n1" />);
    });
    await act(async () => {});
    expect(r.container.textContent).not.toContain("CPU allocation");
  });
});
