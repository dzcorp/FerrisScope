// A cluster tab's table unmounts when another tab is selected; its scroll
// offset per kind is saved in the tab's slice and re-applied on return.

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { TabScopeProvider, readTab } from "../lib/tabScope";
import { ResourceTable } from "./ResourceTable";
import type { ResourceKind } from "../types";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  act(() => useAppStore.setState({ ...initial }));
});

const kind: ResourceKind = {
  id: "configmaps",
  group: "",
  version: "v1",
  kind: "ConfigMap",
  plural: "configmaps",
  namespaced: true,
  category: "Config",
  columns: [{ id: "name", header: "Name", kind: "text" }],
};
const CLUSTERS = [{ id: "a", name: "a", colorIdx: 0 }];

function mount(tabId: string) {
  return render(
    <TabScopeProvider tabId={tabId} active>
      <ResourceTable mode="dark" clusters={CLUSTERS} viewScopeId="a" kind={kind} />
    </TabScopeProvider>,
  );
}

describe("ResourceTable scroll memory", () => {
  it("saves the offset into its tab on unmount and restores it on remount", async () => {
    setMockInvoke((cmd) =>
      cmd === "subscribe_resource"
        ? { rows: [{ uid: "u1", name: "cm", namespace: "default" }], init_done: true }
        : undefined,
    );
    act(() => {
      useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never, { id: "b", name: "b" } as never], openTabs: [], activeTabId: null });
      useAppStore.getState().selectContext("a");
      useAppStore.getState().selectContext("b");
    });
    const tabA = useAppStore.getState().openTabs[0]!.id;

    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = mount(tabA);
    });
    const body = screen.getByTestId("table-body");
    body.scrollTop = 480;
    fireEvent.scroll(body);
    r.unmount();
    expect(readTab(tabA).tableScroll).toEqual({ configmaps: 480 });
    // The active tab (b) is untouched.
    expect(useAppStore.getState().tableScroll).toEqual({});

    await act(async () => {
      mount(tabA);
    });
    await act(() => new Promise((res) => setTimeout(res, 2500)));
    expect(screen.getByTestId("table-body").scrollTop).toBe(480);
  });
});
