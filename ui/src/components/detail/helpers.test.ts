import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ageFromIso } from "./helpers";

describe("ageFromIso", () => {
  beforeEach(() => {
    // Pin "now" so the relative output is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns seconds for very recent timestamps", () => {
    expect(ageFromIso("2026-04-15T09:59:30.000Z")).toBe("30s");
    expect(ageFromIso("2026-04-15T10:00:00.000Z")).toBe("0s");
  });

  it("returns minutes / hours / days at the canonical boundaries", () => {
    expect(ageFromIso("2026-04-15T09:55:00.000Z")).toBe("5m");
    expect(ageFromIso("2026-04-15T07:00:00.000Z")).toBe("3h");
    expect(ageFromIso("2026-04-13T10:00:00.000Z")).toBe("2d");
  });

  it("clamps future timestamps to 0s instead of negative ages", () => {
    expect(ageFromIso("2026-04-15T11:00:00.000Z")).toBe("0s");
  });

  it("renders an em dash for unparseable input", () => {
    expect(ageFromIso("not-a-date")).toBe("—");
    expect(ageFromIso("")).toBe("—");
  });
});
