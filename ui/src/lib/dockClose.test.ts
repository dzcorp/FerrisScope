import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore, type DockTab } from "../store";

const confirmMock = vi.fn<(o: unknown) => Promise<boolean>>();
vi.mock("./dialog", () => ({ confirm: (o: unknown) => confirmMock(o) }));

const { closeDockTabs, describeLive, liveDockTabs } = await import("./dockClose");

const tab = (id: string, kind: DockTab["kind"], state: Record<string, unknown> = {}): DockTab => ({
  id,
  kind,
  title: id,
  placement: kind === "chat" ? "right" : "bottom",
  state,
});

beforeEach(() => {
  confirmMock.mockReset();
  useAppStore.setState({
    dockTabs: [],
    dockActive: { bottom: null, right: null },
    dockMin: { bottom: false, right: false },
  });
});

describe("liveDockTabs", () => {
  it("counts terminals, chats and edited YAML only", () => {
    const tabs = [
      tab("t", "terminal"),
      tab("c", "chat"),
      tab("y1", "yaml", { pristine: true }),
      tab("y2", "yaml", { pristine: false }),
    ];
    expect(liveDockTabs(tabs).map((t) => t.id)).toEqual(["t", "c", "y2"]);
    expect(describeLive(liveDockTabs(tabs))).toBe("1 terminal, 1 chat, 1 unsaved YAML buffer");
  });
});

describe("closeDockTabs", () => {
  it("closes pristine tabs without asking", async () => {
    useAppStore.getState().addDockTab(tab("y", "yaml", { pristine: true }));
    expect(await closeDockTabs(["y"])).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
  });

  it("keeps live tabs when the operator cancels", async () => {
    useAppStore.getState().addDockTab(tab("t", "terminal"));
    confirmMock.mockResolvedValue(false);
    expect(await closeDockTabs(["t"])).toBe(false);
    expect(useAppStore.getState().dockTabs).toHaveLength(1);
  });

  it("closes live tabs after confirmation", async () => {
    useAppStore.getState().addDockTab(tab("c1", "chat"));
    useAppStore.getState().addDockTab(tab("c2", "chat"));
    confirmMock.mockResolvedValue(true);
    expect(await closeDockTabs(["c1", "c2"])).toBe(true);
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
  });
});
