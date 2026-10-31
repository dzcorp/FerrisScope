import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { emitMock, resetEventMock } from "../test/tauri-event-mock";
import { useClusterAllocation } from "./clusterAllocation";

const target = { namespace: "mon", service: "prom", port: 9090, scheme: "http", backend: "prometheus" };
const vector = { resultType: "vector", result: [{ metric: { k: "cpuRequests" }, value: [1, "750"] }] };

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
});

describe("useClusterAllocation", () => {
  it("does nothing while disabled", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      return undefined;
    });
    const { result } = renderHook(() => useClusterAllocation("c1", false));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(calls).toEqual([]);
  });

  it("queries a cached target without triggering discovery", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      if (cmd === "get_prometheus_target") return { target, source: "auto", last_validated_at_unix_ms: 1 };
      if (cmd === "prometheus_query_instant") return vector;
      return undefined;
    });
    const { result } = renderHook(() => useClusterAllocation("c1", true));
    await waitFor(() => expect(result.current?.cpuRequests).toBe(750));
    expect(calls).not.toContain("prometheus_redetect");
    expect(calls).not.toContain("discover_prometheus_targets");
  });

  it("starts once a target shows up and stops when it goes away", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "get_prometheus_target") return null;
      if (cmd === "prometheus_query_instant") return vector;
      return undefined;
    });
    const { result } = renderHook(() => useClusterAllocation("c1", true));
    await act(async () => {});
    expect(result.current).toBeNull();
    await act(async () => {
      emitMock("prometheus://changed", { cluster_id: "c1", entry: { target, source: "auto", last_validated_at_unix_ms: 1 } });
    });
    await waitFor(() => expect(result.current?.cpuRequests).toBe(750));
    await act(async () => {
      emitMock("prometheus://changed", { cluster_id: "c1", entry: null });
    });
    expect(result.current).toBeNull();
  });

  it("drops an answer that lands after the target went away", async () => {
    let resolve: (v: unknown) => void = () => {};
    setMockInvoke((cmd) => {
      if (cmd === "get_prometheus_target") return { target, source: "auto", last_validated_at_unix_ms: 1 };
      if (cmd === "prometheus_query_instant") return new Promise((r) => (resolve = r));
      return undefined;
    });
    const { result } = renderHook(() => useClusterAllocation("c1", true));
    await act(async () => {});
    await act(async () => {
      emitMock("prometheus://changed", { cluster_id: "c1", entry: null });
    });
    await act(async () => resolve(vector));
    expect(result.current).toBeNull();
  });
});
