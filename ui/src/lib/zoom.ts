// Placement helpers for `position: fixed` portals.
//
// History: this module used to compensate for CSS `style.zoom` applied to
// the document root — which Chromium/WebKitGTK and macOS WebKit treat
// differently. macOS WebKit scaled paint only (not layout), so coordinates
// from `getBoundingClientRect()` and `clientX/Y` lived in different spaces
// and `position: fixed` repainted writes × zoom. The helpers below divided
// each emitted coordinate by the right scale to land portals correctly.
//
// We've since switched to Tauri's native page-zoom API
// (`WebviewWindow.setZoom`), which maps to WKWebView `setPageZoom` on
// macOS, `webkit_web_view_set_zoom_level` on Linux, and the WebView2 zoom
// factor on Windows — all of which rescale layout *and* paint uniformly.
// Under native page zoom, every coordinate the page sees (cursor, rect,
// `innerWidth`, fixed-style write) is in the same space, so the divides
// collapse to identity and the engine-specific calibration probe is no
// longer needed.
//
// The helpers stay because they still own placement geometry (cursor
// anchoring, trigger anchoring, viewport clamping, side flipping). The
// `scale` parameter and the two getters below stay at `1` defensively in
// case a future surface re-introduces a non-native zoom transform.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Side = "top" | "bottom" | "left" | "right";

export type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

// Always 1 under native page zoom. Kept as a function (rather than a
// constant) so the call sites read naturally and we have one symbol to
// audit if a future feature ever stacks an extra paint transform on top.
export function rootZoom(): number {
  return 1;
}

// Kept for API stability; under native page zoom there's no rect/visual
// mismatch, so it's the same as `rootZoom()`. `resetFixedRectScaleCache()`
// stays for tests that still reach for it — it's a no-op now.
export function resetFixedRectScaleCache(): void {
  // no-op under native page zoom; retained for test compatibility.
}

export function fixedRectScale(): number {
  return 1;
}

// Cursor-anchored menu (right-click ContextMenu). `cursor` is the visual-px
// clientX/clientY; `menu` and `viewport` are in the same space. Returns the
// fixed-layer top/left, clamped 4px inside the viewport.
export function placeMenuAtCursor(
  cursor: Point,
  menu: Size,
  viewport: Size,
  scale: number,
): Point {
  const m = 4;
  let x = cursor.x;
  let y = cursor.y;
  if (x + menu.width > viewport.width - m) x = viewport.width - menu.width - m;
  if (y + menu.height > viewport.height - m) y = viewport.height - menu.height - m;
  x = Math.max(m, x);
  y = Math.max(m, y);
  return { x: x / scale, y: y / scale };
}

export type SelectPlacement = {
  x: number;
  y: number;
  w: number;
  maxH: number;
  flipUp: boolean;
};

// Trigger-anchored dropdown (Select). `trigger` and `viewport` share a
// coordinate space. `flipUp` anchors the popover bottom to the trigger top
// (style `bottom`), otherwise the popover top hangs below the trigger
// (style `top`).
export function placeSelectPopover(
  trigger: Rect,
  viewport: Size,
  opts: { popoverMinWidth?: number },
  scale: number,
): SelectPlacement {
  const margin = 8;
  const gap = 4;
  const below = viewport.height - trigger.bottom - margin;
  const above = trigger.top - margin;
  const flipUp = below < 200 && above > below;
  const maxH = Math.max(120, Math.min(360, flipUp ? above - gap : below - gap));
  const desiredW = Math.max(trigger.width, opts.popoverMinWidth ?? 0);
  const maxW = viewport.width - margin * 2;
  const w = Math.min(desiredW, maxW);
  let x = trigger.left;
  if (x + w > viewport.width - margin) {
    x = Math.max(margin, viewport.width - margin - w);
  }
  // Up: distance from the viewport bottom to the popover bottom edge. Down:
  // popover top edge just under the trigger.
  const y = flipUp ? viewport.height - trigger.top + gap : trigger.bottom + gap;
  return {
    x: x / scale,
    y: y / scale,
    w: w / scale,
    maxH: maxH / scale,
    flipUp,
  };
}

// Trigger-anchored tooltip. `trigger`, `tip` and `viewport` share a
// coordinate space. Picks the requested `side`, flips to the opposite side
// if it doesn't fit, then clamps. Returns top/left plus the side actually
// used (for the caller's arrow / styling).
export function placeTooltip(
  trigger: Rect,
  tip: Size,
  side: Side,
  viewport: Size,
  scale: number,
): { x: number; y: number; placedSide: Side } {
  const gap = 8;
  const margin = 6;
  const placements: Record<Side, Point> = {
    top: {
      x: trigger.left + trigger.width / 2 - tip.width / 2,
      y: trigger.top - tip.height - gap,
    },
    bottom: {
      x: trigger.left + trigger.width / 2 - tip.width / 2,
      y: trigger.bottom + gap,
    },
    left: {
      x: trigger.left - tip.width - gap,
      y: trigger.top + trigger.height / 2 - tip.height / 2,
    },
    right: {
      x: trigger.right + gap,
      y: trigger.top + trigger.height / 2 - tip.height / 2,
    },
  };
  const fits = (s: Side) => {
    const p = placements[s];
    return (
      p.x >= margin &&
      p.y >= margin &&
      p.x + tip.width <= viewport.width - margin &&
      p.y + tip.height <= viewport.height - margin
    );
  };
  const flipMap: Record<Side, Side> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };
  const chosen: Side = fits(side) ? side : fits(flipMap[side]) ? flipMap[side] : side;
  let { x, y } = placements[chosen];
  x = Math.max(margin, Math.min(x, viewport.width - tip.width - margin));
  y = Math.max(margin, Math.min(y, viewport.height - tip.height - margin));
  return { x: x / scale, y: y / scale, placedSide: chosen };
}
