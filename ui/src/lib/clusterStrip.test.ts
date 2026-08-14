import { describe, expect, it } from "vitest";
import {
  chipWidthPx,
  fitStrip,
  healthCounts,
  overflowPillPx,
  populatedBuckets,
  rollupSummary,
  shouldShowRollup,
  type StripMember,
} from "./clusterStrip";

const m = (
  id: string,
  label = id,
  health: StripMember["health"] = "ok",
  removable = false,
): StripMember => ({ id, label, health, removable });

describe("fitStrip", () => {
  it("shows everything when it fits", () => {
    const members = [m("a", "prod-6"), m("b", "prod-7")];
    const fit = fitStrip(members, 1000);
    expect(fit.visible).toHaveLength(2);
    expect(fit.hidden).toHaveLength(0);
  });

  it("hides the tail and reports it when it does not fit", () => {
    const members = Array.from({ length: 20 }, (_, i) =>
      m(`c${i}`, `cluster-${i}`),
    );
    const fit = fitStrip(members, 400);
    expect(fit.visible.length).toBeGreaterThan(0);
    expect(fit.visible.length).toBeLessThan(20);
    expect(fit.visible.length + fit.hidden.length).toBe(20);
  });

  it("leaves room for the overflow pill rather than clipping the last chip", () => {
    const members = Array.from({ length: 8 }, (_, i) => m(`c${i}`, `abcdefgh`));
    const width = 400;
    const fit = fitStrip(members, width);
    const used =
      fit.visible.reduce((sum, x) => sum + chipWidthPx(x), 0) +
      6 * Math.max(0, fit.visible.length - 1) +
      6 +
      overflowPillPx(fit.hidden.length);
    expect(used).toBeLessThanOrEqual(width);
  });

  it("reserves width for the rollup", () => {
    const members = Array.from({ length: 10 }, (_, i) => m(`c${i}`, `node-${i}`));
    const without = fitStrip(members, 500).visible.length;
    const withRollup = fitStrip(members, 500, { rollupBuckets: 3 }).visible
      .length;
    expect(withRollup).toBeLessThanOrEqual(without);
  });

  it("always keeps at least one chip, however narrow", () => {
    const members = [m("a", "a-very-long-cluster-name-indeed"), m("b", "b")];
    const fit = fitStrip(members, 10);
    expect(fit.visible).toHaveLength(1);
    expect(fit.hidden).toHaveLength(1);
  });

  it("pins the focused member first and never hides it", () => {
    // A focus you cannot see is a trap: the table looks broken and the chip
    // that would clear it is off-screen.
    const members = Array.from({ length: 30 }, (_, i) =>
      m(`c${i}`, `cluster-${i}`),
    );
    const fit = fitStrip(members, 300, { pinnedId: "c29" });
    expect(fit.visible[0]!.id).toBe("c29");
    expect(fit.hidden.some((x) => x.id === "c29")).toBe(false);
  });

  it("ignores a pinned id that is not a member", () => {
    const members = [m("a"), m("b")];
    const fit = fitStrip(members, 1000, { pinnedId: "gone" });
    expect(fit.visible.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("handles an empty member list", () => {
    expect(fitStrip([], 500)).toEqual({ visible: [], hidden: [] });
  });

  it("counts a removable chip as wider", () => {
    expect(chipWidthPx(m("a", "same", "ok", true))).toBeGreaterThan(
      chipWidthPx(m("a", "same", "ok", false)),
    );
  });
});

describe("healthCounts / rollup", () => {
  const MIXED = [
    m("a", "a", "ok"),
    m("b", "b", "ok"),
    m("c", "c", "connecting"),
    m("d", "d", "bad"),
  ];

  it("buckets members by health", () => {
    expect(healthCounts(MIXED)).toEqual({ ok: 2, connecting: 1, bad: 1 });
  });

  it("counts only populated buckets", () => {
    expect(populatedBuckets(healthCounts(MIXED))).toBe(3);
    expect(populatedBuckets(healthCounts([m("a")]))).toBe(1);
    expect(populatedBuckets({ ok: 0, connecting: 0, bad: 0 })).toBe(0);
  });

  it("stays hidden when everything is healthy and nothing is hidden", () => {
    // Two green clusters need no summary — the chips already say it.
    expect(shouldShowRollup(healthCounts([m("a"), m("b")]), 0)).toBe(false);
  });

  it("shows once members are hidden", () => {
    expect(shouldShowRollup(healthCounts([m("a"), m("b")]), 3)).toBe(true);
  });

  it("shows when anything is unhealthy, even with nothing hidden", () => {
    expect(shouldShowRollup(healthCounts(MIXED), 0)).toBe(true);
  });

  it("summarises only the populated buckets", () => {
    expect(rollupSummary(healthCounts(MIXED))).toBe(
      "2 connected · 1 connecting · 1 unreachable",
    );
    expect(rollupSummary(healthCounts([m("a")]))).toBe("1 connected");
    expect(rollupSummary({ ok: 0, connecting: 0, bad: 0 })).toBe("");
  });
});
