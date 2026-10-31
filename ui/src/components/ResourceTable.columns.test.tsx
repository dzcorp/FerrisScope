// Built-in columns can be turned off per (scope, kind) from the column picker,
// persisted next to the label columns.

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { TabScopeProvider } from "../lib/tabScope";
import { ResourceTable } from "./ResourceTable";
import type { ResourceKind, TableView } from "../types";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  act(() => useAppStore.setState({ ...initial }));
});

const kind: ResourceKind = {
  id: "pods",
  group: "",
  version: "v1",
  kind: "Pod",
  plural: "pods",
  namespaced: true,
  category: "Workloads",
  columns: [
    { id: "name", header: "Name", kind: "text" },
    { id: "node", header: "Node", kind: "text" },
    { id: "controlled_by", header: "Controlled By", kind: "text" },
  ],
};
const KEY = "a::pods";

async function mount(view: TableView | null = null) {
  const saved: TableView[] = [];
  setMockInvoke((cmd, args) => {
    if (cmd === "set_table_view") saved.push((args as { view: TableView }).view);
    return cmd === "subscribe_resource"
      ? { rows: [{ uid: "u1", name: "p", namespace: "default", node: "n1" }], init_done: true }
      : undefined;
  });
  act(() => {
    useAppStore.setState({ tableViews: view ? { [KEY]: view } : {} });
  });
  await act(async () => {
    render(
      <TabScopeProvider tabId="t" active>
        <ResourceTable
          mode="dark"
          clusters={[{ id: "a", name: "a", colorIdx: 0 }]}
          viewScopeId="a"
          kind={kind}
        />
      </TabScopeProvider>,
    );
  });
  return saved;
}

// Header text, not the picker's row of the same name.
const header = (text: string) =>
  screen.queryAllByText(text, { exact: true }).find((e) => !e.closest("[role=menu]")) ?? null;
const pick = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Customize columns" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name }));
  fireEvent.mouseDown(document.body);
};
const flush = () => act(() => new Promise((r) => setTimeout(r, 250)));

describe("ResourceTable built-in column visibility", () => {
  it("hides a column from the picker and persists the choice", async () => {
    const saved = await mount();
    expect(header("Node")).not.toBeNull();
    pick("Node");
    expect(header("Node")).toBeNull();
    await flush();
    expect(useAppStore.getState().tableViews[KEY]?.hidden_columns).toEqual(["node"]);
    expect(saved.at(-1)?.hidden_columns).toEqual(["node"]);
  });

  it("restores persisted hidden columns, and Reset brings them back", async () => {
    await mount({ sorting: [], column_sizing: {}, hidden_columns: ["controlled_by"] });
    expect(header("Controlled By")).toBeNull();
    expect(header("Node")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Customize columns" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(header("Controlled By")).not.toBeNull();
  });

  it("drops a sort on the column it hides", async () => {
    await mount({ sorting: [{ id: "node", desc: true }], column_sizing: {} });
    pick("Node");
    await flush();
    expect(useAppStore.getState().tableViews[KEY]?.sorting).toEqual([{ id: "name", desc: false }]);
  });
});
