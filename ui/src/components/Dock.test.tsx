import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// The terminal body would load xterm and spawn a PTY; neither matters here.
vi.mock("../lib/xterm", () => ({ loadXterm: () => new Promise(() => {}) }));

import { Dock, makeTerminalTab } from "./Dock";
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
