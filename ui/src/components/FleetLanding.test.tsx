// Regression guard for the store-subscription shape. FleetLanding must read
// the store through per-field selectors, NOT a bulk `useAppStore()`
// destructure. The bulk form subscribes to the whole state object, so any
// unrelated mutation (the ~1 Hz metrics tick, table-count churn, toasts)
// produces a new top-level state reference and re-renders the entire landing
// screen. This test pins the per-field behaviour: an unrelated slice change
// must commit zero additional renders.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { FleetLanding } from "./FleetLanding";

afterEach(() => {
  cleanup();
  resetMockInvoke();
  // Reset the slices these tests poke so they don't bleed across the file.
  act(() => {
    useAppStore.setState({ metricsByCluster: {}, tableCount: null });
  });
});

describe("FleetLanding store subscription", () => {
  it("does not re-render when an unrelated store slice changes", async () => {
    setMockInvoke((cmd) => {
      switch (cmd) {
        case "list_contexts":
          return [];
        case "get_fleet_cache":
          return {};
        default:
          return undefined;
      }
    });

    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
      commits += 1;
    };

    await act(async () => {
      render(
        <Profiler id="fleet" onRender={onRender}>
          <FleetLanding mode="dark" onSelect={() => {}} />
        </Profiler>,
      );
    });
    // Flush the mount-time listContexts()/getFleetCache() promises + effects.
    await act(async () => {});

    expect(commits).toBeGreaterThan(0);
    const baseline = commits;

    // FleetLanding reads neither `metrics` nor `tableCount`. Both `set(...)`
    // calls produce a fresh top-level state object; with per-field selectors
    // the component's selected slices are referentially unchanged, so it must
    // not re-render. (A bulk `useAppStore()` would re-render on each.)
    act(() => {
      useAppStore.getState().setMetrics("c1", { pods: {}, cluster: null, pod_volumes: {}, pvcs: {}, available: false, volumes_available: false, fetched_at_unix_ms: 0 } as never);
      useAppStore.getState().setTableCount({ filtered: 5, total: 9 });
    });

    expect(commits).toBe(baseline);
  });
});

// ─── Virtual context multi-select + CRUD ────────────────────────────────────

import { fireEvent, screen } from "@testing-library/react";

const fleetCtx = (id: string, name: string) => ({
  id,
  name,
  cluster: name,
  user: null,
  namespace: null,
  is_current: false,
  group: "Default",
  source_id: "default",
  source_path: null,
});

const fleetMock = () =>
  setMockInvoke((cmd) => {
    switch (cmd) {
      case "list_contexts":
        return [fleetCtx("default::a", "alpha"), fleetCtx("default::b", "beta")];
      case "get_fleet_cache":
        return {};
      case "refresh_fleet":
        return undefined;
      default:
        return undefined;
    }
  });

const resetVctxState = () =>
  act(() => {
    useAppStore.setState({
      contexts: [],
      virtualContexts: [],
      selectedVirtualContextId: null,
      selectedContext: null,
      scopeExtras: [],
    });
  });

