// Logs & metrics panel tests: target resolution (fast path for pods with
// known containers vs `resolve_log_pods_cmd` for workloads), aggregated
// stream counts, resolution warnings, the error + Retry surface, and the
// Metrics tab (per-pod metrics-server rows + totals).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import {
  LogPanel,
  MAX_OBSERVE_TARGETS,
  type ObserveTarget,
} from "./LogPanel";
import { MAX_LOG_SOURCES } from "../lib/logSources";
import type { ContextInfo, MetricsSnapshot } from "../types";

const ctxEu: ContextInfo = {
  id: "kc::prod-eu",
  name: "prod-eu",
  cluster: "prod-eu",
  user: null,
  namespace: null,
  is_current: false,
  group: "",
  source_id: "kc",
  source_path: null,
};
const ctxUs: ContextInfo = {
  ...ctxEu,
  id: "kc::prod-us",
  name: "prod-us",
  cluster: "prod-us",
};

function snapshot(
  pods: Record<string, { cpu_milli: number; mem_mib: number }>,
  available = true,
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
    available,
    volumes_available: false,
    fetched_at_unix_ms: 1,
  };
}

type Call = { cmd: string; args?: Record<string, unknown> };

function mockBackend(opts: {
  resolve?: (
    clusterId: string,
  ) =>
    | { pods: { namespace: string; name: string; containers: string[] }[]; warnings: string[] }
    | Error;
}) {
  const calls: Call[] = [];
  let seq = 0;
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "start_log_stream") return `s${++seq}`;
    if (cmd === "stop_log_stream") return undefined;
    if (cmd === "subscribe_metrics") return null;
    if (cmd === "unsubscribe_metrics") return undefined;
    // The live workload pod-set watch arms after the one-shot resolve. Tests
    // assert on the resolve seed + streams; the watch just needs to not throw.
    if (cmd === "watch_log_pods") return `lpw${++seq}`;
    if (cmd === "unwatch_log_pods") return undefined;
    if (cmd === "resolve_log_pods_cmd") {
      const res = opts.resolve?.(String(args!.clusterId));
      if (res instanceof Error) throw res;
      return res ?? { pods: [], warnings: [] };
    }
    return undefined;
  });
  return { calls };
}

function podTarget(
  name: string,
  containers: string[] | undefined,
  clusterId = ctxEu.id,
): ObserveTarget {
  return { clusterId, kindId: "pods", namespace: "default", name, containers };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  act(() => {
    useAppStore.setState({ contexts: [ctxEu, ctxUs] });
  });
});

afterEach(() => {
  cleanup();
  resetMockInvoke();
  vi.unstubAllGlobals();
  act(() => {
    useAppStore.setState({ contexts: [], metricsByCluster: {} });
  });
});

