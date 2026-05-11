import { useEffect, useMemo, useRef } from "react";
import type { ContextInfo } from "../types";
import { FF_MONO, type ThemeMode, R_MD, R_SM, FS_LG, FS_MD, FS_SM, FS_XS } from "../theme";
import { BrandMark, IconBtn, Icons, Kbd } from "./ui";
import { MOD_KEY } from "../lib/keyboard";
import { HeaderToast } from "./HeaderToast";
import { parseTableFilter } from "../lib/tableFilter";
import { useAppStore, useResolvedTheme } from "../store";

type Props = {
  mode: ThemeMode;
  context: ContextInfo | null;
  selectedKindLabel: string | null;
  unreadNotifications: number;
  activeForwards: number;
  onHome: () => void;
  onPalette: () => void;
  onToggleTheme: () => void;
  onOpenNotifications: () => void;
  onOpenSettings: () => void;
  onOpenForwards: () => void;
};

// Top bar — brand, breadcrumb, command-palette stub, theme toggle. Per P6 the
// cluster name is always visible while a context is selected; `Esc` is wired
// at the App level (R-13).
export function AppHeader({
  mode,
  context,
  selectedKindLabel,
  unreadNotifications,
  activeForwards,
  onHome,
  onPalette,
  onToggleTheme,
  onOpenNotifications,
  onOpenSettings,
  onOpenForwards,
}: Props) {
  const t = useResolvedTheme().tokens;
  // Visible-row count + active filter for the breadcrumb. Both pushed by
  // ResourceTable; both null when no kind table is mounted.
  const tableCount = useAppStore((s) => s.tableCount);
  const tableFilter = useAppStore((s) => s.tableFilter);
  const setTableFilter = useAppStore((s) => s.setTableFilter);
  const clearTableFilter = useAppStore((s) => s.clearTableFilter);
  const filterEditing = useAppStore((s) => s.filterEditing);
  const openFilterEditor = useAppStore((s) => s.openFilterEditor);
  const closeFilterEditor = useAppStore((s) => s.closeFilterEditor);

  // Auto-focus the inline filter input when it opens (Cmd+F / `/` /
  // chip click). Selecting all text on focus lets the operator overwrite
  // an existing filter without manually clearing.
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (filterEditing) {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    }
  }, [filterEditing]);

  // Parse the filter once for the chip's visual state. `invalid` flips
  // the border red so an unparseable regex doesn't look like "no
  // matches" — the operator can see the pattern itself is broken.
  const parsedFilter = useMemo(() => parseTableFilter(tableFilter), [
    tableFilter,
  ]);
  const filterInvalid = parsedFilter.invalid === true;
  const filterAccent = filterInvalid ? t.bad : t.accent;

  return (
    <div
      style={{
        background: t.header,
        borderBottom: `1px solid ${t.border}`,
        flexShrink: 0,
        zIndex: 5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "12px 22px",
        }}
      >
        <button
          type="button"
          onClick={onHome}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: t.text,
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          <div
            style={{
              width: 26,
              height: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: t.accent,
            }}
          >
            <BrandMark size={26} />
          </div>
          <div style={{ fontSize: FS_LG, fontWeight: 700, letterSpacing: -0.3 }}>
            FerrisScope
          </div>
        </button>

        <div style={{ height: 18, width: 1, background: t.border }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: FS_MD,
            fontWeight: 500,
            minWidth: 0,
          }}
        >
          <button
            type="button"
            onClick={onHome}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: context ? t.textDim : t.text,
              padding: "3px 6px",
              borderRadius: R_MD,
              fontFamily: "inherit",
              fontSize: FS_MD,
              fontWeight: 500,
            }}
          >
            Clusters
          </button>
          {context && (
            <>
              <span style={{ color: t.textMuted, display: "inline-flex" }}>
                {Icons.chevR}
              </span>
              <span
                style={{
                  padding: "3px 6px",
                  fontWeight: 600,
                  letterSpacing: -0.2,
                }}
              >
                {context.name}
              </span>
              {context.namespace && (
                <span
                  style={{
                    fontSize: FS_SM,
                    padding: "1px 6px",
                    borderRadius: R_SM,
                    background: t.chip,
                    color: t.textDim,
                    fontWeight: 500,
                    marginLeft: 2,
                    fontFamily: FF_MONO,
                  }}
                >
                  ns:{context.namespace}
                </span>
              )}
              {selectedKindLabel && (
                <>
                  <span style={{ color: t.textMuted, display: "inline-flex" }}>
                    {Icons.chevR}
                  </span>
                  <span style={{ padding: "3px 6px", color: t.textDim }}>
                    {selectedKindLabel}
                  </span>
                  {tableCount && (
                    <span
                      style={{
                        fontSize: FS_SM,
                        color: t.textMuted,
                        fontFamily: FF_MONO,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      ·{" "}
                      {tableCount.filtered === tableCount.total
                        ? tableCount.total
                        : `${tableCount.filtered}/${tableCount.total}`}
                    </span>
                  )}
                  {/* Filter chip / inline input — same anchor point, two
                      states. When `filterEditing` is true: a small input
                      lives here, two-way-bound to `tableFilter` so typing
                      live-narrows the table behind. Esc / Enter / blur
                      collapses back to the chip; the filter persists.
                      When idle: a funnel chip showing the active filter
                      (or just the icon if no filter), clickable to
                      re-open the input. */}
                  {filterEditing ? (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 6px",
                        border: `1px solid ${filterAccent}`,
                        borderRadius: R_MD,
                        background: t.surface,
                        height: 24,
                      }}
                    >
                      <span
                        style={{
                          color: filterAccent,
                          display: "inline-flex",
                        }}
                      >
                        {Icons.filter}
                      </span>
                      <input
                        ref={filterInputRef}
                        value={tableFilter}
                        onChange={(e) => setTableFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape" || e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            closeFilterEditor();
                          }
                        }}
                        // Defer-close on blur so a click on the inline ×
                        // (which momentarily steals focus) doesn't race the
                        // state update and re-open the editor.
                        onBlur={() => {
                          window.setTimeout(closeFilterEditor, 0);
                        }}
                        placeholder="Filter rows…"
                        title={
                          filterInvalid
                            ? "Invalid regex pattern"
                            : "Plain text = substring · use | * + ? ( ) ^ $ to switch to regex"
                        }
                        style={{
                          width: 220,
                          border: "none",
                          outline: "none",
                          background: "transparent",
                          color: filterInvalid ? t.bad : t.text,
                          fontSize: FS_MD,
                          fontFamily: FF_MONO,
                          padding: 0,
                        }}
                      />
                      {tableFilter && (
                        <button
                          type="button"
                          // mousedown so this fires before the input's blur,
                          // giving us the chance to clear before the editor
                          // collapses (cleaner UX than blur → click-to-clear).
                          onMouseDown={(e) => {
                            e.preventDefault();
                            clearTableFilter();
                            filterInputRef.current?.focus();
                          }}
                          title="Clear filter"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: 2,
                            border: "none",
                            borderRadius: R_SM,
                            background: "transparent",
                            color: t.textMuted,
                            cursor: "pointer",
                          }}
                        >
                          {Icons.close}
                        </button>
                      )}
                    </div>
                  ) : (
                    // Wrapper, not a button — the chip splits into two click
                    // targets: the funnel/text part opens the editor (so the
                    // operator can replace the term with a new one) and the
                    // × clears the active filter without opening the editor
                    // first. Both are nested buttons; the wrapper itself is
                    // visual only.
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        border: `1px solid ${tableFilter ? filterAccent : t.borderSoft}`,
                        borderRadius: R_MD,
                        background: tableFilter
                          ? filterInvalid
                            ? t.surface
                            : t.accentSoft
                          : "transparent",
                        color: tableFilter ? filterAccent : t.textMuted,
                        height: 22,
                      }}
                    >
                      <button
                        type="button"
                        onClick={openFilterEditor}
                        title={
                          filterInvalid
                            ? `Invalid regex: ${tableFilter}`
                            : tableFilter
                              ? `Filter: "${tableFilter}" — edit (${MOD_KEY}F or /)`
                              : `Filter visible rows (${MOD_KEY}F or /). Plain text matches substring; metachars switch to regex.`
                        }
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: tableFilter ? "0 4px 0 6px" : "0 6px",
                          border: "none",
                          background: "transparent",
                          color: "inherit",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          fontSize: FS_SM,
                          lineHeight: 1,
                          height: "100%",
                        }}
                      >
                        <span style={{ display: "inline-flex" }}>
                          {Icons.filter}
                        </span>
                        {tableFilter && (
                          <span
                            style={{
                              fontFamily: FF_MONO,
                              maxWidth: 140,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {tableFilter}
                          </span>
                        )}
                      </button>
                      {tableFilter && (
                        <button
                          type="button"
                          onClick={clearTableFilter}
                          title="Clear filter"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "0 5px",
                            border: "none",
                            borderLeft: `1px solid ${filterAccent}`,
                            background: "transparent",
                            color: "inherit",
                            cursor: "pointer",
                            height: "100%",
                          }}
                        >
                          {Icons.close}
                        </button>
                      )}
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div style={{ flex: 1 }} />

        <HeaderToast mode={mode} />

        <button
          type="button"
          onClick={onPalette}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: `1px solid ${t.border}`,
            background: t.surface,
            borderRadius: R_MD,
            padding: "6px 12px",
            width: 280,
            cursor: "pointer",
            fontFamily: "inherit",
            color: "inherit",
            // `minHeight` instead of fixed `height` so the row stays
            // single-line and centered at any theme's base font size.
            minHeight: 32,
            // Hide vertical overflow that 14-px-base themes would otherwise
            // push past the row.
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{ color: t.textMuted, display: "inline-flex", flexShrink: 0 }}
          >
            {Icons.search}
          </span>
          <span
            style={{
              // `flex + minWidth: 0` lets the placeholder ellipsis-truncate
              // instead of wrapping to a second line at larger base fonts.
              flex: 1,
              minWidth: 0,
              color: t.textMuted,
              fontSize: FS_MD,
              textAlign: "left",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Search clusters, pods, nodes…
          </span>
          <span style={{ flexShrink: 0 }}>
            <Kbd t={t}>{MOD_KEY}K</Kbd>
          </span>
        </button>

        <div style={{ position: "relative", display: "inline-flex" }}>
          <IconBtn
            t={t}
            title={
              activeForwards > 0
                ? `${activeForwards} active port-forward${activeForwards === 1 ? "" : "s"}`
                : "Port forwards"
            }
            onClick={onOpenForwards}
          >
            {Icons.forward}
          </IconBtn>
          {activeForwards > 0 && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                minWidth: 14,
                height: 14,
                padding: "0 3px",
                borderRadius: R_MD,
                background: t.accent,
                color: "#fff",
                fontSize: FS_XS,
                fontWeight: 700,
                fontFamily: FF_MONO,
                fontVariantNumeric: "tabular-nums",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                pointerEvents: "none",
              }}
            >
              {activeForwards > 99 ? "99+" : activeForwards}
            </span>
          )}
        </div>

        <div style={{ position: "relative", display: "inline-flex" }}>
          <IconBtn
            t={t}
            title={
              unreadNotifications > 0
                ? `${unreadNotifications} new notification${unreadNotifications === 1 ? "" : "s"}`
                : "Notifications"
            }
            onClick={onOpenNotifications}
          >
            {Icons.bell}
          </IconBtn>
          {unreadNotifications > 0 && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                minWidth: 14,
                height: 14,
                padding: "0 3px",
                borderRadius: R_MD,
                background: t.bad,
                color: "#fff",
                fontSize: FS_XS,
                fontWeight: 700,
                fontFamily: FF_MONO,
                fontVariantNumeric: "tabular-nums",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                pointerEvents: "none",
              }}
            >
              {unreadNotifications > 99 ? "99+" : unreadNotifications}
            </span>
          )}
        </div>

        <IconBtn
          t={t}
          title={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
        >
          {mode === "dark" ? Icons.sun : Icons.moon}
        </IconBtn>

        <IconBtn t={t} title="Settings" onClick={onOpenSettings}>
          {Icons.settings}
        </IconBtn>
      </div>
    </div>
  );
}
