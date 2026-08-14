import { logErr } from "../lib/log";
import { useEffect, useMemo, useState } from "react";
import { api, onFleetProbe, onKubeconfigChanged } from "../api";
import { useAppStore, useClusterLabels, useResolvedTheme } from "../store";
import type { ClusterProbe, ContextInfo, VirtualContext } from "../types";
import {
  FF_MONO,
  type ThemeMode,
  type Tokens,
  clusterAccent,
  R_LG,
  R_MD,
  R_SM,
  FS_LG,
  FS_MD,
  FS_SM,
  FS_XL,
  FS_XS,
} from "../theme";
import { MOD_KEY } from "../lib/keyboard";
import { labelFor, type ClusterLabel } from "../lib/clusterName";
import {
  aggregateVirtualContext,
  clusterColorIndexMap,
  defaultVirtualContextName,
  type VirtualContextAggregate,
} from "../lib/multiCluster";
import {
  Btn,
  Checkbox,
  EmptyState,
  ErrorBlock,
  Eyebrow,
  Gauge,
  Icons,
  LoadingLine,
  Tooltip,
} from "./ui";
import { BulkBar } from "./BulkBar";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { confirm, toast } from "../lib/dialog";

type Props = {
  mode: ThemeMode;
  onSelect: (id: string) => void;
};

