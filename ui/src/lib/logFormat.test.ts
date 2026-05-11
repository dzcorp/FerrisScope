// `splitTimestamp` runs on every log line in the inline and full-overlay log
// panes. The RFC3339-nano prefix shape is fixed by the kube apiserver, but
// edge cases — invalid dates, no-fraction, slight format drift — are easy
// to regress when refactoring the regex.

import { describe, it, expect } from "vitest";
import { splitTimestamp } from "./logFormat";

describe("splitTimestamp", () => {
  it("splits a standard RFC3339Nano prefix into a local HH:MM:SS.mmm time", () => {
    // Build the prefix from a fixed UTC moment so the test is timezone-agnostic.
    // 2024-01-01T12:34:56.789012345Z → local hour depends on TZ; check shape +
    // the milliseconds (which is timezone-independent).
    const r = splitTimestamp("2024-01-01T12:34:56.789012345Z hello world");
    expect(r.ts).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(r.ts!.endsWith(".789")).toBe(true);
    expect(r.text).toBe("hello world");
  });

  it("tolerates no fractional seconds", () => {
    const r = splitTimestamp("2024-01-01T12:34:56Z body");
    expect(r.ts).toMatch(/^\d{2}:\d{2}:\d{2}\.000$/);
    expect(r.text).toBe("body");
  });

  it("non-timestamped line passes through with ts: null", () => {
    const r = splitTimestamp("no timestamp here");
    expect(r.ts).toBeNull();
    expect(r.text).toBe("no timestamp here");
  });

  it("invalid date in a well-formed prefix yields ts: null and preserves the original line", () => {
    // Month 99 — the regex matches the digit count but Date rejects it.
    const r = splitTimestamp("2024-99-01T12:34:56Z body");
    expect(r.ts).toBeNull();
    expect(r.text).toBe("2024-99-01T12:34:56Z body");
  });

  it("missing trailing space → not a prefix", () => {
    // Regex requires a literal space after the Z.
    const r = splitTimestamp("2024-01-01T12:34:56Zbody");
    expect(r.ts).toBeNull();
  });

  it("does not scan the entire long line (only the first ~40 chars)", () => {
    // A very long line without a prefix should fast-path return ts: null.
    const long = "x".repeat(10_000);
    const r = splitTimestamp(long);
    expect(r.ts).toBeNull();
    expect(r.text).toBe(long);
  });
});
