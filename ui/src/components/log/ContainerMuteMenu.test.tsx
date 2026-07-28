// Container mute control. Two shapes: a flat chip strip for a handful of
// containers, and a popover once the strip would become a wall of buttons.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { tokens } from "../../theme";
import { ContainerMuteMenu, INLINE_LIMIT } from "./ContainerMuteMenu";
import type { LogContainer } from "../../types";

const t = tokens("dark");

const mains = (names: string[]): LogContainer[] =>
  names.map((name) => ({ name, kind: "main" }));

function manyContainers(n: number): LogContainer[] {
  return mains(Array.from({ length: n }, (_, i) => `c${i}`));
}

describe("ContainerMuteMenu — inline strip", () => {
  it("renders nothing when there is only one container to choose from", () => {
    // Nothing to mute against — a lone chip is a control with no purpose.
    const { container } = render(
      <ContainerMuteMenu
        t={t}
        universe={mains(["app"])}
        excluded={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one chip per container and toggles on click", () => {
    const onToggle = vi.fn();
    render(
      <ContainerMuteMenu
        t={t}
        universe={mains(["app", "istio-proxy"])}
        excluded={new Set()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByLabelText("Mute istio-proxy across all pods"));
    expect(onToggle).toHaveBeenCalledWith("istio-proxy");
  });

  it("marks a muted container pressed:false and offers to include it", () => {
    render(
      <ContainerMuteMenu
        t={t}
        universe={mains(["app", "istio-proxy"])}
        excluded={new Set(["istio-proxy"])}
        onToggle={() => {}}
      />,
    );
    const muted = screen.getByLabelText(
      "istio-proxy muted — click to include",
    );
    expect(muted).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Mute app across all pods")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("badges non-main containers with their kind", () => {
    render(
      <ContainerMuteMenu
        t={t}
        universe={[
          { name: "app", kind: "main" },
          { name: "logship", kind: "sidecar" },
          { name: "migrate", kind: "init" },
        ]}
        excluded={new Set(["migrate"])}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("sidecar")).toBeInTheDocument();
    expect(screen.getByText("init")).toBeInTheDocument();
    // The hint carries the kind too, so the tooltip is self-explanatory.
    expect(
      screen.getByLabelText("migrate (init) muted — click to include"),
    ).toBeInTheDocument();
  });
});

describe("ContainerMuteMenu — popover", () => {
  it("collapses into a trigger past the inline limit", () => {
    render(
      <ContainerMuteMenu
        t={t}
        universe={manyContainers(INLINE_LIMIT + 1)}
        excluded={new Set()}
        onToggle={() => {}}
      />,
    );
    // No chips until it's opened…
    expect(screen.queryByLabelText("Mute c0 across all pods")).toBeNull();
    const trigger = screen.getByTitle("Choose which containers stream");
    expect(trigger).toHaveTextContent(`containers: all ${INLINE_LIMIT + 1}`);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("stays inline at exactly the limit", () => {
    render(
      <ContainerMuteMenu
        t={t}
        universe={manyContainers(INLINE_LIMIT)}
        excluded={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByTitle("Choose which containers stream")).toBeNull();
    expect(screen.getByLabelText("Mute c0 across all pods")).toBeInTheDocument();
  });

  it("opens to reveal every container and toggles from the list", () => {
    const onToggle = vi.fn();
    render(
      <ContainerMuteMenu
        t={t}
        universe={manyContainers(INLINE_LIMIT + 2)}
        excluded={new Set()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByTitle("Choose which containers stream"));
    fireEvent.click(screen.getByLabelText("Mute c3 across all pods"));
    expect(onToggle).toHaveBeenCalledWith("c3");
  });

  it("summarises how many of the set is still streaming", () => {
    render(
      <ContainerMuteMenu
        t={t}
        universe={manyContainers(10)}
        excluded={new Set(["c0", "c1", "c2"])}
        onToggle={() => {}}
      />,
    );
    expect(
      screen.getByTitle("Choose which containers stream"),
    ).toHaveTextContent("containers: 7/10");
  });

  it("All / None toggle only what needs changing", () => {
    const onToggle = vi.fn();
    render(
      <ContainerMuteMenu
        t={t}
        universe={manyContainers(8)}
        excluded={new Set(["c0", "c1"])}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByTitle("Choose which containers stream"));
    // "All" un-mutes exactly the two muted entries — not all eight, which
    // would flip the live ones off.
    fireEvent.click(screen.getByText("All"));
    expect(onToggle.mock.calls.map((c) => c[0])).toEqual(["c0", "c1"]);

    onToggle.mockClear();
    fireEvent.click(screen.getByText("None"));
    expect(onToggle.mock.calls.map((c) => c[0])).toEqual([
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
    ]);
  });

  it("Escape closes the menu without bubbling to the panel's own handler", () => {
    // The overlay panel closes on Escape; dismissing this menu must not also
    // close the panel behind it.
    const onPanelEscape = vi.fn();
    document.addEventListener("keydown", onPanelEscape);
    try {
      render(
        <ContainerMuteMenu
          t={t}
          universe={manyContainers(10)}
          excluded={new Set()}
          onToggle={() => {}}
        />,
      );
      fireEvent.click(screen.getByTitle("Choose which containers stream"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(onPanelEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onPanelEscape);
    }
  });
});
