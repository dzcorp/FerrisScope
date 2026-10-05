import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// The terminal body would load xterm and spawn a PTY; neither matters here.
vi.mock("../lib/xterm", () => ({ loadXterm: () => new Promise(() => {}) }));

import { Dock, makeChatTab, makeTerminalTab, openClusterChat } from "./Dock";
import { useAppStore } from "../store";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";

const TAB = "tab-1";

beforeEach(() => {
  setMockInvoke(() => undefined);
  act(() =>
    useAppStore.setState({
      activeTabId: TAB,
      dockTabs: [makeTerminalTab({ mode: "shell", clusterId: "c1", namespace: null }, "c1")],
      dockMin: { bottom: false, right: false },
      dockSize: { bottom: 300, right: null },
    }),
  );
});
afterEach(() => {
  cleanup();
  resetMockInvoke();
});

describe("Dock resize", () => {
  it("resizes the panel live and commits the size to the store on release", () => {
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frame = cb;
      return 1;
    });
    const { container } = render(
      <Dock mode="dark" clusterName="c1" clusterId="c1" placement="bottom" clusterTabId={TAB} />,
    );
    const handle = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
      (d) => d.style.cursor === "ns-resize",
    )!;
    const panel = handle.parentElement!;

    fireEvent.mouseDown(handle, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 380 });
    act(() => frame?.(0));
    // Live on the element; the store (which re-renders the app shell) waits.
    expect(panel.style.height).toBe("420px");
    expect(useAppStore.getState().dockSize.bottom).toBe(300);

    fireEvent.mouseUp(window);
    expect(useAppStore.getState().dockSize.bottom).toBe(420);
    vi.restoreAllMocks();
  });
});

describe("openClusterChat", () => {
  const chats = () => useAppStore.getState().dockTabs.filter((t) => t.kind === "chat");

  it("opens a chat bound to the first member when none exists", () => {
    act(() => openClusterChat([{ id: "c1", name: "prod" }, { id: "c2", name: "dev" }]));
    expect(chats()).toHaveLength(1);
    expect(chats()[0]!.state).toMatchObject({ clusterId: "c1", contextLabel: "prod" });
    expect(useAppStore.getState().dockActive.right).toBe(chats()[0]!.id);
  });

  it("focuses and restores the chat already bound to any member instead of stacking", () => {
    const existing = makeChatTab("c2", "dev");
    act(() =>
      useAppStore.setState({
        dockTabs: [existing, makeTerminalTab({ mode: "shell", clusterId: "c1", namespace: null }, "c1")],
        dockActive: { bottom: null, right: null },
        dockMin: { bottom: false, right: true },
      }),
    );
    act(() => openClusterChat([{ id: "c1", name: "prod" }, { id: "c2", name: "dev" }]));
    expect(chats()).toHaveLength(1);
    expect(useAppStore.getState().dockActive.right).toBe(existing.id);
    expect(useAppStore.getState().dockMin.right).toBe(false);
  });

  it("opens a separate chat for a cluster no existing chat is bound to", () => {
    act(() => useAppStore.setState({ dockTabs: [makeChatTab("c9", "other")] }));
    act(() => openClusterChat([{ id: "c1", name: "prod" }]));
    expect(chats()).toHaveLength(2);
  });

  it("does nothing for an empty scope", () => {
    act(() => openClusterChat([]));
    expect(chats()).toHaveLength(0);
  });
});