// Cluster fleet — landing screen when no context is selected. Cards are
// driven by two streams:
//   1. ContextInfo[] from kubeconfig (default + user-added sources) — names,
//      default namespace, group, current.
//   2. ClusterProbe per context (keyed by composite id) — version, node/pod
//      count, CPU/Mem load.
// Probes are cached to disk and refreshed hourly so the screen renders
// immediately on startup. The kubeconfig file watcher refetches contexts
// whenever any source changes (default file edited, file in a watched
// folder added/removed, etc.) so the fleet stays live without a reload.
export function FleetLanding({ mode, onSelect }: Props) {
  const t = useResolvedTheme().tokens;
  // Per-field selectors rather than a bulk `useAppStore()` destructure, which
  // would re-render the whole landing screen on every unrelated store mutation
  // (toasts, modals, notifications). Action functions are stable store refs.
  const contexts = useAppStore((s) => s.contexts);
  const contextsStatus = useAppStore((s) => s.contextsStatus);
  const contextsError = useAppStore((s) => s.contextsError);
  const setContexts = useAppStore((s) => s.setContexts);
  const setContextsLoading = useAppStore((s) => s.setContextsLoading);
  const setContextsError = useAppStore((s) => s.setContextsError);

  // Display labels for the whole fleet, resolved once here and threaded down
  // rather than re-subscribed per card. The uniqueness pass inside is
  // list-aware, so it must see every context — never a bucket.
  const labels = useClusterLabels();
  const groupByProject = useAppStore((s) => s.settings.groupFleetByProject);

  const [probes, setProbes] = useState<Record<string, ClusterProbe>>({});
  const [menu, setMenu] = useState<{ pos: MenuPosition; ctx: ContextInfo } | null>(null);
  const [vctxMenu, setVctxMenu] = useState<{
    pos: MenuPosition;
    vctx: VirtualContext;
  } | null>(null);

  // Multi-select for "save as virtual context": ⌘/Ctrl-click a card to
  // toggle it; once anything is picked every card grows a checkbox. Esc
  // clears. `editingVctx` re-enters this mode seeded with an existing
  // virtual context's members (the Edit flow).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editingVctx, setEditingVctx] = useState<string | null>(null);
  const [vctxName, setVctxName] = useState("");
  const virtualContexts = useAppStore((s) => s.virtualContexts);
  const saveVirtualContext = useAppStore((s) => s.saveVirtualContext);
  const renameVirtualContext = useAppStore((s) => s.renameVirtualContext);
  const setVirtualContextMembers = useAppStore(
    (s) => s.setVirtualContextMembers,
  );
  const deleteVirtualContext = useAppStore((s) => s.deleteVirtualContext);
  const selectVirtualContext = useAppStore((s) => s.selectVirtualContext);

  const clearPick = () => {
    setPicked(new Set());
    setEditingVctx(null);
    setVctxName("");
  };
  const togglePick = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (picked.size === 0 && editingVctx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      // Let an open input clear itself first.
      if (target && target.tagName === "INPUT") return;
      clearPick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked.size, editingVctx]);

  const trimmedName = vctxName.trim();
  const duplicateName = virtualContexts.some(
    (v) =>
      v.id !== editingVctx &&
      v.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  // Empty input is fine — we fall back to a pregenerated "a + b" / "a +N"
  // name (already deduped against existing virtual contexts), shown as the
  // input placeholder so the operator sees exactly what Save will use.
  //
  // Deliberately the FULL context names, not the shortened display labels.
  // This name is persisted as the virtual context's identity, and
  // `defaultVirtualContextName` runs its own sibling-elision pass over
  // whatever it's given. Fed the short names it double-compresses: two
  // clusters from different projects that both shorten to `prod-1` come out
  // as "prod-1 + prod-1", and `prod-1` + `prod-2` come out as "1 + 2" with
  // the project gone. Fed the full names it produces "alpha + beta" — the
  // segment that actually distinguishes them.
  const generatedName = useMemo(() => {
    const pickedNames = Array.from(picked).map(
      (id) => contexts.find((c) => c.id === id)?.name ?? id,
    );
    return defaultVirtualContextName(
      pickedNames,
      virtualContexts.filter((v) => v.id !== editingVctx).map((v) => v.name),
    );
  }, [picked, contexts, virtualContexts, editingVctx]);
  const canSaveVctx =
    picked.size >= 2 && !(trimmedName.length > 0 && duplicateName);
  const onSaveVctx = () => {
    if (!canSaveVctx) return;
    const name = trimmedName.length > 0 ? trimmedName : generatedName;
    const members = Array.from(picked);
    if (editingVctx) {
      renameVirtualContext(editingVctx, name);
      setVirtualContextMembers(editingVctx, members);
      toast.ok(`Updated virtual context "${name}".`);
    } else {
      saveVirtualContext(name, members);
      toast.ok(
        `Saved virtual context "${name}" (${members.length} clusters).`,
      );
    }
    clearPick();
  };
  // Temporary multi-cluster view: connect the picked clusters without
  // persisting anything. First pick anchors the scope, the rest ride as
  // ad-hoc extras — the VirtualClusterBar offers Save if it grows on you.
  const onOpenTemporary = () => {
    if (picked.size < 2) return;
    const [first, ...rest] = Array.from(picked);
    if (!first) return;
    const s = useAppStore.getState();
    s.selectContext(first);
    for (const id of rest) s.addScopeExtra(id);
    clearPick();
  };

  useEffect(() => {
    setContextsLoading();
    api
      .listContexts()
      .then(setContexts)
      .catch((e: unknown) => setContextsError(String(e)));
  }, [setContexts, setContextsError, setContextsLoading]);

  // Live-refresh on kubeconfig source changes. The backend debounces the
  // notify events ~300ms, so we get one tick per logical change even when an
  // editor does a rename-then-replace.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onKubeconfigChanged(() => {
      if (cancelled) return;
      api.listContexts().then(setContexts).catch((e: unknown) => {
        setContextsError(String(e));
      });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [setContexts, setContextsError]);

  // Load the cached fleet on first render so the screen has values
  // immediately, then trigger a background refresh for stale entries.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await onFleetProbe((probe) => {
          if (cancelled) return;
          setProbes((prev) => ({ ...prev, [probe.context_name]: probe }));
        });
        const cache = await api.getFleetCache();
        if (!cancelled) setProbes(cache);
      } catch {
        // Best-effort: cache failure is non-fatal.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Settings → General → Refresh-on-launch gates the initial probe; the
  // hourly disk cache already gives us values to render immediately so the
  // operator can opt out of the on-mount network calls.
  const refreshOnLaunch = useAppStore((s) => s.settings.refreshOnLaunch);
  // Settings → General → Refresh interval drives the periodic background
  // re-probe of the visible fleet. 0 disables.
  const refreshSec = useAppStore((s) => s.settings.refreshSec);
  // Fleet-only view mode (tiles | mini | rows). Independent of global
  // density — see prefs::FleetView.
  const fleetView = useAppStore((s) => s.settings.fleetView);

  useEffect(() => {
    if (contexts.length === 0) return;
    if (!refreshOnLaunch) return;
    api
      .refreshFleet(
        contexts.map((c) => c.id),
        false,
      )
      .catch(logErr("fleet"));
  }, [contexts, refreshOnLaunch]);

  useEffect(() => {
    if (contexts.length === 0) return;
    if (refreshSec <= 0) return;
    const ids = contexts.map((c) => c.id);
    const id = setInterval(() => {
      api.refreshFleet(ids, false).catch(logErr("fleet"));
    }, refreshSec * 1000);
    return () => clearInterval(id);
  }, [contexts, refreshSec]);

  if (contextsStatus === "loading" || contextsStatus === "idle") {
    return <LoadingLine t={t} label="Loading kubeconfig…" />;
  }

  if (contextsStatus === "error") {
    return (
      <div style={{ flex: 1 }}>
        <ErrorBlock
          t={t}
          message={contextsError ?? ""}
          kindLabel="kubeconfig"
        />
      </div>
    );
  }

  if (contexts.length === 0) {
    return (
      <EmptyState
        t={t}
        title="No contexts available"
        hint="Add a kubeconfig file or folder, or set up `~/.kube/config`."
        action={
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={() =>
              useAppStore.getState().openSettings({ section: "kubeconfig" })
            }
          >
            Open Kubeconfig settings
          </Btn>
        }
      />
    );
  }

  // Bucket by group; "Default" first, then alphabetical.
  const groups = new Map<string, ContextInfo[]>();
  for (const c of contexts) {
    const arr = groups.get(c.group) ?? [];
    arr.push(c);
    groups.set(c.group, arr);
  }
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    if (a === "Default") return -1;
    if (b === "Default") return 1;
    return a.localeCompare(b);
  });

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "32px 40px 48px" }}>
      <div
        style={{
          marginBottom: 28,
          display: "flex",
          alignItems: "flex-start",
          gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: FS_XL,
              fontWeight: 700,
              letterSpacing: -0.6,
              marginBottom: 4,
              color: t.text,
            }}
          >
            Cluster fleet
          </div>
          <div style={{ fontSize: FS_MD, color: t.textDim }}>
            Pick a context to connect, or {MOD_KEY}-click two or more to save
            them as a virtual context. {contexts.length} loaded across{" "}
            {orderedGroups.length} group{orderedGroups.length === 1 ? "" : "s"}.
          </div>
        </div>
        <ViewToggle mode={mode} />
      </div>

      {virtualContexts.length > 0 && (
        <VirtualContextSection
          mode={mode}
          virtualContexts={virtualContexts}
          contexts={contexts}
          probes={probes}
          view={fleetView}
          onOpen={(id) => selectVirtualContext(id)}
          onMenu={(pos, vctx) => setVctxMenu({ pos, vctx })}
        />
      )}

      {orderedGroups.map((g) => (
        <FleetGroup
          key={g}
          mode={mode}
          label={g}
          list={groups.get(g) ?? []}
          labels={labels}
          groupByProject={groupByProject}
          probes={probes}
          view={fleetView}
          picked={picked}
          onTogglePick={togglePick}
          onSelect={onSelect}
          onMenu={(pos, ctx) => setMenu({ pos, ctx })}
        />
      ))}

      {menu && (
        <ContextMenu
          mode={mode}
          position={menu.pos}
          onClose={() => setMenu(null)}
          rowName={primaryLabel(menu.ctx, labels)}
          items={fleetMenuItems(menu.ctx, onSelect, togglePick)}
        />
      )}

      {vctxMenu && (
        <ContextMenu
          mode={mode}
          position={vctxMenu.pos}
          onClose={() => setVctxMenu(null)}
          rowName={vctxMenu.vctx.name}
          items={[
            {
              kind: "item",
              label: "Open",
              onClick: () => selectVirtualContext(vctxMenu.vctx.id),
            },
            {
              kind: "item",
              label: "Edit name & members",
              onClick: () => {
                // Re-enter pick mode seeded with the saved definition;
                // Save in the floating bar then updates in place.
                setPicked(new Set(vctxMenu.vctx.members));
                setEditingVctx(vctxMenu.vctx.id);
                setVctxName(vctxMenu.vctx.name);
              },
            },
            { kind: "separator" },
            {
              kind: "item",
              label: "Delete virtual context",
              danger: true,
              onClick: async () => {
                const ok = await confirm({
                  title: `Delete virtual context "${vctxMenu.vctx.name}"?`,
                  body: "Only the saved grouping is removed — the member clusters and their kubeconfig entries are untouched.",
                  confirmLabel: "Delete",
                  tone: "danger",
                });
                if (!ok) return;
                deleteVirtualContext(vctxMenu.vctx.id);
                toast.ok(`Deleted virtual context ${vctxMenu.vctx.name}.`);
              },
            },
          ]}
        />
      )}

      {(picked.size > 0 || editingVctx !== null) && (
        <BulkBar
          mode={mode}
          count={picked.size}
          onClear={clearPick}
          actions={[
            ...(editingVctx === null && picked.size >= 2
              ? [
                  {
                    icon: Icons.cluster,
                    label: "Open",
                    onClick: onOpenTemporary,
                  },
                ]
              : []),
            {
              icon: Icons.layers,
              label: "Save",
              onClick: onSaveVctx,
            },
          ]}
        >
          <input
            value={vctxName}
            onChange={(e) => setVctxName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveVctx();
              if (e.key === "Escape") clearPick();
            }}
            placeholder={
              picked.size < 2 ? "Pick 2+ clusters…" : generatedName
            }
            aria-label="Virtual context name"
            style={{
              height: 28,
              padding: "0 10px",
              borderRadius: R_MD,
              border: `1px solid ${
                duplicateName && trimmedName.length > 0
                  ? t.bad
                  : "rgba(255,255,255,0.2)"
              }`,
              background: "rgba(255,255,255,0.08)",
              color: "#fff",
              fontSize: FS_MD,
              fontFamily: "inherit",
              outline: "none",
              width: 220,
            }}
          />
        </BulkBar>
      )}
    </div>
  );
}

