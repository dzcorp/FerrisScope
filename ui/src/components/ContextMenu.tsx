import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { tokens, FONT_MONO, type ThemeMode } from "../theme";

export type MenuItem =
  | {
      kind: "item";
      label: string;
      onClick: () => void;
      disabled?: boolean;
      danger?: boolean;
    }
  | { kind: "separator" };

export type MenuPosition = { x: number; y: number };

type Props = {
  mode: ThemeMode;
  position: MenuPosition;
  items: MenuItem[];
  onClose: () => void;
  rowName?: string;
};

// Right-click menu — mirrors HV2PodMenu. Mono header pins the row's identity,
// danger items always trail (R-04). Esc and outside-click both close.
export function ContextMenu({ mode, position, items, onClose, rowName }: Props) {
  const t = tokens(mode);
  const ref = useRef<HTMLDivElement | null>(null);
  const [adjusted, setAdjusted] = useState<MenuPosition>(position);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { x, y } = position;
    if (x + r.width > window.innerWidth - 4) x = window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight - 4)
      y = window.innerHeight - r.height - 4;
    setAdjusted({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [position]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        top: adjusted.y,
        left: adjusted.x,
        minWidth: 210,
        zIndex: 50,
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        boxShadow:
          mode === "dark"
            ? "0 12px 32px rgba(0,0,0,0.45)"
            : "0 12px 32px rgba(15,20,30,0.18)",
        padding: "6px 0",
      }}
    >
      {rowName && (
        <div
          style={{
            padding: "4px 12px 6px",
            fontSize: 10.5,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            borderBottom: `1px solid ${t.borderSoft}`,
            marginBottom: 4,
          }}
        >
          {rowName}
        </div>
      )}
      {items.map((it, i) =>
        it.kind === "separator" ? (
          <div
            key={`sep-${i}`}
            style={{
              height: 1,
              background: t.borderSoft,
              margin: "4px 0",
            }}
          />
        ) : (
          <MenuRow
            key={`${it.label}-${i}`}
            t={t}
            danger={!!it.danger}
            disabled={!!it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
          >
            {it.label}
          </MenuRow>
        ),
      )}
    </div>
  );
}

function MenuRow({
  t,
  danger,
  disabled,
  onClick,
  children,
}: {
  t: ReturnType<typeof tokens>;
  danger: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const baseStyle: CSSProperties = {
    width: "100%",
    display: "flex",
    alignItems: "center",
    padding: "6px 12px",
    border: "none",
    background: hover
      ? danger
        ? "rgba(244,63,94,0.10)"
        : t.hover
      : "transparent",
    color: disabled ? t.textMuted : danger ? "#dc2626" : t.text,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    fontSize: 12.5,
    textAlign: "left",
    minHeight: 30,
    opacity: disabled ? 0.55 : 1,
  };
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={baseStyle}
    >
      {children}
    </button>
  );
}
