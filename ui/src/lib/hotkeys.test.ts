import { describe, it, expect } from "vitest";
import {
  hotkeyIntent,
  intentPreventsDefault,
  type HotkeyEvent,
  type HotkeyIntent,
  type HotkeyLayers,
} from "./hotkeys";

const ev = (over: Partial<HotkeyEvent>): HotkeyEvent => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const layers = (over?: Partial<HotkeyLayers>): HotkeyLayers => ({
  scopeActive: true,
  paletteOpen: false,
  addMenuOpen: false,
  settingsOpen: false,
  nsModalOpen: false,
  filterEditing: false,
  hasSelection: false,
  inTextInput: false,
  ...over,
});

describe("hotkeyIntent — platform parity", () => {
  // Every chord must fire identically with Cmd (macOS) and Ctrl
  // (Windows / Linux). One table, both modifier flags.
  const chords: [Partial<HotkeyEvent>, HotkeyIntent][] = [
    [{ key: "k", code: "KeyK" }, "toggle-palette"],
    [{ key: "f", code: "KeyF" }, "open-filter"],
    [{ key: "i", code: "KeyI" }, "open-ns-modal"],
    [{ key: ",", code: "Comma" }, "open-settings"],
    [{ key: "l", code: "KeyL", shiftKey: true }, "toggle-theme"],
    [{ key: "=", code: "Equal" }, "zoom-in"],
    [{ key: "+", code: "Equal", shiftKey: true }, "zoom-in"],
    [{ key: "-", code: "Minus" }, "zoom-out"],
    [{ key: "0", code: "Digit0" }, "zoom-reset"],
    [{ key: "`", code: "Backquote" }, "new-terminal"],
    [{ key: "y", code: "KeyY", shiftKey: true }, "new-yaml"],
  ];

  it.each(chords)("%o resolves with Cmd (macOS)", (over, intent) => {
    expect(hotkeyIntent(ev({ ...over, metaKey: true }), layers())).toBe(intent);
  });

  it.each(chords)("%o resolves with Ctrl (Windows/Linux)", (over, intent) => {
    expect(hotkeyIntent(ev({ ...over, ctrlKey: true }), layers())).toBe(intent);
  });

  it("resolves the physical key on non-Latin layouts (Ctrl+F on Cyrillic)", () => {
    expect(
      hotkeyIntent(ev({ key: "а", code: "KeyF", ctrlKey: true }), layers()),
    ).toBe("open-filter");
  });

  it("returns null for unmodified letters", () => {
    expect(hotkeyIntent(ev({ key: "k", code: "KeyK" }), layers())).toBeNull();
  });
});

describe("hotkeyIntent — scope gating", () => {
  // Regression: these shortcuts gate on scopeActive — the active cluster
  // set (single, virtual context, or ad-hoc multi). They previously gated
  // on `selectedContext`, which is null in virtual-context views, so ⌘I /
  // ⌘F / `/` were dead exactly where the multi-cluster namespace modal
  // matters most.
  const scoped: [Partial<HotkeyEvent>, HotkeyIntent][] = [
    [{ key: "i", code: "KeyI", metaKey: true }, "open-ns-modal"],
    [{ key: "f", code: "KeyF", metaKey: true }, "open-filter"],
    [{ key: "/", code: "Slash" }, "open-filter"],
    [{ key: "`", code: "Backquote", metaKey: true }, "new-terminal"],
    [{ key: "y", code: "KeyY", metaKey: true, shiftKey: true }, "new-yaml"],
  ];

  it.each(scoped)("%o fires when any scope is active", (over, intent) => {
    expect(hotkeyIntent(ev(over), layers({ scopeActive: true }))).toBe(intent);
  });

  it.each(scoped)("%o is inert with no active scope", (over) => {
    expect(hotkeyIntent(ev(over), layers({ scopeActive: false }))).toBeNull();
  });

  it("palette / settings / theme / zoom stay available without a scope", () => {
    const free = layers({ scopeActive: false });
    expect(hotkeyIntent(ev({ key: "k", code: "KeyK", metaKey: true }), free)).toBe(
      "toggle-palette",
    );
    expect(hotkeyIntent(ev({ key: ",", metaKey: true }), free)).toBe(
      "open-settings",
    );
    expect(
      hotkeyIntent(ev({ key: "l", code: "KeyL", metaKey: true, shiftKey: true }), free),
    ).toBe("toggle-theme");
    expect(hotkeyIntent(ev({ key: "0", metaKey: true }), free)).toBe(
      "zoom-reset",
    );
  });
});

describe("hotkeyIntent — `/` find shortcut", () => {
  it("is suppressed inside text inputs", () => {
    expect(
      hotkeyIntent(ev({ key: "/" }), layers({ inTextInput: true })),
    ).toBeNull();
  });

  it("is suppressed with any modifier held", () => {
    expect(hotkeyIntent(ev({ key: "/", ctrlKey: true }), layers())).toBeNull();
    expect(hotkeyIntent(ev({ key: "/", metaKey: true }), layers())).toBeNull();
    expect(hotkeyIntent(ev({ key: "/", altKey: true }), layers())).toBeNull();
  });
});

describe("hotkeyIntent — Esc cascade", () => {
  const esc = ev({ key: "Escape", code: "Escape" });

  it("closes the deepest open layer first", () => {
    const all = {
      addMenuOpen: true,
      paletteOpen: true,
      filterEditing: true,
      settingsOpen: true,
      nsModalOpen: true,
      hasSelection: true,
    };
    expect(hotkeyIntent(esc, layers(all))).toBe("esc-add-menu");
    expect(hotkeyIntent(esc, layers({ ...all, addMenuOpen: false }))).toBe(
      "esc-palette",
    );
    expect(
      hotkeyIntent(
        esc,
        layers({ ...all, addMenuOpen: false, paletteOpen: false }),
      ),
    ).toBe("esc-filter");
    expect(
      hotkeyIntent(
        esc,
        layers({
          ...all,
          addMenuOpen: false,
          paletteOpen: false,
          filterEditing: false,
        }),
      ),
    ).toBe("esc-settings");
    expect(hotkeyIntent(esc, layers({ nsModalOpen: true, hasSelection: true }))).toBe(
      "esc-ns-modal",
    );
    expect(hotkeyIntent(esc, layers({ hasSelection: true }))).toBe(
      "esc-selection",
    );
  });

  it("returns null when nothing is open — deeper panels own their own Esc", () => {
    expect(hotkeyIntent(esc, layers())).toBeNull();
  });
});

describe("intentPreventsDefault", () => {
  it("chord intents swallow the browser default, Esc intents don't", () => {
    expect(intentPreventsDefault("open-filter")).toBe(true);
    expect(intentPreventsDefault("zoom-in")).toBe(true);
    expect(intentPreventsDefault("toggle-palette")).toBe(true);
    expect(intentPreventsDefault("esc-palette")).toBe(false);
    expect(intentPreventsDefault("esc-selection")).toBe(false);
  });
});
