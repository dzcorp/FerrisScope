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
    useAppStore.setState({ metrics: null, tableCount: null });
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
      useAppStore.getState().setMetrics(null);
      useAppStore.getState().setTableCount({ filtered: 5, total: 9 });
    });

    expect(commits).toBe(baseline);
  });
});
