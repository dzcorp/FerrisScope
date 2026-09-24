import { useEffect } from "react";
import { useTabActive } from "./tabScope";

const VAR = "--fs-drawer-w";

/// Publish the open drawer's width so the tray can dock against its left edge
/// instead of covering it.
export function useDrawerEdge(width: number | string): void {
  const value = typeof width === "number" ? `${width}px` : width;
  const active = useTabActive();
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement.style;
    root.setProperty(VAR, value);
    return () => {
      if (root.getPropertyValue(VAR) === value) root.removeProperty(VAR);
    };
  }, [value, active]);
}
