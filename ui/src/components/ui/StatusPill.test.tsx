// StatusPill is the single label that surfaces every pod / job / node status
// across the app. Its branches (compact-ambient → bare bar, transient →
// breathing bar) are easy to regress when restyling.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusPill } from "./StatusPill";
import { tokens } from "../../theme";

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("StatusPill", () => {
  it("renders the status label in a non-compact pill", () => {
    const t = tokens("dark");
    const { getByText } = render(
      <StatusPill status="Running" t={t} mode="dark" />,
    );
    expect(getByText("Running")).toBeInTheDocument();
  });

  it("compact + ambient status (Running / Terminating) renders only the bare dot, no label", () => {
    const t = tokens("dark");
    const { queryByText, container } = render(
      <StatusPill status="Running" t={t} mode="dark" compact />,
    );
    // No textual "Running" — it's a bar-only badge.
    expect(queryByText("Running")).toBeNull();
    // The tooltip child carries it as a label, not as visible text.
    // Two spans: outer flex + inner bar.
    expect(container.querySelectorAll("span").length).toBeGreaterThanOrEqual(2);
  });

  it("compact + non-ambient status (Failed) still renders the full label pill", () => {
    const t = tokens("dark");
    const { getByText } = render(
      <StatusPill status="Failed" t={t} mode="dark" compact />,
    );
    expect(getByText("Failed")).toBeInTheDocument();
  });

  it("renders a status-colored bar and body-colored text", () => {
    const t = tokens("dark");
    const { container, getByText } = render(
      <StatusPill status="CrashLoopBackOff" t={t} mode="dark" />,
    );
    const bar = container.querySelector("[data-status-bar]") as HTMLElement;
    expect(bar.style.width).toBe("3px");
    expect(bar.style.background).toBe(hexToRgb(t.bad));
    expect(bar.className).toBe("");
    expect(getByText("CrashLoopBackOff").style.color).toBe(hexToRgb(t.text));
  });

  it("transient statuses breathe; the bar stays solid", () => {
    const t = tokens("dark");
    for (const status of ["Pending", "ContainerCreating", "Terminating"]) {
      const { container, unmount } = render(
        <StatusPill status={status} t={t} mode="dark" compact />,
      );
      const bar = container.querySelector("[data-status-bar]") as HTMLElement;
      expect(bar.className).toBe("fs-breathe");
      expect(bar.style.background).not.toBe("transparent");
      unmount();
    }
  });

  it("compact ambient status is the bar alone, labelled for assistive tech", () => {
    const t = tokens("dark");
    const { getByRole, queryByText } = render(
      <StatusPill status="Terminating" t={t} mode="dark" compact />,
    );
    expect(queryByText("Terminating")).toBeNull();
    expect(getByRole("img", { name: "Terminating" })).toBeInTheDocument();
  });

  it("dense mode reduces gap / padding (visually verifiable via inline style)", () => {
    const t = tokens("dark");
    const { container } = render(
      <StatusPill status="Running" t={t} mode="dark" dense />,
    );
    // Dense steps down the theme type scale (sm instead of md).
    const pill = container.querySelector("span")!;
    expect(pill.style.fontSize).toBe("var(--fs-fs-sm, 11px)");
  });
});
