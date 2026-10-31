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

describe("applyThemeCssVars — table, field and colour vars", () => {
  it("publishes the table typography, field heights, focus and scrollbar colours", () => {
    const r = resolveTheme({ themeId: "vscode", paletteId: "modern", mode: "dark" });
    applyThemeCssVars(r, "dark", { isMac: false, titlebarInsetPx: 0 });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--fs-table-fs")).toBe("13px");
    expect(root.getPropertyValue("--fs-table-fs-mono")).toBe("12.5px");
    expect(root.getPropertyValue("--fs-field-h")).toBe("26px");
    expect(root.getPropertyValue("--fs-field-h-sm")).toBe("22px");
    expect(root.getPropertyValue("--fs-focus")).toBe(r.tokens.focus);
    expect(root.getPropertyValue("--fs-accent")).toBe(r.tokens.accent);
    expect(root.getPropertyValue("--fs-scroll-thumb")).toBe(r.tokens.scrollThumb);
    expect(root.getPropertyValue("--fs-scroll-thumb-active")).toBe(r.tokens.scrollThumbActive);
    expect(root.getPropertyValue("--fs-accent-ring")).toMatch(/^rgba\(0, 120, 212, 0\.32\)$/);
  });
});

describe("applyThemeCssVars — weights, labels, tabs", () => {
  it("publishes weight, label and tab-indicator vars, and clears an unset label weight", () => {
    const lens = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark" });
    applyThemeCssVars(lens, "dark", { isMac: false, titlebarInsetPx: 0 });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--fs-label-case")).toBe("none");
    expect(root.getPropertyValue("--fs-label-font")).toBe("var(--fs-font-sans)");
    expect(root.getPropertyValue("--fs-label-ls")).toBe("0");
    expect(root.getPropertyValue("--fs-label-fw")).toBe("500");
    expect(root.getPropertyValue("--fs-tab-indicator")).toBe("3px");
    expect(root.getPropertyValue("--fs-fw-semibold")).toBe("500");

    const def = resolveTheme({ themeId: "default", paletteId: "default", mode: "dark" });
    applyThemeCssVars(def, "dark", { isMac: false, titlebarInsetPx: 0 });
    expect(root.getPropertyValue("--fs-label-case")).toBe("uppercase");
    expect(root.getPropertyValue("--fs-label-fw")).toBe("");
    expect(root.getPropertyValue("--fs-fw-medium")).toBe("500");
  });
});
