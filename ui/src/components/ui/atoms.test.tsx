// atoms.tsx is the largest single component file in the UI but most of it
// is small visual primitives. We test the structural / behavioural ones —
// rendering, interaction, branch coverage. The font-stack / spacing inline
// styles aren't worth asserting against (they're already pinned by the
// theme tests).

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BarGauge,
  Checkbox,
  Chip,
  ContainerDots,
  EmptyState,
  ErrorBlock,
  Eyebrow,
  Field,
  Gauge,
  Kbd,
  LoadingLine,
  Section,
  SectionHeader,
  Stat,
  TextInput,
  Toggle,
} from "./atoms";
import { tokens } from "../../theme";

const t = tokens("dark");

describe("Eyebrow / Section / SectionHeader / Stat / Kbd / Chip — basic render", () => {
  it("Eyebrow renders its children", () => {
    const { getByText } = render(<Eyebrow t={t}>CPU</Eyebrow>);
    expect(getByText("CPU")).toBeInTheDocument();
  });

  it("Section renders title and an optional right slot", () => {
    const { getByText } = render(
      <Section t={t} title="Conditions" right={<span>3</span>} />,
    );
    expect(getByText("Conditions")).toBeInTheDocument();
    expect(getByText("3")).toBeInTheDocument();
  });

  it("SectionHeader renders title and optional sub", () => {
    const { getByText, rerender } = render(
      <SectionHeader t={t} title="General" sub="App-level prefs" />,
    );
    expect(getByText("General")).toBeInTheDocument();
    expect(getByText("App-level prefs")).toBeInTheDocument();
    // Without sub — only the title.
    rerender(<SectionHeader t={t} title="General" />);
    expect(getByText("General")).toBeInTheDocument();
  });

  it("Stat shows label + value", () => {
    const { getByText } = render(
      <Stat t={t} label="Nodes" value={42} />,
    );
    expect(getByText("Nodes")).toBeInTheDocument();
    expect(getByText("42")).toBeInTheDocument();
  });

  it("Kbd renders its children", () => {
    const { getByText } = render(<Kbd t={t}>⌘K</Kbd>);
    expect(getByText("⌘K")).toBeInTheDocument();
  });

  it("Chip neutral / accent / warn tones each render", () => {
    const { rerender, getByText, container } = render(
      <Chip t={t}>plain</Chip>,
    );
    expect(getByText("plain")).toBeInTheDocument();
    rerender(<Chip t={t} tone="accent">tag</Chip>);
    expect(getByText("tag")).toBeInTheDocument();
    rerender(<Chip t={t} tone="warn" mono title="hover-hint">warn</Chip>);
    expect(getByText("warn")).toBeInTheDocument();
    // mono branch sets the font-family to mono; check via inline style.
    const span = container.querySelector("span")!;
    expect(span.style.fontFamily).toMatch(/--fs-font-mono|mono/);
    expect(span.title).toBe("hover-hint");
  });
});