// Build the right-click menu for a fleet card. Capabilities are gated by the
// context's source: the implicit default kubeconfig only allows context-level
// edits (set-current, delete-context); custom files & folder children also
// allow deleting the file itself. `source_path` carries the on-disk path —
// when it's missing we still allow context-level edits because the backend
// resolves the default kubeconfig path on its own.
function fleetMenuItems(
  c: ContextInfo,
  onSelect: (id: string) => void,
  onTogglePick: (id: string) => void,
): MenuItem[] {
  const isDefault = c.source_id === "default";
  const items: MenuItem[] = [
    {
      kind: "item",
      label: "Connect",
      onClick: () => onSelect(c.id),
    },
    {
      kind: "item",
      label: `Toggle in selection (${MOD_KEY}-click)`,
      onClick: () => onTogglePick(c.id),
    },
  ];
  if (isDefault) {
    items.push({
      kind: "item",
      label: c.is_current ? "Already current context" : "Set as current context",
      disabled: c.is_current,
      onClick: async () => {
        try {
          await api.setCurrentKubeconfigContext(c.id);
          toast.ok(`Set ${c.name} as current context.`);
        } catch (e: unknown) {
          toast.bad(`Could not set current: ${String(e)}`);
        }
      },
    });
  }
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Remove context from kubeconfig",
    danger: true,
    onClick: async () => {
      const ok = await confirm({
        title: "Remove context?",
        body: `This rewrites the kubeconfig file and removes "${c.name}". Comments and unrelated formatting in the file are not preserved.`,
        confirmLabel: "Remove",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await api.deleteKubeconfigContext(c.id);
        toast.ok(`Removed context ${c.name}.`);
      } catch (e: unknown) {
        toast.bad(`Could not remove context: ${String(e)}`);
      }
    },
  });
  if (!isDefault) {
    items.push({
      kind: "item",
      label: "Delete kubeconfig file",
      danger: true,
      onClick: async () => {
        const ok = await confirm({
          title: "Delete kubeconfig file?",
          body: `Permanently delete ${c.source_path ?? "this kubeconfig file"} from disk. Every context inside it will disappear from the fleet.`,
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api.deleteKubeconfigFile(c.id);
          toast.ok("Kubeconfig file deleted.");
        } catch (e: unknown) {
          toast.bad(`Could not delete file: ${String(e)}`);
        }
      },
    });
  }
  return items;
}

// Saved virtual contexts — rendered as a distinct section above the
// kubeconfig groups, following the same fleet-view style (tiles / mini /
// rows) as single-cluster cards. A card opens all members at once;
// right-click offers Edit (re-enters pick mode seeded) and Delete.
function VirtualContextSection({
  mode,
  virtualContexts,
  contexts,
  probes,
  view,
  onOpen,
  onMenu,
}: {
  mode: ThemeMode;
  virtualContexts: VirtualContext[];
  contexts: ContextInfo[];
  probes: Record<string, ClusterProbe>;
  view: FleetView;
  onOpen: (id: string) => void;
  onMenu: (pos: MenuPosition, vctx: VirtualContext) => void;
}) {
  const t = useResolvedTheme().tokens;
  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
      }}
    >
      <Eyebrow t={t}>Virtual contexts</Eyebrow>
      <div style={{ flex: 1, height: 1, background: t.border }} />
      <div
        style={{
          fontSize: FS_SM,
          color: t.textMuted,
          fontVariantNumeric: "tabular-nums",
          fontFamily: FF_MONO,
        }}
      >
        {virtualContexts.length}
      </div>
    </div>
  );

  if (view === "rows") {
    return (
      <div style={{ marginBottom: 28 }}>
        {header}
        <div
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: R_LG,
            background: t.surface,
            overflow: "hidden",
          }}
        >
          {virtualContexts.map((v, i) => (
            <VirtualContextRow
              key={v.id}
              mode={mode}
              vctx={v}
              contexts={contexts}
              probes={probes}
              isLast={i === virtualContexts.length - 1}
              onOpen={() => onOpen(v.id)}
              onMenu={(pos) => onMenu(pos, v)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 28 }}>
      {header}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: view === "mini" ? 8 : 12,
          alignItems: "stretch",
        }}
      >
        {virtualContexts.map((v) => (
          <VirtualContextCard
            key={v.id}
            mode={mode}
            vctx={v}
            contexts={contexts}
            probes={probes}
            view={view}
            onOpen={() => onOpen(v.id)}
            onMenu={(pos) => onMenu(pos, v)}
          />
        ))}
      </div>
    </div>
  );
}

