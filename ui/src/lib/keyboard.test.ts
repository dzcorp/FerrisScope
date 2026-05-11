// Keyboard helpers are tiny and pure but `latinLetter` carries non-obvious
// behaviour (Cyrillic / Greek physical-position fallback) that's exactly
// where regressions sneak in. Worth pinning.

import { describe, it, expect } from "vitest";
import { chord, chordLabel, latinLetter, MOD_KEY, SHIFT_KEY, ALT_KEY } from "./keyboard";

describe("chord", () => {
  it("translates Mod/Shift/Alt tokens to platform glyphs and passes other parts through", () => {
    const parts = chord("Mod", "Shift", "K");
    expect(parts).toEqual([MOD_KEY, SHIFT_KEY, "K"]);
    // Non-token parts pass through verbatim — `,` / `←` are real call-site values.
    expect(chord("Mod", ",")).toEqual([MOD_KEY, ","]);
    expect(chord("Alt", "←")).toEqual([ALT_KEY, "←"]);
  });
});

describe("chordLabel", () => {
  it("joins with + on non-mac (Linux jsdom default)", () => {
    // jsdom's navigator.platform doesn't match the Mac regex, so we exercise
    // the non-mac branch deterministically. Mac glyph paths are covered by
    // the constants themselves.
    expect(chordLabel("Mod", "K")).toBe("Ctrl+K");
    expect(chordLabel("Mod", "Shift", "P")).toBe("Ctrl+Shift+P");
  });
});

describe("latinLetter", () => {
  it("returns the lowercase letter for a Latin key event", () => {
    expect(latinLetter({ key: "F", code: "KeyF" })).toBe("f");
    expect(latinLetter({ key: "a", code: "KeyA" })).toBe("a");
  });

  it("non-letter Latin keys return null even with a Key… code (digit row)", () => {
    expect(latinLetter({ key: "1", code: "Digit1" })).toBeNull();
    expect(latinLetter({ key: " ", code: "Space" })).toBeNull();
    expect(latinLetter({ key: "Enter", code: "Enter" })).toBeNull();
  });

  it("non-Latin .key falls back to physical KeyF code", () => {
    // Russian "а" on the F physical key.
    expect(latinLetter({ key: "а", code: "KeyF" })).toBe("f");
    // Greek "φ" on the F physical key.
    expect(latinLetter({ key: "φ", code: "KeyF" })).toBe("f");
  });

  it("non-Latin .key without a Key… code returns null", () => {
    expect(latinLetter({ key: "а", code: "" })).toBeNull();
    // Five-letter `code` (Digit1, Space) shouldn't be parsed as a letter.
    expect(latinLetter({ key: "а", code: "Digit1" })).toBeNull();
  });

  it("multi-character key strings (named keys) return null", () => {
    expect(latinLetter({ key: "ArrowLeft", code: "ArrowLeft" })).toBeNull();
    expect(latinLetter({ key: "Escape", code: "Escape" })).toBeNull();
  });
});