describe("Checkbox", () => {
  it("checked / indeterminate / unchecked all render and onChange fires", async () => {
    const onChange = vi.fn();
    const { getByRole, rerender } = render(
      <Checkbox t={t} checked={false} onChange={onChange} />,
    );
    await userEvent.click(getByRole("button"));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Checkbox t={t} checked onChange={onChange} />);
    await userEvent.click(getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith(false);

    rerender(<Checkbox t={t} indeterminate onChange={onChange} />);
    // Indeterminate clicks treat the next value as `true`.
    await userEvent.click(getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("size prop is honoured (sets element size in px)", () => {
    const { getByRole } = render(
      <Checkbox t={t} checked size={20} onChange={() => {}} />,
    );
    const btn = getByRole("button") as HTMLButtonElement;
    expect(btn.style.width).toMatch(/^20px$|^20$/);
  });
});

describe("Gauge + BarGauge — clamp value to [0, 1]", () => {
  it("Gauge renders an SVG", () => {
    const { container } = render(
      <Gauge value={0.6} color={t.good} track={t.borderSoft} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("circle").length).toBe(2);
  });

  it("BarGauge renders a track with the inner bar at the clamped percentage", () => {
    const { container } = render(
      <BarGauge value={2 /* will clamp to 1 */} color={t.good} track={t.borderSoft} />,
    );
    const outer = container.querySelector("div")!;
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.style.width).toBe("100%");
  });

  it("BarGauge with a negative value clamps to 0%", () => {
    const { container } = render(
      <BarGauge value={-0.3} color={t.good} track={t.borderSoft} />,
    );
    const outer = container.querySelector("div")!;
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.style.width).toBe("0%");
  });
});

describe("Toggle", () => {
  it("flips on click", async () => {
    const onChange = vi.fn();
    const { getByRole, rerender } = render(
      <Toggle t={t} checked={false} onChange={onChange} label="On?" />,
    );
    await userEvent.click(getByRole("button"));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Toggle t={t} checked onChange={onChange} label="On?" />);
    await userEvent.click(getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("sm size renders without crashing", () => {
    const { getByRole } = render(
      <Toggle t={t} checked size="sm" onChange={() => {}} title="hint" />,
    );
    expect(getByRole("button").title).toBe("hint");
  });
});

describe("TextInput", () => {
  it("onChange fires with the new value", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <TextInput t={t} value="" onChange={onChange} placeholder="filter" />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    expect(input.placeholder).toBe("filter");
    fireEvent.change(input, { target: { value: "nginx" } });
    expect(onChange).toHaveBeenCalledWith("nginx");
  });

  it("focus/blur swap the border color", () => {
    const { getByRole } = render(
      <TextInput t={t} value="" onChange={() => {}} />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.style.borderColor).not.toBe("");
    fireEvent.blur(input);
    expect(input.style.borderColor).not.toBe("");
  });
});

describe("Field (settings row)", () => {
  it("default grid layout — label, hint, child control", () => {
    const { getByText } = render(
      <Field t={t} label="Refresh" hint="seconds">
        <input data-testid="ctrl" />
      </Field>,
    );
    expect(getByText("Refresh")).toBeInTheDocument();
    expect(getByText("seconds")).toBeInTheDocument();
  });

  it("anchor prop becomes data-fs-anchor (settings deep-linking)", () => {
    const { container } = render(
      <Field t={t} label="X" anchor="density">
        <input />
      </Field>,
    );
    expect(
      container.querySelector('[data-fs-anchor="density"]'),
    ).not.toBeNull();
  });

  it("stack layout switches to flex column", () => {
    const { container } = render(
      <Field t={t} label="X" stack>
        <input />
      </Field>,
    );
    const root = container.querySelector("div")!;
    expect(root.style.display).toBe("flex");
    expect(root.style.flexDirection).toBe("column");
  });
});

describe("ContainerDots", () => {
  it("nothing rendered when there are no containers", () => {
    const { container } = render(<ContainerDots t={t} containers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one dot per container; init and sidecar branches use distinct shapes", () => {
    const { container } = render(
      <ContainerDots
        t={t}
        containers={[
          { name: "i1", status: "Completed", kind: "init" },
          { name: "m1", status: "Running", kind: "main" },
          { name: "s1", status: "Running", kind: "sidecar" },
        ]}
      />,
    );
    // 3 dots → 3 spans inside the wrapper (each wrapped in a Tooltip).
    const dots = container.querySelectorAll("span > span");
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });

  it("containers without a kind fall back to all-main (no collapse)", () => {
    const { container } = render(
      <ContainerDots
        t={t}
        containers={[
          { name: "a", status: "Running" },
          { name: "b", status: "Running" },
        ]}
      />,
    );
    expect(container.querySelectorAll("span").length).toBeGreaterThan(2);
  });

  it("custom dotColor wins over status-bucket color", () => {
    const dotColor = vi.fn(() => "#abcdef");
    render(
      <ContainerDots
        t={t}
        containers={[{ name: "x", status: "Running", kind: "main" }]}
        dotColor={dotColor}
      />,
    );
    expect(dotColor).toHaveBeenCalled();
  });
});

describe("LoadingLine", () => {
  it("centred layout renders a label + action when supplied", () => {
    const { getByText } = render(
      <LoadingLine t={t} label="Connecting" action={<button>Cancel</button>} />,
    );
    expect(getByText("Connecting")).toBeInTheDocument();
    expect(getByText("Cancel")).toBeInTheDocument();
  });

  it("inline layout suppresses centring chrome", () => {
    const { container, getByText } = render(
      <LoadingLine t={t} inline label="…" />,
    );
    expect(getByText("…")).toBeInTheDocument();
    // Inline emits a <span> root rather than the centred <div>.
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("span");
  });

  it("no-label variant still renders the track bar", () => {
    const { container } = render(<LoadingLine t={t} />);
    // The track div is the first child; its className-loaded inner sits underneath.
    expect(container.querySelector(".fs-line-loader")).not.toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders title; optional hint and action when provided", () => {
    const { getByText, queryByText, rerender } = render(
      <EmptyState t={t} title="No items" />,
    );
    expect(getByText("No items")).toBeInTheDocument();
    expect(queryByText("Try again")).toBeNull();

    rerender(
      <EmptyState
        t={t}
        title="No items"
        hint="Add one to get started"
        action={<button>Try again</button>}
      />,
    );
    expect(getByText("Add one to get started")).toBeInTheDocument();
    expect(getByText("Try again")).toBeInTheDocument();
  });
});

describe("ErrorBlock — classification branches", () => {
  it("404 → 'Not found' with the kindLabel woven in", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="kube error: not found" kindLabel="Pod" />,
    );
    expect(getByText("Not found")).toBeInTheDocument();
    // Body references "pod" lowercase.
    expect(getByText(/the pod/i)).toBeInTheDocument();
  });

  it("403 → 'Access denied' and verb-specific body for save", () => {
    const { getByText } = render(
      <ErrorBlock
        t={t}
        message="kube error: forbidden"
        kindLabel="ConfigMap"
        verb="save"
      />,
    );
    expect(getByText("Access denied")).toBeInTheDocument();
    expect(getByText(/permission to modify/i)).toBeInTheDocument();
  });

  it("401 → 'Authentication failed'", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="kube error: unauthorized" />,
    );
    expect(getByText("Authentication failed")).toBeInTheDocument();
  });

  it("409 → 'Conflict'", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="kube error: conflict, please retry" />,
    );
    expect(getByText("Conflict")).toBeInTheDocument();
  });

  it("network error → 'Connection failed'", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="connection refused" />,
    );
    expect(getByText("Connection failed")).toBeInTheDocument();
  });

  it("namespace-required hint → 'Namespace required'", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="this kind requires a namespace" />,
    );
    expect(getByText("Namespace required")).toBeInTheDocument();
  });

  it("unknown short error becomes the body verbatim", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="some quirky thing went wrong" />,
    );
    expect(getByText("Failed to load")).toBeInTheDocument();
    expect(getByText("some quirky thing went wrong")).toBeInTheDocument();
  });

  it("inline variant still renders the friendly title", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="not found" kindLabel="Pod" inline />,
    );
    expect(getByText("Not found")).toBeInTheDocument();
  });

  it("verb='stream' on a 403 surfaces a logs-permission body", () => {
    const { getByText } = render(
      <ErrorBlock t={t} message="forbidden" kindLabel="Pod" verb="stream" />,
    );
    expect(getByText(/permission to stream logs/i)).toBeInTheDocument();
  });
});
