import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useAppStore } from "../store";
import { TabScopeProvider, readTab, useTabKind, useTabSlice, writeTab } from "./tabScope";
import { useEscLayer } from "./escStack";

const ctx = (id: string) => ({ id, name: id }) as never;
const st = () => useAppStore.getState();

beforeEach(() => {
  act(() =>
    useAppStore.setState({
      contexts: [ctx("a"), ctx("b")],
      virtualContexts: [],
      openTabs: [],
      activeTabId: null,
      kinds: [],
      kindCache: {},
      drawer: null,
      drawerId: null,
      tray: [],
    }),
  );
  act(() => {
    st().selectContext("a");
    useAppStore.setState({ tableFilter: "in-a" });
    st().selectContext("b");
    useAppStore.setState({ tableFilter: "in-b" });
  });
});

const tabOf = (ctxId: string) => st().openTabs.find((t) => t.selectedContext === ctxId)!.id;
const wrap = (tabId: string, active: boolean) =>
  function W({ children }: { children: ReactNode }) {
    return (
      <TabScopeProvider tabId={tabId} active={active}>
        {children}
      </TabScopeProvider>
    );
  };

describe("tab scope", () => {
  it("a hidden tab reads its stashed slice; the active tab reads the mirror", () => {
    const hidden = renderHook(() => useTabSlice((v) => v.tableFilter), { wrapper: wrap(tabOf("a"), false) });
    const live = renderHook(() => useTabSlice((v) => v.tableFilter), { wrapper: wrap(tabOf("b"), true) });
    expect(hidden.result.current).toBe("in-a");
    expect(live.result.current).toBe("in-b");
    // Swapping which tab is active keeps both reading their own values.
    act(() => st().switchTab(tabOf("a")));
    expect(hidden.result.current).toBe("in-a");
    expect(live.result.current).toBe("in-b");
  });

  it("writeTab routes to the owning tab, never the active mirror", () => {
    writeTab(tabOf("a"), { tableFilter: "bg-write" });
    expect(st().tableFilter).toBe("in-b");
    expect(readTab(tabOf("a")).tableFilter).toBe("bg-write");
    writeTab(tabOf("b"), { tableFilter: "live-write" });
    expect(st().tableFilter).toBe("live-write");
  });

  it("an Esc layer inside a hidden tab doesn't register", () => {
    const onEsc = vi.fn();
    function Layer() {
      useEscLayer(true, onEsc);
      return null;
    }
    render(
      <TabScopeProvider tabId={tabOf("a")} active={false}>
        <Layer />
      </TabScopeProvider>,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onEsc).not.toHaveBeenCalled();
  });

  it("useTabKind falls back to the kind cache when discovery moved on", () => {
    const crd = { id: "crd:x", kind: "X" } as never;
    act(() => st().setKinds([crd]));
    act(() => useAppStore.setState({ selectedKindId: "crd:x" }));
    act(() => st().setKinds([], true));
    const { result } = renderHook(() => useTabKind(), { wrapper: wrap(tabOf("b"), true) });
    expect(result.current).toBe(crd);
  });
});
