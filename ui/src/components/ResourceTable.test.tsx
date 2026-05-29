// Focused tests for renderCell — the per-cell renderer that knows how to
// turn each (column, row) pair into the right widget. Full-table tests
// would drag in TanStack, the store, and the resize observer; the cell
// renderer is the unit where the cross-kind link behaviour lives.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { renderCell, selectPodMetrics } from "./ResourceTable";
import { tokens } from "../theme";
import type { ColumnDef, MetricsSnapshot, ResourceRow } from "../types";

const t = tokens("dark");

type NavFn = (kindId: string, namespace: string | null, name: string) => void;
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
    expect(nav).toHaveBeenCalledWith("nodes", null, "ip-10-0-1-2");
    expect(setNs).not.toHaveBeenCalled();
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

  it("returns the pods map for a Pods table", () => {
    expect(selectPodMetrics(true)({ metrics: snap })).toBe(pods);
  });

  it("returns null for non-Pod tables even when metrics are present", () => {
    // This is the gate: a ConfigMap/Secret/Deployment table must read a
    // stable null so the ~1 Hz metrics tick never re-renders it.
    expect(selectPodMetrics(false)({ metrics: snap })).toBeNull();
  });

  it("returns null when no metrics snapshot exists yet", () => {
    expect(selectPodMetrics(true)({ metrics: null })).toBeNull();
  });

  it("returns a referentially-stable null across snapshots for non-Pod tables", () => {
    // Two distinct snapshots both resolve to the SAME null, so Zustand's
    // Object.is comparison sees no change and skips the re-render.
    const a = selectPodMetrics(false)({ metrics: snap });
    const b = selectPodMetrics(false)({
      metrics: { pods: { "uid-2": { cpu_milli: 1, mem_mib: 2 } } } as unknown as MetricsSnapshot,
    });
    expect(a).toBe(b);
    expect(a).toBeNull();
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