describe("LogPanel target resolution", () => {
  it("pod targets with known containers skip the resolve round-trip", async () => {
    const m = mockBackend({});
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[podTarget("api-0", ["app"])]}
          onClose={() => {}}
        />,
      );
    });
    expect(m.calls.some((c) => c.cmd === "resolve_log_pods_cmd")).toBe(false);
    const stream = m.calls.find((c) => c.cmd === "start_log_stream");
    expect(stream?.args?.pod).toBe("api-0");
    expect(utils.getByText("container: app")).toBeInTheDocument();
  });

  it("single pod: 'Previous' toggle restarts the stream with previous:true and shows a banner", async () => {
    const m = mockBackend({});
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[podTarget("api-0", ["app"])]}
          onClose={() => {}}
        />,
      );
    });
    // Live stream first — previous defaults false.
    const firstStreams = m.calls.filter((c) => c.cmd === "start_log_stream");
    expect(firstStreams).toHaveLength(1);
    expect(firstStreams[0]!.args?.previous).toBe(false);
    expect(utils.queryByRole("status")).toBeNull();

    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Previous" }));
      await Promise.resolve();
    });

    // Folding `previous` into the source key tears the live stream down and
    // opens a new one against the terminated instance.
    const prevStream = m.calls
      .filter((c) => c.cmd === "start_log_stream")
      .find((c) => c.args?.previous === true);
    expect(prevStream?.args?.pod).toBe("api-0");
    expect(m.calls.some((c) => c.cmd === "stop_log_stream")).toBe(true);
    // Banner warns the operator this isn't the live runtime.
    expect(utils.getByRole("status").textContent).toContain(
      "previous terminated instance",
    );
  });

  it("workload targets resolve to pods and stream each container", async () => {
    const m = mockBackend({
      resolve: () => ({
        pods: [
          { namespace: "default", name: "api-7f-a1", containers: ["app"] },
          { namespace: "default", name: "api-7f-b2", containers: ["app"] },
        ],
        warnings: [],
      }),
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[
            {
              clusterId: ctxEu.id,
              kindId: "deployments",
              namespace: "default",
              name: "api",
            },
          ]}
          onClose={() => {}}
        />,
      );
    });
    const resolve = m.calls.find((c) => c.cmd === "resolve_log_pods_cmd");
    expect(resolve?.args?.targets).toEqual([
      { kind_id: "deployments", namespace: "default", name: "api" },
    ]);
    const streams = m.calls.filter((c) => c.cmd === "start_log_stream");
    expect(streams.map((c) => c.args?.pod).sort()).toEqual([
      "api-7f-a1",
      "api-7f-b2",
    ]);
    expect(utils.getByText(/2 pods · 2 streams/)).toBeInTheDocument();
  });

  it("surfaces per-target resolution warnings without blanking the view", async () => {
    mockBackend({
      resolve: () => ({
        pods: [{ namespace: "default", name: "api-0", containers: ["app"] }],
        warnings: ["Deployment default/dead: no pods matched its selector"],
      }),
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[
            {
              clusterId: ctxEu.id,
              kindId: "deployments",
              namespace: "default",
              name: "dead",
            },
          ]}
          onClose={() => {}}
        />,
      );
    });
    expect(
      utils.getByText(/Deployment default\/dead: no pods matched/),
    ).toBeInTheDocument();
  });

  it("shows the error surface with Retry when every cluster fails", async () => {
    let fail = true;
    const m = mockBackend({
      resolve: () =>
        fail
          ? new Error("connection refused")
          : {
              pods: [
                { namespace: "default", name: "api-0", containers: ["app"] },
              ],
              warnings: [],
            },
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[
            {
              clusterId: ctxEu.id,
              kindId: "deployments",
              namespace: "default",
              name: "api",
            },
          ]}
          onClose={() => {}}
        />,
      );
    });
    expect(utils.getByText("Retry")).toBeInTheDocument();
    expect(
      m.calls.filter((c) => c.cmd === "start_log_stream"),
    ).toHaveLength(0);
    fail = false;
    await act(async () => {
      fireEvent.click(utils.getByText("Retry"));
    });
    expect(
      m.calls.filter((c) => c.cmd === "start_log_stream"),
    ).toHaveLength(1);
  });

  it("caps a 100+ row selection: 50 targets observed, 24 streams opened", async () => {
    const m = mockBackend({});
    const targets = Array.from({ length: 120 }, (_, i) =>
      podTarget(`p${i}`, ["app"]),
    );
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel mode="dark" targets={targets} onClose={() => {}} />,
      );
    });
    // Only the capped target set is observed…
    expect(
      utils.getByText(
        new RegExp(
          `observing the first ${MAX_OBSERVE_TARGETS} of 120 targets`,
        ),
      ),
    ).toBeInTheDocument();
    // …and the stream fan-out stops at the source cap, not at 120.
    const streams = m.calls.filter((c) => c.cmd === "start_log_stream");
    expect(streams).toHaveLength(MAX_LOG_SOURCES);
    expect(
      utils.getByText(
        new RegExp(
          `${MAX_OBSERVE_TARGETS} pods · ${MAX_LOG_SOURCES} streams \\(\\+${
            MAX_OBSERVE_TARGETS - MAX_LOG_SOURCES
          } over cap\\)`,
        ),
      ),
    ).toBeInTheDocument();
  });

  it("renders the empty state when nothing resolves to a pod", async () => {
    mockBackend({ resolve: () => ({ pods: [], warnings: [] }) });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[
            {
              clusterId: ctxEu.id,
              kindId: "jobs",
              namespace: "default",
              name: "done",
            },
          ]}
          onClose={() => {}}
        />,
      );
    });
    expect(utils.getByText("No pods to observe")).toBeInTheDocument();
  });
});

describe("LogPanel metrics tab", () => {
  it("switches tabs and shows per-pod usage + totals", async () => {
    mockBackend({});
    act(() => {
      useAppStore.setState({
        metricsByCluster: {
          [ctxEu.id]: snapshot({
            "default/api-0": { cpu_milli: 250, mem_mib: 100 },
          }),
        },
      });
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[podTarget("api-0", ["app"])]}
          onClose={() => {}}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(utils.getByText("Metrics"));
    });
    expect(utils.getByText("Total CPU")).toBeInTheDocument();
    expect(utils.getAllByText("250m").length).toBeGreaterThan(0);
    expect(utils.getAllByText("100 Mi").length).toBeGreaterThan(0);
    expect(utils.getByText("1/1")).toBeInTheDocument();
  });

  it("opens directly on metrics with initialTab and tags rows by cluster", async () => {
    mockBackend({});
    act(() => {
      useAppStore.setState({
        metricsByCluster: {
          [ctxEu.id]: snapshot({
            "default/api-0": { cpu_milli: 1500, mem_mib: 2048 },
          }),
          [ctxUs.id]: snapshot({
            "default/api-0": { cpu_milli: 100, mem_mib: 64 },
          }),
        },
      });
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[
            podTarget("api-0", ["app"], ctxEu.id),
            podTarget("api-0", ["app"], ctxUs.id),
          ]}
          initialTab="metrics"
          onClose={() => {}}
        />,
      );
    });
    // Compressed cluster labels on the rows (prod-eu / prod-us → eu / us).
    expect(utils.getByText("eu")).toBeInTheDocument();
    expect(utils.getByText("us")).toBeInTheDocument();
    // Unit upgrades: 1500m → 1.5 cores, 2048 Mi → 2.0 Gi.
    expect(utils.getByText("1.5 cores")).toBeInTheDocument();
    expect(utils.getByText("2.0 Gi")).toBeInTheDocument();
    expect(utils.getByText("2/2")).toBeInTheDocument();
  });

  it("calls out clusters where metrics-server is unavailable", async () => {
    mockBackend({});
    act(() => {
      useAppStore.setState({
        metricsByCluster: { [ctxEu.id]: snapshot({}, false) },
      });
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <LogPanel
          mode="dark"
          targets={[podTarget("api-0", ["app"])]}
          initialTab="metrics"
          onClose={() => {}}
        />,
      );
    });
    expect(
      utils.getByText(/metrics-server not detected on prod-eu/),
    ).toBeInTheDocument();
  });
});
