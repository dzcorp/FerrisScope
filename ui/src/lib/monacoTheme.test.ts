import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Monaco } from "@monaco-editor/react";
import { defineMonacoThemes, monacoThemeData, useMonacoTheme } from "./monacoTheme";
import { useAppStore } from "../store";
import { resolveTheme } from "../theme";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  act(() => useAppStore.setState({ ...initial }));
});

function fakeMonaco() {
  const defineTheme = vi.fn();
  return { monaco: { editor: { defineTheme } } as unknown as Monaco, defineTheme };
}

describe("monacoThemeData", () => {
  it("paints editor chrome from the palette, in hex Monaco accepts", () => {
    const t = resolveTheme({ themeId: "vscode", paletteId: "modern", mode: "dark" }).tokens;
    const d = monacoThemeData(t, true);
    expect(d.base).toBe("vs-dark");
    expect(d.inherit).toBe(true);
    expect(d.colors["editor.background"]).toBe("#1f1f1f");
    expect(d.colors["focusBorder"]).toBe("#0078d4");
    // rgba() tokens arrive as #rrggbbaa.
    expect(d.colors["scrollbarSlider.background"]).toBe("#79797966");
    for (const v of Object.values(d.colors)) expect(v).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });

  it("uses the light base in light mode", () => {
    const t = resolveTheme({ themeId: "default", paletteId: "default", mode: "light" }).tokens;
    expect(monacoThemeData(t, false).base).toBe("vs");
  });
});

describe("useMonacoTheme", () => {
  it("names the theme by content and defines it once per Monaco instance", () => {
    const { result, rerender } = renderHook(() => useMonacoTheme());
    const first = result.current;
    expect(first).toMatch(/^fs-[0-9a-z]+$/);

    const { monaco, defineTheme } = fakeMonaco();
    defineMonacoThemes(monaco);
    expect(defineTheme).toHaveBeenCalledWith(first, expect.objectContaining({ base: "vs-dark" }));
    const calls = defineTheme.mock.calls.length;
    defineMonacoThemes(monaco);
    expect(defineTheme.mock.calls.length).toBe(calls);

    // A palette switch after mount defines the new theme synchronously.
    act(() => useAppStore.setState({ themeId: "lens", paletteId: "lens" }));
    rerender();
    expect(result.current).not.toBe(first);
    expect(defineTheme).toHaveBeenLastCalledWith(result.current, expect.any(Object));
  });
});
