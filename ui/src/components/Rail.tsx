import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAppStore } from "../store";
import type { Category, PrefsRailMode, ResourceKind } from "../types";
import { tokens, FONT_MONO, type ThemeMode, type Tokens } from "../theme";
import { Icons, KindIcons, Tooltip, type IconKey } from "./ui";

const CATEGORY_ORDER: Category[] = [
  "Workloads",
  "Cluster",
  "Network",
  "Config",
  "Storage",
  "Access",
  "Apps",
  "CustomResources",
];

const CATEGORY_ICON: Record<Category, IconKey> = {
  Workloads: "pod",
  Cluster: "cluster",
  Network: "network",
  Config: "cm",
  Storage: "storage",
  Access: "access",
  Apps: "apps",
  // No bespoke icon yet — reuse the cluster glyph; the kind icon (the CRD
  // glyph itself) is what the operator actually clicks on.
  CustomResources: "cluster",
};

const W_COLLAPSED = 56;
const W_OPEN = 220;

type Props = {
  mode: ThemeMode;
};

// Auto-hide grouped left rail (R-09: prefer rail/dock over modals).
// Mode-aware: `auto` collapses on mouse-leave and expands on hover; `pinned`
// stays open; `collapsed` stays closed even on hover — except when the
// operator hovers the CustomResources group, which always force-expands the
// rail (every CRD falls back to the same icon, so the collapsed list would
// be a stack of indistinguishable glyphs).
export function Rail({ mode }: Props) {
  const t = tokens(mode);
  const {
    kinds,
    kindsStatus,
    kindsError,
    selectedKindId,
    selectedContext,
    setKinds,
    setKindsLoading,
    setKindsError,
    selectKind,
    railMode,
    setRailMode,
    cycleRailMode,
  } = useAppStore();
  // Track the static-kind count so we can splice dynamic kinds onto the
  // tail of `kinds` and `setKinds` again — keeps `s.kinds.find(...)`
  // working in ClusterPanel (which is what discovers the table to render).
  const staticKindsCount = useRef(0);

  const [hover, setHover] = useState(false);
  const [crHover, setCrHover] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const open =
    railMode === "pinned" ||
    (railMode === "auto" && hover) ||
    (railMode === "collapsed" && crHover);

  useEffect(() => {
    setKindsLoading();
    api
      .listResourceKinds()
      .then((ks) => {
        staticKindsCount.current = ks.length;
        setKinds(ks);
      })
      .catch((e: unknown) => setKindsError(String(e)));
  }, [setKinds, setKindsError, setKindsLoading]);

  // Discover CRDs every time a cluster is selected. CRDs are cluster-local
  // so the dynamic kinds reset on context switch — we don't keep a stale
  // list visible. Failures are silent: the operator still has the well-
  // known kinds and the standalone CustomResourceDefinition entry.
  useEffect(() => {
    if (!selectedContext) {
      setCustomError(null);
      // Drop any dynamic kinds back to the static tail when no cluster is
      // selected — switching back to fleet view should clear the rail.
      const current = useAppStore.getState().kinds;
      if (current.length > staticKindsCount.current) {
        setKinds(current.slice(0, staticKindsCount.current));
      }
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 8;
    setCustomError(null);

    const tryOnce = () => {
      attempts += 1;
      api
        .listCustomResourceKinds(selectedContext)
        .then((list) => {
          if (cancelled) return;
          setCustomError(null);
          // Splice into the global kinds store so that ClusterPanel's
          // `s.kinds.find(id => ...)` resolves dynamic ids to a real
          // ResourceKind (and thus actually renders the table). Without
          // this the rail shows the entry but clicking it produces an
          // empty pane because the kind never reaches the renderer.
          const current = useAppStore.getState().kinds;
          const head = current.slice(0, staticKindsCount.current);
          setKinds([...head, ...list]);
          // eslint-disable-next-line no-console
          console.info(
            `[FerrisScope] discovered ${list.length} CRD-derived kinds for ${selectedContext}`,
          );
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = String(e);
          // The cluster may not be connected yet — ClusterPanel kicks off
          // its connect in parallel and discovery races it. Back off and
          // retry a handful of times before giving up.
          if (attempts < maxAttempts) {
            const delay = Math.min(500 * 2 ** (attempts - 1), 4000);
            setTimeout(() => {
              if (!cancelled) tryOnce();
            }, delay);
            return;
          }
          // Drop any previously spliced dynamic kinds back to the static
          // tail so a stale list doesn't linger after discovery failures.
          const current = useAppStore.getState().kinds;
          if (current.length > staticKindsCount.current) {
            setKinds(current.slice(0, staticKindsCount.current));
          }
          setCustomError(msg);
          // eslint-disable-next-line no-console
          console.warn(
            `[FerrisScope] CRD discovery failed after ${attempts} attempts:`,
            msg,
          );
        });
    };
    tryOnce();
    return () => {
      cancelled = true;
    };
  }, [selectedContext]);

  const grouped = useMemo(() => {
    const map = new Map<Category, ResourceKind[]>();
    for (const k of kinds) {
      const arr = map.get(k.category) ?? [];
      arr.push(k);
      map.set(k.category, arr);
    }
    // Dynamic CRD-derived kinds are already merged into `kinds` (spliced
    // by the discovery effect below) — don't re-append them here. Just
    // sort the CustomResources bucket so the dynamic entries appear in
    // alphabetical order under the built-in CustomResourceDefinition row.
    const cr = map.get("CustomResources");
    if (cr && cr.length > 1) {
      const builtin = cr.filter((k) => !k.id.startsWith("crd:"));
      const dynamic = cr
        .filter((k) => k.id.startsWith("crd:"))
        .sort((a, b) => a.kind.localeCompare(b.kind));
      map.set("CustomResources", [...builtin, ...dynamic]);
    }
    return map;
  }, [kinds]);

  // When pinned, the rail reserves the full open width so main content stops
  // beside it instead of underneath. Auto-hide and collapsed both keep the
  // wrapper at the collapsed width and let the open panel float on top of
  // content — collapsed only opens for the CR exception, which is transient.
  const reservedWidth = railMode === "pinned" ? W_OPEN : W_COLLAPSED;
  const isPinned = railMode === "pinned";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        flexShrink: 0,
        width: reservedWidth,
        transition: "width .18s cubic-bezier(.2,.7,.2,1)",
        zIndex: 4,
      }}
    >
      <div style={{ width: reservedWidth, height: "100%" }} />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: open ? W_OPEN : W_COLLAPSED,
          background: t.rail,
          borderRight: `1px solid ${t.border}`,
          boxShadow:
            open && !isPinned ? "4px 0 16px rgba(15,20,30,0.08)" : "none",
          display: "flex",
          flexDirection: "column",
          transition: "width .18s cubic-bezier(.2,.7,.2,1), box-shadow .18s",
          overflow: "hidden",
        }}
      >
        <div
          className="fs-rail-scroll"
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "10px 0 8px",
          }}
        >
          {kindsStatus !== "ready" ? (
            <div
              style={{
                padding: "10px 16px",
                fontSize: 11,
                color: kindsStatus === "error" ? t.bad : t.textMuted,
                fontFamily: FONT_MONO,
                opacity: open ? 1 : 0,
                transition: "opacity .15s",
              }}
            >
              {kindsStatus === "error" ? `error: ${kindsError}` : "loading…"}
            </div>
          ) : (
            <>
              {CATEGORY_ORDER.filter((c) => grouped.has(c)).map((cat, gi) => (
                <RailGroup
                  key={cat}
                  t={t}
                  open={open}
                  gi={gi}
                  category={cat}
                  items={grouped.get(cat) ?? []}
                  selectedId={selectedKindId}
                  onSelect={selectKind}
                  onCrHoverChange={
                    cat === "CustomResources" ? setCrHover : undefined
                  }
                />
              ))}
              {customError && open && (
                <Tooltip label={customError}>
                  <div
                    style={{
                      padding: "8px 16px",
                      fontSize: 10.5,
                      color: t.bad,
                      fontFamily: FONT_MONO,
                      wordBreak: "break-word",
                    }}
                  >
                    CRD discovery: {customError}
                  </div>
                </Tooltip>
              )}
            </>
          )}
        </div>

        <RailFooter
          t={t}
          open={open}
          railMode={railMode}
          onCycle={cycleRailMode}
          onSetMode={setRailMode}
        />
      </div>
    </div>
  );
}

