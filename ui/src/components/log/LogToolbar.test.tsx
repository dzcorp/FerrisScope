// Behaviour of the shared log control strip: container mute chips (aggregated
// merge view), the tail picker, single-pod container/previous controls, and the
// rich-status override the overlay panel relies on.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { tokens } from "../../theme";
import { LogToolbar } from "./LogToolbar";
import type { LogContainer } from "../../types";

const t = tokens("dark");

/// Container names → all-`main` `LogContainer[]`. Kind-specific behaviour has
/// its own cases below.
const mains = (names: string[]): LogContainer[] =>
  names.map((name) => ({ name, kind: "main" }));

describe("LogToolbar — aggregated mode", () => {
  it("renders a mute chip per container and toggles on click", () => {
    const onToggle = vi.fn();
    render(
      <LogToolbar
        t={t}
        mode={{
          kind: "aggregated",
          podCount: 3,
          selectedPodCount: 3,
          streamCount: 6,
          dropped: 0,
          universe: mains(["app", "istio-proxy"]),
          excluded: new Set(),
          onToggleContainer: onToggle,
          railOpen: false,
          onToggleRail: () => {},
        }}
        tailLines={200}
        onTailLines={() => {}}
        statusLabel="streaming"
        statusColor={t.good}
      />,
    );
    // Both container chips present, each marked "on" (included).
    const app = screen.getByRole("button", { name: /mute app/i });
    const proxy = screen.getByRole("button", { name: /mute istio-proxy/i });
    expect(app).toHaveAttribute("aria-pressed", "true");
    expect(proxy).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(proxy);
    expect(onToggle).toHaveBeenCalledWith("istio-proxy");
  });

  it("marks an excluded container as not-pressed", () => {
    render(
      <LogToolbar
        t={t}
        mode={{
          kind: "aggregated",
          podCount: 1,
          selectedPodCount: 3,
          streamCount: 1,
          dropped: 0,
          universe: mains(["app", "istio-proxy"]),
          excluded: new Set(["istio-proxy"]),
          onToggleContainer: () => {},
          railOpen: false,
          onToggleRail: () => {},
        }}
        tailLines={200}
        onTailLines={() => {}}
        statusLabel="streaming"
        statusColor={t.good}
      />,
    );
    // Muted chip's accessible name flips to "…click to include".
    const proxy = screen.getByRole("button", { name: /click to include/i });
    expect(proxy).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the over-cap count when streams were dropped", () => {
    render(
      <LogToolbar
        t={t}
        mode={{
          kind: "aggregated",
          podCount: 40,
          selectedPodCount: 3,
          streamCount: 24,
          dropped: 16,
          universe: mains(["app"]),
          excluded: new Set(),
          onToggleContainer: () => {},
          railOpen: false,
          onToggleRail: () => {},
        }}
        tailLines={200}
        onTailLines={() => {}}
        statusLabel="streaming"
        statusColor={t.good}
      />,
    );
    expect(screen.getByText(/\+16 over cap/)).toBeInTheDocument();
    // A single-container universe offers nothing to mute, so no chips.
    expect(
      screen.queryByRole("button", { name: /mute app/i }),
    ).not.toBeInTheDocument();
  });
});

describe("LogToolbar — theme adaptivity", () => {
  // Regression: the toolbar buttons must follow the active theme, not render
  // with the always-dark console tokens. An included mute chip paints with
  // `t.chip`, which differs between light and dark palettes.
  function chipBg(mode: "light" | "dark"): string | undefined {
    const tm = tokens(mode);
    const { unmount } = render(
      <LogToolbar
        t={tm}
        mode={{
          kind: "aggregated",
          podCount: 1,
          selectedPodCount: 3,
          streamCount: 2,
          dropped: 0,
          universe: mains(["app", "sidecar"]),
          excluded: new Set(),
          onToggleContainer: () => {},
          railOpen: false,
          onToggleRail: () => {},
        }}
        tailLines={200}
        onTailLines={() => {}}
        statusLabel="streaming"
        statusColor={tm.good}
      />,
    );
    const chip = screen.getByRole("button", { name: /mute app/i });
    const bg = chip.style.background;
    unmount();
    return bg;
  }

  it("paints mute chips differently in light vs dark (adapts to day/night)", () => {
    // jsdom normalises the hex token to rgb(), so compare the two modes to each
    // other rather than to the raw hex. They must differ, and neither may be
    // pure black — that was the "always black regardless of mode" report.
    const light = chipBg("light");
    const dark = chipBg("dark");
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    expect(light).not.toBe(dark);
    expect(light).not.toBe("rgb(0, 0, 0)");
    expect(dark).not.toBe("rgb(0, 0, 0)");
  });
});

describe("LogToolbar — single mode", () => {
  it("renders the tail label and wires the previous toggle", () => {
    const onPrev = vi.fn();
    render(
      <LogToolbar
        t={t}
        mode={{
          kind: "single",
          containers: [{ name: "app", kind: "main" as const }],
          active: "app",
          onContainer: () => {},
          previous: false,
          onPrevious: onPrev,
        }}
        tailLines={1000}
        onTailLines={() => {}}
        statusLabel="streaming"
        statusColor={t.good}
      />,
    );
    // Tail picker shows the human label for the chosen value.
    expect(screen.getByText("1k lines")).toBeInTheDocument();
    // Lone container → static text, not a Select.
    expect(screen.getByText(/container: app/)).toBeInTheDocument();
  });
});

describe("LogToolbar — status", () => {
  it("prefers a rich statusNode over the plain label", () => {
    render(
      <LogToolbar
        t={t}
        mode={{
          kind: "single",
          containers: [{ name: "app", kind: "main" as const }],
          active: "app",
          onContainer: () => {},
          previous: false,
          onPrevious: () => {},
        }}
        tailLines={200}
        onTailLines={() => {}}
        statusLabel="plain-label"
        statusColor={t.good}
        statusNode={<span>rich-pill</span>}
      />,
    );
    expect(screen.getByText("rich-pill")).toBeInTheDocument();
    expect(screen.queryByText("plain-label")).not.toBeInTheDocument();
  });
});
