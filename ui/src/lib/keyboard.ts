// Platform-aware keyboard label helpers. The handlers themselves are already
// cross-platform (every key listener tests `e.metaKey || e.ctrlKey`); only the
// hints shown to the user need to know the difference. macOS gets ⌘/⇧/⌥
// glyphs; everyone else gets the spelled-out modifier name.

const IS_MAC = (() => {
  if (typeof navigator === "undefined") return false;
  // navigator.platform is the most reliable signal on desktop browsers and is
  // what Tauri's WebView surfaces. UA fallback covers the rare case where it's
  // empty (some sandboxed runners).
  const p = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad/.test(p);
})();

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
export const SHIFT_KEY = IS_MAC ? "⇧" : "Shift";
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";

// Render a chord as an array of label segments (so callers can map each
// segment into its own <Kbd>). Pass tokens like "Mod", "Shift", "Alt" for
// modifiers and a literal key like "K" / "," / "`" / "←" for the trigger.
export function chord(...parts: string[]): string[] {
  return parts.map((p) => {
    if (p === "Mod") return MOD_KEY;
    if (p === "Shift") return SHIFT_KEY;
    if (p === "Alt") return ALT_KEY;
    return p;
  });
}

// Convenience for inline string hints (tooltips, aria-labels). Joins with a
// thin space — same separator we use in <Kbd> stacks visually.
export function chordLabel(...parts: string[]): string {
  return chord(...parts).join(IS_MAC ? "" : "+");
}

// Layout-agnostic letter detection for shortcut handlers.
//
// `KeyboardEvent.key` is localized — on a Cyrillic / Greek / Hebrew /
// Arabic layout, pressing the physical "F" key produces a non-Latin
// character ("а" / "φ" / "כ" / …) and a naive `e.key.toLowerCase() === "f"`
// check silently misses. `KeyboardEvent.code`, by contrast, is the
// physical key identifier ("KeyF") regardless of layout.
//
// We accept either:
//   1. `e.key` already says the Latin letter — fast path for Latin layouts
//      and Dvorak / Colemak (where the operator's mental model maps to
//      the produced character, not the position).
//   2. `e.code === "Key{X}"` — physical position fallback so Cmd+F on a
//      Russian or Hebrew keyboard still hits the F handler.
//
// Returns the lowercase Latin letter the operator effectively typed, or
// `null` if the event isn't a Latin-letter keypress in either sense.
//
// Accepts the structural shape rather than the named DOM/React types so
// callers don't have to import either; both `KeyboardEvent` (browser
// native) and `React.KeyboardEvent` satisfy this signature.
export function latinLetter(e: { key: string; code: string }): string | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (k.length === 1 && k >= "a" && k <= "z") return k;
  const code = e.code;
  if (code && code.length === 4 && code.startsWith("Key")) {
    const c = code.charAt(3).toLowerCase();
    if (c >= "a" && c <= "z") return c;
  }
  return null;
}
