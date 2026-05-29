import type { ResolvedTheme, ThemeMode } from "../theme";

// Publish theme-derived state onto the document: body background/typography,
// the `:root` CSS custom properties components read via `var(--fs-*)`, and the
// native `color-scheme`. Pure w.r.t. its inputs (the only effect is the DOM
// write), so App can call it from a `useLayoutEffect` keyed on the resolved
// theme + mode rather than re-running the writes on every render.
//
// `isMac` / `titlebarInsetPx` are passed in rather than imported so this stays
// a leaf module with no platform-const dependency (and is trivially testable).
export function applyThemeCssVars(
  resolved: ResolvedTheme,
  themeMode: ThemeMode,
  opts: { isMac: boolean; titlebarInsetPx: number },
): void {
  const tk = resolved.tokens;
  document.body.style.background = tk.bg;
  document.body.style.color = tk.text;
  // Theme typography flows to the document so every component that doesn't
  // explicitly override font / base size picks it up. Cheap blanket effect —
  // covers the long tail of components not yet swept to consume ResolvedTheme.
  document.body.style.fontFamily = resolved.typography.fontSans;
  document.body.style.fontSize = `${resolved.typography.base}px`;
  // macOS vibrancy: the window is transparent and an NSVisualEffectView sits
  // behind the webview (tauri.macos.conf.json). The page background must be
  // clear for that material to show through; the opaque content area repaints
  // t.bg itself. No-op (and reverts to the stylesheet) off macOS.
  document.body.style.background = opts.isMac ? "transparent" : "";
  // Publish the typography + sizing scale as CSS custom properties so
  // components can read `var(--fs-fs-sm)` etc. without each one threading
  // ResolvedTheme through props. Incremental migration: components keep their
  // inline pixel literals as the var fallback until they're swept.
  const root = document.documentElement.style;
  root.setProperty("--fs-font-sans", resolved.typography.fontSans);
  root.setProperty("--fs-font-mono", resolved.typography.fontMono);
  root.setProperty("--fs-fs-xs", `${resolved.typography.scale.xs}px`);
  root.setProperty("--fs-fs-sm", `${resolved.typography.scale.sm}px`);
  root.setProperty("--fs-fs-md", `${resolved.typography.scale.md}px`);
  root.setProperty("--fs-fs-lg", `${resolved.typography.scale.lg}px`);
  root.setProperty("--fs-fs-xl", `${resolved.typography.scale.xl}px`);
  root.setProperty("--fs-radius-sm", `${resolved.sizing.radius.sm}px`);
  root.setProperty("--fs-radius-md", `${resolved.sizing.radius.md}px`);
  root.setProperty("--fs-radius-lg", `${resolved.sizing.radius.lg}px`);
  root.setProperty("--fs-control-h", `${resolved.sizing.controlHeight}px`);
  root.setProperty("--fs-border-w", `${resolved.sizing.borderWidth}px`);
  // Publish the custom-titlebar height (Linux only — 0 elsewhere) as a CSS
  // variable. Every fixed-position overlay (scrim, side panel, modal, dock)
  // reads `var(--fs-titlebar-h, 0px)` for its top inset so the titlebar stays
  // accessible (drag, close) above modals — matching native macOS/Windows.
  root.setProperty("--fs-titlebar-h", `${opts.titlebarInsetPx}px`);
  // Tell native form controls (select dropdowns, scrollbars, autofill) to theme
  // themselves to match — otherwise the OS defaults to light, leaving a white
  // dropdown list on a dark page.
  document.documentElement.style.colorScheme = themeMode;
}
