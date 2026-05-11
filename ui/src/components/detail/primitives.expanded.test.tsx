// Detail-panel primitives — these are composed by every kind's summary, so a
// silent regression here would surface across the entire app. We test the
// behavioural branches (copy, link navigation, condition invert, long-value
// expansion, sub-grid grouping) on top of the existing primitives.test.tsx.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ChipStrip,
  ChipWrap,
  ConditionChip,
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
  SubGrid,
} from "./primitives";
import { tokens } from "../../theme";

const t = tokens("dark");

// jsdom doesn't ship navigator.clipboard. Inject a stub before any test
// runs so the click handlers don't throw.
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe("DetailRow + Mute + ChipWrap", () => {
  it("DetailRow renders the label and the children", () => {
    const { getByText } = render(
      <DetailRow t={t} label="Status">
        Running
      </DetailRow>,
    );
    expect(getByText("Status")).toBeInTheDocument();
    expect(getByText("Running")).toBeInTheDocument();
  });

  it("Mute renders dim text", () => {
    const { getByText } = render(<Mute t={t}>—</Mute>);
    expect(getByText("—")).toBeInTheDocument();
  });

  it("ChipWrap is the flex container that wraps chips", () => {
    const { container } = render(
      <ChipWrap>
        <span>a</span>
        <span>b</span>
      </ChipWrap>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.flexWrap).toBe("wrap");
  });
});

describe("Copyable", () => {
  it("click writes the text to clipboard and adds the flash class", async () => {
    const { container } = render(
      <Copyable text="hello-pod">
        <span>hello-pod</span>
      </Copyable>,
    );
    const target = container.querySelector(".fs-copyable") as HTMLElement;
    await userEvent.click(target);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello-pod");
    expect(target.classList.contains("fs-copy-flash")).toBe(true);
  });

  it("custom label is rendered alongside the copy hint", async () => {
    // Tooltips are gated by hover; not asserting render. We just want to
    // verify the component accepts the label prop without throwing.
    const { container } = render(
      <Copyable text="x" label="Hello label">
        <span>x</span>
      </Copyable>,
    );
    expect(container.querySelector(".fs-copyable")).not.toBeNull();
  });
});

