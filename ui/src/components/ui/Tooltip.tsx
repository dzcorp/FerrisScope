import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FF_MONO, type ThemeMode, R_MD, R_SM, FS_SM, FS_XS } from "../../theme";
import { useAppStore, useResolvedTheme } from "../../store";

type Side = "top" | "bottom" | "left" | "right";

type TooltipProps = {
  label: ReactNode;
  kbd?: string;
  side?: Side;
  delay?: number;
  // Disable without removing the wrapper — useful when a control's title is
  // conditional (e.g. only shown when the rail is collapsed).
  disabled?: boolean;
  children: ReactElement;
};

// Themed hover hint. Replaces the native `title` attribute everywhere a label
// would otherwise come from the OS. Anti-pattern guardrail (design-principles
// §05): reserve for compact-glyph aliases, disabled-action reasons, and probe
// errors — not for coach-marks. The wrapped child must accept a ref + the
// mouse/focus props we forward.
export function Tooltip({
  label,
  kbd,
  side = "bottom",
  delay = 350,
  disabled,
  children,
}: TooltipProps) {
  const themeMode = useAppStore((s) => s.themeMode);
  const t = useResolvedTheme().tokens;
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; placedSide: Side }>({
    x: 0,
    y: 0,
    placedSide: side,
  });

  const clearShow = () => {
    if (showTimer.current != null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };

  const place = useCallback(() => {
    const trig = triggerRef.current;
    const tip = tipRef.current;
    if (!trig || !tip) return;
    const tr = trig.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    const gap = 8;
    const margin = 6;

    const placements: Record<Side, { x: number; y: number }> = {
      top: { x: tr.left + tr.width / 2 - r.width / 2, y: tr.top - r.height - gap },
      bottom: {
        x: tr.left + tr.width / 2 - r.width / 2,
        y: tr.bottom + gap,
      },
      left: { x: tr.left - r.width - gap, y: tr.top + tr.height / 2 - r.height / 2 },
      right: { x: tr.right + gap, y: tr.top + tr.height / 2 - r.height / 2 },
    };

    const fits = (s: Side) => {
      const p = placements[s];
      return (
        p.x >= margin &&
        p.y >= margin &&
        p.x + r.width <= window.innerWidth - margin &&
        p.y + r.height <= window.innerHeight - margin
      );
    };
    const flipMap: Record<Side, Side> = {
      top: "bottom",
      bottom: "top",
      left: "right",
      right: "left",
    };
    const chosen: Side = fits(side) ? side : fits(flipMap[side]) ? flipMap[side] : side;
    let { x, y } = placements[chosen];
    x = Math.max(margin, Math.min(x, window.innerWidth - r.width - margin));
    y = Math.max(margin, Math.min(y, window.innerHeight - r.height - margin));
    setPos({ x, y, placedSide: chosen });
  }, [side]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, label, kbd]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => () => clearShow(), []);

  if (!isValidElement(children)) return children;
  if (disabled || (!label && !kbd)) return children;

  const onEnter = (e: React.MouseEvent | React.FocusEvent) => {
    triggerRef.current = e.currentTarget as HTMLElement;
    clearShow();
    showTimer.current = window.setTimeout(() => setOpen(true), delay);
    const child = children as ReactElement<{
      onMouseEnter?: (e: React.MouseEvent) => void;
      onFocus?: (e: React.FocusEvent) => void;
    }>;
    if (e.type === "mouseenter") child.props.onMouseEnter?.(e as React.MouseEvent);
    else child.props.onFocus?.(e as React.FocusEvent);
  };
  const onLeave = (e: React.MouseEvent | React.FocusEvent) => {
    clearShow();
    setOpen(false);
    const child = children as ReactElement<{
      onMouseLeave?: (e: React.MouseEvent) => void;
      onBlur?: (e: React.FocusEvent) => void;
    }>;
    if (e.type === "mouseleave") child.props.onMouseLeave?.(e as React.MouseEvent);
    else child.props.onBlur?.(e as React.FocusEvent);
  };

  const cloned = cloneElement(
    children as ReactElement<Record<string, unknown>>,
    {
      onMouseEnter: onEnter,
      onMouseLeave: onLeave,
      onFocus: onEnter,
      onBlur: onLeave,
    },
  );

  const tipStyle: CSSProperties = {
    position: "fixed",
    top: pos.y,
    left: pos.x,
    zIndex: 9999,
    pointerEvents: "none",
    // Tooltips intentionally invert the surface — dark on light themes,
    // even darker on dark themes — for readability against any backdrop.
    // `bulkBg` is the same near-black we use for the bulk-action bar, so
    // tooltips read as the same "modal/floating" surface across themes.
    background: t.bulkBg,
    color: themeMode === "dark" ? t.text : "#f4f6f9",
    border: `1px solid ${themeMode === "dark" ? t.border : "rgba(255,255,255,0.06)"}`,
    borderRadius: R_MD,
    padding: "5px 8px",
    fontSize: FS_SM,
    lineHeight: 1.35,
    letterSpacing: -0.05,
    maxWidth: 320,
    boxShadow:
      themeMode === "dark"
        ? "0 8px 24px rgba(0,0,0,0.45)"
        : "0 8px 24px rgba(15,20,30,0.22)",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    opacity: open ? 1 : 0,
    transition: "opacity .08s ease-out",
  };

  return (
    <>
      {cloned}
      {open &&
        createPortal(
          <div ref={tipRef} role="tooltip" style={tipStyle}>
            <span>{label}</span>
            {kbd && (
              <span
                style={{
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  padding: "1px 5px",
                  borderRadius: R_SM,
                  background: "rgba(255,255,255,0.10)",
                  color: "rgba(255,255,255,0.78)",
                }}
              >
                {kbd}
              </span>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// Convenience for components that already take a `mode` instead of pulling
// from the store. Keeps the existing call sites tidy.
export function TooltipFor({
  mode: mode,
  ...rest
}: TooltipProps & { mode?: ThemeMode }) {
  return <Tooltip {...rest} />;
}
