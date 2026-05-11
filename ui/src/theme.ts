// Design tokens for ferrisscope. The Default theme is canonical and tied to
// `design/Helmsman v2/`. Lens / VS Code / Readable are intentional sibling
// themes — they don't have a matching `hv2-*.jsx` reference, by design.
//
// Two orthogonal axes:
//   - Theme    = typography + sizing + display options + bundled palettes
//   - Palette  = color tokens, in light + dark variants
//
// Components should consume `ResolvedTheme` (via `useResolvedTheme()` in the
// store, or `resolveTheme(...)` directly). The legacy `tokens(mode)` helper
// remains as a shim so importers that only need colors keep working unchanged.

export const FONT_SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// CSS-var-backed font families. The active theme publishes
// `--fs-font-sans` / `--fs-font-mono` on `:root` (see `App.tsx`);
// components should prefer these so the choice flows from the active theme
// instead of being pinned to the Default theme's stack. Each carries its
// `FONT_*` constant as the fallback so anything that consumes them before
// `App` has mounted still gets a sane string.
export const FF_SANS = `var(--fs-font-sans, ${FONT_SANS})`;
export const FF_MONO = `var(--fs-font-mono, ${FONT_MONO})`;

// CSS-var-backed font sizes. The active theme publishes `--fs-fs-*` on
// `:root` (App.tsx); literal fallback keeps things sane before mount.
// Mapping convention:
//   xs → captions, kbd glyphs, eyebrow labels (~10px in Default)
//   sm → secondary labels, table-adjacent text (~11px)
//   md → default body, controls (~12.5px)
//   lg → section headers (~14px)
//   xl → page titles / headlines (~16px)
export const FS_XS = "var(--fs-fs-xs, 10px)";
export const FS_SM = "var(--fs-fs-sm, 11px)";
export const FS_MD = "var(--fs-fs-md, 12.5px)";
export const FS_LG = "var(--fs-fs-lg, 14px)";
export const FS_XL = "var(--fs-fs-xl, 16px)";

// CSS-var-backed border-radius scale. Components reach for `R_MD` instead
// of inline `borderRadius: 6` so the active theme's `sizing.radius` flows
// through (VS Code's sharp 2px corners, Readable's chunky 12px corners).
// Fallback values are the Default theme's so anything that consumes them
// before `App` has mounted still renders sanely.
export const R_SM = "var(--fs-radius-sm, 4px)";
export const R_MD = "var(--fs-radius-md, 6px)";
export const R_LG = "var(--fs-radius-lg, 10px)";

export type ThemeMode = "light" | "dark";

// Global UI scale (root document.zoom). Bounds chosen so the smallest end
// still leaves header strip controls hit-targets sane and the largest end
// keeps the rail + dock layout from running off screen on a 13" display.
// The UI scale stacks on top of a theme's `typography.base` — themes pick
// the baseline, the scale slider zooms it.
export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1.0;

export function clampUiScale(v: number): number {
  if (!Number.isFinite(v)) return UI_SCALE_DEFAULT;
  if (v < UI_SCALE_MIN) return UI_SCALE_MIN;
  if (v > UI_SCALE_MAX) return UI_SCALE_MAX;
  return Math.round(v / UI_SCALE_STEP) * UI_SCALE_STEP;
}

// ── Color tokens ───────────────────────────────────────────────────────────
// Shape preserved from the previous `Tokens` so every existing call site
// keeps compiling. New themes must populate every field — palette completeness
// is enforced at the type level.

export type Tokens = {
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
  // status — structural, identical across themes in spirit but each palette
  // may re-tone them to match its character.
  good: string;
  warn: string;
  bad: string;
  info: string;
  unknown: string;
};

// Alias for readability — `ColorTokens` reads better in new code.
export type ColorTokens = Tokens;

// ── Typography / Sizing / Display ──────────────────────────────────────────

export type Typography = {
  fontSans: string;
  fontMono: string;
  // Base size in px. Helmsman is 12.5; Readable is 14. The UI Scale slider
  // multiplies on top of this via document.zoom.
  base: number;
  // Tight 5-step scale. Every inline `fontSize: N` in components migrates
  // to one of these keys. New sizes mean adding a step, not a literal.
  scale: {
    xs: number; // captions, badge counts
    sm: number; // table cells, secondary labels
    md: number; // default body, controls
    lg: number; // section headers
    xl: number; // page titles / large headlines
  };
  weights: {
    normal: number;
    medium: number;
    semibold: number;
    bold: number;
  };
};

