import { hexWithAlpha, type ResolvedTheme, type ThemeMode } from "../theme";

// Publish theme-derived state onto the document: body typography, the `:root`
// custom properties components read via `var(--fs-*)`, and `color-scheme`.
export function applyThemeCssVars(
  resolved: ResolvedTheme,
  themeMode: ThemeMode,
  opts: { isMac: boolean; titlebarInsetPx: number },
): void {
  const tk = resolved.tokens;
  const ty = resolved.typography;
  const sz = resolved.sizing;
  document.body.style.color = tk.text;
  document.body.style.fontFamily = ty.fontSans;
  document.body.style.fontSize = `${ty.base}px`;
  // macOS vibrancy needs a clear page so the NSVisualEffectView shows through;
  // elsewhere the stylesheet's background applies.
  document.body.style.background = opts.isMac ? "transparent" : "";
  const root = document.documentElement.style;
  const px = (n: number) => `${n}px`;
  const vars: [string, string][] = [
    ["--fs-font-sans", ty.fontSans],
    ["--fs-font-mono", ty.fontMono],
    ["--fs-fs-xs", px(ty.scale.xs)],
    ["--fs-fs-sm", px(ty.scale.sm)],
    ["--fs-fs-md", px(ty.scale.md)],
    ["--fs-fs-lg", px(ty.scale.lg)],
    ["--fs-fs-xl", px(ty.scale.xl)],
    ["--fs-fw-normal", String(ty.weights.normal)],
    ["--fs-fw-medium", String(ty.weights.medium)],
    ["--fs-fw-semibold", String(ty.weights.semibold)],
    ["--fs-fw-bold", String(ty.weights.bold)],
    ["--fs-label-case", ty.label.caps ? "uppercase" : "none"],
    ["--fs-label-font", ty.label.mono ? "var(--fs-font-mono)" : "var(--fs-font-sans)"],
    ["--fs-label-ls", String(ty.label.tracking)],
    ["--fs-table-fs", px(ty.table.text)],
    ["--fs-table-fs-mono", px(ty.table.mono)],
    ["--fs-radius-sm", px(sz.radius.sm)],
    ["--fs-radius-md", px(sz.radius.md)],
    ["--fs-radius-lg", px(sz.radius.lg)],
    ["--fs-control-h", px(sz.controlHeight)],
    ["--fs-field-h", px(sz.fieldHeight.md)],
    ["--fs-field-h-sm", px(sz.fieldHeight.sm)],
    ["--fs-tab-indicator", px(sz.tabIndicator)],
    ["--fs-border-w", px(sz.borderWidth)],
    ["--fs-accent", tk.accent],
    ["--fs-focus", tk.focus],
    ["--fs-accent-ring", hexWithAlpha(tk.accent, 0.32)],
    ["--fs-scroll-thumb", tk.scrollThumb],
    ["--fs-scroll-thumb-hover", tk.scrollThumbHover],
    ["--fs-scroll-thumb-active", tk.scrollThumbActive],
    // Linux custom titlebar height (0 elsewhere); fixed overlays inset by it.
    ["--fs-titlebar-h", px(opts.titlebarInsetPx)],
  ];
  for (const [k, v] of vars) root.setProperty(k, v);
  if (ty.label.weight === null) root.removeProperty("--fs-label-fw");
  else root.setProperty("--fs-label-fw", String(ty.label.weight));
  document.documentElement.style.colorScheme = themeMode;
}
