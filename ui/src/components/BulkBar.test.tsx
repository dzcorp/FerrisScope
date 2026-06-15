// BulkBar: floating selection action dock. Regression guard for the
// label-wrapping bug — multi-word labels ("Compare YAML", "Copy names")
// used to wrap onto a second line when the bar got crowded, breaking the
// dock's single-row design. We pin that every action button stays on one
// line (whiteSpace: nowrap) and refuses to shrink (flexShrink: 0).

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BulkBar } from "./BulkBar";

afterEach(cleanup);

describe("BulkBar", () => {
  const actions = [
    { icon: null, label: "Logs", onClick: () => {} },
    { icon: null, label: "Compare YAML", onClick: () => {} },
    { icon: null, label: "Copy names", onClick: () => {} },
    { icon: null, label: "Delete", onClick: () => {}, danger: true },
  ];

  it("keeps multi-word action labels on a single line", () => {
    render(
      <BulkBar mode="dark" count={2} actions={actions} onClear={() => {}} />,
    );
    for (const label of ["Compare YAML", "Copy names"]) {
      const btn = screen.getByText(label).closest("button");
      expect(btn).not.toBeNull();
      expect(btn!.style.whiteSpace).toBe("nowrap");
      expect(btn!.style.flexShrink).toBe("0");
    }
  });
});
