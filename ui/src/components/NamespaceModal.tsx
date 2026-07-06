import { useEffect, useMemo, useRef, useState } from "react";
import { FF_MONO, type ThemeMode, R_LG, R_MD, R_SM, FS_MD, FS_SM, FS_XS } from "../theme";
import { useAppStore, useResolvedTheme } from "../store";
import { Btn, Icons, Kbd, KindIcons } from "./ui";

// Treat anything in the kube-* family plus the dashboard add-ons as "system."
// Surfaced behind the Settings → General → Show system namespaces toggle.
function isSystemNs(name: string): boolean {
  if (name.startsWith("kube-")) return true;
  if (name === "kube-system" || name === "kube-public") return true;
  if (name === "default") return false;
  if (name === "kubernetes-dashboard") return true;
  if (name === "local-path-storage") return true;
  return false;
}

type Props = {
  mode: ThemeMode;
  // Available namespaces in this cluster — loaded from the resource tables.
  namespaces: string[];
  // Pod counts per namespace, optional. Used to give a quick context number.
  counts?: Record<string, number>;
  // Multi-cluster views only: origin chips for namespaces that exist on a
  // subset of the active members (label = compressed cluster name, color =
  // the member's identity accent). Namespaces present everywhere have no
  // entry and render unchanged.
  clusterTags?: Record<string, { label: string; color: string }[]>;
  initial: Set<string>;
  onApply: (next: Set<string>) => void;
  onClose: () => void;
};

