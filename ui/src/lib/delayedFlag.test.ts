import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { LOADING_HINT_DELAY_MS, syncTracker, useDelayedFlag } from "./delayedFlag";

describe("useDelayedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flips only after the threshold while active", () => {
    const { result } = renderHook(() => useDelayedFlag(true));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(LOADING_HINT_DELAY_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("clears as soon as the work finishes and never fires after", () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 100), {
      initialProps: { on: true },
    });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it("a fast finish never shows the flag", () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 100), {
      initialProps: { on: true },
    });
    act(() => vi.advanceTimersByTime(50));
    rerender({ on: false });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(false);
  });
});

describe("syncTracker", () => {
  it("fires once, after the last pair finishes", () => {
    const onDone = vi.fn();
    const t = syncTracker(3, onDone);
    t.done(0);
    t.done(0);
    t.done(2);
    expect(onDone).not.toHaveBeenCalled();
    t.done(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    t.done(1);
    t.done(7);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("an empty fan is done immediately", () => {
    const onDone = vi.fn();
    syncTracker(0, onDone);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
