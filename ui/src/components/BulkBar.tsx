import { useState, type ReactNode } from "react";
import { useResolvedTheme } from "../store";
import { type ThemeMode, R_LG, R_MD, FS_MD, FS_SM } from "../theme";
import { Icons } from "./ui";

export type BulkAction = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
};
type Action = BulkAction;

type Props = {
  mode: ThemeMode;
  count: number;
  actions: Action[];
  onClear: () => void;
};

// HV2BulkBar — floating dock-style bar pinned to bottom-center. Slides up on
// first selection (R-03). Destructive actions sit at the trailing position
// behind a divider per R-04.
export function BulkBar({ count, actions, onClear }: Props) {
  const t = useResolvedTheme().tokens;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 22,
        left: "50%",
        transform: "translateX(-50%)",
        background: t.bulkBg,
        color: "#fff",
        borderRadius: R_LG,
        padding: "8px 8px 8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        boxShadow:
          "0 12px 36px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06)",
        zIndex: 35,
        animation: "fs-bulk-rise .18s cubic-bezier(.2,.7,.2,1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: FS_MD,
          fontWeight: 500,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 20,
            height: 20,
            padding: "0 6px",
            background: "rgba(255,255,255,0.16)",
            borderRadius: R_LG,
            fontSize: FS_SM,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count}
        </span>
        <span>selected</span>
      </div>

      {actions.map((a, i) => (
        <span key={i} style={{ display: "contents" }}>
          {a.separatorBefore && (
            <div
              style={{
                width: 1,
                height: 18,
                background: "rgba(255,255,255,0.14)",
              }}
            />
          )}
          <BulkActionButton
            icon={a.icon}
            label={a.label}
            onClick={a.onClick}
            danger={a.danger}
          />
        </span>
      ))}

      <div
        style={{
          width: 1,
          height: 18,
          background: "rgba(255,255,255,0.14)",
        }}
      />
      <button
        type="button"
        title="Clear selection (Esc)"
        onClick={onClear}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "rgba(255,255,255,0.10)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "transparent")
        }
        style={{
          width: 28,
          height: 28,
          borderRadius: R_MD,
          border: "none",
          background: "transparent",
          color: "rgba(255,255,255,0.7)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {Icons.close}
      </button>
    </div>
  );
}

function BulkActionButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        height: 28,
        borderRadius: R_MD,
        border: "none",
        background: hover
          ? danger
            ? "rgba(244,63,94,0.18)"
            : "rgba(255,255,255,0.10)"
          : "transparent",
        color: danger ? (hover ? "#fca5a5" : "#f87171") : "#ffffff",
        fontFamily: "inherit",
        fontSize: FS_MD,
        fontWeight: 500,
        cursor: "pointer",
        transition: "background .12s, color .12s",
      }}
    >
      <span style={{ display: "inline-flex", opacity: 0.85 }}>{icon}</span>
      {label}
    </button>
  );
}
