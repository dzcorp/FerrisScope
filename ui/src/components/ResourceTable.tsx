import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef as TanColumnDef,
  type SortingState,
  type ColumnSizingState,
  type Row as TanRow,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, onResourceDelta } from "../api";
import { useAppStore, useResolvedTheme } from "../store";
import { formatQuantity } from "./detail";
import type { ColumnDef, ResourceDelta, ResourceKind, ResourceRow } from "../types";
import { tokens, FF_MONO, FONT_MONO, type ThemeMode, FS_MD, FS_SM, FS_XS } from "../theme";
import { LogPanel } from "./LogPanel";
import { DetailPanel, type DetailTarget } from "./DetailPanel";
import { ContextMenu, type MenuPosition } from "./ContextMenu";
import { actionsForRow } from "./rowActions";
import { makeTerminalTab } from "./Dock";
import { confirm, toast } from "../lib/dialog";
import { latinLetter } from "../lib/keyboard";
import { parseTableFilter } from "../lib/tableFilter";
import { useMetricsSubscription } from "../lib/useMetricsSubscription";
import {
  Checkbox,
  ContainerDots,
  ErrorBlock,
  Icons,
  LoadingLine,
  StatusPill,
  EmptyState,
} from "./ui";
import type { ContainerLite } from "./ui";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

// Row height now flows from the active theme's `sizing.rowHeights[density]`,
// so a theme can shift the whole curve (e.g. Readable's spacious is taller
// than Default's). The density preference still picks which row of the
// curve to use.
const SELECT_COL_ID = "__select__";
const SELECT_COL_WIDTH = 40;
const RESIZE_HANDLE_WIDTH = 6;

// "Now" flows through context so only components that *subscribe* (the
// age cell) re-render on each 1 Hz tick. The table, rows, and other
// cells are unaffected. This is what lets us keep "1s → 2s → 3s" live
// updates without re-rendering 30+ rows × 10 cells per second.
const NowContext = createContext<number>(Date.now());

// Module-level style objects. Inline-style allocation per render was a
// big share of scroll cost on large tables (30 rows × 10 cells = 300
// fresh objects per render). Stable references let React skip prop
// diffing entirely.
//
// Font size and family use the theme-published CSS custom properties
// (App.tsx publishes them on `:root`) so cells follow the active theme
// without busting referential equality on every theme change.
const TABLE_FS_CELL = "var(--fs-fs-sm, 11.5px)";
const AGE_CELL_STYLE: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  fontFamily: FF_MONO,
  fontSize: TABLE_FS_CELL,
};
const NUM_CELL_BASE: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  fontFamily: FF_MONO,
  fontSize: TABLE_FS_CELL,
};
const PHASE_WRAP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const AgeCell = memo(function AgeCell({
  value,
  color,
}: {
  value: unknown;
  color: string;
}) {
  const now = useContext(NowContext);
  return (
    <span style={{ ...AGE_CELL_STYLE, color }}>{formatAge(value, now)}</span>
  );
});

// Owns the `now` state and feeds it to descendants via context. Only
// AgeCell subscribers re-render on each tick — table, rows, and other
// cells are unaffected. 1 Hz so the seconds bucket displays "live"
// (1s → 2s → 3s); the cost is bounded to AgeCell instances, not the
// rest of the table.
const NOW_TICK_MS = 1000;
function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(tick);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

type Props = {
  mode: ThemeMode;
  clusterId: string;
  kind: ResourceKind;
};

