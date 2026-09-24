import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { escStackDepth, useEscLayer } from "./escStack";

function esc(target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("useEscLayer", () => {
  it("closes only the most recently opened layer", () => {
    const a = vi.fn();
    const b = vi.fn();
    const ha = renderHook(() => useEscLayer(true, a));
    const hb = renderHook(() => useEscLayer(true, b));
    esc();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    hb.unmount();
    esc();
    expect(a).toHaveBeenCalledTimes(1);
    ha.unmount();
    expect(escStackDepth()).toBe(0);
  });

  it("swallows a consumed Esc so later window listeners don't see it", () => {
    const later = vi.fn();
    const h = renderHook(() => useEscLayer(true, () => {}));
    window.addEventListener("keydown", later);
    esc();
    expect(later).not.toHaveBeenCalled();
    h.unmount();
    esc();
    expect(later).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", later);
  });

  it("ignores an Esc another handler already claimed", () => {
    const f = vi.fn();
    const h = renderHook(() => useEscLayer(true, f));
    const claim = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", claim, true);
    esc();
    window.removeEventListener("keydown", claim, true);
    expect(f).not.toHaveBeenCalled();
    h.unmount();
  });

  it("inactive layers don't register", () => {
    const f = vi.fn();
    const h = renderHook(({ on }) => useEscLayer(on, f), { initialProps: { on: false } });
    esc();
    expect(f).not.toHaveBeenCalled();
    h.rerender({ on: true });
    esc();
    expect(f).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("blurInputsFirst blurs a focused field before closing", () => {
    const f = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const h = renderHook(() => useEscLayer(true, f, { blurInputsFirst: true }));
    esc(input);
    expect(f).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    esc();
    expect(f).toHaveBeenCalledTimes(1);
    h.unmount();
    input.remove();
  });

  it("uses the latest handler without re-registering", () => {
    const first = vi.fn();
    const second = vi.fn();
    const h = renderHook(({ fn }) => useEscLayer(true, fn), { initialProps: { fn: first } });
    h.rerender({ fn: second });
    esc();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    h.unmount();
  });
});
