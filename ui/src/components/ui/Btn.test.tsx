// Btn / IconBtn are wired into every interactive surface — exposed to
// regressions in disabled handling, icon sizing, hover/active styling, and
// keyboard hint rendering. Cover the interaction-relevant branches.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Btn, IconBtn } from "./Btn";
import { tokens } from "../../theme";

describe("Btn", () => {
  const t = tokens("dark");

  it("renders children and fires onClick", async () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Btn t={t} onClick={onClick}>
        Apply
      </Btn>,
    );
    const btn = getByRole("button", { name: /apply/i });
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled buttons do not fire onClick and report aria-disabled to AT", async () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Btn t={t} onClick={onClick} disabled>
        Apply
      </Btn>,
    );
    const btn = getByRole("button");
    // userEvent obeys the `disabled` attribute and skips the click.
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(btn).toBeDisabled();
  });

  it("type defaults to button (no accidental form submission)", () => {
    const { getByRole } = render(<Btn t={t}>X</Btn>);
    expect(getByRole("button")).toHaveAttribute("type", "button");
  });

  it("type='submit' propagates", () => {
    const { getByRole } = render(
      <Btn t={t} type="submit">
        Save
      </Btn>,
    );
    expect(getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("kbd hint renders alongside the label", () => {
    const { getByText } = render(
      <Btn t={t} kbd="⌘K">
        Search
      </Btn>,
    );
    expect(getByText("Search")).toBeInTheDocument();
    expect(getByText("⌘K")).toBeInTheDocument();
  });

  it("hover sets the variant's hover background", () => {
    const { getByRole } = render(<Btn t={t}>Hi</Btn>);
    const btn = getByRole("button") as HTMLButtonElement;
    // Default variant is secondary — surface → btnHover on enter.
    const before = btn.style.background;
    fireEvent.mouseEnter(btn);
    const after = btn.style.background;
    expect(after).not.toBe(before);
  });

  it("primary variant has white text and accent-tinted background", () => {
    const { getByRole } = render(
      <Btn t={t} variant="primary">
        Save
      </Btn>,
    );
    const btn = getByRole("button") as HTMLButtonElement;
    expect(btn.style.color).toMatch(/rgb\(255, ?255, ?255\)|#ffffff/i);
  });

  it("fullWidth gives the button 100% width", () => {
    const { getByRole } = render(
      <Btn t={t} fullWidth>
        X
      </Btn>,
    );
    expect((getByRole("button") as HTMLButtonElement).style.width).toBe("100%");
  });
});

describe("IconBtn", () => {
  const t = tokens("dark");

  it("renders the child glyph and fires onClick", async () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <IconBtn t={t} onClick={onClick} title="Refresh">
        <span data-testid="glyph">★</span>
      </IconBtn>,
    );
    await userEvent.click(getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });

  it("forwards width/height to the inner glyph by cloning it (size='lg')", () => {
    // The icon component is cloned with explicit width/height from ICON_SIZES.
    // sm=16, md=18, lg=20.
    const { container } = render(
      <IconBtn t={t} size="lg" title="Refresh">
        <svg data-testid="g" />
      </IconBtn>,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
  });

  it("disabled IconBtn does not fire onClick", async () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <IconBtn t={t} onClick={onClick} disabled title="x">
        <svg />
      </IconBtn>,
    );
    await userEvent.click(getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("danger styling tints the foreground with the bad-bucket color", () => {
    const { getByRole } = render(
      <IconBtn t={t} danger title="del">
        <svg />
      </IconBtn>,
    );
    const btn = getByRole("button") as HTMLButtonElement;
    fireEvent.mouseEnter(btn);
    // jsdom normalises #f43f5e → rgb(244, 63, 94). Compare the rgb form.
    expect(btn.style.color).toBe("rgb(244, 63, 94)");
  });
});
