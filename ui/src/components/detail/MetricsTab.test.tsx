import { describe, it, expect, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  clientXToSvgX,
  MetricsTab,
  workloadOwnerJoin,
  workloadPodNamePattern,
  workloadQueries,
} from "./MetricsTab";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import { useAppStore } from "../../store";
import type { ContextInfo, MetricsSnapshot } from "../../types";

// Build a minimal SVGSVGElement-shaped stub. The chart renders the SVG
// with width=viewBoxWidth, then native page zoom rescales layout + paint
// together — getBoundingClientRect and clientX share a coordinate space,
// so the stub's `zoom` parameter scales both the reported rect width and
// the cursor input uniformly.
function makeSvgStub(opts: {
  viewBoxWidth: number;
  zoom: number;
  rectLeft: number;
  viewBoxAttr?: string;
}): SVGSVGElement {
  const { viewBoxWidth, zoom, rectLeft, viewBoxAttr } = opts;
  const renderedWidth = viewBoxWidth * zoom;
  return {
    viewBox: { baseVal: { x: 0, y: 0, width: viewBoxWidth, height: 130 } },
    getAttribute: (name: string) => {
      if (name === "viewBox") {
        return viewBoxAttr !== undefined ? viewBoxAttr : `0 0 ${viewBoxWidth} 130`;
      }
      return null;
    },
    getBoundingClientRect: () => ({
      left: rectLeft,
      top: 0,
      right: rectLeft + renderedWidth,
      bottom: 130 * zoom,
      width: renderedWidth,
      height: 130 * zoom,
      x: rectLeft,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as SVGSVGElement;
}

describe("clientXToSvgX", () => {
  it("maps client coords 1:1 into viewBox space with no zoom", () => {
    // viewBox 0..560, no zoom, rect 0..560. Cursor at screen x=280
    // should land at viewBox x=280.
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1, rectLeft: 0 });
    expect(clientXToSvgX(svg, 280)).toBeCloseTo(280, 5);
    expect(clientXToSvgX(svg, 0)).toBeCloseTo(0, 5);
    expect(clientXToSvgX(svg, 560)).toBeCloseTo(560, 5);
  });

  it("maps cursor proportionally when the rect is wider than the viewBox", () => {
    // SVG rendered at 840 CSS px but viewBox stays 0..560 (e.g. the
    // chart was sized larger by its container). Cursor at the rect
    // midpoint (420) must map to viewBox midpoint (280).
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1.5, rectLeft: 0 });
    expect(clientXToSvgX(svg, 420)).toBeCloseTo(280, 5);
    expect(clientXToSvgX(svg, 840)).toBeCloseTo(560, 5);
  });

  it("maps cursor proportionally when the rect is narrower than the viewBox", () => {
    // SVG rendered at 448 CSS px with viewBox 0..560. Cursor at the
    // rect midpoint (224) maps to viewBox midpoint (280).
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 0.8, rectLeft: 0 });
    expect(clientXToSvgX(svg, 224)).toBeCloseTo(280, 5);
  });

  it("accounts for the SVG's left offset on the page", () => {
    // Chart sits 200px from the left of the viewport with rendered
    // width 700. Cursor at the rect midpoint (550) maps to viewBox
    // midpoint (280); cursor at the rect edges maps to 0 / viewBoxWidth.
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1.25, rectLeft: 200 });
    expect(clientXToSvgX(svg, 550)).toBeCloseTo(280, 5);
    expect(clientXToSvgX(svg, 200)).toBeCloseTo(0, 5);
    expect(clientXToSvgX(svg, 900)).toBeCloseTo(560, 5);
  });

  it("uses the viewBox attribute over stale viewBox.baseVal under WebKit/Tauri", () => {
    // Under WebKit/Tauri, viewBox.baseVal can be stale (e.g. 560) after resize,
    // but the viewBox attribute itself gets updated (e.g. 800).
    const svg = {
      viewBox: { baseVal: { x: 0, y: 0, width: 560, height: 130 } },
      getAttribute: (name: string) => (name === "viewBox" ? "0 0 800 130" : null),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 130,
        width: 800,
        height: 130,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as unknown as SVGSVGElement;

    // Cursor at visual midpoint (400) should map to 400 (halfway of 800).
    // If it used stale baseVal (560), it would map to 280.
    expect(clientXToSvgX(svg, 400)).toBeCloseTo(400, 5);
  });

  it("ignores document.documentElement.style.zoom under native page zoom", () => {
    // Sanity check: native page zoom (WebviewWindow.setZoom) rescales
    // layout and paint together, so getBoundingClientRect and clientX
    // already share a space. Stray CSS `zoom` on the root must not enter
    // the mapping.
    const prevZoom = document.documentElement.style.zoom;
    document.documentElement.style.zoom = "1.5";
    try {
      const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1, rectLeft: 0 });
      expect(clientXToSvgX(svg, 280)).toBeCloseTo(280, 5);
    } finally {
      document.documentElement.style.zoom = prevZoom;
    }
  });
});

// ── Workload Metrics tab: metrics-server fallback ─────────────────────────
// Without Prometheus the workload tab used to render only the "not
// detected" banner — pods got live snapshot data, workloads got nothing.
// These tests pin the fallback: resolve the workload's pods via
// `resolve_log_pods_cmd` and render the live per-pod snapshot pane.

