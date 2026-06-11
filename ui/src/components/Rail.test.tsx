// Regression guard for the store-subscription shape. The Rail is mounted
// alongside the table for the whole browsing session, so a bulk
// `useAppStore()` destructure would re-render its full kind list (every
// discovered CRD) on every unrelated store mutation — the metrics tick,
// table-count updates, toasts, selection toggles. This test pins the
// per-field selector behaviour: an unrelated slice change commits zero
// additional renders.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { Rail } from "./Rail";

afterEach(() => {
  cleanup();
  resetMockInvoke();
  act(() => {
    useAppStore.setState({ metricsByCluster: {}, tableCount: null });
  });
});

describe("Rail store subscription", () => {
  it("does not re-render when an unrelated store slice changes", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "list_resource_kinds") return [];
      return undefined;
    });

    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
      commits += 1;
    };

    await act(async () => {
      render(
        <Profiler id="rail" onRender={onRender}>
          <Rail mode="dark" />
        </Profiler>,
      );
    });
    // Flush the mount-time listResourceKinds() promise + effects.
    await act(async () => {});

    expect(commits).toBeGreaterThan(0);
    const baseline = commits;

    // The rail reads neither `metrics` nor `tableCount`. Per-field selectors
    // must absorb these high-frequency mutations with no re-render. (A bulk
    // `useAppStore()` would re-render the entire kind list on each.)
    act(() => {
      useAppStore.getState().setMetrics("c1", { pods: {}, cluster: null, pod_volumes: {}, pvcs: {}, available: false, volumes_available: false, fetched_at_unix_ms: 0 } as never);
      useAppStore.getState().setTableCount({ filtered: 5, total: 9 });
    });

    expect(commits).toBe(baseline);
  });
});

describe("Rail CRD discovery across active clusters", () => {
  const crd = (id: string, kind: string) => ({
    id,
    group: "example.io",
    version: "v1",
    kind,
    plural: `${kind.toLowerCase()}s`,
    namespaced: true,
    category: "CustomResources",
    columns: [],
  });

  it("unions dynamic kinds across members and publishes kindClusters", async () => {
    const A = "default::a";
    const B = "default::b";
    const shared = crd("crd:example.io|v1|widgets|Widget|ns", "Widget");
    const onlyB = crd("crd:example.io|v1|gizmos|Gizmo|ns", "Gizmo");
    setMockInvoke((cmd, args) => {
      switch (cmd) {
        case "list_resource_kinds":
          return [];
        case "list_custom_resource_kinds":
          return args?.clusterId === A ? [shared] : [shared, onlyB];
        default:
          return undefined;
      }
    });
    act(() => {
      const ctx = (id: string) => ({
        id,
        name: id,
        cluster: "c",
        user: null,
        namespace: null,
        is_current: false,
        group: "Default",
        source_id: "default",
        source_path: null,
      });
      useAppStore.setState({
        contexts: [ctx(A), ctx(B)],
        virtualContexts: [{ id: "v1", name: "both", members: [A, B] }],
        selectedVirtualContextId: "v1",
        selectedContext: null,
        scopeExtras: [],
      });
    });

    await act(async () => {
      render(<Rail mode="dark" />);
    });
    await act(async () => {});

    const s = useAppStore.getState();
    const dynamicIds = s.kinds.map((k) => k.id);
    expect(dynamicIds).toContain(shared.id);
    expect(dynamicIds).toContain(onlyB.id);
    // Availability: the shared CRD lives on both members, Gizmo only on B.
    expect(s.kindClusters[shared.id]?.sort()).toEqual([A, B]);
    expect(s.kindClusters[onlyB.id]).toEqual([B]);
  });

  it("clears dynamic kinds and kindClusters when no cluster is active", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "list_resource_kinds") return [];
      return undefined;
    });
    act(() => {
      useAppStore.setState({
        selectedContext: null,
        selectedVirtualContextId: null,
        scopeExtras: [],
        kindClusters: { "crd:x": ["default::a"] },
      });
    });
    await act(async () => {
      render(<Rail mode="dark" />);
    });
    await act(async () => {});
    expect(useAppStore.getState().kindClusters).toEqual({});
  });
});
