// Positioning helpers for `position: fixed` portals under the global UI scale.
//
// App.tsx applies the UI scale as `document.documentElement.style.zoom`
// (= uiScale * UI_SCALE_BASELINE; baseline 1.1, so the default is already
// >1.0). A `position: fixed` portal is a descendant of that zoomed root, so the
// browser repaints its `top/left/width/height` coordinates × zoom (the "paint
// scale", which is exactly the numeric `style.zoom`).
//
// The inputs we measure from are reported differently per engine:
//   - `clientX/clientY` (the mouse) are *visual* (post-zoom) px on every engine.
//   - `getBoundingClientRect()` / `innerWidth` are visual on WebKitGTK (Linux)
//     and modern Blink/WebView2, but the MetricsTab notes that macOS WebKit can
//     report them *unzoomed*. So we can't assume rect == visual everywhere.
//
// The rule these helpers enforce: do all placement math in the same space the
// inputs come in, then divide every coordinate written to the fixed portal by
// the appropriate scale so the portal lands where intended once the root
// repaints it × zoom:
//   - cursor-anchored menus divide by the *paint scale* (`rootZoom()`), because
//     the cursor is visual on all engines.
//   - trigger-anchored menus divide by the *measured rect scale*
//     (`fixedRectScale()`), which self-calibrates: it equals the paint scale on
//     engines that report rects in visual px, and 1 where rects are unzoomed.
//
// Pure placement fns take the scale as a parameter so they stay testable; the
// React call sites pass `rootZoom()` or `fixedRectScale()` as appropriate.

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

// Active root zoom (paint scale). Falls back to 1 when unset / unparseable
// (jsdom in tests, first paint before App.tsx writes it).
export function rootZoom(): number {
  const z = Number.parseFloat(document.documentElement.style.zoom || "");
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// Measured ratio between what `getBoundingClientRect()` reports for a
// `position: fixed` element and the CSS px we set on it. This is the divisor
// trigger-anchored portals need, and it works regardless of whether the engine
// reports rects in visual px (ratio == paint zoom) or unzoomed px (ratio == 1)
// — because the probe is measured the exact same way the real triggers are.
//
// Cached per zoom value (the ratio only changes when the scale changes); call
// `resetFixedRectScaleCache()` in tests. Falls back to `rootZoom()` when the
// probe can't be measured (jsdom reports 0-size rects).
const PROBE_PX = 1000;
let probeCache: { key: string; value: number } | null = null;

export function resetFixedRectScaleCache(): void {
  probeCache = null;
}

export function fixedRectScale(): number {
  const key = document.documentElement.style.zoom || "";
  if (probeCache && probeCache.key === key) return probeCache.value;
  let value = rootZoom();
  const body = document.body;
  if (body) {
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.left = "0";
    probe.style.top = "0";
    probe.style.width = `${PROBE_PX}px`;
    probe.style.height = "0";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    body.appendChild(probe);
    const measured = probe.getBoundingClientRect().width;
    body.removeChild(probe);
    if (Number.isFinite(measured) && measured > 0) value = measured / PROBE_PX;
  }
  probeCache = { key, value };
  return value;
}

// Cursor-anchored menu (right-click ContextMenu). `cursor` is the visual-px
// clientX/clientY; `menu` and `viewport` are visual px. Returns the fixed-layer
// top/left in pre-zoom px, clamped 4px inside the viewport.
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

// Trigger-anchored dropdown (Select). `trigger` and `viewport` are visual px.
// `flipUp` anchors the popover bottom to the trigger top (style `bottom`),
// otherwise the popover top hangs below the trigger (style `top`). All emitted
// pixel values (x, y, w, maxH) are pre-zoom px ready for the fixed style.
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

// Trigger-anchored tooltip. `trigger`, `tip` and `viewport` are visual px.
// Picks the requested `side`, flips to the opposite side if it doesn't fit,
// then clamps. Returns the fixed-layer top/left in pre-zoom px plus the side
// actually used (for the caller's arrow / styling).
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
