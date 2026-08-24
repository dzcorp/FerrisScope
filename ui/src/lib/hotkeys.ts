// Global hotkey dispatch, extracted from App.tsx's window keydown handler
// into a pure resolver so every chord is unit-testable across platforms
// (macOS ⌘ vs Windows/Linux Ctrl) and keyboard layouts. App.tsx maps the
// returned intent onto store actions; nothing here touches React or the DOM.

import { latinLetter } from "./keyboard";

/// Structural shape of the keyboard event — accepts both the native
/// `KeyboardEvent` and React's synthetic one.
export type HotkeyEvent = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type HotkeyLayers = {
  /// True when any cluster scope is active — a single selected context, a
  /// virtual context, or an ad-hoc multi-cluster view. Gates the
  /// table/namespace/dock shortcuts. Deliberately NOT "a context is
  /// selected": virtual-context views keep `selectedContext` null while
  /// mounting the same table and namespace modal.
  scopeActive: boolean;
  paletteOpen: boolean;
  addMenuOpen: boolean;
  settingsOpen: boolean;
  nsModalOpen: boolean;
  filterEditing: boolean;
  hasSelection: boolean;
  /// A right-hand drawer (detail / logs / compare / inspect) is open. Those
  /// close themselves on Esc, so App must NOT also consume it — otherwise one
  /// Esc closes the drawer AND wipes the selection the drawer was showing.
  drawerOpen: boolean;
  /// The event target sits inside an input / textarea / contenteditable —
  /// suppresses the bare `/` shortcut so typing slashes keeps working.
  inTextInput: boolean;
};

export type HotkeyIntent =
  | "toggle-palette"
  | "open-filter"
  | "open-ns-modal"
  | "open-settings"
  | "toggle-theme"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "new-terminal"
  | "new-yaml"
  | "esc-add-menu"
  | "esc-palette"
  | "esc-filter"
  | "esc-settings"
  | "esc-ns-modal"
  | "esc-selection";

/// Resolve a keydown into a global-shortcut intent, or null when the event
/// isn't ours. Every chord accepts either Cmd or Ctrl (`metaKey || ctrlKey`)
/// so the same handler serves macOS and Windows/Linux; `latinLetter`
/// resolves the physical Latin letter regardless of active keyboard layout
/// (Cmd+F on a Russian / Greek / Hebrew layout otherwise misses because
/// `e.key` is the localized character, not "f").
export function hotkeyIntent(
  e: HotkeyEvent,
  l: HotkeyLayers,
): HotkeyIntent | null {
  const meta = e.metaKey || e.ctrlKey;
  const letter = latinLetter(e);
  if (meta && letter === "k") return "toggle-palette";
  // Cmd/Ctrl+F — open the inline filter input in the breadcrumb. Mirrors
  // browsers' "find on page"; only fires when a kind table is mounted.
  if (meta && letter === "f" && l.scopeActive) return "open-filter";
  // `/` (vim-style) — same as Cmd+F, but only outside text inputs.
  if (
    e.key === "/" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    l.scopeActive &&
    !l.inTextInput
  ) {
    return "open-filter";
  }
  // Same scope gate as the namespace modal's render condition, so the
  // shortcut works in virtual-context views too.
  if (meta && letter === "i" && l.scopeActive) return "open-ns-modal";
  if (meta && e.key === ",") return "open-settings";
  if (meta && e.shiftKey && letter === "l") return "toggle-theme";
  // Global UI scale. `=` is matched alongside `+` because `+` requires
  // Shift on most layouts and platform keymaps surface the unshifted key.
  if (meta && (e.key === "+" || e.key === "=")) return "zoom-in";
  if (meta && (e.key === "-" || e.key === "_")) return "zoom-out";
  if (meta && e.key === "0") return "zoom-reset";
  if (meta && e.key === "`" && l.scopeActive) return "new-terminal";
  if (meta && e.shiftKey && letter === "y" && l.scopeActive) return "new-yaml";

  // R-13: Esc cascades from the deepest layer outward. The right-hand drawers
  // register their own Esc to close themselves, so `drawerOpen` stops this
  // resolver from consuming the same keypress for a shallower layer.
  if (e.key === "Escape") {
    if (l.addMenuOpen) return "esc-add-menu";
    if (l.paletteOpen) return "esc-palette";
    if (l.filterEditing) return "esc-filter";
    if (l.settingsOpen) return "esc-settings";
    if (l.nsModalOpen) return "esc-ns-modal";
    if (l.hasSelection && !l.drawerOpen) return "esc-selection";
  }
  return null;
}

/// Chord intents swallow the browser default (Cmd+F find-on-page, Ctrl+-
/// browser zoom, …); Esc intents don't — Esc's default is harmless and
/// inputs may want it.
export function intentPreventsDefault(intent: HotkeyIntent): boolean {
  return !intent.startsWith("esc-");
}
