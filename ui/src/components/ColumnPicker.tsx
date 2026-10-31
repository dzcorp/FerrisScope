import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useResolvedTheme } from "../store";
import { FF_MONO, FF_SANS, FS_MD, FS_SM, FS_XS, R_LG, R_MD, type Tokens, FW_SEMIBOLD, shade, LABEL_CASE, LABEL_FONT, labelTracking } from "../theme";
import type { ColumnDef } from "../types";
import { Checkbox, Icons } from "./ui";
import { labelColumnHeader } from "../lib/labelColumns";
import { useEscLayer } from "../lib/escStack";

type Props = {
  /// The kind's own columns; Name is always shown, so it isn't offered.
  columns: ColumnDef[];
  /// Built-in column ids turned off.
  hidden: string[];
  onToggleColumn: (id: string) => void;
  /// Distinct label keys present on the current rows (the universe to pick
  /// from), sorted.
  available: string[];
  /// Label keys currently promoted to columns.
  enabled: string[];
  /// Toggle one key on/off. The parent owns the persisted list.
  onToggle: (key: string) => void;
  /// Back to the kind's own columns: none hidden, no label columns.
  onReset: () => void;
};

// ColumnPicker — the table header's right-edge "⋯" control. Opens a dropdown
// that turns the kind's own columns on/off and adds custom columns from the
// label keys found on the current rows. The choices are owned + persisted per
// (scope, kind) by the parent ResourceTable.
export function ColumnPicker({
  columns,
  hidden,
  onToggleColumn,
  available,
  enabled,
  onToggle,
  onReset,
}: Props) {
  const resolved = useResolvedTheme();
  const t = resolved.tokens;
  const mode = resolved.mode;
  // Anchor of the open menu (viewport coords); null when closed.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const open = pos !== null;
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toggle = () => {
    if (open || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  useEscLayer(open, () => setPos(null));
  // Close on outside click, resize and Esc. Same pattern as SessionsPopover / Select.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n) && !menuRef.current?.contains(n))
        setPos(null);
    };
    const onResize = () => setPos(null);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const enabledSet = useMemo(() => new Set(enabled), [enabled]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const builtIn = useMemo(() => columns.filter((c) => c.id !== "name"), [columns]);
  // Union of available + enabled, so a key that was persisted but is no
  // longer present on any current row can still be unchecked here. Sorted
  // for stable scanning.
  const keys = useMemo(() => {
    const s = new Set(available);
    for (const k of enabled) s.add(k);
    return [...s].sort();
  }, [available, enabled]);

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        display: "flex",
        // Last header cell: fixed width, never shrinks, stretches to the full
        // header height (parent header is display:flex, align-items:stretch).
        width: 30,
        flexShrink: 0,
        alignSelf: "stretch",
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Customize columns"
        title="Customize columns"
        onClick={toggle}
        style={{
          width: 30,
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: open ? t.surfaceAlt : t.headerAlt,
          border: "none",
          borderLeft: `1px solid ${t.border}`,
          color: open ? t.text : t.textMuted,
          cursor: "pointer",
          padding: 0,
        }}
      >
        {Icons.more}
      </button>
      {pos &&
        // Portalled: the table is its own stacking context, so the menu
        // would otherwise sit under the panel tray and drawers.
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              position: "fixed",
              top: pos.top,
              right: pos.right,
              zIndex: 50,
              width: 280,
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: R_LG,
              boxShadow:
                mode === "dark"
                  ? `0 12px 32px ${shade(t, 0.45)}`
                  : `0 12px 32px ${shade(t, 0.18)}`,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              fontFamily: FF_SANS,
            }}
          >
            <div
              style={{
                padding: "8px 10px",
                borderBottom: `1px solid ${t.borderSoft}`,
                background: t.surfaceAlt,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    color: t.textMuted,
                    fontSize: FS_SM,
                    fontFamily: LABEL_FONT,
                    letterSpacing: labelTracking(0.5),
                    textTransform: LABEL_CASE,
                  }}
                >
                  Columns
                </div>
              </div>
              {(enabled.length > 0 || hidden.length > 0) && (
                <button
                  type="button"
                  onClick={onReset}
                  title="Show the default columns"
                  style={{
                    flexShrink: 0,
                    background: "transparent",
                    border: `1px solid ${t.border}`,
                    borderRadius: R_MD,
                    color: t.textMuted,
                    fontSize: FS_XS,
                    fontFamily: FF_SANS,
                    padding: "3px 8px",
                    cursor: "pointer",
                  }}
                >
                  Reset
                </button>
              )}
            </div>
            <div style={{ overflow: "auto", maxHeight: 420 }}>
              <SectionLabel t={t}>Built-in</SectionLabel>
              {builtIn.map((c) => (
                <PickRow
                  key={c.id}
                  t={t}
                  label={c.header}
                  checked={!hiddenSet.has(c.id)}
                  onToggle={() => onToggleColumn(c.id)}
                />
              ))}
              <SectionLabel t={t}>From labels</SectionLabel>
              {keys.length === 0 ? (
                <div
                  style={{
                    padding: 14,
                    color: t.textDim,
                    fontSize: FS_MD,
                    textAlign: "center",
                  }}
                >
                  No labels on these resources.
                </div>
              ) : (
                keys.map((key) => (
                  <PickRow
                    key={key}
                    t={t}
                    label={labelColumnHeader(key)}
                    sub={key}
                    checked={enabledSet.has(key)}
                    onToggle={() => onToggle(key)}
                  />
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function SectionLabel({ t, children }: { t: Tokens; children: string }) {
  return (
    <div
      style={{
        padding: "8px 10px 4px",
        color: t.textMuted,
        fontSize: FS_XS,
        fontFamily: LABEL_FONT,
        letterSpacing: labelTracking(0.5),
        textTransform: LABEL_CASE,
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      {children}
    </div>
  );
}

// `sub` is the full label key under its short header; built-in rows have none.
function PickRow({
  t,
  label,
  sub,
  checked,
  onToggle,
}: {
  t: Tokens;
  label: string;
  sub?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-label={sub ?? label}
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderBottom: `1px solid ${t.borderSoft}`,
        cursor: "pointer",
      }}
    >
      {/* Checkbox stops click propagation, so a direct hit toggles once;
        clicking the rest of the row toggles via the row handler. */}
      <Checkbox t={t} checked={checked} onChange={onToggle} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span style={{ ...PICK_ELLIPSIS, color: t.text, fontSize: FS_MD, fontWeight: FW_SEMIBOLD }}>
          {label}
        </span>
        {sub && (
          <span style={{ ...PICK_ELLIPSIS, color: t.textDim, fontSize: FS_XS, fontFamily: FF_MONO }}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

const PICK_ELLIPSIS = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;
