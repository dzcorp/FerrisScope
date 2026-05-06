// Component-level tests for the kind-agnostic detail primitives. These
// don't render whole panels — they exercise the atoms (DetailRow,
// Copyable, LinkValue, ChipStrip, ConditionChip, KeyValueChips) so a
// regression in click handling or label wiring fails here, far from the
// panels that compose them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ChipStrip,
  ConditionChip,
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
} from "./primitives";
import { tokens } from "../../theme";

const t = tokens("dark");

// jsdom normalises CSS color values to rgb()/rgba(). Compare semantically
// by converting the token's hex form to the same shape.
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

// jsdom doesn't ship a real clipboard. We stub navigator.clipboard once
// and reset between tests so each can assert the exact call.
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

describe("DetailRow", () => {
  it("renders the label and the value-side children", () => {
    render(
      <DetailRow t={t} label="Image">
        <span>nginx:1.27</span>
      </DetailRow>,
    );
    expect(screen.getByText("Image")).toBeInTheDocument();
    expect(screen.getByText("nginx:1.27")).toBeInTheDocument();
  });

  it("accepts a ReactNode label so callers can decorate it", () => {
    render(
      <DetailRow
        t={t}
        label={
          <span>
            Image <em>(annotated)</em>
          </span>
        }
      >
        <span>v</span>
      </DetailRow>,
    );
    expect(screen.getByText("(annotated)")).toBeInTheDocument();
  });
});

describe("Mute", () => {
  it("renders dim-text content", () => {
    render(<Mute t={t}>—</Mute>);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("Copyable", () => {
  it("clicks copy the configured text", () => {
    render(
      <Copyable text="postgres://example">
        <span>db</span>
      </Copyable>,
    );
    fireEvent.click(screen.getByText("db"));
    expect(clipboardWrites).toEqual(["postgres://example"]);
  });

  it("stops the click from propagating to ancestor handlers", () => {
    const onParent = vi.fn();
    render(
      <div onClick={onParent}>
        <Copyable text="x">
          <span>v</span>
        </Copyable>
      </div>,
    );
    fireEvent.click(screen.getByText("v"));
    expect(onParent).not.toHaveBeenCalled();
    expect(clipboardWrites).toEqual(["x"]);
  });
});

describe("LinkValue", () => {
  it("plain click navigates when enabled", () => {
    const onClick = vi.fn();
    render(
      <LinkValue t={t} onClick={onClick} copyText="kind:name" enabled>
        <span>name</span>
      </LinkValue>,
    );
    fireEvent.click(screen.getByText("name"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(clipboardWrites).toEqual([]);
  });

  it("Cmd-click copies instead of navigating", () => {
    const onClick = vi.fn();
    render(
      <LinkValue t={t} onClick={onClick} copyText="kind:name" enabled>
        <span>name</span>
      </LinkValue>,
    );
    fireEvent.click(screen.getByText("name"), { metaKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(clipboardWrites).toEqual(["kind:name"]);
  });

  it("Ctrl-click also copies (covers Linux/Windows)", () => {
    const onClick = vi.fn();
    render(
      <LinkValue t={t} onClick={onClick} copyText="x" enabled>
        <span>name</span>
      </LinkValue>,
    );
    fireEvent.click(screen.getByText("name"), { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(clipboardWrites).toEqual(["x"]);
  });

  it("disabled link copies on a plain click (degrades gracefully)", () => {
    const onClick = vi.fn();
    render(
      <LinkValue t={t} onClick={onClick} copyText="x" enabled={false}>
        <span>name</span>
      </LinkValue>,
    );
    fireEvent.click(screen.getByText("name"));
    expect(onClick).not.toHaveBeenCalled();
    expect(clipboardWrites).toEqual(["x"]);
  });
});

describe("ConditionChip", () => {
  it("True → green for normal conditions", () => {
    const { container } = render(
      <ConditionChip t={t} cond={{ type: "Available", status: "True" }} />,
    );
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toBe(hexToRgb(t.good));
  });

  it("False → red for normal conditions", () => {
    const { container } = render(
      <ConditionChip
        t={t}
        cond={{ type: "Available", status: "False" }}
      />,
    );
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toBe(hexToRgb(t.bad));
  });

  it("invert=true flips colour for pressure-style conditions (NodeMemoryPressure)", () => {
    const { container, rerender } = render(
      <ConditionChip
        t={t}
        cond={{ type: "MemoryPressure", status: "True" }}
        invert
      />,
    );
    const chipA = container.firstChild as HTMLElement;
    expect(chipA.style.color).toBe(hexToRgb(t.bad));
    rerender(
      <ConditionChip
        t={t}
        cond={{ type: "MemoryPressure", status: "False" }}
        invert
      />,
    );
    const chipB = container.firstChild as HTMLElement;
    expect(chipB.style.color).toBe(hexToRgb(t.good));
  });
});

describe("ChipStrip", () => {
  it("renders each label as a chip", () => {
    render(
      <ChipStrip
        t={t}
        items={[
          { label: "privileged" },
          { label: "hostNetwork", tone: "warn" },
          { label: "DROP_ALL", tone: "bad" },
        ]}
      />,
    );
    expect(screen.getByText("privileged")).toBeInTheDocument();
    expect(screen.getByText("hostNetwork")).toBeInTheDocument();
    expect(screen.getByText("DROP_ALL")).toBeInTheDocument();
  });

  it("makes a chip copyable when `copy` is set", () => {
    render(
      <ChipStrip
        t={t}
        items={[{ label: "v1.31.4", copy: "v1.31.4" }]}
      />,
    );
    fireEvent.click(screen.getByText("v1.31.4"));
    expect(clipboardWrites).toEqual(["v1.31.4"]);
  });

  it("does NOT copy when `copy` is absent", () => {
    render(<ChipStrip t={t} items={[{ label: "plain" }]} />);
    fireEvent.click(screen.getByText("plain"));
    expect(clipboardWrites).toEqual([]);
  });
});

describe("KeyValueChips", () => {
  it("renders k=v chips and copies the joined form", () => {
    render(
      <KeyValueChips
        t={t}
        pairs={[
          ["app", "web"],
          ["env", "prod"],
        ]}
      />,
    );
    expect(screen.getByText("app=web")).toBeInTheDocument();
    expect(screen.getByText("env=prod")).toBeInTheDocument();
    fireEvent.click(screen.getByText("env=prod"));
    expect(clipboardWrites).toEqual(["env=prod"]);
  });
});
