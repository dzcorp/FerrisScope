import { describe, it, expect, beforeEach } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { tokens, usageColor } from "../../theme";
import { useAppStore } from "../../store";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import type { MetricsSnapshot } from "../../types";
import { SubGrid } from "./primitives";
import { PodResources, resourceGroups, useContainerUsage } from "./resourceUsage";

const t = tokens("dark");
const CID = "default::c1";

function snapAt(stamp: number) {
  useAppStore.setState({
    metricsByCluster: {
      [CID]: { fetched_at_unix_ms: stamp } as unknown as MetricsSnapshot,
    },
  });
}

beforeEach(() => {
  resetMockInvoke();
  useAppStore.setState({ metricsByCluster: {} });
});

describe("resourceGroups", () => {
  it("folds usage into the request row, and only the share into the limit", () => {
    const { container } = render(
      <SubGrid
        t={t}
        groups={resourceGroups(
          t,
          { cpu: "100m", memory: "256Mi" },
          { cpu: "1", memory: "512Mi" },
          { cpu_milli: 95, mem_mib: 64 },
        )}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("95m used (95%)");
    expect(text).toContain("64Mi used (25%)");
    expect(text).toContain("10% used");
    expect(text).toContain("13% used");
    const tint = [...container.querySelectorAll("span")]
      .filter((e) => e.textContent?.includes("95m used"))
      .at(-1);
    const want = document.createElement("span");
    want.style.color = usageColor(95, 100, t);
    expect(tint?.style.color).toBe(want.style.color);
  });

  it("names the amount on the limit when nothing is requested", () => {
    const groups = resourceGroups(t, null, { cpu: "200m" }, { cpu_milli: 50, mem_mib: 1 });
    expect(groups.map((g) => g.label)).toEqual(["Limits"]);
    const { container } = render(<SubGrid t={t} groups={groups} />);
    expect(container.textContent).toContain("50m used (25%)");
  });

  it("leaves rows plain without usage or a usable value", () => {
    const groups = resourceGroups(t, { cpu: "0", "nvidia.com/gpu": "1" }, null, {
      cpu_milli: 50,
      mem_mib: 1,
    });
    expect(groups[0]!.entries.every((e) => e.children === undefined)).toBe(true);
    expect(resourceGroups(t, { cpu: "1" }, null, null)[0]!.entries[0]!.children).toBeUndefined();
    expect(resourceGroups(t, {}, {}, null)).toEqual([]);
  });
});

describe("useContainerUsage", () => {
  it("shares one read per pod and snapshot across containers", async () => {
    const calls: unknown[] = [];
    setMockInvoke((cmd, args) => {
      calls.push(args);
      expect(cmd).toBe("pod_container_metrics");
      return [
        { name: "app", cpu_milli: 40, mem_mib: 100 },
        { name: "proxy", cpu_milli: 5, mem_mib: 20 },
      ];
    });
    snapAt(1);
    const app = renderHook(() => useContainerUsage(CID, "prod", "web", "app"));
    const proxy = renderHook(() => useContainerUsage(CID, "prod", "web", "proxy"));
    await waitFor(() => expect(app.result.current).toEqual({ cpu_milli: 40, mem_mib: 100 }));
    await waitFor(() => expect(proxy.result.current).toEqual({ cpu_milli: 5, mem_mib: 20 }));
    expect(calls).toEqual([{ clusterId: CID, namespace: "prod", name: "web" }]);

    snapAt(2);
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("waits for a snapshot and drops a stale pod's reading", async () => {
    let cpu = 40;
    setMockInvoke(() => [{ name: "app", cpu_milli: cpu, mem_mib: 1 }]);
    const { result, rerender } = renderHook(
      ({ pod }: { pod: string }) => useContainerUsage(CID, "prod", pod, "app"),
      { initialProps: { pod: "web" } },
    );
    expect(result.current).toBeNull();
    snapAt(1);
    await waitFor(() => expect(result.current?.cpu_milli).toBe(40));

    cpu = 7;
    setMockInvoke(() => new Promise(() => {}));
    rerender({ pod: "other" });
    expect(result.current).toBeNull();
  });

  it("drops the reading when the metrics snapshot is cleared", async () => {
    setMockInvoke(() => [{ name: "app", cpu_milli: 40, mem_mib: 1 }]);
    snapAt(1);
    const { result } = renderHook(() => useContainerUsage(CID, "prod", "web", "app"));
    await waitFor(() => expect(result.current?.cpu_milli).toBe(40));
    act(() => useAppStore.setState({ metricsByCluster: {} }));
    expect(result.current).toBeNull();
  });

  it("is empty for a container metrics-server doesn't report", async () => {
    setMockInvoke(() => [{ name: "app", cpu_milli: 1, mem_mib: 1 }]);
    snapAt(1);
    const { result } = renderHook(() => useContainerUsage(CID, "prod", "web", "init"));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });
});

describe("PodResources", () => {
  const totals = { requests: { cpu: "100m" }, limits: {} };

  it("joins the pod's usage by namespace/name from its cluster's snapshot", () => {
    useAppStore.setState({
      metricsByCluster: {
        [CID]: {
          pods: { "prod/web": { namespace: "prod", name: "web", cpu_milli: 50, mem_mib: 8 } },
        } as unknown as MetricsSnapshot,
        other: {
          pods: { "prod/web": { namespace: "prod", name: "web", cpu_milli: 99, mem_mib: 8 } },
        } as unknown as MetricsSnapshot,
      },
    });
    const { container } = render(
      <PodResources t={t} totals={totals} clusterId={CID} namespace="prod" name="web" />,
    );
    expect(container.textContent).toContain("Resources");
    expect(container.textContent).toContain("50m used (50%)");
  });

  it("shows the plain request before metrics arrive, and nothing without values", () => {
    const { container } = render(
      <PodResources t={t} totals={totals} clusterId={CID} namespace="prod" name="web" />,
    );
    expect(container.textContent).toContain("100m");
    expect(container.textContent).not.toContain("used");
    const empty = render(
      <PodResources
        t={t}
        totals={{ requests: {}, limits: {} }}
        clusterId={CID}
        namespace="prod"
        name="web"
      />,
    );
    expect(empty.container).toBeEmptyDOMElement();
  });
});