// Per-member resolution shared by every virtual-context variant: chip data
// (name + stable color) plus the aggregated fleet numbers.
function resolveVctx(
  vctx: VirtualContext,
  contexts: ContextInfo[],
  probes: Record<string, ClusterProbe>,
): {
  resolved: { id: string; ctx: ContextInfo | null }[];
  colorIdx: Record<string, number>;
  agg: VirtualContextAggregate;
} {
  const colorIdx = clusterColorIndexMap(vctx.members);
  const resolved = vctx.members.map((id) => ({
    id,
    ctx: contexts.find((c) => c.id === id) ?? null,
  }));
  const known = new Set(contexts.map((c) => c.id));
  const agg = aggregateVirtualContext(vctx.members, known, probes);
  return { resolved, colorIdx, agg };
}

// Aggregated stat fragments for the summary line / row stats. Missing and
// unreachable members are called out by count — the chips carry the
// per-member detail.
function vctxStats(agg: VirtualContextAggregate): string[] {
  const bits: string[] = [];
  if (agg.nodes != null) bits.push(`${agg.nodes} nodes`);
  if (agg.pods != null) bits.push(`${agg.pods} pods`);
  if (agg.missing > 0) bits.push(`${agg.missing} missing`);
  if (agg.unreachable > 0) bits.push(`${agg.unreachable} unreachable`);
  return bits;
}

function vctxDotColor(t: Tokens, agg: VirtualContextAggregate): string {
  return agg.health === "bad"
    ? t.bad
    : agg.health === "good"
      ? t.good
      : t.unknown;
}

// One colored dot + name per member; missing members render struck-through
// in the bad color. `dotsOnly` drops the names for the Mini layout.
//
// Names go through the fleet's shortening pass — a virtual context over four
// GKE clusters is exactly where 50-character chips hurt most. The full
// context name stays in the chip's `title`.
function VctxMemberChips({
  resolved,
  colorIdx,
  dotsOnly,
}: {
  resolved: { id: string; ctx: ContextInfo | null }[];
  colorIdx: Record<string, number>;
  dotsOnly?: boolean;
}) {
  const t = useResolvedTheme().tokens;
  const labels = useClusterLabels();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: dotsOnly ? 4 : 8,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      {resolved.map((m) => (
        <span
          key={m.id}
          title={m.ctx ? m.ctx.name : `${m.id} (missing from kubeconfig)`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: FS_XS,
            fontFamily: FF_MONO,
            color: m.ctx ? t.textDim : t.bad,
            textDecoration: m.ctx ? undefined : "line-through",
            whiteSpace: "nowrap",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: clusterAccent(colorIdx[m.id] ?? 0),
              flexShrink: 0,
              outline: m.ctx ? undefined : `1px solid ${t.bad}`,
            }}
          />
          {!dotsOnly && labelFor(labels, m.id, m.ctx?.name ?? m.id).short}
        </span>
      ))}
    </span>
  );
}

// Tile + Mini variants. Tiles mirror FleetCard's anatomy — aggregated
// CPU/Mem gauges, title row, mono summary line — plus the member chips.
// Mini drops gauges and stats and shows just dot + name + member dots.
function VirtualContextCard({
  mode,
  vctx,
  contexts,
  probes,
  view,
  onOpen,
  onMenu,
}: {
  mode: ThemeMode;
  vctx: VirtualContext;
  contexts: ContextInfo[];
  probes: Record<string, ClusterProbe>;
  view: "tiles" | "mini";
  onOpen: () => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = useResolvedTheme().tokens;
  const { resolved, colorIdx, agg } = resolveVctx(vctx, contexts, probes);
  const dotColor = vctxDotColor(t, agg);

  const buttonBase: React.CSSProperties = {
    border: `1px solid ${t.border}`,
    borderRadius: R_LG,
    background: t.surface,
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
    color: "inherit",
    transition: "border-color .15s, background .15s",
  };
  const hoverHandlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.borderColor = t.accent;
      e.currentTarget.style.background = t.accentSoft;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.borderColor = t.border;
      e.currentTarget.style.background = t.surface;
    },
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onMenu({ x: e.clientX, y: e.clientY });
  };

  if (view === "mini") {
    return (
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={onContextMenu}
        style={{
          ...buttonBase,
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 180,
          maxWidth: 420,
          flex: "0 1 auto",
        }}
        {...hoverHandlers}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: FS_MD,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: t.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {vctx.name}
        </span>
        <VctxMemberChips resolved={resolved} colorIdx={colorIdx} dotsOnly />
        <span
          style={{
            marginLeft: "auto",
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.textMuted,
            flexShrink: 0,
            paddingLeft: 8,
          }}
        >
          {vctx.members.length} clusters
        </span>
      </button>
    );
  }

  const colorFor = (r: number) =>
    r > 0.8 ? t.bad : r > 0.65 ? t.warn : t.good;
  const stats = vctxStats(agg);

  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={onContextMenu}
      style={{
        ...buttonBase,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        minWidth: 300,
        maxWidth: 560,
        flex: "0 1 auto",
      }}
      {...hoverHandlers}
    >
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <GaugeWithLabel
          mode={mode}
          ratio={agg.cpuRatio}
          color={agg.cpuRatio != null ? colorFor(agg.cpuRatio) : t.unknown}
          label="cpu"
        />
        <GaugeWithLabel
          mode={mode}
          ratio={agg.memRatio}
          color={agg.memRatio != null ? colorFor(agg.memRatio) : t.unknown}
          label="mem"
        />
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: dotColor,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: FS_LG,
              fontWeight: 600,
              letterSpacing: -0.3,
              color: t.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {vctx.name}
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: FF_MONO,
              fontSize: FS_XS,
              color: t.textMuted,
              flexShrink: 0,
              paddingLeft: 8,
            }}
          >
            {vctx.members.length} clusters
          </span>
        </div>
        <div
          style={{
            fontSize: FS_SM,
            color: t.textMuted,
            fontVariantNumeric: "tabular-nums",
            fontFamily: FF_MONO,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {stats.length > 0 ? stats.join(" · ") : "probing…"}
        </div>
        <VctxMemberChips resolved={resolved} colorIdx={colorIdx} />
      </div>
    </button>
  );
}

