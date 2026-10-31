// Design tokens for ferrisscope. The Default theme is canonical and tied to
// `design/Helmsman v2/`. Lens / VS Code / Readable are intentional sibling
// themes. Lens and VS Code palettes are transcribed from the upstream sources
// (freelensapp/freelens `themes/lens-*.injectable.ts`, microsoft/vscode
// `extensions/theme-*` + the workbench colour registry defaults).

export const FONT_SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// CSS-var-backed values published by `lib/themeDom.ts`; the literal fallback is
// the Default theme's so anything rendered before App mounts stays sane.
export const FF_SANS = `var(--fs-font-sans, ${FONT_SANS})`;
export const FF_MONO = `var(--fs-font-mono, ${FONT_MONO})`;

//   xs → captions, kbd glyphs, eyebrow labels
//   sm → secondary labels
//   md → default body, controls
//   lg → section headers
//   xl → page titles / headlines
export const FS_XS = "var(--fs-fs-xs, 10px)";
export const FS_SM = "var(--fs-fs-sm, 11px)";
export const FS_MD = "var(--fs-fs-md, 12.5px)";
export const FS_LG = "var(--fs-fs-lg, 14px)";
export const FS_XL = "var(--fs-fs-xl, 16px)";

// `typography.weights`; VS Code maps medium to 600, Lens semibold to 500.
export const FW_NORMAL = "var(--fs-fw-normal, 400)";
export const FW_MEDIUM = "var(--fs-fw-medium, 500)";
export const FW_SEMIBOLD = "var(--fs-fw-semibold, 600)";
export const FW_BOLD = "var(--fs-fw-bold, 700)";

// Eyebrow labels (section titles, detail-row labels, tab captions):
// `typography.label` decides case, family and letter spacing.
export const LABEL_CASE = "var(--fs-label-case, uppercase)";
export const LABEL_FONT = `var(--fs-label-font, ${FF_MONO})`;
/// Label weight, unless the theme's `typography.label.weight` overrides it.
export function labelWeight(fallback: string): string {
  return `var(--fs-label-fw, ${fallback})`;
}
export function labelTracking(px: number): string {
  return `calc(var(--fs-label-ls, 1) * ${px}px)`;
}

// Resource-table cells and header (`typography.table`).
export const TABLE_FS_TEXT = "var(--fs-table-fs, 12px)";
export const TABLE_FS_MONO = "var(--fs-table-fs-mono, 11.5px)";

export const DETAIL_LAYOUT = {
  padding: "18px 22px 22px",
  sectionGap: 22,
  itemGap: 10,
  cardPadding: "12px 14px",
  cardMinWidth: 180,
  columns: "minmax(0, min(180px, 35%)) minmax(0, 1fr)",
} as const;

export const R_SM = "var(--fs-radius-sm, 4px)";
export const R_MD = "var(--fs-radius-md, 6px)";
export const R_LG = "var(--fs-radius-lg, 10px)";
// Pill / circle silhouettes stay round in every theme, so not a CSS var.
export const R_PILL = "999px";

export const CONTROL_H = "var(--fs-control-h, 28px)";
// Buttons, text inputs and select triggers (`sizing.fieldHeight`).
export const FIELD_H = "var(--fs-field-h, 32px)";
export const FIELD_H_SM = "var(--fs-field-h-sm, 26px)";
export const TAB_INDICATOR_W = "var(--fs-tab-indicator, 2px)";

export type ThemeMode = "light" | "dark";

// `uiScale` is the user-facing multiplier (1.0 = "100 %"); the zoom applied
// to the webview is `uiScale * UI_SCALE_BASELINE`.
export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1.0;
export const UI_SCALE_BASELINE = 1.1;

export function clampUiScale(v: number): number {
  if (!Number.isFinite(v)) return UI_SCALE_DEFAULT;
  if (v < UI_SCALE_MIN) return UI_SCALE_MIN;
  if (v > UI_SCALE_MAX) return UI_SCALE_MAX;
  return Math.round(v / UI_SCALE_STEP) * UI_SCALE_STEP;
}

// ── Color tokens ───────────────────────────────────────────────────────────

/// What every palette must spell out.
export type BaseTokens = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  header: string;
  headerAlt: string;
  border: string;
  borderSoft: string;
  text: string;
  textDim: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentHover: string;
  accentActive: string;
  chip: string;
  hover: string;
  btnHover: string;
  rail: string;
  railHover: string;
  scrim: string;
  paletteBg: string;
  paletteBorder: string;
  bulkBg: string;
  good: string;
  warn: string;
  /// Low-opacity wash of `warn` for warning surfaces.
  warnSoft: string;
  bad: string;
  info: string;
  unknown: string;
};

/// 16 ANSI colours: black red green yellow blue magenta cyan white, then the
/// bright variants in the same order.
export type AnsiColors = readonly string[];

/// Surface roles a palette may set explicitly; `completeTokens` derives the
/// rest from the base set, so the Default look is the derivation.
export type DerivedTokens = {
  /// Text / glyph colour on an `accent` fill.
  onAccent: string;
  /// Keyboard focus ring.
  focus: string;
  link: string;
  input: string;
  inputBorder: string;
  /// Row whose detail drawer is open.
  rowSelected: string;
  /// Multi-select checked row.
  rowChecked: string;
  /// Left-edge marker on the selected row; "transparent" for none.
  rowSelectedBar: string;
  tableHeader: string;
  tableHeaderText: string;
  railActive: string;
  railActiveText: string;
  /// Bar beside the active rail item; "transparent" for none.
  railIndicator: string;
  scrollThumb: string;
  scrollThumbHover: string;
  scrollThumbActive: string;
  /// Ink on a `bad` fill (destructive hover, error badges).
  onBad: string;
  /// Toggle thumb.
  knob: string;
  /// Light backdrop behind command-palette style overlays.
  scrimSoft: string;
  /// Floating hint surface.
  tooltip: string;
  tooltipText: string;
  tooltipBorder: string;
  /// Ink on `bulkBg` (bulk-action bar), and its destructive variant.
  bulkText: string;
  bulkDanger: string;
  bulkDangerHover: string;
  /// Elevation colour; its alpha scales every shadow (0 = flat, as in High
  /// Contrast). Components keep their geometry and call `shade(t, alpha)`.
  shadow: string;
  /// Detail drawer title bar (Lens paints it in the primary colour).
  drawerTitle: string;
  drawerTitleText: string;
  /// Detail-row field name / value.
  detailLabel: string;
  detailValue: string;
  /// Underlined tab strips.
  tabText: string;
  tabActiveText: string;
  tabIndicator: string;
  /// Dock (terminal / YAML / chat) tabs.
  dockTabActive: string;
  dockTabBorder: string;
  /// Metric series by meaning, so a theme can match its app's chart colours.
  chartCpu: string;
  chartMemory: string;
  chartNetRx: string;
  chartNetTx: string;
  chartDisk: string;
  /// Reference series on usage charts (kube-state-metrics / node status).
  chartRequests: string;
  chartLimits: string;
  chartCapacity: string;
  chartAllocatable: string;
  /// Inner rings of a multi-ring gauge (requests, limits).
  chartRingRequests: string;
  chartRingLimits: string;
  /// Categorical series (per device, per mount) in order.
  chartSeries: readonly string[];
  chartGrid: string;
  chartAxis: string;
  /// Unfilled part of gauges and usage bars.
  chartTrack: string;
  chartCrosshair: string;
  /// Alternate background band behind time charts; "transparent" for none.
  chartStripe: string;
  chartTooltip: string;
  chartTooltipText: string;
  chartTooltipMuted: string;
  chartTooltipBorder: string;
  /// Usage arc when gauges colour by series rather than status.
  chartUsage: string;
  /// Unfilled part of ring gauges.
  chartRingTrack: string;
  /// Log + terminal body.
  consoleBg: string;
  consoleText: string;
  /// `null` keeps xterm's built-in ANSI palette.
  ansi: AnsiColors | null;
};

export type Tokens = BaseTokens & DerivedTokens;
export type ColorTokens = Tokens;
export type PaletteTokens = BaseTokens & Partial<DerivedTokens>;

