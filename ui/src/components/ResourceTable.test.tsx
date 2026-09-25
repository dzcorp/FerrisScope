// Focused tests for renderCell — the per-cell renderer that knows how to
// turn each (column, row) pair into the right widget. Full-table tests
// would drag in TanStack, the store, and the resize observer; the cell
// renderer is the unit where the cross-kind link behaviour lives.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import {
  renderCell,
  selectPodMetrics,
  rowComparatorFor,
  tableComparator,
} from "./ResourceTable";
import { tokens } from "../theme";
import type { ColumnDef, MetricsSnapshot, ResourceRow } from "../types";
import type { ScopedRow } from "../lib/multiCluster";

const t = tokens("dark");

type NavFn = (
  kindId: string,
  namespace: string | null,
  name: string,
  clusterId?: string | null,
) => void;
type SetNsFn = (ns: Set<string>) => void;

function cell(
  col: ColumnDef,
  row: ResourceRow,
  navigateToDetail: NavFn,
  setSelectedNamespaces: SetNsFn,
) {
  return renderCell(
    col,
    row,
    "dark",
    t,
    /* isPods */ col.id === "node" || col.id === "namespace",
    /* podMetrics */ null,
    /* monoTables */ false,
    navigateToDetail,
    setSelectedNamespaces,
  );
}

describe("renderCell — namespace link", () => {
  const col: ColumnDef = { id: "namespace", header: "Namespace", kind: "text" };

  it("clicking a namespace cell pins it as the global filter", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const { getByText } = render(
      <>{cell(col, { uid: "u", namespace: "kube-system", name: "p" }, nav, setNs)}</>,
    );
    fireEvent.click(getByText("kube-system"));
    expect(setNs).toHaveBeenCalledTimes(1);
    expect(setNs).toHaveBeenCalledWith(new Set(["kube-system"]));
    expect(nav).not.toHaveBeenCalled();
  });

  it("stops propagation so the delegated row click doesn't also fire", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const rowClick = vi.fn();
    const { getByText } = render(
      <div onClick={rowClick}>
        {cell(col, { uid: "u", namespace: "default", name: "p" }, nav, setNs)}
      </div>,
    );
    fireEvent.click(getByText("default"));
    expect(setNs).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("empty namespace value is not clickable", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const { container } = render(
      <>{cell(col, { uid: "u", namespace: "", name: "p" }, nav, setNs)}</>,
    );
    // Click whatever rendered — no handler should fire.
    fireEvent.click(container.firstChild as Element);
    expect(setNs).not.toHaveBeenCalled();
  });
});

describe("renderCell — node link", () => {
  const col: ColumnDef = { id: "node", header: "Node", kind: "text" };

  it("clicking a node cell navigates to the node's detail (cluster-scoped)", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const { getByText } = render(
      <>{cell(col, { uid: "u", namespace: "default", name: "p", node: "ip-10-0-1-2" }, nav, setNs)}</>,
    );
    fireEvent.click(getByText("ip-10-0-1-2"));
    expect(nav).toHaveBeenCalledTimes(1);
    // Unscoped row (no __clusterId) → null cluster, resolution falls back
    // to name-only matching.
    expect(nav).toHaveBeenCalledWith("nodes", null, "ip-10-0-1-2", null);
    expect(setNs).not.toHaveBeenCalled();
  });

  it("a scoped row forwards its origin cluster to the node link", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const { getByText } = render(
      <>
        {cell(
          col,
          {
            uid: "u",
            namespace: "default",
            name: "p",
            node: "n2",
            __clusterId: "default::prod",
            __sid: "default::prod::u",
          },
          nav,
          setNs,
        )}
      </>,
    );
    fireEvent.click(getByText("n2"));
    expect(nav).toHaveBeenCalledWith("nodes", null, "n2", "default::prod");
  });

  it("stops propagation so the delegated row click doesn't also fire", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const rowClick = vi.fn();
    const { getByText } = render(
      <div onClick={rowClick}>
        {cell(col, { uid: "u", namespace: "default", name: "p", node: "n1" }, nav, setNs)}
      </div>,
    );
    fireEvent.click(getByText("n1"));
    expect(nav).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("null node renders the em-dash placeholder (not yet scheduled) and is not clickable", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const { container } = render(
      <>{cell(col, { uid: "u", namespace: "default", name: "p", node: null }, nav, setNs)}</>,
    );
    fireEvent.click(container.firstChild as Element);
    expect(nav).not.toHaveBeenCalled();
  });
});

