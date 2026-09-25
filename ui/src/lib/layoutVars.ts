import { useEffect, useState } from "react";

/// Resizes settle for this long before the variable updates: changing a
/// `:root` variable restyles the whole document, so a drag must not do it
/// every frame.
export const PUBLISH_SETTLE_MS = 150;

/// Publish an element's rendered size as a `:root` CSS variable while
/// `enabled`, so content under a fixed overlay can reserve room for it.
/// Attach the returned callback as the element's `ref`; the element itself
/// is returned too. Removed on disable/unmount unless another publisher took
/// the variable.
export function usePublishedSize<E extends HTMLElement>(
  cssVar: string,
  axis: "width" | "height",
  enabled: boolean,
): [(el: E | null) => void, E | null] {
  const [el, setEl] = useState<E | null>(null);
  useEffect(() => {
    if (!enabled || !el) return;
    const root = document.documentElement.style;
    let value = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      const next = `${Math.round(el.getBoundingClientRect()[axis])}px`;
      if (next === value) return;
      value = next;
      root.setProperty(cssVar, value);
    };
    apply();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(apply, PUBLISH_SETTLE_MS);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      if (root.getPropertyValue(cssVar) === value) root.removeProperty(cssVar);
    };
  }, [el, enabled, cssVar, axis]);
  return [setEl, el];
}
