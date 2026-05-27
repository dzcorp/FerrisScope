import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Control IS_MAC per-test. Off macOS the header is a single row (brand +
// breadcrumb + controls). On macOS the layout splits into two rows: row 1 is
// right-aligned (controls + breadcrumb), row 2 holds the brand alone on the
// left below the OS traffic lights.
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

  it("splits into two rows on macOS: controls + breadcrumb up top, brand below", () => {
    platform.isMac = true;
    const { container, getByText } = renderHeader();
    const shell = container.firstChild as HTMLElement;
    expect(shell.children).toHaveLength(2);
    const topRow = shell.children[0] as HTMLElement;
    const brandRow = shell.children[1] as HTMLElement;
    // Top row: controls + breadcrumb (no brand). PaddingTop clears the OS
    // traffic lights (~14px tall at y≈14).
    expect(topRow.contains(getByText("Clusters"))).toBe(true);
    expect(topRow.contains(getByText("FerrisScope"))).toBe(false);
    expect(parseInt(topRow.style.paddingTop, 10)).toBeGreaterThanOrEqual(28);
    // Bottom row: brand alone, aligned with the leftmost traffic light at
    // 12px paddingLeft (not the standard 22px gutter).
    expect(brandRow.contains(getByText("FerrisScope"))).toBe(true);
    expect(brandRow.contains(getByText("Clusters"))).toBe(false);
    expect(brandRow.style.paddingLeft).toBe("12px");
    // Both rows act as window drag handles on macOS.
    expect(topRow.getAttribute("data-tauri-drag-region")).not.toBeNull();
    expect(brandRow.getAttribute("data-tauri-drag-region")).not.toBeNull();
  });

  it("keeps a single row with the standard gutter and no drag region off macOS", () => {
    platform.isMac = false;
    const { container } = renderHeader();
    const shell = container.firstChild as HTMLElement;
    expect(shell.children).toHaveLength(1);
    const r = row(container);
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
