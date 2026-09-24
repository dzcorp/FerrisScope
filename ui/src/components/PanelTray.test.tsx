import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { PanelTray, expandedWidth, sortTray, trayLabel } from "./PanelTray";
import { useAppStore, type Drawer, type DockTab } from "../store";

const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock("../lib/dialog", () => ({ confirm: () => confirmMock() }));

const logs: Drawer = {
  kind: "logs",
  targets: [{ clusterId: "c1", kindId: "pods", namespace: "ns", name: "api-0" }],
};
const detail: Drawer = {
  kind: "detail",
  kindId: "pods",
  clusterId: "c1",
  uid: "u1",
  namespace: "ns",
  name: "db-0",
};
const chat: DockTab = { id: "chat-1", kind: "chat", title: "chat", placement: "right", state: {} };

beforeEach(() => {
  cleanup();
  act(() =>
    useAppStore.setState({
      drawer: null,
      tray: [],
      kinds: [],
      dockTabs: [],
      dockActive: { bottom: null, right: null },
      dockMin: { bottom: false, right: false },
      dockSize: { bottom: null, right: null },
    }),
  );
});

describe("trayLabel", () => {
  it("titles the object; the subtitle says what kind of view it is", () => {
    const kinds = [{ id: "pods", kind: "Pod" }] as never;
    expect(trayLabel(detail, kinds)).toEqual({ title: "db-0", subtitle: "Pod · ns" });
    expect(trayLabel(logs, [])).toEqual({ title: "api-0", subtitle: "Logs · ns" });
    const two = { clusterId: "c1", kindId: "pods", namespace: "ns", name: "b" };
    expect(trayLabel({ kind: "logs", initialTab: "metrics", targets: [two, two] }, [])).toEqual({
      title: "2 objects",
      subtitle: "Metrics",
    });
  });
});

const PEEK = 1000;
const park = (d: Drawer) =>
  act(() => {
    useAppStore.getState().openDrawer(d);
    useAppStore.getState().minimizeDrawer();
  });
const row = (name: RegExp) => screen.getByRole("listitem", { name });
const controlsOf = (name: string) => screen.getByLabelText(`Close ${name}`).parentElement!;
// Hover the tray and wait out the arm delay so close buttons accept clicks.
async function expand() {
  fireEvent.mouseEnter(screen.getByTestId("panel-tray"));
  await act(() => new Promise((r) => setTimeout(r, 260)));
}

describe("sortTray", () => {
  const kinds = [
    { id: "pods", kind: "Pod", category: "Workloads" },
    { id: "deployments", kind: "Deployment", category: "Workloads" },
    { id: "services", kind: "Service", category: "Network" },
    { id: "configmaps", kind: "ConfigMap", category: "Config" },
  ] as never[];
  const det = (kindId: string, name: string): Drawer => ({ kind: "detail", kindId, clusterId: "c", uid: name, namespace: "ns", name });
  const lg = (kindId: string, name: string): Drawer => ({ kind: "logs", targets: [{ clusterId: "c", kindId, namespace: "ns", name }] });

  it("follows the rail: group, kind, then view type, then name; unknown kinds last", () => {
    const items = [
      { id: "1", drawer: det("configmaps", "cfg") },
      { id: "2", drawer: det("crd:gone", "x") },
      { id: "3", drawer: lg("pods", "api") },
      { id: "4", drawer: det("services", "svc") },
      { id: "5", drawer: det("pods", "web") },
      { id: "6", drawer: det("pods", "api") },
      { id: "7", drawer: det("deployments", "dep") },
    ];
    expect(sortTray(items, kinds).map((i) => i.id)).toEqual(["6", "5", "3", "7", "4", "1", "2"]);
  });

  it("is independent of hide order", () => {
    const a = { id: "a", drawer: det("services", "svc") };
    const b = { id: "b", drawer: det("pods", "api") };
    expect(sortTray([a, b], kinds).map((i) => i.id)).toEqual(sortTray([b, a], kinds).map((i) => i.id));
  });
});

describe("expandedWidth", () => {
  it("fits the longest text plus row chrome, clamped to 160–360", () => {
    expect(expandedWidth([])).toBe(160);
    expect(expandedWidth([20, 30])).toBe(160);
    expect(expandedWidth([120.2, 90])).toBe(121 + 82);
    expect(expandedWidth([900])).toBe(360);
  });
});

