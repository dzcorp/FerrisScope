// Pod picker for the aggregated log view — filtering, bulk actions, and the
// over-budget warning. Selection maths itself lives in `lib/logSelection`.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { tokens } from "../../theme";
import { SourceRail } from "./SourceRail";
import { podKey } from "../../lib/logSources";
import type { SelectablePod } from "../../lib/logSelection";

const t = tokens("dark");

function row(name: string, streamCount = 1, namespace = "default"): SelectablePod {
  return {
    key: podKey("cl1", namespace, name),
    clusterId: "cl1",
    namespace,
    name,
    streamCount,
  };
}

function renderRail(
  pods: SelectablePod[],
  selected: Iterable<string> = [],
  onChange = vi.fn(),
) {
  const utils = render(
    <SourceRail
      t={t}
      pods={pods}
      selected={new Set(selected)}
      onChange={onChange}
      onClose={() => {}}
    />,
  );
  return { ...utils, onChange };
}

describe("SourceRail", () => {
  it("lists pods with their stream cost and current checked state", () => {
    const pods = [row("web-0", 2), row("web-1", 1)];
    renderRail(pods, [pods[0]!.key]);
    expect(screen.getByTitle("default/web-0")).toBeInTheDocument();
    expect(screen.getByText("2×")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("labels a fully-muted pod rather than showing a bare zero", () => {
    renderRail([row("web-0", 0)]);
    expect(screen.getByText("muted")).toBeInTheDocument();
  });

  it("toggling a row hands back the new selection", () => {
    const pods = [row("web-0"), row("web-1")];
    const { onChange } = renderRail(pods, [pods[0]!.key]);
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect([...onChange.mock.calls[0]![0]]).toEqual([
      pods[0]!.key,
      pods[1]!.key,
    ]);
  });

  it("reports the stream budget and warns when the selection exceeds it", () => {
    const pods = [row("a", 20), row("b", 20)];
    renderRail(pods, [pods[0]!.key]);
    expect(screen.getByText(/20\/24 streams/)).toBeInTheDocument();
    expect(screen.queryByText(/over budget/)).toBeNull();
  });

  it("says so when the selection is over budget", () => {
    // The streams past the cap genuinely don't start, so this can't be silent.
    const pods = [row("a", 20), row("b", 20)];
    renderRail(pods, [pods[0]!.key, pods[1]!.key]);
    expect(screen.getByText(/over budget/)).toBeInTheDocument();
  });

  it("filters by pod name and reports the visible count", () => {
    renderRail([row("web-0"), row("api-0")]);
    fireEvent.change(screen.getByPlaceholderText("Filter pods…"), {
      target: { value: "api" },
    });
    expect(screen.getByTitle("default/api-0")).toBeInTheDocument();
    expect(screen.queryByTitle("default/web-0")).toBeNull();
    expect(screen.getByText(/1 shown/)).toBeInTheDocument();
  });

  it("filters by namespace too", () => {
    renderRail([row("web-0", 1, "prod"), row("web-1", 1, "staging")]);
    fireEvent.change(screen.getByPlaceholderText("Filter pods…"), {
      target: { value: "staging" },
    });
    expect(screen.getByTitle("staging/web-1")).toBeInTheDocument();
    expect(screen.queryByTitle("prod/web-0")).toBeNull();
  });

  it("shows an empty state when the filter matches nothing", () => {
    renderRail([row("web-0")]);
    fireEvent.change(screen.getByPlaceholderText("Filter pods…"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(/No pods match/)).toBeInTheDocument();
  });

  it("Fit fills the budget from the visible pods only", () => {
    // Narrow to one namespace, then Fit — the selection should come from that
    // namespace rather than from the whole set.
    const pods = [row("web-0", 1, "prod"), row("api-0", 1, "staging")];
    const { onChange } = renderRail(pods, []);
    fireEvent.change(screen.getByPlaceholderText("Filter pods…"), {
      target: { value: "staging" },
    });
    fireEvent.click(screen.getByText("Fit"));
    expect([...onChange.mock.calls[0]![0]]).toEqual([pods[1]!.key]);
  });

  it("Clear only deselects the visible pods", () => {
    // A filtered Clear must not silently wipe selections the operator can't see.
    const pods = [row("web-0", 1, "prod"), row("api-0", 1, "staging")];
    const { onChange } = renderRail(pods, [pods[0]!.key, pods[1]!.key]);
    fireEvent.change(screen.getByPlaceholderText("Filter pods…"), {
      target: { value: "staging" },
    });
    fireEvent.click(screen.getByText("Clear"));
    expect([...onChange.mock.calls[0]![0]]).toEqual([pods[0]!.key]);
  });

  it("renders a large pod set without putting every row in the DOM", () => {
    // 500 pods is a real DaemonSet selection; flat rendering is what the
    // virtualizer exists to avoid.
    const pods = Array.from({ length: 500 }, (_, i) =>
      row(`p${String(i).padStart(3, "0")}`),
    );
    renderRail(pods);
    // jsdom reports a zero-height scroll container, so the virtualizer renders
    // no rows at all here — the point is that it is *not* rendering 500. The
    // sized spacer is what proves virtualization is engaged.
    expect(screen.queryAllByRole("checkbox").length).toBeLessThan(pods.length);
    const spacer = screen
      .getByRole("group", { name: "Pods to stream" })
      .querySelector("div");
    expect(spacer).toHaveStyle({ position: "relative" });
    expect(screen.getByText(/0 of 500 pods/)).toBeInTheDocument();
  });
});
