// The minimised chat pill is the right-edge affordance shown while the chat
// dock is hidden. With sessions living inside one chat window the dock holds a
// single chat tab, so the pill behaves as one unit: clicking anywhere on it
// restores the chat, and a single close button (which must NOT also restore)
// tears it down. These tests pin that contract.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MinimizedChatPill } from "./MinimizedChatPill";
import { tokens } from "../theme";

const T = tokens("dark");

// The pill body is a div[role="button"] labelled "Restore chat"; the close
// control is the only real <button> rendered inside it.
function closeButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector("button");
  if (!btn) throw new Error("close button not found");
  return btn;
}

describe("MinimizedChatPill", () => {
  it("labels the pill 'Chat' for a single chat", () => {
    const { getByText } = render(
      <MinimizedChatPill t={T} count={1} onRestore={() => {}} onClose={() => {}} />,
    );
    expect(getByText("Chat")).toBeInTheDocument();
  });

  it("pluralises the label when more than one chat is open", () => {
    const { getByText } = render(
      <MinimizedChatPill t={T} count={3} onRestore={() => {}} onClose={() => {}} />,
    );
    expect(getByText("3 chats")).toBeInTheDocument();
  });

  it("uses no native title attribute on the restore body (themed tooltip only)", () => {
    // Regression: the pill once carried `title="Restore chat"`, which renders
    // the OS tooltip the rest of the app deliberately replaces with <Tooltip>.
    const { getByRole } = render(
      <MinimizedChatPill t={T} count={1} onRestore={() => {}} onClose={() => {}} />,
    );
    expect(getByRole("button", { name: "Restore chat" })).not.toHaveAttribute(
      "title",
    );
  });

  it("restores when the pill body is clicked", () => {
    const onRestore = vi.fn();
    const { getByRole } = render(
      <MinimizedChatPill t={T} count={1} onRestore={onRestore} onClose={() => {}} />,
    );
    fireEvent.click(getByRole("button", { name: "Restore chat" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("restores on Enter / Space for keyboard users", () => {
    const onRestore = vi.fn();
    const { getByRole } = render(
      <MinimizedChatPill t={T} count={1} onRestore={onRestore} onClose={() => {}} />,
    );
    const pill = getByRole("button", { name: "Restore chat" });
    fireEvent.keyDown(pill, { key: "Enter" });
    fireEvent.keyDown(pill, { key: " " });
    expect(onRestore).toHaveBeenCalledTimes(2);
  });

  it("closes — and does NOT restore — when the close button is clicked", () => {
    // The close button lives inside the clickable pill; stopPropagation must
    // keep its click from bubbling up into the restore handler.
    const onRestore = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <MinimizedChatPill t={T} count={1} onRestore={onRestore} onClose={onClose} />,
    );
    fireEvent.click(closeButton(container));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
  });
});
