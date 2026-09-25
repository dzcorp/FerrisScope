import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/DetailPanel", () => ({ DetailPanel: () => null }));
vi.mock("../components/SettingsPanel", () => ({ SettingsPanel: () => null }));

import { PREFETCH_DELAY_MS, loadDetailPanel, loadSettingsPanel, prefetchPanels } from "./lazyPanels";

describe("lazyPanels", () => {
  afterEach(() => vi.useRealTimers());

  it("exposes each named export as a default for React.lazy", async () => {
    expect(typeof (await loadDetailPanel()).default).toBe("function");
    expect(typeof (await loadSettingsPanel()).default).toBe("function");
  });

  it("prefetches after the delay, and not at all when cancelled", () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve());
    prefetchPanels(PREFETCH_DELAY_MS, [load])();
    vi.advanceTimersByTime(PREFETCH_DELAY_MS * 2);
    expect(load).not.toHaveBeenCalled();

    prefetchPanels(PREFETCH_DELAY_MS, [load]);
    vi.advanceTimersByTime(PREFETCH_DELAY_MS - 1);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed prefetch", async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.reject(new Error("offline")));
    prefetchPanels(0, [load]);
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