export function completeTokens(p: PaletteTokens): Tokens {
  const dark = isLightInk(p.text);
  const tooltip = p.tooltip ?? p.bulkBg;
  return {
    ...p,
    onAccent: p.onAccent ?? pickInk(p.accent, darkestOf(p.bg, p.text)),
    focus: p.focus ?? p.accent,
    link: p.link ?? p.accent,
    input: p.input ?? p.surface,
    inputBorder: p.inputBorder ?? p.border,
    rowSelected: p.rowSelected ?? p.hover,
    rowChecked: p.rowChecked ?? p.accentSoft,
    rowSelectedBar: p.rowSelectedBar ?? "transparent",
    tableHeader: p.tableHeader ?? p.headerAlt,
    tableHeaderText: p.tableHeaderText ?? p.textMuted,
    railActive: p.railActive ?? p.accentSoft,
    railActiveText: p.railActiveText ?? p.accent,
    railIndicator: p.railIndicator ?? p.accent,
    scrollThumb: p.scrollThumb ?? "rgba(127,127,127,0.28)",
    scrollThumbHover: p.scrollThumbHover ?? "rgba(127,127,127,0.45)",
    scrollThumbActive: p.scrollThumbActive ?? "rgba(127,127,127,0.65)",
    onBad: p.onBad ?? pickInk(p.bad, darkestOf(p.bg, p.text)),
    knob: p.knob ?? "#ffffff",
    scrimSoft: p.scrimSoft ?? "rgba(8,10,14,0.32)",
    tooltip,
    tooltipText: p.tooltipText ?? (dark ? p.text : "#f4f6f9"),
    tooltipBorder: p.tooltipBorder ?? (dark ? p.border : "rgba(255,255,255,0.06)"),
    bulkText: p.bulkText ?? pickInk(p.bulkBg, darkestOf(p.bg, p.text)),
    bulkDanger: p.bulkDanger ?? mixColors(p.bad, "#ffffff", 0.8),
    bulkDangerHover: p.bulkDangerHover ?? mixColors(p.bad, "#ffffff", 0.6),
    shadow: p.shadow ?? (dark ? "#000000" : "#0f141e"),
    drawerTitle: p.drawerTitle ?? p.surface,
    drawerTitleText: p.drawerTitleText ?? p.text,
    detailLabel: p.detailLabel ?? p.textMuted,
    detailValue: p.detailValue ?? p.text,
    tabText: p.tabText ?? p.textMuted,
    tabActiveText: p.tabActiveText ?? p.accent,
    tabIndicator: p.tabIndicator ?? p.accent,
    dockTabActive: p.dockTabActive ?? p.surface,
    dockTabBorder: p.dockTabBorder ?? p.borderSoft,
    chartCpu: p.chartCpu ?? p.accent,
    chartMemory: p.chartMemory ?? p.good,
    chartNetRx: p.chartNetRx ?? p.info,
    chartNetTx: p.chartNetTx ?? p.warn,
    chartDisk: p.chartDisk ?? p.accent,
    chartRequests: p.chartRequests ?? p.textDim,
    chartLimits: p.chartLimits ?? p.warn,
    chartCapacity: p.chartCapacity ?? p.textMuted,
    chartAllocatable: p.chartAllocatable ?? p.textDim,
    // Rings sit beside a status-coloured usage arc, so neither borrows a
    // status hue: requests in `info`, limits a neutral ceiling.
    chartRingRequests: p.chartRingRequests ?? p.info,
    chartRingLimits: p.chartRingLimits ?? p.textMuted,
    chartSeries: p.chartSeries ?? [p.accent, p.good, p.info, p.warn, p.bad],
    chartGrid: p.chartGrid ?? p.borderSoft,
    chartAxis: p.chartAxis ?? p.textMuted,
    chartTrack: p.chartTrack ?? p.borderSoft,
    chartCrosshair: p.chartCrosshair ?? p.textMuted,
    chartStripe: p.chartStripe ?? "transparent",
    chartTooltip: p.chartTooltip ?? p.surface,
    chartTooltipText: p.chartTooltipText ?? p.text,
    chartTooltipMuted: p.chartTooltipMuted ?? p.textMuted,
    chartTooltipBorder: p.chartTooltipBorder ?? p.border,
    chartUsage: p.chartUsage ?? p.accent,
    chartRingTrack: p.chartRingTrack ?? p.chartTrack ?? p.borderSoft,
    consoleBg: p.consoleBg ?? p.surfaceAlt,
    consoleText: p.consoleText ?? p.text,
    ansi: p.ansi ?? null,
  };
}

// ── Typography / Sizing / Display ──────────────────────────────────────────

export type Typography = {
  fontSans: string;
  fontMono: string;
  /// Body size in px; the UI Scale zoom multiplies on top.
  base: number;
  scale: { xs: number; sm: number; md: number; lg: number; xl: number };
  weights: { normal: number; medium: number; semibold: number; bold: number };
  /// Eyebrow labels: Helmsman's uppercase mono, VS Code's uppercase pane
  /// titles, or plain sentence case. `tracking` scales letter spacing.
  label: { caps: boolean; mono: boolean; tracking: number; weight: number | null };
  /// Resource tables: the densest surface, sized apart from the body scale.
  table: {
    text: number;
    mono: number;
    header: number;
    headerWeight: keyof Typography["weights"];
    headerCaps: boolean;
    headerMono: boolean;
  };
};

export type Sizing = {
  rowHeights: { compact: number; comfortable: number; spacious: number };
  controlHeight: number;
  fieldHeight: { sm: number; md: number };
  /// Active-tab underline thickness.
  tabIndicator: number;
  radius: { sm: number; md: number; lg: number };
  borderWidth: number;
};

export type ChartStyle = {
  /// Time series as a straight line or steps (Lens's touching bars).
  kind: "line" | "step";
  strokeWidth: number;
  /// Fill under the series, 0 for none.
  areaOpacity: number;
  /// Dash the interior gridlines.
  gridDash: boolean;
  /// Gridlines / y labels, top to bottom.
  yTicks: number;
  /// Anchor the y axis at 0 instead of fitting the data range.
  yFromZero: boolean;
  axisMono: boolean;
  axisSize: number;
  height: number;
  /// `chartStripe` bands, 10 samples wide, behind time charts.
  stripes: boolean;
  legendSwatch: "line" | "square";
  /// Draw request / limit / capacity series as dashed reference lines.
  refDash: boolean;
  gaugeCap: "round" | "butt";
  /// Usage, requests and limits as concentric rings where data allows.
  gaugeRings: boolean;
  /// Ring thickness as a share of the gauge diameter.
  gaugeRing: number;
  /// Colour gauges by capacity status or by the usage series.
  gaugeColor: "status" | "series";
};

export type Display = {
  showRailIcons: boolean;
  // Declarative for now: no table / detail-header surface renders kind icons.
  showTableIcons: boolean;
  showDetailIcons: boolean;
  /// Seeds `settings.monoTables` / `settings.density` on theme change.
  monoTablesDefault: boolean;
  densityDefault: "compact" | "comfortable" | "spacious";
};

export type Palette = {
  id: string;
  name: string;
  light: PaletteTokens;
  dark: PaletteTokens;
  /// Shown in Settings when a mode isn't upstream.
  note?: Partial<Record<ThemeMode, string>>;
};

export type Theme = {
  id: string;
  name: string;
  description: string;
  defaultPaletteId: string;
  palettes: Palette[];
  typography: Typography;
  sizing: Sizing;
  display: Display;
  chart: ChartStyle;
};

export type ThemeOverrides = {
  tokens?: Partial<ColorTokens>;
  typography?: Partial<Omit<Typography, "scale" | "weights" | "table" | "label">> & {
    label?: Partial<Typography["label"]>;
    scale?: Partial<Typography["scale"]>;
    weights?: Partial<Typography["weights"]>;
    table?: Partial<Typography["table"]>;
  };
  sizing?: Partial<Omit<Sizing, "rowHeights" | "radius" | "fieldHeight">> & {
    rowHeights?: Partial<Sizing["rowHeights"]>;
    radius?: Partial<Sizing["radius"]>;
    fieldHeight?: Partial<Sizing["fieldHeight"]>;
  };
  display?: Partial<Display>;
  chart?: Partial<ChartStyle>;
};

export type ResolvedTheme = {
  themeId: string;
  paletteId: string;
  mode: ThemeMode;
  tokens: ColorTokens;
  typography: Typography;
  sizing: Sizing;
  display: Display;
  chart: ChartStyle;
};

// Swap a palette's accent family, re-pointing any derived role the base set
// explicitly to its old accent.
function withAccent(
  base: PaletteTokens,
  a: Pick<BaseTokens, "accent" | "accentSoft" | "accentHover" | "accentActive"> &
    Partial<DerivedTokens>,
): PaletteTokens {
  const out: PaletteTokens = { ...base, ...a };
  const roles = [
    "focus",
    "link",
    "rowSelectedBar",
    "railActive",
    "railActiveText",
    "railIndicator",
    "chartCpu",
    "drawerTitle",
    "tabIndicator",
  ] as const;
  for (const k of roles) {
    if (a[k] === undefined && base[k] === base.accent) out[k] = a.accent;
  }
  return out;
}

// ── ANSI sets ───────────────────────────────────────────────────────────────

// microsoft/vscode terminalColorRegistry.ts defaults.
const ANSI_VSCODE_DARK: AnsiColors = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
];
const ANSI_VSCODE_LIGHT: AnsiColors = [
  "#000000", "#cd3131", "#107c10", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
  "#666666", "#f14c4c", "#14ce14", "#b5ba00", "#3b8eea", "#d670d6", "#29b8db", "#a5a5a5",
];
const ANSI_MONOKAI: AnsiColors = [
  "#333333", "#c4265e", "#86b42b", "#b3b42b", "#6a7ec8", "#8c6bc8", "#56adbc", "#e3e3dd",
  "#666666", "#f92672", "#a6e22e", "#e2e22e", "#819aff", "#ae81ff", "#66d9ef", "#f8f8f2",
];
const ANSI_SOLARIZED: AnsiColors = [
  "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
  "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
];
// freelens lens-dark / lens-light `terminalColors`.
const ANSI_FREELENS_DARK: AnsiColors = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];
const ANSI_FREELENS_LIGHT: AnsiColors = [
  "#2d2d2d", "#cd3734", "#18cf12", "#acb300", "#00a7a0", "#c100cd", "#07c4b9", "#d3d7cf",
  "#a8a8a8", "#ff6259", "#5cdb59", "#f8c000", "#008db6", "#ee55f8", "#50e8df", "#eeeeec",
];

// ── Default theme ──────────────────────────────────────────────────────────

const DEFAULT_LIGHT: PaletteTokens = {
  bg: "#f7f8fa",
  surface: "#ffffff",
  surfaceAlt: "#f7f8fa",
  header: "#ffffff",
  headerAlt: "#fafbfc",
  border: "#e3e6ec",
  borderSoft: "#eef0f4",
  text: "#11161d",
  textDim: "#525a68",
  textMuted: "#8a93a0",
  accent: "#ce422b",
  accentSoft: "#fbe1da",
  accentHover: "#b03722",
  accentActive: "#912c1a",
  chip: "#eef0f4",
  hover: "rgba(15,20,30,0.035)",
  btnHover: "#f4f6f9",
  rail: "#ffffff",
  railHover: "rgba(15,20,30,0.04)",
  scrim: "rgba(15,20,30,0.22)",
  paletteBg: "rgba(255,255,255,0.97)",
  paletteBorder: "#d6dae2",
  bulkBg: "#11161d",
  good: "#10b981",
  warn: "#f59e0b",
  warnSoft: "rgba(245,158,11,0.12)",
  bad: "#f43f5e",
  info: "#3b82f6",
  unknown: "#94a3b8",
};

const DEFAULT_DARK: PaletteTokens = {
  bg: "#0d1014",
  surface: "#161a20",
  surfaceAlt: "#11141a",
  header: "#11141a",
  headerAlt: "#191d24",
  border: "#23282f",
  borderSoft: "#1c2027",
  text: "#e8eaef",
  textDim: "#a0a6b0",
  textMuted: "#6c7280",
  accent: "#f08c6e",
  accentSoft: "rgba(240,140,110,0.16)",
  accentHover: "#d97a5d",
  accentActive: "#b9664c",
  chip: "#1d2128",
  hover: "rgba(255,255,255,0.04)",
  btnHover: "#1c2128",
  rail: "#11141a",
  railHover: "rgba(255,255,255,0.05)",
  scrim: "rgba(8,10,14,0.55)",
  paletteBg: "rgba(20,22,28,0.92)",
  paletteBorder: "#2a2d36",
  bulkBg: "#161a20",
  good: "#10b981",
  warn: "#f59e0b",
  warnSoft: "rgba(245,158,11,0.14)",
  bad: "#f43f5e",
  info: "#3b82f6",
  unknown: "#64748b",
};