describe("selectPodMetrics — metrics read gated on isPods", () => {
  const pods = { "uid-1": { cpu_milli: 250, mem_mib: 512 } };
  const snap = { pods } as unknown as MetricsSnapshot;
  const CID = "default::c1";

  it("returns the per-cluster record for a Pods table", () => {
    const record = { [CID]: snap };
    expect(selectPodMetrics(true)({ metricsByCluster: record })).toBe(record);
  });

  it("returns null for non-Pod tables even when metrics are present", () => {
    // This is the gate: a ConfigMap/Secret/Deployment table must read a
    // stable null so the ~1 Hz metrics tick never re-renders it.
    expect(
      selectPodMetrics(false)({ metricsByCluster: { [CID]: snap } }),
    ).toBeNull();
  });

  it("returns a referentially-stable null across snapshots for non-Pod tables", () => {
    // Two distinct snapshots both resolve to the SAME null, so Zustand's
    // Object.is comparison sees no change and skips the re-render.
    const a = selectPodMetrics(false)({ metricsByCluster: { [CID]: snap } });
    const b = selectPodMetrics(false)({
      metricsByCluster: {
        [CID]: {
          pods: { "uid-2": { cpu_milli: 1, mem_mib: 2 } },
        } as unknown as MetricsSnapshot,
      },
    });
    expect(a).toBe(b);
    expect(a).toBeNull();
  });
});

describe("rowComparatorFor — cpu/mem comparator reads live metrics via ref", () => {
  // The ref holds clusterId → ("ns/name" → metric) so a merged table joins
  // each row's metrics through its own origin cluster.
  type PodMetricsByCluster = Record<
    string,
    Record<string, { cpu_milli: number; mem_mib: number }>
  >;
  const CID = "default::c1";
  const tanRow = (ns: string, name: string, cid = CID): ResourceRow => ({
    uid: name,
    namespace: ns,
    name,
    __clusterId: cid,
  });

  it("picks up metrics that arrive after the comparator was built", () => {
    // Regression: the comparator used to close over a snapshot taken at
    // columns-build time, so sorts ran against stale (often empty) metrics
    // until the columns happened to rebuild.
    const ref: { current: PodMetricsByCluster | null } = { current: null };
    const cmp = rowComparatorFor({ id: "cpu", header: "CPU" }, ref, true);

    const a = tanRow("default", "pod-a");
    const b = tanRow("default", "pod-b");
    // No metrics yet → both unknown (-1), tie.
    expect(cmp(a, b)).toBe(0);

    ref.current = {
      [CID]: {
        "default/pod-a": { cpu_milli: 50, mem_mib: 10 },
        "default/pod-b": { cpu_milli: 200, mem_mib: 10 },
      },
    };
    expect(cmp(a, b)).toBeLessThan(0);

    // A later tick flips the ordering — the same comparator must see it.
    ref.current = {
      [CID]: {
        "default/pod-a": { cpu_milli: 500, mem_mib: 10 },
        "default/pod-b": { cpu_milli: 100, mem_mib: 10 },
      },
    };
    expect(cmp(a, b)).toBeGreaterThan(0);
  });

  it("joins each row through its own cluster — same ns/name on two clusters", () => {
    const OTHER = "default::c2";
    const ref: { current: PodMetricsByCluster | null } = {
      current: {
        [CID]: { "default/api": { cpu_milli: 10, mem_mib: 1 } },
        [OTHER]: { "default/api": { cpu_milli: 900, mem_mib: 1 } },
      },
    };
    const cmp = rowComparatorFor({ id: "cpu", header: "CPU" }, ref, true);
    expect(
      cmp(tanRow("default", "api", CID), tanRow("default", "api", OTHER)),
    ).toBeLessThan(0);
  });

  it("sorts mem by mem_mib, not cpu", () => {
    const ref: { current: PodMetricsByCluster | null } = {
      current: {
        [CID]: {
          "default/pod-a": { cpu_milli: 999, mem_mib: 5 },
          "default/pod-b": { cpu_milli: 1, mem_mib: 50 },
        },
      },
    };
    const cmp = rowComparatorFor({ id: "mem", header: "Mem" }, ref, true);
    expect(cmp(tanRow("default", "pod-a"), tanRow("default", "pod-b"))).toBeLessThan(0);
  });

  it("sorts by the column's own text off the Pods table", () => {
    const ref: { current: PodMetricsByCluster | null } = { current: null };
    const cmp = rowComparatorFor({ id: "cpu", header: "CPU" }, ref, false);
    const row = (cpu: string): ResourceRow => ({ uid: cpu, cpu });
    expect(cmp(row("2"), row("10"))).toBeLessThan(0);
  });

  it("sorts text columns naturally and typed columns numerically", () => {
    const ref: { current: PodMetricsByCluster | null } = { current: null };
    const cmp = rowComparatorFor({ id: "name", header: "Name", kind: "text" }, ref, true);
    const row = (name: string): ResourceRow => ({ uid: name, name });
    const names = ["api-10", "API-2", "api-1", "db"];
    const sorted = names.map(row).sort(cmp).map((r) => r.name);
    expect(sorted).toEqual(["api-1", "API-2", "api-10", "db"]);
    // Label columns read `__labels`, not a top-level field.
    const byLabel = rowComparatorFor(
      { id: "label:app", header: "app", kind: "text", labelKey: "app" },
      ref,
      true,
    );
    const lrow = (app: string): ResourceRow => ({ uid: app, __labels: { app } });
    expect(byLabel(lrow("b"), lrow("a"))).toBeGreaterThan(0);
    const restarts = rowComparatorFor({ id: "restarts", header: "R", kind: "number" }, ref, true);
    expect(restarts({ uid: "a", restarts: 2 }, { uid: "b", restarts: 10 })).toBeLessThan(0);
    const age = rowComparatorFor({ id: "age", header: "Age", kind: "age" }, ref, true);
    expect(
      age({ uid: "a", age: "2026-01-01T00:00:00Z" }, { uid: "b", age: "2026-01-02T00:00:00Z" }),
    ).toBeLessThan(0);
  });
});