export type Sizing = {
  // Per-density row height in px. ResourceTable picks one based on the
  // density setting; themes may shift the whole curve.
  rowHeights: {
    compact: number;
    comfortable: number;
    spacious: number;
  };
  // Default control height (buttons, chips, inputs).
  controlHeight: number;
  paddingX: number;
  radius: {
    sm: number;
    md: number;
    lg: number;
  };
  borderWidth: number;
};

export type Display = {
  // Per-surface icon toggles. `showRailIcons` is wired and gates the kind
  // glyphs next to each rail item — themes can opt out to mimic a label-only
  // navigation. `showTableIcons` / `showDetailIcons` are declarative for now
  // (no surfaces in the current app render kind icons in tables or detail
  // headers); kept on the type so themes can declare intent and we can wire
  // them when those surfaces grow icons.
  showRailIcons: boolean;
  showTableIcons: boolean;
  showDetailIcons: boolean;
  // Theme-level default for the existing `settings.monoTables` toggle.
  // Theme seeds it on theme change; user toggle wins after that.
  monoTablesDefault: boolean;
  // Theme-level default for the existing `settings.density` setting.
  densityDefault: "compact" | "comfortable" | "spacious";
  // Border heaviness preset — affects the inline borderWidth applied by
  // components that respect it (chrome rails, table grid lines).
  chrome: "low" | "normal" | "high";
};

export type Palette = {
  id: string;
  name: string;
  light: ColorTokens;
  dark: ColorTokens;
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
};

export type ThemeOverrides = {
  // Free-form override slot the Customize UI fills. Anything supplied here
  // wins over the active theme/palette. Kept as a partial-of-partials so a
  // user override can target a single field (e.g. just `tokens.accent`)
  // without losing the rest of the resolved theme.
  tokens?: Partial<ColorTokens>;
  typography?: Partial<Omit<Typography, "scale" | "weights">> & {
    scale?: Partial<Typography["scale"]>;
    weights?: Partial<Typography["weights"]>;
  };
  sizing?: Partial<Omit<Sizing, "rowHeights" | "radius">> & {
    rowHeights?: Partial<Sizing["rowHeights"]>;
    radius?: Partial<Sizing["radius"]>;
  };
  display?: Partial<Display>;
};

export type ResolvedTheme = {
  themeId: string;
  paletteId: string;
  mode: ThemeMode;
  tokens: ColorTokens;
  typography: Typography;
  sizing: Sizing;
  display: Display;
};

// ── Default theme palette ──────────────────────────────────────────────────

const DEFAULT_LIGHT: ColorTokens = {
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
  bad: "#f43f5e",
  info: "#3b82f6",
  unknown: "#94a3b8",
};

const DEFAULT_DARK: ColorTokens = {
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
  bad: "#f43f5e",
  info: "#3b82f6",
  unknown: "#64748b",
};

// Reference exports retained for tests / older importers that read the raw
// palettes. Prefer `resolveTheme()` in new code.
const LIGHT: Tokens = DEFAULT_LIGHT;
const DARK: Tokens = DEFAULT_DARK;

const DEFAULT_PALETTE: Palette = {
  id: "default",
  name: "Default",
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
};

// Sibling palettes for the Default theme — same neutrals, different accent.
// Built by spreading the canonical light/dark and swapping only the accent
// family so every palette stays visually consistent inside the Default
// theme's typography + sizing.
const DEFAULT_SLATE: Palette = {
  id: "slate",
  name: "Slate",
  light: {
    ...DEFAULT_LIGHT,
    accent: "#3b82f6",
    accentSoft: "#dbeafe",
    accentHover: "#2563eb",
    accentActive: "#1d4ed8",
  },
  dark: {
    ...DEFAULT_DARK,
    accent: "#60a5fa",
    accentSoft: "rgba(96,165,250,0.18)",
    accentHover: "#3b82f6",
    accentActive: "#1d4ed8",
  },
};

const DEFAULT_FOREST: Palette = {
  id: "forest",
  name: "Forest",
  light: {
    ...DEFAULT_LIGHT,
    accent: "#16a34a",
    accentSoft: "#dcfce7",
    accentHover: "#15803d",
    accentActive: "#166534",
  },
  dark: {
    ...DEFAULT_DARK,
    accent: "#4ade80",
    accentSoft: "rgba(74,222,128,0.16)",
    accentHover: "#22c55e",
    accentActive: "#16a34a",
  },
};

