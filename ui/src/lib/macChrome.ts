// macOS integrated title-bar helpers.
//
// On macOS the window keeps its *native* decorations (real OS traffic-light
// buttons, native drag/resize/fullscreen) but uses Tauri's `titleBarStyle:
// "Overlay"` (tauri.conf.json) — the same AppKit mechanism a native Swift app
// uses for an integrated toolbar window. The webview fills the whole window and
// the genuine OS buttons float over our own <AppHeader/>.
//
// So the header must (a) reserve a left inset for any row whose left-most
// content shares the traffic-light row, and (b) act as the window drag handle,
// since a transparent title bar has no native drag strip. These helpers
// centralise both so the platform branch lives in one tested place rather than
// inline in JSX.
//
// Linux draws a fully custom title bar instead (see TitleBar.tsx); Windows
// keeps the standard native bar. Neither needs these — hence the `isMac` gate
// defaulting to the runtime value.
import { IS_MAC } from "./keyboard";

// Width reserved at the top-left for the three macOS traffic-light buttons.
// At the default position the rightmost button edge sits at ~68px; 72 clears
// the buttons with just a few px to spare so adjacent content hugs them rather
// than floating off to the right with an awkward gap.
export const MAC_TRAFFIC_LIGHT_INSET_PX = 72;

// Left padding that clears the traffic lights on macOS, otherwise the caller's
// normal gutter. Use on any header row whose left-most content shares the
// traffic-light row.
export function headerPaddingLeft(
  normal: number,
  isMac: boolean = IS_MAC,
): number {
  return isMac ? MAC_TRAFFIC_LIGHT_INSET_PX : normal;
}

// Spread onto a header container / spacer to turn its empty area into a window
// drag handle on macOS. Interactive children (buttons, inputs) stay clickable —
// Tauri only drags when the click lands on the element carrying the attribute,
// not on its children. Returns nothing off macOS so other platforms are
// untouched (Linux drags via TitleBar.tsx; Windows uses the native bar).
export function dragRegionProps(isMac: boolean = IS_MAC): Record<string, true> {
  return isMac ? { "data-tauri-drag-region": true } : {};
}
