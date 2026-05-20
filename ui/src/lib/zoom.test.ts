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

// A fixed portal under `documentElement.style.zoom` is repainted × zoom, while
// the inputs (getBoundingClientRect / clientX / innerWidth) are visual px. Each
// helper does its math in visual px, then divides emitted coordinates by zoom
// so the painted portal lands back at the intended visual geometry.

afterEach(() => {
  document.documentElement.style.zoom = "";
  resetFixedRectScaleCache();
  vi.restoreAllMocks();
});

describe("rootZoom", () => {
  it("returns 1 when zoom is unset", () => {
    expect(rootZoom()).toBe(1);
  });
  it("parses the applied zoom", () => {
    document.documentElement.style.zoom = "1.1";
    expect(rootZoom()).toBeCloseTo(1.1, 5);
  });
  it("falls back to 1 for non-positive / unparseable values", () => {
    document.documentElement.style.zoom = "0";
    expect(rootZoom()).toBe(1);
    document.documentElement.style.zoom = "nonsense";
    expect(rootZoom()).toBe(1);
  });
});

describe("fixedRectScale", () => {
  // Stub how the engine reports a fixed element's width. The probe sets
  // width:1000px; the ratio is reportedWidth / 1000.
  function stubProbeWidth(reported: number) {
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: reported,
      height: 0,
      top: 0,
      left: 0,
      right: reported,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it("falls back to rootZoom when the probe can't be measured (jsdom → 0)", () => {
    document.documentElement.style.zoom = "1.1";
    // jsdom reports 0-size rects; ratio is unmeasurable → fall back to zoom.
    expect(fixedRectScale()).toBeCloseTo(1.1, 5);
  });

  it("returns the paint zoom on engines that report rects in visual px", () => {
    document.documentElement.style.zoom = "1.1";
    stubProbeWidth(1000 * 1.1); // visual: 1000css × 1.1 paint, reported as visual
    expect(fixedRectScale()).toBeCloseTo(1.1, 5);
  });

  it("returns 1 on engines that report rects unzoomed", () => {
    document.documentElement.style.zoom = "1.1";
    stubProbeWidth(1000); // unzoomed: reported as the css px we set
    expect(fixedRectScale()).toBeCloseTo(1, 5);
  });

  it("caches per zoom value", () => {
    document.documentElement.style.zoom = "1.2";
    const spy = vi
      .spyOn(HTMLDivElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 1200, height: 0 } as DOMRect);
    expect(fixedRectScale()).toBeCloseTo(1.2, 5); // 1200 / 1000
    expect(fixedRectScale()).toBeCloseTo(1.2, 5);
    expect(spy).toHaveBeenCalledTimes(1); // second call served from cache
  });
});

describe("placeMenuAtCursor", () => {
  const menu = { width: 210, height: 120 };
  const viewport = { width: 1000, height: 800 };

  it("passes the cursor through unchanged at zoom 1", () => {
    expect(placeMenuAtCursor({ x: 300, y: 200 }, menu, viewport, 1)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it("divides the visual cursor by zoom so the repaint lands on it", () => {
    // Visual cursor (330, 220) under zoom 1.1 → fixed (300, 200); the root
    // repaints × 1.1 → back to (330, 220) visual.
    const p = placeMenuAtCursor({ x: 330, y: 220 }, menu, viewport, 1.1);
    expect(p.x).toBeCloseTo(300, 5);
    expect(p.y).toBeCloseTo(200, 5);
  });

  it("clamps to the right/bottom edge in visual space before dividing", () => {
    // Visual: x 980 + 210 > 996 → 786; y 780 + 120 > 796 → 676. Then / 1.1.
    const p = placeMenuAtCursor({ x: 980, y: 780 }, menu, viewport, 1.1);
    expect(p.x).toBeCloseTo(786 / 1.1, 5);
    expect(p.y).toBeCloseTo(676 / 1.1, 5);
  });

  it("keeps a 4px visual margin at the top-left", () => {
    const p = placeMenuAtCursor({ x: 0, y: 0 }, menu, viewport, 1.1);
    expect(p.x).toBeCloseTo(4 / 1.1, 5);
    expect(p.y).toBeCloseTo(4 / 1.1, 5);
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

  it("anchors below the trigger and matches its width at zoom 1", () => {
    const p = placeSelectPopover(trigger, viewport, {}, 1);
    expect(p.flipUp).toBe(false);
    expect(p.x).toBe(200);
    expect(p.y).toBe(124 + 4); // bottom + gap
    expect(p.w).toBe(160);
  });

  it("divides x/y/w/maxH by zoom so the fixed popover lands on the trigger", () => {
    const p = placeSelectPopover(trigger, viewport, {}, 1.1);
    expect(p.x).toBeCloseTo(200 / 1.1, 5);
    expect(p.y).toBeCloseTo(128 / 1.1, 5);
    expect(p.w).toBeCloseTo(160 / 1.1, 5);
    // maxH = clamp(800 - 124 - 8 - 4, 120, 360) = 360, then / zoom.
    expect(p.maxH).toBeCloseTo(360 / 1.1, 5);
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

  it("centers below the trigger for side=bottom at zoom 1", () => {
    const p = placeTooltip(trigger, tip, "bottom", viewport, 1);
    expect(p.placedSide).toBe("bottom");
    expect(p.x).toBe(400 + 20 - 50); // center - tip/2
    expect(p.y).toBe(320 + 8); // bottom + gap
  });

  it("divides the result by zoom", () => {
    const p = placeTooltip(trigger, tip, "bottom", viewport, 1.1);
    expect(p.x).toBeCloseTo(370 / 1.1, 5);
    expect(p.y).toBeCloseTo(328 / 1.1, 5);
  });

  it("flips to bottom when top does not fit", () => {
    const high: Rect = { ...trigger, top: 10, bottom: 30 };
    const p = placeTooltip(high, tip, "top", viewport, 1);
    expect(p.placedSide).toBe("bottom");
  });
});
