// Tests for the collapsible container chrome: CollapsibleCard (per-card
// toggle, body kept mounted via display so embedded editors survive a
// collapse), and useCollapseGroup + ExpandAllButton (bulk expand/collapse
// that still allows individual toggles).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  CollapsibleCard,
  Copyable,
  ExpandAllButton,
  useCollapseGroup,
} from "./primitives";
import { tokens } from "../../theme";

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

describe("CollapsibleCard", () => {
  it("starts collapsed: header shown, body mounted but not visible", () => {
    render(
      <CollapsibleCard t={t} header={() => <span>hdr</span>}>
        <span>body</span>
      </CollapsibleCard>,
    );
    expect(screen.getByText("hdr")).toBeInTheDocument();
    // Body stays in the DOM (so embedded editors keep their state) but is
    // hidden until expanded.
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByText("body")).not.toBeVisible();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles the body open and closed on header click", () => {
    render(
      <CollapsibleCard t={t} header={() => <span>hdr</span>}>
        <span>body</span>
      </CollapsibleCard>,
    );
    const header = screen.getByRole("button");
    fireEvent.click(header);
    expect(screen.getByText("body")).toBeVisible();
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(screen.getByText("body")).not.toBeVisible();
  });

  it("passes the open state to the header render-prop", () => {
    render(
      <CollapsibleCard
        t={t}
        header={(open) => <span>{open ? "is-open" : "is-closed"}</span>}
      >
        <span>body</span>
      </CollapsibleCard>,
    );
    expect(screen.getByText("is-closed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("is-open")).toBeInTheDocument();
  });

  it("honours defaultOpen", () => {
    render(
      <CollapsibleCard t={t} defaultOpen header={() => <span>hdr</span>}>
        <span>body</span>
      </CollapsibleCard>,
    );
    expect(screen.getByText("body")).toBeVisible();
  });

  it("a Copyable inside the header copies without toggling the card", () => {
    render(
      <CollapsibleCard
        t={t}
        header={() => (
          <Copyable text="container-name">
            <span>name</span>
          </Copyable>
        )}
      >
        <span>body</span>
      </CollapsibleCard>,
    );
    fireEvent.click(screen.getByText("name"));
    expect(clipboardWrites).toEqual(["container-name"]);
    // Click was absorbed by Copyable — the card must not have expanded.
    expect(screen.getByText("body")).not.toBeVisible();
  });
});

function Group() {
  const group = useCollapseGroup();
  return (
    <>
      <ExpandAllButton t={t} allOpen={group.allOpen} onToggle={group.toggleAll} />
      <CollapsibleCard t={t} signal={group.signal} header={() => <span>h1</span>}>
        <span>body1</span>
      </CollapsibleCard>
      <CollapsibleCard t={t} signal={group.signal} header={() => <span>h2</span>}>
        <span>body2</span>
      </CollapsibleCard>
    </>
  );
}

describe("useCollapseGroup + ExpandAllButton", () => {
  it("bulk-expands and bulk-collapses every card, flipping the label", () => {
    render(<Group />);
    const bulk = screen.getByRole("button", { name: /expand all/i });
    expect(screen.getByText("body1")).not.toBeVisible();
    expect(screen.getByText("body2")).not.toBeVisible();

    fireEvent.click(bulk);
    expect(screen.getByText("body1")).toBeVisible();
    expect(screen.getByText("body2")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /collapse all/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /collapse all/i }));
    expect(screen.getByText("body1")).not.toBeVisible();
    expect(screen.getByText("body2")).not.toBeVisible();
  });

  it("lets an individual card toggle without disturbing its sibling", () => {
    render(<Group />);
    fireEvent.click(screen.getByRole("button", { name: /expand all/i }));
    // Collapse only the first card via its own header.
    fireEvent.click(screen.getByText("h1"));
    expect(screen.getByText("body1")).not.toBeVisible();
    expect(screen.getByText("body2")).toBeVisible();
  });
});
