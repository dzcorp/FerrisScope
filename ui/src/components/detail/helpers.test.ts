import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ageFromIso, formatQuantity, parseQuantity } from "./helpers";

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

describe("parseQuantity", () => {
  it("parses bare numbers as base units", () => {
    expect(parseQuantity("1")).toBe(1);
    expect(parseQuantity("0.5")).toBe(0.5);
    expect(parseQuantity("-3")).toBe(-3);
  });

  it("parses binary suffixes against 1024", () => {
    expect(parseQuantity("1Ki")).toBe(1024);
    expect(parseQuantity("2Mi")).toBe(2 * 1024 * 1024);
    expect(parseQuantity("1Gi")).toBe(1024 ** 3);
  });

  it("parses decimal suffixes against 1000", () => {
    expect(parseQuantity("1k")).toBe(1000);
    expect(parseQuantity("1M")).toBe(1_000_000);
    expect(parseQuantity("250m")).toBe(0.25);
  });

  it("returns null on garbage", () => {
    expect(parseQuantity("eight gigs")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
  });
});

describe("formatQuantity", () => {
  it("scales memory to the most natural binary unit", () => {
    expect(formatQuantity("memory", "16384000Ki")).toBe("15.6Gi");
    expect(formatQuantity("memory", "1073741824")).toBe("1Gi");
    expect(formatQuantity("memory", "536870912")).toBe("512Mi");
    expect(formatQuantity("memory", "1024")).toBe("1Ki");
  });

  it("formats cpu in cores or millicores", () => {
    expect(formatQuantity("cpu", "8000m")).toBe("8");
    expect(formatQuantity("cpu", "8")).toBe("8");
    expect(formatQuantity("cpu", "1.5")).toBe("1.5");
    expect(formatQuantity("cpu", "250m")).toBe("250m");
  });

  it("recognises memory under dotted ResourceQuota keys", () => {
    expect(formatQuantity("requests.memory", "1073741824")).toBe("1Gi");
    expect(formatQuantity("limits.cpu", "4000m")).toBe("4");
  });

  it("treats hugepages-* and *-storage as bytes", () => {
    expect(formatQuantity("hugepages-2Mi", "10485760")).toBe("10Mi");
    expect(formatQuantity("ephemeral-storage", "5368709120")).toBe("5Gi");
    expect(formatQuantity("requests.ephemeral-storage", "5368709120")).toBe("5Gi");
  });

  it("passes unknown resource classes through unchanged", () => {
    expect(formatQuantity("pods", "110")).toBe("110");
    expect(formatQuantity("attachable-volumes-csi", "8")).toBe("8");
  });

  it("returns the original string when value can't be parsed", () => {
    expect(formatQuantity("memory", "lots")).toBe("lots");
  });

  it("returns an em dash for null", () => {
    expect(formatQuantity("memory", null)).toBe("—");
  });
});