describe("PanelTray", () => {
  it("renders nothing when nothing is hidden", () => {
    render(<PanelTray />);
    expect(screen.queryByTestId("panel-tray")).toBeNull();
  });

  it("is an icon column at rest and expands into a named list on hover", () => {
    park(logs);
    render(<PanelTray />);
    const tray = screen.getByTestId("panel-tray");
    expect(tray.dataset["open"]).toBe("false");
    expect(tray.style.width).toBe("40px");
    // Close controls are inert until expanded, so a stray click can't close anything.
    expect(controlsOf("api-0").dataset["armed"]).toBe("false");
    fireEvent.mouseEnter(tray);
    expect(tray.dataset["open"]).toBe("true");
    // jsdom measures text as 0 wide, so the floor applies.
    expect(tray.style.width).toBe("160px");
    expect(screen.getByLabelText("Close api-0")).toBeTruthy();
  });

  it("stays open one second after the pointer leaves; re-entering keeps it", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      render(<PanelTray />);
      const tray = screen.getByTestId("panel-tray");
      fireEvent.mouseEnter(tray);
      fireEvent.mouseLeave(tray);
      act(() => vi.advanceTimersByTime(900));
      expect(tray.dataset["open"]).toBe("true");
      fireEvent.mouseEnter(tray);
      act(() => vi.advanceTimersByTime(2000));
      expect(tray.dataset["open"]).toBe("true");
      fireEvent.mouseLeave(tray);
      act(() => vi.advanceTimersByTime(999));
      expect(tray.dataset["open"]).toBe("true");
      act(() => vi.advanceTimersByTime(1));
      expect(tray.dataset["open"]).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keyboard focus expands it; Enter restores, Delete closes", () => {
    park(logs);
    park(detail);
    render(<PanelTray />);
    const logsRow = row(/Logs · ns/);
    fireEvent.keyDown(window, { key: "Tab" });
    act(() => logsRow.focus());
    expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("true");
    fireEvent.keyDown(row(/db-0/), { key: "Delete" });
    expect(useAppStore.getState().tray).toHaveLength(1);
    fireEvent.keyDown(logsRow, { key: "Enter" });
    expect(useAppStore.getState().drawer).toEqual(logs);
  });

  it("keeps the icon on the fixed edge so the opening pointer isn't on a close button", () => {
    park(logs);
    render(<PanelTray />);
    fireEvent.mouseEnter(screen.getByTestId("panel-tray"));
    expect(row(/Logs/).style.flexDirection).toBe("row-reverse");
    // Close buttons are inert until the expand animation has finished.
    const close = controlsOf("api-0");
    expect(close.dataset["armed"]).toBe("false");
    expect(close.style.pointerEvents).toBe("none");
  });

  it("clicking a row restores it; its × closes without restoring", async () => {
    park(logs);
    park(detail);
    render(<PanelTray />);
    await expand();
    expect(controlsOf("api-0").dataset["armed"]).toBe("true");
    fireEvent.click(screen.getByLabelText("Close api-0"));
    expect(useAppStore.getState().drawer).toBeNull();
    expect(useAppStore.getState().tray).toHaveLength(1);
    fireEvent.click(row(/db-0/));
    expect(useAppStore.getState().drawer).toEqual(detail);
    expect(useAppStore.getState().tray).toHaveLength(0);
  });

  it("middle-click closes a row", () => {
    park(logs);
    render(<PanelTray />);
    fireEvent(row(/Logs/), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(useAppStore.getState().tray).toHaveLength(0);
  });

  it("hosts the minimised chat dock", async () => {
    act(() => {
      useAppStore.getState().addDockTab(chat);
      useAppStore.getState().setDockMin("right", true);
    });
    render(<PanelTray />);
    fireEvent.click(row(/Chat/));
    expect(useAppStore.getState().dockMin.right).toBe(false);
    expect(screen.queryByTestId("panel-tray")).toBeNull();

    act(() => useAppStore.getState().setDockMin("right", true));
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close chat"));
    });
    expect(confirmMock).toHaveBeenCalled();
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
  });

  it("docks against the open chat panel, and rises above a drawer's scrim", () => {
    act(() => {
      useAppStore.getState().addDockTab(chat);
      useAppStore.setState({ dockSize: { bottom: null, right: 400 } });
    });
    park(logs);
    render(<PanelTray />);
    const tray = screen.getByTestId("panel-tray");
    expect(tray.style.right).toBe("var(--fs-drawer-w, 400px)");
    expect(tray.style.top).toBe("calc(var(--fs-table-body-top, calc(60px + var(--fs-titlebar-h, 0px))) + 4px)");
    expect(tray.style.zIndex).toBe("26");
    act(() => useAppStore.getState().openDrawer(detail));
    expect(screen.getByTestId("panel-tray").style.zIndex).toBe("32");
  });

  it("sizes to the measured names and left-aligns them", () => {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-tray-text") ? (this.textContent ?? "").length * 7 : 0;
      },
    });
    try {
      park({ kind: "logs", targets: [{ clusterId: "c1", kindId: "pods", namespace: "ns", name: "x".repeat(20) }] });
      render(<PanelTray />);
      const tray = screen.getByTestId("panel-tray");
      fireEvent.mouseEnter(tray);
      expect(tray.style.width).toBe(`${expandedWidth([140])}px`);
      const text = tray.querySelector("[data-tray-text]")!.parentElement!;
      expect(text.style.alignItems).toBe("flex-start");
    } finally {
      if (orig) Object.defineProperty(HTMLElement.prototype, "scrollWidth", orig);
    }
  });

  it("hiding a panel previews its row for a second, then folds back to icons", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      render(<PanelTray />);
      const tray = () => screen.getByTestId("panel-tray");
      // An existing tray at mount doesn't flash.
      expect(tray().dataset["open"]).toBe("false");
      park(detail);
      expect(tray().dataset["open"]).toBe("true");
      act(() => vi.advanceTimersByTime(999));
      expect(tray().dataset["open"]).toBe("true");
      act(() => vi.advanceTimersByTime(1));
      expect(tray().dataset["open"]).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hovering during the preview keeps it open", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      render(<PanelTray />);
      park(detail);
      fireEvent.mouseEnter(screen.getByTestId("panel-tray"));
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a clicked row doesn't hold the tray open through focus", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      park(detail);
      render(<PanelTray />);
      const tray = screen.getByTestId("panel-tray");
      fireEvent.pointerDown(window);
      fireEvent.mouseEnter(tray);
      const r = row(/Logs/);
      act(() => r.focus());
      fireEvent.click(r);
      park(logs);
      fireEvent.mouseLeave(tray);
      act(() => vi.advanceTimersByTime(PEEK));
      expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Close all closes every hidden panel and chat after one confirmation", async () => {
    act(() => {
      useAppStore.getState().addDockTab(chat);
      useAppStore.getState().setDockMin("right", true);
    });
    park(logs);
    park(detail);
    render(<PanelTray />);
    await expand();
    confirmMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId("tray-close-all"));
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().tray).toHaveLength(0);
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
  });

  it("Close all leaves an open chat alone", async () => {
    act(() => useAppStore.getState().addDockTab(chat));
    park(logs);
    park(detail);
    render(<PanelTray />);
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByTestId("tray-close-all"));
    });
    expect(useAppStore.getState().tray).toHaveLength(0);
    expect(useAppStore.getState().dockTabs.map((d) => d.id)).toEqual(["chat-1"]);
  });

  it("Close all is offered only with two or more hidden items", async () => {
    park(logs);
    render(<PanelTray />);
    await expand();
    expect(screen.queryByTestId("tray-close-all")).toBeNull();
  });

  it("keeps rows in rail order through restore and re-hide", () => {
    act(() =>
      useAppStore.setState({
        kinds: [
          { id: "pods", kind: "Pod", category: "Workloads" },
          { id: "services", kind: "Service", category: "Network" },
        ] as never[],
      }),
    );
    const svc: Drawer = { kind: "detail", kindId: "services", clusterId: "c1", uid: "s", namespace: "ns", name: "svc" };
    park(svc);
    park(detail);
    render(<PanelTray />);
    const names = () =>
      screen.getAllByRole("listitem").map((el) => el.getAttribute("aria-label")?.replace(/^Restore (\S+).*/, "$1"));
    expect(names()).toEqual(["db-0", "svc"]);
    act(() => useAppStore.getState().restoreTrayItem(useAppStore.getState().tray.find((i) => i.drawer.kind === "detail" && i.drawer.name === "db-0")!.id));
    act(() => useAppStore.getState().minimizeDrawer());
    expect(names()).toEqual(["db-0", "svc"]);
  });

  it("the preview after hiding shows row x but not Close all", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      render(<PanelTray />);
      park(detail);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("true");
      expect(controlsOf("db-0").dataset["armed"]).toBe("true");
      expect(screen.getByTestId("tray-close-all").getAttribute("aria-hidden")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaving hides Close all at once; row x stay until the tray folds", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      park(detail);
      render(<PanelTray />);
      const tray = screen.getByTestId("panel-tray");
      fireEvent.mouseEnter(tray);
      act(() => vi.advanceTimersByTime(300));
      expect(controlsOf("db-0").dataset["armed"]).toBe("true");
      expect(screen.getByTestId("tray-close-all").getAttribute("aria-hidden")).toBe("false");
      fireEvent.mouseLeave(tray);
      // Close all goes at once; row x stay through the linger.
      expect(screen.getByTestId("tray-close-all").getAttribute("aria-hidden")).toBe("true");
      expect(controlsOf("db-0").dataset["armed"]).toBe("true");
      expect(tray.dataset["open"]).toBe("true");
      act(() => vi.advanceTimersByTime(1000));
      expect(tray.dataset["open"]).toBe("false");
      expect(controlsOf("db-0").dataset["armed"]).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds when opening a panel moves it out from under the pointer", () => {
    vi.useFakeTimers();
    try {
      park(logs);
      park(detail);
      render(<PanelTray />);
      const tray = screen.getByTestId("panel-tray");
      fireEvent.mouseEnter(tray);
      act(() => vi.advanceTimersByTime(300));
      // No mouseleave: the tray jumps to the new panel's edge instead.
      fireEvent.click(row(/db-0/));
      expect(useAppStore.getState().drawer).toEqual(detail);
      expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("false");
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("false");
      // Hiding the panel still previews it.
      act(() => useAppStore.getState().minimizeDrawer());
      expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds when the chat is restored from it", () => {
    act(() => {
      useAppStore.getState().addDockTab(chat);
      useAppStore.getState().setDockMin("right", true);
    });
    park(logs);
    render(<PanelTray />);
    fireEvent.mouseEnter(screen.getByTestId("panel-tray"));
    fireEvent.click(row(/Chat/));
    expect(screen.getByTestId("panel-tray").dataset["open"]).toBe("false");
  });
});
