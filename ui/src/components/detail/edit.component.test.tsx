// Component-level tests for the inline-edit kit. Pure helpers
// (kvBuffer*) live in edit.test.ts; this file covers the rendered
// pieces — KvEditor, ConflictBanner — that compose them.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import {
  ConflictBanner,
  KvEditor,
  kvBufferFromPairs,
  type KvBuffer,
} from "./edit";
import { tokens } from "../../theme";

const t = tokens("dark");

// Tiny harness so KvEditor's controlled buffer has somewhere to live in a
// component test. Exposes the latest buffer to the test via the spy.
function HostedKvEditor({
  initial,
  duplicates,
  validateKey,
  onSnapshot,
}: {
  initial: KvBuffer;
  duplicates?: Set<string>;
  validateKey?: (k: string) => boolean;
  onSnapshot?: (b: KvBuffer) => void;
}) {
  const [buffer, setBuffer] = useState<KvBuffer>(initial);
  return (
    <KvEditor
      t={t}
      buffer={buffer}
      onChange={(next) => {
        setBuffer(next);
        onSnapshot?.(next);
      }}
      duplicates={duplicates}
      validateKey={validateKey}
    />
  );
}

describe("KvEditor", () => {
  it("renders one row per existing pair", () => {
    render(
      <HostedKvEditor
        initial={kvBufferFromPairs([
          ["a", "1"],
          ["b", "2"],
        ])}
      />,
    );
    // Each row has a key input + value input. We find them by their
    // initial values rather than by label since the design omits labels.
    expect(screen.getByDisplayValue("a")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("b")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
  });

  it("typing into a key input flushes the buffer through onChange", () => {
    const onSnap = vi.fn();
    render(
      <HostedKvEditor
        initial={kvBufferFromPairs([["a", "1"]])}
        onSnapshot={onSnap}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("a"), {
      target: { value: "alpha" },
    });
    const last = onSnap.mock.calls.at(-1)?.[0] as KvBuffer;
    expect(last.rows[0]?.key).toBe("alpha");
    expect(last.rows[0]?.value).toBe("1");
  });

  it("Add button appends a new blank row", () => {
    render(<HostedKvEditor initial={kvBufferFromPairs([])} />);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    fireEvent.click(screen.getByText("Add"));
    // A new row has 2 inputs (key + value).
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("delete button on existing row strikes the row and shows Restore", () => {
    render(
      <HostedKvEditor initial={kvBufferFromPairs([["a", "1"]])} />,
    );
    // The trashcan/× button is a button; there are two buttons total
    // (the row × and the bottom +Add). We pick the row's by title.
    const removeBtn = screen.getByTitle("Remove");
    fireEvent.click(removeBtn);
    // After delete, the inputs are replaced by struck-through plain text
    // "a=1" — the inputs are gone.
    expect(screen.queryByDisplayValue("a")).not.toBeInTheDocument();
    expect(screen.getByText("a=1")).toBeInTheDocument();
    // A Restore tooltip-titled button is rendered in place.
    expect(screen.getByTitle("Restore")).toBeInTheDocument();
  });

  it("delete on a brand-new row removes it entirely (no Restore)", () => {
    render(<HostedKvEditor initial={kvBufferFromPairs([])} />);
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    fireEvent.click(screen.getByTitle("Remove"));
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByTitle("Restore")).not.toBeInTheDocument();
  });

  it("duplicate keys render the second row's key with the invalid (red) outline", () => {
    const initial = kvBufferFromPairs([
      ["dup", "first"],
      ["dup", "second"],
    ]);
    const { container } = render(<HostedKvEditor initial={initial} />);
    const keyInputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="text"]',
    );
    // Inputs interleave key, value, key, value, ... — pick odd-positioned
    // (every key) and confirm both have the red border.
    const keyA = keyInputs[0];
    const keyB = keyInputs[2];
    expect(keyA).toBeDefined();
    expect(keyB).toBeDefined();
    // Border colour goes red when invalid (uses theme's `bad` token).
    // jsdom renders the border-shorthand as separate computed parts; we
    // assert the inline style contains the bad colour.
    expect(keyA?.getAttribute("style")).toContain("rgb(244, 63, 94)");
    expect(keyB?.getAttribute("style")).toContain("rgb(244, 63, 94)");
  });

  it("validateKey=false on a non-empty key flags the input as invalid", () => {
    // Reject keys containing uppercase letters — common label-key rule.
    const validateKey = (k: string) => /^[a-z0-9._-]*$/.test(k);
    const { container } = render(
      <HostedKvEditor
        initial={kvBufferFromPairs([["GoodKey", "v"]])}
        validateKey={validateKey}
      />,
    );
    const keyInput = container.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    expect(keyInput?.getAttribute("style")).toContain("rgb(244, 63, 94)");
  });

  it("empty-key new rows do not flag as invalid (placeholder, not error)", () => {
    const { container } = render(
      <HostedKvEditor
        initial={kvBufferFromPairs([])}
        validateKey={(k) => /^[a-z]+$/.test(k)}
      />,
    );
    fireEvent.click(screen.getByText("Add"));
    const keyInput = container.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    // Empty value → no validation triggered → no red outline.
    expect(keyInput?.getAttribute("style")).not.toContain("rgb(244, 63, 94)");
  });
});

describe("ConflictBanner", () => {
  const baseConflict = {
    managers: ["other-tool"],
    fields: [".data.KEY", ".metadata.labels.team"],
    message: "conflicts with field manager other-tool",
  };

  it("renders managers and conflicting fields", () => {
    render(
      <ConflictBanner
        t={t}
        conflict={baseConflict}
        saving={false}
        onForce={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Conflict")).toBeInTheDocument();
    expect(screen.getByText(/with other-tool/)).toBeInTheDocument();
    // Field paths are joined with " · " into a single text node.
    expect(
      screen.getByText(/\.data\.KEY · \.metadata\.labels\.team/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("conflicts with field manager other-tool"),
    ).toBeInTheDocument();
  });

  it("falls back when managers list is empty", () => {
    render(
      <ConflictBanner
        t={t}
        conflict={{ managers: [], fields: [], message: "??" }}
        saving={false}
        onForce={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText("with another field manager"),
    ).toBeInTheDocument();
  });

  it("Force takeover and Cancel fire the right callbacks", () => {
    const onForce = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ConflictBanner
        t={t}
        conflict={baseConflict}
        saving={false}
        onForce={onForce}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText("Force takeover"));
    expect(onForce).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("saving=true disables both buttons and shows 'Forcing…' on the force btn", () => {
    const onForce = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ConflictBanner
        t={t}
        conflict={baseConflict}
        saving
        onForce={onForce}
        onDismiss={onDismiss}
      />,
    );
    const force = screen.getByText("Forcing…") as HTMLButtonElement;
    expect(force.disabled).toBe(true);
    const cancel = screen.getByText("Cancel") as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(force);
    fireEvent.click(cancel);
    // Disabled buttons must not fire onClick.
    expect(onForce).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