const DEFAULT_PALETTE: Palette = {
  id: "default",
  name: "Default",
  // The design puts white on the accent in both modes.
  light: { ...DEFAULT_LIGHT, onAccent: "#ffffff", bulkDanger: "#f87171", bulkDangerHover: "#fca5a5" },
  dark: { ...DEFAULT_DARK, onAccent: "#ffffff", bulkDanger: "#f87171", bulkDangerHover: "#fca5a5" },
};

const DEFAULT_SLATE: Palette = {
  id: "slate",
  name: "Slate",
  light: withAccent(DEFAULT_LIGHT, {
    accent: "#3b82f6",
    accentSoft: "#dbeafe",
    accentHover: "#2563eb",
    accentActive: "#1d4ed8",
  }),
  dark: withAccent(DEFAULT_DARK, {
    accent: "#60a5fa",
    accentSoft: "rgba(96,165,250,0.18)",
    accentHover: "#3b82f6",
    accentActive: "#1d4ed8",
  }),
};

const DEFAULT_FOREST: Palette = {
  id: "forest",
  name: "Forest",
  light: withAccent(DEFAULT_LIGHT, {
    accent: "#16a34a",
    accentSoft: "#dcfce7",
    accentHover: "#15803d",
    accentActive: "#166534",
  }),
  dark: withAccent(DEFAULT_DARK, {
    accent: "#4ade80",
    accentSoft: "rgba(74,222,128,0.16)",
    accentHover: "#22c55e",
    accentActive: "#16a34a",
  }),
};

const DEFAULT_VIOLET: Palette = {
  id: "violet",
  name: "Violet",
  light: withAccent(DEFAULT_LIGHT, {
    accent: "#7c3aed",
    accentSoft: "#ede9fe",
    accentHover: "#6d28d9",
    accentActive: "#5b21b6",
  }),
  dark: withAccent(DEFAULT_DARK, {
    accent: "#a78bfa",
    accentSoft: "rgba(167,139,250,0.18)",
    accentHover: "#8b5cf6",
    accentActive: "#7c3aed",
  }),
};

