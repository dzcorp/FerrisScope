import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Control IS_MAC per-test. The header is a single row everywhere; on macOS it
// shares the integrated transparent title bar with the OS traffic lights, so
// lib/macChrome insets it past them and turns it into a window drag handle.
// AppHeader no longer reads IS_MAC directly, but macChrome (which it imports)
// does — a getter-backed override on the keyboard module lets one file flip the
// value at render time while the rest of the module stays real.
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

  it("insets past the traffic lights and becomes a drag region on macOS", () => {
    platform.isMac = true;
    const { container } = renderHeader();
    const r = row(container);
    // 72px traffic-light inset from lib/macChrome.
    expect(r.style.paddingLeft).toBe("72px");
    expect(r.getAttribute("data-tauri-drag-region")).not.toBeNull();
  });

  it("uses the normal gutter and no drag region off macOS", () => {
    platform.isMac = false;
    const { container } = renderHeader();
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