// Resource table — the page is the data (P1). No skeleton on poll, no
// spinner on re-fetch (R-01). Identifiers in mono (R-07), numbers tabular
// (R-06), header labels uppercase mono.
export function ResourceTable({ mode, clusterId, kind }: Props) {
  const t = useResolvedTheme().tokens;
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // Filter is driven by the global palette (Cmd+F / `/` / breadcrumb icon).
  // Lifted to the store so the AppHeader can render the active-filter chip
  // and so the palette in filter mode can edit it live without prop drilling.
  const tableFilter = useAppStore((s) => s.tableFilter);
  const setTableCount = useAppStore((s) => s.setTableCount);
  const [logTarget, setLogTarget] = useState<ResourceRow | null>(null);
  const [logDefaultContainer, setLogDefaultContainer] = useState<string | null>(
    null,
  );
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [menu, setMenu] = useState<{
    pos: MenuPosition;
    row: ResourceRow;
  } | null>(null);

  // Namespace filter is global (cluster-bar driven, persisted on the store).
  const selectedNamespaces = useAppStore((s) => s.selectedNamespaces);
  // Per-table multi-select lives on the store too so the bulk-action bar can
  // be rendered at App level.
  const selection = useAppStore((s) => s.selection);
  const toggleSelection = useAppStore((s) => s.toggleSelection);
  const setSelection = useAppStore((s) => s.setSelection);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const pendingDetail = useAppStore((s) => s.pendingDetail);
  const consumePendingDetail = useAppStore((s) => s.consumePendingDetail);
  const navigateToDetail = useAppStore((s) => s.navigateToDetail);
  const setSelectedNamespaces = useAppStore((s) => s.setSelectedNamespaces);
  const pushDetailEntry = useAppStore((s) => s.pushDetailEntry);
  const closeDetail = useAppStore((s) => s.closeDetail);
  const kinds = useAppStore((s) => s.kinds);
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);
  const density = useAppStore((s) => s.settings.density);
  const monoTables = useAppStore((s) => s.settings.monoTables);
  const resolved = useResolvedTheme();
  const ROW_HEIGHT = resolved.sizing.rowHeights[density];
  const addDockTab = useAppStore((s) => s.addDockTab);
  const contextLabel = useAppStore(
    (s) => s.contexts.find((c) => c.id === s.selectedContext)?.name ?? null,
  );

  // Persisted (sort, column widths) per (cluster, kind). Hydrated at App
  // startup; the table writes back through `setTableView` which both updates
  // the store and the on-disk JSON file.
  const persistedView = useAppStore(
    (s) => s.tableViews[`${clusterId}::${kind.id}`] ?? null,
  );
  const setTableView = useAppStore((s) => s.setTableView);

  const isPods = kind.id === "pods";

  // Pull cluster metrics only while the operator is on a kind that displays
  // CPU/Mem (today: Pods). The hook no-ops if `clusterId` is null; we pass
  // null for non-Pod kinds so we don't pay for metrics-server polling +
  // kubelet stats fan-out when browsing ConfigMaps, Deployments, etc. The
  // subscription is refcounted server-side so concurrent consumers (cluster
  // bar gauges, MetricsTab) share one polling task.
  useMetricsSubscription(isPods ? clusterId : null);

  const rowsRef = useRef<Map<string, ResourceRow>>(new Map());

  // Per-subscription namespace lists. Each entry becomes one backend
  // subscribe call → one `Api::namespaced(ns)` watcher → one event
  // channel. The frontend merges the per-watcher snapshots into a single
  // row map, so the operator sees the union without paying the cross-NS
  // `Api::all` cost on the apiserver.
  //
  // | Selected set       | `subscribeScopes`            |
  // |--------------------|------------------------------|
  // | cluster-scoped     | `[null]` (always All)        |
  // | empty (All NS)     | `[null]`                     |
  // | one namespace      | `[["foo"]]`                  |
  // | multi-select 2+    | `[["foo"], ["bar"], ["baz"]]`|
  //
  // Each scope is independently lingered by the backend, so flipping
  // {foo} → {foo, bar} only pays a fresh LIST for bar — foo's watcher
  // is reused. Flipping back to {foo} drops bar after its 60 s linger.
  const subscribeScopes: (string[] | null)[] = useMemo(() => {
    if (!kind.namespaced) return [null];
    const sel = Array.from(selectedNamespaces).sort();
    if (sel.length === 0) return [null];
    return sel.map((ns) => [ns]);
  }, [kind.namespaced, selectedNamespaces]);
  // Stable key for the subscribe effect's dep array. Re-runs the effect
  // when the operator changes scope (cardinality or set membership) so
  // we tear down + open the right backend slots.
  const subscribeScopeKey = useMemo(() => {
    return subscribeScopes
      .map((s) => (s == null ? "all" : `ns:${s[0]}`))
      .join("|");
  }, [subscribeScopes]);

  useEffect(() => {
    let cancelled = false;
    // One unlisten per per-namespace listener (one entry for single-NS /
    // cluster / All; N entries for multi-select). Cleared in the cleanup.
    const unlistens: Array<() => void> = [];
    // Per-effect map. The listener closures capture THIS map, not the shared
    // `rowsRef`, so a leaked listener from a prior kind/cluster can never
    // pollute the next kind's row set. (The shared ref is still updated for
    // detail/exec lookups, but only by the active effect.)
    const localMap = new Map<string, ResourceRow>();
    rowsRef.current = localMap;
    setLoad({ kind: "loading" });
    setRows([]);
    setLogTarget(null);
    setDetailTarget(null);
    setMenu(null);

    // Coalesce delta-driven setRows into one render per animation frame.
    // Without this, a 5000-row InitApply burst triggers 5000 array
    // allocations + re-renders; the rAF gate collapses it to ~one render
    // per paint regardless of how fast deltas arrive.
    let rafHandle: number | null = null;
    const flushRows = () => {
      rafHandle = null;
      if (cancelled || rowsRef.current !== localMap) return;
      setRows(Array.from(localMap.values()));
    };
    const scheduleFlush = () => {
      if (rafHandle != null) return;
      rafHandle = requestAnimationFrame(flushRows);
    };

    const onDelta = (delta: ResourceDelta) => {
      // Belt: closure-captured `cancelled` neutralises a listener whose
      // effect has been torn down. Suspenders: the rowsRef identity check
      // guards the case where a stale listener somehow outlives both
      // cleanup and the next mount.
      if (cancelled) return;
      if (rowsRef.current !== localMap) return;
      if (delta.kind === "upsert") {
        localMap.set(delta.row.uid, delta.row);
        scheduleFlush();
        // First row counts as visual confirmation the watcher is alive
        // even before the initial sync formally completes — drop the
        // spinner so the table isn't fighting against rows already on
        // screen.
        setLoad((cur) => (cur.kind === "loading" ? { kind: "ready" } : cur));
      } else if (delta.kind === "delete") {
        localMap.delete(delta.uid);
        scheduleFlush();
      } else {
        // init_done — watcher finished its initial sync. Safe to flip
        // the load state to ready even if the snapshot was empty (the
        // kind genuinely has no instances on this cluster).
        setLoad((cur) => (cur.kind === "loading" ? { kind: "ready" } : cur));
      }
    };

    (async () => {
      try {
        // Register listeners FIRST (before subscribe) so deltas emitted
        // during the snapshot round-trip aren't missed. Listeners run in
        // parallel; each owns its own scope event channel.
        const listenerHandles = await Promise.all(
          subscribeScopes.map((scope) =>
            onResourceDelta(clusterId, kind.id, scope, onDelta),
          ),
        );
        // If cleanup ran while we were awaiting registration, the cleanup
        // saw `unlistens` empty and skipped the unsubscribe — tear down here.
        if (cancelled) {
          for (const u of listenerHandles) u();
          return;
        }
        unlistens.push(...listenerHandles);

        // Subscribe each scope in parallel. Backend lingers each
        // (kind, ns) slot independently, so a flip from {foo} →
        // {foo, bar} reuses foo's warm watcher and only pays a fresh
        // LIST for bar.
        const results = await Promise.all(
          subscribeScopes.map((scope) =>
            api.subscribeResource(clusterId, kind.id, scope),
          ),
        );
        if (cancelled) return;

        // Merge each scope's snapshot under any deltas already landed
        // (deltas win, they're newer). Snapshots can't double-count: a
        // pod has exactly one namespace and is only emitted by that
        // namespace's watcher.
        const merged = new Map<string, ResourceRow>();
        for (const result of results) {
          for (const row of result.rows) merged.set(row.uid, row);
        }
        for (const [uid, row] of localMap) merged.set(uid, row);
        localMap.clear();
        for (const [uid, row] of merged) localMap.set(uid, row);
        setRows(Array.from(localMap.values()));
        // Flip to ready when every scope has either completed its initial
        // sync OR contributed a row (mirrors the single-scope heuristic).
        const allInitDone = results.every((r) => r.init_done);
        if (allInitDone || localMap.size > 0) {
          setLoad({ kind: "ready" });
        }
      } catch (e) {
        if (!cancelled) setLoad({ kind: "error", message: String(e) });
      }
    })();

    // The 1 Hz "now" tick lives inside `<NowProvider>` and only re-renders
    // <AgeCell> subscribers — the parent table no longer rebuilds for it.

    return () => {
      cancelled = true;
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
      for (const u of unlistens) u();
      // Drop every captured row reference so a late Tauri delta firing
      // after unsubscribe (the channel can deliver a few in-flight events
      // before the unlisten round-trip completes) can't keep 2800 row
      // payloads alive on the JS heap. Belt for the rowsRef-identity
      // suspenders we already have.
      localMap.clear();
      for (const scope of subscribeScopes) {
        api
          .unsubscribeResource(clusterId, kind.id, scope)
          .catch(() => {});
      }
    };
    // `subscribeScopeKey` joins scope flips with the existing
    // (cluster, kind) churn — when the operator changes their namespace
    // selection (size or membership), we tear down the old subscriptions
    // and open a new fan of them against the matching backend slots.
  }, [clusterId, kind.id, subscribeScopeKey, subscribeScopes]);

  // Cross-kind navigation: if the operator clicked "Controlled By: …" on
  // another kind's detail panel, the store carries the (namespace, name) here.
  // Resolve it to a uid against the current snapshot and open the detail.
  useEffect(() => {
    if (!pendingDetail || pendingDetail.kindId !== kind.id) return;
    if (load.kind !== "ready") return;
    const match = rows.find(
      (r) =>
        String(r.name ?? "") === pendingDetail.name &&
        (pendingDetail.namespace == null ||
          String(r.namespace ?? "") === pendingDetail.namespace),
    );
    if (match) {
      const ns = match.namespace;
      setDetailTarget({
        uid: match.uid,
        namespace: typeof ns === "string" ? ns : null,
        name: String(match.name ?? ""),
      });
      setLogTarget(null);
      consumePendingDetail();
    }
  }, [pendingDetail, kind.id, rows, load.kind, consumePendingDetail]);

  const filtered = useMemo(() => {
    const parsed = parseTableFilter(tableFilter);
    const nsFilterActive = kind.namespaced && selectedNamespaces.size > 0;
    return rows
      .filter((r) => {
        if (!nsFilterActive) return true;
        const ns = r.namespace;
        return typeof ns === "string" && selectedNamespaces.has(ns);
      })
      .filter((r) => {
        if (parsed.mode === "off") return true;
        const name = typeof r.name === "string" ? r.name : "";
        return parsed.test(name);
      });
  }, [rows, selectedNamespaces, tableFilter, kind.namespaced]);

  // Push the row count to the store so the header breadcrumb can render it
  // (`Pods · 232` / `Pods · 12/232`). Reset to null on unmount so a stale
  // count doesn't linger after navigating away from a kind.
  useEffect(() => {
    setTableCount({ filtered: filtered.length, total: rows.length });
    return () => setTableCount(null);
  }, [filtered.length, rows.length, setTableCount]);

  // Hide the namespace column when the operator has filtered to exactly one
  // namespace — every row would say the same thing. The cluster bar already
  // shows which namespace they're in, so the column is dead weight (P1).
  const singleNs =
    selectedNamespaces.size === 1
      ? Array.from(selectedNamespaces)[0]
      : null;

  // Pull metrics here so the cell renderer can join CPU/Mem by uid. Keeping
  // the read at this level lets every table row re-render together when a
  // new snapshot arrives instead of subscribing per-cell.
  const podMetrics = useAppStore((s) => s.metrics?.pods ?? null);

  // Sort / sizing state. Initialized from the persisted view, falls back
  // to the project default (single column, name asc). Multi-column sort
  // is opt-in via shift-click — persisted multi-column state from older
  // builds is clamped to its primary entry so the operator only sees one
  // active sort caret on first paint.
  const [sorting, setSorting] = useState<SortingState>(() =>
    sortingFromPersisted(persistedView?.sorting, kind),
  );
  // Column widths are in-memory only — auto-fit on mount/resize, user drags
  // override until the next kind/cluster switch. Not persisted: opening the
  // same view tomorrow re-fits to whatever the window size is now.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  // Flips true the first time the user actually drags a handle. While false,
  // auto-fit owns the widths and recomputes on container resize.
  const userResizedRef = useRef(false);

  // When the kind / cluster changes, reset to whatever was persisted for the
  // new (cluster, kind). Without this the sort from kind A would leak onto
  // kind B until the operator clicked something.
  useEffect(() => {
    setSorting(sortingFromPersisted(persistedView?.sorting, kind));
    setColumnSizing({});
    userResizedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, kind.id]);

  // Debounced persistence (sorting only — widths stay in memory).
  useEffect(() => {
    const timeout = setTimeout(() => {
      const view = { sorting, column_sizing: {} };
      setTableView(clusterId, kind.id, view);
      api.setTableView(clusterId, kind.id, view).catch(() => {});
    }, 200);
    return () => clearTimeout(timeout);
  }, [sorting, clusterId, kind.id, setTableView]);

  // Refs so the cell renderer can read fresh values without triggering a
  // columns-memo recompute (which invalidates TanStack's entire row model
  // and reallocates 2800-row internal structures on every change). `now`
  // doesn't need a ref — it's delivered to the age cell directly via
  // NowContext, so the parent doesn't need to re-render on its tick at all.
  const podMetricsRef = useRef(podMetrics);
  podMetricsRef.current = podMetrics;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tRef = useRef(t);
  tRef.current = t;
  const monoTablesRef = useRef(monoTables);
  monoTablesRef.current = monoTables;
  // Inline cell-link handlers flow through refs so a store change doesn't
  // force a columns rebuild (which would invalidate TanStack's row model).
  const navigateToDetailRef = useRef(navigateToDetail);
  navigateToDetailRef.current = navigateToDetail;
  const setSelectedNamespacesRef = useRef(setSelectedNamespaces);
  setSelectedNamespacesRef.current = setSelectedNamespaces;

  const columns = useMemo<TanColumnDef<ResourceRow>[]>(() => {
    const cols: TanColumnDef<ResourceRow>[] = kind.columns
      .filter((c) => !(singleNs && c.id === "namespace"))
      .map((c) => ({
        id: c.id,
        header: c.header,
        size: defaultWidth(c),
        enableSorting: true,
        // sortingFn reads from the ref so a metrics tick doesn't force
        // a columns rebuild; sort comparator is invoked at sort time
        // and picks up the current podMetrics ref then.
        sortingFn: sortingFnFor(c, podMetricsRef.current, isPods),
        accessorFn: accessorFor(c),
        cell: (ctx) =>
          renderCell(
            c,
            ctx.row.original,
            modeRef.current,
            tRef.current,
            isPods,
            podMetricsRef.current,
            monoTablesRef.current,
            navigateToDetailRef.current,
            setSelectedNamespacesRef.current,
          ),
      }));
    // Selection column applies to every kind now — operators copy names off
    // configmaps and secrets too. Bulk-action wiring still gates each action
    // by kind in `App.tsx`.
    cols.unshift({
      id: SELECT_COL_ID,
      header: "",
      size: SELECT_COL_WIDTH,
      enableSorting: false,
      enableResizing: false,
      cell: () => null,
    });
    return cols;
    // Only kind shape + namespace-column toggle drive a columns rebuild.
    // `now`, `mode`, `t`, `podMetrics`, `monoTables` flow through refs.
  }, [kind, isPods, singleNs]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: (updater) => {
      // Any change driven through TanStack means the user grabbed a handle —
      // freeze auto-fit so a window resize doesn't snap their widths back.
      userResizedRef.current = true;
      setColumnSizing(updater);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    enableMultiSort: false,
    getRowId: (r) => r.uid,
  });

  // Selection-anchor for shift-range. Holds the uid the operator last
  // toggled; cleared whenever the visible/sorted order changes so a stale
  // anchor doesn't produce a confusing range.
  const anchorRef = useRef<string | null>(null);
  const sortedRows = table.getRowModel().rows;
  useEffect(() => {
    anchorRef.current = null;
  }, [tableFilter, selectedNamespaces, sorting]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const tableShellRef = useRef<HTMLDivElement | null>(null);

  // Keep the header aligned with the body when columns overflow the
  // container horizontally (narrow window). The body has `overflow: auto`
  // so it scrolls horizontally; the header sits inside an `overflow:
  // hidden` parent, so without this it stays put and columns drift out of
  // alignment with the rows beneath.
  useEffect(() => {
    const body = scrollRef.current;
    const head = headerRef.current;
    if (!body || !head) return;
    const onScroll = () => {
      head.style.transform = `translateX(-${body.scrollLeft}px)`;
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  // estimateSize closes over ROW_HEIGHT once per render, but the virtualizer
  // caches per-row measurements; nudge it when the density changes so the
  // visible height actually updates instead of staying frozen at the prior
  // setting.
  useEffect(() => {
    virtualizer.measure();
  }, [ROW_HEIGHT, virtualizer]);
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const padTop = virtualRows[0]?.start ?? 0;
  const padBottom = totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0);

  // Auto-fit: pour the leftover horizontal space into the Name column on
  // first paint and on container resize, so the rightmost column lands on
  // the right edge instead of leaving a gap. Frozen the moment the user
  // grabs any resize handle (`userResizedRef`) — from then on their drags
  // own the layout until the next kind/cluster switch (which resets
  // `userResizedRef` and re-fits).
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    // Observe the body (scrollRef) — its clientWidth already excludes
    // the vertical scrollbar gutter, so the right edge of the rightmost
    // column lands flush against the visible right edge of the table.
    // Measuring the outer shell (tableShellRef) was off by ~12–17 px on
    // platforms with classic scrollbars (Linux Chromium / WebKitGTK).
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Content-aware "natural" widths: the longest rendered string in each
  // column across a row sample. Caps and floors are applied in the
  // auto-fit; here we just measure. Sample size of 200 catches the
  // longest names in practical clusters (kube-system pods top out around
  // 60 chars) without scanning 2800 rows on every delta — the result
  // converges within the first sync.
  const naturalWidths = useMemo(() => {
    if (filtered.length === 0) return null;
    const sample = filtered.slice(0, 200);
    const result: Record<string, number> = {};
    for (const c of kind.columns) {
      if (singleNs && c.id === "namespace") continue;
      result[c.id] = naturalContentWidth(c, sample);
    }
    return result;
  }, [filtered, kind, singleNs]);

  useEffect(() => {
    if (containerWidth === 0) return;
    if (userResizedRef.current) return;
    const visible = kind.columns.filter(
      (c) => !(singleNs && c.id === "namespace"),
    );
    if (visible.length === 0) return;
    // Cells use box-sizing: content-box, so the configured column size
    // (TanStack `header.getSize()`) is laid out in addition to the cell's
    // horizontal padding. `containerWidth` is the body's clientWidth
    // (scrollbar gutter already excluded), so we only subtract the cell
    // padding overhead:
    //   - select column visual = SELECT_COL_WIDTH + 22 (left pad only)
    //   - each data column adds 24 (12 + 12) of horizontal padding
    //   - the first data column adds an extra 10 (22 left vs. 12)
    const SELECT_VISUAL = SELECT_COL_WIDTH + 22;
    const PER_COL_PAD = 24;
    const FIRST_COL_EXTRA = 10;
    const overhead =
      SELECT_VISUAL + PER_COL_PAD * visible.length + FIRST_COL_EXTRA;
    const available = Math.max(0, containerWidth - overhead);

    // Per-column "preferred" width: what the data wants to display in
    // full. When natural is unknown (no rows yet) we fall back to the
    // configured default. There is intentionally no upper cap — long
    // node identifiers (e.g. gke-cluster-default-pool-abc1234) need to
    // grow past the 180 default; the tiered shrink takes care of pulling
    // them back when the container is too narrow.
    const preferred = (c: ColumnDef): number => {
      const lo = minWidth(c);
      const nat = naturalWidths?.[c.id];
      if (typeof nat !== "number") return defaultWidth(c);
      return Math.max(lo, nat);
    };

    const sumPreferred = visible.reduce((a, c) => a + preferred(c), 0);

    // Tiered shrink. The Name column is prefix-scannable — the operator
    // reads "kube-apiserver-…" by its prefix, the tail is fungible — so
    // it absorbs the bulk of any shrink without UX loss. Other columns
    // (node, status, ready, age, …) carry identifier or numeric content
    // that the operator reads in full, and only start shrinking once
    // Name has hit its min.
    const SHRINK_FIRST = new Set(["name"]);
    const tier1 = visible.filter((c) => SHRINK_FIRST.has(c.id));
    const tier2 = visible.filter((c) => !SHRINK_FIRST.has(c.id));
    const tier1Headroom = tier1.reduce(
      (a, c) => a + (preferred(c) - minWidth(c)),
      0,
    );
    const tier2Headroom = tier2.reduce(
      (a, c) => a + (preferred(c) - minWidth(c)),
      0,
    );

    const next: Record<string, number> = {};
    visible.forEach((c) => {
      next[c.id] = preferred(c);
    });

    if (available < sumPreferred) {
      // Need to shrink by `deficit`. Tier 1 (Name) absorbs first; only
      // once Name has hit its min do other columns shrink. CSS handles
      // the roomy case via `flex-grow: 1` on the Name cell.
      let deficit = sumPreferred - available;
      const tier1Take = Math.min(deficit, tier1Headroom);
      if (tier1Take > 0 && tier1Headroom > 0) {
        const ratio = tier1Take / tier1Headroom;
        tier1.forEach((c) => {
          const headroom = preferred(c) - minWidth(c);
          next[c.id] = preferred(c) - Math.round(headroom * ratio);
        });
      }
      deficit -= tier1Take;
      if (deficit > 0 && tier2Headroom > 0) {
        const ratio = Math.min(1, deficit / tier2Headroom);
        tier2.forEach((c) => {
          const headroom = preferred(c) - minWidth(c);
          next[c.id] = preferred(c) - Math.round(headroom * ratio);
        });
      }
      // If even tier-2 mins aren't enough, leave columns at their mins;
      // the synced header + body horizontal-scroll handles the overflow.
      if (deficit > tier2Headroom) {
        tier2.forEach((c) => {
          next[c.id] = minWidth(c);
        });
      }
    }
    // Roomy case: every column gets its preferred (content-aware) and
    // `flex-grow: 1` on the Name cell pours leftover horizontal space
    // into Name. No JS drift correction needed.

    setColumnSizing((prev) => {
      // Skip the state update when nothing changed — avoids a re-render
      // loop with the ResizeObserver.
      const keys = Object.keys(next);
      if (
        keys.length === Object.keys(prev).length &&
        keys.every((k) => prev[k] === next[k])
      ) {
        return prev;
      }
      return next;
    });
  }, [containerWidth, kind, singleNs, naturalWidths]);

  const logPod = useMemo(() => {
    if (!logTarget) return null;
    const containers = Array.isArray(logTarget.containers)
      ? (logTarget.containers as string[])
      : [];
    return {
      uid: logTarget.uid,
      namespace: String(logTarget.namespace ?? ""),
      name: String(logTarget.name ?? ""),
      containers,
    };
  }, [logTarget]);

  // Click handler for the select-column. Pulls range / additive logic into
  // one place so both the cell-wide click target (Slice 1) and modifier
  // keys (Slice 2) share the same code path.
  const onSelectClick = (
    e: React.MouseEvent,
    row: TanRow<ResourceRow>,
  ) => {
    e.stopPropagation();
    const uid = row.original.uid;
    const meta = {
      namespace:
        typeof row.original.namespace === "string"
          ? row.original.namespace
          : null,
      name: String(row.original.name ?? ""),
    };
    if (e.shiftKey && anchorRef.current) {
      const ids = sortedRows.map((r) => r.original.uid);
      const a = ids.indexOf(anchorRef.current);
      const b = ids.indexOf(uid);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        // Range select extends the existing selection — matches Finder/Sheets
        // semantics. Plain click on the anchor would have set it; shift adds
        // everything from anchor → click inclusive.
        const next = new Map(selection);
        for (let i = lo; i <= hi; i++) {
          const r = sortedRows[i];
          if (!r) continue;
          next.set(r.original.uid, {
            namespace:
              typeof r.original.namespace === "string"
                ? r.original.namespace
                : null,
            name: String(r.original.name ?? ""),
          });
        }
        setSelection(next);
        return;
      }
    }
    anchorRef.current = uid;
    toggleSelection(uid, meta);
  };

  // Ctrl/Cmd-A inside the table — select everything currently visible.
  // Scoped to the table shell focus so Cmd-A elsewhere (e.g. the global
  // palette in filter mode) keeps default browser behaviour.
  //
  // The handler reads `sortedRows` through a ref so the listener is bound
  // once. Previously the deps were `[sortedRows, setSelection]`, which
  // re-bound the keydown listener on every parent re-render — including
  // every scroll tick on a 2800-row table — and each re-bind allocated a
  // fresh closure capturing the entire row array. Under sustained load
  // this leaked into JSC's listener registry and grew RSS without bound.
  const sortedRowsRef = useRef(sortedRows);
  sortedRowsRef.current = sortedRows;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (latinLetter(e) !== "a") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
        return;
      const shell = tableShellRef.current;
      if (!shell || !shell.contains(target)) return;
      const rows = sortedRowsRef.current;
      if (rows.length === 0) return;
      e.preventDefault();
      setSelection(
        new Map(
          rows.map((r) => [
            r.original.uid,
            {
              namespace:
                typeof r.original.namespace === "string"
                  ? r.original.namespace
                  : null,
              name: String(r.original.name ?? ""),
            },
          ]),
        ),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelection]);

  return (
   <NowProvider>
    <div
      ref={tableShellRef}
      tabIndex={-1}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: t.bg,
        outline: "none",
      }}
    >
      {/* Table */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          ref={headerRef}
          style={{
            display: "flex",
            background: t.headerAlt,
            borderBottom: `1px solid ${t.border}`,
            flexShrink: 0,
            position: "sticky",
            top: 0,
            willChange: "transform",
          }}
        >
          {table.getHeaderGroups()[0]?.headers.map((header, i) => {
            if (header.column.id === SELECT_COL_ID) {
              const all =
                filtered.length > 0 &&
                filtered.every((r) => selection.has(r.uid));
              const some = filtered.some((r) => selection.has(r.uid));
              const toggleAll = () => {
                if (all) clearSelection();
                else
                  setSelection(
                    new Map(
                      filtered.map((r) => [
                        r.uid,
                        {
                          namespace:
                            typeof r.namespace === "string" ? r.namespace : null,
                          name: String(r.name ?? ""),
                        },
                      ]),
                    ),
                  );
              };
              return (
                <div
                  key={header.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAll();
                  }}
                  style={{
                    width: SELECT_COL_WIDTH,
                    padding: "10px 0 10px 22px",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    cursor: "pointer",
                  }}
                >
                  <Checkbox
                    t={t}
                    checked={all}
                    indeterminate={!all && some}
                    onChange={toggleAll}
                  />
                </div>
              );
            }
            const sort = header.column.getIsSorted();
            const canSort = header.column.getCanSort();
            const canResize = header.column.getCanResize();
            // The first data column (in every registered kind, that's
            // Name) absorbs leftover horizontal space, which automatically
            // shifts every subsequent column right so the last column —
            // whatever it is for this kind: Age for Pods/Nodes, but it
            // could be anything else — lands flush against the right
            // edge. `flex-grow: 1` only fires when total cell widths <
            // row width (no overflow); on overflow each cell stays at its
            // configured size and horizontal scroll handles the rest.
            // i === 0 is the SELECT column (handled in the early return
            // above), so i === 1 is reliably the first data column.
            const isStretchCol = i === 1;
            return (
              <div
                key={header.id}
                style={{
                  width: header.getSize(),
                  flexShrink: 0,
                  flexGrow: isStretchCol ? 1 : 0,
                  position: "relative",
                  padding: i === 1 ? "10px 12px 10px 22px" : "10px 12px",
                  fontSize: FS_XS,
                  fontWeight: 700,
                  color: sort ? t.text : t.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  fontFamily: FF_MONO,
                  textAlign: rightAlign(header.column.id) ? "right" : "left",
                  cursor: canSort ? "pointer" : "default",
                  userSelect: "none",
                }}
                onClick={
                  canSort
                    ? (e) => {
                        // Tri-state cycle: none → asc → desc → none.
                        e.stopPropagation();
                        header.column.toggleSorting(undefined, false);
                      }
                    : undefined
                }
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    justifyContent: rightAlign(header.column.id)
                      ? "flex-end"
                      : "flex-start",
                    width: "100%",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                  {canSort && sort && <SortCaret dir={sort} t={t} />}
                </span>
                {canResize && (
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      height: "100%",
                      width: RESIZE_HANDLE_WIDTH,
                      cursor: "col-resize",
                      background: header.column.getIsResizing()
                        ? t.accent
                        : "transparent",
                      transition: "background .12s",
                    }}
                    onMouseEnter={(e) => {
                      if (!header.column.getIsResizing())
                        e.currentTarget.style.background = t.borderSoft;
                    }}
                    onMouseLeave={(e) => {
                      if (!header.column.getIsResizing())
                        e.currentTarget.style.background = "transparent";
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div
          ref={scrollRef}
          style={{ flex: 1, overflow: "auto", minHeight: 0 }}
          onClick={(e) => {
            // Delegated row click. Per-row onClick props were the biggest
            // source of GC pressure on large tables — every render
            // rebuilt a fresh closure per visible row, defeating React
            // memoization. The handler walks up to find the [data-uid]
            // ancestor (skipping the select-column glyph which stops
            // propagation) and looks the row up via the shared map.
            const target = e.target as HTMLElement | null;
            const node = target?.closest<HTMLElement>("[data-uid]");
            if (!node) return;
            const uid = node.dataset["uid"];
            if (!uid) return;
            const row = rowsRef.current.get(uid);
            if (!row) return;
            const ns = row.namespace;
            const nsStr = typeof ns === "string" ? ns : null;
            const nm = String(row.name ?? "");
            setLogTarget(null);
            setDetailTarget({ uid, namespace: nsStr, name: nm });
            pushDetailEntry(kind.id, nsStr, nm);
          }}
          onContextMenu={(e) => {
            const target = e.target as HTMLElement | null;
            const node = target?.closest<HTMLElement>("[data-uid]");
            if (!node) return;
            const uid = node.dataset["uid"];
            if (!uid) return;
            const row = rowsRef.current.get(uid);
            if (!row) return;
            e.preventDefault();
            setMenu({ pos: { x: e.clientX, y: e.clientY }, row });
          }}
        >
          {load.kind === "error" ? (
            <ErrorBlock
              t={t}
              message={load.message}
              kindLabel={kind.plural}
            />
          ) : load.kind === "loading" && filtered.length === 0 ? (
            // First-paint loading. R-01: no spinners on poll — but we are
            // not polling here; we're waiting for the watcher's first
            // snapshot, which is exactly when a quiet indicator helps.
            <LoadingLine t={t} label={`Loading ${kind.plural}…`} />
          ) : filtered.length === 0 && load.kind === "ready" ? (
            // Honest empty: only mention filters if any are actually applied.
            (() => {
              const nsFilterApplied =
                kind.namespaced && selectedNamespaces.size > 0;
              const filtersApplied =
                tableFilter.trim().length > 0 || nsFilterApplied;
              if (filtersApplied) {
                const bits: string[] = [];
                if (nsFilterApplied) {
                  bits.push(
                    selectedNamespaces.size === 1
                      ? `namespace ${Array.from(selectedNamespaces)[0]}`
                      : `${selectedNamespaces.size} namespaces`,
                  );
                }
                if (tableFilter.trim()) {
                  bits.push(`filter "${tableFilter.trim()}"`);
                }
                return (
                  <EmptyState
                    t={t}
                    title={`No ${kind.plural} match the current filters`}
                    hint={`Filters: ${bits.join(", ")}. Clear them to see everything.`}
                  />
                );
              }
              return (
                <EmptyState
                  t={t}
                  title={`No ${kind.plural} in this cluster`}
                  hint={
                    kind.namespaced
                      ? "Try a different cluster, or check that the right resources have been created."
                      : "This cluster has nothing of this kind."
                  }
                />
              );
            })()
          ) : (
            <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
              {virtualRows.map((vi) => {
                const row = sortedRows[vi.index];
                if (!row) return null;
                const selected =
                  detailTarget && detailTarget.uid === row.original.uid;
                const checked = selection.has(row.original.uid);
                return (
                  <Row
                    key={row.original.uid}
                    uid={row.original.uid}
                    t={t}
                    selected={!!selected}
                    checked={checked}
                  >
                    {row.getVisibleCells().map((cell, ci) => {
                      if (cell.column.id === SELECT_COL_ID) {
                        // The Checkbox button calls e.stopPropagation, so
                        // clicks on the glyph never bubble to the wrapping
                        // div. We capture on the cell *and* drive the
                        // checkbox's onChange through the same handler so
                        // either click target — glyph or surrounding cell —
                        // takes the same shift / cmd path.
                        const fakeEvent = (
                          mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
                        ) =>
                          ({
                            ...mods,
                            stopPropagation: () => {},
                          }) as unknown as React.MouseEvent;
                        return (
                          <div
                            key={cell.id}
                            onClick={(e) => onSelectClick(e, row)}
                            style={{
                              width: SELECT_COL_WIDTH,
                              padding: "0 0 0 22px",
                              flexShrink: 0,
                              height: ROW_HEIGHT,
                              display: "flex",
                              alignItems: "center",
                              cursor: "pointer",
                            }}
                          >
                            <span
                              onClickCapture={(e) => {
                                // Forward the real modifier state from the
                                // glyph click into the same handler before
                                // the Checkbox stops propagation.
                                onSelectClick(
                                  fakeEvent({
                                    shiftKey: e.shiftKey,
                                    metaKey: e.metaKey,
                                    ctrlKey: e.ctrlKey,
                                  }),
                                  row,
                                );
                                e.stopPropagation();
                                e.preventDefault();
                              }}
                              style={{ display: "inline-flex" }}
                            >
                              <Checkbox t={t} checked={checked} />
                            </span>
                          </div>
                        );
                      }
                      // ci === 0 is the SELECT column (early-returned
                      // above), so ci === 1 is the first data column —
                      // it stretches and pushes the rest of the row right
                      // until the last column hits the right edge.
                      const isStretchCol = ci === 1;
                      return (
                        <div
                          key={cell.id}
                          style={{
                            width: cell.column.getSize(),
                            flexShrink: 0,
                            flexGrow: isStretchCol ? 1 : 0,
                            padding:
                              ci === 1 ? "0 12px 0 22px" : "0 12px",
                            height: ROW_HEIGHT,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: rightAlign(cell.column.id)
                              ? "flex-end"
                              : "flex-start",
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            fontSize: FS_MD,
                          }}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </div>
                      );
                    })}
                  </Row>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {logPod && (
        <LogPanel
          mode={mode}
          clusterId={clusterId}
          pod={logPod}
          defaultContainer={logDefaultContainer}
          onClose={() => setLogTarget(null)}
        />
      )}

      {detailTarget && (
        <DetailPanel
          mode={mode}
          clusterId={clusterId}
          kind={kind}
          target={detailTarget}
          // Detail's delta listener needs the channel that actually
          // carries this row's events. With per-namespace subscriptions,
          // the row lives in the watcher scoped to its own namespace —
          // not the table's full selection. Cluster-scoped kinds and
          // detail targets without a namespace fall back to All.
          subscribeNamespaces={
            kind.namespaced && detailTarget.namespace
              ? [detailTarget.namespace]
              : null
          }
          row={
            rowsRef.current.get(detailTarget.uid) ??
            filtered.find((r) => r.uid === detailTarget.uid) ??
            null
          }
          onClose={() => {
            setDetailTarget(null);
            closeDetail();
          }}
          onNavigate={(targetKindName, namespace, name) => {
            // Map a Kubernetes Kind name (e.g. "StatefulSet") to a registry
            // kind id ("stateful_sets") and navigate. Falls back silently if
            // the kind isn't browseable yet (e.g. a CRD we don't ship for).
            const target = kinds.find((k) => k.kind === targetKindName);
            if (!target) return;
            navigateToDetail(target.id, namespace, name);
          }}
          onOpenExec={
            isPods
              ? (container) => {
                  // Same Dock-terminal flow the row context menu uses, but
                  // sourced from the detail panel's container picker so the
                  // operator can target an init/sidecar without round-
                  // tripping back to the table.
                  const r = rowsRef.current.get(detailTarget.uid);
                  if (!r) return;
                  const ns =
                    typeof r.namespace === "string" ? r.namespace : null;
                  if (!ns) {
                    toast.bad("Pod has no namespace — can't exec.");
                    return;
                  }
                  addDockTab(
                    makeTerminalTab(
                      {
                        mode: "exec",
                        clusterId,
                        namespace: ns,
                        pod: String(r.name ?? ""),
                        container: container ?? null,
                      },
                      contextLabel ?? clusterId,
                    ),
                  );
                  setDetailTarget(null);
                }
              : kind.id === "nodes"
                ? () => {
                    // Node "shell" is `kubectl debug node/<name>` — same path
                    // the row context menu uses. The container arg is
                    // irrelevant here; the debug pod is the shell.
                    const r = rowsRef.current.get(detailTarget.uid);
                    if (!r) return;
                    openNodeDebugTab(
                      clusterId,
                      contextLabel ?? clusterId,
                      String(r.name ?? ""),
                      addDockTab,
                    );
                    setDetailTarget(null);
                  }
                : undefined
          }
        />
      )}

      {menu && (
        <ContextMenu
          mode={mode}
          position={menu.pos}
          onClose={() => setMenu(null)}
          rowName={String(menu.row.name ?? "")}
          items={actionsForRow(
            buildRowActionContext(
              kind,
              menu.row,
              clusterId,
              contextLabel ?? clusterId,
              confirmDestructive,
              addDockTab,
              {
                openDetail: () => {
                  const ns = menu.row.namespace;
                  const nsStr = typeof ns === "string" ? ns : null;
                  const nm = String(menu.row.name ?? "");
                  setLogTarget(null);
                  setDetailTarget({
                    uid: menu.row.uid,
                    namespace: nsStr,
                    name: nm,
                  });
                  pushDetailEntry(kind.id, nsStr, nm);
                },
                openLogs: () => {
                  setDetailTarget(null);
                  setLogDefaultContainer(null);
                  setLogTarget(menu.row);
                },
              },
            ),
          )}
        />
      )}
    </div>
   </NowProvider>
  );
}

// Wire the menu's row-context handlers (delete / cordon / drain) here so the
// table doesn't have to drill `clusterId` + `confirmDestructive` through
// every callsite. Pod-only and node-only branches are inlined per kind to
// keep the action surface deliberately scoped.
function buildRowActionContext(
  kind: ResourceKind,
  row: ResourceRow,
  clusterId: string,
  contextLabel: string,
  confirmDestructive: boolean,
  addDockTab: (tab: import("../store").DockTab) => void,
  base: {
    openDetail: () => void;
    openLogs: () => void;
  },
): import("./rowActions").RowActionContext {
  const ns = typeof row.namespace === "string" ? row.namespace : null;
  const name = String(row.name ?? "");
  const qualified = ns ? `${ns}/${name}` : name;
  const containers = Array.isArray(row.containers)
    ? (row.containers as Array<{ name?: string }>)
    : [];

  const ctx: import("./rowActions").RowActionContext = {
    kind,
    row,
    openDetail: base.openDetail,
    openLogs: base.openLogs,
  };

  if (kind.id === "pods") {
    ctx.openExec = () => {
      if (!ns) {
        toast.bad("Pod has no namespace — can't exec.");
        return;
      }
      const firstContainer =
        containers.length > 0 && typeof containers[0]?.name === "string"
          ? (containers[0]!.name as string)
          : null;
      addDockTab(
        makeTerminalTab(
          {
            mode: "exec",
            clusterId,
            namespace: ns,
            pod: name,
            container: firstContainer,
          },
          contextLabel,
        ),
      );
    };
    ctx.delete = () => {
      void (async () => {
        if (confirmDestructive) {
          const ok = await confirm({
            title: `Delete pod ${qualified}?`,
            body: "The pod will be terminated. If owned by a controller it will be recreated; otherwise it's gone.",
            confirmLabel: "Delete",
            tone: "danger",
          });
          if (!ok) return;
        }
        try {
          await api.deleteResource(clusterId, "pods", ns, name, null);
          toast.ok(`Deleted pod ${qualified}.`);
        } catch (e) {
          toast.bad(`Delete failed: ${String(e)}`);
        }
      })();
    };
    ctx.restart = () => {
      void (async () => {
        if (!ns) {
          toast.bad("Pod has no namespace — can't restart.");
          return;
        }
        if (confirmDestructive) {
          const ok = await confirm({
            title: `Restart owner of ${qualified}?`,
            body: "Rolls out the workload that owns this pod (Deployment / StatefulSet / DaemonSet). Every pod owned by it is recreated, not just this one.",
            confirmLabel: "Restart",
            tone: "danger",
          });
          if (!ok) return;
        }
        try {
          const [k, n] = await api.restartPod(clusterId, ns, name);
          toast.ok(`Restarted ${k} ${ns}/${n}.`);
        } catch (e) {
          toast.bad(`Restart failed: ${String(e)}`);
        }
      })();
    };
  } else if (kind.id === "nodes") {
    ctx.openExec = () => {
      openNodeDebugTab(clusterId, contextLabel, name, addDockTab);
    };
    const cordoned = isNodeCordoned(row);
    const target = !cordoned;
    ctx.cordonTo = {
      target,
      run: () => {
        void (async () => {
          if (confirmDestructive && target) {
            const ok = await confirm({
              title: `Cordon node ${name}?`,
              body: "New pods won't be scheduled here until the node is uncordoned. Existing pods stay running.",
              confirmLabel: "Cordon",
            });
            if (!ok) return;
          }
          try {
            await api.cordonNode(clusterId, name, target);
            toast.ok(target ? `Cordoned ${name}.` : `Uncordoned ${name}.`);
          } catch (e) {
            toast.bad(
              `${target ? "Cordon" : "Uncordon"} failed: ${String(e)}`,
            );
          }
        })();
      },
    };
    ctx.drain = () => {
      void (async () => {
        const ok = await confirm({
          title: `Drain node ${name}?`,
          body: "Cordons the node and evicts every pod on it. DaemonSet-managed and mirror pods are skipped. Pods backed by a PDB may be blocked — failures are reported but the drain continues.",
          confirmLabel: "Drain",
          tone: "danger",
        });
        if (!ok) return;
        try {
          const report = await api.drainNode(clusterId, name, false);
          summarizeDrain(name, report);
        } catch (e) {
          toast.bad(`Drain failed: ${String(e)}`);
        }
      })();
    };
    ctx.delete = () => {
      void (async () => {
        const ok = await confirm({
          title: `Delete node ${name}?`,
          body: "Removes the node from the cluster. Pods on it become orphaned until rescheduled. This does not stop the underlying machine.",
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api.deleteResource(clusterId, "nodes", null, name, null);
          toast.ok(`Deleted node ${name}.`);
        } catch (e) {
          toast.bad(`Delete failed: ${String(e)}`);
        }
      })();
    };
  } else if (kind.id === "helm_charts") {
    // Synthetic catalog entry, nothing to delete. Don't expose a delete
    // callback at all — rowActions.ts already filters this kind out of
    // the menu, and the bulk path skips uninstall-able ops on charts.
  } else if (kind.id === "helm_releases") {
    // Helm releases route through `helm uninstall` — backend handles the
    // dispatch in delete_resource_cmd. UX surfaces this as "Uninstall"
    // so the operator knows hooks fire and rendered workloads come down.
    ctx.delete = () => {
      void (async () => {
        if (confirmDestructive) {
          const ok = await confirm({
            title: `Uninstall release ${qualified}?`,
            body:
              "Runs `helm uninstall`: deletes the release secret AND every Kubernetes object the release rendered (Deployments, Services, ConfigMaps, …). Pre-/post-delete hooks fire. This is irreversible.",
            confirmLabel: "Uninstall",
            tone: "danger",
          });
          if (!ok) return;
        }
        try {
          await api.deleteResource(clusterId, kind.id, ns, name, null);
          toast.ok(`Uninstalled release ${qualified}.`);
        } catch (e) {
          toast.bad(`Uninstall failed: ${String(e)}`);
        }
      })();
    };
  } else {
    // Generic delete for every other kind. The dynamic API in
    // `api.deleteResource` covers them via `kind.id` — no per-kind plumbing.
    const kindLabel = kind.kind.toLowerCase();
    ctx.delete = () => {
      void (async () => {
        if (confirmDestructive) {
          const ok = await confirm({
            title: `Delete ${kindLabel} ${qualified}?`,
            body: kind.namespaced
              ? "Object will be removed from the cluster. Controllers may recreate it; cascading deletes may follow per the apiserver's default propagation policy."
              : "Object will be removed from the cluster. Cascading deletes may follow per the apiserver's default propagation policy.",
            confirmLabel: "Delete",
            tone: "danger",
          });
          if (!ok) return;
        }
        try {
          await api.deleteResource(clusterId, kind.id, ns, name, null);
          toast.ok(`Deleted ${kindLabel} ${qualified}.`);
        } catch (e) {
          toast.bad(`Delete failed: ${String(e)}`);
        }
      })();
    };
  }

  return ctx;
}

// `kubectl debug node/<name>` runs a debug pod with the node's PID namespace
// + a host-fs mount. Kubectl leaves the pod behind on exit, so we register
// a cleanup descriptor with the session and the backend deletes the pod
// when the terminal tab closes. The pod's name is auto-generated by kubectl
// (`node-debugger-<node>-<rand>`) — `--custom` only patches the container
// spec, not pod metadata, so we can't pin it up front. Instead the backend
// scrapes the actual name from kubectl's first stdout line ("Creating
// debugging pod <name> with container …") and writes it into the cleanup
// descriptor before close.
function openNodeDebugTab(
  clusterId: string,
  contextLabel: string,
  nodeName: string,
  addDockTab: (tab: import("../store").DockTab) => void,
): void {
  addDockTab(
    makeTerminalTab(
      {
        mode: "kubectl",
        clusterId,
        namespace: null,
        args: [
          "debug",
          `node/${nodeName}`,
          "-it",
          // Pin the debug pod to the `default` namespace explicitly.
          // Without this kubectl drops it into the kubeconfig's current
          // namespace, which can be anything (kube-system, the user's
          // workload ns, …) — and the cleanup hook below would then look
          // in `default` and 404. Forcing both ends to `default` keeps
          // create + delete in sync.
          "-n",
          "default",
          "--image=alpine:3.20",
          "--profile=sysadmin",
          // Land the operator inside the actual node filesystem, like
          // Lens / `kubectl debug`-via-`chroot` does. `--profile=sysadmin`
          // mounts the host root at `/host`; without the chroot the user
          // sits in alpine's own root and `/etc`, `/var/log`, etc. are
          // the debug pod's, not the node's. The inner `sh -c …` lets
          // bash win if the host has it (almost always does — RHEL,
          // Fedora, Ubuntu, …) and falls back to sh on minimal nodes.
          "--",
          "chroot",
          "/host",
          "sh",
          "-c",
          "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
        ],
        label: `node-debug ${nodeName}`,
        // Empty `name` is the signal to the backend output scanner that it
        // should fill it in from kubectl's "Creating debugging pod …" line.
        cleanup: { namespace: "default", name: "" },
      },
      contextLabel,
    ),
  );
}

function isNodeCordoned(row: ResourceRow): boolean {
  // The node row projection writes "SchedulingDisabled" into `phase` when the
  // kubelet reports Ready but spec.unschedulable=true. There's no separate
  // boolean on the row, so derive cordon state from that label — the rest of
  // the UI uses the same string everywhere (StatusPill, detail header).
  return row.phase === "SchedulingDisabled";
}

function summarizeDrain(
  node: string,
  report: import("../types").DrainReport,
): void {
  const ev = report.evicted.length;
  const sk = report.skipped.length;
  const fl = report.failures.length;
  const headline = `Drain ${node}: ${ev} evicted, ${sk} skipped${fl > 0 ? `, ${fl} failed` : ""}.`;
  if (fl > 0) {
    const lines = report.failures
      .slice(0, 8)
      .map((f) => `${f.namespace}/${f.pod}: ${f.error}`)
      .join("\n");
    const more =
      report.failures.length > 8
        ? `\n…and ${report.failures.length - 8} more`
        : "";
    toast.bad(`${headline}\n${lines}${more}`);
  } else {
    toast.ok(headline);
  }
}

function SortCaret({
  dir,
  t,
}: {
  dir: "asc" | "desc" | false;
  t: ReturnType<typeof tokens>;
}) {
  // Tiny down-chevron, rotated 180° on asc. Reuses Icons.chevD via inline
  // rotation — keeping the icon set centralized per CLAUDE.md.
  if (!dir) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        transform: dir === "asc" ? "rotate(180deg)" : "none",
        color: t.text,
        opacity: 0.85,
      }}
    >
      {Icons.chevD}
    </span>
  );
}

// Click and context-menu propagate to the scroll container's delegated
// handlers (see ResourceTable's scrollRef element). We wrap Row in
// `memo` so a stale row whose props haven't changed (uid + selected +
// checked + t) skips its body entirely. `children` still differ each
// render — those are the cells, which TanStack rebuilds — so memo's
// real win is only on hover-driven re-renders that don't touch the
// children list. Combined with delegated events, per-row work during
// scroll drops sharply.
const Row = memo(function Row({
  uid,
  t,
  selected,
  checked,
  children,
}: {
  uid: string;
  t: ReturnType<typeof tokens>;
  selected: boolean;
  checked?: boolean;
  children: React.ReactNode;
}) {
  const baseBg = checked ? t.accentSoft : selected ? t.hover : "transparent";
  return (
    <div
      data-uid={uid}
      onMouseEnter={(e) => {
        if (!checked && !selected) e.currentTarget.style.background = t.hover;
      }}
      onMouseLeave={(e) => {
        if (!checked && !selected)
          e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "flex",
        cursor: "pointer",
        background: baseBg,
        borderBottom: `1px solid ${t.borderSoft}`,
        color: t.text,
      }}
    >
      {children}
    </div>
  );
});

function rightAlign(id: string): boolean {
  return (
    id === "ready" ||
    id === "restarts" ||
    id === "replicas" ||
    id === "available" ||
    id === "count" ||
    id === "size" ||
    id === "keys" ||
    id === "data" ||
    id === "ports" ||
    id === "cpu" ||
    id === "mem" ||
    id === "age"
  );
}

// Lazily-allocated canvas for measureText. Way faster than DOM-based
// measurement (no layout, no reflow) and accurate enough for the cell
// font we control. Reused across all table instances.
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureText(text: string, font: string): number {
  if (!_measureCtx && typeof document !== "undefined") {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!_measureCtx) return text.length * 7; // SSR / unsupported fallback
  if (_measureCtx.font !== font) _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

// Cell font strings used by canvas measureText for column-width fitting.
// Canvas cannot resolve CSS custom properties, so these must reference a
// literal font family. We use the Default theme's JetBrains Mono — themes
// that pick a different mono will have slightly off measurements, but the
// resize handles still let the operator tune column widths interactively.
const CELL_FONT_TEXT = "12px system-ui, -apple-system, Segoe UI, sans-serif";
const CELL_FONT_MONO = `12px ${FONT_MONO}`;
const HEADER_FONT = `700 10.5px ${FONT_MONO}`;

function isMonoCell(c: ColumnDef): boolean {
  if (c.id === "name" || c.id === "namespace" || c.id === "node") return true;
  switch (c.kind) {
    case "age":
    case "number":
      return true;
    default:
      return false;
  }
}

// Measure the longest rendered string in this column across a sample of
// rows AND the header label, so the column never collapses below either.
// Returns the column's "natural" width — what the data + header actually
// want — floored at min and uncapped above (the caller decides). The
// chrome pad covers the sort caret (~14 px when active), letter-spacing
// on the uppercase header, and a small breathing room so text doesn't
// kiss the right edge.
function naturalContentWidth(c: ColumnDef, sample: ResourceRow[]): number {
  const CHROME_PAD = 28;
  const headerWidth =
    measureText(String(c.header ?? "").toUpperCase(), HEADER_FONT) * 1.12;

  // Phase column renders StatusPill (when non-ambient) + ContainerDots
  // (when the row carries `container_states`, i.e. pods). Plain
  // measureText on the status string under-counts by the pill chrome
  // and the dots row — the operator sees `CrashLoopBackOff` followed
  // by 8 container dots overflow a column sized for the bare text.
  // Mirror the rendering math from `renderCell`'s `phase` branch.
  if (c.kind === "phase") {
    // Dense StatusPill chrome: 1px×6px padding + 4px gap + 5px inner
    // dot ≈ 21px around the text glyphs.
    const PILL_FONT = `600 10.5px system-ui, -apple-system, Segoe UI, sans-serif`;
    const PILL_CHROME = 21;
    const PHASE_WRAP_GAP = 8; // PHASE_WRAP's gap between pill and dots
    const DOT_SIZE = 7; // size prop on ContainerDots in ResourceTable
    const DOT_GAP = 3;
    const SEP_WIDTH = 1 + (DOT_GAP + 1) * 2; // separator + its margins

    let maxRendered = 0;
    for (const r of sample) {
      const phase = typeof r[c.id] === "string" ? String(r[c.id]) : "";
      // Ambient (Running / Terminating) suppresses the pill on pod
      // rows — see `renderCell`'s `phase` branch.
      const ambient = phase === "Running" || phase === "Terminating";
      const states = Array.isArray(r.container_states)
        ? (r.container_states as Array<Record<string, unknown>>)
        : [];
      const isPodRow = states.length > 0;
      const pillWidth =
        isPodRow && ambient ? 0 : measureText(phase, PILL_FONT) + PILL_CHROME;

      let dotsWidth = 0;
      if (isPodRow) {
        let inits = 0;
        let mainsAndSidecars = 0;
        for (const s of states) {
          if (s.kind === "init") inits++;
          else mainsAndSidecars++;
        }
        const total = inits + mainsAndSidecars;
        // Main dots are size+2, init/sidecar are size — average to
        // (size+1) per dot since we don't track which is which here.
        dotsWidth =
          total * (DOT_SIZE + 1) + Math.max(0, total - 1) * DOT_GAP;
        if (inits > 0 && mainsAndSidecars > 0) dotsWidth += SEP_WIDTH;
      }

      const gap = pillWidth > 0 && dotsWidth > 0 ? PHASE_WRAP_GAP : 0;
      const rendered = pillWidth + gap + dotsWidth;
      if (rendered > maxRendered) maxRendered = rendered;
    }
    return Math.ceil(Math.max(maxRendered, headerWidth)) + CHROME_PAD;
  }

  const font = isMonoCell(c) ? CELL_FONT_MONO : CELL_FONT_TEXT;
  let dataWidth = 0;
  for (const r of sample) {
    const v = r[c.id];
    if (typeof v !== "string" && typeof v !== "number") continue;
    const w = measureText(String(v), font);
    if (w > dataWidth) dataWidth = w;
  }
  return Math.ceil(Math.max(dataWidth, headerWidth)) + CHROME_PAD;
}

function defaultWidth(c: ColumnDef): number {
  if (c.id === "name") return 320;
  if (c.id === "namespace") return 160;
  if (c.id === "node") return 180;
  if (c.id === "ready") return 80;
  if (c.id === "cpu" || c.id === "mem") return 90;
  switch (c.kind) {
    case "phase":
      // No-data fallback: room for a "CrashLoopBackOff" pill (~140px
      // dense) plus a typical handful of container dots without
      // overflowing. Once rows arrive `naturalContentWidth` takes over
      // with a per-row exact calculation.
      return 220;
    case "age":
      return 80;
    case "number":
      return 100;
    default:
      return 140;
  }
}

// Lower bound the auto-fit will shrink a column to. Below this the cell
// content is unreadable; the table prefers to overflow + horizontal-scroll.
function minWidth(c: ColumnDef): number {
  if (c.id === "name") return 140;
  if (c.id === "namespace") return 90;
  if (c.id === "node") return 100;
  if (c.id === "ready") return 60;
  if (c.id === "cpu" || c.id === "mem") return 60;
  switch (c.kind) {
    case "phase":
      // Pill text alone (e.g. "CrashLoopBackOff") needs ~140px in
      // dense mode — the previous 90px clipped both the pill and any
      // container dots beside it. The shrink tier prefers to take
      // from Name first, so this only kicks in on very narrow viewports.
      return 140;
    case "age":
      return 50;
    case "number":
      return 60;
    default:
      return 80;
  }
}

// Default sort matches the previous hand-rolled order: namespace asc,
// name asc. Cluster-scoped kinds (no namespace column) fall back to name.
// Default sort is a single column. Multi-column sort is still available
// via shift-click, but shipping it on by default rendered two carets at
// once (namespace + name) and read like a bug — the operator couldn't
// tell which column "owned" the order. A single primary sort by Name is
// what every comparable resource browser does on first paint.
function defaultSorting(_kind: ResourceKind): SortingState {
  return [{ id: "name", desc: false }];
}

// Decide the initial sort state for a (cluster, kind). Falls back to
// `defaultSorting` when nothing is persisted, and clamps any persisted
// multi-column sort to its primary entry so legacy state from earlier
// builds (which defaulted to namespace + name) doesn't carry forward as
// a confusing two-caret view.
function sortingFromPersisted(
  persisted: SortingState | undefined,
  kind: ResourceKind,
): SortingState {
  if (!persisted || persisted.length === 0) return defaultSorting(kind);
  return [persisted[0]!];
}

// Per-column sort accessor. `age` and `number` need numeric comparison;
// everything else falls back to a stringified value the default
// localeCompare-like sort handles fine.
function accessorFor(c: ColumnDef) {
  if (c.kind === "age") {
    return (row: ResourceRow): number => {
      const v = row[c.id];
      if (typeof v !== "string") return 0;
      const ms = Date.parse(v);
      // Newer first when desc=false reads naturally — but we keep raw
      // millis here and let the comparator decide direction.
      return Number.isNaN(ms) ? 0 : ms;
    };
  }
  if (c.kind === "number") {
    return (row: ResourceRow): number => {
      const v = row[c.id];
      if (typeof v === "number") return v;
      const n = Number(v);
      return Number.isNaN(n) ? 0 : n;
    };
  }
  return (row: ResourceRow): string => {
    const v = row[c.id];
    if (v == null) return "";
    return String(v);
  };
}

// `phase` sorts by status bucket so CrashLoopBackOff floats above Running
// when ascending — what the operator usually wants. Pods' CPU/Mem are
// metrics-server values, joined here so the sort matches what's rendered.
function sortingFnFor(
  c: ColumnDef,
  podMetrics: Record<string, { cpu_milli: number; mem_mib: number }> | null,
  isPods: boolean,
) {
  if (c.kind === "phase") {
    return (a: TanRow<ResourceRow>, b: TanRow<ResourceRow>) => {
      const av = phaseRank(String(a.original[c.id] ?? ""));
      const bv = phaseRank(String(b.original[c.id] ?? ""));
      return av - bv;
    };
  }
  if (isPods && (c.id === "cpu" || c.id === "mem")) {
    return (a: TanRow<ResourceRow>, b: TanRow<ResourceRow>) => {
      const ak = `${a.original.namespace ?? ""}/${a.original.name ?? ""}`;
      const bk = `${b.original.namespace ?? ""}/${b.original.name ?? ""}`;
      const av = podMetrics?.[ak] ?? null;
      const bv = podMetrics?.[bk] ?? null;
      const an = av ? (c.id === "cpu" ? av.cpu_milli : av.mem_mib) : -1;
      const bn = bv ? (c.id === "cpu" ? bv.cpu_milli : bv.mem_mib) : -1;
      return an - bn;
    };
  }
  // Fall back to TanStack's auto sort (string locale-aware / numeric on
  // accessor-typed columns).
  return "auto" as const;
}

// Severity ordering used for `phase` sorts. Bad first when ascending
// matches the operator's mental model — they look for problems first.
function phaseRank(p: string): number {
  switch (p) {
    case "Failed":
    case "CrashLoopBackOff":
    case "OOMKilled":
    case "Error":
      return 0;
    case "ImagePullBackOff":
    case "ErrImagePull":
    case "Evicted":
      return 1;
    case "Pending":
    case "ContainerCreating":
    case "Init":
      return 2;
    case "Terminating":
      return 3;
    case "Running":
      return 4;
    case "Succeeded":
    case "Completed":
      return 5;
    default:
      return 6;
  }
}

export function renderCell(
  c: ColumnDef,
  row: ResourceRow,
  mode: ThemeMode,
  t: ReturnType<typeof tokens>,
  isPods: boolean,
  podMetrics: Record<string, { cpu_milli: number; mem_mib: number }> | null,
  monoTables: boolean,
  navigateToDetail: (
    kindId: string,
    namespace: string | null,
    name: string,
  ) => void,
  setSelectedNamespaces: (ns: Set<string>) => void,
) {
  const value = row[c.id];

  // CPU / Mem on the Pods table are projected as null on the backend
  // (metrics-server fills them in via a side channel). Keep this branch
  // ahead of the generic null guard so an absent backend value doesn't
  // short-circuit the metrics-snapshot lookup.
  if (isPods && (c.id === "cpu" || c.id === "mem")) {
    const ns = typeof row.namespace === "string" ? row.namespace : "";
    const name = typeof row.name === "string" ? row.name : "";
    const live = podMetrics
      ? podMetrics[`${ns}/${name}`] ?? podMetrics[`/${name}`] ?? null
      : null;
    const n: number | null = live
      ? c.id === "cpu"
        ? live.cpu_milli
        : live.mem_mib
      : null;
    return (
      <span style={{ ...NUM_CELL_BASE, color: t.textDim }}>
        {n == null ? "—" : c.id === "cpu" ? `${n}m` : formatMi(n)}
      </span>
    );
  }

  if (value === null || value === undefined) {
    return <span style={{ color: t.textMuted }}>—</span>;
  }
  switch (c.kind) {
    case "phase": {
      // For pods, ContainerDots already carry the per-container state — so
      // we drop the redundant pod-level dot and only render a labelled
      // StatusPill when the phase is non-ambient (Pending, CrashLoopBackOff,
      // OOMKilled, Init, Completed, etc.). When everything is healthy the
      // cell shows just the dots and reads quietly per P1.
      const phase = String(value);
      if (isPods) {
        const states = Array.isArray(row.container_states)
          ? (row.container_states as Array<Record<string, unknown>>)
          : [];
        const containers: ContainerLite[] = states.map((s) => ({
          name: typeof s.name === "string" ? s.name : "",
          status: typeof s.state === "string" ? s.state : phase,
          kind:
            s.kind === "init" || s.kind === "sidecar" || s.kind === "main"
              ? (s.kind as "init" | "main" | "sidecar")
              : "main",
        }));
        const ambient = phase === "Running" || phase === "Terminating";
        return (
          <span style={PHASE_WRAP}>
            {!ambient && (
              <StatusPill status={phase} t={t} mode={mode} dense />
            )}
            {containers.length > 0 && (
              <ContainerDots
                containers={containers}
                t={t}
                size={7}
                showSeparator={containers.some((c) => c.kind === "init")}
              />
            )}
          </span>
        );
      }
      return <StatusPill status={phase} t={t} mode={mode} dense />;
    }
    case "age":
      // Self-contained subscriber to NowContext — re-renders once per
      // 1 Hz tick without dragging the whole row through reconciliation.
      return <AgeCell value={value} color={t.textMuted} />;
    case "number": {
      // Special-case the columns whose number means something:
      // restarts colors by severity (>5 red, >0 amber) per HV2PodTable;
      // cpu / mem render with units when the backend has a value.
      if (c.id === "restarts") {
        const n = Number(value) || 0;
        const color = n > 5 ? t.bad : n > 0 ? t.warn : t.textDim;
        return (
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              color,
              fontWeight: n > 0 ? 600 : 400,
            }}
          >
            {n}
          </span>
        );
      }
      // cpu / mem for non-pod kinds (or when isPods is false) — handled by
      // the generic number renderer below.
      return (
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            color: t.textDim,
          }}
        >
          {String(value)}
        </span>
      );
    }
    default: {
      const raw = String(value);
      // Quantity-shaped columns (Node table's `cpu` / `memory` ship as raw
      // K8s Quantity strings like "16384000Ki") render in a friendlier
      // unit. Pod cpu/mem already go through their own renderer above
      // (live metrics from metrics-server); this branch covers the static
      // capacity strings from kubelet.
      const isQty = c.id === "cpu" || c.id === "memory";
      const display = isQty ? formatQuantity(c.id, raw === "" ? null : raw) : raw;
      // R-07: identifiers (name, namespace, image, IP-ish) get mono — but
      // the operator can override via Settings → Appearance → Mono in tables.
      const mono =
        isQty ||
        (monoTables &&
          (c.id === "name" ||
            c.id === "namespace" ||
            c.id === "image" ||
            c.id === "node" ||
            c.id === "host" ||
            c.id === "uid" ||
            c.id === "ip" ||
            c.id === "cluster_ip"));
      // Namespace cells globally pin the namespace filter; node cells open the
      // node's detail panel. Both stop propagation so the delegated row click
      // (which opens *this* row's detail) doesn't also fire. Style stays as is
      // — only a pointer cursor signals the affordance.
      const isNsLink = c.id === "namespace" && raw !== "";
      const isNodeLink = c.id === "node" && raw !== "";
      const clickable = isNsLink || isNodeLink;
      const onClick = clickable
        ? (e: React.MouseEvent) => {
            e.stopPropagation();
            if (isNsLink) {
              setSelectedNamespaces(new Set([raw]));
            } else if (isNodeLink) {
              navigateToDetail("nodes", null, raw);
            }
          }
        : undefined;
      return (
        <span
          title={isQty && raw !== "" ? raw : undefined}
          onClick={onClick}
          style={{
            fontFamily: mono ? FF_MONO : "inherit",
            fontSize: mono ? 11.5 : 12,
            color: c.id === "namespace" ? t.textDim : t.text,
            fontVariantNumeric: isQty ? "tabular-nums" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
            cursor: clickable ? "pointer" : undefined,
          }}
        >
          {display}
        </span>
      );
    }
  }
}

function formatMi(mb: number): string {
  // Mirrors design/data.jsx fmtMi.
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} Gi` : `${mb} Mi`;
}

function formatAge(value: unknown, nowMs: number): string {
  if (typeof value !== "string") return "—";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "—";
  let s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
