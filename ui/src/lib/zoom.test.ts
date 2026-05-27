import { describe, it, expect, afterEach, vi } from "vitest";
import {
  rootZoom,
  fixedRectScale,
  resetFixedRectScaleCache,
  placeMenuAtCursor,
  placeSelectPopover,
  placeTooltip,
  type Rect,
} from "./zoom";

// Under Tauri's native page zoom (WebviewWindow.setZoom), layout and paint
// scale together on every engine, so coordinates and rects live in the same
// space. The scale-returning helpers therefore stay at 1. The placement
// helpers still respect the `scale` parameter as a contract — callers pass
// 1 today, but the divide stays in place defensively in case a future
// surface stacks a non-native transform on top.

afterEach(() => {
  document.documentElement.style.zoom = "";
  resetFixedRectScaleCache();
  vi.restoreAllMocks();
});

describe("rootZoom", () => {
  it("returns 1 under native page zoom regardless of style.zoom", () => {
    expect(rootZoom()).toBe(1);
    document.documentElement.style.zoom = "1.1";
    expect(rootZoom()).toBe(1);
    document.documentElement.style.zoom = "0.8";
    expect(rootZoom()).toBe(1);
  });
});

describe("fixedRectScale", () => {
  it("returns 1 under native page zoom regardless of style.zoom or rect probing", () => {
    expect(fixedRectScale()).toBe(1);
    document.documentElement.style.zoom = "1.1";
    expect(fixedRectScale()).toBe(1);
  });

  it("resetFixedRectScaleCache is a safe no-op", () => {
    expect(() => resetFixedRectScaleCache()).not.toThrow();
  });
});

describe("placeMenuAtCursor", () => {
  const menu = { width: 210, height: 120 };
  const viewport = { width: 1000, height: 800 };

  it("passes the cursor through unchanged at scale 1", () => {
    expect(placeMenuAtCursor({ x: 300, y: 200 }, menu, viewport, 1)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it("clamps to the right/bottom edge inside the viewport", () => {
    // x 980 + 210 > 996 → 786; y 780 + 120 > 796 → 676.
    const p = placeMenuAtCursor({ x: 980, y: 780 }, menu, viewport, 1);
    expect(p.x).toBe(786);
    expect(p.y).toBe(676);
  });

  it("keeps a 4px margin at the top-left", () => {
    const p = placeMenuAtCursor({ x: 0, y: 0 }, menu, viewport, 1);
    expect(p.x).toBe(4);
    expect(p.y).toBe(4);
  });

  it("divides the clamped coords by the scale parameter (defensive contract)", () => {
    // Verifies the helper respects the `scale` arg even though native page
    // zoom means callers pass 1 today.
    const p = placeMenuAtCursor({ x: 330, y: 220 }, menu, viewport, 1.1);
    expect(p.x).toBeCloseTo(300, 5);
    expect(p.y).toBeCloseTo(200, 5);
  });
});

describe("placeSelectPopover", () => {
  const viewport = { width: 1000, height: 800 };
  const trigger: Rect = {
    left: 200,
    right: 360,
    top: 100,
    bottom: 124,
    width: 160,
    height: 24,
  };

  it("anchors below the trigger and matches its width at scale 1", () => {
    const p = placeSelectPopover(trigger, viewport, {}, 1);
    expect(p.flipUp).toBe(false);
    expect(p.x).toBe(200);
    expect(p.y).toBe(124 + 4); // bottom + gap
    expect(p.w).toBe(160);
  });

  it("flips up when there is little room below, anchoring from the bottom", () => {
    const low: Rect = { ...trigger, top: 720, bottom: 744 };
    const p = placeSelectPopover(low, viewport, {}, 1);
    expect(p.flipUp).toBe(true);
    // y = innerHeight - top + gap = 800 - 720 + 4 (distance from viewport bottom)
    expect(p.y).toBe(84);
  });

  it("honours popoverMinWidth and clamps x within the viewport", () => {
    const nearRight: Rect = { ...trigger, left: 900, right: 960, width: 60 };
    const p = placeSelectPopover(nearRight, viewport, { popoverMinWidth: 300 }, 1);
    expect(p.w).toBe(300);
    // 900 + 300 > 992 → x = 1000 - 8 - 300 = 692
    expect(p.x).toBe(692);
  });

  it("divides x/y/w/maxH by the scale parameter (defensive contract)", () => {
    const p = placeSelectPopover(trigger, viewport, {}, 1.1);
    expect(p.x).toBeCloseTo(200 / 1.1, 5);
    expect(p.y).toBeCloseTo(128 / 1.1, 5);
    expect(p.w).toBeCloseTo(160 / 1.1, 5);
    // maxH = clamp(800 - 124 - 8 - 4, 120, 360) = 360, then / scale.
    expect(p.maxH).toBeCloseTo(360 / 1.1, 5);
  });
});

describe("placeTooltip", () => {
  const viewport = { width: 1000, height: 800 };
  const trigger: Rect = {
    left: 400,
    right: 440,
    top: 300,
    bottom: 320,
    width: 40,
    height: 20,
  };
  const tip = { width: 100, height: 30 };

  it("centers below the trigger for side=bottom at scale 1", () => {
    const p = placeTooltip(trigger, tip, "bottom", viewport, 1);
    expect(p.placedSide).toBe("bottom");
    expect(p.x).toBe(400 + 20 - 50); // center - tip/2
    expect(p.y).toBe(320 + 8); // bottom + gap
  });

  it("flips to bottom when top does not fit", () => {
    const high: Rect = { ...trigger, top: 10, bottom: 30 };
    const p = placeTooltip(high, tip, "top", viewport, 1);
    expect(p.placedSide).toBe("bottom");
  });

  it("divides the result by the scale parameter (defensive contract)", () => {
    const p = placeTooltip(trigger, tip, "bottom", viewport, 1.1);
    expect(p.x).toBeCloseTo(370 / 1.1, 5);
    expect(p.y).toBeCloseTo(328 / 1.1, 5);
  });
});