const DEFAULT_VIOLET: Palette = {
  id: "violet",
  name: "Violet",
  light: {
    ...DEFAULT_LIGHT,
    accent: "#7c3aed",
    accentSoft: "#ede9fe",
    accentHover: "#6d28d9",
    accentActive: "#5b21b6",
  },
  dark: {
    ...DEFAULT_DARK,
    accent: "#a78bfa",
    accentSoft: "rgba(167,139,250,0.18)",
    accentHover: "#8b5cf6",
    accentActive: "#7c3aed",
  },
};

const DEFAULT_THEME: Theme = {
  id: "default",
  name: "Default",
  description: "Inter, comfortable rows, soft borders.",
  defaultPaletteId: "default",
  palettes: [DEFAULT_PALETTE, DEFAULT_SLATE, DEFAULT_FOREST, DEFAULT_VIOLET],
  typography: {
    fontSans: FONT_SANS,
    fontMono: FONT_MONO,
    base: 12.5,
    scale: { xs: 10, sm: 11, md: 12.5, lg: 14, xl: 16 },
    weights: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  },
  sizing: {
    rowHeights: { compact: 26, comfortable: 32, spacious: 40 },
    controlHeight: 28,
    paddingX: 10,
    radius: { sm: 4, md: 6, lg: 10 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: true,
    showDetailIcons: true,
    monoTablesDefault: true,
    densityDefault: "comfortable",
    chrome: "normal",
  },
};

// ── Lens theme ─────────────────────────────────────────────────────────────

const LENS_LIGHT: ColorTokens = {
  bg: "#f3f4f6",
  surface: "#ffffff",
  surfaceAlt: "#f8f9fb",
  header: "#ffffff",
  headerAlt: "#f5f6f8",
  border: "#d1d5db",
  borderSoft: "#e5e7eb",
  text: "#0f172a",
  textDim: "#475569",
  textMuted: "#94a3b8",
  accent: "#2563eb",
  accentSoft: "#dbeafe",
  accentHover: "#1d4ed8",
  accentActive: "#1e40af",
  chip: "#e5e7eb",
  hover: "rgba(15,23,42,0.04)",
  btnHover: "#eef2f7",
  rail: "#ffffff",
  railHover: "rgba(15,23,42,0.05)",
  scrim: "rgba(15,23,42,0.25)",
  paletteBg: "rgba(255,255,255,0.97)",
  paletteBorder: "#cbd5e1",
  bulkBg: "#0f172a",
  good: "#16a34a",
  warn: "#f59e0b",
  bad: "#dc2626",
  info: "#2563eb",
  unknown: "#94a3b8",
};

const LENS_DARK: ColorTokens = {
  bg: "#1e2227",
  surface: "#262a30",
  surfaceAlt: "#22262c",
  header: "#1a1d22",
  headerAlt: "#23262c",
  border: "#3a3f47",
  borderSoft: "#2d3138",
  text: "#e6e8eb",
  textDim: "#a0a6b0",
  textMuted: "#6b7280",
  accent: "#3b82f6",
  accentSoft: "rgba(59,130,246,0.18)",
  accentHover: "#60a5fa",
  accentActive: "#2563eb",
  chip: "#30343b",
  hover: "rgba(255,255,255,0.04)",
  btnHover: "#2e3239",
  rail: "#1a1d22",
  railHover: "rgba(255,255,255,0.05)",
  scrim: "rgba(0,0,0,0.55)",
  paletteBg: "rgba(38,42,48,0.95)",
  paletteBorder: "#3a3f47",
  bulkBg: "#262a30",
  good: "#22c55e",
  warn: "#f59e0b",
  bad: "#ef4444",
  info: "#3b82f6",
  unknown: "#64748b",
};

const LENS_TEAL: Palette = {
  id: "teal",
  name: "Teal",
  light: {
    ...LENS_LIGHT,
    accent: "#0d9488",
    accentSoft: "#ccfbf1",
    accentHover: "#0f766e",
    accentActive: "#115e59",
  },
  dark: {
    ...LENS_DARK,
    accent: "#2dd4bf",
    accentSoft: "rgba(45,212,191,0.18)",
    accentHover: "#14b8a6",
    accentActive: "#0d9488",
  },
};

const LENS_AMBER: Palette = {
  id: "amber",
  name: "Amber",
  light: {
    ...LENS_LIGHT,
    accent: "#d97706",
    accentSoft: "#fef3c7",
    accentHover: "#b45309",
    accentActive: "#92400e",
  },
  dark: {
    ...LENS_DARK,
    accent: "#fbbf24",
    accentSoft: "rgba(251,191,36,0.18)",
    accentHover: "#f59e0b",
    accentActive: "#d97706",
  },
};

const LENS_THEME: Theme = {
  id: "lens",
  name: "Lens",
  description: "Compact rows, heavier borders.",
  defaultPaletteId: "lens",
  palettes: [
    {
      id: "lens",
      name: "Lens",
      light: LENS_LIGHT,
      dark: LENS_DARK,
    },
    LENS_TEAL,
    LENS_AMBER,
  ],
  typography: {
    fontSans: FONT_SANS,
    fontMono: FONT_MONO,
    base: 12,
    scale: { xs: 10, sm: 11, md: 12, lg: 13.5, xl: 15 },
    weights: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  },
  sizing: {
    rowHeights: { compact: 24, comfortable: 28, spacious: 34 },
    controlHeight: 26,
    paddingX: 8,
    radius: { sm: 3, md: 4, lg: 6 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: true,
    showDetailIcons: true,
    monoTablesDefault: false,
    densityDefault: "compact",
    chrome: "high",
  },
};

// ── VS Code theme ──────────────────────────────────────────────────────────

const VSCODE_FONT_SANS =
  '"Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const VSCODE_FONT_MONO =
  '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';

const VSCODE_DARK_PLUS: ColorTokens = {
  bg: "#1e1e1e",
  surface: "#252526",
  surfaceAlt: "#1e1e1e",
  header: "#3c3c3c",
  headerAlt: "#2d2d2d",
  border: "#3c3c3c",
  borderSoft: "#2d2d2d",
  text: "#cccccc",
  textDim: "#9d9d9d",
  textMuted: "#6e6e6e",
  accent: "#0078d4",
  accentSoft: "rgba(0,120,212,0.18)",
  accentHover: "#1f8ad6",
  accentActive: "#005a9e",
  chip: "#2d2d2d",
  hover: "rgba(255,255,255,0.04)",
  btnHover: "#2a2d2e",
  rail: "#333333",
  railHover: "rgba(255,255,255,0.05)",
  scrim: "rgba(0,0,0,0.6)",
  paletteBg: "rgba(37,37,38,0.97)",
  paletteBorder: "#454545",
  bulkBg: "#252526",
  good: "#89d185",
  warn: "#cca700",
  bad: "#f48771",
  info: "#75beff",
  unknown: "#858585",
};

const VSCODE_LIGHT_PLUS: ColorTokens = {
  bg: "#ffffff",
  surface: "#ffffff",
  surfaceAlt: "#f3f3f3",
  header: "#f3f3f3",
  headerAlt: "#ececec",
  border: "#cecece",
  borderSoft: "#e7e7e7",
  text: "#1e1e1e",
  textDim: "#616161",
  textMuted: "#8a8a8a",
  accent: "#0078d4",
  accentSoft: "#cde6f7",
  accentHover: "#106ebe",
  accentActive: "#005a9e",
  chip: "#e7e7e7",
  hover: "rgba(0,0,0,0.04)",
  btnHover: "#f0f0f0",
  // VS Code's actual Light+ uses a dark activity bar, but our rail carries
  // kind labels (text), not just icons — black on dark is unreadable. Keep
  // the rail light here for legibility; the Dark+ palette gets the dark
  // activity-bar treatment as expected.
  rail: "#f3f3f3",
  railHover: "rgba(0,0,0,0.05)",
  scrim: "rgba(0,0,0,0.25)",
  paletteBg: "rgba(255,255,255,0.97)",
  paletteBorder: "#cecece",
  bulkBg: "#1e1e1e",
  good: "#388a34",
  warn: "#bf8803",
  bad: "#a1260d",
  info: "#0078d4",
  unknown: "#616161",
};

const VSCODE_MONOKAI: Palette = {
  id: "monokai",
  name: "Monokai",
  light: {
    ...VSCODE_LIGHT_PLUS,
    accent: "#a6286e",
    accentSoft: "#fce7f3",
    accentHover: "#831b58",
    accentActive: "#6b163f",
  },
  dark: {
    ...VSCODE_DARK_PLUS,
    accent: "#a6e22e",
    accentSoft: "rgba(166,226,46,0.18)",
    accentHover: "#8bc926",
    accentActive: "#6f9e1f",
  },
};

const VSCODE_SOLARIZED: Palette = {
  id: "solarized",
  name: "Solarized",
  light: {
    ...VSCODE_LIGHT_PLUS,
    accent: "#268bd2",
    accentSoft: "#dceffb",
    accentHover: "#2076b3",
    accentActive: "#1a608f",
  },
  dark: {
    ...VSCODE_DARK_PLUS,
    accent: "#2aa198",
    accentSoft: "rgba(42,161,152,0.18)",
    accentHover: "#268876",
    accentActive: "#1f6f5f",
  },
};

const VSCODE_THEME: Theme = {
  id: "vscode",
  name: "VS Code",
  description: "Segoe + Cascadia, sharp corners.",
  defaultPaletteId: "dark-plus",
  palettes: [
    {
      id: "dark-plus",
      name: "Dark+",
      light: VSCODE_LIGHT_PLUS,
      dark: VSCODE_DARK_PLUS,
    },
    VSCODE_MONOKAI,
    VSCODE_SOLARIZED,
  ],
  typography: {
    fontSans: VSCODE_FONT_SANS,
    fontMono: VSCODE_FONT_MONO,
    base: 12,
    scale: { xs: 10, sm: 11, md: 12, lg: 13, xl: 14 },
    weights: { normal: 400, medium: 600, semibold: 600, bold: 700 },
  },
  sizing: {
    rowHeights: { compact: 22, comfortable: 26, spacious: 30 },
    controlHeight: 24,
    paddingX: 8,
    radius: { sm: 2, md: 2, lg: 2 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: false,
    showDetailIcons: true,
    monoTablesDefault: false,
    densityDefault: "compact",
    chrome: "normal",
  },
};

// ── Readable theme ─────────────────────────────────────────────────────────

const READABLE_LIGHT: ColorTokens = {
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
  bad: "#b91c1c",
  info: "#1d4ed8",
  unknown: "#78716c",
};

const READABLE_DARK: ColorTokens = {
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
  bad: "#fb7185",
  info: "#60a5fa",
  unknown: "#a8a29e",
};

const READABLE_COOL: Palette = {
  id: "cool",
  name: "Cool",
  light: {
    ...READABLE_LIGHT,
    accent: "#1e6091",
    accentSoft: "#d6e4f0",
    accentHover: "#194e76",
    accentActive: "#143d5b",
  },
  dark: {
    ...READABLE_DARK,
    accent: "#7ab8d8",
    accentSoft: "rgba(122,184,216,0.18)",
    accentHover: "#5fa3c9",
    accentActive: "#3e85ad",
  },
};

const READABLE_SEPIA: Palette = {
  id: "sepia",
  name: "Sepia",
  light: {
    ...READABLE_LIGHT,
    accent: "#7a5d3a",
    accentSoft: "#f0e6d2",
    accentHover: "#5f482c",
    accentActive: "#46361f",
  },
  dark: {
    ...READABLE_DARK,
    accent: "#d4b896",
    accentSoft: "rgba(212,184,150,0.18)",
    accentHover: "#b89a76",
    accentActive: "#967c5d",
  },
};

const READABLE_THEME: Theme = {
  id: "readable",
  name: "Readable",
  description: "Larger fonts, spacious rows.",
  defaultPaletteId: "warm",
  palettes: [
    {
      id: "warm",
      name: "Warm",
      light: READABLE_LIGHT,
      dark: READABLE_DARK,
    },
    READABLE_COOL,
    READABLE_SEPIA,
  ],
  typography: {
    fontSans: FONT_SANS,
    fontMono: FONT_MONO,
    base: 14,
    scale: { xs: 11, sm: 12.5, md: 14, lg: 16, xl: 19 },
    weights: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  },
  sizing: {
    rowHeights: { compact: 30, comfortable: 38, spacious: 46 },
    controlHeight: 32,
    paddingX: 12,
    radius: { sm: 6, md: 8, lg: 12 },
    borderWidth: 1,
  },
  display: {
    showRailIcons: true,
    showTableIcons: true,
    showDetailIcons: true,
    monoTablesDefault: false,
    densityDefault: "spacious",
    chrome: "low",
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

export function resolveTheme(opts: {
  themeId: string;
  paletteId: string;
  mode: ThemeMode;
  overrides?: ThemeOverrides | null;
}): ResolvedTheme {
  const theme = getTheme(opts.themeId);
  const palette = getPalette(theme, opts.paletteId);
  const baseTokens = opts.mode === "dark" ? palette.dark : palette.light;
  const o = opts.overrides ?? {};
  const tokens: ColorTokens = { ...baseTokens, ...(o.tokens ?? {}) };
  const typography: Typography = {
    ...theme.typography,
    ...(o.typography ?? {}),
    scale: { ...theme.typography.scale, ...(o.typography?.scale ?? {}) },
    weights: { ...theme.typography.weights, ...(o.typography?.weights ?? {}) },
  };
  const sizing: Sizing = {
    ...theme.sizing,
    ...(o.sizing ?? {}),
    rowHeights: { ...theme.sizing.rowHeights, ...(o.sizing?.rowHeights ?? {}) },
    radius: { ...theme.sizing.radius, ...(o.sizing?.radius ?? {}) },
  };
  const display: Display = { ...theme.display, ...(o.display ?? {}) };
  return {
    themeId: theme.id,
    paletteId: palette.id,
    mode: opts.mode,
    tokens,
    typography,
    sizing,
    display,
  };
}

// ── Legacy `tokens(mode)` shim ─────────────────────────────────────────────
// Existing call sites pass only `mode`. They get the Default theme's palette,
// matching today's behaviour exactly. New code should read `tokens` off
// `useResolvedTheme()` instead so the active theme/palette flows through.

export const tokens = (mode: ThemeMode): Tokens =>
  mode === "dark" ? DARK : LIGHT;

// ── Status mapping ─────────────────────────────────────────────────────────
// Status semantics are theme-invariant. Buckets and the transient set are
// defined here once; palettes recolor the buckets but never redefine them.

export type StatusBucket = "good" | "warn" | "bad" | "info" | "unknown";

const GOOD = new Set([
  "Running",
  "Ready",
  "Active",
  "Available",
  "Bound",
  "healthy",
]);
const WARN = new Set([
  "Pending",
  "Warning",
  "warning",
  "degraded",
  "Updating",
  "Progressing",
]);
const INFO = new Set([
  "ContainerCreating",
  "PodInitializing",
  "Init",
  "Succeeded",
  "Completed",
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
  "Unhealthy",
  "Unavailable",
  "DeadlineExceeded",
  "ContainerCannotRun",
  "Terminated",
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
  "Waiting",
  "PodScheduled",
  "ContainerStarting",
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

// Pill background + foreground for a status — softer than the dot.
//
// Both `bg` and `fg` derive from the active palette's bucket color, so a
// palette that re-tones (e.g. VS Code's muted `good: "#89d185"`) flows
// through to the pill. `bg` is the bucket color at low alpha; `fg` is the
// bucket color itself in dark mode (already light enough to read on a
// translucent dark surface) and a darkened mix in light mode (the same
// color over a tinted background can lose contrast). The darkening is
// done by overlaying a near-black at ~55% — cheap and deterministic.
export function statusFill(
  status: string,
  t: Tokens,
  mode: ThemeMode,
): { bg: string; fg: string } {
  const bucket = statusBucket(status);
  const color =
    bucket === "good"
      ? t.good
      : bucket === "warn"
        ? t.warn
        : bucket === "bad"
          ? t.bad
          : bucket === "info"
            ? t.info
            : t.unknown;
  const dark = mode === "dark";
  return {
    // 16% alpha on the bucket color — same intensity the old hand-tuned
    // RGB tints had, but now follows the palette.
    bg: hexWithAlpha(color, dark ? 0.16 : 0.14),
    // Light theme darkens for legibility on the tinted pill; dark theme
    // leaves the bucket color as-is (already vivid on a dark backdrop).
    fg: dark ? color : mixWithBlack(color, 0.55),
  };
}

/// Append an alpha channel to a hex / rgb-ish color. Tolerates `#rrggbb`,
/// `#rgb`, and `rgb(...)` / `rgba(...)` inputs. Falls back to the input
/// itself if the shape is unfamiliar (palette authors can paste anything
/// reasonable and the pill stays usable).
function hexWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const rgb = toRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
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

function toRgb(color: string): { r: number; g: number; b: number } | null {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length !== 6) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }
  const m = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i,
  );
  if (m && m[1] && m[2] && m[3])
    return {
      r: parseInt(m[1], 10),
      g: parseInt(m[2], 10),
      b: parseInt(m[3], 10),
    };
  return null;
}
