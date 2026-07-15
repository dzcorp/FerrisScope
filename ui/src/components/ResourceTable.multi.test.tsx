// Multi-cluster (virtual context) behaviour of ResourceTable: subscription
// fan-out across members, merged row counts, the synthetic Cluster column
// gating, and the partial-data strip when one member fails to subscribe.
// jsdom gives the virtualised body zero height so row CELLS don't paint —
// assertions go through the header DOM and the store's tableCount, which
// reflects the merged row map.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { ResourceTable, type TableCluster } from "./ResourceTable";
import type { ResourceKind } from "../types";

const initial = useAppStore.getState();

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  act(() => {
    useAppStore.setState({
      ...initial,
      selectedNamespaces: new Set<string>(),
      selection: new Map(),
      kindClusters: {},
      tableCount: null,
      tableFilter: "",
    });
  });
});

const configMapsKind: ResourceKind = {
  id: "configmaps",
  group: "",
  version: "v1",
  kind: "ConfigMap",
  plural: "configmaps",
  namespaced: true,
  category: "Config",
  columns: [
    { id: "name", header: "Name", kind: "text" },
    { id: "namespace", header: "Namespace", kind: "text" },
    { id: "age", header: "Age", kind: "age" },
  ],
};

const CID_A = "default::prod-eu";
const CID_B = "default::prod-us";
const TWO: TableCluster[] = [
  { id: CID_A, name: "prod-eu", colorIdx: 0 },
  { id: CID_B, name: "prod-us", colorIdx: 1 },
];
const ONE: TableCluster[] = [{ id: CID_A, name: "prod-eu", colorIdx: 0 }];

function mockSubscribe(rowsByCluster: Record<string, unknown[] | Error>) {
  setMockInvoke((cmd, args) => {
    switch (cmd) {
      case "subscribe_resource": {
        const cid = String(args?.clusterId ?? "");
        const entry = rowsByCluster[cid];
        if (entry instanceof Error) throw entry;
        return { rows: entry ?? [], init_done: true };
      }
      case "unsubscribe_resource":
      case "set_table_view":
        return undefined;
      default:
        return undefined;
    }
  });
}

describe("ResourceTable — multi-cluster merge", () => {
  it("merges rows from every member and shows the Cluster column at 2+", async () => {
    mockSubscribe({
      [CID_A]: [{ uid: "u1", name: "cm-a", namespace: "default" }],
      // Same uid on the other cluster — scoped keys must keep both.
      [CID_B]: [
        { uid: "u1", name: "cm-b", namespace: "default" },
        { uid: "u2", name: "cm-c", namespace: "default" },
      ],
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={TWO}
          viewScopeId="vctx:test"
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});

    // Header carries the synthetic column.
    expect(screen.getByText("Cluster")).toBeTruthy();
    // Merged count: 3 rows across both members despite the uid collision.
    expect(useAppStore.getState().tableCount).toEqual({
      filtered: 3,
      total: 3,
    });
  });

  it("hides the Cluster column on a single-cluster view", async () => {
    mockSubscribe({
      [CID_A]: [{ uid: "u1", name: "cm-a", namespace: "default" }],
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={ONE}
          viewScopeId={CID_A}
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});
    expect(screen.queryByText("Cluster")).toBeNull();
    expect(useAppStore.getState().tableCount).toEqual({
      filtered: 1,
      total: 1,
    });
  });

  it("keeps serving healthy members and shows the partial-data strip when one fails", async () => {
    mockSubscribe({
      [CID_A]: [{ uid: "u1", name: "cm-a", namespace: "default" }],
      [CID_B]: new Error("connection refused"),
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={TWO}
          viewScopeId="vctx:test"
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});

    // Healthy member's rows still count…
    expect(useAppStore.getState().tableCount).toEqual({
      filtered: 1,
      total: 1,
    });
    // …and the failed member is called out by display name.
    const strip = screen.getByRole("alert");
    expect(strip.textContent).toContain("Partial data");
    expect(strip.textContent).toContain("prod-us");
    expect(strip.textContent).toContain("connection refused");
  });

  it("full-pane error when every member fails to subscribe", async () => {
    mockSubscribe({
      [CID_A]: new Error("boom-a"),
      [CID_B]: new Error("boom-b"),
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={TWO}
          viewScopeId="vctx:test"
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});
    // No partial strip — the whole view is the error state.
    expect(screen.queryByText(/Partial data/)).toBeNull();
    expect(screen.getByText(/boom-/)).toBeTruthy();
  });

  it("never subscribes a kind on a member that lacks it (kindClusters intersection)", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "subscribe_resource") {
        calls.push(String(args?.clusterId ?? ""));
        return { rows: [], init_done: true };
      }
      return undefined;
    });
    act(() => {
      useAppStore.setState({
        kindClusters: { configmaps: [CID_A] },
      });
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={TWO}
          viewScopeId="vctx:test"
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});
    expect(calls).toEqual([CID_A]);
  });
});

