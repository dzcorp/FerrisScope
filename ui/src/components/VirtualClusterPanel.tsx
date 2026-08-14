import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppStore, useClusterLabels, useResolvedTheme } from "../store";
import type { ContextInfo } from "../types";
import {
  clusterAccent,
  type ThemeMode,
  FF_MONO,
  FS_MD,
  FS_XS,
  R_LG,
  R_MD,
  R_SM,
} from "../theme";
import {
  useClusterConnection,
  type ConnectState,
} from "../lib/useClusterConnection";
import {
  clusterColorIndexMap,
  defaultVirtualContextName,
} from "../lib/multiCluster";
import {
  fitStrip,
  healthCounts,
  populatedBuckets,
  rollupSummary,
  shouldShowRollup,
  type MemberHealth,
  type StripMember,
} from "../lib/clusterStrip";
import { ReconnectBanner } from "./ClusterPanel";
import { AddMenuItem, AddMenuTrigger, NamespaceButton } from "./ClusterBar";
import { ResourceTable, type TableCluster } from "./ResourceTable";
import { makeChatTab, makeTerminalTab, makeYamlTab } from "./Dock";
import { toast } from "../lib/dialog";
import { EmptyState, Icons, LoadingLine, Tooltip } from "./ui";

type MemberConn = {
  state: ConnectState;
  cancel: () => void;
  reconnect: () => void;
  autoReconnect: { attempt: number; max: number } | null;
};

type Props = {
  mode: ThemeMode;
  /// Display name of the view — the virtual context's name, or an ad-hoc
  /// "<cluster> +N" label for scope-extra views.
  title: string;
  /// Table-view persistence key (`vctx:<id>` or the anchor cluster id).
  viewScopeId: string;
  /// Resolved member contexts, already filtered to ones that exist. MUST be
  /// referentially stable (parent memoizes on the joined id list).
  contexts: ContextInfo[];
};

