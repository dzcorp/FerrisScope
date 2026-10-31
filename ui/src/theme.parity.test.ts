import { describe, it, expect } from "vitest";
import {
  THEMES,
  capacityBucket,
  capacityColor,
  completeTokens,
  consoleTokens,
  contrastRatio,
  getPalette,
  getTheme,
  resolveTheme,
  shade,
  tableFonts,
  titleBarTokens,
  volumeBucket,
  toHexColor,
  tokens,
  xtermTheme,
  type ThemeMode,
  type Tokens,
} from "./theme";

const MODES: ThemeMode[] = ["light", "dark"];

function everyPalette(): { label: string; t: Tokens }[] {
  return THEMES.flatMap((th) =>
    th.palettes.flatMap((p) =>
      MODES.map((m) => ({ label: `${th.id}/${p.id}/${m}`, t: completeTokens(p[m]) })),
    ),
  );
}

describe("palette parity", () => {
  it("every token of every palette is a colour the helpers can parse", () => {
    for (const { label, t } of everyPalette()) {
      for (const [k, v] of Object.entries(t)) {
        if (v === null || v === "transparent") continue;
        for (const c of Array.isArray(v) ? v : [v]) {
          expect(toHexColor(c as string), `${label}.${k} = ${String(c)}`).not.toBeNull();
        }
      }
    }
  });

  it("keeps text legible in every palette and mode", () => {
    for (const { label, t } of everyPalette()) {
      expect(contrastRatio(t.text, t.surface), `${label} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.textDim, t.surface), `${label} textDim`).toBeGreaterThanOrEqual(4);
      expect(contrastRatio(t.textMuted, t.surface), `${label} textMuted`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.consoleText, t.consoleBg), `${label} console`).toBeGreaterThanOrEqual(4);
      // Default dark's white-on-salmon is the design's call (2.42).
      expect(contrastRatio(t.onAccent, t.accent), `${label} onAccent`).toBeGreaterThanOrEqual(2.4);
    }
  });

  it("ships either no ANSI set or all 16 colours", () => {
    for (const { label, t } of everyPalette()) {
      if (t.ansi === null) continue;
      expect(t.ansi, label).toHaveLength(16);
      for (const c of t.ansi) expect(toHexColor(c), `${label} ansi ${c}`).not.toBeNull();
    }
  });

  it("palette ids are unique within a theme", () => {
    for (const th of THEMES) {
      const ids = th.palettes.map((p) => p.id);
      expect(new Set(ids).size, th.id).toBe(ids.length);
    }
  });
});

describe("upstream fidelity", () => {
  const tk = (themeId: string, paletteId: string, mode: ThemeMode) =>
    resolveTheme({ themeId, paletteId, mode }).tokens;

  it("VS Code Modern mirrors dark_modern / light_modern", () => {
    const d = tk("vscode", "modern", "dark");
    expect(d.surface).toBe("#1f1f1f");
    expect(d.rail).toBe("#181818");
    expect(d.accent).toBe("#0078d4");
    expect(d.input).toBe("#313131");
    const l = tk("vscode", "modern", "light");
    expect(l.surface).toBe("#ffffff");
    expect(l.accent).toBe("#005fb8");
    expect(l.railActive).toBe("#e8e8e8");
  });

  it("VS Code Dark+ uses the workbench registry defaults", () => {
    const d = tk("vscode", "dark-plus", "dark");
    expect(d.surface).toBe("#1e1e1e");
    expect(d.rail).toBe("#252526");
    expect(d.rowChecked).toBe("#04395e");
    expect(d.focus).toBe("#007fd4");
  });

  it("Monokai and Solarized carry their own neutrals and ANSI sets", () => {
    const m = tk("vscode", "monokai", "dark");
    expect(m.surface).toBe("#272822");
    expect(m.ansi?.[9]).toBe("#f92672");
    const s = tk("vscode", "solarized", "dark");
    expect(s.surface).toBe("#002b36");
    expect(s.ansi?.[4]).toBe("#268bd2");
    expect(tk("vscode", "solarized", "light").surface).toBe("#fdf6e3");
  });

  it("Lens follows Freelens: teal primary, solid active sidebar, black terminal", () => {
    const d = tk("lens", "lens", "dark");
    expect(d.accent).toBe("#00a7a0");
    expect(d.rail).toBe("#36393e");
    expect(d.railActive).toBe("#00a7a0");
    expect(d.railActiveText).toBe("#ffffff");
    expect(d.railIndicator).toBe("transparent");
    expect(d.rowSelectedBar).toBe("#00a7a0");
    expect(d.consoleBg).toBe("#000000");
    const ty = getTheme("lens").typography;
    expect(ty.fontSans.startsWith('"Roboto"')).toBe(true);
    expect(ty.table.headerCaps).toBe(false);
    expect(getTheme("lens").sizing.rowHeights.comfortable).toBe(33);
  });

  it("re-pointed accent palettes move every accent-linked role", () => {
    const c = tk("lens", "classic", "dark");
    expect(c.accent).toBe("#3d90ce");
    expect(c.railActive).toBe("#3d90ce");
    expect(c.rowSelectedBar).toBe("#3d90ce");
    expect(c.focus).toBe("#3d90ce");
    // Roles the base left derived follow the new accent too.
    const slate = tk("default", "slate", "light");
    expect(slate.railActiveText).toBe(slate.accent);
    expect(slate.rowChecked).toBe(slate.accentSoft);
  });
});

describe("completeTokens", () => {
  it("derives the Default look from the base set", () => {
    const base = getPalette(getTheme("default"), "default").dark;
    const t = completeTokens(base);
    expect(t.rowSelected).toBe(base.hover);
    expect(t.rowChecked).toBe(base.accentSoft);
    expect(t.railActive).toBe(base.accentSoft);
    expect(t.railActiveText).toBe(base.accent);
    expect(t.tableHeader).toBe(base.headerAlt);
    expect(t.tableHeaderText).toBe(base.textMuted);
    expect(t.input).toBe(base.surface);
    expect(t.inputBorder).toBe(base.border);
    expect(t.consoleBg).toBe(base.surfaceAlt);
    expect(t.rowSelectedBar).toBe("transparent");
    expect(t.ansi).toBeNull();
    expect(t.onAccent).toBe("#ffffff");
  });

  it("explicit roles win over derivation", () => {
    const t = completeTokens({ ...tokens("dark"), railActive: "#123456", onAccent: "#000000" });
    expect(t.railActive).toBe("#123456");
    expect(t.onAccent).toBe("#000000");
  });

  it("picks a dark ink when white fails 3:1 on a light accent", () => {
    const t = completeTokens({ ...tokens("dark"), accent: "#a6e22e", onAccent: undefined });
    expect(t.onAccent).toBe(tokens("dark").bg);
    const blue = completeTokens({ ...tokens("light"), accent: "#3b82f6", onAccent: undefined });
    expect(blue.onAccent).toBe("#ffffff");
  });
});

describe("resolveTheme cache", () => {
  it("returns one shared object for the same inputs", () => {
    const a = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark" });
    const b = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark", overrides: null });
    expect(a).toBe(b);
    expect(a.tokens).toBe(b.tokens);
  });

  it("separates mode, palette and override identity", () => {
    const base = { themeId: "vscode", paletteId: "modern" };
    const dark = resolveTheme({ ...base, mode: "dark" });
    expect(resolveTheme({ ...base, mode: "light" })).not.toBe(dark);
    expect(resolveTheme({ ...base, paletteId: "monokai", mode: "dark" })).not.toBe(dark);
    const o = { tokens: { accent: "#ff0000" } };
    const withO = resolveTheme({ ...base, mode: "dark", overrides: o });
    expect(withO.tokens.accent).toBe("#ff0000");
    expect(resolveTheme({ ...base, mode: "dark", overrides: o })).toBe(withO);
    expect(resolveTheme({ ...base, mode: "dark", overrides: { ...o } })).not.toBe(withO);
  });

  it("merges table typography and field height overrides field by field", () => {
    const r = resolveTheme({
      themeId: "default",
      paletteId: "default",
      mode: "dark",
      overrides: { typography: { table: { text: 15 } }, sizing: { fieldHeight: { md: 40 } } },
    });
    expect(r.typography.table.text).toBe(15);
    expect(r.typography.table.mono).toBe(11.5);
    expect(r.sizing.fieldHeight).toEqual({ sm: 26, md: 40 });
  });
});

describe("console surface", () => {
  it("folds consoleBg / consoleText into surfaceAlt / text", () => {
    const c = consoleTokens({ themeId: "lens", paletteId: "lens", mode: "light", darkConsole: true });
    expect(c.surfaceAlt).toBe("#000000");
    expect(c.text).toBe("#ffffff");
    const again = consoleTokens({ themeId: "lens", paletteId: "lens", mode: "light", darkConsole: true });
    expect(again).toBe(c);
  });

  it("xtermTheme passes the palette's ANSI set, or leaves xterm's defaults", () => {
    const lens = xtermTheme(
      consoleTokens({ themeId: "lens", paletteId: "lens", mode: "dark", darkConsole: true }),
    );
    expect(lens.background).toBe("#000000");
    expect(lens.red).toBe("#cc0000");
    expect(lens.brightWhite).toBe("#eeeeec");
    const def = xtermTheme(tokens("dark"));
    expect(def.red).toBeUndefined();
    expect(def.background).toBe(tokens("dark").surfaceAlt);
  });
});

describe("tableFonts", () => {
  it("builds canvas fonts from the theme's table typography", () => {
    const d = tableFonts(getTheme("default").typography);
    expect(d.text.startsWith("12px ")).toBe(true);
    expect(d.mono).toContain("JetBrains Mono");
    expect(d.header.startsWith("700 10px ")).toBe(true);
    expect(d.headerCaps).toBe(true);
    expect(d.pill).toBe(`500 11px ${getTheme("default").typography.fontSans}`);
    const v = tableFonts(getTheme("vscode").typography);
    expect(v.header.startsWith("600 12px -apple-system")).toBe(true);
    expect(v.headerCaps).toBe(false);
    expect(v.pill.startsWith("600 12px -apple-system")).toBe(true);
  });
});

describe("colour helpers", () => {
  it("contrastRatio spans 1..21", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("toHexColor keeps alpha and expands short hex", () => {
    expect(toHexColor("rgba(255,0,0,0.5)")).toBe("#ff000080");
    expect(toHexColor("rgb(0, 128, 255)")).toBe("#0080ff");
    expect(toHexColor("#abc")).toBe("#aabbcc");
    expect(toHexColor("#2aa19899")).toBe("#2aa19899");
    expect(toHexColor("transparent")).toBeNull();
  });
});

describe("chart parity", () => {
  const style = (id: string) => getTheme(id).chart;
  const tk = (themeId: string, paletteId: string, mode: ThemeMode) =>
    resolveTheme({ themeId, paletteId, mode }).tokens;

  it("Lens draws Freelens's stepped, filled, zero-based, striped 200px charts", () => {
    const c = style("lens");
    expect(c).toMatchObject({
      kind: "step",
      strokeWidth: 3,
      areaOpacity: 0.2,
      yFromZero: true,
      yTicks: 6,
      height: 200,
      stripes: true,
      gaugeColor: "series",
      gaugeCap: "butt",
    });
    const d = tk("lens", "lens", "dark");
    expect([d.chartCpu, d.chartMemory, d.chartDisk, d.chartNetRx, d.chartNetTx]).toEqual([
      "#00a7a0", "#c93dce", "#ffc63d", "#64c5d6", "#46cd9e",
    ]);
    expect(d.chartStripe).toBe("#ffffff08");
    expect(d.chartRingTrack).toBe("#30353a");
    expect(d.chartTooltip).toBe("rgba(0,0,0,0.8)");
    expect(tk("lens", "lens", "light").chartRingTrack).toBe("#efefef");
    expect(tk("lens", "classic", "dark").chartCpu).toBe("#3d90ce");
  });

  it("Default keeps its line charts and status-coloured gauges", () => {
    expect(style("default")).toMatchObject({ kind: "line", areaOpacity: 0, yTicks: 3, gaugeColor: "status" });
    const t = tk("default", "default", "dark");
    expect(t.chartCpu).toBe(t.accent);
    expect(t.chartMemory).toBe(t.good);
    expect(t.chartGrid).toBe(t.borderSoft);
  });

  it("VS Code takes the workbench charts.* colours", () => {
    const d = tk("vscode", "modern", "dark");
    expect(d.chartCpu).toBe("#59a4f9");
    expect(d.chartMemory).toBe("#89d185");
    expect(d.chartSeries).toEqual(["#59a4f9", "#89d185", "#cca700", "#d18616", "#f14c4c", "#b180d7"]);
    expect(d.chartGrid).toBe("rgba(204, 204, 204, 0.5)");
    expect(tk("vscode", "modern", "light").chartCpu).toBe("#0063d3");
    expect(tk("vscode", "high-contrast", "dark").chartDisk).toBe("#ffd370");
  });
});

describe("thresholds", () => {
  it("capacity follows the design's 65 / 80 %", () => {
    expect(capacityBucket(0.65)).toBe("good");
    expect(capacityBucket(0.66)).toBe("warn");
    expect(capacityBucket(0.81)).toBe("bad");
  });
  it("volume fill warns from 75 % and fails from 90 %", () => {
    expect(volumeBucket(0.74)).toBe("good");
    expect(volumeBucket(0.75)).toBe("warn");
    expect(volumeBucket(0.9)).toBe("bad");
  });
  it("capacityColor uses the usage series when the theme colours gauges by series", () => {
    const t = tokens("dark");
    expect(capacityColor(0.9, t, { gaugeColor: "status" })).toBe(t.bad);
    expect(capacityColor(0.9, t, { gaugeColor: "series" })).toBe(t.chartUsage);
  });
});

describe("shade / tooltip / bulk / title bar roles", () => {
  it("shade scales by the palette's shadow strength; High Contrast is flat", () => {
    expect(shade(tokens("dark"), 0.4)).toBe("rgba(0, 0, 0, 0.4)");
    expect(shade(tokens("light"), 0.12)).toBe("rgba(15, 20, 30, 0.12)");
    const hc = resolveTheme({ themeId: "vscode", paletteId: "high-contrast", mode: "dark" }).tokens;
    expect(shade(hc, 0.4)).toBe("rgba(0, 0, 0, 0)");
  });

  it("Default derives the tooltip and bulk bar exactly as before", () => {
    const d = tokens("dark");
    expect([d.tooltip, d.tooltipText, d.tooltipBorder]).toEqual([d.bulkBg, d.text, d.border]);
    const l = tokens("light");
    expect([l.tooltipText, l.tooltipBorder]).toEqual(["#f4f6f9", "rgba(255,255,255,0.06)"]);
    expect([d.bulkText, d.bulkDanger, d.bulkDangerHover]).toEqual(["#ffffff", "#f87171", "#fca5a5"]);
  });

  it("titleBarTokens is the identity unless the palette paints the drawer title", () => {
    const d = tokens("dark");
    expect(titleBarTokens(d)).toBe(d);
    const lens = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark" }).tokens;
    const ht = titleBarTokens(lens);
    expect(ht.surface).toBe("#00a7a0");
    expect(ht.text).toBe("#ffffff");
    expect(ht.textMuted).toBe("rgba(255, 255, 255, 0.7)");
    expect(titleBarTokens(lens)).toBe(ht);
  });
});

describe("label typography", () => {
  it("Helmsman caps mono, VS Code caps sans, Lens / Readable sentence case", () => {
    expect(getTheme("default").typography.label).toEqual({ caps: true, mono: true, tracking: 1, weight: null });
    expect(getTheme("vscode").typography.label).toMatchObject({ caps: true, mono: false });
    expect(getTheme("lens").typography.label).toMatchObject({ caps: false, mono: false, weight: 500 });
    expect(getTheme("readable").typography.label.caps).toBe(false);
  });
  it("VS Code medium weight is 600", () => {
    expect(getTheme("vscode").typography.weights.medium).toBe(600);
  });
});

describe("title bar accent", () => {
  it("inverts accent fills on a primary-coloured title bar", () => {
    const lens = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark" }).tokens;
    const ht = titleBarTokens(lens);
    expect(ht.accent).toBe("#ffffff");
    expect(ht.onAccent).toBe("#00a7a0");
  });
});

describe("ink and overlay roles", () => {
  it("onBad, knob and scrimSoft derive the previous literals", () => {
    const d = tokens("dark");
    expect(d.onBad).toBe("#ffffff");
    expect(d.knob).toBe("#ffffff");
    expect(d.scrimSoft).toBe("rgba(8,10,14,0.32)");
  });

  it("onBad switches to dark ink on a light error colour", () => {
    const t = completeTokens({ ...tokens("dark"), bad: "#ffb3b3", onBad: undefined });
    expect(t.onBad).toBe(tokens("dark").bg);
  });

  it("Lens reference series follow Freelens", () => {
    const d = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark" }).tokens;
    expect([d.chartRequests, d.chartLimits, d.chartCapacity, d.chartAllocatable]).toEqual([
      "#30b24d", "#4c545f", "#4c545f", "#032b4d",
    ]);
    expect([d.chartRingRequests, d.chartRingLimits]).toEqual(["#4caf50", "#00a7a0"]);
  });

  it("every theme rings its gauges, in its own colours", () => {
    for (const th of THEMES) expect(th.chart.gaugeRings, th.id).toBe(true);
    const def = tokens("dark");
    expect([def.chartRingRequests, def.chartRingLimits]).toEqual([def.info, def.textMuted]);
    const vs = resolveTheme({ themeId: "vscode", paletteId: "modern", mode: "dark" }).tokens;
    expect([vs.chartRingRequests, vs.chartRingLimits]).toEqual(["#59a4f9", "#b180d7"]);
    expect(getTheme("lens").chart).toMatchObject({ refDash: false, gaugeRings: true });
    expect(getTheme("default").chart).toMatchObject({ refDash: true, gaugeRings: true });
  });
});