describe("renderCell — non-link columns stay inert", () => {
  it("name column does not fire either handler", () => {
    const nav = vi.fn<NavFn>();
    const setNs = vi.fn<SetNsFn>();
    const col: ColumnDef = { id: "name", header: "Name", kind: "text" };
    const { getByText } = render(
      <>{cell(col, { uid: "u", namespace: "default", name: "my-pod" }, nav, setNs)}</>,
    );
    fireEvent.click(getByText("my-pod"));
    expect(nav).not.toHaveBeenCalled();
    expect(setNs).not.toHaveBeenCalled();
  });
});

describe("tableComparator", () => {
  const r = (name: string, sid: string, restarts = 0) =>
    ({ uid: sid, __sid: sid, __clusterId: "c", name, restarts }) as ScopedRow;
  const byRestarts = rowComparatorFor<ScopedRow>(
    { id: "restarts", header: "R", kind: "number" },
    { current: null },
    false,
  );

  it("reverses only the sorted column; ties fall back to name, then id", () => {
    const rows = [r("b", "2", 1), r("a", "3", 1), r("c", "1", 5), r("a", "0", 1)];
    const desc = rows.slice().sort(tableComparator(byRestarts, true));
    expect(desc.map((x) => x.__sid)).toEqual(["1", "0", "3", "2"]);
    const asc = rows.slice().sort(tableComparator(byRestarts, false));
    expect(asc.map((x) => x.__sid)).toEqual(["0", "3", "2", "1"]);
  });

  it("orders by name naturally with no sorted column", () => {
    const rows = [r("pod-10", "a"), r("pod-2", "b")];
    expect(rows.sort(tableComparator(null, false)).map((x) => x.name)).toEqual(["pod-2", "pod-10"]);
  });
});

describe("renderCell — pod phase", () => {
  const col: ColumnDef = { id: "phase", header: "Status", kind: "phase" };
  const phaseCell = (phase: string) =>
    render(
      <>
        {renderCell(
          col,
          {
            uid: "u",
            name: "p",
            phase,
            container_states: [{ name: "app", kind: "main", state: phase === "Succeeded" ? "Completed" : phase }],
          },
          "dark",
          t,
          /* isPods */ true,
          null,
          false,
          vi.fn<NavFn>(),
          vi.fn<SetNsFn>(),
        )}
      </>,
    );

  it("hides the label for ambient phases and keeps the container dots", () => {
    for (const phase of ["Running", "Terminating", "Succeeded"]) {
      const { queryByText, container, unmount } = phaseCell(phase);
      expect(queryByText(phase)).toBeNull();
      expect(container.querySelector("[data-status-bar]")).toBeNull();
      expect(container.querySelectorAll("span").length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("labels every other phase", () => {
    for (const phase of ["Pending", "Failed", "Unknown"]) {
      const { getByText, container, unmount } = phaseCell(phase);
      expect(getByText(phase)).toBeInTheDocument();
      expect(container.querySelector("[data-status-bar]")).not.toBeNull();
      unmount();
    }
  });
});