// Headless per-member connection driver. One component per member keeps
// React's hook order fixed regardless of how the member set changes —
// the alternative (N useClusterConnection calls in one component) breaks
// the rules of hooks the moment membership shrinks.
function MemberConnection({
  context,
  onUpdate,
}: {
  context: ContextInfo;
  onUpdate: (id: string, conn: MemberConn) => void;
}) {
  const { state, cancel, reconnect, autoReconnect } =
    useClusterConnection(context);
  useEffect(() => {
    onUpdate(context.id, { state, cancel, reconnect, autoReconnect });
    // cancel/reconnect are fresh closures each render; state identity +
    // autoReconnect identity are what drive meaningful updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.id, state, autoReconnect, onUpdate]);
  return null;
}

// Multi-cluster view: connects every member of the active virtual context
// (or ad-hoc scope) in parallel and renders one merged ResourceTable over
// the members that are up. Per-member failures surface as banner rows with
// their own Reconnect — the table keeps serving the healthy members.
export function VirtualClusterPanel({ mode, title, viewScopeId, contexts }: Props) {
  const t = useResolvedTheme().tokens;
  const selectedKind = useAppStore((s) =>
    s.kinds.find((k) => k.id === s.selectedKindId) ?? null,
  );
  const clusterHealth = useAppStore((s) => s.clusterHealth);
  const clusterHealthReason = useAppStore((s) => s.clusterHealthReason);

  const [conns, setConns] = useState<Record<string, MemberConn>>({});
  const onUpdate = useCallback((id: string, conn: MemberConn) => {
    setConns((cur) => ({ ...cur, [id]: conn }));
  }, []);

  // Prune connection records for members that left the set, so a removed
  // cluster's error banner doesn't linger.
  const memberIds = useMemo(() => contexts.map((c) => c.id), [contexts]);
  useEffect(() => {
    setConns((cur) => {
      const next: Record<string, MemberConn> = {};
      let changed = false;
      for (const [id, conn] of Object.entries(cur)) {
        if (memberIds.includes(id)) next[id] = conn;
        else changed = true;
      }
      return changed ? next : cur;
    });
  }, [memberIds]);

  // Stable color assignment by sorted member id, independent of order and
  // of which members happen to be reachable.
  const colorIdx = useMemo(() => clusterColorIndexMap(memberIds), [memberIds]);
  const clusterLabels = useClusterLabels();
  const shortName = (c: { id: string; name: string }) =>
    clusterLabels[c.id]?.short ?? c.name;

  // The merged table only spans members whose connect landed — connecting
  // members join the fan as they arrive (backend watcher linger makes the
  // re-fan cheap for the already-subscribed ones).
  const okClusters: TableCluster[] = useMemo(
    () =>
      contexts
        .filter((c) => conns[c.id]?.state.status === "ok")
        .map((c) => ({
          id: c.id,
          name: c.name,
          colorIdx: colorIdx[c.id] ?? 0,
        })),
    [contexts, conns, colorIdx],
  );

  // Members mid silent auto-reconnect. Takes precedence over failed/unavailable
  // so a member shows exactly one strip (the busy one) while retrying — it can
  // be in `error` (hard-down) or `ok`+unavailable (wedged) underneath.
  const reconnecting = contexts.filter((c) => conns[c.id]?.autoReconnect != null);
  const reconnectingIds = new Set(reconnecting.map((c) => c.id));
  const failed = contexts.filter((c) => {
    if (reconnectingIds.has(c.id)) return false;
    const st = conns[c.id]?.state.status;
    return st === "error" || st === "cancelled";
  });
  const unavailable = contexts.filter(
    (c) =>
      !reconnectingIds.has(c.id) &&
      conns[c.id]?.state.status === "ok" &&
      clusterHealth[c.id] === "unavailable",
  );
  const connecting = contexts.filter(
    (c) => !conns[c.id] || conns[c.id]!.state.status === "connecting",
  );
  const allDown = okClusters.length === 0 && connecting.length === 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: t.bg,
      }}
    >
      {contexts.map((c) => (
        <MemberConnection key={c.id} context={c} onUpdate={onUpdate} />
      ))}

      <VirtualClusterBar
        title={title}
        contexts={contexts}
        conns={conns}
        colorIdx={colorIdx}
      />

      {/* Per-member silent auto-reconnect strips, shown first (precedence over
          failed/unavailable). "Reconnect now" forces an immediate attempt. */}
      {reconnecting.map((c) => (
        <ReconnectBanner
          key={c.id}
          mode={mode}
          title={`${shortName(c)}: reconnecting…`}
          reason={
            clusterHealthReason[c.id] ??
            (conns[c.id]?.state.status === "error"
              ? (conns[c.id]?.state as { message: string }).message
              : "Lost contact with the apiserver. Retrying with a fresh connection.")
          }
          onReconnect={() => conns[c.id]?.reconnect()}
          busy
          progress={conns[c.id]?.autoReconnect ?? undefined}
        />
      ))}

      {/* Per-member failure strips. One row per broken member with its own
          Reconnect; the table below keeps rendering the healthy members. */}
      {failed.map((c) => {
        const st = conns[c.id]?.state;
        return (
          <ReconnectBanner
            key={c.id}
            mode={mode}
            title={
              st?.status === "cancelled"
                ? `${shortName(c)}: connection cancelled`
                : `${shortName(c)}: could not connect`
            }
            reason={st?.status === "error" ? st.message : null}
            onReconnect={() => conns[c.id]?.reconnect()}
          />
        );
      })}
      {unavailable.map((c) => (
        <ReconnectBanner
          key={c.id}
          mode={mode}
          title={`${shortName(c)}: cluster unavailable`}
          reason={
            clusterHealthReason[c.id] ??
            "No response from the apiserver for 30s. Watchers and metrics have been torn down."
          }
          onReconnect={() => conns[c.id]?.reconnect()}
        />
      ))}

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {okClusters.length > 0 ? (
          selectedKind ? (
            <ResourceTable
              mode={mode}
              clusters={okClusters}
              viewScopeId={viewScopeId}
              kind={selectedKind}
            />
          ) : (
            <EmptyState
              t={t}
              title="Pick a resource kind"
              hint="Hover the left rail to expand it, then choose a kind."
            />
          )
        ) : allDown ? (
          <EmptyState
            t={t}
            title="No members reachable"
            hint="Every cluster in this virtual context failed to connect. Use Reconnect above, or check your kubeconfig / VPN."
          />
        ) : (
          <LoadingLine
            t={t}
            label={`Connecting to ${connecting.length} cluster${connecting.length === 1 ? "" : "s"}…`}
          />
        )}
      </div>
    </div>
  );
}

