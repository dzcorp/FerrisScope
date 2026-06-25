import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyClipboardKeyToInput } from "./monacoClipboard";

function makeInput(value: string, selStart: number, selEnd: number) {
  const el = document.createElement("textarea");
  el.value = value;
  document.body.appendChild(el);
  el.setSelectionRange(selStart, selEnd);
  return el;
}

describe("applyClipboardKeyToInput", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("paste inserts clipboard text at the caret and fires input", async () => {
    const el = makeInput("ab", 1, 1);
    const onInput = vi.fn();
    el.addEventListener("input", onInput);
    const read = vi.fn().mockResolvedValue("XY");
    const write = vi.fn();

    const acted = await applyClipboardKeyToInput(el, "paste", { read, write });

    expect(acted).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(el.value).toBe("aXYb");
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("paste replaces the current selection", async () => {
    const el = makeInput("abcd", 1, 3); // selects "bc"
    const acted = await applyClipboardKeyToInput(el, "paste", {
      read: vi.fn().mockResolvedValue("X"),
      write: vi.fn(),
    });
    expect(acted).toBe(true);
    expect(el.value).toBe("aXd");
  });

  it("paste is a no-op when the clipboard is empty", async () => {
    const el = makeInput("ab", 1, 1);
    const acted = await applyClipboardKeyToInput(el, "paste", {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn(),
    });
    expect(acted).toBe(false);
    expect(el.value).toBe("ab");
  });

  it("copy writes the selected substring without mutating the value", async () => {
    const el = makeInput("hello world", 0, 5); // "hello"
    const write = vi.fn().mockResolvedValue(undefined);

    const acted = await applyClipboardKeyToInput(el, "copy", {
      read: vi.fn(),
      write,
    });

    expect(acted).toBe(true);
    expect(write).toHaveBeenCalledWith("hello");
    expect(el.value).toBe("hello world");
  });

  it("cut writes the selection then removes it", async () => {
    const el = makeInput("hello world", 0, 6); // "hello "
    const write = vi.fn().mockResolvedValue(undefined);

    const acted = await applyClipboardKeyToInput(el, "cut", {
      read: vi.fn(),
      write,
    });

    expect(acted).toBe(true);
    expect(write).toHaveBeenCalledWith("hello ");
    expect(el.value).toBe("world");
  });

  it("copy/cut are no-ops without a selection", async () => {
    const el = makeInput("abc", 2, 2);
    const write = vi.fn();
    expect(
      await applyClipboardKeyToInput(el, "copy", { read: vi.fn(), write }),
    ).toBe(false);
    expect(
      await applyClipboardKeyToInput(el, "cut", { read: vi.fn(), write }),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(el.value).toBe("abc");
  });
});
