// Tests for the toleration renderers shared by the Pod detail and every
// workload's Pod Template block. Before this, both surfaces showed "N total"
// with no way to see the tolerations — these pin the canonical formatting and
// the copy behaviour so a regression fails here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { formatToleration, TolerationList } from "./shared";
import { tokens } from "../../../theme";
import type { PodToleration } from "../../../types";

const t = tokens("dark");

let clipboardWrites: string[];
beforeEach(() => {
  clipboardWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        clipboardWrites.push(text);
      }),
    },
  });
});

describe("formatToleration", () => {
  it("formats the common not-ready/Exists/NoExecute taint with a timeout", () => {
    const tol: PodToleration = {
      key: "node.kubernetes.io/not-ready",
      operator: "Exists",
      value: null,
      effect: "NoExecute",
      toleration_seconds: 300,
    };
    expect(formatToleration(tol)).toBe(
      "node.kubernetes.io/not-ready:NoExecute op=Exists for 300s",
    );
  });

  it("formats an Equal toleration with a value and no timeout", () => {
    const tol: PodToleration = {
      key: "dedicated",
      operator: "Equal",
      value: "gpu",
      effect: "NoSchedule",
      toleration_seconds: null,
    };
    expect(formatToleration(tol)).toBe("dedicated=gpu:NoSchedule op=Equal");
  });

  it("surfaces tolerate-everything (no key, no effect) rather than rendering blank", () => {
    const tol: PodToleration = {
      key: null,
      operator: "Exists",
      value: null,
      effect: null,
      toleration_seconds: null,
    };
    expect(formatToleration(tol)).toBe("*:* op=Exists");
  });
});

describe("TolerationList", () => {
  const tols: PodToleration[] = [
    {
      key: "node.kubernetes.io/not-ready",
      operator: "Exists",
      value: null,
      effect: "NoExecute",
      toleration_seconds: 300,
    },
    {
      key: "dedicated",
      operator: "Equal",
      value: "gpu",
      effect: "NoSchedule",
      toleration_seconds: null,
    },
  ];

  it("renders the key, effect chip, and eviction grace period per toleration", () => {
    render(<TolerationList t={t} tolerations={tols} />);
    // Structured fields are shown separately, not as one mono string.
    expect(
      screen.getByText("node.kubernetes.io/not-ready"),
    ).toBeInTheDocument();
    expect(screen.getByText("NoExecute")).toBeInTheDocument();
    expect(screen.getByText("evict after 300s")).toBeInTheDocument();
    expect(screen.getByText("NoSchedule")).toBeInTheDocument();
  });

  it("shows the value for Equal but ignores it for Exists", () => {
    render(
      <TolerationList
        t={t}
        tolerations={[
          // Equal → value is meaningful, render it.
          {
            key: "dedicated",
            operator: "Equal",
            value: "gpu",
            effect: "NoSchedule",
            toleration_seconds: null,
          },
          // Exists matches any value, so a stray value must not be shown.
          {
            key: "spot",
            operator: "Exists",
            value: "ignored",
            effect: "NoSchedule",
            toleration_seconds: null,
          },
        ]}
      />,
    );
    expect(screen.getByText("gpu")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).not.toBeInTheDocument();
  });

  it("renders a keyless Exists as 'any taint' with 'all effects'", () => {
    render(
      <TolerationList
        t={t}
        tolerations={[
          {
            key: null,
            operator: "Exists",
            value: null,
            effect: null,
            toleration_seconds: null,
          },
        ]}
      />,
    );
    expect(screen.getByText("any taint")).toBeInTheDocument();
    expect(screen.getByText("all effects")).toBeInTheDocument();
  });

  it("click-copies the canonical kubectl form", () => {
    render(<TolerationList t={t} tolerations={tols} />);
    fireEvent.click(screen.getByText("dedicated"));
    expect(clipboardWrites).toEqual(["dedicated=gpu:NoSchedule op=Equal"]);
  });
});
