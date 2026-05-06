import { useEffect, useMemo, useRef, useState } from "react";
import { tokens, FONT_MONO, type ThemeMode } from "../theme";
import { useAppStore } from "../store";
import { Btn, Icons, Kbd } from "./ui";

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
  initial: Set<string>;
  onApply: (next: Set<string>) => void;
  onClose: () => void;
};

// HV2NamespaceModal — multi-select with a top "All namespaces" pseudo-row.
// Empty selection means "all" (matches HV2 semantics). Apply is the canonical
// action (P2); Clear is secondary; Esc cancels.
export function NamespaceModal({
  mode,
  namespaces,
  counts,
  initial,
  onApply,
  onClose,
}: Props) {
  const t = tokens(mode);
  const showSystemNs = useAppStore((s) => s.settings.showSystemNs);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(initial));
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
        : namespaces.filter((n) => !isSystemNs(n) || draft.has(n)),
    [namespaces, showSystemNs, draft],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? visible.filter((n) => n.toLowerCase().includes(needle))
      : visible;
  }, [q, visible]);

  const allMode = draft.size === 0;
  const apply = () => onApply(new Set(draft));
  const reset = () => setDraft(new Set());
  const selectAll = () => setDraft(new Set());

  const toggleNs = (ns: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
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
          borderRadius: 12,
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
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: -0.2,
                  color: t.text,
                }}
              >
                Filter by namespace
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: t.textMuted,
                  marginTop: 2,
                  fontFamily: FONT_MONO,
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
                borderRadius: 4,
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
                borderRadius: 6,
                color: t.text,
                fontFamily: "inherit",
                fontSize: 12.5,
                outline: "none",
              }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={selectAll}
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
            color: t.text,
          }}
          onMouseEnter={(e) => {
            if (!allMode) e.currentTarget.style.background = t.hover;
          }}
          onMouseLeave={(e) => {
            if (!allMode) e.currentTarget.style.background = "transparent";
          }}
        >
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: `1.5px solid ${allMode ? t.accent : t.border}`,
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {allMode && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: t.accent,
                }}
              />
            )}
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>
            All namespaces
          </span>
          <span
            style={{
              fontSize: 11,
              color: t.textMuted,
              fontFamily: FONT_MONO,
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
                fontSize: 12,
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
                  onClick={() => toggleNs(ns)}
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
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
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
                  <span
                    style={{
                      fontSize: 12.5,
                      fontFamily: FONT_MONO,
                      flex: 1,
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
                      fontSize: 10.5,
                      color: t.textMuted,
                      fontFamily: FONT_MONO,
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
          <span style={{ fontSize: 11.5, color: t.textMuted, flex: 1 }}>
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
