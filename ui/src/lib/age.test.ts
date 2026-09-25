import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { formatAge, msUntilAgeChanges, useAgeLabel } from "./age";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = new Date(T0).toISOString();

describe("formatAge", () => {
  it("buckets into s / m / h / d", () => {
    expect(formatAge(iso, T0 + 42_000)).toBe("42s");
    expect(formatAge(iso, T0 + 5 * 60_000 + 30_000)).toBe("5m");
    expect(formatAge(iso, T0 + 3 * 3_600_000)).toBe("3h");
    expect(formatAge(iso, T0 + 12 * 86_400_000)).toBe("12d");
    expect(formatAge(iso, T0 - 5_000)).toBe("0s");
    expect(formatAge(null, T0)).toBe("—");
    expect(formatAge("nope", T0)).toBe("—");
  });
});

describe("msUntilAgeChanges", () => {
  it("waits for the next boundary of the displayed unit", () => {
    expect(msUntilAgeChanges(iso, T0 + 42_300)).toBe(700);
    expect(msUntilAgeChanges(iso, T0 + 5 * 60_000 + 30_000)).toBe(30_000);
    expect(msUntilAgeChanges(iso, T0 + 3 * 3_600_000 + 1_000)).toBe(3_599_000);
    expect(msUntilAgeChanges(iso, T0 + 12 * 86_400_000)).toBe(86_400_000);
    expect(msUntilAgeChanges(undefined, T0)).toBeNull();
  });

  it("always lands on a changed label", () => {
    for (const age of [0, 999, 59_999, 60_000, 3_599_999, 86_399_999, 90_000_000]) {
      const before = formatAge(iso, T0 + age);
      const wait = msUntilAgeChanges(iso, T0 + age)!;
      expect(formatAge(iso, T0 + age + wait)).not.toBe(before);
      expect(formatAge(iso, T0 + age + wait - 1)).toBe(before);
    }
  });
});

describe("useAgeLabel", () => {
  afterEach(() => vi.useRealTimers());

  it("re-renders on label changes only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 59_000);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useAgeLabel(iso);
    });
    expect(result.current).toBe("59s");
    act(() => {
      vi.advanceTimersByTime(1_010);
    });
    expect(result.current).toBe("1m");
    const settled = renders;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(renders).toBe(settled);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe("2m");
  });
});
