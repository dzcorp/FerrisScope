import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useResolvedTheme } from "../store";
import { FF_MONO, FONT_SANS, FS_MD, FS_SM, FS_XS, R_LG, R_MD } from "../theme";
import { Checkbox, Icons } from "./ui";
import { labelColumnHeader } from "../lib/labelColumns";
import { useEscLayer } from "../lib/escStack";

type Props = {
  /// Distinct label keys present on the current rows (the universe to pick
  /// from), sorted.
  available: string[];
  /// Label keys currently promoted to columns.
  enabled: string[];
  /// Toggle one key on/off. The parent owns the persisted list.
  onToggle: (key: string) => void;
  /// Clear all custom columns back to none.
  onReset: () => void;
};

// ColumnPicker — the table header's right-edge "⋯" control. Opens a dropdown
// listing every label key found on the current rows; checking one adds a
// custom column reading that label, unchecking removes it. The chosen set is
// owned + persisted per (scope, kind) by the parent ResourceTable.
export function ColumnPicker({ available, enabled, onToggle, onReset }: Props) {
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
                  ? "0 12px 32px rgba(0,0,0,0.45)"
                  : "0 12px 32px rgba(15,20,30,0.18)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              fontFamily: FONT_SANS,
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
                    fontFamily: FF_MONO,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  Custom columns
                </div>
                <div
                  style={{ color: t.textDim, fontSize: FS_XS, marginTop: 2 }}
                >
                  From resource labels
                </div>
              </div>
              {enabled.length > 0 && (
                <button
                  type="button"
                  onClick={onReset}
                  title="Remove all custom columns"
                  style={{
                    flexShrink: 0,
                    background: "transparent",
                    border: `1px solid ${t.border}`,
                    borderRadius: R_MD,
                    color: t.textMuted,
                    fontSize: FS_XS,
                    fontFamily: FONT_SANS,
                    padding: "3px 8px",
                    cursor: "pointer",
                  }}
                >
                  Reset
                </button>
              )}
            </div>
            <div style={{ overflow: "auto", maxHeight: 320 }}>
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
                keys.map((key) => {
                  const checked = enabledSet.has(key);
                  return (
                    <div
                      key={key}
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      aria-label={key}
                      onClick={() => onToggle(key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 10px",
                        borderBottom: `1px solid ${t.borderSoft}`,
                        cursor: "pointer",
                      }}
                    >
                      {/* Checkbox stops click propagation, so a direct hit
                        toggles once; clicking the rest of the row toggles via
                        the row handler. */}
                      <Checkbox
                        t={t}
                        checked={checked}
                        onChange={() => onToggle(key)}
                      />
                      <div
                        style={{
                          minWidth: 0,
                          display: "flex",
                          flexDirection: "column",
                        }}
                      >
                        <span
                          style={{
                            color: t.text,
                            fontSize: FS_MD,
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {labelColumnHeader(key)}
                        </span>
                        <span
                          style={{
                            color: t.textDim,
                            fontSize: FS_XS,
                            fontFamily: FF_MONO,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {key}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