const MODE_LABEL: Record<PrefsRailMode, string> = {
  auto: "Auto-hide",
  pinned: "Pinned",
  collapsed: "Collapsed",
};

const MODE_NEXT_LABEL: Record<PrefsRailMode, string> = {
  auto: "auto-hide → pinned",
  pinned: "pinned → collapsed",
  collapsed: "collapsed → auto-hide",
};

function RailFooter({
  t,
  open,
  railMode,
  onCycle,
  onSetMode,
}: {
  t: Tokens;
  open: boolean;
  railMode: PrefsRailMode;
  onCycle: () => void;
  onSetMode: (mode: PrefsRailMode) => void;
}) {
  const modeIcon =
    railMode === "pinned"
      ? Icons.pin
      : railMode === "collapsed"
        ? Icons.chevR
        : Icons.chevL;
  // Collapsed footer cycles through modes via a single icon; expanded
  // footer shows a 3-segment picker so the operator can jump straight to
  // the mode they want.
  return (
    <div
      style={{
        padding: 8,
        borderTop: `1px solid ${t.borderSoft}`,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {open ? (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            border: `1px solid ${t.border}`,
            borderRadius: 5,
            overflow: "hidden",
            height: 20,
          }}
        >
          {(["auto", "pinned", "collapsed"] as const).map((m, i) => {
            const active = railMode === m;
            return (
              <Tooltip key={m} label={MODE_LABEL[m]}>
                <button
                  type="button"
                  onClick={() => onSetMode(m)}
                  style={{
                    flex: 1,
                    padding: 0,
                    border: "none",
                    borderLeft:
                      i === 0 ? "none" : `1px solid ${t.border}`,
                    background: active ? t.accentSoft : "transparent",
                    color: active ? t.accent : t.textMuted,
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {m === "auto" ? "Auto" : m === "pinned" ? "Pin" : "Lock"}
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : (
        <FooterRowButton
          t={t}
          open={open}
          icon={modeIcon}
          label={MODE_LABEL[railMode]}
          title={`Sidebar: ${MODE_LABEL[railMode]} (click for ${MODE_NEXT_LABEL[railMode]})`}
          onClick={onCycle}
          accent={railMode === "pinned"}
        />
      )}
    </div>
  );
}

function FooterRowButton({
  t,
  open,
  icon,
  label,
  title,
  onClick,
  accent,
}: {
  t: Tokens;
  open: boolean;
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  accent?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const btn = (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: open ? "flex-start" : "center",
        gap: open ? 11 : 0,
        padding: open ? "7px 10px" : "7px 0",
        borderRadius: 7,
        border: "none",
        background: hover ? t.railHover : "transparent",
        cursor: "pointer",
        fontFamily: "inherit",
        color: accent ? t.accent : t.textDim,
        minHeight: 32,
        textAlign: "left",
        transition: "background .12s",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: accent ? t.accent : t.textDim,
        }}
      >
        {icon}
      </div>
      {open && (
        <span
          style={{
            flex: 1,
            fontSize: 12.5,
            fontWeight: 500,
            whiteSpace: "nowrap",
            color: accent ? t.accent : t.text,
          }}
        >
          {label}
        </span>
      )}
    </button>
  );
  return open ? btn : <Tooltip label={title} side="right">{btn}</Tooltip>;
}

function RailGroup({
  t,
  open,
  gi,
  category,
  items,
  selectedId,
  onSelect,
  onCrHoverChange,
}: {
  t: ReturnType<typeof tokens>;
  open: boolean;
  gi: number;
  category: Category;
  items: ResourceKind[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  // Only set for the CustomResources group — fires when the operator
  // enters/leaves the group's bounding box. Drives the
  // collapsed-mode-but-still-expand exception in the parent Rail.
  onCrHoverChange?: (hovering: boolean) => void;
}) {
  return (
    <div
      style={{ marginBottom: 8 }}
      onMouseEnter={onCrHoverChange ? () => onCrHoverChange(true) : undefined}
      onMouseLeave={onCrHoverChange ? () => onCrHoverChange(false) : undefined}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: t.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          fontFamily: FONT_MONO,
          padding: "6px 16px 4px",
          opacity: open ? 1 : 0,
          transition: "opacity .15s",
          whiteSpace: "nowrap",
          height: open ? "auto" : gi === 0 ? 0 : 8,
        }}
      >
        {category === "CustomResources" ? "Custom Resources" : category}
      </div>
      <div
        style={{
          padding: "0 8px",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {category === "CustomResources" ? (
          <CustomResourcesBody
            t={t}
            open={open}
            items={items}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          items.map((k) => (
            <RailItem
              key={k.id}
              t={t}
              open={open}
              kind={k}
              category={category}
              active={selectedId === k.id}
              onClick={() => onSelect(k.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// CRDs from a busy cluster (cert-manager + argo + traefik + prometheus
// operator etc.) flatten into a 30-item wall in the rail. Bucket the
// dynamic entries by API group so the operator can scan by vendor —
// "cert-manager.io" / "argoproj.io" / "monitoring.coreos.com". Each
// group is collapsible; the built-in CustomResourceDefinition row
// stays at the top with no subgroup chrome.
function CustomResourcesBody({
  t,
  open,
  items,
  selectedId,
  onSelect,
}: {
  t: ReturnType<typeof tokens>;
  open: boolean;
  items: ResourceKind[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const builtin = items.filter((k) => !k.id.startsWith("crd:"));
  const dynamic = items.filter((k) => k.id.startsWith("crd:"));

  // Bucket by API group, sorted by group name so the layout is stable
  // across renders.
  const buckets = new Map<string, ResourceKind[]>();
  for (const k of dynamic) {
    const arr = buckets.get(k.group) ?? [];
    arr.push(k);
    buckets.set(k.group, arr);
  }
  const groupNames = Array.from(buckets.keys()).sort();

  // Collapse state per group. Default: collapsed — busy clusters can have
  // 30+ CRDs across many vendors, so showing all of them by default makes
  // the rail unscannable. Auto-expand the group that contains the active
  // selection so the user always sees where they are.
  const activeGroup =
    dynamic.find((k) => k.id === selectedId)?.group ?? null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (g: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <>
      {builtin.map((k) => (
        <RailItem
          key={k.id}
          t={t}
          open={open}
          kind={k}
          category="CustomResources"
          active={selectedId === k.id}
          onClick={() => onSelect(k.id)}
        />
      ))}
      {groupNames.map((g) => {
        const isOpen = expanded.has(g) || activeGroup === g;
        const groupItems = buckets.get(g) ?? [];
        return (
          <div key={g} style={{ marginTop: 4 }}>
            {open && (
              <Tooltip label={`${g} — ${groupItems.length} kind${groupItems.length === 1 ? "" : "s"}`}>
              <button
                type="button"
                onClick={() => toggle(g)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "4px 8px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                  fontSize: 10.5,
                  textAlign: "left",
                  letterSpacing: 0.2,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
                    transition: "transform .12s",
                    color: t.textDim,
                  }}
                >
                  ▾
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {g}
                </span>
                <span style={{ color: t.textDim, fontSize: 10 }}>
                  {groupItems.length}
                </span>
              </button>
              </Tooltip>
            )}
            {isOpen && (
              <div style={{ paddingLeft: open ? 8 : 0 }}>
                {groupItems.map((k) => (
                  <RailItem
                    key={k.id}
                    t={t}
                    open={open}
                    kind={k}
                    category="CustomResources"
                    active={selectedId === k.id}
                    onClick={() => onSelect(k.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function RailItem({
  t,
  open,
  kind,
  category,
  active,
  onClick,
}: {
  t: ReturnType<typeof tokens>;
  open: boolean;
  kind: ResourceKind;
  category: Category;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const icon = KindIcons[kind.kind] ?? Icons[CATEGORY_ICON[category]];
  const btn = (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "7px 10px",
        borderRadius: 7,
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        background: active ? t.accentSoft : hover ? t.railHover : "transparent",
        color: active ? t.accent : t.textDim,
        width: "100%",
        minHeight: 32,
        position: "relative",
        textAlign: "left",
        transition: "background .12s, color .12s",
      }}
    >
      {active && (
        <div
          style={{
            position: "absolute",
            left: -8,
            top: 6,
            bottom: 6,
            width: 2,
            borderRadius: 2,
            background: t.accent,
          }}
        />
      )}
      <div
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          display: "flex",
          color: active ? t.accent : t.textDim,
        }}
      >
        {icon}
      </div>
      <div
        style={{
          flex: 1,
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
          letterSpacing: -0.1,
          opacity: open ? 1 : 0,
          transition: "opacity .15s",
          whiteSpace: "nowrap",
          color: active ? t.accent : t.text,
        }}
      >
        {kind.kind}
      </div>
    </button>
  );
  return open ? (
    btn
  ) : (
    <Tooltip label={kind.kind} side="right">
      {btn}
    </Tooltip>
  );
}
