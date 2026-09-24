import { useEffect, type RefObject } from "react";
import { useTabActive } from "./tabScope";

const VAR = "--fs-table-body-top";

/// Publish the top edge of the visible table's body (below its header row)
/// so right-edge chrome — the panel tray — starts there, clear of the header
/// row's controls.
export function useTableTop(ref: RefObject<HTMLElement | null>): void {
  const active = useTabActive();
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const root = document.documentElement.style;
    let value = "";
    const measure = () => {
      value = `${Math.round(el.getBoundingClientRect().top)}px`;
      root.setProperty(VAR, value);
    };
    measure();
    // The shell resizes whenever anything above it (bars, banners) or the
    // window changes height, which is exactly when its top can move.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      if (root.getPropertyValue(VAR) === value) root.removeProperty(VAR);
    };
  }, [ref, active]);
}
