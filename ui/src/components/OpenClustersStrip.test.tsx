import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { OpenClustersStrip } from "./OpenClustersStrip";
import { useAppStore } from "../store";
import { tokens } from "../theme";

const ctx = (id: string) => ({ id, name: id, source: "default" }) as never;

beforeEach(() => {
  cleanup();
  act(() => {
    useAppStore.setState({
      contexts: [ctx("default::alpha"), ctx("default::beta")],
      virtualContexts: [],
      kinds: [],
      openTabs: [],
      activeTabId: null,
      selectedContext: null,
      selectedVirtualContextId: null,
      scopeExtras: [],
    });
  });
});

function openTwo() {
  act(() => {
    useAppStore.getState().openTab({ kind: "context", contextId: "default::alpha" });
    useAppStore.getState().openTab({ kind: "context", contextId: "default::beta" });
  });
}

const t = tokens("dark");

describe("OpenClustersStrip", () => {
  it("renders nothing while fewer than two tabs are open", () => {
    act(() => {
      useAppStore.getState().openTab({ kind: "context", contextId: "default::alpha" });
    });
    render(<OpenClustersStrip t={t} open />);
    expect(screen.queryByTestId("open-clusters-strip")).toBeNull();
  });

  it("lists every open tab and switches on click, preserving the rest", () => {
    openTwo();
    render(<OpenClustersStrip t={t} open />);
    expect(screen.getByTestId("open-clusters-strip")).toBeTruthy();
    // beta is active (opened last).
    expect(useAppStore.getState().selectedContext).toBe("default::beta");

    fireEvent.click(screen.getByText("default::alpha"));
    expect(useAppStore.getState().selectedContext).toBe("default::alpha");
    // Both tabs still open — switching never closes.
    expect(useAppStore.getState().openTabs).toHaveLength(2);
  });

  it("closes a tab (backend disconnect is App's reconcile effect, not the strip)", () => {
    openTwo();
    render(<OpenClustersStrip t={t} open />);
    fireEvent.click(screen.getByLabelText("Close default::alpha"));
    expect(useAppStore.getState().openTabs).toHaveLength(1);
    expect(
      useAppStore
        .getState()
        .openTabs.some((tb) => tb.selectedContext === "default::alpha"),
    ).toBe(false);
  });
});
