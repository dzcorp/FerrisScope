// BrandMark is a single SVG glyph — small but it's the first thing the
// operator sees in the header. Pin the contract: renders, accepts size,
// and uses currentColor so callers control the tint.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("renders an SVG with currentColor fill and an aria-hidden attribute", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect(svg).toBeInTheDocument();
    expect(svg.getAttribute("fill")).toBe("currentColor");
    // aria-hidden lets screen readers skip the purely-decorative glyph.
    expect(svg.hasAttribute("aria-hidden")).toBe(true);
  });

  it("defaults to a 26px box and accepts an override", () => {
    const { container, rerender } = render(<BrandMark />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("26");
    rerender(<BrandMark size={48} />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("48");
    expect(container.querySelector("svg")!.getAttribute("height")).toBe("48");
  });
});
