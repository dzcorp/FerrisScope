import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { useAppStore, type Drawer } from "../store";
import { TabScopeProvider, useTabActive } from "../lib/tabScope";

const mounts = vi.fn();
vi.mock("./LogPanel", () => ({
  LogPanel: ({ targets }: { targets: { name: string }[] }) => {
    const active = useTabActive();
    useEffect(() => {
      mounts(targets[0]?.name);
    }, [targets]);
    return <div data-testid={`log-${targets[0]?.name}`} data-active={String(active)} />;
  },
}));
vi.mock("./ComparePanel", () => ({ ComparePanel: () => null }));
const detailMounts = vi.fn();
vi.mock("./DetailPanel", async () => {
  const { useEffect, useState } = await import("react");
  return {
    DetailPanel: ({ target }: { target: { name: string } }) => {
      const [clicks, setClicks] = useState(0);
      useEffect(() => {
        detailMounts(target.name);
      }, [target.name]);
      return (
        <button data-testid={`detail-${target.name}`} onClick={() => setClicks((c) => c + 1)}>
          {clicks}
        </button>
      );
    },
  };
});
vi.mock("./inspect", () => ({ InspectPanel: () => null }));

const { TabDrawers } = await import("./TabDrawers");

const logs = (name: string): Drawer => ({
  kind: "logs",
  targets: [{ clusterId: "c1", kindId: "pods", namespace: "ns", name }],
});

beforeEach(() => {
  mounts.mockReset();
  detailMounts.mockReset();
  act(() =>
    useAppStore.setState({
      contexts: [{ id: "a", name: "a" } as never],
      kinds: [{ id: "pods", kind: "Pod", namespaced: true } as never],
      openTabs: [],
      activeTabId: null,
      drawer: null,
      drawerId: null,
      tray: [],
    }),
  );
  act(() => useAppStore.getState().selectContext("a"));
});

function mount() {
  const tabId = useAppStore.getState().activeTabId!;
  return render(
    <TabScopeProvider tabId={tabId} active>
      <TabDrawers mode="dark" />
    </TabScopeProvider>,
  );
}

describe("TabDrawers", () => {
  it("keeps a minimised drawer mounted and hidden, and restores the same instance", () => {
    mount();
    act(() => useAppStore.getState().openDrawer(logs("api")));
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("log-api").dataset["active"]).toBe("true");

    act(() => useAppStore.getState().minimizeDrawer());
    expect(screen.getByTestId("log-api").dataset["active"]).toBe("false");
    expect(screen.getByTestId("log-api").parentElement?.style.visibility).toBe("hidden");

    act(() => useAppStore.getState().openDrawer(logs("web")));
    act(() => useAppStore.getState().restoreTrayItem(useAppStore.getState().tray[0]!.id));
    expect(screen.getByTestId("log-api").dataset["active"]).toBe("true");
    expect(screen.getByTestId("log-web").dataset["active"]).toBe("false");
    // Two drawers, each mounted exactly once across the whole dance.
    expect(mounts.mock.calls.map((c) => c[0])).toEqual(["api", "web"]);
  });

  it("closing the open drawer unmounts it", () => {
    mount();
    act(() => useAppStore.getState().openDrawer(logs("api")));
    act(() => useAppStore.getState().closeDrawer());
    expect(screen.queryByTestId("log-api")).toBeNull();
  });

  it("a detail keeps its state through minimise, another panel, and restore", () => {
    mount();
    act(() =>
      useAppStore.getState().openDrawer({
        kind: "detail",
        kindId: "pods",
        clusterId: "c1",
        uid: "u1",
        namespace: "ns",
        name: "api-0",
      }),
    );
    fireEvent.click(screen.getByTestId("detail-api-0"));
    fireEvent.click(screen.getByTestId("detail-api-0"));
    act(() => useAppStore.getState().minimizeDrawer());
    act(() => useAppStore.getState().openDrawer(logs("web")));
    act(() => useAppStore.getState().restoreTrayItem(useAppStore.getState().tray[0]!.id));
    expect(screen.getByTestId("detail-api-0").textContent).toBe("2");
    expect(detailMounts).toHaveBeenCalledTimes(1);
    // The table's kind was never touched.
    expect(useAppStore.getState().pendingDetail).toBeNull();
  });

  it("switching between parked panels never moves their DOM nodes (scroll survives)", () => {
    const { container } = mount();
    act(() => useAppStore.getState().openDrawer(logs("a")));
    act(() => useAppStore.getState().minimizeDrawer());
    act(() => useAppStore.getState().openDrawer(logs("b")));
    const order = () =>
      Array.from(container.querySelectorAll("[data-testid^=log-]")).map((e) => e.getAttribute("data-testid"));
    const before = order();
    for (let i = 0; i < 3; i++) {
      act(() => useAppStore.getState().restoreTrayItem(useAppStore.getState().tray[0]!.id));
      expect(order()).toEqual(before);
    }
  });
});

describe("stableOrder", () => {
  it("keeps first-seen order, appends new ids, drops gone ones", async () => {
    const { stableOrder } = await import("./TabDrawers");
    const ref = { current: [] as string[] };
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    expect(ids(stableOrder(ref, [{ id: "a" }, { id: "b" }]))).toEqual(["a", "b"]);
    expect(ids(stableOrder(ref, [{ id: "b" }, { id: "a" }, { id: "c" }]))).toEqual(["a", "b", "c"]);
    expect(ids(stableOrder(ref, [{ id: "c" }, { id: "a" }]))).toEqual(["a", "c"]);
  });
});