type AddMenuMode = "root" | "terminal" | "yaml" | "add" | "save";

// Compact bar for the merged view: virtual-context name + one chip per
// member (identity dot in the member's accent + name + state dot) + the
// "+" menu (dock tabs need a member picker — they bind to ONE cluster) +
// the namespace filter button. Composes the same store-driven namespace
// modal the single-cluster ClusterBar uses. Ad-hoc scope extras render a
// remove ×, and "Save as virtual context" persists the current set.
function VirtualClusterBar({
  title,
  contexts,
  conns,
  colorIdx,
}: {
  title: string;
  contexts: ContextInfo[];
  conns: Record<string, MemberConn>;
  colorIdx: Record<string, number>;
}) {
  const t = useResolvedTheme().tokens;
  const scopeExtras = useAppStore((s) => s.scopeExtras);
  const addScopeExtra = useAppStore((s) => s.addScopeExtra);
  const allContexts = useAppStore((s) => s.contexts);
  const addDockTab = useAppStore((s) => s.addDockTab);
  const virtualContexts = useAppStore((s) => s.virtualContexts);
  const saveVirtualContext = useAppStore((s) => s.saveVirtualContext);
  const selectVirtualContext = useAppStore((s) => s.selectVirtualContext);
  const absorbScopeExtras = useAppStore((s) => s.absorbScopeExtras);
  // The saved virtual context this view extends, if any — drives the
  // "Add to <name>" option in save mode (vs. always creating a new one).
  const activeVctx = useAppStore((s) =>
    s.selectedVirtualContextId
      ? s.virtualContexts.find((v) => v.id === s.selectedVirtualContextId) ??
        null
      : null,
  );

  const memberIds = contexts.map((c) => c.id);
  const addable = allContexts.filter((c) => !memberIds.includes(c.id));
  const clusterLabels = useClusterLabels();
  const shortName = (c: { id: string; name: string }) =>
    clusterLabels[c.id]?.short ?? c.name;

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMode, setMenuMode] = useState<AddMenuMode>("root");
  const [saveName, setSaveName] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) {
      setMenuMode("root");
      setSaveName("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const openChat = () => {
    // Idempotent: focus any chat tab already bound to one of the members;
    // otherwise open a new chat on the first member — the agent can switch
    // clusters itself via fs_configuration_use_context.
    const s = useAppStore.getState();
    const existing = s.dockTabs.find(
      (tt) =>
        tt.kind === "chat" &&
        memberIds.includes(
          String((tt.state as { clusterId?: string } | undefined)?.clusterId),
        ),
    );
    if (existing) {
      s.setDockActiveId(existing.id);
      s.setDockMin("right", false);
    } else {
      const first = contexts[0];
      if (first) addDockTab(makeChatTab(first.id, first.name));
    }
    setMenuOpen(false);
  };

  const trimmedSave = saveName.trim();
  const saveDup = virtualContexts.some(
    (v) => v.name.toLowerCase() === trimmedSave.toLowerCase(),
  );
  // Empty input falls back to a pregenerated "a + b" / "a +N" name
  // (deduped against existing virtual contexts) shown as the placeholder.
  const generatedName = defaultVirtualContextName(
    contexts.map((c) => c.name),
    virtualContexts.map((v) => v.name),
  );
  const canSave =
    memberIds.length >= 2 && !(trimmedSave.length > 0 && saveDup);
  const onSaveView = () => {
    if (!canSave) return;
    const name = trimmedSave.length > 0 ? trimmedSave : generatedName;
    const id = saveVirtualContext(name, memberIds);
    toast.ok(`Saved virtual context "${name}".`);
    setMenuOpen(false);
    // Switching to the saved virtual context keeps the same member set but
    // clears the ad-hoc extras (they're now part of the definition).
    selectVirtualContext(id);
  };


  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        // Same vertical rhythm as the single-cluster ClusterBar — the two
        // bars swap in for each other when the scope grows/shrinks, so a
        // height or chrome jump reads as a glitch.
        padding: "12px 22px",
        borderBottom: `1px solid ${t.border}`,
        background: t.headerAlt,
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: FS_MD,
          fontWeight: 700,
          color: t.text,
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      <span
        aria-hidden
        style={{ width: 1, height: 16, background: t.border, flexShrink: 0 }}
      />
      <MemberStrip
        contexts={contexts}
        conns={conns}
        colorIdx={colorIdx}
        shortName={shortName}
        qualifierFor={(c) => clusterLabels[c.id]?.qualifier ?? null}
      />

      {/* Temporary (ad-hoc) views get a standing Save affordance — the
          same save flow the "+" menu offers, surfaced so the operator
          doesn't have to discover it behind the menu. */}
      {scopeExtras.length > 0 && (
        <Tooltip label="Save these clusters as a virtual context">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(true);
              setMenuMode("save");
            }}
            style={{
              border: `1px solid ${t.accent}`,
              background: t.accentSoft,
              color: t.accent,
              height: 36,
              padding: "0 12px",
              borderRadius: R_MD,
              fontSize: FS_MD,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              outline: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Save view…
          </button>
        </Tooltip>
      )}

      {/* "+" menu — dock tabs bind to ONE cluster, so terminal/YAML go
          through a member picker; chat opens on the first member (the
          agent can switch clusters itself). */}
      <div ref={menuRef} style={{ position: "relative" }}>
        <AddMenuTrigger
          open={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          tooltip="New tab, add cluster, or save this view"
          ariaLabel="Add tab or cluster"
        />
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: R_LG,
              padding: 4,
              minWidth: 240,
              zIndex: 22,
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              // Long context lists (Add cluster / member pickers) must
              // scroll, not run off the viewport.
              maxHeight: "min(420px, 60vh)",
              overflowY: "auto",
            }}
          >
            {menuMode === "root" && (
              <>
                <AddMenuItem
                  t={t}
                  icon={Icons.shell}
                  title="Terminal…"
                  subtitle="Run kubectl — pick a cluster"
                  onClick={() =>
                    contexts.length === 1 && contexts[0]
                      ? (addDockTab(
                          makeTerminalTab(
                            {
                              mode: "shell",
                              clusterId: contexts[0].id,
                              namespace: null,
                            },
                            contexts[0].name,
                          ),
                        ),
                        setMenuOpen(false))
                      : setMenuMode("terminal")
                  }
                />
                <AddMenuItem
                  t={t}
                  icon={Icons.yaml}
                  title="YAML scratchpad…"
                  subtitle="Edit and apply — pick a cluster"
                  onClick={() =>
                    contexts.length === 1 && contexts[0]
                      ? (addDockTab(makeYamlTab(contexts[0].id)),
                        setMenuOpen(false))
                      : setMenuMode("yaml")
                  }
                />
                <AddMenuItem
                  t={t}
                  icon={Icons.chat}
                  title="AI chat"
                  subtitle="Talk to the cluster-aware assistant"
                  onClick={openChat}
                />
                <AddMenuItem
                  t={t}
                  icon={Icons.plus}
                  title="Add cluster…"
                  subtitle="Merge another cluster into this view"
                  onClick={() => setMenuMode("add")}
                />
              </>
            )}
            {(menuMode === "terminal" || menuMode === "yaml") &&
              contexts.map((c) => (
                <MenuRow
                  key={c.id}
                  label={shortName(c)}
                  hint=""
                  dotColor={clusterAccent(colorIdx[c.id] ?? 0)}
                  onClick={() => {
                    if (menuMode === "terminal") {
                      addDockTab(
                        makeTerminalTab(
                          { mode: "shell", clusterId: c.id, namespace: null },
                          shortName(c),
                        ),
                      );
                    } else {
                      addDockTab(makeYamlTab(c.id));
                    }
                    setMenuOpen(false);
                  }}
                />
              ))}
            {menuMode === "add" &&
              (addable.length === 0 ? (
                <div
                  style={{
                    padding: "8px 10px",
                    fontSize: FS_XS,
                    color: t.textMuted,
                  }}
                >
                  Every context is already in this view.
                </div>
              ) : (
                // Same row anatomy as ClusterBar's "Add cluster to this
                // view" list — the two menus must read identically.
                addable.map((c) => (
                  <AddMenuItem
                    key={c.id}
                    t={t}
                    icon={Icons.cluster}
                    title={shortName(c)}
                    subtitle={clusterLabels[c.id]?.qualifier ?? c.cluster}
                    onClick={() => {
                      addScopeExtra(c.id);
                      setMenuOpen(false);
                    }}
                  />
                ))
              ))}
            {menuMode === "save" && activeVctx && scopeExtras.length > 0 && (
              <AddMenuItem
                t={t}
                icon={Icons.layers}
                title={`Add to "${activeVctx.name}"`}
                subtitle="Fold the added clusters into this virtual context"
                onClick={() => {
                  absorbScopeExtras(activeVctx.id);
                  toast.ok(
                    `Added ${scopeExtras.length} cluster${scopeExtras.length === 1 ? "" : "s"} to "${activeVctx.name}".`,
                  );
                  setMenuOpen(false);
                }}
              />
            )}
            {menuMode === "save" && (
              <div style={{ display: "flex", gap: 6, padding: 6 }}>
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveView();
                  }}
                  placeholder={generatedName}
                  aria-label="Virtual context name"
                  style={{
                    flex: 1,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: R_MD,
                    border: `1px solid ${saveDup && trimmedSave ? t.bad : t.border}`,
                    background: t.bg,
                    color: t.text,
                    fontSize: FS_XS,
                    fontFamily: "inherit",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={onSaveView}
                  disabled={!canSave}
                  style={{
                    border: `1px solid ${t.border}`,
                    background: canSave ? t.accent : t.chip,
                    color: canSave ? "#fff" : t.textMuted,
                    borderRadius: R_MD,
                    padding: "0 10px",
                    fontSize: FS_XS,
                    cursor: canSave ? "pointer" : "default",
                    whiteSpace: "nowrap",
                  }}
                >
                  {activeVctx ? "Save as new" : "Save"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <NamespaceButton />
    </div>
  );
}

// Minimal dropdown row for the VirtualClusterBar "+" menu. Kept local —
// ClusterBar's AddMenuItem carries icon+subtitle chrome this compact menu
// doesn't need.
// The bar's member list. Scales from two clusters to a few dozen without a
// magic cutoff: chips render while they fit the measured width, then a health
// rollup summarises what's left and a "+N" pill opens the full list.
//
// The old strip was a plain flex row with `overflow: hidden`, so past a
// handful of members the extras were clipped SILENTLY — no count, no way to
// reach them, and an unreachable member could be invisible.
function MemberStrip({
  contexts,
  conns,
  colorIdx,
  shortName,
  qualifierFor,
}: {
  contexts: ContextInfo[];
  conns: Record<string, MemberConn>;
  colorIdx: Record<string, number>;
  shortName: (c: { id: string; name: string }) => string;
  qualifierFor: (c: ContextInfo) => string | null;
}) {
  const t = useResolvedTheme().tokens;
  const clusterHealth = useAppStore((s) => s.clusterHealth);
  const scopeExtras = useAppStore((s) => s.scopeExtras);
  const removeScopeExtra = useAppStore((s) => s.removeScopeExtra);
  const focusedClusterId = useAppStore((s) => s.focusedClusterId);
  const toggleFocusedCluster = useAppStore((s) => s.toggleFocusedCluster);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const [query, setQuery] = useState("");
  const overflowRef = useRef<HTMLDivElement | null>(null);

  // Measured width of the strip. Seeded optimistically so the first paint
  // shows chips rather than a "+N" that immediately expands.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const health = (c: ContextInfo): { bucket: MemberHealth; label: string } => {
    // Auto-reconnecting wins over the underlying error/unavailable state so
    // the chip matches the single "reconnecting…" strip the operator sees.
    if (conns[c.id]?.autoReconnect != null) {
      return { bucket: "connecting", label: "reconnecting" };
    }
    const st = conns[c.id]?.state.status;
    if (st === "ok") {
      return clusterHealth[c.id] === "unavailable"
        ? { bucket: "bad", label: "unavailable" }
        : { bucket: "ok", label: "connected" };
    }
    if (st === "error" || st === "cancelled") {
      return { bucket: "bad", label: st };
    }
    return { bucket: "connecting", label: "connecting" };
  };
  const bucketColor = (b: MemberHealth) =>
    b === "ok" ? t.good : b === "bad" ? t.bad : t.warn;

  const byId = new Map(contexts.map((c) => [c.id, c]));
  const members: StripMember[] = contexts.map((c) => ({
    id: c.id,
    label: shortName(c),
    health: health(c).bucket,
    removable: scopeExtras.includes(c.id),
  }));

  const counts = healthCounts(members);
  // Chicken-and-egg: the rollup's width depends on whether anything is
  // hidden, which depends on the space the rollup takes. Reserve for it
  // whenever it *could* show (anything unhealthy), then decide for real.
  const mayRollup = counts.connecting > 0 || counts.bad > 0;
  const fit = fitStrip(members, width, {
    pinnedId: focusedClusterId,
    rollupBuckets: mayRollup ? populatedBuckets(counts) : 0,
  });
  const showRollup = shouldShowRollup(counts, fit.hidden.length);

  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node))
        setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);
  useEffect(() => {
    if (!overflowOpen) setQuery("");
  }, [overflowOpen]);

  const chip = (m: StripMember) => {
    const c = byId.get(m.id);
    if (!c) return null;
    const h = health(c);
    const focused = focusedClusterId === m.id;
    return (
      <Tooltip
        key={m.id}
        label={`${c.name} — ${h.label}${m.removable ? " (ad-hoc)" : ""}${
          focused ? " · showing only this cluster" : " · click to show only this cluster"
        }`}
      >
        <span
          role="button"
          tabIndex={0}
          aria-pressed={focused}
          aria-label={`${c.name}, ${h.label}`}
          onClick={() => toggleFocusedCluster(m.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleFocusedCluster(m.id);
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 8px",
            borderRadius: R_MD,
            background: focused ? t.accentSoft : t.chip,
            border: `1px ${m.removable ? "dashed" : "solid"} ${
              focused ? t.accent : t.borderSoft
            }`,
            fontSize: FS_XS,
            fontFamily: FF_MONO,
            color: focused ? t.text : t.textDim,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 220,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: clusterAccent(colorIdx[m.id] ?? 0),
              flexShrink: 0,
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {m.label}
          </span>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: bucketColor(m.health),
              flexShrink: 0,
            }}
          />
          {m.removable && (
            <button
              type="button"
              aria-label={`Remove ${c.name} from this view`}
              onClick={(e) => {
                e.stopPropagation();
                removeScopeExtra(m.id);
              }}
              style={{
                border: "none",
                background: "transparent",
                color: t.textMuted,
                cursor: "pointer",
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                lineHeight: 1,
                fontSize: FS_XS,
              }}
            >
              ×
            </button>
          )}
        </span>
      </Tooltip>
    );
  };

  const hiddenMatching = query.trim()
    ? members.filter((m) => {
        const c = byId.get(m.id);
        const needle = query.trim().toLowerCase();
        return (
          m.label.toLowerCase().includes(needle) ||
          (c?.name ?? "").toLowerCase().includes(needle)
        );
      })
    : members;

  return (
    <div
      ref={stripRef}
      data-testid="member-strip"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {fit.visible.map(chip)}

      {showRollup && (
        <Tooltip label={rollupSummary(counts)}>
          <span
            data-testid="member-rollup"
            aria-label={rollupSummary(counts)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              color: t.textMuted,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {(["ok", "connecting", "bad"] as const)
              .filter((b) => counts[b] > 0)
              .map((b) => (
                <span
                  key={b}
                  style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: bucketColor(b),
                    }}
                  />
                  {counts[b]}
                </span>
              ))}
          </span>
        </Tooltip>
      )}

      {fit.hidden.length > 0 && (
        <div ref={overflowRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            data-testid="member-overflow"
            aria-haspopup="dialog"
            aria-expanded={overflowOpen}
            aria-label={`Show all ${members.length} clusters (${fit.hidden.length} not shown)`}
            onClick={() => setOverflowOpen((v) => !v)}
            style={{
              border: `1px solid ${t.borderSoft}`,
              background: overflowOpen ? t.accentSoft : t.chip,
              color: overflowOpen ? t.accent : t.textDim,
              borderRadius: R_MD,
              padding: "3px 8px",
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            +{fit.hidden.length}
          </button>
          {overflowOpen && (
            <div
              role="dialog"
              aria-label="All clusters in this view"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                zIndex: 30,
                minWidth: 280,
                maxWidth: 380,
                maxHeight: 340,
                overflowY: "auto",
                background: t.surface,
                border: `1px solid ${t.border}`,
                borderRadius: R_MD,
                boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
                padding: 4,
              }}
            >
              {members.length > 8 && (
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search clusters…"
                  aria-label="Search clusters in this view"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    margin: "2px 0 6px",
                    padding: "5px 8px",
                    border: `1px solid ${t.borderSoft}`,
                    borderRadius: R_SM,
                    background: t.chip,
                    color: t.text,
                    fontSize: FS_XS,
                    fontFamily: FF_MONO,
                    outline: "none",
                  }}
                />
              )}
              {hiddenMatching.length === 0 && (
                <div
                  style={{
                    padding: "8px 8px 10px",
                    fontSize: FS_XS,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  No cluster matches “{query.trim()}”.
                </div>
              )}
              {hiddenMatching.map((m) => {
                const c = byId.get(m.id);
                if (!c) return null;
                const h = health(c);
                const focused = focusedClusterId === m.id;
                const qualifier = qualifierFor(c);
                return (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={focused}
                    title={c.name}
                    onClick={() => {
                      toggleFocusedCluster(m.id);
                      setOverflowOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleFocusedCluster(m.id);
                        setOverflowOpen(false);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: R_SM,
                      cursor: "pointer",
                      background: focused ? t.accentSoft : "transparent",
                      color: focused ? t.text : t.textDim,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: clusterAccent(colorIdx[m.id] ?? 0),
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: FS_XS,
                          fontFamily: FF_MONO,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.label}
                      </span>
                      {qualifier && (
                        <span
                          style={{
                            display: "block",
                            fontSize: FS_XS,
                            fontFamily: FF_MONO,
                            color: t.textMuted,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {qualifier}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontSize: FS_XS,
                        fontFamily: FF_MONO,
                        color: bucketColor(m.health),
                        flexShrink: 0,
                      }}
                    >
                      {h.label}
                    </span>
                    {m.removable && (
                      <button
                        type="button"
                        aria-label={`Remove ${c.name} from this view`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeScopeExtra(m.id);
                        }}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: t.textMuted,
                          cursor: "pointer",
                          padding: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          lineHeight: 1,
                          fontSize: FS_XS,
                          flexShrink: 0,
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  label,
  hint,
  dotColor,
  onClick,
}: {
  label: string;
  hint: string;
  dotColor?: string;
  onClick: () => void;
}) {
  const t = useResolvedTheme().tokens;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = t.hover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        borderRadius: R_MD,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        color: t.text,
        fontFamily: "inherit",
        fontSize: FS_MD,
      }}
    >
      {dotColor && (
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {hint && (
        <span style={{ fontSize: FS_XS, color: t.textMuted, flexShrink: 0 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
