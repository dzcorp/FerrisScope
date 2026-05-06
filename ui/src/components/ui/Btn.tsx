import {
  cloneElement,
  forwardRef,
  isValidElement,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { FONT_MONO, type Tokens } from "../../theme";
import { Tooltip } from "./Tooltip";

export type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
export type BtnSize = "sm" | "md";

type BtnProps = {
  t: Tokens;
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  kbd?: string;
  children?: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  style?: CSSProperties;
  fullWidth?: boolean;
};

// Push button for primary/secondary/ghost/danger variants. Hit target ≥ 28px
// per R-08; primary uses the accent token, danger never colors a default
// action (callers place danger in trailing menu items per R-04).
export function Btn({
  t,
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  kbd,
  children,
  onClick,
  disabled,
  title,
  type = "button",
  style,
  fullWidth,
}: BtnProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const sizes =
    size === "sm"
      ? { pad: "5px 10px", fs: 11.5, h: 26, gap: 6, iconSz: 12 }
      : { pad: "7px 13px", fs: 12.5, h: 32, gap: 7, iconSz: 13 };

  const variants: Record<
    BtnVariant,
    { bg: string; fg: string; border: string; shadow: string }
  > = {
    primary: {
      bg: active ? t.accentActive : hover ? t.accentHover : t.accent,
      fg: "#ffffff",
      border: "transparent",
      shadow: hover
        ? `0 1px 2px rgba(15,20,30,0.10), 0 0 0 3px ${t.accentSoft}`
        : "0 1px 2px rgba(15,20,30,0.06)",
    },
    secondary: {
      bg: hover ? t.btnHover : t.surface,
      fg: t.text,
      border: t.border,
      shadow: "0 1px 0 rgba(15,20,30,0.02)",
    },
    ghost: {
      bg: hover ? t.hover : "transparent",
      fg: t.textDim,
      border: "transparent",
      shadow: "none",
    },
    danger: {
      bg: hover ? "rgba(244,63,94,0.12)" : "transparent",
      fg: "#dc2626",
      border: hover ? "rgba(244,63,94,0.32)" : "transparent",
      shadow: "none",
    },
  };

  const v = variants[variant];

  const btn = (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: sizes.gap,
        padding: sizes.pad,
        height: sizes.h,
        width: fullWidth ? "100%" : undefined,
        border: `1px solid ${v.border}`,
        borderRadius: 7,
        background: v.bg,
        color: v.fg,
        fontFamily: "inherit",
        fontSize: sizes.fs,
        fontWeight: variant === "primary" ? 600 : 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        outline: "none",
        boxShadow: v.shadow,
        transform: active ? "translateY(0.5px)" : "none",
        transition: "background .12s, box-shadow .12s, transform .05s",
        letterSpacing: -0.05,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon && (
        <span
          style={{
            display: "inline-flex",
            width: sizes.iconSz,
            height: sizes.iconSz,
          }}
        >
          {icon}
        </span>
      )}
      {children}
      {iconRight && (
        <span
          style={{
            display: "inline-flex",
            width: sizes.iconSz,
            height: sizes.iconSz,
            opacity: 0.7,
          }}
        >
          {iconRight}
        </span>
      )}
      {kbd && (
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            background:
              variant === "primary" ? "rgba(255,255,255,0.18)" : t.chip,
            color:
              variant === "primary" ? "rgba(255,255,255,0.8)" : t.textMuted,
            marginLeft: 2,
          }}
        >
          {kbd}
        </span>
      )}
    </button>
  );

  return title ? <Tooltip label={title}>{btn}</Tooltip> : btn;
}

export type IconBtnSize = "sm" | "md" | "lg";

type IconBtnProps = {
  t: Tokens;
  title?: string;
  kbd?: string;
  size?: IconBtnSize;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
};

// Square icon-only button. `sm` (28/16) is the default — header / dock / panel
// chrome. `md` (32/18) and `lg` (36/20) bump both the hit target and the
// rendered glyph for surfaces where the icon row is the primary affordance
// (detail-panel header). The inner SVG's intrinsic width/height (set by the
// `filled` helper in icons.tsx) is overridden via CSS so a single `size` prop
// drives both dimensions without changing every icon definition.
const ICON_SIZES: Record<IconBtnSize, { box: number; glyph: number; radius: number }> = {
  sm: { box: 28, glyph: 16, radius: 6 },
  md: { box: 32, glyph: 18, radius: 7 },
  lg: { box: 36, glyph: 20, radius: 8 },
};

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(
  function IconBtn(
    { t, title, kbd, size = "sm", onClick, active, danger, disabled, children },
    ref,
  ) {
    const [hover, setHover] = useState(false);
    const effectiveHover = hover && !disabled;
    const bg = disabled
      ? "transparent"
      : danger
        ? effectiveHover
          ? "rgba(244,63,94,0.12)"
          : "transparent"
        : active
          ? t.accentSoft
          : effectiveHover
            ? t.hover
            : "transparent";
    const fg = disabled
      ? t.textMuted
      : danger
        ? "#dc2626"
        : active
          ? t.accent
          : t.textDim;
    const dims = ICON_SIZES[size];
    // Icons in `icons.tsx` are baked with explicit width/height attributes via
    // the `filled(size, …)` helper. To resize per IconBtn variant, clone the
    // child element and override those attributes; fall back to wrapping for
    // non-element children (text, fragments).
    const sized: ReactNode = isValidElement(children)
      ? cloneElement(
          children as ReactElement<{ width?: number; height?: number }>,
          { width: dims.glyph, height: dims.glyph },
        )
      : children;
    const btn = (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: dims.box,
          height: dims.box,
          borderRadius: dims.radius,
          border: "none",
          background: bg,
          color: fg,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background .12s, opacity .12s",
        }}
      >
        {sized}
      </button>
    );
    return title ? (
      <Tooltip label={title} kbd={kbd}>
        {btn}
      </Tooltip>
    ) : (
      btn
    );
  },
);
