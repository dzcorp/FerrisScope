// Regression test for CollapsedPairs — the "show first N, expand the rest"
// collapse used by the Annotations row. Small sets render in full; only past
// the threshold do extra pairs hide behind a "Show N more" toggle.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollapsedPairs } from "./shared";
import { tokens } from "../../../theme";

const t = tokens("dark");

function pairs(n: number): [string, string][] {
  return Array.from({ length: n }, (_, i) => [`key-${i}`, `val-${i}`]);
}

describe("CollapsedPairs", () => {
  it("renders every pair with no toggle when at or under the threshold", () => {
    render(<CollapsedPairs t={t} pairs={pairs(5)} />);
    expect(screen.getByText("key-0=val-0")).toBeInTheDocument();
    expect(screen.getByText("key-4=val-4")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the first 10 and hides the rest behind 'Show N more' past the threshold", () => {
    render(<CollapsedPairs t={t} pairs={pairs(13)} />);
    expect(screen.getByText("key-9=val-9")).toBeInTheDocument();
    expect(screen.queryByText("key-10=val-10")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveTextContent("Show 3 more");
  });

  it("expands to reveal the rest, then re-collapses", () => {
    render(<CollapsedPairs t={t} pairs={pairs(13)} />);
    const toggle = screen.getByRole("button");

    fireEvent.click(toggle);
    expect(screen.getByText("key-12=val-12")).toBeInTheDocument();
    expect(toggle).toHaveTextContent("Show less");

    fireEvent.click(toggle);
    expect(screen.queryByText("key-12=val-12")).not.toBeInTheDocument();
  });
});