describe("FleetLanding virtual-context flow", () => {
  it("⌘-click picks cards, the bar gates on 2+ and a unique name, save writes the store", async () => {
    resetVctxState();
    fleetMock();
    const onSelect = () => {};
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={onSelect} />);
    });
    await act(async () => {});

    // ⌘-click the first card → picked, floating bar appears.
    fireEvent.click(screen.getAllByText("alpha").at(-1)!, { metaKey: true });
    expect(screen.getByText("selected")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Pick 2+ clusters…"),
    ).toBeTruthy();

    // Picking the second flips the placeholder to the name prompt.
    fireEvent.click(screen.getAllByText("beta").at(-1)!, { metaKey: true });
    const input = screen.getByLabelText("Virtual context name");
    fireEvent.change(input, { target: { value: "prod fleet" } });
    fireEvent.click(screen.getByText("Save"));

    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(1);
    expect(s.virtualContexts[0]!.name).toBe("prod fleet");
    expect(new Set(s.virtualContexts[0]!.members)).toEqual(
      new Set(["default::a", "default::b"]),
    );
    // Saving does not activate, and pick mode is cleared.
    expect(s.selectedVirtualContextId).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("refuses to save a duplicate name", async () => {
    resetVctxState();
    fleetMock();
    act(() => {
      useAppStore.setState({
        virtualContexts: [
          { id: "v0", name: "prod fleet", members: ["default::a", "default::b"] },
        ],
      });
    });
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    fireEvent.click(screen.getAllByText("alpha").at(-1)!, { metaKey: true });
    fireEvent.click(screen.getAllByText("beta").at(-1)!, { metaKey: true });
    const input = screen.getByLabelText("Virtual context name");
    fireEvent.change(input, { target: { value: "PROD FLEET" } });
    fireEvent.click(screen.getByText("Save"));
    // Still just the pre-existing one.
    expect(useAppStore.getState().virtualContexts).toHaveLength(1);
  });

  it("renders saved virtual contexts as cards and click activates them", async () => {
    resetVctxState();
    fleetMock();
    act(() => {
      useAppStore.setState({
        virtualContexts: [
          { id: "v1", name: "edge", members: ["default::a", "default::b"] },
        ],
      });
    });
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    expect(screen.getByText("Virtual contexts")).toBeTruthy();
    expect(screen.getByText("2 clusters")).toBeTruthy();
    fireEvent.click(screen.getByText("edge"));
    const s = useAppStore.getState();
    expect(s.selectedVirtualContextId).toBe("v1");
    expect(s.selectedContext).toBeNull();
  });

  it("plain click still connects (single-select path untouched)", async () => {
    resetVctxState();
    fleetMock();
    const picked: string[] = [];
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={(id) => picked.push(id)} />);
    });
    await act(async () => {});
    fireEvent.click(screen.getAllByText("alpha").at(-1)!);
    expect(picked).toEqual(["default::a"]);
    expect(useAppStore.getState().virtualContexts).toHaveLength(0);
  });
});

// ─── Virtual context fleet-view variants ────────────────────────────────────

const fleetProbe = (name: string, over: Record<string, unknown>) => ({
  context_name: name,
  server_version: "v1.30",
  nodes: null,
  pods: null,
  cpu_used_milli: null,
  cpu_capacity_milli: null,
  mem_used_mib: null,
  mem_capacity_mib: null,
  healthy: true,
  fetched_at_unix_ms: 0,
  last_error: null,
  ...over,
});

const probedFleetMock = () =>
  setMockInvoke((cmd) => {
    switch (cmd) {
      case "list_contexts":
        return [fleetCtx("default::a", "alpha"), fleetCtx("default::b", "beta")];
      case "get_fleet_cache":
        return {
          "default::a": fleetProbe("default::a", {
            nodes: 3,
            pods: 10,
            cpu_used_milli: 500,
            cpu_capacity_milli: 1000,
            mem_used_mib: 1024,
            mem_capacity_mib: 4096,
          }),
          "default::b": fleetProbe("default::b", {
            nodes: 2,
            pods: 20,
            cpu_used_milli: 250,
            cpu_capacity_milli: 500,
            mem_used_mib: 1024,
            mem_capacity_mib: 4096,
          }),
        };
      case "refresh_fleet":
        return undefined;
      default:
        return undefined;
    }
  });

const setFleetView = (view: "tiles" | "mini" | "rows") =>
  act(() => {
    useAppStore.setState((s) => ({
      settings: { ...s.settings, fleetView: view },
    }));
  });

const seedVctx = () =>
  act(() => {
    useAppStore.setState({
      virtualContexts: [
        { id: "v1", name: "edge", members: ["default::a", "default::b"] },
      ],
    });
  });

