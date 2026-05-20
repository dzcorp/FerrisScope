import { describe, it, expect } from "vitest";
import {
  MAC_TRAFFIC_LIGHT_INSET_PX,
  headerPaddingLeft,
  dragRegionProps,
} from "./macChrome";

describe("headerPaddingLeft", () => {
  it("reserves the traffic-light inset on macOS", () => {
    expect(headerPaddingLeft(22, true)).toBe(MAC_TRAFFIC_LIGHT_INSET_PX);
  });

  it("uses the caller's normal gutter off macOS", () => {
    expect(headerPaddingLeft(22, false)).toBe(22);
  });

  it("inset clears the traffic-light buttons but hugs them (no big gap)", () => {
    // 3 buttons (~14px) from x≈16 ⇒ rightmost edge ≈68px. The inset must
    // clear that, yet stay tight so adjacent content hugs the lights rather
    // than floating off to the right.
    expect(MAC_TRAFFIC_LIGHT_INSET_PX).toBeGreaterThanOrEqual(70);
    expect(MAC_TRAFFIC_LIGHT_INSET_PX).toBeLessThanOrEqual(76);
  });
});

describe("dragRegionProps", () => {
  it("emits the Tauri drag-region attribute on macOS", () => {
    expect(dragRegionProps(true)).toEqual({ "data-tauri-drag-region": true });
  });

  it("emits nothing off macOS so other platforms are untouched", () => {
    expect(dragRegionProps(false)).toEqual({});
  });
});
