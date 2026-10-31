// The table header and cells follow the theme's `typography.table`: Default
// keeps Helmsman's uppercase mono header, Lens / VS Code use plain sans.

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { TabScopeProvider } from "../lib/tabScope";
import { ResourceTable, renderCell } from "./ResourceTable";
import { tokens } from "../theme";
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
  columns: [
    { id: "name", header: "Name", kind: "text" },
    { id: "namespace", header: "Namespace", kind: "text" },
  ],
};

async function mount(themeId: string) {
  act(() => useAppStore.getState().setTheme(themeId));
  setMockInvoke((cmd) =>
    cmd === "subscribe_resource"
      ? { rows: [{ uid: "u1", name: "cm-one", namespace: "default" }], init_done: true }
      : undefined,
  );
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
}

const headerCell = (label: string) =>
  screen.getByText(label, { selector: "span" }).parentElement as HTMLElement;

describe("ResourceTable theme typography", () => {
  it("Default renders the uppercase mono header", async () => {
    await mount("default");
    const h = headerCell("Name");
    expect(h.style.textTransform).toBe("uppercase");
    expect(h.style.fontFamily).toContain("--fs-font-mono");
    expect(h.style.fontWeight).toBe("700");
  });

  it("Lens renders a plain-case sans header at its own size", async () => {
    await mount("lens");
    const h = headerCell("Name");
    expect(h.style.textTransform).toBe("none");
    expect(h.style.fontFamily).toContain("--fs-font-sans");
    expect(h.style.fontSize).toBe("13px");
    expect(h.style.fontWeight).toBe("500");
  });

  it("text cells size from the table vars, mono or not", () => {
    const col = { id: "name", header: "Name", kind: "text" } as const;
    const row = { uid: "u", name: "cm-one", namespace: "default" };
    const noop = () => {};
    const draw = (mono: boolean) =>
      render(<>{renderCell(col, row, "dark", tokens("dark"), false, null, mono, noop, noop)}</>);
    const sans = draw(false);
    expect(sans.getByText("cm-one").style.fontSize).toBe("var(--fs-table-fs, 12px)");
    sans.unmount();
    expect(draw(true).getByText("cm-one").style.fontSize).toBe("var(--fs-table-fs-mono, 11.5px)");
  });
});
