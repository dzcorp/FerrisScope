// Regression guard for the store-subscription shape. The Rail is mounted
// alongside the table for the whole browsing session, so a bulk
// `useAppStore()` destructure would re-render its full kind list (every
// discovered CRD) on every unrelated store mutation — the metrics tick,
// table-count updates, toasts, selection toggles. This test pins the
// per-field selector behaviour: an unrelated slice change commits zero
// additional renders.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { Rail } from "./Rail";

afterEach(() => {
  cleanup();
  resetMockInvoke();
  act(() => {
    useAppStore.setState({ metrics: null, tableCount: null });
  });
});

describe("Rail store subscription", () => {
  it("does not re-render when an unrelated store slice changes", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "list_resource_kinds") return [];
      return undefined;
    });

    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
      commits += 1;
    };

    await act(async () => {
      render(
        <Profiler id="rail" onRender={onRender}>
          <Rail mode="dark" />
        </Profiler>,
      );
    });
    // Flush the mount-time listResourceKinds() promise + effects.
    await act(async () => {});

    expect(commits).toBeGreaterThan(0);
    const baseline = commits;

    // The rail reads neither `metrics` nor `tableCount`. Per-field selectors
    // must absorb these high-frequency mutations with no re-render. (A bulk
    // `useAppStore()` would re-render the entire kind list on each.)
    act(() => {
      useAppStore.getState().setMetrics(null);
      useAppStore.getState().setTableCount({ filtered: 5, total: 9 });
    });

    expect(commits).toBe(baseline);
  });
});
