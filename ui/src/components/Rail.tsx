import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useActiveClusterIds, useAppStore, useResolvedTheme } from "../store";
import type { Category, PrefsRailMode, ResourceKind } from "../types";
import {
  tokens,
  FF_MONO,
  type ThemeMode,
  type Tokens,
  R_MD,
  R_SM,
  FS_MD,
  FS_SM,
  FS_XS,
  vibrantSurface,
} from "../theme";
import { IS_MAC } from "../lib/keyboard";
import { compareApiGroups } from "../lib/crdGroups";
import { ErrorBlock, Icons, Tooltip, resolveKindIcon } from "./ui";
import { OpenClustersStrip } from "./OpenClustersStrip";

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
export function Rail({}: Props) {
  const resolved = useResolvedTheme();
  const t = resolved.tokens;
  const themeMode = resolved.mode;
  // Per-field selectors, not a bulk `useAppStore()` destructure: the bulk form
  // subscribes to the whole state object, so this always-mounted rail would
  // re-render its full kind list on every unrelated mutation (metrics tick,
  // table-count updates, toasts, selection toggles). Each selector below
  // re-renders only when its own slice changes; the action functions are
  // stable store references and never trigger a render.
  const kinds = useAppStore((s) => s.kinds);
  const kindsStatus = useAppStore((s) => s.kindsStatus);
  const kindsError = useAppStore((s) => s.kindsError);
  const selectedKindId = useAppStore((s) => s.selectedKindId);
  // CRD discovery spans every active cluster (members of a virtual context
  // or the single selection). NUL-joined key — ids contain "::"/spaces.
  const activeClusterIds = useActiveClusterIds();
  const activeClusterKey = activeClusterIds.join(String.fromCharCode(0));
  const setKinds = useAppStore((s) => s.setKinds);
  const setKindClusters = useAppStore((s) => s.setKindClusters);
  const setKindsLoading = useAppStore((s) => s.setKindsLoading);
  const setKindsError = useAppStore((s) => s.setKindsError);
  const selectKind = useAppStore((s) => s.selectKind);
  const railMode = useAppStore((s) => s.railMode);
  const setRailMode = useAppStore((s) => s.setRailMode);
  const cycleRailMode = useAppStore((s) => s.cycleRailMode);
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

  // Discover CRDs on every active cluster (one for the classic view, N for
  // a virtual context). CRDs are cluster-local so the dynamic kinds reset
  // on scope switch — we don't keep a stale list visible. The rail shows
  // the UNION across members; `kindClusters` records which members serve
  // each dynamic kind so the merged table never subscribes a kind on a
  // cluster that lacks it. Failures only surface when EVERY member's
  // discovery fails — the operator still has the well-known kinds and the
  // standalone CustomResourceDefinition entry.
  useEffect(() => {
    const ids =
      activeClusterKey === ""
        ? []
        : activeClusterKey.split(String.fromCharCode(0));
    if (ids.length === 0) {
      setCustomError(null);
      setKindClusters({});
      // Drop any dynamic kinds back to the static tail when no cluster is
      // selected — switching back to fleet view should clear the rail.
      const current = useAppStore.getState().kinds;
      if (current.length > staticKindsCount.current) {
        setKinds(current.slice(0, staticKindsCount.current));
      }
      return;
    }
    let cancelled = false;
    setCustomError(null);
    const perMember = new Map<string, ResourceKind[]>();
    let exhausted = 0;
    let lastError = "";

    // Recompute the union + availability map from whatever has landed so
    // far. Members publish independently — a slow cluster doesn't hold the
    // fast one's CRDs hostage. Union order follows the active id order;
    // first member to surface a kind id wins the ResourceKind value
    // (column sets for the same id are identical by construction — the id
    // embeds group/version/plural).
    const publish = () => {
      if (cancelled) return;
      const current = useAppStore.getState().kinds;
      const head = current.slice(0, staticKindsCount.current);
      const union: ResourceKind[] = [];
      const availability: Record<string, string[]> = {};
      for (const cid of ids) {
        for (const k of perMember.get(cid) ?? []) {
          if (!availability[k.id]) {
            availability[k.id] = [];
            union.push(k);
          }
          availability[k.id]!.push(cid);
        }
      }
      setKinds([...head, ...union]);
      setKindClusters(availability);
    };

    const discover = (cid: string) => {
      let attempts = 0;
      const maxAttempts = 8;
      const tryOnce = () => {
        attempts += 1;
        api
          .listCustomResourceKinds(cid)
          .then((list) => {
            if (cancelled) return;
            perMember.set(cid, list);
            publish();
            // eslint-disable-next-line no-console
            console.info(
              `[FerrisScope] discovered ${list.length} CRD-derived kinds for ${cid}`,
            );
          })
          .catch((e: unknown) => {
            if (cancelled) return;
            // The cluster may not be connected yet — the panel kicks off
            // its connect in parallel and discovery races it. Back off and
            // retry a handful of times before giving up on this member.
            if (attempts < maxAttempts) {
              const delay = Math.min(500 * 2 ** (attempts - 1), 4000);
              setTimeout(() => {
                if (!cancelled) tryOnce();
              }, delay);
              return;
            }
            lastError = String(e);
            exhausted += 1;
            // eslint-disable-next-line no-console
            console.warn(
              `[FerrisScope] CRD discovery failed for ${cid} after ${attempts} attempts:`,
              lastError,
            );
            if (exhausted === ids.length && perMember.size === 0) {
              // Every member failed — same operator surface as the old
              // single-cluster failure path.
              const current = useAppStore.getState().kinds;
              if (current.length > staticKindsCount.current) {
                setKinds(current.slice(0, staticKindsCount.current));
              }
              setCustomError(lastError);
            }
          });
      };
      tryOnce();
    };
    for (const cid of ids) discover(cid);

    return () => {
      cancelled = true;
    };
  }, [activeClusterKey, setKinds, setKindClusters]);

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
          // Translucent on macOS so the vibrancy material shows through the
          // sidebar; opaque elsewhere. The <main> content stays opaque.
          background: IS_MAC ? vibrantSurface(t.rail, themeMode) : t.rail,
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
          {/* Open cluster tabs, above the kind list. Self-hides with <2 tabs. */}
          <OpenClustersStrip t={t} open={open} />
          {kindsStatus === "error" ? (
            <div
              style={{
                padding: "10px 16px",
                opacity: open ? 1 : 0,
                transition: "opacity .15s",
              }}
            >
              <ErrorBlock
                t={t}
                message={kindsError ?? ""}
                kindLabel="resource kinds"
                inline
              />
            </div>
          ) : kindsStatus !== "ready" ? (
            <div
              style={{
                padding: "10px 16px",
                fontSize: FS_SM,
                color: t.textMuted,
                fontFamily: FF_MONO,
                opacity: open ? 1 : 0,
                transition: "opacity .15s",
              }}
            >
              loading…
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
                      fontSize: FS_XS,
                      color: t.bad,
                      fontFamily: FF_MONO,
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
            borderRadius: R_MD,
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
                    borderLeft: i === 0 ? "none" : `1px solid ${t.border}`,
                    background: active ? t.accentSoft : "transparent",
                    color: active ? t.accent : t.textMuted,
                    fontFamily: FF_MONO,
                    fontSize: FS_XS,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: "uppercase",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    lineHeight: 1,
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
        borderRadius: R_MD,
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
            fontSize: FS_MD,
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
  return open ? (
    btn
  ) : (
    <Tooltip label={title} side="right">
      {btn}
    </Tooltip>
  );
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
          fontSize: FS_XS,
          fontWeight: 700,
          color: t.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          fontFamily: FF_MONO,
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
  // Sort by domain hierarchy (root-first) so a vendor's groups stay
  // contiguous — gke.io / auto.gke.io / node.gke.io group together instead
  // of being split apart by an unrelated group that sorts between them
  // lexicographically (e.g. cert-manager.io).
  const groupNames = Array.from(buckets.keys()).sort(compareApiGroups);

  // Collapse state per group. Default: collapsed — busy clusters can have
  // 30+ CRDs across many vendors, so showing all of them by default makes
  // the rail unscannable. Auto-expand the group that contains the active
  // selection so the user always sees where they are.
  const activeGroup = dynamic.find((k) => k.id === selectedId)?.group ?? null;
  // `expanded` is the single source of truth for which groups are open. Seed
  // it with the active group so a restored/preselected CRD reveals its group
  // on mount without a flash of collapsed state.
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    activeGroup ? new Set([activeGroup]) : new Set(),
  );
  // Auto-expand the group holding the selection, but only when the selection
  // *moves* into a new group — never on every render. Folding this into
  // `isOpen` (as `|| activeGroup === g`) pinned the selected group open and
  // silently no-op'd the collapse toggle; seeding `expanded` instead lets the
  // operator collapse it again afterward.
  useEffect(() => {
    if (!activeGroup) return;
    setExpanded((prev) =>
      prev.has(activeGroup) ? prev : new Set(prev).add(activeGroup),
    );
  }, [activeGroup]);
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
        const isOpen = expanded.has(g);
        const groupItems = buckets.get(g) ?? [];
        return (
          <div key={g} style={{ marginTop: 4 }}>
            {open && (
              <Tooltip
                label={`${g} — ${groupItems.length} kind${groupItems.length === 1 ? "" : "s"}`}
              >
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
                    fontFamily: FF_MONO,
                    fontSize: FS_XS,
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
                  <span style={{ color: t.textDim, fontSize: FS_XS }}>
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
  // Theme can opt out of rail icons (e.g. a label-only style). When the rail
  // is collapsed we keep the icon regardless — collapsed mode would
  // otherwise be a column of empty buttons. So this only takes effect once
  // the rail is open.
  const showIcons = useResolvedTheme().display.showRailIcons;
  const renderIcon = showIcons || !open;
  const icon = resolveKindIcon(kind.kind, kind.group, category);
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
        borderRadius: R_MD,
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
            borderRadius: R_SM,
            background: t.accent,
          }}
        />
      )}
      {renderIcon && (
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
      )}
      <div
        style={{
          flex: 1,
          fontSize: FS_MD,
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
