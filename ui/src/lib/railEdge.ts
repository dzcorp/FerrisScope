import { useEffect } from "react";

export const RAIL_COLLAPSED_W = 56;
export const RAIL_OPEN_W = 220;

/// The rail's open/close animation, shared by anything that follows it.
export const RAIL_EASE = ".18s cubic-bezier(.2,.7,.2,1)";

const VAR = "--fs-rail-w";

/// Left edge for panels that sit beside the rail: its visible width, or 0
/// when no rail is shown.
export const RAIL_EDGE = `var(${VAR}, 0px)`;
export const RAIL_EDGE_TRANSITION = `left ${RAIL_EASE}`;

/// Publish the rail's visible width (pinned, hover-expanded or collapsed) so
/// bottom-docked panels start where it ends and move with it.
export function useRailEdge(open: boolean): void {
  const value = `${open ? RAIL_OPEN_W : RAIL_COLLAPSED_W}px`;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty(VAR, value);
    return () => {
      if (root.getPropertyValue(VAR) === value) root.removeProperty(VAR);
    };
  }, [value]);
}
