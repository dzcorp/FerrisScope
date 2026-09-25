import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { RAIL_COLLAPSED_W, RAIL_OPEN_W, useRailEdge } from "./railEdge";

const read = () => document.documentElement.style.getPropertyValue("--fs-rail-w");

describe("useRailEdge", () => {
  it("publishes the visible rail width and clears it when the rail goes away", () => {
    const { rerender, unmount } = renderHook(({ open }) => useRailEdge(open), {
      initialProps: { open: false },
    });
    expect(read()).toBe(`${RAIL_COLLAPSED_W}px`);
    rerender({ open: true });
    expect(read()).toBe(`${RAIL_OPEN_W}px`);
    unmount();
    expect(read()).toBe("");
  });
});
