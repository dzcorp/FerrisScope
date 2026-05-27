import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Control IS_MAC per-test. The header is a single row everywhere. On macOS
// the brand is wrapped in its own block that is `transform: translateY` nudged
// down so it tucks beneath the integrated transparent title bar's traffic
// lights, and the divider between brand and breadcrumb is dropped (the
// vertical offset already separates them).
// AppHeader reads IS_MAC directly (and macChrome reads it too) — a
// getter-backed override on the keyboard module lets one file flip the value
// at render time while the rest of the module stays real.
const platform = vi.hoisted(() => ({ isMac: false }));
vi.mock("../lib/keyboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/keyboard")>();
  return {
    ...actual,
    get IS_MAC() {
      return platform.isMac;
    },
  };
});

import { AppHeader } from "./AppHeader";

const noop = () => {};

function renderHeader() {
  return render(
    <AppHeader
      mode="dark"
      context={null}
      selectedKindLabel={null}
      unreadNotifications={0}
      activeForwards={0}
      onHome={noop}
      onPalette={noop}
      onToggleTheme={noop}
      onOpenNotifications={noop}
      onOpenSettings={noop}
      onOpenForwards={noop}
    />,
  );
}

function row(container: HTMLElement): HTMLElement {
  return (container.firstChild as HTMLElement).firstElementChild as HTMLElement;
}

afterEach(() => {
  cleanup();
  platform.isMac = false;
});

describe("AppHeader layout", () => {
  it("is a single row holding brand, breadcrumb and controls", () => {
    const { container, getByText } = renderHeader();
    const shell = container.firstChild as HTMLElement;
    expect(shell.children).toHaveLength(1);
    const r = row(container);
    expect(r.contains(getByText("FerrisScope"))).toBe(true);
    expect(r.contains(getByText("Clusters"))).toBe(true);
    expect(r.contains(getByText(/Search clusters/))).toBe(true);
  });

  it("nudges the brand block down beneath the traffic lights on macOS", () => {
    platform.isMac = true;
    const { container, getByText } = renderHeader();
    const r = row(container);
    // Single row still; the brand sits in the first child wrapper with a
    // translateY transform that tucks it under the OS traffic lights.
    const brandWrapper = r.firstElementChild as HTMLElement;
    expect(brandWrapper.contains(getByText("FerrisScope"))).toBe(true);
    expect(brandWrapper.style.transform).toMatch(/translateY\(\d+px\)/);
    // The brand-breadcrumb divider is dropped on macOS — the vertical
    // offset already separates the two visually.
    const divider = r.querySelector('div[style*="width: 1px"]');
    expect(divider).toBeNull();
    // Row gutter drops back to the normal 22px since the brand is now
    // visually beneath the lights, not next to them.
    expect(r.style.paddingLeft).toBe("22px");
    // Drag region stays on the row so the header still moves the window.
    expect(r.getAttribute("data-tauri-drag-region")).not.toBeNull();
  });

  it("uses the normal gutter, keeps the divider and no drag region off macOS", () => {
    platform.isMac = false;
    const { container } = renderHeader();
    const r = row(container);
    const brandWrapper = r.firstElementChild as HTMLElement;
    expect(brandWrapper.style.transform === "" || brandWrapper.style.transform === "none").toBe(
      true,
    );
    expect(r.querySelector('div[style*="width: 1px"]')).not.toBeNull();
    expect(r.style.paddingLeft).toBe("22px");
    expect(r.getAttribute("data-tauri-drag-region")).toBeNull();
  });

  it("paints a translucent (vibrancy) header background on macOS", () => {
    platform.isMac = true;
    const { container } = renderHeader();
    const shell = container.firstChild as HTMLElement;
    // rgba(...) ⇒ the NSVisualEffectView material shows through behind the
    // traffic lights so dimmed inactive buttons stay visible on light themes.
    expect(shell.style.background).toContain("rgba");
  });

  it("keeps an opaque header background off macOS", () => {
    platform.isMac = false;
    const { container } = renderHeader();
    const shell = container.firstChild as HTMLElement;
    expect(shell.style.background).not.toContain("rgba");
  });
});
