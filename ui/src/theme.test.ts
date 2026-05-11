import { describe, it, expect } from "vitest";
import {
  THEMES,
  clampUiScale,
  getPalette,
  getTheme,
  resolveTheme,
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

  it("fill bg derives from the bucket token in both modes", () => {
    const dark = statusFill("Running", t, "dark");
    const lt = tokens("light");
    const light = statusFill("Running", lt, "light");
    // Both modes emit rgba() bg with the palette's `good` channel.
    expect(dark.bg).toMatch(/^rgba\(16, ?185, ?129/);
    expect(light.bg).toMatch(/^rgba\(16, ?185, ?129/);
  });

  it("dark mode fg keeps the bucket color vivid; light mode darkens it", () => {
    const dark = statusFill("Failed", t, "dark");
    const lt = tokens("light");
    const light = statusFill("Failed", lt, "light");
    // Dark passes the bucket color through unchanged.
    expect(dark.fg).toBe(t.bad);
    // Light mixes toward black for contrast on the tinted pill.
    expect(light.fg).toMatch(/^rgb\(\d+, ?\d+, ?\d+\)$/);
    expect(light.fg).not.toBe(lt.bad);
  });

  it("a palette that re-tones a bucket flows through to the pill", () => {
    // VS Code's `bad` is #a1260d (darker red) in light mode — the pill bg
    // should reference *that*, not the Default's #f43f5e.
    const vscodeLight = {
      ...tokens("light"),
      bad: "#a1260d",
    };
    const f = statusFill("Failed", vscodeLight, "light");
    expect(f.bg).toMatch(/^rgba\(161, ?38, ?13/);
  });
});

describe("theme registry", () => {
  it("ships the four bundled themes in stable id order", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "default",
      "lens",
      "vscode",
      "readable",
    ]);
  });
  it("every theme has at least one palette and a valid defaultPaletteId", () => {
    for (const th of THEMES) {
      expect(th.palettes.length).toBeGreaterThan(0);
      expect(th.palettes.some((p) => p.id === th.defaultPaletteId)).toBe(true);
    }
  });
  it("getTheme falls back to Default for unknown ids", () => {
    expect(getTheme("nope").id).toBe("default");
  });
  it("getPalette falls back to the theme's default for unknown palette ids", () => {
    const t = getTheme("default");
    expect(getPalette(t, "nope").id).toBe(t.defaultPaletteId);
  });
});

describe("resolveTheme", () => {
  it("returns the active theme's tokens for the requested mode", () => {
    const r = resolveTheme({
      themeId: "default",
      paletteId: "default",
      mode: "dark",
    });
    expect(r.themeId).toBe("default");
    expect(r.paletteId).toBe("default");
    expect(r.mode).toBe("dark");
    expect(r.tokens.bg).toBe("#0d1014");
  });
  it("falls back to Default for an unknown theme id", () => {
    const r = resolveTheme({
      themeId: "nope",
      paletteId: "doesnt-matter",
      mode: "light",
    });
    expect(r.themeId).toBe("default");
    // Palette also falls back to Default's only palette.
    expect(r.paletteId).toBe("default");
  });
  it("typography differs across themes (the visible delta)", () => {
    const def = resolveTheme({
      themeId: "default",
      paletteId: "default",
      mode: "dark",
    });
    const readable = resolveTheme({
      themeId: "readable",
      paletteId: "warm",
      mode: "dark",
    });
    expect(readable.typography.base).toBeGreaterThan(def.typography.base);
    expect(readable.sizing.rowHeights.comfortable).toBeGreaterThan(
      def.sizing.rowHeights.comfortable,
    );
  });
  it("overrides win over the resolved theme + palette", () => {
    const r = resolveTheme({
      themeId: "default",
      paletteId: "default",
      mode: "dark",
      overrides: {
        tokens: { accent: "#ff00ff" },
        typography: { base: 18, scale: { md: 18 } },
        display: { showRailIcons: false },
      },
    });
    expect(r.tokens.accent).toBe("#ff00ff");
    expect(r.typography.base).toBe(18);
    expect(r.typography.scale.md).toBe(18);
    // Untouched scale steps survive the merge.
    expect(r.typography.scale.lg).toBe(14);
    expect(r.display.showRailIcons).toBe(false);
    expect(r.display.showDetailIcons).toBe(true);
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
