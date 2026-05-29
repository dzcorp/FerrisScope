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
  copyHint,
  DetailRow,
  ExpandableList,
  KeyValueChips,
  LinkValue,
  Mono,
  Mute,
} from "./primitives";
import { tokens, FF_MONO, FS_MD, FS_SM } from "../../theme";

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

describe("copyHint", () => {
  it("echoes a short single-line value so the operator can confirm it", () => {
    expect(copyHint("postgres://example")).toBe(
      "Click to copy · postgres://example",
    );
  });

  it("drops the echo for a multi-line value (would be a wall of text)", () => {
    expect(copyHint("line one\nline two")).toBe("Click to copy");
  });

  it("drops the echo once the value exceeds the length cap", () => {
    expect(copyHint("a".repeat(81))).toBe("Click to copy");
  });

  it("keeps echoing right up to the length cap (no off-by-one)", () => {
    const at = "a".repeat(80);
    expect(copyHint(at)).toBe(`Click to copy · ${at}`);
  });
});

describe("ExpandableList", () => {
  const renderItems = (items: string[]) => (
    <>
      {items.map((it) => (
        <span key={it}>{it}</span>
      ))}
    </>
  );

  it("renders everything with no toggle when at or under the threshold", () => {
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    render(<ExpandableList t={t} items={items} render={renderItems} />);
    expect(screen.getByText("item-0")).toBeInTheDocument();
    expect(screen.getByText("item-9")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows only the first `threshold` items and a 'Show N more' toggle past it", () => {
    const items = Array.from({ length: 13 }, (_, i) => `item-${i}`);
    render(<ExpandableList t={t} items={items} render={renderItems} />);
    // First 10 visible, 11th+ hidden.
    expect(screen.getByText("item-9")).toBeInTheDocument();
    expect(screen.queryByText("item-10")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveTextContent("Show 3 more");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals the rest on click and re-collapses on 'Show less'", () => {
    const items = Array.from({ length: 13 }, (_, i) => `item-${i}`);
    render(<ExpandableList t={t} items={items} render={renderItems} />);
    const toggle = screen.getByRole("button");

    fireEvent.click(toggle);
    expect(screen.getByText("item-12")).toBeInTheDocument();
    expect(toggle).toHaveTextContent("Show less");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(screen.queryByText("item-12")).not.toBeInTheDocument();
    expect(toggle).toHaveTextContent("Show 3 more");
  });

  it("honours a custom threshold", () => {
    const items = ["a", "b", "c"];
    render(
      <ExpandableList t={t} items={items} threshold={2} render={renderItems} />,
    );
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.queryByText("c")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveTextContent("Show 1 more");
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

describe("Mono", () => {
  it("renders children in the mono font at the body size by default", () => {
    render(<Mono>web-0</Mono>);
    const el = screen.getByText("web-0");
    expect(el.tagName).toBe("SPAN");
    expect(el.style.fontFamily).toBe(FF_MONO);
    expect(el.style.fontSize).toBe(FS_MD);
  });

  it("honours a size override", () => {
    render(<Mono size={FS_SM}>tiny</Mono>);
    const el = screen.getByText("tiny");
    expect(el.style.fontSize).toBe(FS_SM);
    expect(el.style.fontFamily).toBe(FF_MONO); // still mono
  });

  it("merges extra style without clobbering the mono font", () => {
    render(
      <Mono style={{ wordBreak: "break-all", color: "rgb(1, 2, 3)" }}>
        sha256:deadbeef
      </Mono>,
    );
    const el = screen.getByText("sha256:deadbeef");
    expect(el.style.fontFamily).toBe(FF_MONO);
    expect(el.style.wordBreak).toBe("break-all");
    expect(el.style.color).toBe("rgb(1, 2, 3)");
  });
});
