import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSaver } from "./saver";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

describe("createSaver", () => {
  it("debounces bursts into one write", async () => {
    const write = vi.fn(() => Promise.resolve());
    const s = createSaver(write, 250, () => {});
    s.schedule();
    s.schedule();
    s.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never overlaps writes; a change during a write triggers one more", async () => {
    const d = deferred();
    let active = 0;
    let maxActive = 0;
    const write = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (write.mock.calls.length === 1) await d.p;
      active--;
    });
    const s = createSaver(write, 10, () => {});
    s.schedule();
    await vi.advanceTimersByTimeAsync(10);
    s.schedule();
    s.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(write).toHaveBeenCalledTimes(1);
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("flush writes a pending change immediately and is a no-op when clean", async () => {
    const write = vi.fn(() => Promise.resolve());
    const s = createSaver(write, 10_000, () => {});
    await s.flush();
    expect(write).not.toHaveBeenCalled();
    s.schedule();
    await s.flush();
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports errors and keeps working", async () => {
    const onError = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
    const s = createSaver(write, 0, onError);
    s.schedule();
    await s.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    s.schedule();
    await s.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