describe("LinkValue", () => {
  it("plain click navigates when enabled", () => {
    const onClick = vi.fn();
    const { container } = render(
      <LinkValue t={t} onClick={onClick} copyText="ns/pod" enabled>
        ns/pod
      </LinkValue>,
    );
    const target = container.querySelector(".fs-copyable") as HTMLElement;
    fireEvent.click(target);
    expect(onClick).toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl-click copies instead of navigating", () => {
    const onClick = vi.fn();
    const { container } = render(
      <LinkValue t={t} onClick={onClick} copyText="ns/pod" enabled>
        ns/pod
      </LinkValue>,
    );
    const target = container.querySelector(".fs-copyable") as HTMLElement;
    fireEvent.click(target, { metaKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ns/pod");
  });

  it("disabled link falls back to plain copy on any click", () => {
    const onClick = vi.fn();
    const { container } = render(
      <LinkValue t={t} onClick={onClick} copyText="ns/pod" enabled={false}>
        ns/pod
      </LinkValue>,
    );
    const target = container.querySelector(".fs-copyable") as HTMLElement;
    fireEvent.click(target);
    expect(onClick).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ns/pod");
  });
});

describe("ConditionChip", () => {
  it("True without invert reads as 'ok' (good color)", () => {
    const { getByText } = render(
      <ConditionChip t={t} cond={{ type: "Ready", status: "True" }} />,
    );
    const chip = getByText("Ready");
    // Good bucket → green-ish; just assert the bg uses the good rgba.
    expect((chip as HTMLElement).style.background).toMatch(/16, ?185, ?129/);
  });

  it("False without invert reads as 'bad' (red rgba)", () => {
    const { getByText } = render(
      <ConditionChip t={t} cond={{ type: "Ready", status: "False" }} />,
    );
    expect((getByText("Ready") as HTMLElement).style.background).toMatch(
      /244, ?63, ?94/,
    );
  });

  it("invert flips the semantics — True is bad for NodeMemoryPressure", () => {
    const { getByText } = render(
      <ConditionChip
        t={t}
        cond={{ type: "MemoryPressure", status: "True" }}
        invert
      />,
    );
    expect((getByText("MemoryPressure") as HTMLElement).style.background).toMatch(
      /244, ?63, ?94/,
    );
  });

  it("Unknown status falls into the bad bucket (matches !True)", () => {
    const { getByText } = render(
      <ConditionChip t={t} cond={{ type: "Ready", status: "Unknown" }} />,
    );
    expect((getByText("Ready") as HTMLElement).style.background).toMatch(
      /244, ?63, ?94/,
    );
  });
});

describe("ChipStrip", () => {
  it("renders each item with its tone-driven colour and copies on click when copy is set", async () => {
    const { getByText } = render(
      <ChipStrip
        t={t}
        items={[
          { label: "privileged" },
          { label: "host-net", tone: "bad", copy: "hostNetwork=true" },
          { label: "warn-flag", tone: "warn" },
        ]}
      />,
    );
    // Bad-toned chip has the red rgba bg.
    expect((getByText("host-net") as HTMLElement).style.background).toMatch(
      /244, ?63, ?94/,
    );
    // Warn-toned chip has amber rgba.
    expect((getByText("warn-flag") as HTMLElement).style.background).toMatch(
      /245, ?158, ?11/,
    );
    // The bad chip is wrapped in Copyable — click → clipboard write.
    await userEvent.click(getByText("host-net"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hostNetwork=true");
  });

  it("empty items renders nothing visible", () => {
    const { container } = render(<ChipStrip t={t} items={[]} />);
    // The flex wrapper is still there, but with no children.
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.childElementCount).toBe(0);
  });
});

describe("KeyValueChips", () => {
  it("short values render as inline chips", () => {
    const { getByText } = render(
      <KeyValueChips
        t={t}
        pairs={[
          ["app", "hello"],
          ["env", "prod"],
        ]}
      />,
    );
    expect(getByText("app=hello")).toBeInTheDocument();
    expect(getByText("env=prod")).toBeInTheDocument();
  });

  it("long values are split out into collapsible rows with byte-size hint", () => {
    const long = "x".repeat(150);
    const { container, getByText } = render(
      <KeyValueChips t={t} pairs={[["last-applied", long]]} />,
    );
    // Header carries the key + size; no inline `key=value` chip.
    expect(getByText("last-applied")).toBeInTheDocument();
    expect(container.textContent).toMatch(/B|KB/);
  });

  it("long-value row toggles open + closed on click", () => {
    const long = "x".repeat(150);
    const { container } = render(
      <KeyValueChips t={t} pairs={[["k", long]]} />,
    );
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(container.querySelector("button")!);
    expect(container.querySelector("pre")).not.toBeNull();
    fireEvent.click(container.querySelector("button")!);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("long-value row pretty-prints valid JSON when expanded", () => {
    const json = `{"hello":"world","x":[1,2,3]}` + " ".repeat(100); // force long
    const { container } = render(
      <KeyValueChips t={t} pairs={[["data", json]]} />,
    );
    fireEvent.click(container.querySelector("button")!);
    const pre = container.querySelector("pre")!;
    // Pretty-printed → multi-line.
    expect(pre.textContent).toContain("\n");
    expect(pre.textContent).toContain('"hello"');
  });
});

describe("SubGrid", () => {
  it("renders flat entries with their values and copyable hooks", async () => {
    const { getByText, container } = render(
      <SubGrid
        t={t}
        entries={[
          { key: "cpu", value: "200m" },
          { key: "memory", value: "256Mi" },
        ]}
      />,
    );
    expect(getByText("cpu")).toBeInTheDocument();
    expect(getByText("200m")).toBeInTheDocument();
    // Click on the row copies the joined key=value pair.
    const firstRow = container.querySelector(".fs-copyable") as HTMLElement;
    await userEvent.click(firstRow);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("cpu=200m");
  });

  it("respects copyKeyJoin=':' for status-style entries", async () => {
    const { container } = render(
      <SubGrid
        t={t}
        entries={[{ key: "message", value: "all good" }]}
        copyKeyJoin=":"
      />,
    );
    const row = container.querySelector(".fs-copyable") as HTMLElement;
    await userEvent.click(row);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "message: all good",
    );
  });

  it("groups render their group label and entries", () => {
    const { getByText } = render(
      <SubGrid
        t={t}
        groups={[
          { label: "Requests", entries: [{ key: "cpu", value: "100m" }] },
          { label: "Limits", entries: [{ key: "cpu", value: "200m" }] },
        ]}
      />,
    );
    expect(getByText("Requests")).toBeInTheDocument();
    expect(getByText("Limits")).toBeInTheDocument();
    // Both groups contain a `cpu` entry — both should render.
    expect(getByText("100m")).toBeInTheDocument();
    expect(getByText("200m")).toBeInTheDocument();
  });

  it("tone='bad' tints the value red", () => {
    const { getByText } = render(
      <SubGrid
        t={t}
        entries={[{ key: "exitCode", value: "137", tone: "bad" }]}
      />,
    );
    const value = getByText("137") as HTMLElement;
    // jsdom normalises t.bad (#f43f5e) → rgb(244, 63, 94).
    expect(value.style.color).toBe("rgb(244, 63, 94)");
  });
});
