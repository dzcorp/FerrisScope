import { describe, it, expect } from "vitest";
import {
  clampUiScale,
  statusBucket,
  statusIsTransient,
  statusDot,
  statusFill,
  tokens,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from "./theme";

describe("clampUiScale", () => {
  it("returns default for non-finite input", () => {
    expect(clampUiScale(Number.NaN)).toBe(UI_SCALE_DEFAULT);
    expect(clampUiScale(Infinity)).toBe(UI_SCALE_DEFAULT);
    expect(clampUiScale(-Infinity)).toBe(UI_SCALE_DEFAULT);
  });
  it("clamps to bounds", () => {
    expect(clampUiScale(0.1)).toBe(UI_SCALE_MIN);
    expect(clampUiScale(99)).toBe(UI_SCALE_MAX);
  });
  it("snaps to nearest 0.05 step so the chip never drifts", () => {
    expect(clampUiScale(1.04999999)).toBeCloseTo(1.05, 5);
    expect(clampUiScale(1.234)).toBeCloseTo(1.25, 5);
    expect(clampUiScale(1.0)).toBeCloseTo(1.0, 5);
  });
});

describe("statusBucket — known buckets", () => {
  // Sample at least one canonical name from each bucket. The full
  // membership of each set lives in theme.ts; if a status moves bucket
  // (e.g. a phase becomes warn instead of bad) this test will catch it.
  it.each([
    ["Running", "good"],
    ["Ready", "good"],
    ["Active", "good"],
    ["Bound", "good"],
  ])("%s → good", (status, want) => {
    expect(statusBucket(status)).toBe(want);
  });

  it.each([
    ["Pending", "warn"],
    ["Progressing", "warn"],
    ["Updating", "warn"],
  ])("%s → warn", (status, want) => {
    expect(statusBucket(status)).toBe(want);
  });

  it.each([
    // Init / completion states are info — neither alarming nor steady.
    ["ContainerCreating", "info"],
    ["PodInitializing", "info"],
    ["Succeeded", "info"],
    ["Completed", "info"],
  ])("%s → info", (status, want) => {
    expect(statusBucket(status)).toBe(want);
  });

  it.each([
    ["CrashLoopBackOff", "bad"],
    ["ImagePullBackOff", "bad"],
    ["OOMKilled", "bad"],
    ["Evicted", "bad"],
    ["Failed", "bad"],
    ["NotReady", "bad"],
  ])("%s → bad", (status, want) => {
    expect(statusBucket(status)).toBe(want);
  });

  it("unknown statuses fall back to unknown", () => {
    expect(statusBucket("Mystery")).toBe("unknown");
    expect(statusBucket("")).toBe("unknown");
  });
});

describe("statusIsTransient", () => {
  it("flags pod-startup and termination phases", () => {
    expect(statusIsTransient("Pending")).toBe(true);
    expect(statusIsTransient("ContainerCreating")).toBe(true);
    expect(statusIsTransient("Init")).toBe(true);
    expect(statusIsTransient("Terminating")).toBe(true);
    expect(statusIsTransient("PodInitializing")).toBe(true);
  });
  it("steady states are NOT transient", () => {
    expect(statusIsTransient("Running")).toBe(false);
    expect(statusIsTransient("Failed")).toBe(false);
    expect(statusIsTransient("Succeeded")).toBe(false);
  });
});

describe("statusDot + statusFill use token colors", () => {
  const t = tokens("dark");
  it("dot color matches the bucket token", () => {
    expect(statusDot("Running", t)).toBe(t.good);
    expect(statusDot("Failed", t)).toBe(t.bad);
    expect(statusDot("Pending", t)).toBe(t.warn);
    expect(statusDot("Succeeded", t)).toBe(t.info);
    expect(statusDot("Mystery", t)).toBe(t.unknown);
  });

  it("fill returns dark-mode tints in dark", () => {
    const f = statusFill("Running", t, "dark");
    expect(f.bg).toMatch(/rgba\(/);
    expect(f.fg).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("fill returns light-mode tints in light", () => {
    const lt = tokens("light");
    const f = statusFill("Failed", lt, "light");
    expect(f.bg).toBe("#ffe4e6");
    expect(f.fg).toBe("#9f1239");
  });
});

describe("tokens(mode) — theme parity", () => {
  it("light + dark publish the same token shape", () => {
    const a = Object.keys(tokens("light")).sort();
    const b = Object.keys(tokens("dark")).sort();
    expect(a).toEqual(b);
  });
  it("status colors stay structural across modes", () => {
    // Per CLAUDE.md: status semantics are fixed and identical across themes.
    expect(tokens("light").good).toBe(tokens("dark").good);
    expect(tokens("light").warn).toBe(tokens("dark").warn);
    expect(tokens("light").bad).toBe(tokens("dark").bad);
    expect(tokens("light").info).toBe(tokens("dark").info);
  });
});
