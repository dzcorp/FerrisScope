import { useEffect, useRef } from "react";
import { useTabActive } from "./tabScope";

type Layer = { onEsc: () => void; blurInputsFirst: boolean };

const stack: Layer[] = [];

function isEditable(el: EventTarget | null): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") != null
  );
}

export function handleEscape(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (top.blurInputsFirst && isEditable(e.target)) {
    e.target.blur();
    return;
  }
  top.onEsc();
}

// Installed at import time so it runs before any later window keydown
// listener (App's hotkeys) and can swallow an Esc a layer consumed.
if (typeof window !== "undefined") window.addEventListener("keydown", handleEscape);

export function escStackDepth(): number {
  return stack.length;
}

/// Register an Esc-closable layer while `active`. Only the most recently
/// activated layer receives Esc, so stacked drawers/popovers unwind one at a
/// time. Handlers that must win over a layer (a find bar, an inline editor)
/// call `preventDefault()` or `stopPropagation()` first.
export function useEscLayer(
  active: boolean,
  onEsc: () => void,
  opts: { blurInputsFirst?: boolean } = {},
): void {
  const ref = useRef(onEsc);
  ref.current = onEsc;
  const blurInputsFirst = opts.blurInputsFirst ?? false;
  // A layer inside a hidden keep-alive tab must not catch the visible tab's Esc.
  const tabActive = useTabActive();
  const on = active && tabActive;
  useEffect(() => {
    if (!on) return;
    const layer: Layer = { onEsc: () => ref.current(), blurInputsFirst };
    stack.push(layer);
    return () => {
      const i = stack.lastIndexOf(layer);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [on, blurInputsFirst]);
}
