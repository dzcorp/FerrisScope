// StatusPill is the single chip that surfaces every pod / job / node status
// across the table. Its branches (compact-ambient → bare dot, transient →
// pulse class, palette-tinted bg) are easy to regress when restyling.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusPill } from "./StatusPill";
import { tokens } from "../../theme";

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
    // No textual "Running" — it's a dot-only badge.
    expect(queryByText("Running")).toBeNull();
    // The tooltip child carries it as a label, not as visible text.
    // Two spans: outer flex + inner dot.
    expect(container.querySelectorAll("span").length).toBeGreaterThanOrEqual(2);
  });

  it("compact + non-ambient status (Failed) still renders the full label pill", () => {
    const t = tokens("dark");
    const { getByText } = render(
      <StatusPill status="Failed" t={t} mode="dark" compact />,
    );
    expect(getByText("Failed")).toBeInTheDocument();
  });

  it("transient status gets the pulse-dot class", () => {
    const t = tokens("dark");
    const { container } = render(
      <StatusPill status="Pending" t={t} mode="dark" />,
    );
    // Inner dot span carries the pulse class.
    expect(container.querySelector(".fs-pulse-dot")).not.toBeNull();
  });

  it("steady status (Running) does NOT carry the pulse class", () => {
    const t = tokens("dark");
    const { container } = render(
      <StatusPill status="Running" t={t} mode="dark" />,
    );
    expect(container.querySelector(".fs-pulse-dot")).toBeNull();
  });

  it("dense mode reduces gap / padding (visually verifiable via inline style)", () => {
    const t = tokens("dark");
    const { container } = render(
      <StatusPill status="Running" t={t} mode="dark" dense />,
    );
    // Dense changes the pill's font-size to 10.5px.
    const pill = container.querySelector("span")!;
    expect(pill.style.fontSize).toMatch(/10\.5/);
  });
});