const DEFAULT_THEME: Theme = {
  id: "default",
  name: "Default",
  description: "Helmsman: Inter, comfortable rows, soft borders.",
  defaultPaletteId: "default",
  palettes: [DEFAULT_PALETTE, DEFAULT_SLATE, DEFAULT_FOREST, DEFAULT_VIOLET],
  typography: {
    fontSans: FONT_SANS,
    fontMono: FONT_MONO,
    base: 12.5,
    scale: { xs: 10, sm: 11, md: 12.5, lg: 14, xl: 16 },
    weights: { normal: 400, medium: 500, semibold: 600, bold: 700 },
    label: { caps: true, mono: true, tracking: 1, weight: null },
    table: {
      text: 12,
      mono: 11.5,
      header: 10,
      headerWeight: "bold",
      headerCaps: true,
      headerMono: true,
    },
  },
  sizing: {
    rowHeights: { compact: 26, comfortable: 32, spacious: 40 },
    controlHeight: 28,
    fieldHeight: { sm: 26, md: 32 },
    tabIndicator: 2,
    radius: { sm: 4, md: 6, lg: 10 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: true,
    showDetailIcons: true,
    monoTablesDefault: true,
    densityDefault: "comfortable",
  },
  chart: {
    kind: "line",
    strokeWidth: 1.5,
    areaOpacity: 0,
    gridDash: true,
    yTicks: 3,
    yFromZero: false,
    axisMono: true,
    axisSize: 10,
    height: 130,
    stripes: false,
    legendSwatch: "line",
    refDash: true,
    gaugeCap: "round",
    gaugeRings: true,
    gaugeRing: 0.097,
    gaugeColor: "status",
  },
};

// ── Lens theme (Freelens) ──────────────────────────────────────────────────

// Freelens hard-codes series colours, identical in both modes; the tooltip is
// Chart.js's default.
const LENS_CHARTS: Partial<DerivedTokens> = {
  chartCpu: "#00a7a0",
  chartMemory: "#c93dce",
  chartNetRx: "#64c5d6",
  chartNetTx: "#46cd9e",
  chartDisk: "#ffc63d",
  chartSeries: ["#00a7a0", "#c93dce", "#ffc63d", "#64c5d6", "#46cd9e", "#30b24d", "#ff963d"],
  chartTooltip: "rgba(0,0,0,0.8)",
  chartTooltipText: "#ffffff",
  chartTooltipMuted: "rgba(255,255,255,0.7)",
  chartTooltipBorder: "transparent",
  chartUsage: "#c93dce",
  chartRequests: "#30b24d",
  chartAllocatable: "#032b4d",
  chartRingRequests: "#4caf50",
  chartRingLimits: "#00a7a0",
};

const LENS_DARK: PaletteTokens = {
  bg: "#1e2124", // mainBackground
  surface: "#262b2f", // contentColor
  surfaceAlt: "#1e2125", // secondaryBackground
  header: "#2e3136", // layoutBackground (top bar)
  headerAlt: "#262b2f", // tableHeaderBackground
  border: "#4c5053",
  borderSoft: "#373a3e", // borderFaintColor
  text: "#dcddde", // navHoverColor
  textDim: "#a0a0a0", // textColorSecondary
  textMuted: "#8e9297", // textColorPrimary
  accent: "#00a7a0",
  accentSoft: "rgba(0,167,160,0.18)",
  accentHover: "#00bdb5",
  accentActive: "#008f89",
  chip: "#36393e", // colorVague
  hover: "#383c42", // tableBgcSelected
  btnHover: "#3a3e44",
  rail: "#36393e", // sidebarBackground
  railHover: "#3a3e44", // sidebarItemHoverBackground
  scrim: "rgba(0,0,0,0.55)",
  paletteBg: "#262b2f",
  paletteBorder: "#4c5053",
  bulkBg: "#18191c", // tooltipBackground
  good: "#43a047",
  warn: "#ff9800",
  warnSoft: "rgba(255,152,0,0.14)",
  bad: "#ce3933",
  info: "#00a7a0",
  unknown: "#87909c",
  onAccent: "#ffffff",
  input: "#1e2125",
  inputBorder: "#414448",
  rowSelected: "#383c42",
  rowSelectedBar: "#00a7a0",
  tableHeaderText: "#ffffff",
  railActive: "#00a7a0",
  railActiveText: "#ffffff",
  railIndicator: "transparent",
  scrollThumb: "#5f6064",
  scrollThumbHover: "#6e7074",
  scrollThumbActive: "#87909c",
  tooltip: "#18191c", // tooltipBackground
  tooltipText: "#ffffff",
  tooltipBorder: "#373a3e",
  shadow: "#000000",
  ...LENS_CHARTS,
  drawerTitle: "#00a7a0", // drawer title: var(--blue)
  drawerTitleText: "#ffffff",
  detailLabel: "#87909c", // drawerItemNameColor
  detailValue: "#a0a0a0", // drawerItemValueColor
  tabText: "#8e9297",
  tabActiveText: "#ffffff", // layoutTabsActiveColor
  tabIndicator: "#00a7a0",
  dockTabActive: "#3a3e45",
  dockTabBorder: "#43424d",
  chartGrid: "#373a3e", // borderFaintColor
  chartAxis: "#8e9297", // textColorPrimary
  chartTrack: "#414448", // lineProgressBackground
  chartCrosshair: "#8e9297",
  chartStripe: "#ffffff08", // chartStripesColor
  chartRingTrack: "#30353a", // pieChartDefaultColor
  chartLimits: "#4c545f", // chartCapacityColor
  chartCapacity: "#4c545f",
  consoleBg: "#000000",
  consoleText: "#ffffff",
  ansi: ANSI_FREELENS_DARK,
};

const LENS_LIGHT: PaletteTokens = {
  bg: "#f1f1f1",
  surface: "#ffffff",
  surfaceAlt: "#f2f3f5",
  header: "#e8e8e8",
  headerAlt: "#f1f1f1",
  border: "#c9cfd3",
  borderSoft: "#dfdfdf",
  text: "#222222", // textColorAccent
  textDim: "#51575d",
  textMuted: "#727272", // drawerItemNameColor
  accent: "#00a7a0",
  accentSoft: "#d6f2f1",
  accentHover: "#00958f",
  accentActive: "#00827d",
  chip: "#ededed",
  hover: "#f4f5f5",
  btnHover: "#f0f2f5",
  rail: "#e8e8e8",
  railHover: "#f0f2f5",
  scrim: "rgba(0,0,0,0.25)",
  paletteBg: "#ffffff",
  paletteBorder: "#c9cfd3",
  bulkBg: "#36393e",
  good: "#206923",
  warn: "#ff9800",
  warnSoft: "rgba(255,152,0,0.14)",
  bad: "#ce3933",
  info: "#2d71a4",
  unknown: "#9dabb5",
  onAccent: "#ffffff",
  input: "#f6f6f7",
  inputBorder: "#cccdcf",
  rowSelected: "#eef0f1",
  rowSelectedBar: "#00a7a0",
  tableHeaderText: "#555555",
  railActive: "#00a7a0",
  railActiveText: "#ffffff",
  railIndicator: "transparent",
  scrollThumb: "#bbbbbb",
  scrollThumbHover: "#a8a8a8",
  scrollThumbActive: "#8d8d8d",
  tooltip: "#ffffff", // tooltipBackground
  tooltipText: "#222222",
  tooltipBorder: "#c9cfd3",
  shadow: "#000000",
  ...LENS_CHARTS,
  drawerTitle: "#00a7a0",
  drawerTitleText: "#ffffff",
  detailLabel: "#727272",
  detailValue: "#555555",
  tabText: "#555555",
  tabActiveText: "#333333",
  tabIndicator: "#00a7a0",
  dockTabActive: "#ffffff",
  dockTabBorder: "#d5d4de",
  chartGrid: "#dfdfdf",
  chartAxis: "#555555",
  chartTrack: "#e8e8e8",
  chartCrosshair: "#555555",
  chartStripe: "#00000009",
  chartRingTrack: "#efefef",
  chartLimits: "#cccccc",
  chartCapacity: "#cccccc",
  consoleBg: "#ffffff",
  consoleText: "#2d2d2d",
  ansi: ANSI_FREELENS_LIGHT,
};

// Upstream Lens before Freelens moved the primary to teal.
const LENS_CLASSIC: Palette = {
  id: "classic",
  name: "Lens classic",
  light: withAccent(LENS_LIGHT, {
    accent: "#3d90ce",
    accentSoft: "#dbeaf6",
    accentHover: "#3381bb",
    accentActive: "#2d71a4",
  }),
  dark: withAccent(
    { ...LENS_DARK, info: "#3d90ce" },
    {
      accent: "#3d90ce",
      accentSoft: "rgba(61,144,206,0.2)",
      accentHover: "#4f9dd6",
      accentActive: "#3381bb",
    },
  ),
};

const LENS_AMBER: Palette = {
  id: "amber",
  name: "Amber",
  light: withAccent(LENS_LIGHT, {
    accent: "#d97706",
    accentSoft: "#fef3c7",
    accentHover: "#b45309",
    accentActive: "#92400e",
  }),
  dark: withAccent(LENS_DARK, {
    accent: "#fbbf24",
    accentSoft: "rgba(251,191,36,0.18)",
    accentHover: "#f59e0b",
    accentActive: "#d97706",
    onAccent: "#1e2124",
    railActiveText: "#1e2124",
    drawerTitleText: "#1e2124",
  }),
};

const LENS_THEME: Theme = {
  id: "lens",
  name: "Lens",
  description: "Freelens: Roboto 14px, teal accent, 33px rows.",
  defaultPaletteId: "lens",
  palettes: [
    { id: "lens", name: "Freelens", light: LENS_LIGHT, dark: LENS_DARK },
    LENS_CLASSIC,
    LENS_AMBER,
  ],
  typography: {
    fontSans: '"Roboto", "Helvetica", "Arial", sans-serif',
    fontMono: '"Lucida Console", Monaco, Consolas, "DejaVu Sans Mono", monospace',
    base: 14,
    scale: { xs: 11, sm: 12, md: 14, lg: 16, xl: 18 },
    weights: { normal: 400, medium: 500, semibold: 500, bold: 700 },
    label: { caps: false, mono: false, tracking: 0, weight: 500 },
    table: {
      text: 14,
      mono: 13,
      header: 13,
      headerWeight: "medium",
      headerCaps: false,
      headerMono: false,
    },
  },
  sizing: {
    rowHeights: { compact: 28, comfortable: 33, spacious: 40 },
    controlHeight: 30,
    fieldHeight: { sm: 28, md: 32 },
    tabIndicator: 3,
    radius: { sm: 3, md: 3, lg: 4 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: true,
    showDetailIcons: true,
    monoTablesDefault: false,
    densityDefault: "comfortable",
  },
  // freelens chart/bar-chart.tsx: touching bars with a 3px top edge over a
  // 20 % fill, y from 0, up to 6 ticks, 200px; pies are 88 % doughnuts
  // coloured by series.
  chart: {
    kind: "step",
    strokeWidth: 3,
    areaOpacity: 0.2,
    gridDash: false,
    yTicks: 6,
    yFromZero: true,
    axisMono: false,
    axisSize: 11,
    height: 200,
    stripes: true,
    legendSwatch: "square",
    refDash: false,
    gaugeCap: "butt",
    gaugeRings: true,
    gaugeRing: 0.06,
    gaugeColor: "series",
  },
};

// ── VS Code theme ──────────────────────────────────────────────────────────

// microsoft/vscode chartsColors.ts: red/blue/yellow follow editorError /
// editorInfo / editorWarning, lines are the foreground at 50 %.
type VsChartKind = "dark" | "light" | "hcDark" | "hcLight";
const VS_CHARTS: Record<VsChartKind, Record<"red" | "blue" | "yellow" | "orange" | "green" | "purple", string>> = {
  dark: { red: "#f14c4c", blue: "#59a4f9", yellow: "#cca700", orange: "#d18616", green: "#89d185", purple: "#b180d7" },
  light: { red: "#e51400", blue: "#0063d3", yellow: "#bf8803", orange: "#d18616", green: "#388a34", purple: "#652d90" },
  hcDark: { red: "#f48771", blue: "#59a4f9", yellow: "#ffd370", orange: "#ab5a00", green: "#89d185", purple: "#b180d7" },
  hcLight: { red: "#b5200d", blue: "#0063d3", yellow: "#895503", orange: "#0f4a85", green: "#374e06", purple: "#652d90" },
};
function vscodeCharts(kind: VsChartKind, fg: string): Partial<DerivedTokens> {
  const c = VS_CHARTS[kind];
  return {
    chartCpu: c.blue,
    chartMemory: c.green,
    chartNetRx: c.purple,
    chartNetTx: c.orange,
    chartDisk: c.yellow,
    chartSeries: [c.blue, c.green, c.yellow, c.orange, c.red, c.purple],
    chartGrid: hexWithAlpha(fg, 0.5),
    chartAxis: fg,
    chartRingRequests: c.blue,
    chartRingLimits: c.purple,
    tabActiveText: fg,
  };
}

const VSCODE_DARK_MODERN: PaletteTokens = {
  bg: "#181818",
  surface: "#1f1f1f", // editor.background
  surfaceAlt: "#181818",
  header: "#181818", // titleBar
  headerAlt: "#181818",
  border: "#2b2b2b",
  borderSoft: "#262626",
  text: "#cccccc",
  textDim: "#9d9d9d",
  textMuted: "#868686",
  accent: "#0078d4",
  accentSoft: "rgba(0,120,212,0.2)",
  accentHover: "#026ec1",
  accentActive: "#005ba4",
  chip: "#2b2b2b",
  hover: "#2a2d2e",
  btnHover: "#2b2b2b",
  rail: "#181818",
  railHover: "#2a2d2e",
  scrim: "rgba(0,0,0,0.6)",
  paletteBg: "#222222", // quickInput
  paletteBorder: "#3c3c3c",
  bulkBg: "#252526",
  good: "#89d185",
  warn: "#cca700",
  warnSoft: "rgba(204,167,0,0.16)",
  bad: "#f85149",
  info: "#3794ff",
  unknown: "#858585",
  onAccent: "#ffffff",
  link: "#4daafc",
  input: "#313131",
  inputBorder: "#3c3c3c",
  rowSelected: "#37373d",
  rowChecked: "#04395e",
  tableHeaderText: "#cccccc",
  railActive: "#37373d",
  railActiveText: "#ffffff",
  scrollThumb: "rgba(121,121,121,0.4)",
  scrollThumbHover: "rgba(100,100,100,0.7)",
  scrollThumbActive: "rgba(191,191,191,0.4)",
  tooltip: "#202020", // editorHoverWidget
  tooltipText: "#cccccc",
  tooltipBorder: "#454545",
  shadow: "#000000",
  consoleBg: "#181818",
  consoleText: "#cccccc",
  ansi: ANSI_VSCODE_DARK,
  ...vscodeCharts("dark", "#cccccc"),
};

const VSCODE_LIGHT_MODERN: PaletteTokens = {
  bg: "#f8f8f8",
  surface: "#ffffff",
  surfaceAlt: "#f8f8f8",
  header: "#f8f8f8",
  headerAlt: "#f8f8f8",
  border: "#e5e5e5",
  borderSoft: "#eeeeee",
  text: "#3b3b3b",
  textDim: "#616161",
  textMuted: "#767676",
  accent: "#005fb8",
  accentSoft: "#dce9f6",
  accentHover: "#0258a8",
  accentActive: "#004e99",
  chip: "#e5e5e5",
  hover: "#f2f2f2",
  btnHover: "#ebebeb",
  rail: "#f8f8f8",
  railHover: "#f2f2f2",
  scrim: "rgba(0,0,0,0.25)",
  paletteBg: "#f8f8f8",
  paletteBorder: "#cecece",
  bulkBg: "#1f1f1f",
  good: "#388a34",
  warn: "#bf8803",
  warnSoft: "rgba(191,136,3,0.14)",
  bad: "#e51400",
  info: "#1a85ff",
  unknown: "#6e7681",
  onAccent: "#ffffff",
  input: "#ffffff",
  inputBorder: "#cecece",
  rowSelected: "#e8e8e8",
  tableHeaderText: "#3b3b3b",
  railActive: "#e8e8e8",
  railActiveText: "#000000",
  scrollThumb: "rgba(100,100,100,0.4)",
  scrollThumbHover: "rgba(100,100,100,0.7)",
  scrollThumbActive: "rgba(0,0,0,0.6)",
  tooltip: "#f8f8f8",
  tooltipText: "#3b3b3b",
  tooltipBorder: "#c8c8c8",
  shadow: "#000000",
  consoleBg: "#f8f8f8",
  consoleText: "#3b3b3b",
  ansi: ANSI_VSCODE_LIGHT,
  ...vscodeCharts("light", "#3b3b3b"),
};

const VSCODE_DARK_PLUS: PaletteTokens = {
  bg: "#1e1e1e",
  surface: "#1e1e1e",
  surfaceAlt: "#252526",
  header: "#3c3c3c", // titleBar
  headerAlt: "#252526",
  border: "#3c3c3c",
  borderSoft: "#2d2d2d",
  text: "#cccccc",
  textDim: "#9d9d9d",
  textMuted: "#858585",
  accent: "#007acc",
  accentSoft: "rgba(0,122,204,0.22)",
  accentHover: "#1177bb",
  accentActive: "#0e639c",
  chip: "#333333",
  hover: "#2a2d2e",
  btnHover: "#2a2d2e",
  rail: "#252526", // sideBar
  railHover: "#2a2d2e",
  scrim: "rgba(0,0,0,0.6)",
  paletteBg: "#252526",
  paletteBorder: "#454545",
  bulkBg: "#252526",
  good: "#89d185",
  warn: "#cca700",
  warnSoft: "rgba(204,167,0,0.16)",
  bad: "#f48771",
  info: "#75beff",
  unknown: "#858585",
  onAccent: "#ffffff",
  focus: "#007fd4",
  link: "#3794ff",
  input: "#3c3c3c",
  inputBorder: "#3c3c3c",
  rowSelected: "#37373d",
  rowChecked: "#04395e",
  tableHeaderText: "#cccccc",
  railActive: "#37373d",
  railActiveText: "#ffffff",
  railIndicator: "#ffffff", // activityBar.activeBorder
  scrollThumb: "rgba(121,121,121,0.4)",
  scrollThumbHover: "rgba(100,100,100,0.7)",
  scrollThumbActive: "rgba(191,191,191,0.4)",
  tooltip: "#252526",
  tooltipText: "#cccccc",
  tooltipBorder: "#454545",
  shadow: "#000000",
  consoleBg: "#1e1e1e",
  consoleText: "#cccccc",
  ansi: ANSI_VSCODE_DARK,
  ...vscodeCharts("dark", "#cccccc"),
};

const VSCODE_LIGHT_PLUS: PaletteTokens = {
  bg: "#ffffff",
  surface: "#ffffff",
  surfaceAlt: "#f3f3f3",
  header: "#dddddd", // titleBar
  headerAlt: "#f3f3f3",
  border: "#cecece",
  borderSoft: "#e7e7e7",
  text: "#383838",
  textDim: "#616161",
  textMuted: "#7a7a7a",
  accent: "#007acc",
  accentSoft: "#d6ebf8",
  accentHover: "#0062a3",
  accentActive: "#005a9e",
  chip: "#e8e8e8",
  hover: "#e8e8e8",
  btnHover: "#e8e8e8",
  rail: "#f3f3f3", // sideBar
  railHover: "#e8e8e8",
  scrim: "rgba(0,0,0,0.25)",
  paletteBg: "#f3f3f3",
  paletteBorder: "#c8c8c8",
  bulkBg: "#2c2c2c",
  good: "#388a34",
  warn: "#bf8803",
  warnSoft: "rgba(191,136,3,0.14)",
  bad: "#a1260d",
  info: "#1a85ff",
  unknown: "#6f6f6f",
  onAccent: "#ffffff",
  focus: "#0090f1",
  link: "#006ab1",
  input: "#ffffff",
  inputBorder: "#cecece",
  rowSelected: "#e4e6f1",
  tableHeaderText: "#616161",
  railActive: "#e4e6f1",
  railActiveText: "#1e1e1e",
  scrollThumb: "rgba(100,100,100,0.4)",
  scrollThumbHover: "rgba(100,100,100,0.7)",
  scrollThumbActive: "rgba(0,0,0,0.6)",
  tooltip: "#f3f3f3",
  tooltipText: "#616161",
  tooltipBorder: "#c8c8c8",
  shadow: "#000000",
  consoleBg: "#ffffff",
  consoleText: "#333333",
  ansi: ANSI_VSCODE_LIGHT,
  ...vscodeCharts("light", "#383838"),
};

const VSCODE_MONOKAI_DARK: PaletteTokens = {
  bg: "#1e1f1c",
  surface: "#272822",
  surfaceAlt: "#1e1f1c",
  header: "#1e1f1c",
  headerAlt: "#1e1f1c",
  border: "#414339",
  borderSoft: "#34352f",
  text: "#f8f8f2",
  textDim: "#cfcfc2",
  textMuted: "#90908a",
  accent: "#a6e22e",
  accentSoft: "rgba(166,226,46,0.16)",
  accentHover: "#b6ec4f",
  accentActive: "#8bc926",
  chip: "#34352f",
  hover: "#3e3d32",
  btnHover: "#3e3d32",
  rail: "#1e1f1c",
  railHover: "#3e3d32",
  scrim: "rgba(0,0,0,0.6)",
  paletteBg: "#1e1f1c",
  paletteBorder: "#414339",
  bulkBg: "#414339",
  good: "#86b42b",
  warn: "#e6db74",
  warnSoft: "rgba(230,219,116,0.14)",
  bad: "#f92672",
  info: "#66d9ef",
  unknown: "#75715e",
  focus: "#99947c",
  link: "#66d9ef",
  input: "#414339",
  inputBorder: "#414339",
  rowSelected: "#414339",
  rowChecked: "#49483e",
  tableHeaderText: "#cfcfc2",
  railActive: "#49483e",
  railActiveText: "#f8f8f2",
  tooltip: "#414339", // editorHoverWidget
  tooltipText: "#f8f8f2",
  tooltipBorder: "#75715e",
  shadow: "#000000",
  consoleBg: "#1e1f1c",
  consoleText: "#f8f8f2",
  ansi: ANSI_MONOKAI,
  ...vscodeCharts("dark", "#f8f8f2"),
};

const VSCODE_SOLARIZED_DARK: PaletteTokens = {
  bg: "#00212b",
  surface: "#002b36",
  surfaceAlt: "#00212b",
  header: "#002c39",
  headerAlt: "#00212b",
  border: "#1f4a55",
  borderSoft: "#073642",
  text: "#93a1a1",
  textDim: "#839496",
  textMuted: "#6c8186",
  accent: "#2aa198",
  accentSoft: "rgba(42,161,152,0.18)",
  accentHover: "#35b5ab",
  accentActive: "#22867e",
  chip: "#073642",
  hover: "#003c4a",
  btnHover: "#003c4a",
  rail: "#00212b",
  railHover: "#003c4a",
  scrim: "rgba(0,0,0,0.55)",
  paletteBg: "#00212b",
  paletteBorder: "#2a7b78",
  bulkBg: "#073642",
  good: "#859900",
  warn: "#b58900",
  warnSoft: "rgba(181,137,0,0.16)",
  bad: "#dc322f",
  info: "#268bd2",
  unknown: "#586e75",
  focus: "#2a7b78",
  link: "#268bd2",
  input: "#003847",
  inputBorder: "#0b4f5e",
  rowSelected: "#003a48",
  rowChecked: "#005a6f",
  tableHeaderText: "#93a1a1",
  railActive: "#005a6f",
  railActiveText: "#eee8d5",
  tooltip: "#004052", // editorHoverWidget
  tooltipText: "#93a1a1",
  tooltipBorder: "#2a7b78",
  shadow: "#000000",
  consoleBg: "#002b36",
  consoleText: "#93a1a1",
  ansi: ANSI_SOLARIZED,
  ...vscodeCharts("dark", "#93a1a1"),
};

const VSCODE_SOLARIZED_LIGHT: PaletteTokens = {
  bg: "#eee8d5",
  surface: "#fdf6e3",
  surfaceAlt: "#eee8d5",
  header: "#eee8d5",
  headerAlt: "#eee8d5",
  border: "#ddd6c1",
  borderSoft: "#e8e1cc",
  text: "#586e75",
  textDim: "#657b83",
  textMuted: "#7f8f91",
  accent: "#b58900",
  accentSoft: "#f1e4b8",
  accentHover: "#9c7600",
  accentActive: "#7f6000",
  chip: "#e8e1cc",
  hover: "#f6ebc8",
  btnHover: "#e9e2cc",
  rail: "#eee8d5",
  railHover: "#e4dcc5",
  scrim: "rgba(0,43,54,0.2)",
  paletteBg: "#eee8d5",
  paletteBorder: "#d3af86",
  bulkBg: "#073642",
  good: "#859900",
  warn: "#b58900",
  warnSoft: "rgba(181,137,0,0.14)",
  bad: "#dc322f",
  info: "#268bd2",
  unknown: "#93a1a1",
  focus: "#b49471",
  link: "#268bd2",
  input: "#ddd6c1",
  inputBorder: "#d3af86",
  rowSelected: "#e8dfc4",
  rowChecked: "#dfca88",
  tableHeaderText: "#586e75",
  railActive: "#dfca88",
  railActiveText: "#073642",
  tooltip: "#eee8d5",
  tooltipText: "#586e75",
  tooltipBorder: "#d3af86",
  shadow: "#002b36",
  consoleBg: "#fdf6e3",
  consoleText: "#657b83",
  ansi: ANSI_SOLARIZED,
  ...vscodeCharts("light", "#586e75"),
};

const VSCODE_HC_DARK: PaletteTokens = {
  bg: "#000000",
  surface: "#000000",
  surfaceAlt: "#000000",
  header: "#000000",
  headerAlt: "#000000",
  border: "#6fc3df", // contrastBorder
  borderSoft: "#4c4c4c",
  text: "#ffffff",
  textDim: "#d0d0d0",
  textMuted: "#b3b3b3",
  accent: "#f38518", // activeContrastBorder
  accentSoft: "rgba(243,133,24,0.22)",
  accentHover: "#ff9a33",
  accentActive: "#d9730f",
  chip: "#1f1f1f",
  hover: "#1a1a1a",
  btnHover: "#1a1a1a",
  rail: "#000000",
  railHover: "#1a1a1a",
  scrim: "rgba(0,0,0,0.75)",
  paletteBg: "#0c0c0c",
  paletteBorder: "#6fc3df",
  bulkBg: "#0c0c0c",
  good: "#89d185",
  warn: "#ffcc00",
  warnSoft: "rgba(255,204,0,0.16)",
  bad: "#f48771",
  info: "#21a6ff",
  unknown: "#b3b3b3",
  link: "#21a6ff",
  input: "#000000",
  inputBorder: "#6fc3df",
  rowSelected: "#141414",
  rowSelectedBar: "#f38518",
  tableHeaderText: "#ffffff",
  railActive: "#1a1a1a",
  railActiveText: "#ffffff",
  scrollThumb: "rgba(111,195,223,0.6)",
  scrollThumbHover: "rgba(111,195,223,0.8)",
  scrollThumbActive: "#6fc3df",
  tooltip: "#000000",
  tooltipText: "#ffffff",
  tooltipBorder: "#6fc3df",
  shadow: "rgba(0,0,0,0)",
  consoleBg: "#000000",
  consoleText: "#ffffff",
  ansi: ANSI_VSCODE_DARK,
  ...vscodeCharts("hcDark", "#ffffff"),
};

const VSCODE_HC_LIGHT: PaletteTokens = {
  bg: "#ffffff",
  surface: "#ffffff",
  surfaceAlt: "#ffffff",
  header: "#ffffff",
  headerAlt: "#ffffff",
  border: "#0f4a85",
  borderSoft: "#b5c4d6",
  text: "#292929",
  textDim: "#3d3d3d",
  textMuted: "#5c5c5c",
  accent: "#0f4a85",
  accentSoft: "rgba(15,74,133,0.1)",
  accentHover: "#0b3a6b",
  accentActive: "#082b50",
  chip: "#eef2f7",
  hover: "#e7edf3",
  btnHover: "#e7edf3",
  rail: "#ffffff",
  railHover: "#e7edf3",
  scrim: "rgba(0,0,0,0.35)",
  paletteBg: "#ffffff",
  paletteBorder: "#0f4a85",
  bulkBg: "#292929",
  good: "#2d7d27",
  warn: "#895503",
  warnSoft: "rgba(137,85,3,0.12)",
  bad: "#b5200d",
  info: "#0f4a85",
  unknown: "#5c5c5c",
  focus: "#006bbd",
  input: "#ffffff",
  inputBorder: "#0f4a85",
  rowSelected: "#e7edf3",
  rowSelectedBar: "#0f4a85",
  tableHeaderText: "#292929",
  railActive: "#e7edf3",
  scrollThumb: "rgba(15,74,133,0.4)",
  scrollThumbHover: "rgba(15,74,133,0.6)",
  scrollThumbActive: "#0f4a85",
  tooltip: "#ffffff",
  tooltipText: "#292929",
  tooltipBorder: "#0f4a85",
  shadow: "rgba(0,0,0,0)",
  consoleBg: "#ffffff",
  consoleText: "#292929",
  ansi: ANSI_VSCODE_LIGHT,
  ...vscodeCharts("hcLight", "#292929"),
};

const VSCODE_THEME: Theme = {
  id: "vscode",
  name: "VS Code",
  description: "Workbench look: system UI 13px, 22px lists, square controls.",
  defaultPaletteId: "modern",
  palettes: [
    { id: "modern", name: "Modern", light: VSCODE_LIGHT_MODERN, dark: VSCODE_DARK_MODERN },
    { id: "dark-plus", name: "Dark+ / Light+", light: VSCODE_LIGHT_PLUS, dark: VSCODE_DARK_PLUS },
    {
      id: "monokai",
      name: "Monokai",
      note: { light: "Monokai ships dark only; light mode is Light Modern with Monokai's pink." },
      light: withAccent(VSCODE_LIGHT_MODERN, {
        accent: "#c4265e",
        accentSoft: "#fbe3ec",
        accentHover: "#a61f4f",
        accentActive: "#8a1a42",
      }),
      dark: VSCODE_MONOKAI_DARK,
    },
    { id: "solarized", name: "Solarized", light: VSCODE_SOLARIZED_LIGHT, dark: VSCODE_SOLARIZED_DARK },
    { id: "high-contrast", name: "High Contrast", light: VSCODE_HC_LIGHT, dark: VSCODE_HC_DARK },
  ],
  typography: {
    fontSans:
      '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif',
    fontMono:
      'Consolas, Menlo, Monaco, "Droid Sans Mono", "DejaVu Sans Mono", "Courier New", monospace',
    base: 13,
    scale: { xs: 11, sm: 12, md: 13, lg: 13, xl: 14 },
    // Segoe UI has no 500; VS Code's emphasis is 600.
    weights: { normal: 400, medium: 600, semibold: 600, bold: 700 },
    label: { caps: true, mono: false, tracking: 0.3, weight: null },
    table: {
      text: 13,
      mono: 12.5,
      header: 12,
      headerWeight: "semibold",
      headerCaps: false,
      headerMono: false,
    },
  },
  sizing: {
    rowHeights: { compact: 22, comfortable: 26, spacious: 30 },
    controlHeight: 24,
    fieldHeight: { sm: 22, md: 26 },
    tabIndicator: 1,
    radius: { sm: 2, md: 2, lg: 6 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: false,
    showDetailIcons: true,
    monoTablesDefault: false,
    densityDefault: "compact",
  },
  // VS Code ships no metric charts; this follows its `charts.*` colours and
  // flat widget styling.
  chart: {
    kind: "line",
    strokeWidth: 1.5,
    areaOpacity: 0,
    gridDash: false,
    yTicks: 3,
    yFromZero: false,
    axisMono: false,
    axisSize: 11,
    height: 130,
    stripes: false,
    legendSwatch: "square",
    refDash: true,
    gaugeCap: "butt",
    gaugeRings: true,
    gaugeRing: 0.08,
    gaugeColor: "status",
  },
};

// ── Readable theme ─────────────────────────────────────────────────────────

const READABLE_LIGHT: PaletteTokens = {
  bg: "#fbfaf7",
  surface: "#ffffff",
  surfaceAlt: "#f6f4ef",
  header: "#ffffff",
  headerAlt: "#f8f6f1",
  border: "#d8d3c7",
  borderSoft: "#ece8df",
  text: "#1c1a17",
  textDim: "#5b5750",
  textMuted: "#8c887f",
  accent: "#a14d2a",
  accentSoft: "#f3dcd0",
  accentHover: "#874021",
  accentActive: "#6b321a",
  chip: "#ece8df",
  hover: "rgba(28,26,23,0.04)",
  btnHover: "#f0ece4",
  rail: "#ffffff",
  railHover: "rgba(28,26,23,0.05)",
  scrim: "rgba(28,26,23,0.22)",
  paletteBg: "rgba(255,255,255,0.97)",
  paletteBorder: "#d8d3c7",
  bulkBg: "#1c1a17",
  good: "#15803d",
  warn: "#b45309",
  warnSoft: "rgba(180,83,9,0.12)",
  bad: "#b91c1c",
  info: "#1d4ed8",
  unknown: "#78716c",
};

const READABLE_DARK: PaletteTokens = {
  bg: "#181613",
  surface: "#22201c",
  surfaceAlt: "#1c1a17",
  header: "#1c1a17",
  headerAlt: "#262320",
  border: "#3a3631",
  borderSoft: "#2d2a26",
  text: "#f0ede6",
  textDim: "#b3afa6",
  textMuted: "#807c73",
  accent: "#e8a07a",
  accentSoft: "rgba(232,160,122,0.18)",
  accentHover: "#d18c66",
  accentActive: "#a87050",
  chip: "#2d2a26",
  hover: "rgba(255,255,255,0.04)",
  btnHover: "#2a2724",
  rail: "#1c1a17",
  railHover: "rgba(255,255,255,0.05)",
  scrim: "rgba(0,0,0,0.55)",
  paletteBg: "rgba(34,32,28,0.95)",
  paletteBorder: "#3a3631",
  bulkBg: "#22201c",
  good: "#4ade80",
  warn: "#fbbf24",
  warnSoft: "rgba(251,191,36,0.16)",
  bad: "#fb7185",
  info: "#60a5fa",
  unknown: "#a8a29e",
};

const READABLE_COOL: Palette = {
  id: "cool",
  name: "Cool",
  light: withAccent(READABLE_LIGHT, {
    accent: "#1e6091",
    accentSoft: "#d6e4f0",
    accentHover: "#194e76",
    accentActive: "#143d5b",
  }),
  dark: withAccent(READABLE_DARK, {
    accent: "#7ab8d8",
    accentSoft: "rgba(122,184,216,0.18)",
    accentHover: "#5fa3c9",
    accentActive: "#3e85ad",
  }),
};

const READABLE_SEPIA: Palette = {
  id: "sepia",
  name: "Sepia",
  light: withAccent(READABLE_LIGHT, {
    accent: "#7a5d3a",
    accentSoft: "#f0e6d2",
    accentHover: "#5f482c",
    accentActive: "#46361f",
  }),
  dark: withAccent(READABLE_DARK, {
    accent: "#d4b896",
    accentSoft: "rgba(212,184,150,0.18)",
    accentHover: "#b89a76",
    accentActive: "#967c5d",
  }),
};

const READABLE_THEME: Theme = {
  id: "readable",
  name: "Readable",
  description: "Larger type everywhere, tables included; spacious rows.",
  defaultPaletteId: "warm",
  palettes: [
    { id: "warm", name: "Warm", light: READABLE_LIGHT, dark: READABLE_DARK },
    READABLE_COOL,
    READABLE_SEPIA,
  ],
  typography: {
    fontSans: FONT_SANS,
    fontMono: FONT_MONO,
    base: 14,
    scale: { xs: 11, sm: 12.5, md: 14, lg: 16, xl: 19 },
    weights: { normal: 400, medium: 500, semibold: 600, bold: 700 },
    label: { caps: false, mono: false, tracking: 0, weight: 600 },
    table: {
      text: 14,
      mono: 13.5,
      header: 12.5,
      headerWeight: "semibold",
      headerCaps: false,
      headerMono: false,
    },
  },
  sizing: {
    rowHeights: { compact: 30, comfortable: 38, spacious: 46 },
    controlHeight: 32,
    fieldHeight: { sm: 30, md: 36 },
    tabIndicator: 2,
    radius: { sm: 6, md: 8, lg: 12 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: true,
    showDetailIcons: true,
    monoTablesDefault: false,
    densityDefault: "spacious",
  },
  chart: {
    kind: "line",
    strokeWidth: 2,
    areaOpacity: 0.1,
    gridDash: true,
    yTicks: 3,
    yFromZero: false,
    axisMono: false,
    axisSize: 12,
    height: 150,
    stripes: false,
    legendSwatch: "line",
    refDash: true,
    gaugeCap: "round",
    gaugeRings: true,
    gaugeRing: 0.11,
    gaugeColor: "status",
  },
};

// ── Registry ───────────────────────────────────────────────────────────────

export const THEMES: readonly Theme[] = [
  DEFAULT_THEME,
  LENS_THEME,
  VSCODE_THEME,
  READABLE_THEME,
];

export const DEFAULT_THEME_ID = DEFAULT_THEME.id;
export const DEFAULT_PALETTE_ID = DEFAULT_THEME.defaultPaletteId;

export function getTheme(themeId: string): Theme {
  return THEMES.find((t) => t.id === themeId) ?? DEFAULT_THEME;
}

export function getPalette(theme: Theme, paletteId: string): Palette {
  return (
    theme.palettes.find((p) => p.id === paletteId) ??
    theme.palettes.find((p) => p.id === theme.defaultPaletteId) ??
    theme.palettes[0]!
  );
}

// ── Resolver ───────────────────────────────────────────────────────────────

// Every consumer of the same (theme, palette, mode, overrides) gets the same
// object, so children memoised on `t` survive renders across components.
const NO_OVERRIDES: ThemeOverrides = {};
const resolveCache = new WeakMap<ThemeOverrides, Map<string, ResolvedTheme>>();

export function resolveTheme(opts: {
  themeId: string;
  paletteId: string;
  mode: ThemeMode;
  overrides?: ThemeOverrides | null;
}): ResolvedTheme {
  const o = opts.overrides ?? NO_OVERRIDES;
  const key = `${opts.themeId}\u0000${opts.paletteId}\u0000${opts.mode}`;
  let byKey = resolveCache.get(o);
  if (!byKey) {
    byKey = new Map();
    resolveCache.set(o, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;

  const theme = getTheme(opts.themeId);
  const palette = getPalette(theme, opts.paletteId);
  const base = opts.mode === "dark" ? palette.dark : palette.light;
  const tokens: ColorTokens = { ...completeTokens(base), ...(o.tokens ?? {}) };
  const typography: Typography = {
    ...theme.typography,
    ...(o.typography ?? {}),
    scale: { ...theme.typography.scale, ...(o.typography?.scale ?? {}) },
    weights: { ...theme.typography.weights, ...(o.typography?.weights ?? {}) },
    table: { ...theme.typography.table, ...(o.typography?.table ?? {}) },
    label: { ...theme.typography.label, ...(o.typography?.label ?? {}) },
  };
  const sizing: Sizing = {
    ...theme.sizing,
    ...(o.sizing ?? {}),
    rowHeights: { ...theme.sizing.rowHeights, ...(o.sizing?.rowHeights ?? {}) },
    radius: { ...theme.sizing.radius, ...(o.sizing?.radius ?? {}) },
    fieldHeight: { ...theme.sizing.fieldHeight, ...(o.sizing?.fieldHeight ?? {}) },
  };
  const display: Display = { ...theme.display, ...(o.display ?? {}) };
  const chart: ChartStyle = { ...theme.chart, ...(o.chart ?? {}) };
  const resolved: ResolvedTheme = {
    themeId: theme.id,
    paletteId: palette.id,
    mode: opts.mode,
    tokens,
    typography,
    sizing,
    display,
    chart,
  };
  byKey.set(key, resolved);
  return resolved;
}

// ── Console (logs + terminal) surface ───────────────────────────────────────
// With `darkConsole` on, the console resolves the active theme's dark palette
// even in light mode. Its body is `consoleBg` / `consoleText`, folded into
// `surfaceAlt` / `text` so log views keep reading the usual token names.
const consoleCache = new WeakMap<ColorTokens, ColorTokens>();

export function consoleTokens(opts: {
  themeId: string;
  paletteId: string;
  mode: ThemeMode;
  overrides?: ThemeOverrides | null;
  darkConsole: boolean;
}): ColorTokens {
  const mode: ThemeMode = opts.darkConsole ? "dark" : opts.mode;
  const t = resolveTheme({
    themeId: opts.themeId,
    paletteId: opts.paletteId,
    mode,
    overrides: opts.overrides,
  }).tokens;
  let c = consoleCache.get(t);
  if (!c) {
    c = { ...t, surfaceAlt: t.consoleBg, text: t.consoleText };
    consoleCache.set(t, c);
  }
  return c;
}

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/// xterm `ITheme` for a console token set. Without `ansi` the 16 colours are
/// left out so xterm keeps its own defaults.
export function xtermTheme(t: Tokens): Record<string, string> {
  const out: Record<string, string> = {
    background: t.surfaceAlt,
    foreground: t.text,
    cursor: t.good,
    // xterm's default selection is translucent white: invisible on a light
    // console, so derive the veil from the text colour.
    selectionBackground: hexWithAlpha(t.text, 0.3),
    selectionInactiveBackground: hexWithAlpha(t.text, 0.18),
  };
  if (t.ansi) ANSI_KEYS.forEach((k, i) => {
    const c = t.ansi?.[i];
    if (c) out[k] = c;
  });
  return out;
}

/// Canvas-measurement font strings matching what the resource table renders.
export type TableFonts = {
  text: string;
  mono: string;
  header: string;
  headerCaps: boolean;
  /// Dense StatusPill label.
  pill: string;
};

export function tableFonts(ty: Typography): TableFonts {
  const tb = ty.table;
  return {
    text: `${tb.text}px ${ty.fontSans}`,
    mono: `${tb.mono}px ${ty.fontMono}`,
    header: `${ty.weights[tb.headerWeight]} ${tb.header}px ${tb.headerMono ? ty.fontMono : ty.fontSans}`,
    headerCaps: tb.headerCaps,
    pill: `${ty.weights.medium} ${ty.scale.sm}px ${ty.fontSans}`,
  };
}

// Legacy shim: the Default theme's palette. New code reads `useResolvedTheme()`.
const LIGHT: Tokens = completeTokens(DEFAULT_PALETTE.light);
const DARK: Tokens = completeTokens(DEFAULT_PALETTE.dark);

export const tokens = (mode: ThemeMode): Tokens =>
  mode === "dark" ? DARK : LIGHT;


// ── Status mapping ─────────────────────────────────────────────────────────
// Status semantics are theme-invariant. Buckets and the transient set are
// defined here once; palettes recolor the buckets but never redefine them.

export type StatusBucket = "good" | "warn" | "bad" | "info" | "unknown";

const GOOD = new Set([
  "Running",
  "Normal",
  "Ready",
  "Active",
  "Available",
  "Bound",
  "healthy",
  "Healthy",
  "Synced",
  // Helm release statuses (lowercase, hyphenated).
  "deployed",
]);
const WARN = new Set([
  "Pending",
  "Warning",
  "warning",
  "degraded",
  "Updating",
  "Progressing",
  "OutOfSync",
  "Missing",
  "Reconciling",
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
  "uninstalling",
  // Cluster-level, not object-level: a connection being rebuilt after the
  // health probe declared the apiserver gone.
  "Reconnecting",
  // HPA pinned at min/max replicas.
  "Limited",
]);
const INFO = new Set([
  // HPA mid-rescale (current != desired).
  "Scaling",
  "ContainerCreating",
  "PodInitializing",
  "Init",
  "Succeeded",
  "Completed",
  "Suspended",
  "Static",
  "superseded",
  "uninstalled",
]);
const BAD = new Set([
  "CrashLoopBackOff",
  "Error",
  "Failed",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "RunContainerError",
  "OOMKilled",
  "Evicted",
  "NotReady",
  "Degraded",
  "Stalled",
  "Unhealthy",
  // HPA can't compute a recommendation (metrics unavailable).
  "Inactive",
  "Unavailable",
  "DeadlineExceeded",
  "ContainerCannotRun",
  "Terminated",
  "failed",
]);
// Transient: render with a pulsing dot until the state resolves. Per the
// design's `statusIsTransient`, plus the container-level waiting reasons we
// see while pods are coming up.
const TRANSIENT = new Set([
  "ContainerCreating",
  "PodInitializing",
  "Init",
  "Pending",
  "Terminating",
  "Updating",
  "Progressing",
  "Reconciling",
  "Scaling",
  "Waiting",
  "PodScheduled",
  "ContainerStarting",
  "Reconnecting",
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
  "uninstalling",
]);

export function statusBucket(status: string): StatusBucket {
  if (GOOD.has(status)) return "good";
  if (BAD.has(status)) return "bad";
  if (INFO.has(status)) return "info";
  if (WARN.has(status)) return "warn";
  if (status === "Terminating" || status === "Waiting") return "unknown";
  return "unknown";
}

export function statusIsTransient(status: string): boolean {
  return TRANSIENT.has(status);
}

// Common states whose color alone says enough in dense views: the Pods table
// and compact labels show only the bar / container dots, no text.
const AMBIENT = new Set(["Running", "Terminating", "Succeeded"]);

export function statusIsAmbient(status: string): boolean {
  return AMBIENT.has(status);
}

// Hex color for the status dot — used by StatusPill, container dots, etc.
export function statusDot(status: string, t: Tokens): string {
  switch (statusBucket(status)) {
    case "good":
      return t.good;
    case "warn":
      return t.warn;
    case "bad":
      return t.bad;
    case "info":
      return t.info;
    case "unknown":
      return t.unknown;
  }
}

// Bucket for a `ready / desired` ratio (replicas, partition progress, …).
// Kept here so every surface that renders "x / y" uses the same rules:
// all-ready+non-zero → good, none-ready → bad, partial → warn, no signal
// (desired === 0, ready unknown) → good (nothing to do).
export type ReadyDesiredBucket = "good" | "warn" | "bad";
export function readyDesiredBucket(
  ready: number | undefined,
  desired: number,
): ReadyDesiredBucket {
  if (ready === undefined) return "good";
  if (ready === 0 && desired > 0) return "bad";
  if (ready === desired && desired > 0) return "good";
  return "warn";
}
export function readyDesiredColor(
  ready: number | undefined,
  desired: number,
  t: Tokens,
): string {
  switch (readyDesiredBucket(ready, desired)) {
    case "good":
      return t.good;
    case "warn":
      return t.warn;
    case "bad":
      return t.bad;
  }
}

// Usage against a request: amber from 70%, red from 90%. `null` when nothing
// was requested — there is no ratio to judge.
export const USAGE_WARN_RATIO = 0.7;
export const USAGE_BAD_RATIO = 0.9;
export function usageBucket(
  used: number,
  requested: number | null | undefined,
): ReadyDesiredBucket | null {
  if (requested == null || !(requested > 0)) return null;
  const r = used / requested;
  return r >= USAGE_BAD_RATIO ? "bad" : r >= USAGE_WARN_RATIO ? "warn" : "good";
}

/// Capacity utilisation (cluster / node gauges): amber past 65 %, red past 80 %
/// (design/helmsman-v2.jsx).
export const CAPACITY_WARN_RATIO = 0.65;
export const CAPACITY_BAD_RATIO = 0.8;
export function capacityBucket(ratio: number): ReadyDesiredBucket {
  return ratio > CAPACITY_BAD_RATIO ? "bad" : ratio > CAPACITY_WARN_RATIO ? "warn" : "good";
}

/// Volume fill: amber from 75 %, red from 90 %.
export const VOLUME_WARN_RATIO = 0.75;
export const VOLUME_BAD_RATIO = 0.9;
export function volumeBucket(ratio: number): ReadyDesiredBucket {
  return ratio >= VOLUME_BAD_RATIO ? "bad" : ratio >= VOLUME_WARN_RATIO ? "warn" : "good";
}

/// Gauge arc colour: capacity status, or the usage series where the theme
/// colours gauges by series (Lens).
export function capacityColor(
  ratio: number,
  t: Pick<Tokens, "good" | "warn" | "bad" | "chartUsage">,
  chart: Pick<ChartStyle, "gaugeColor">,
): string {
  return chart.gaugeColor === "series" ? t.chartUsage : bucketColor(capacityBucket(ratio), t);
}

export function bucketColor(b: ReadyDesiredBucket, t: Pick<Tokens, "good" | "warn" | "bad">): string {
  return b === "bad" ? t.bad : b === "warn" ? t.warn : t.good;
}

/// Share of the status hue in the usage text; the rest is `textDim`, so a
/// table of numbers reads as a quiet signal rather than a wall of colour.
export const USAGE_TINT = 0.55;
const usageToneCache = new Map<string, string>();
export function usageColor(
  used: number,
  requested: number | null | undefined,
  t: Tokens,
): string {
  const b = usageBucket(used, requested);
  if (!b) return t.textDim;
  const hue = b === "bad" ? t.bad : b === "warn" ? t.warn : t.good;
  const key = `${hue}|${t.textDim}`;
  let c = usageToneCache.get(key);
  if (c === undefined) {
    c = mixColors(hue, t.textDim, USAGE_TINT);
    usageToneCache.set(key, c);
  }
  return c;
}

// Soft tinted background + legible foreground for an arbitrary accent/status
// color. `bg` is the color at low alpha; `fg` is the raw color in dark mode
// (already vivid on a dark surface) and a darkened mix in light mode — the
// raw hue over its own pale tint loses contrast, amber being the worst case.
// The port-forward chip builds on this so it stays legible across all
// palettes and both modes.
export function tintPair(
  color: string,
  dark: boolean,
): { bg: string; fg: string } {
  return {
    bg: hexWithAlpha(color, dark ? 0.16 : 0.14),
    fg: dark ? color : mixWithBlack(color, 0.55),
  };
}

/// Tokens for content on the drawer title bar: the same set unless the
/// palette paints the bar (Lens), where ink and hovers follow its text.
const titleBarCache = new WeakMap<Tokens, Tokens>();
export function titleBarTokens(t: Tokens): Tokens {
  if (t.drawerTitle === t.surface) return t;
  let v = titleBarCache.get(t);
  if (!v) {
    const ink = t.drawerTitleText;
    v = {
      ...t,
      text: ink,
      textDim: hexWithAlpha(ink, 0.85),
      textMuted: hexWithAlpha(ink, 0.7),
      detailLabel: hexWithAlpha(ink, 0.7),
      border: hexWithAlpha(ink, 0.35),
      borderSoft: hexWithAlpha(ink, 0.2),
      hover: hexWithAlpha(ink, 0.12),
      btnHover: hexWithAlpha(ink, 0.16),
      chip: hexWithAlpha(ink, 0.16),
      surface: t.drawerTitle,
      // Accent fills would vanish into a primary-coloured bar.
      accent: ink,
      accentSoft: hexWithAlpha(ink, 0.18),
      accentHover: hexWithAlpha(ink, 0.9),
      accentActive: hexWithAlpha(ink, 0.8),
      onAccent: t.drawerTitle,
    };
    titleBarCache.set(t, v);
  }
  return v;
}

/// Shadow colour at `alpha`, scaled by the palette's shadow strength.
const shadeCache = new Map<string, string>();
export function shade(t: Pick<Tokens, "shadow">, alpha: number): string {
  const key = `${t.shadow}|${alpha}`;
  let v = shadeCache.get(key);
  if (v === undefined) {
    const c = parseColor(t.shadow);
    v = c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${+(alpha * c.a).toFixed(3)})` : t.shadow;
    if (shadeCache.size > 512) shadeCache.clear();
    shadeCache.set(key, v);
  }
  return v;
}

// Whether a token set is a dark-mode palette. Components that only receive
// `Tokens` (not the active `mode`) use this to pick the legible variant of a
// tint — light text on a dark surface means a dark theme. Robust across every
// palette since text must contrast its own background.
export function tokensAreDark(t: Pick<Tokens, "text">): boolean {
  return isLightInk(t.text);
}

// Rec. 601 luma > 0.5: light text, so a dark palette.
function isLightInk(text: string): boolean {
  const rgb = toRgb(text);
  if (!rgb) return true;
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.5;
}

/// Append an alpha channel to a hex / rgb-ish color. Tolerates `#rrggbb`,
/// `#rgb`, and `rgb(...)` / `rgba(...)` inputs. Falls back to the input
/// itself if the shape is unfamiliar (palette authors can paste anything
/// reasonable and the pill stays usable). Exported so per-component
/// glows / shadows can ride the active palette instead of hardcoding an
/// `${t.warn}33` string-concat that breaks for non-hex palettes.
export function hexWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const rgb = toRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}

// macOS vibrancy: opacity applied to chrome surfaces (header, rail) so the
// NSVisualEffectView material behind the transparent webview shows through.
// Mode-dependent because the trade differs. Dark chrome stays legible quite
// translucent. Light/white chrome muddies and loses text contrast if pushed too
// far, so light keeps a *subtle* frost (mostly white) — enough to read as
// vibrant and give the inactive traffic lights some backdrop, without dropping
// to an obvious gray. The window appearance follows the theme (App.tsx) so the
// light material stays light. Tunable knobs; lives here, not inline in
// components, per the no-hardcoded-alpha rule. Lower light → more frost / more
// button contrast / less white; raise → whiter / fainter buttons.
export const MAC_VIBRANCY_ALPHA_DARK = 0.5;
export const MAC_VIBRANCY_ALPHA_LIGHT = 0.7;

export function vibrancyAlpha(mode: ThemeMode): number {
  return mode === "dark" ? MAC_VIBRANCY_ALPHA_DARK : MAC_VIBRANCY_ALPHA_LIGHT;
}

// Translucent variant of a chrome surface colour for macOS vibrancy.
export function vibrantSurface(color: string, mode: ThemeMode): string {
  return hexWithAlpha(color, vibrancyAlpha(mode));
}

// The vibrancy material sits behind the window, not behind the webview's own
// content, so a translucent surface floating over <main> shows the table
// through it instead of frost. Overlays stay opaque.
export function chromeSurface(
  color: string,
  mode: ThemeMode,
  opts: { isMac: boolean; overContent: boolean },
): string {
  return opts.isMac && !opts.overContent ? vibrantSurface(color, mode) : color;
}

/// Mix a color toward black by `amount` (0 = original, 1 = black). Used
/// for the light-mode pill foreground so the bucket color stays vivid on
/// dark themes but darkens on light ones for contrast.
function mixWithBlack(color: string, amount: number): string {
  const a = Math.max(0, Math.min(1, amount));
  const rgb = toRgb(color);
  if (!rgb) return color;
  const m = (c: number) => Math.round(c * (1 - a));
  return `rgb(${m(rgb.r)}, ${m(rgb.g)}, ${m(rgb.b)})`;
}

/// `amount` of `a` over `b` (1 = `a`). Falls back to `a` on unparseable input.
function mixColors(a: string, b: string, amount: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  if (!x || !y) return a;
  const k = Math.max(0, Math.min(1, amount));
  const m = (p: number, q: number) => Math.round(p * k + q * (1 - k));
  return `rgb(${m(x.r, y.r)}, ${m(x.g, y.g)}, ${m(x.b, y.b)})`;
}

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(color: string): Rgba | null {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = [0, 2, 4, 6].map((i) => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) : 255));
    if (n.some((v) => Number.isNaN(v))) return null;
    return { r: n[0]!, g: n[1]!, b: n[2]!, a: n[3]! / 255 };
  }
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (m && m[1] && m[2] && m[3])
    return {
      r: parseInt(m[1], 10),
      g: parseInt(m[2], 10),
      b: parseInt(m[3], 10),
      a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(m[4]))),
    };
  return null;
}

function toRgb(color: string): { r: number; g: number; b: number } | null {
  return parseColor(color);
}

/// `#rrggbb` / `#rrggbbaa` — for consumers (Monaco) that reject `rgba()`.
export function toHexColor(color: string): string | null {
  const c = parseColor(color);
  if (!c) return null;
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ""}`;
}

/// WCAG 2 relative luminance; alpha is ignored.
export function relativeLuminance(color: string): number {
  const c = parseColor(color);
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function darkestOf(a: string, b: string): string {
  return relativeLuminance(a) <= relativeLuminance(b) ? a : b;
}

/// White on `fill` unless it drops under the 3:1 UI-component floor and
/// `dark` reads better.
function pickInk(fill: string, dark: string): string {
  const white = contrastRatio("#ffffff", fill);
  return white >= 3 || white >= contrastRatio(dark, fill) ? "#ffffff" : dark;
}

// ── Cluster identity accents ────────────────────────────────────────────────
// Deterministic per-cluster colors for multi-cluster (virtual context) views:
// the dot in the merged table's Cluster column, member chips in the cluster
// bar, detail-panel headers. Eight mid-saturation hues legible on both the
// light and dark neutrals above, deliberately distinct from each other at a
// glance. Assignment is by position in the SORTED member list (see
// `clusterColorIndexMap` in lib/multiCluster.ts) so a cluster keeps its color
// regardless of selection order; >8 members wrap around.
export const CLUSTER_ACCENTS: readonly string[] = [
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#d946ef", // fuchsia
  "#84cc16", // lime
  "#6366f1", // indigo
  "#ec4899", // pink
];

export function clusterAccent(index: number): string {
  const n = CLUSTER_ACCENTS.length;
  // Defensive modulo — negative or fractional indices clamp into range
  // rather than producing `undefined` (a dot with no color reads as a bug).
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) % n : 0;
  return CLUSTER_ACCENTS[i]!;
}
