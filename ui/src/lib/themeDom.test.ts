import { describe, it, expect, beforeEach } from "vitest";
import { applyThemeCssVars } from "./themeDom";
import { resolveTheme, DEFAULT_THEME_ID, DEFAULT_PALETTE_ID } from "../theme";

function resolved(mode: "light" | "dark") {
  return resolveTheme({
    themeId: DEFAULT_THEME_ID,
    paletteId: DEFAULT_PALETTE_ID,
    mode,
    overrides: null,
  });
}

beforeEach(() => {
  // Clear inline styles set by a previous case so each assertion is isolated.
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

describe("applyThemeCssVars", () => {
  it("publishes the typography + sizing scale as :root custom properties", () => {
    const r = resolved("dark");
    applyThemeCssVars(r, "dark", { isMac: false, titlebarInsetPx: 0 });

    const root = document.documentElement.style;
    expect(root.getPropertyValue("--fs-font-sans")).toBe(r.typography.fontSans);
    expect(root.getPropertyValue("--fs-font-mono")).toBe(r.typography.fontMono);
    expect(root.getPropertyValue("--fs-fs-xs")).toBe(`${r.typography.scale.xs}px`);
    expect(root.getPropertyValue("--fs-fs-md")).toBe(`${r.typography.scale.md}px`);
    expect(root.getPropertyValue("--fs-fs-xl")).toBe(`${r.typography.scale.xl}px`);
    expect(root.getPropertyValue("--fs-radius-md")).toBe(`${r.sizing.radius.md}px`);
    expect(root.getPropertyValue("--fs-control-h")).toBe(`${r.sizing.controlHeight}px`);
    expect(root.getPropertyValue("--fs-border-w")).toBe(`${r.sizing.borderWidth}px`);
  });

  it("sets the native color-scheme to the active mode", () => {
    applyThemeCssVars(resolved("light"), "light", { isMac: false, titlebarInsetPx: 0 });
    expect(document.documentElement.style.colorScheme).toBe("light");

    applyThemeCssVars(resolved("dark"), "dark", { isMac: false, titlebarInsetPx: 0 });
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("publishes the titlebar inset and gates body background on isMac", () => {
    // Off macOS: body background reverts to the stylesheet (empty inline value).
    applyThemeCssVars(resolved("dark"), "dark", { isMac: false, titlebarInsetPx: 30 });
    expect(document.documentElement.style.getPropertyValue("--fs-titlebar-h")).toBe("30px");
    expect(document.body.style.background).toBe("");

    // On macOS: body must be clear so the NSVisualEffectView shows through.
    applyThemeCssVars(resolved("dark"), "dark", { isMac: true, titlebarInsetPx: 0 });
    expect(document.body.style.background).toBe("transparent");
    expect(document.documentElement.style.getPropertyValue("--fs-titlebar-h")).toBe("0px");
  });

  it("applies the typography font + base size to the body", () => {
    const r = resolved("dark");
    applyThemeCssVars(r, "dark", { isMac: false, titlebarInsetPx: 0 });
    expect(document.body.style.fontFamily).toBe(r.typography.fontSans);
    expect(document.body.style.fontSize).toBe(`${r.typography.base}px`);
  });
});
