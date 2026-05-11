// Tooltip is portal-rendered with a configurable show delay. We verify the
// behaviour that matters to operators:
//   - hover after delay shows the tooltip
//   - mouseleave hides it
//   - Escape closes it
//   - disabled / no-label early returns

import { describe, it, expect, vi } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  it("returns children unchanged when disabled", () => {
    const { container } = render(
      <Tooltip label="hi" disabled>
        <button>x</button>
      </Tooltip>,
    );
    // No portal, no extra <div role="tooltip"> — just the wrapped child.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("returns children unchanged when both label and kbd are empty", () => {
    const { container } = render(
      <Tooltip label="">
        <button>x</button>
      </Tooltip>,
    );
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("mouseenter after delay portals the tooltip into the body; mouseleave hides it", () => {
    vi.useFakeTimers();
    try {
      const { getByRole } = render(
        <Tooltip label="hint" delay={150}>
          <button>btn</button>
        </Tooltip>,
      );
      const btn = getByRole("button");

      // Before hover: no tooltip in the document.
      expect(document.querySelector('[role="tooltip"]')).toBeNull();

      fireEvent.mouseEnter(btn);
      // Still hidden until the delay elapses.
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

      // mouseleave hides the tooltip.
      fireEvent.mouseLeave(btn);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the kbd hint alongside the label", () => {
    vi.useFakeTimers();
    try {
      const { getByRole } = render(
        <Tooltip label="Search" kbd="⌘K" delay={0}>
          <button>x</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const tip = document.querySelector('[role="tooltip"]')!;
      expect(tip).toBeInTheDocument();
      expect(tip.textContent).toContain("Search");
      expect(tip.textContent).toContain("⌘K");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape closes the tooltip", () => {
    vi.useFakeTimers();
    try {
      const { getByRole } = render(
        <Tooltip label="hint" delay={0}>
          <button>x</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scroll closes the tooltip (so it doesn't follow the viewport)", () => {
    vi.useFakeTimers();
    try {
      const { getByRole } = render(
        <Tooltip label="hint" delay={0}>
          <button>x</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
      fireEvent.scroll(window);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards mouse / focus handlers on the wrapped child", () => {
    const onMouseEnter = vi.fn();
    const onFocus = vi.fn();
    const { getByRole } = render(
      <Tooltip label="hint" delay={9999}>
        <button onMouseEnter={onMouseEnter} onFocus={onFocus}>
          x
        </button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(getByRole("button"));
    fireEvent.focus(getByRole("button"));
    expect(onMouseEnter).toHaveBeenCalled();
    expect(onFocus).toHaveBeenCalled();
  });
});