// Row variant: one line per virtual context inside the bordered list, same
// anatomy as FleetRow — dot, name, member chips, right-aligned mono stats.
function VirtualContextRow({
  vctx,
  contexts,
  probes,
  isLast,
  onOpen,
  onMenu,
}: {
  mode: ThemeMode;
  vctx: VirtualContext;
  contexts: ContextInfo[];
  probes: Record<string, ClusterProbe>;
  isLast: boolean;
  onOpen: () => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = useResolvedTheme().tokens;
  const { resolved, colorIdx, agg } = resolveVctx(vctx, contexts, probes);
  const dotColor = vctxDotColor(t, agg);
  const stats = [`${vctx.members.length} clusters`, ...vctxStats(agg)];

  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        border: "none",
        borderBottom: isLast ? "none" : `1px solid ${t.border}`,
        background: "transparent",
        padding: "8px 14px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "background .12s",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
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
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            fontSize: FS_MD,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: t.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {vctx.name}
        </span>
        <VctxMemberChips resolved={resolved} colorIdx={colorIdx} />
      </div>
      <div
        style={{
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          color: t.textMuted,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}
      >
        {stats.join(" · ")}
      </div>
    </button>
  );
}

// One bucket of a kubeconfig group, split out by the cloud coordinate the
// short names were stripped of (GKE project + location, EKS account +
// region, AKS resource group, DO region). `key === null` is the remainder:
// contexts with no coordinate to group by, plus buckets of one — a header
// over a single row is noise, not structure.
type ProjectBucket = {
  key: string | null;
  label: string | null;
  list: ContextInfo[];
};

// Pure: bucket a kubeconfig group's contexts by `ClusterLabel.groupKey`.
// Preserves the incoming order inside each bucket, puts the ungrouped
// remainder first, then buckets alphabetically by header so the layout
// doesn't reshuffle when a probe lands.
export function bucketByProject(
  list: ContextInfo[],
  labels: Record<string, ClusterLabel>,
  enabled: boolean,
): ProjectBucket[] {
  if (!enabled) return [{ key: null, label: null, list }];

  const counts = new Map<string, number>();
  for (const c of list) {
    const key = labels[c.id]?.groupKey;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const loose: ContextInfo[] = [];
  const buckets = new Map<string, { label: string; list: ContextInfo[] }>();
  for (const c of list) {
    const l = labels[c.id];
    const key = l?.groupKey;
    if (!key || !l?.groupLabel || (counts.get(key) ?? 0) < 2) {
      loose.push(c);
      continue;
    }
    const bucket = buckets.get(key) ?? { label: l.groupLabel, list: [] };
    bucket.list.push(c);
    buckets.set(key, bucket);
  }

  const out: ProjectBucket[] = [];
  if (loose.length > 0) out.push({ key: null, label: null, list: loose });
  for (const [key, bucket] of [...buckets].sort((a, b) =>
    a[1].label.localeCompare(b[1].label),
  )) {
    out.push({ key, label: bucket.label, list: bucket.list });
  }
  return out;
}

function FleetGroup({
  mode,
  label,
  list,
  labels,
  groupByProject,
  probes,
  view,
  picked,
  onTogglePick,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  label: string;
  list: ContextInfo[];
  labels: Record<string, ClusterLabel>;
  groupByProject: boolean;
  probes: Record<string, ClusterProbe>;
  view: FleetView;
  picked: Set<string>;
  onTogglePick: (id: string) => void;
  onSelect: (id: string) => void;
  onMenu: (pos: MenuPosition, ctx: ContextInfo) => void;
}) {
  const t = useResolvedTheme().tokens;
  const anyPicked = picked.size > 0;
  // ⌘/Ctrl-click toggles multi-select; plain click connects.
  const cardClick = (c: ContextInfo) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) onTogglePick(c.id);
    else onSelect(c.id);
  };
  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
      }}
    >
      <Eyebrow t={t}>{label}</Eyebrow>
      <div style={{ flex: 1, height: 1, background: t.border }} />
      <div
        style={{
          fontSize: FS_SM,
          color: t.textMuted,
          fontVariantNumeric: "tabular-nums",
          fontFamily: FF_MONO,
        }}
      >
        {list.length}
      </div>
    </div>
  );

  const buckets = bucketByProject(list, labels, groupByProject);
  // A bucket's header already carries the coordinate, so repeating it on
  // every row inside would be pure noise.
  const showQualifier = (b: ProjectBucket) => b.label === null;

  // Sub-header for one project bucket. `inset` is the Rows variant, which
  // lives inside the bordered container and so needs its own padding and a
  // separating rule rather than card-grid margins.
  const subHeader = (b: ProjectBucket, inset: boolean) =>
    b.label && (
      <div
        data-testid="fleet-project-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: inset ? "6px 14px" : undefined,
          marginBottom: inset ? undefined : 8,
          marginTop: inset ? undefined : 4,
          background: inset ? t.chip : undefined,
          borderBottom: inset ? `1px solid ${t.border}` : undefined,
        }}
      >
        <span
          style={{
            fontSize: FS_XS,
            fontFamily: FF_MONO,
            fontWeight: 600,
            color: t.textMuted,
            letterSpacing: 0.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {b.label}
        </span>
        <div style={{ flex: 1, height: 1, background: t.borderSoft }} />
        <span
          style={{
            fontSize: FS_XS,
            color: t.textMuted,
            fontVariantNumeric: "tabular-nums",
            fontFamily: FF_MONO,
            flexShrink: 0,
          }}
        >
          {b.list.length}
        </span>
      </div>
    );

  if (view === "rows") {
    return (
      <div style={{ marginBottom: 28 }}>
        {header}
        <div
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: R_LG,
            background: t.surface,
            overflow: "hidden",
          }}
        >
          {buckets.map((b, bi) => (
            <div key={b.key ?? "__ungrouped"}>
              {subHeader(b, true)}
              {b.list.map((c, i) => (
                <FleetRow
                  key={c.id}
                  mode={mode}
                  context={c}
                  labels={labels}
                  showQualifier={showQualifier(b)}
                  probe={probes[c.id] ?? null}
                  isLast={
                    bi === buckets.length - 1 && i === b.list.length - 1
                  }
                  picked={picked.has(c.id)}
                  showPick={anyPicked}
                  onTogglePick={() => onTogglePick(c.id)}
                  onSelect={cardClick(c)}
                  onMenu={(pos) => onMenu(pos, c)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Tile / mini grid: each card declares the horizontal room it wants
  // (flex-basis). flex-shrink 0 wraps to the next row instead of squeezing
  // names; flex-grow 1 fills the trailing slack on each row.
  const basisFn = view === "mini" ? miniBasisPx : cardBasisPx;
  return (
    <div style={{ marginBottom: 28 }}>
      {header}
      {buckets.map((b) => (
        <div key={b.key ?? "__ungrouped"}>
          {subHeader(b, false)}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: view === "mini" ? 8 : 12,
              alignItems: "stretch",
              marginBottom: b.label ? 14 : 0,
            }}
          >
            {b.list.map((c) => {
              const title = primaryLabel(c, labels);
              const sub = showQualifier(b) ? secondaryLabel(c, labels) : null;
              const visibleLen = title.length + (sub ? sub.length + 3 : 0);
              return (
                <div
                  key={c.id}
                  style={{
                    flex: `1 0 ${basisFn(title, sub)}px`,
                    minWidth: 0,
                    maxWidth: "100%",
                  }}
                >
                  {view === "mini" ? (
                    <MiniCard
                      mode={mode}
                      context={c}
                      labels={labels}
                      showQualifier={showQualifier(b)}
                      probe={probes[c.id] ?? null}
                      picked={picked.has(c.id)}
                      showPick={anyPicked}
                      onTogglePick={() => onTogglePick(c.id)}
                      onSelect={cardClick(c)}
                      onMenu={(pos) => onMenu(pos, c)}
                    />
                  ) : (
                    <FleetCard
                      mode={mode}
                      context={c}
                      labels={labels}
                      showQualifier={showQualifier(b)}
                      probe={probes[c.id] ?? null}
                      wide={visibleLen > 36}
                      picked={picked.has(c.id)}
                      showPick={anyPicked}
                      onTogglePick={() => onTogglePick(c.id)}
                      onSelect={cardClick(c)}
                      onMenu={(pos) => onMenu(pos, c)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function FleetCard({
  mode,
  context,
  labels,
  showQualifier,
  probe,
  wide,
  picked,
  showPick,
  onTogglePick,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  context: ContextInfo;
  labels: Record<string, ClusterLabel>;
  /// False when the card sits under a project sub-header that already shows
  /// the coordinate; repeating it on the card would be noise.
  showQualifier: boolean;
  probe: ClusterProbe | null;
  wide: boolean;
  picked: boolean;
  showPick: boolean;
  onTogglePick: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = useResolvedTheme().tokens;
  const sub = showQualifier ? secondaryLabel(context, labels) : null;
  const density = useAppStore((s) => s.settings.density);
  const cardPad =
    density === "compact" ? 9 : density === "spacious" ? 18 : 14;
  const cardGap =
    density === "compact" ? 10 : density === "spacious" ? 18 : 14;

  const cpuRatio =
    probe &&
    probe.cpu_used_milli != null &&
    probe.cpu_capacity_milli != null &&
    probe.cpu_capacity_milli > 0
      ? probe.cpu_used_milli / probe.cpu_capacity_milli
      : null;
  const memRatio =
    probe &&
    probe.mem_used_mib != null &&
    probe.mem_capacity_mib != null &&
    probe.mem_capacity_mib > 0
      ? probe.mem_used_mib / probe.mem_capacity_mib
      : null;
  const colorFor = (r: number) => (r > 0.8 ? t.bad : r > 0.65 ? t.warn : t.good);

  // Status dot logic: green when last probe was healthy, red when it
  // explicitly failed, neutral grey when we have no data yet.
  const dotColor =
    probe?.healthy === true
      ? t.good
      : probe?.healthy === false
        ? t.bad
        : t.unknown;

  const card = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        border: `1px solid ${picked ? t.accent : t.border}`,
        borderRadius: R_LG,
        background: picked ? t.accentSoft : t.surface,
        padding: cardPad,
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "border-color .15s, background .15s",
        display: "flex",
        alignItems: "center",
        gap: cardGap,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = t.accent;
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = picked ? t.accent : t.border;
        e.currentTarget.style.background = picked ? t.accentSoft : t.surface;
      }}
    >
      {showPick && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onTogglePick();
          }}
          style={{ display: "inline-flex", flexShrink: 0 }}
        >
          <Checkbox t={t} checked={picked} />
        </span>
      )}
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <GaugeWithLabel
          mode={mode}
          ratio={cpuRatio}
          color={cpuRatio != null ? colorFor(cpuRatio) : t.unknown}
          label="cpu"
        />
        <GaugeWithLabel
          mode={mode}
          ratio={memRatio}
          color={memRatio != null ? colorFor(memRatio) : t.unknown}
          label="mem"
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 3,
            flexWrap: wide ? "wrap" : "nowrap",
          }}
        >
          <div
            style={{
              fontSize: FS_LG,
              fontWeight: 600,
              letterSpacing: -0.3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: t.text,
              minWidth: 0,
              flex: wide ? "0 1 auto" : "1 1 auto",
              maxWidth: "100%",
            }}
          >
            {primaryLabel(context, labels)}
            {sub && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: FS_SM,
                  fontWeight: 500,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                  letterSpacing: 0,
                }}
              >
                · {sub}
              </span>
            )}
          </div>
          <Tooltip
            label={
              probe?.healthy === true
                ? "Reachable"
                : probe?.healthy === false
                  ? probe.last_error
                    ? `Unreachable — ${probe.last_error}`
                    : "Unreachable"
                  : "Not yet probed"
            }
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: dotColor,
                flexShrink: 0,
              }}
            />
          </Tooltip>
          {context.is_current && (
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_XS,
                color: t.accent,
                background: t.accentSoft,
                padding: "1px 6px",
                borderRadius: R_SM,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                flexShrink: 0,
              }}
            >
              current
            </span>
          )}
          {probe?.server_version && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: FF_MONO,
                fontSize: FS_XS,
                color: t.textMuted,
                flexShrink: 0,
                paddingLeft: 8,
              }}
            >
              {probe.server_version}
              {context.namespace ? ` · ns:${context.namespace}` : ""}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: FS_SM,
            color: t.textMuted,
            fontVariantNumeric: "tabular-nums",
            fontFamily: FF_MONO,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summaryLine(probe, context, labels)}
        </div>
      </div>
    </button>
  );
  return probe?.last_error ? (
    <Tooltip label={probe.last_error}>{card}</Tooltip>
  ) : (
    card
  );
}

// Mirrors `prefs::FleetView`. The fleet landing is the only place that
// reads it; pulled into a local alias to keep dispatch readable.
type FleetView = "tiles" | "mini" | "rows";

// Pick the flex-basis (in px) for a card based on its title length.
// This is the minimum horizontal room the card wants before it wraps to
// the next row; flex-grow then fills the trailing slack on each row.
//
// Estimate = chrome (gauges + paddings + status dot + version chip +
// optional "current" badge) + width of the visible title. The title is
// the context name plus, when present, " · cluster-name" rendered in a
// smaller mono font — counted separately because both must remain
// readable without ellipsis.
function cardBasisPx(primary: string, secondary: string | null): number {
  const chrome = 240;
  const primaryPx = primary.length * 8.2; // 14px / 600 / -0.3 letter-spacing
  const secondaryPx = secondary ? (secondary.length + 3) * 7 : 0; // 11.5px mono + " · "
  const want = chrome + primaryPx + secondaryPx;
  return Math.min(880, Math.max(280, Math.round(want)));
}

// Same idea as `cardBasisPx` for the Mini layout: no gauges, no summary
// line, smaller chrome — so cards pack denser.
function miniBasisPx(primary: string, secondary: string | null): number {
  const chrome = 110; // dot + paddings + version chip
  const primaryPx = primary.length * 7.5; // 13px / 600
  const secondaryPx = secondary ? (secondary.length + 3) * 6.6 : 0; // 11px mono + " · "
  const want = chrome + primaryPx + secondaryPx;
  return Math.min(560, Math.max(180, Math.round(want)));
}

// Title for the card. We prefer the context name (k8s convention — what
// `kubectl use-context` switches between, unique within a kubeconfig),
// shortened to the cluster segment when the name is one of the
// machine-generated shapes `lib/clusterName` recognises.
function primaryLabel(
  c: ContextInfo,
  labels: Record<string, ClusterLabel>,
): string {
  return labelFor(labels, c.id, c.name || c.cluster).short;
}

// The dim text next to the title. When shortening stripped a cloud
// coordinate (GKE project + location, EKS account + region, …) that's what
// we surface, so the card still says which project a `prod-6` lives in.
//
// Otherwise we fall back to the kubeconfig cluster name when it adds
// information beyond the context name. We only dedup on a literal
// case-insensitive match — the `user@` prefix variant (`admin@prod-cluster`
// vs `prod-cluster`) still surfaces the cluster, since the operator wants
// both the identity and the underlying cluster visible on the card.
function secondaryLabel(
  c: ContextInfo,
  labels: Record<string, ClusterLabel>,
): string | null {
  const qualifier = labels[c.id]?.qualifier;
  if (qualifier) return qualifier;
  const cluster = c.cluster?.trim();
  if (!cluster) return null;
  const ctx = c.name.trim();
  if (ctx.toLowerCase() === cluster.toLowerCase()) return null;
  return cluster;
}

function summaryLine(
  probe: ClusterProbe | null,
  context: ContextInfo,
  labels: Record<string, ClusterLabel>,
): string {
  if (!probe) {
    return secondaryLabel(context, labels) ? "" : context.cluster;
  }
  const bits: string[] = [];
  if (probe.nodes != null) bits.push(`${probe.nodes} nodes`);
  if (probe.pods != null) bits.push(`${probe.pods} pods`);
  if (bits.length === 0) {
    if (probe.healthy === false) return "unreachable";
    return "probing…";
  }
  return bits.join(" · ");
}

function GaugeWithLabel({
  
  ratio,
  color,
  label,
}: {
  mode: ThemeMode;
  ratio: number | null;
  color: string;
  label: string;
}) {
  const t = useResolvedTheme().tokens;
  const pct = ratio != null ? Math.round(Math.max(0, Math.min(1, ratio)) * 100) : null;
  return (
    <div
      style={{
        position: "relative",
        width: 42,
        height: 42,
        flexShrink: 0,
      }}
    >
      <Gauge
        value={ratio ?? 0}
        size={42}
        thickness={4}
        color={ratio == null ? t.borderSoft : color}
        track={t.borderSoft}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontSize: FS_XS,
          fontWeight: 600,
          fontFamily: FF_MONO,
          fontVariantNumeric: "tabular-nums",
          color: t.text,
          letterSpacing: -0.2,
          lineHeight: 1.05,
        }}
      >
        <div style={{ fontSize: FS_SM }}>
          {pct == null ? "—" : pct}
          {pct != null && (
            <span style={{ fontSize: FS_XS, opacity: 0.7 }}>%</span>
          )}
        </div>
        <div
          style={{
            fontSize: FS_XS,
            opacity: 0.55,
            fontWeight: 500,
            marginTop: 1,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

// Compact tile: status dot + name (+ secondary cluster name) + version. No
// gauges, no summary line. Used when the operator wants to scan a large
// fleet without per-card load info.
function MiniCard({

  context,
  labels,
  showQualifier,
  probe,
  picked,
  showPick,
  onTogglePick,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  context: ContextInfo;
  labels: Record<string, ClusterLabel>;
  showQualifier: boolean;
  probe: ClusterProbe | null;
  picked: boolean;
  showPick: boolean;
  onTogglePick: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = useResolvedTheme().tokens;
  const dotColor =
    probe?.healthy === true
      ? t.good
      : probe?.healthy === false
        ? t.bad
        : t.unknown;
  const sub = showQualifier ? secondaryLabel(context, labels) : null;

  const card = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        height: "100%",
        border: `1px solid ${picked ? t.accent : t.border}`,
        borderRadius: R_LG,
        background: picked ? t.accentSoft : t.surface,
        padding: "8px 10px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "border-color .15s, background .15s",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = t.accent;
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = picked ? t.accent : t.border;
        e.currentTarget.style.background = picked ? t.accentSoft : t.surface;
      }}
    >
      {showPick && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onTogglePick();
          }}
          style={{ display: "inline-flex", flexShrink: 0 }}
        >
          <Checkbox t={t} checked={picked} />
        </span>
      )}
      <Tooltip
        label={
          probe?.healthy === true
            ? "Reachable"
            : probe?.healthy === false
              ? probe.last_error
                ? `Unreachable — ${probe.last_error}`
                : "Unreachable"
              : "Not yet probed"
        }
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: FS_MD,
          fontWeight: 600,
          letterSpacing: -0.2,
          color: t.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {primaryLabel(context, labels)}
        {sub && (
          <span
            style={{
              marginLeft: 6,
              fontSize: FS_SM,
              fontWeight: 500,
              color: t.textMuted,
              fontFamily: FF_MONO,
              letterSpacing: 0,
            }}
          >
            · {sub}
          </span>
        )}
      </div>
      {context.is_current && (
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.accent,
            background: t.accentSoft,
            padding: "1px 5px",
            borderRadius: R_SM,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            flexShrink: 0,
          }}
        >
          current
        </span>
      )}
      {probe?.server_version && (
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.textMuted,
            flexShrink: 0,
          }}
        >
          {probe.server_version}
        </span>
      )}
    </button>
  );
  return probe?.last_error ? (
    <Tooltip label={probe.last_error}>{card}</Tooltip>
  ) : (
    card
  );
}

