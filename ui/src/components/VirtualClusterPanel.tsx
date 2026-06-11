import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, useResolvedTheme } from "../store";
import type { ContextInfo } from "../types";
import { clusterAccent, type ThemeMode, FF_MONO, FS_MD, FS_XS, R_LG, R_MD } from "../theme";
import {
  useClusterConnection,
  type ConnectState,
} from "../lib/useClusterConnection";
import { clusterColorIndexMap } from "../lib/multiCluster";
import { ReconnectBanner } from "./ClusterPanel";
import { ResourceTable, type TableCluster } from "./ResourceTable";
import { makeChatTab, makeTerminalTab, makeYamlTab } from "./Dock";
import { toast } from "../lib/dialog";
import { EmptyState, Icons, LoadingLine, Tooltip } from "./ui";

type MemberConn = {
  state: ConnectState;
  cancel: () => void;
  reconnect: () => void;
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
  const { state, cancel, reconnect } = useClusterConnection(context);
  useEffect(() => {
    onUpdate(context.id, { state, cancel, reconnect });
    // cancel/reconnect are fresh closures each render; state identity is
    // what actually drives meaningful updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.id, state, onUpdate]);
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

  const failed = contexts.filter((c) => {
    const st = conns[c.id]?.state.status;
    return st === "error" || st === "cancelled";
  });
  const unavailable = contexts.filter(
    (c) =>
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
                ? `${c.name}: connection cancelled`
                : `${c.name}: could not connect`
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
          title={`${c.name}: cluster unavailable`}
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
  const selectedNamespaces = useAppStore((s) => s.selectedNamespaces);
  const openNsModal = useAppStore((s) => s.openNsModal);
  const clusterHealth = useAppStore((s) => s.clusterHealth);
  const scopeExtras = useAppStore((s) => s.scopeExtras);
  const removeScopeExtra = useAppStore((s) => s.removeScopeExtra);
  const addScopeExtra = useAppStore((s) => s.addScopeExtra);
  const allContexts = useAppStore((s) => s.contexts);
  const addDockTab = useAppStore((s) => s.addDockTab);
  const virtualContexts = useAppStore((s) => s.virtualContexts);
  const saveVirtualContext = useAppStore((s) => s.saveVirtualContext);
  const selectVirtualContext = useAppStore((s) => s.selectVirtualContext);

  const memberIds = contexts.map((c) => c.id);
  const addable = allContexts.filter((c) => !memberIds.includes(c.id));

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
  const canSave = trimmedSave.length > 0 && !saveDup && memberIds.length >= 2;
  const onSaveView = () => {
    if (!canSave) return;
    const id = saveVirtualContext(trimmedSave, memberIds);
    toast.ok(`Saved virtual context "${trimmedSave}".`);
    setMenuOpen(false);
    // Switching to the saved virtual context keeps the same member set but
    // clears the ad-hoc extras (they're now part of the definition).
    selectVirtualContext(id);
  };

  const nsCount = selectedNamespaces.size;
  const nsSummary =
    nsCount === 0
      ? "All namespaces"
      : nsCount === 1
        ? Array.from(selectedNamespaces)[0]
        : `${nsCount} namespaces`;

  const stateDot = (c: ContextInfo): { color: string; label: string } => {
    const st = conns[c.id]?.state.status;
    if (st === "ok") {
      return clusterHealth[c.id] === "unavailable"
        ? { color: t.bad, label: "unavailable" }
        : { color: t.good, label: "connected" };
    }
    if (st === "error" || st === "cancelled") {
      return { color: t.bad, label: st };
    }
    return { color: t.unknown, label: "connecting" };
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderBottom: `1px solid ${t.border}`,
        background: t.header,
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {contexts.map((c) => {
          const dot = stateDot(c);
          const isExtra = scopeExtras.includes(c.id);
          return (
            <Tooltip
              key={c.id}
              label={`${c.name} — ${dot.label}${isExtra ? " (ad-hoc)" : ""}`}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 8px",
                  borderRadius: R_MD,
                  background: t.chip,
                  border: `1px ${isExtra ? "dashed" : "solid"} ${t.borderSoft}`,
                  fontSize: FS_XS,
                  fontFamily: FF_MONO,
                  color: t.textDim,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 220,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: clusterAccent(colorIdx[c.id] ?? 0),
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.name}
                </span>
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dot.color,
                    flexShrink: 0,
                  }}
                />
                {isExtra && (
                  <button
                    type="button"
                    aria-label={`Remove ${c.name} from this view`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeScopeExtra(c.id);
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
        })}
      </div>

      {/* "+" menu — dock tabs bind to ONE cluster, so terminal/YAML go
          through a member picker; chat opens on the first member (the
          agent can switch clusters itself). */}
      <div ref={menuRef} style={{ position: "relative" }}>
        <button
          type="button"
          aria-label="Add tab or cluster"
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            border: `1px solid ${t.border}`,
            background: menuOpen ? t.btnHover : "transparent",
            color: t.text,
            width: 28,
            height: 28,
            borderRadius: R_MD,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {Icons.plus}
        </button>
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
            }}
          >
            {menuMode === "root" && (
              <>
                <MenuRow
                  label="Terminal…"
                  hint="pick a cluster"
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
                <MenuRow
                  label="YAML scratchpad…"
                  hint="pick a cluster"
                  onClick={() =>
                    contexts.length === 1 && contexts[0]
                      ? (addDockTab(makeYamlTab(contexts[0].id)),
                        setMenuOpen(false))
                      : setMenuMode("yaml")
                  }
                />
                <MenuRow label="AI chat" hint="" onClick={openChat} />
                <MenuRow
                  label="Add cluster…"
                  hint=""
                  onClick={() => setMenuMode("add")}
                />
                {scopeExtras.length > 0 && (
                  <MenuRow
                    label="Save as virtual context…"
                    hint=""
                    onClick={() => setMenuMode("save")}
                  />
                )}
              </>
            )}
            {(menuMode === "terminal" || menuMode === "yaml") &&
              contexts.map((c) => (
                <MenuRow
                  key={c.id}
                  label={c.name}
                  hint=""
                  dotColor={clusterAccent(colorIdx[c.id] ?? 0)}
                  onClick={() => {
                    if (menuMode === "terminal") {
                      addDockTab(
                        makeTerminalTab(
                          { mode: "shell", clusterId: c.id, namespace: null },
                          c.name,
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
                addable.map((c) => (
                  <MenuRow
                    key={c.id}
                    label={c.name}
                    hint={c.cluster}
                    onClick={() => {
                      addScopeExtra(c.id);
                      setMenuOpen(false);
                    }}
                  />
                ))
              ))}
            {menuMode === "save" && (
              <div style={{ display: "flex", gap: 6, padding: 6 }}>
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveView();
                  }}
                  placeholder={saveDup ? "Name already in use" : "Name"}
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
                  }}
                >
                  Save
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={openNsModal}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: R_MD,
          border: `1px solid ${t.border}`,
          background: "transparent",
          color: t.textDim,
          fontSize: FS_XS,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        title="Filter namespaces"
      >
        {Icons.layers}
        {nsSummary}
      </button>
    </div>
  );
}

// Minimal dropdown row for the VirtualClusterBar "+" menu. Kept local —
// ClusterBar's AddMenuItem carries icon+subtitle chrome this compact menu
// doesn't need.
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
