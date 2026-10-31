import { useMemo } from "react";
import type { Monaco } from "@monaco-editor/react";
import { useResolvedTheme } from "../store";
import { toHexColor, type Tokens } from "../theme";

type ThemeData = Parameters<Monaco["editor"]["defineTheme"]>[1];

// Monaco only accepts `#rrggbb[aa]`; tokens may be `rgba()`.
function hex(c: string): string | undefined {
  return toHexColor(c) ?? undefined;
}

/// Editor chrome in the palette's colours; syntax colours stay with the
/// `vs` / `vs-dark` base so YAML keeps its familiar highlighting.
export function monacoThemeData(t: Tokens, dark: boolean): ThemeData {
  const entries: [string, string][] = [
    ["editor.background", t.surface],
    ["editor.foreground", t.text],
    ["editorGutter.background", t.surface],
    ["editorLineNumber.foreground", t.textMuted],
    ["editorLineNumber.activeForeground", t.textDim],
    ["editor.lineHighlightBackground", t.hover],
    ["editor.lineHighlightBorder", "#00000000"],
    ["editorCursor.foreground", t.accent],
    ["editor.selectionBackground", t.accentSoft],
    ["editor.inactiveSelectionBackground", t.hover],
    ["editorIndentGuide.background1", t.borderSoft],
    ["editorIndentGuide.activeBackground1", t.border],
    ["editorWidget.background", t.surfaceAlt],
    ["editorWidget.border", t.border],
    ["editorHoverWidget.background", t.surfaceAlt],
    ["editorHoverWidget.border", t.border],
    ["editorSuggestWidget.background", t.surfaceAlt],
    ["editorSuggestWidget.border", t.border],
    ["input.background", t.input],
    ["input.border", t.inputBorder],
    ["focusBorder", t.focus],
    ["scrollbarSlider.background", t.scrollThumb],
    ["scrollbarSlider.hoverBackground", t.scrollThumbHover],
    ["scrollbarSlider.activeBackground", t.scrollThumbActive],
    ["editorOverviewRuler.border", "#00000000"],
  ];
  const colors: Record<string, string> = {};
  for (const [k, v] of entries) {
    const h = hex(v);
    if (h) colors[k] = h;
  }
  return { base: dark ? "vs-dark" : "vs", inherit: true, rules: [], colors };
}

// Keyed by full content, so two palettes can never share a name.
const names = new Map<string, string>();
const known = new Map<string, ThemeData>();

function themeName(data: ThemeData): string {
  const key = JSON.stringify(data);
  let name = names.get(key);
  if (!name) {
    name = `fs-${names.size}`;
    names.set(key, name);
    known.set(name, data);
  }
  return name;
}

const defined = new WeakMap<Monaco, Set<string>>();
let instance: Monaco | null = null;

/// Define every theme a component has asked for. Pass as an editor's
/// `beforeMount` so the first mount already finds its theme.
export function defineMonacoThemes(monaco: Monaco): void {
  instance = monaco;
  let done = defined.get(monaco);
  if (!done) {
    done = new Set();
    defined.set(monaco, done);
  }
  for (const [name, data] of known) {
    if (done.has(name)) continue;
    monaco.editor.defineTheme(name, data);
    done.add(name);
  }
}

/// Theme name for the active palette. Defined synchronously once an editor
/// has mounted, so the editor's own `setTheme` on prop change finds it.
export function useMonacoTheme(): string {
  const r = useResolvedTheme();
  return useMemo(() => {
    const data = monacoThemeData(r.tokens, r.mode === "dark");
    const name = themeName(data);
    if (instance) defineMonacoThemes(instance);
    return name;
  }, [r.tokens, r.mode]);
}
