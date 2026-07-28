import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Tokens } from "../../theme";
import { FF_MONO, FS_XS } from "../../theme";
import { placeSelectPopover, fixedRectScale } from "../../lib/zoom";
import { containerKindSuffix } from "../../lib/podContainers";
import type { LogContainer } from "../../types";

// Per-container mute control for an aggregated log view.
//
// Below `INLINE_LIMIT` distinct containers the toggles render as a flat chip
// strip — one click, nothing hidden, which is the right shape for the common
// "app + istio-proxy" case. Past that the strip becomes a wall of buttons that
// wraps across the whole header (10 deployments with differing container names
// is easily 30+), so it collapses into a single trigger with a popover.
//
// The popover borrows `Select`'s fixed-position placement helpers rather than
// `position: absolute`, so it can't be clipped by the detail panel's scroll
// container.

/// Distinct containers past which the chip strip collapses into a popover.
/// Six fits one toolbar row at every shipped theme's font scale.
export const INLINE_LIMIT = 6;

const RADIUS = "var(--fs-radius-sm, 4px)";

function muteHint(c: LogContainer, muted: boolean): string {
  const what = `${c.name}${containerKindSuffix(c.kind)}`;
  return muted
    ? `${what} muted — click to include`
    : `Mute ${what} across all pods`;
}

/// One toggle. Muted renders struck-through and hollow; live renders as a
/// filled chip. `kind` rides along as a dim suffix so an operator can tell a
/// terminated init container from a live sidecar without a legend.
function MuteChip({
  t,
  c,
  muted,
  onToggle,
  block,
}: {
  t: Tokens;
  c: LogContainer;
  muted: boolean;
  onToggle: () => void;
  // Popover rows fill the width and left-align; strip chips hug their content.
  block?: boolean;
}) {
  const hint = muteHint(c, muted);
  return (
    <button
      type="button"
      onClick={onToggle}
      title={hint}
      aria-label={hint}
      aria-pressed={!muted}
      style={{
        display: block ? "flex" : "inline-flex",
        alignItems: "center",
        gap: 6,
        width: block ? "100%" : undefined,
        justifyContent: block ? "flex-start" : "center",
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        height: 22,
        padding: "0 8px",
        borderRadius: RADIUS,
        border: block
          ? "1px solid transparent"
          : `1px solid ${muted ? t.borderSoft : t.border}`,
        background: block ? "transparent" : muted ? "transparent" : t.chip,
        color: muted ? t.textMuted : t.textDim,
        textDecoration: muted ? "line-through" : "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span>{c.name}</span>
      {c.kind !== "main" && (
        <span style={{ color: t.textMuted, textDecoration: "none" }}>
          {c.kind}
        </span>
      )}
    </button>
  );
}

export function ContainerMuteMenu({
  t,
  universe,
  excluded,
  onToggle,
}: {
  t: Tokens;
  universe: LogContainer[];
  excluded: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  // A single container is not a choice — nothing to mute against.
  if (universe.length <= 1) return null;
  if (universe.length <= INLINE_LIMIT) {
    return (
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
      >
        <span style={{ fontSize: FS_XS, color: t.textMuted }}>containers:</span>
        {universe.map((c) => (
          <MuteChip
            key={c.name}
            t={t}
            c={c}
            muted={excluded.has(c.name)}
            onToggle={() => onToggle(c.name)}
          />
        ))}
      </div>
    );
  }
  return (
    <MutePopover t={t} universe={universe} excluded={excluded} onToggle={onToggle} />
  );
}

function MutePopover({
  t,
  universe,
  excluded,
  onToggle,
}: {
  t: Tokens;
  universe: LogContainer[];
  excluded: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pop, setPop] = useState({
    x: 0,
    y: 0,
    w: 0,
    maxH: 260,
    flipUp: false,
  });

  const shown = universe.length - excluded.size;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setPop(
      placeSelectPopover(
        el.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        { popoverMinWidth: 220 },
        fixedRectScale(),
      ),
    );
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Same dismissal contract as `Select`: outside mousedown, any ancestor
  // scroll, or a resize. Scrolls *inside* the popover are ignored so a long
  // container list stays open while you scroll it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (popRef.current?.contains(tgt) || triggerRef.current?.contains(tgt))
        return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let the panel's own Esc-to-close fire while a menu is open.
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const allShown = excluded.size === 0;
  const label = allShown
    ? `containers: all ${universe.length}`
    : `containers: ${shown}/${universe.length}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose which containers stream"
        style={{
          fontFamily: FF_MONO,
          fontSize: FS_XS,
          height: 22,
          padding: "0 8px",
          borderRadius: RADIUS,
          border: `1px solid ${allShown ? t.border : t.accent}`,
          background: t.chip,
          color: allShown ? t.textDim : t.text,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
      {open && (
        <div
          ref={popRef}
          role="menu"
          aria-label="Container mute list"
          style={{
            position: "fixed",
            left: pop.x,
            ...(pop.flipUp ? { bottom: pop.y } : { top: pop.y }),
            minWidth: pop.w,
            maxHeight: pop.maxH,
            overflowY: "auto",
            padding: 4,
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: "var(--fs-radius-md, 6px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
            zIndex: 60,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "2px 4px 6px",
              borderBottom: `1px solid ${t.borderSoft}`,
              marginBottom: 4,
            }}
          >
            <BulkBtn
              t={t}
              label="All"
              disabled={excluded.size === 0}
              onClick={() => {
                for (const c of universe)
                  if (excluded.has(c.name)) onToggle(c.name);
              }}
            />
            <BulkBtn
              t={t}
              label="None"
              disabled={excluded.size === universe.length}
              onClick={() => {
                for (const c of universe)
                  if (!excluded.has(c.name)) onToggle(c.name);
              }}
            />
          </div>
          {universe.map((c) => (
            <MuteChip
              key={c.name}
              t={t}
              c={c}
              block
              muted={excluded.has(c.name)}
              onToggle={() => onToggle(c.name)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function BulkBtn({
  t,
  label,
  onClick,
  disabled,
}: {
  t: Tokens;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        height: 20,
        padding: "0 8px",
        borderRadius: RADIUS,
        border: `1px solid ${t.borderSoft}`,
        background: "transparent",
        color: disabled ? t.textMuted : t.textDim,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