// Row layout: a single line per cluster, joined into a bordered list. No
// gauges, no card frame — meant for operators with dozens of clusters who
// want to scan top-to-bottom.
function FleetRow({

  context,
  labels,
  showQualifier,
  probe,
  isLast,
  picked,
  showPick,
  onTogglePick,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  context: ContextInfo;
  labels: Record<string, ClusterLabel>;
  showQualifier: boolean;
  probe: ClusterProbe | null;
  isLast: boolean;
  picked: boolean;
  showPick: boolean;
  onTogglePick: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = useResolvedTheme().tokens;
  const dotColor =
    probe?.healthy === true
      ? t.good
      : probe?.healthy === false
        ? t.bad
        : t.unknown;
  const sub = showQualifier ? secondaryLabel(context, labels) : null;

  const stats: string[] = [];
  if (probe?.nodes != null) stats.push(`${probe.nodes} nodes`);
  if (probe?.pods != null) stats.push(`${probe.pods} pods`);
  if (context.namespace) stats.push(`ns:${context.namespace}`);

  const row = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        border: "none",
        borderBottom: isLast ? "none" : `1px solid ${t.border}`,
        background: picked ? t.accentSoft : "transparent",
        padding: "8px 14px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "background .12s",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = picked ? t.accentSoft : "transparent";
      }}
    >
      {showPick && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onTogglePick();
          }}
          style={{ display: "inline-flex", flexShrink: 0 }}
        >
          <Checkbox t={t} checked={picked} />
        </span>
      )}
      <Tooltip
        label={
          probe?.healthy === true
            ? "Reachable"
            : probe?.healthy === false
              ? probe.last_error
                ? `Unreachable — ${probe.last_error}`
                : "Unreachable"
              : "Not yet probed"
        }
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            fontSize: FS_MD,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: t.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {primaryLabel(context, labels)}
        </span>
        {sub && (
          <span
            style={{
              fontSize: FS_SM,
              fontWeight: 500,
              color: t.textMuted,
              fontFamily: FF_MONO,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              flexShrink: 2,
            }}
          >
            · {sub}
          </span>
        )}
        {context.is_current && (
          <span
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_XS,
              color: t.accent,
              background: t.accentSoft,
              padding: "1px 5px",
              borderRadius: R_SM,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              flexShrink: 0,
            }}
          >
            current
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          color: t.textMuted,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
          display: "flex",
          gap: 12,
          alignItems: "baseline",
        }}
      >
        {stats.length > 0 && <span>{stats.join(" · ")}</span>}
        {probe?.server_version && <span>{probe.server_version}</span>}
      </div>
    </button>
  );
  return probe?.last_error ? (
    <Tooltip label={probe.last_error}>{row}</Tooltip>
  ) : (
    row
  );
}

// Three-button segmented control for the page-level fleet-view toggle.
// Persists through `patchSettings({ fleetView })` → `prefs.json`.
function ViewToggle({}: { mode: ThemeMode }) {
  const t = useResolvedTheme().tokens;
  const value = useAppStore((s) => s.settings.fleetView);
  const patch = useAppStore((s) => s.patchSettings);
  const options: { id: FleetView; label: string }[] = [
    { id: "tiles", label: "Tiles" },
    { id: "mini", label: "Mini" },
    { id: "rows", label: "Rows" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Fleet view"
      style={{
        display: "inline-flex",
        border: `1px solid ${t.border}`,
        borderRadius: R_LG,
        padding: 2,
        background: t.surface,
        flexShrink: 0,
      }}
    >
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => patch({ fleetView: o.id })}
            style={{
              border: "none",
              background: selected ? t.accentSoft : "transparent",
              color: selected ? t.accent : t.textMuted,
              fontFamily: "inherit",
              fontSize: FS_SM,
              fontWeight: 600,
              letterSpacing: 0.2,
              padding: "5px 12px",
              borderRadius: R_MD,
              cursor: "pointer",
              transition: "background .12s, color .12s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