describe("FleetLanding virtual-context view variants", () => {
  afterEach(() => setFleetView("tiles"));

  it("tiles: shows aggregated gauges and summed node/pod stats", async () => {
    resetVctxState();
    probedFleetMock();
    seedVctx();
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    // Summed across members: 3+2 nodes, 10+20 pods — distinct from any
    // single member's "3 nodes · 10 pods" summary line.
    expect(screen.getByText("5 nodes · 30 pods")).toBeTruthy();
    // Gauge pair on the vctx card plus one pair per member FleetCard.
    expect(screen.getAllByText("cpu")).toHaveLength(3);
    expect(screen.getAllByText("mem")).toHaveLength(3);
    // Member chips keep per-member identity on the card.
    expect(screen.getAllByText("alpha").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("2 clusters")).toBeTruthy();
  });

  it("mini: compact card without gauges or stats, count retained", async () => {
    resetVctxState();
    probedFleetMock();
    seedVctx();
    setFleetView("mini");
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    expect(screen.getByText("2 clusters")).toBeTruthy();
    expect(screen.queryByText("cpu")).toBeNull();
    expect(screen.queryByText("5 nodes · 30 pods")).toBeNull();
    // Still opens on click.
    fireEvent.click(screen.getByText("edge"));
    expect(useAppStore.getState().selectedVirtualContextId).toBe("v1");
  });

  it("rows: renders one row with member chips and joined stats", async () => {
    resetVctxState();
    probedFleetMock();
    seedVctx();
    setFleetView("rows");
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    expect(screen.getByText("2 clusters · 5 nodes · 30 pods")).toBeTruthy();
    expect(screen.queryByText("cpu")).toBeNull();
    fireEvent.click(screen.getByText("edge"));
    expect(useAppStore.getState().selectedVirtualContextId).toBe("v1");
  });

  it("flags a member missing from the kubeconfig in the stats line", async () => {
    resetVctxState();
    probedFleetMock();
    act(() => {
      useAppStore.setState({
        virtualContexts: [
          { id: "v2", name: "edge", members: ["default::a", "default::gone"] },
        ],
      });
    });
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    expect(screen.getByText("3 nodes · 10 pods · 1 missing")).toBeTruthy();
  });
});

describe("FleetLanding generated names + temporary open", () => {
  it("saves with the pregenerated name when the input is left empty", async () => {
    resetVctxState();
    fleetMock();
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    fireEvent.click(screen.getAllByText("alpha").at(-1)!, { metaKey: true });
    fireEvent.click(screen.getAllByText("beta").at(-1)!, { metaKey: true });
    // The placeholder previews exactly what Save will use.
    const input = screen.getByLabelText("Virtual context name");
    expect(input.getAttribute("placeholder")).toBe("alpha + beta");
    fireEvent.click(screen.getByText("Save"));

    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(1);
    expect(s.virtualContexts[0]!.name).toBe("alpha + beta");
  });

  it("dedupes the pregenerated name against existing virtual contexts", async () => {
    resetVctxState();
    fleetMock();
    act(() => {
      useAppStore.setState({
        virtualContexts: [
          { id: "v0", name: "alpha + beta", members: ["default::a", "default::b"] },
        ],
      });
    });
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    fireEvent.click(screen.getAllByText("alpha").at(-1)!, { metaKey: true });
    fireEvent.click(screen.getAllByText("beta").at(-1)!, { metaKey: true });
    fireEvent.click(screen.getByText("Save"));

    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(2);
    expect(s.virtualContexts[1]!.name).toBe("alpha + beta (2)");
  });

  it("'Open' anchors the first pick and rides the rest as extras", async () => {
    resetVctxState();
    fleetMock();
    await act(async () => {
      render(<FleetLanding mode="dark" onSelect={() => {}} />);
    });
    await act(async () => {});

    fireEvent.click(screen.getAllByText("alpha").at(-1)!, { metaKey: true });
    // Not offered below 2 picks.
    expect(screen.queryByText("Open")).toBeNull();
    fireEvent.click(screen.getAllByText("beta").at(-1)!, { metaKey: true });
    fireEvent.click(screen.getByText("Open"));

    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("default::a");
    expect(s.scopeExtras).toEqual(["default::b"]);
    // Nothing persisted, pick mode cleared.
    expect(s.virtualContexts).toHaveLength(0);
    expect(s.selectedVirtualContextId).toBeNull();
    expect(screen.queryByText("Open")).toBeNull();
  });
});