// HV2NamespaceModal — plain click single-selects (replaces the selection);
// the checkbox glyph or a ⌘/Ctrl-click adds to a multi-selection. A top "All
// namespaces" pseudo-row clears to the empty set. Empty selection means "all"
// (matches HV2 semantics). Apply is the canonical action (P2); Clear is
// secondary; Esc cancels. Selected-at-open namespaces float to the top.
export function NamespaceModal({
  namespaces,
  counts,
  clusterTags,
  initial,
  onApply,
  onClose,
}: Props) {
  const t = useResolvedTheme().tokens;
  const showSystemNs = useAppStore((s) => s.settings.showSystemNs);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(initial));
  // Snapshot of the committed selection, captured once at open. Drives the
  // "selected float to the top" ordering without reshuffling rows live as the
  // draft changes mid-session (that would make rows jump under the cursor).
  // Refreshes on the next open, so a just-applied selection sorts to the top
  // the next time the modal is shown.
  const [pinned] = useState<Set<string>>(() => new Set(initial));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // System namespaces are hidden by default — the operator opts in via the
  // Settings → General toggle. Anything already pinned in the draft stays
  // visible regardless so the operator doesn't lose a selection silently
  // when they turn the toggle off mid-flow.
  const visible = useMemo(
    () =>
      showSystemNs
        ? namespaces
        : namespaces.filter(
            (n) => !isSystemNs(n) || draft.has(n) || pinned.has(n),
          ),
    [namespaces, showSystemNs, draft, pinned],
  );

  // Namespaces selected at open float to the top; each group stays alpha
  // (`visible` is already sorted upstream). Frozen via `pinned` so the order is
  // stable for the whole session and only refreshes on the next open.
  const ordered = useMemo(() => {
    const sel: string[] = [];
    const rest: string[] = [];
    for (const n of visible) (pinned.has(n) ? sel : rest).push(n);
    return [...sel, ...rest];
  }, [visible, pinned]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? ordered.filter((n) => n.toLowerCase().includes(needle))
      : ordered;
  }, [q, ordered]);

  const allMode = draft.size === 0;
  const apply = () => onApply(new Set(draft));
  const reset = () => setDraft(new Set());
  const selectAll = () => setDraft(new Set());

  // Additive toggle — the multi-select path. Reached via the checkbox glyph or
  // a ⌘/Ctrl-click on the row.
  const toggleNs = (ns: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  };

  // Single-select — a plain click on the row body replaces the whole selection
  // with just this namespace. "All namespaces" (the empty set) is reached via
  // the pseudo-row above, not by toggling the last one off.
  const selectOnly = (ns: string) => setDraft(new Set([ns]));

  const onRowClick = (ns: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) toggleNs(ns);
    else selectOnly(ns);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          zIndex: 40,
          animation: "fs-fade-in .15s ease",
        }}
      />
      <div
        onKeyDown={onKey}
        style={{
          position: "fixed",
          top: "calc(15% + var(--fs-titlebar-h, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          width: 460,
          maxWidth: "90vw",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: R_LG,
          boxShadow: "0 24px 56px rgba(0,0,0,0.28)",
          zIndex: 41,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 18px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: FS_MD,
                  fontWeight: 600,
                  letterSpacing: -0.2,
                  color: t.text,
                }}
              >
                Filter by namespace
              </div>
              <div
                style={{
                  fontSize: FS_SM,
                  color: t.textMuted,
                  marginTop: 2,
                  fontFamily: FF_MONO,
                }}
              >
                {visible.length} available
                {!showSystemNs && visible.length < namespaces.length
                  ? ` · ${namespaces.length - visible.length} system hidden`
                  : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: t.textMuted,
                padding: 4,
                borderRadius: R_MD,
                display: "flex",
              }}
            >
              {Icons.close}
            </button>
          </div>
          <div style={{ position: "relative" }}>
            <span
              style={{
                position: "absolute",
                left: 9,
                top: "50%",
                transform: "translateY(-50%)",
                color: t.textMuted,
                display: "inline-flex",
                pointerEvents: "none",
              }}
            >
              {Icons.search}
            </span>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search namespaces…"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "7px 10px 7px 30px",
                background: t.surfaceAlt,
                border: `1px solid ${t.borderSoft}`,
                borderRadius: R_MD,
                color: t.text,
                fontFamily: "inherit",
                fontSize: FS_MD,
                outline: "none",
              }}
            />
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: FS_XS,
              color: t.textDim,
              fontFamily: FF_MONO,
            }}
          >
            Click selects one · ⌘/Ctrl-click or the box for multiple
          </div>
        </div>

        <button
          type="button"
          onClick={selectAll}
          aria-pressed={allMode}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 18px",
            border: "none",
            background: allMode ? t.accentSoft : "transparent",
            cursor: "pointer",
            textAlign: "left",
            borderBottom: `1px solid ${t.borderSoft}`,
            fontFamily: "inherit",
            color: allMode ? t.accent : t.text,
          }}
          onMouseEnter={(e) => {
            if (!allMode) e.currentTarget.style.background = t.hover;
          }}
          onMouseLeave={(e) => {
            if (!allMode) e.currentTarget.style.background = "transparent";
          }}
        >
          {/* Namespace kind glyph — "all namespaces" reads thematically; the
              accent colour + accentSoft row background carry the active state,
              so no radio ring is needed. */}
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              width: 16,
              height: 16,
              color: allMode ? t.accent : t.textMuted,
            }}
          >
            {KindIcons.Namespace}
          </span>
          <span style={{ fontSize: FS_MD, fontWeight: 600, flex: 1 }}>
            All namespaces
          </span>
          <span
            style={{
              fontSize: FS_SM,
              color: t.textMuted,
              fontFamily: FF_MONO,
            }}
          >
            {visible.length}
          </span>
        </button>

        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "24px 18px",
                textAlign: "center",
                color: t.textMuted,
                fontSize: FS_MD,
              }}
            >
              No namespaces match "{q}"
            </div>
          ) : (
            filtered.map((ns) => {
              const checked = draft.has(ns);
              return (
                <button
                  key={ns}
                  type="button"
                  onClick={(e) => onRowClick(ns, e)}
                  title="Click to select only this · ⌘/Ctrl-click for multiple"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "8px 18px",
                    border: "none",
                    background: checked ? t.accentSoft : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    color: t.text,
                  }}
                  onMouseEnter={(e) => {
                    if (!checked) e.currentTarget.style.background = t.hover;
                  }}
                  onMouseLeave={(e) => {
                    if (!checked)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  {/* Enlarged left hit-zone: a near-miss around the box still
                      toggles (multi) instead of single-selecting the row. Eats
                      the row's left padding and stretches full height so the
                      whole left column is the checkbox target. */}
                  <span
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`Toggle ${ns}`}
                    onClick={(e) => {
                      // The box is the additive path — never collapse to a
                      // single selection. Stop the row's single-select click.
                      e.stopPropagation();
                      toggleNs(ns);
                    }}
                    style={{
                      alignSelf: "stretch",
                      marginTop: -8,
                      marginBottom: -8,
                      marginLeft: -18,
                      paddingLeft: 18,
                      paddingRight: 4,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      cursor: "pointer",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: R_SM,
                        border: `1.5px solid ${checked ? t.accent : t.border}`,
                        background: checked ? t.accent : "transparent",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {checked && (
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="white"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2 5l2 2 4-4" />
                        </svg>
                      )}
                    </span>
                  </span>
                  <span
                    style={{
                      fontSize: FS_MD,
                      fontFamily: FF_MONO,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ns}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      overflow: "hidden",
                    }}
                  >
                    {clusterTags?.[ns]?.map((tag) => (
                      <span
                        key={tag.label}
                        title={`Only in ${tag.label}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "1px 6px",
                          borderRadius: R_MD,
                          border: `1px solid ${t.borderSoft}`,
                          background: t.chip,
                          color: t.textDim,
                          fontSize: FS_XS,
                          fontFamily: FF_MONO,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 110,
                          flexShrink: 0,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: tag.color,
                            flexShrink: 0,
                          }}
                        />
                        {tag.label}
                      </span>
                    ))}
                  </span>
                  <span
                    style={{
                      fontSize: FS_XS,
                      color: t.textMuted,
                      fontFamily: FF_MONO,
                    }}
                  >
                    {counts && counts[ns] != null ? `${counts[ns]} pods` : "—"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div
          style={{
            padding: "10px 14px",
            borderTop: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: t.surfaceAlt,
          }}
        >
          <span style={{ fontSize: FS_SM, color: t.textMuted, flex: 1 }}>
            {draft.size === 0
              ? "Showing all namespaces"
              : `${draft.size} selected`}
          </span>
          {draft.size > 0 && (
            <Btn t={t} variant="secondary" size="sm" onClick={reset}>
              Clear
            </Btn>
          )}
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={apply}
            iconRight={<Kbd t={t}>↵</Kbd>}
          >
            Apply
          </Btn>
        </div>
      </div>
    </>
  );
}
