// Keep-alive: switching cluster tabs must not resubscribe or reset a hidden
// or re-shown table, even while the rail republishes kinds for the new scope.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { TabScopeProvider, useTabKind } from "../lib/tabScope";
import type { ResourceKind } from "../types";

const detailMounts = vi.fn();
vi.mock("./DetailPanel", async (orig) => {
  const { useEffect } = await import("react");
  const mod = await orig<typeof import("./DetailPanel")>();
  return {
    ...mod,
    DetailPanel: ({ target }: { target: { name: string } }) => {
      useEffect(() => {
        detailMounts(target.name);
      }, [target.name]);
      return <div data-testid={`detail-${target.name}`} />;
    },
  };
});

const { ResourceTable } = await import("./ResourceTable");
const { TabDrawers } = await import("./TabDrawers");

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  detailMounts.mockReset();
  act(() => useAppStore.setState({ ...initial }));
});

const crd = (): ResourceKind => ({
  id: "crd:widgets",
  group: "x.io",
  version: "v1",
  kind: "Widget",
  plural: "widgets",
  namespaced: true,
  category: "Custom" as ResourceKind["category"],
  columns: [{ id: "name", header: "Name", kind: "text" }],
});

const CLUSTERS = {
  a: [{ id: "a", name: "a", colorIdx: 0 }],
  b: [{ id: "b", name: "b", colorIdx: 0 }],
};

function Table({ cid }: { cid: "a" | "b" }) {
  const kind = useTabKind();
  if (!kind) return null;
  return (
    <ResourceTable
      mode="dark"
      clusters={CLUSTERS[cid]}
      viewScopeId={cid}
      kind={kind}
    />
  );
}

describe("ResourceTable keep-alive across tab switches", () => {
  it("keeps subscriptions and the open detail through switches and rail republishes", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "subscribe_resource" || cmd === "unsubscribe_resource") {
        calls.push(`${cmd}:${String(args?.clusterId)}`);
      }
      if (cmd === "subscribe_resource") {
        return { rows: [{ uid: "u1", name: "w1", namespace: "default" }], init_done: true };
      }
      return undefined;
    });
    const st = () => useAppStore.getState();
    act(() => {
      useAppStore.setState({
        contexts: [{ id: "a", name: "a" } as never, { id: "b", name: "b" } as never],
        openTabs: [],
        activeTabId: null,
      });
      st().setKinds([crd()]);
      st().selectContext("a");
      useAppStore.setState({ selectedKindId: "crd:widgets", kindClusters: { "crd:widgets": ["a"] } });
      st().selectContext("b");
      useAppStore.setState({ selectedKindId: "crd:widgets", kindClusters: { "crd:widgets": ["b"] } });
      st().switchTab(st().openTabs[0]!.id);
    });
    const [ta, tb] = st().openTabs;
    const view = () => (
      <>
        <TabScopeProvider tabId={ta!.id} active={st().activeTabId === ta!.id}>
          <Table cid="a" />
          <TabDrawers mode="dark" />
        </TabScopeProvider>
        <TabScopeProvider tabId={tb!.id} active={st().activeTabId === tb!.id}>
          <Table cid="b" />
          <TabDrawers mode="dark" />
        </TabScopeProvider>
      </>
    );
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(view());
    });
    await act(async () => {
      st().openDrawer({ kind: "detail", kindId: "crd:widgets", clusterId: "a", uid: "u1", namespace: "default", name: "w1" });
    });
    expect(detailMounts).toHaveBeenCalledTimes(1);
    const baseline = calls.length;

    for (const target of [tb!, ta!, tb!, ta!]) {
      await act(async () => {
        st().switchTab(target.id);
        r.rerender(view());
      });
      // The rail re-discovers for the new scope: fresh kind objects and a
      // fresh availability map with identical contents.
      await act(async () => {
        st().setKinds([crd()]);
        st().setKindClusters({ "crd:widgets": [target.id === ta!.id ? "a" : "b"] });
      });
    }

    expect(calls.slice(baseline)).toEqual([]);
    expect(detailMounts).toHaveBeenCalledTimes(1);
    expect(r.getByTestId("detail-w1")).toBeTruthy();
  });
});
