import { describe, it, expect } from "vitest";
import { clientXToSvgX } from "./MetricsTab";

// Build a minimal SVGSVGElement-shaped stub. The chart renders the SVG
// with width=viewBoxWidth, then ancestor CSS zoom visually scales it by
// `zoom`. getBoundingClientRect reports the visually-scaled width since
// it's in the same coord system as clientX.
function makeSvgStub(opts: {
  viewBoxWidth: number;
  zoom: number;
  rectLeft: number;
  viewBoxAttr?: string;
}): SVGSVGElement {
  const { viewBoxWidth, zoom, rectLeft, viewBoxAttr } = opts;
  const renderedWidth = viewBoxWidth * zoom;
  return {
    viewBox: { baseVal: { x: 0, y: 0, width: viewBoxWidth, height: 130 } },
    getAttribute: (name: string) => {
      if (name === "viewBox") {
        return viewBoxAttr !== undefined ? viewBoxAttr : `0 0 ${viewBoxWidth} 130`;
      }
      return null;
    },
    getBoundingClientRect: () => ({
      left: rectLeft,
      top: 0,
      right: rectLeft + renderedWidth,
      bottom: 130 * zoom,
      width: renderedWidth,
      height: 130 * zoom,
      x: rectLeft,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as SVGSVGElement;
}

describe("clientXToSvgX", () => {
  it("maps client coords 1:1 into viewBox space with no zoom", () => {
    // viewBox 0..560, no zoom, rect 0..560. Cursor at screen x=280
    // should land at viewBox x=280.
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1, rectLeft: 0 });
    expect(clientXToSvgX(svg, 280)).toBeCloseTo(280, 5);
    expect(clientXToSvgX(svg, 0)).toBeCloseTo(0, 5);
    expect(clientXToSvgX(svg, 560)).toBeCloseTo(560, 5);
  });

  it("scales the cursor back to viewBox space under CSS zoom", () => {
    // UI Scale slider applies zoom=1.5 to <html>: the chart renders at
    // 840 screen px, but viewBox stays 0..560. Cursor at the visual
    // midpoint (screen x=420) must map to viewBox x=280 — the previous
    // implementation returned 420 here, which is what made the
    // crosshair land to the right of the cursor.
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1.5, rectLeft: 0 });
    expect(clientXToSvgX(svg, 420)).toBeCloseTo(280, 5);
    expect(clientXToSvgX(svg, 840)).toBeCloseTo(560, 5);
  });

  it("scales correctly under a different zoom factor", () => {
    // zoom=0.8 (UI Scale down). Visual width = 448. Cursor at the
    // visual midpoint (224) maps to viewBox x=280.
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 0.8, rectLeft: 0 });
    expect(clientXToSvgX(svg, 224)).toBeCloseTo(280, 5);
  });

  it("accounts for the SVG's left offset on the page", () => {
    // Chart sits 200px from the left of the viewport, zoom=1.25 —
    // visual width = 700, visual midpoint = 200 + 350 = 550. viewBox
    // x should be 280.
    const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1.25, rectLeft: 200 });
    expect(clientXToSvgX(svg, 550)).toBeCloseTo(280, 5);
    expect(clientXToSvgX(svg, 200)).toBeCloseTo(0, 5);
    expect(clientXToSvgX(svg, 900)).toBeCloseTo(560, 5);
  });

  it("uses the viewBox attribute over stale viewBox.baseVal under WebKit/Tauri", () => {
    // Under WebKit/Tauri, viewBox.baseVal can be stale (e.g. 560) after resize,
    // but the viewBox attribute itself gets updated (e.g. 800).
    const svg = {
      viewBox: { baseVal: { x: 0, y: 0, width: 560, height: 130 } },
      getAttribute: (name: string) => (name === "viewBox" ? "0 0 800 130" : null),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 130,
        width: 800,
        height: 130,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as unknown as SVGSVGElement;

    // Cursor at visual midpoint (400) should map to 400 (halfway of 800).
    // If it used stale baseVal (560), it would map to 280.
    expect(clientXToSvgX(svg, 400)).toBeCloseTo(400, 5);
  });

  it("scales correctly under WebKit/Tauri CSS zoom behavior (unzoomed bounding rect)", () => {
    // Under WebKit/Tauri, document.documentElement.style.zoom is set to 1.5.
    // getBoundingClientRect reports unzoomed width (560) and left (0),
    // but cursor clientX is reported in zoomed visual coordinates (midpoint = 420).
    const prevZoom = document.documentElement.style.zoom;
    document.documentElement.style.zoom = "1.5";
    try {
      const svg = makeSvgStub({ viewBoxWidth: 560, zoom: 1, rectLeft: 0 }); // rect.width is 560
      expect(clientXToSvgX(svg, 420)).toBeCloseTo(280, 5);
      expect(clientXToSvgX(svg, 840)).toBeCloseTo(560, 5);
    } finally {
      document.documentElement.style.zoom = prevZoom;
    }
  });
});
