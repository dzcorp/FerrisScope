// RBAC in the table: a kind the identity can't watch shows "No access"
// instead of spinning on a watcher that retries its 403 forever, and the row
// menu disables what the identity may not do, with the reason.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act, screen, fireEvent, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { TabScopeProvider, useTabKind } from "../lib/tabScope";
import { resetAccessCache } from "../lib/access";
import type { AccessDecision, ResourceKind } from "../types";

// jsdom has no layout, so the real virtualizer renders no rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number }) => ({
    measure: () => {},
    getTotalSize: () => o.count * 28,
    getVirtualItems: () =>
      Array.from({ length: o.count }, (_, i) => ({ index: i, key: i, start: i * 28, size: 28, end: (i + 1) * 28, lane: 0 })),
  }),
}));

const { ResourceTable } = await import("./ResourceTable");

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  resetAccessCache();
  act(() => useAppStore.setState({ ...initial }));
});

const CONFIGMAPS: ResourceKind = {
  id: "configmaps",
  group: "",
  version: "v1",
  kind: "ConfigMap",
  plural: "configmaps",
  namespaced: true,
  category: "Config" as ResourceKind["category"],
  columns: [{ id: "name", header: "Name", kind: "text" }],
};

function Table() {
  const kind = useTabKind();
  return kind ? (
    <ResourceTable mode="dark" clusters={[{ id: "a", name: "a", colorIdx: 0 }]} viewScopeId="a" kind={kind} />
  ) : null;
}

async function mount(decide: (action: string) => AccessDecision, rows: unknown[] = [], initDone = false) {
  setMockInvoke((cmd, args) => {
    if (cmd === "access_check_cmd") {
      return (args?.requests as { action: string }[]).map((r) => decide(r.action));
    }
    if (cmd === "subscribe_resource") return { rows, init_done: initDone };
    return undefined;
  });
  const st = () => useAppStore.getState();
  act(() => {
    useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never], openTabs: [], activeTabId: null });
    st().setKinds([CONFIGMAPS]);
    st().selectContext("a");
    useAppStore.setState({ selectedKindId: "configmaps" });
  });
  const tab = st().openTabs[0]!;
  await act(async () => {
    render(
      <TabScopeProvider tabId={tab.id} active>
        <Table />
      </TabScopeProvider>,
    );
  });
}

describe("ResourceTable RBAC", () => {
  it("a denied watch renders No access, not an endless Loading", async () => {
    await mount((a) =>
      a === "watch" ? { state: "denied", reason: "cannot list configmaps (cluster-wide)" } : { state: "allowed" },
    );
    expect(await screen.findByText("No access to configmaps")).toBeTruthy();
    expect(screen.getByText(/pick one with the namespace selector/)).toBeTruthy();
    expect(screen.queryByText("Loading configmaps…")).toBeNull();
  });

  it("an allowed watch keeps the normal loading state", async () => {
    await mount(() => ({ state: "allowed" }));
    await waitFor(() => expect(screen.getByText("Loading configmaps…")).toBeTruthy());
    expect(screen.queryByText("No access to configmaps")).toBeNull();
  });

  it("the row menu disables a denied delete and says why", async () => {
    await mount(
      (a) => (a === "delete" ? { state: "denied", reason: "cannot delete configmaps in ns" } : { state: "allowed" }),
      [{ uid: "u1", name: "cfg", namespace: "ns" }],
      true,
    );
    const cell = await screen.findByText("cfg");
    fireEvent.contextMenu(cell);
    const item = await screen.findByRole("menuitem", { name: "Delete configmap" });
    await waitFor(() => expect(item.getAttribute("title")).toBe("Not permitted: cannot delete configmaps in ns"));
    expect(item).toBeDisabled();
  });
});
