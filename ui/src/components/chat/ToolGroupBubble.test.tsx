// ToolGroupBubble wraps a run of tool activity in one collapsible card with
// two independent layers of expansion: the group viewport (collapsed clips to
// N rows) and per-row payloads. The bug these tests pin: a row click while the
// group was collapsed silently recorded "open" state that did nothing until a
// later group expand, which then sprang the row open as if pre-selected. The
// fix keeps the two layers in sync — opening a row expands the group;
// collapsing the group clears open rows.

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolGroupBubble, type ToolGroupItem } from "./ToolGroupBubble";
import type { ChatViewMessage, ExecutingToolCall } from "./chatStreaming";

function resultItem(
  overrides: Partial<ChatViewMessage> & { id: string },
): ToolGroupItem {
  return {
    kind: "result",
    message: {
      role: "tool",
      content: "",
      ...overrides,
    } as ChatViewMessage,
  };
}

const ITEMS: ToolGroupItem[] = [
  resultItem({
    id: "m1",
    toolCallId: "call-1",
    toolName: "fs_pods_list",
    toolPreview: "preview-one",
    toolLineCount: 3,
    content: "PAYLOAD_ONE_BODY",
  }),
  resultItem({
    id: "m2",
    toolCallId: "call-2",
    toolName: "fs_pods_get",
    toolPreview: "preview-two",
    toolLineCount: 5,
    content: "PAYLOAD_TWO_BODY",
  }),
];

function headerButton(container: HTMLElement): HTMLButtonElement {
  // The group header is the first button; its title carries the group state.
  const btn = container.querySelector<HTMLButtonElement>(
    'button[title$="tool group"]',
  );
  if (!btn) throw new Error("group header button not found");
  return btn;
}

function rowButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button.fs-tool-strip"),
  );
}

function rowButton(container: HTMLElement, index: number): HTMLButtonElement {
  const btn = rowButtons(container)[index];
  if (!btn) throw new Error(`row button ${index} not found`);
  return btn;
}

describe("ToolGroupBubble", () => {
  it("renders the group header with the tool-call count", () => {
    const { getByText } = render(<ToolGroupBubble mode="dark" items={ITEMS} />);
    expect(getByText("2 tool calls")).toBeInTheDocument();
  });

  it("starts collapsed: no row payload is visible", () => {
    const { queryByText } = render(
      <ToolGroupBubble mode="dark" items={ITEMS} />,
    );
    expect(queryByText("PAYLOAD_ONE_BODY")).toBeNull();
    expect(queryByText("PAYLOAD_TWO_BODY")).toBeNull();
  });

  it("clicking a row while collapsed expands the group AND opens that row in one click", () => {
    // Regression: previously a single click recorded hidden open state and
    // showed nothing — the operator had to expand the group separately, then
    // the row sprang open unexpectedly.
    const { container, getByText, queryByText } = render(
      <ToolGroupBubble mode="dark" items={ITEMS} />,
    );
    expect(queryByText("PAYLOAD_ONE_BODY")).toBeNull();

    fireEvent.click(rowButton(container, 0));

    // Group is now expanded (header title flipped) and the clicked row's
    // payload is visible — without a second click.
    expect(headerButton(container).title).toBe("Collapse tool group");
    expect(getByText("PAYLOAD_ONE_BODY")).toBeInTheDocument();
    // Sibling row stays closed — only the clicked row opened.
    expect(queryByText("PAYLOAD_TWO_BODY")).toBeNull();
  });

  it("expanding the group via the header does NOT auto-open any row payload", () => {
    // Regression: a leftover open id used to surface here as a ghost-expanded
    // row. Expanding should reveal the row list, nothing more.
    const { container, queryByText } = render(
      <ToolGroupBubble mode="dark" items={ITEMS} />,
    );
    fireEvent.click(headerButton(container));
    expect(headerButton(container).title).toBe("Collapse tool group");
    expect(queryByText("PAYLOAD_ONE_BODY")).toBeNull();
    expect(queryByText("PAYLOAD_TWO_BODY")).toBeNull();
  });

  it("collapsing the group clears open rows so re-expanding starts clean", () => {
    const { container, getByText, queryByText } = render(
      <ToolGroupBubble mode="dark" items={ITEMS} />,
    );
    // Expand group, open a row.
    fireEvent.click(headerButton(container));
    fireEvent.click(rowButton(container, 0));
    expect(getByText("PAYLOAD_ONE_BODY")).toBeInTheDocument();

    // Collapse, then expand again — no ghost-open row.
    fireEvent.click(headerButton(container)); // collapse
    expect(queryByText("PAYLOAD_ONE_BODY")).toBeNull();
    fireEvent.click(headerButton(container)); // expand again
    expect(queryByText("PAYLOAD_ONE_BODY")).toBeNull();
  });

  it("clicking an open row again collapses just that row, leaving the group expanded", () => {
    const { container, getByText, queryByText } = render(
      <ToolGroupBubble mode="dark" items={ITEMS} />,
    );
    fireEvent.click(rowButton(container, 0)); // expand group + open row
    expect(getByText("PAYLOAD_ONE_BODY")).toBeInTheDocument();

    fireEvent.click(rowButton(container, 0)); // close the row
    expect(queryByText("PAYLOAD_ONE_BODY")).toBeNull();
    // Group itself remains expanded.
    expect(headerButton(container).title).toBe("Collapse tool group");
  });

  it("renders an in-flight execution row without a payload toggle", () => {
    const executing: ExecutingToolCall = {
      toolCallId: "call-run",
      name: "fs_pods_run",
      startedAt: Date.now(),
    };
    const items: ToolGroupItem[] = [{ kind: "executing", entry: executing }];
    const { getByText, container } = render(
      <ToolGroupBubble mode="dark" items={items} />,
    );
    expect(getByText("fs_pods_run")).toBeInTheDocument();
    expect(getByText("running")).toBeInTheDocument();
    // Executing rows are not clickable strips — no payload to expand yet.
    expect(rowButtons(container)).toHaveLength(0);
  });
});