describe("ResourceTable — pendingDetail resolution", () => {
  const entry = (clusterId: string | null, name: string) => ({
    clusterId,
    kindId: "configmaps",
    namespace: "default",
    name,
  });

  it("cluster-bearing entries never fall back to a same-named row on another member", async () => {
    // Only prod-us has cm-x; the entry points at prod-eu. Opening prod-us's
    // object here would be the wrong-cluster bug.
    mockSubscribe({
      [CID_A]: [],
      [CID_B]: [{ uid: "u9", name: "cm-x", namespace: "default" }],
    });
    act(() => {
      useAppStore.setState({ pendingDetail: entry(CID_A, "cm-x") });
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={TWO}
          viewScopeId="vctx:test"
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});
    // Not consumed — the origin cluster has no such row.
    expect(useAppStore.getState().pendingDetail).not.toBeNull();
  });

  it("resolves against the origin cluster and mounts a compositor-safe detail panel", async () => {
    // Resolution opens the DetailPanel, which fetches the ConfigMap detail —
    // serve a minimal one so the panel renders instead of crashing.
    setMockInvoke((cmd, args) => {
      switch (cmd) {
        case "subscribe_resource": {
          const cid = String(args?.clusterId ?? "");
          const uid = cid === CID_A ? "u1" : "u9";
          return {
            rows: [{ uid, name: "cm-x", namespace: "default" }],
            init_done: true,
          };
        }
        case "get_config_map_detail_cmd":
          return {
            meta: {
              name: "cm-x",
              namespace: "default",
              uid: "u9",
              created_at: null,
              labels: [],
              annotations: [],
              controlled_by: null,
              generation: null,
              managers: [],
            },
            immutable: false,
            data: [],
          };
        default:
          return undefined;
      }
    });
    act(() => {
      useAppStore.setState({ pendingDetail: entry(CID_B, "cm-x") });
    });
    await act(async () => {
      render(
        <ResourceTable
          mode="dark"
          clusters={TWO}
          viewScopeId="vctx:test"
          kind={configMapsKind}
        />,
      );
    });
    await act(async () => {});
    expect(useAppStore.getState().pendingDetail).toBeNull();
    const close = screen.getByRole("button", { name: "Close (Esc)" });
    const panel = close.closest("header")?.parentElement;
    expect(panel).not.toBeNull();
    expect(panel?.style.animation).toBe("");
  });

  it("times out an unresolvable navigation with a warning toast", async () => {
    vi.useFakeTimers();
    try {
      mockSubscribe({
        [CID_A]: [{ uid: "u1", name: "cm-a", namespace: "default" }],
      });
      act(() => {
        useAppStore.setState({ pendingDetail: entry(CID_A, "ghost") });
      });
      await act(async () => {
        render(
          <ResourceTable
            mode="dark"
            clusters={ONE}
            viewScopeId={CID_A}
            kind={configMapsKind}
          />,
        );
      });
      await act(async () => {});
      expect(useAppStore.getState().pendingDetail).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(6_500);
      });
      const s = useAppStore.getState();
      expect(s.pendingDetail).toBeNull();
      const warn = s.toasts.find((t) => t.tone === "warn");
      expect(warn?.text).toContain("default/ghost not found");
    } finally {
      vi.useRealTimers();
    }
  });
});
