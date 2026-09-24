import { useEffect, type RefObject } from "react";

function scrollables(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: HTMLElement) => {
    if (el.scrollHeight > el.clientHeight) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") out.push(el);
    }
    for (const c of el.children) if (c instanceof HTMLElement) walk(c);
  };
  walk(root);
  return out;
}

/// Scroll offset of the outermost scrolled region under `root`.
export function scrollTopWithin(root: HTMLElement | null): number {
  if (!root) return 0;
  return scrollables(root).find((el) => el.scrollTop > 0)?.scrollTop ?? 0;
}

/// Re-apply a remembered offset once content is tall enough. Content loads
/// asynchronously, so this retries per frame for up to ~2 s, then gives up.
export function useRestoreScroll(
  ref: RefObject<HTMLElement | null>,
  scrollTop: number | undefined,
): void {
  useEffect(() => {
    if (!scrollTop) return;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      const target = ref.current
        ? scrollables(ref.current).find((el) => el.scrollHeight - el.clientHeight >= scrollTop)
        : undefined;
      if (target) {
        target.scrollTop = scrollTop;
        return;
      }
      if (++frames < 120) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Only the value it mounted with matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
