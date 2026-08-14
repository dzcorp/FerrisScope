import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { useAppStore } from "../store";

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
    // Row gutter drops to 12px to align the brand with the leftmost
    // traffic light, instead of the standard 22px gutter.
    expect(r.style.paddingLeft).toBe("12px");
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

describe("AppHeader cluster switcher", () => {
  const ctx = (id: string) => ({ id, name: id, source: "default" }) as never;

  function seedTwoTabs() {
    act(() => {
      useAppStore.setState({
        contexts: [ctx("default::alpha"), ctx("default::beta")],
        virtualContexts: [],
        kinds: [],
        openTabs: [],
        activeTabId: null,
      });
      useAppStore
        .getState()
        .openTab({ kind: "context", contextId: "default::alpha" });
      useAppStore
        .getState()
        .openTab({ kind: "context", contextId: "default::beta" });
    });
    return useAppStore;
  }

  it("shows a switcher dropdown on the active cluster name and switches", () => {
    const store = seedTwoTabs();
    const { getByText, queryByTestId, getAllByText } = render(
      <AppHeader
        mode="dark"
        context={ctx("default::beta")}
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
    // Closed initially.
    expect(queryByTestId("cluster-switcher-menu")).toBeNull();
    // Open via the cluster-name button (the breadcrumb shows "default::beta").
    fireEvent.click(getAllByText("default::beta")[0]!);
    const menu = queryByTestId("cluster-switcher-menu");
    expect(menu).toBeTruthy();
    // Must be a body-portaled fixed overlay above the dock (not absolute inside
    // the header's stacking context, which would paint behind the terminal),
    // and scroll when the cluster list is long.
    expect(menu!.parentElement).toBe(document.body);
    expect((menu as HTMLElement).style.position).toBe("fixed");
    expect((menu as HTMLElement).style.overflowY).toBe("auto");
    // Pick alpha from the menu → store switches.
    fireEvent.click(getByText("default::alpha"));
    expect(store.getState().selectedContext).toBe("default::alpha");
  });

  it("opens a new tab for an available (not-yet-open) cluster", () => {
    act(() => {
      useAppStore.setState({
        contexts: [ctx("default::alpha"), ctx("default::beta")],
        virtualContexts: [],
        kinds: [],
        openTabs: [],
        activeTabId: null,
      });
      // Only alpha is open; beta is available to add.
      useAppStore
        .getState()
        .openTab({ kind: "context", contextId: "default::alpha" });
    });
    const { getByText, getAllByText } = render(
      <AppHeader
        mode="dark"
        context={ctx("default::alpha")}
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
    fireEvent.click(getAllByText("default::alpha")[0]!);
    // beta appears under "Open another" → click adds it as a new tab.
    fireEvent.click(getByText("default::beta"));
    expect(useAppStore.getState().openTabs).toHaveLength(2);
    expect(useAppStore.getState().selectedContext).toBe("default::beta");
  });
});

describe("AppHeader short cluster names", () => {
  const GKE_OPEN = "gke_development-d83ab4a8_europe-west4_truenv-03";
  const GKE_OTHER = "gke_production-4f83b34d_us-central1_prod-6";
  const mkCtx = (name: string) => ({
    id: `default::${name}`,
    name,
    cluster: name,
    user: null,
    namespace: null,
    is_current: false,
    group: "Default",
    source_id: "default",
    source_path: null,
  });
  const open = mkCtx(GKE_OPEN);
  const other = mkCtx(GKE_OTHER);

  const renderWithFleet = () => {
    act(() => {
      useAppStore.setState({
        contexts: [open, other],
        virtualContexts: [],
        openTabs: [],
        activeTabId: null,
      });
      useAppStore
        .getState()
        .openTab({ kind: "context", contextId: open.id });
    });
    return render(
      <AppHeader
        mode="dark"
        context={open}
        selectedKindLabel="Pod"
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
  };

  it("renders the breadcrumb as the short name with the full one on hover", () => {
    const utils = renderWithFleet();
    expect(utils.getByText("truenv-03")).toBeTruthy();
    expect(utils.queryByText(GKE_OPEN)).toBeNull();
    expect(
      utils.getByTitle(`${GKE_OPEN} — switch or open a cluster`),
    ).toBeTruthy();
  });

  it("shortens the 'Open another' list and keeps the coordinate beside it", () => {
    const utils = renderWithFleet();
    fireEvent.click(utils.getByText("truenv-03"));
    // The unopened context is listed short, not as a 42-character string.
    expect(utils.getByText("prod-6")).toBeTruthy();
    expect(utils.queryByText(GKE_OTHER)).toBeNull();
    // …with the stripped coordinate dim next to it, so two clusters from
    // different projects stay distinguishable.
    expect(
      utils.getByText("production-4f83b34d · us-central1"),
    ).toBeTruthy();
    // Full name still recoverable on hover.
    expect(utils.getByTitle(GKE_OTHER)).toBeTruthy();
  });

  it("falls back to full names when shortening is off", () => {
    act(() => {
      useAppStore.getState().patchSettings({ shortenClusterNames: false });
    });
    const utils = renderWithFleet();
    expect(utils.getByText(GKE_OPEN)).toBeTruthy();
    expect(utils.queryByText("truenv-03")).toBeNull();
    act(() => {
      useAppStore.getState().patchSettings({ shortenClusterNames: true });
    });
  });
});
