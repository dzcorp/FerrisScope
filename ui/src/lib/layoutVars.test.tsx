import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { PUBLISH_SETTLE_MS, usePublishedSize } from "./layoutVars";

let resize: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) {
    resize = cb;
  }
  observe() {}
  disconnect() {
    resize = null;
  }
}

let boxHeight = 0;
function Box({ enabled }: { enabled: boolean }) {
  const [ref] = usePublishedSize<HTMLDivElement>("--test-h", "height", enabled);
  return (
    <div
      ref={(el) => {
        if (el) el.getBoundingClientRect = () => ({ height: boxHeight, width: 0 }) as DOMRect;
        ref(el);
      }}
    />
  );
}

const read = () => document.documentElement.style.getPropertyValue("--test-h");

describe("usePublishedSize", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes while enabled, follows resizes, and clears after", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    boxHeight = 240;
    const { rerender, unmount } = render(<Box enabled />);
    expect(read()).toBe("240px");

    vi.useFakeTimers();
    boxHeight = 300;
    resize?.();
    // Settles before publishing: no per-frame root restyle while dragging.
    expect(read()).toBe("240px");
    vi.advanceTimersByTime(PUBLISH_SETTLE_MS);
    expect(read()).toBe("300px");
    vi.useRealTimers();

    rerender(<Box enabled={false} />);
    expect(read()).toBe("");

    boxHeight = 120;
    rerender(<Box enabled />);
    expect(read()).toBe("120px");
    unmount();
    expect(read()).toBe("");
  });
});