const ctx: ContextInfo = {
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

function snapshotWith(
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

afterEach(() => {
  cleanup();
  resetMockInvoke();
  act(() => {
    useAppStore.setState({ contexts: [], metricsByCluster: {} });
  });
});

describe("MetricsTab workload fallback (no Prometheus)", () => {
  it("resolves the workload's pods and shows live snapshot usage", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      // No cached Prometheus entry and no detection — reject so the hook
      // commits `null` (the "missing" state) without the watchdog wait.
      if (cmd === "get_prometheus_target") throw new Error("no prom");
      if (cmd === "resolve_log_pods_cmd") {
        return {
          pods: [
            { namespace: "default", name: "api-7f-a1", containers: ["app"] },
            { namespace: "default", name: "api-7f-b2", containers: ["app"] },
          ],
          warnings: [],
        };
      }
      if (cmd === "subscribe_metrics") return null;
      return undefined;
    });
    act(() => {
      useAppStore.setState({
        contexts: [ctx],
        metricsByCluster: {
          [ctx.id]: snapshotWith({
            "default/api-7f-a1": { cpu_milli: 250, mem_mib: 100 },
            "default/api-7f-b2": { cpu_milli: 50, mem_mib: 30 },
          }),
        },
      });
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <MetricsTab
          mode="dark"
          clusterId={ctx.id}
          kind="workload"
          controllerKind="Deployment"
          namespace="default"
          name="api"
        />,
      );
    });
    expect(calls).toContain("resolve_log_pods_cmd");
    expect(
      utils.getByText(/Showing the live metrics-server snapshot instead/),
    ).toBeInTheDocument();
    expect(utils.getByText("Total CPU")).toBeInTheDocument();
    expect(utils.getByText("250m")).toBeInTheDocument();
    expect(utils.getByText("50m")).toBeInTheDocument();
    expect(utils.getByText("2/2")).toBeInTheDocument();
  });

  it("explains an empty selector match instead of a blank pane", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "get_prometheus_target") throw new Error("no prom");
      if (cmd === "resolve_log_pods_cmd") {
        return {
          pods: [],
          warnings: ["Deployment default/api: no pods matched its selector"],
        };
      }
      if (cmd === "subscribe_metrics") return null;
      return undefined;
    });
    act(() => {
      useAppStore.setState({ contexts: [ctx] });
    });
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(
        <MetricsTab
          mode="dark"
          clusterId={ctx.id}
          kind="workload"
          controllerKind="Deployment"
          namespace="default"
          name="api"
        />,
      );
    });
    expect(
      utils.getByText(/no pods matched its selector/),
    ).toBeInTheDocument();
  });
});

// ── Workload PromQL builders ───────────────────────────────────────────────
// Pins the query text: the kube-state-metrics owner joins (authoritative)
// and the pod-name-regex fallbacks (clusters with cAdvisor but no KSM).

describe("workload PromQL builders", () => {
  it("Deployment owner join chains pod → ReplicaSet → Deployment", () => {
    const j = workloadOwnerJoin("Deployment", "prod", "api");
    expect(j).toContain('kube_pod_owner{namespace="prod",owner_kind="ReplicaSet"}');
    expect(j).toContain(
      'kube_replicaset_owner{namespace="prod",owner_kind="Deployment",owner_name="api"}',
    );
    expect(j).toContain('label_replace(');
    expect(j).toContain("* on(namespace,owner_name) group_left()");
  });

  it("direct owners join kube_pod_owner one step", () => {
    expect(workloadOwnerJoin("StatefulSet", "prod", "db")).toBe(
      'kube_pod_owner{namespace="prod",owner_kind="StatefulSet",owner_name="db"}',
    );
    expect(workloadOwnerJoin("Job", "prod", "sync")).toBe(
      'kube_pod_owner{namespace="prod",owner_kind="Job",owner_name="sync"}',
    );
  });

  it("pod-name patterns follow the kubelet naming conventions", () => {
    expect(workloadPodNamePattern("Deployment", "api")).toBe(
      "^api-[a-z0-9]+-[a-z0-9]{5}$",
    );
    expect(workloadPodNamePattern("StatefulSet", "db")).toBe("^db-[0-9]+$");
    expect(workloadPodNamePattern("DaemonSet", "agent")).toBe(
      "^agent-[a-z0-9]{5}$",
    );
    expect(workloadPodNamePattern("Job", "sync")).toBe("^sync-[a-z0-9]{5}$");
  });

  it("escapes regex metacharacters in workload names (PromQL double-escape)", () => {
    // "api.v2" → the dot must reach the regex engine escaped; PromQL string
    // literals unescape once, so the query text carries a doubled backslash.
    expect(workloadPodNamePattern("StatefulSet", "api.v2")).toBe(
      "^api\\\\.v2-[0-9]+$",
    );
  });

  it("workloadQueries: primary joins on (namespace,pod), fallback filters by name", () => {
    const q = workloadQueries("Deployment", "prod", "api", "120s");
    expect(q.cpu).toContain(
      'rate(container_cpu_usage_seconds_total{namespace="prod",container!="",container!="POD"}[120s])',
    );
    expect(q.cpu).toContain("* on(namespace,pod) group_left()");
    expect(q.cpu.endsWith("* 1000")).toBe(true);
    expect(q.mem).toContain("container_memory_working_set_bytes");
    expect(q.mem).toContain("/ (1024*1024)");
    // Fallbacks never touch kube-state-metrics series.
    for (const fb of [q.cpuFallback, q.memFallback, q.rxFallback, q.txFallback]) {
      expect(fb).not.toContain("kube_pod_owner");
      expect(fb).toContain('pod=~"^api-[a-z0-9]+-[a-z0-9]{5}$"');
    }
    expect(q.rxFallback).toContain(
      "container_network_receive_bytes_total",
    );
  });
});
