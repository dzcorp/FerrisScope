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

describe("OpenClustersStrip short cluster names", () => {
  const GKE_A = "gke_production-4f83b34d_us-central1_prod-6";
  const GKE_B = "gke_development-d83ab4a8_europe-west4_truenv-03";

  const openGkePair = () => {
    act(() => {
      useAppStore.setState({
        contexts: [
          { id: `default::${GKE_A}`, name: GKE_A, user: null } as never,
          { id: `default::${GKE_B}`, name: GKE_B, user: null } as never,
        ],
      });
      useAppStore
        .getState()
        .openTab({ kind: "context", contextId: `default::${GKE_A}` });
      useAppStore
        .getState()
        .openTab({ kind: "context", contextId: `default::${GKE_B}` });
    });
  };

  it("renders the short name but keeps the full one in the tooltip", () => {
    openGkePair();
    render(<OpenClustersStrip t={t} open />);
    const row = screen.getByText("prod-6");
    expect(row).toBeTruthy();
    // The rail is narrow: no qualifier inline, full name on hover instead.
    expect(row.getAttribute("title")).toBe(GKE_A);
    expect(screen.queryByText(GKE_A)).toBeNull();
  });

  it("labels the close button with the full context name", () => {
    openGkePair();
    render(<OpenClustersStrip t={t} open />);
    expect(screen.getByLabelText(`Close ${GKE_A}`)).toBeTruthy();
  });

  it("falls back to full names when shortening is off", () => {
    act(() => {
      useAppStore.getState().patchSettings({ shortenClusterNames: false });
    });
    openGkePair();
    render(<OpenClustersStrip t={t} open />);
    expect(screen.getByText(GKE_A)).toBeTruthy();
    expect(screen.queryByText("prod-6")).toBeNull();
    act(() => {
      useAppStore.getState().patchSettings({ shortenClusterNames: true });
    });
  });
});
