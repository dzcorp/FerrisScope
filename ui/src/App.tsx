import { logErr, reportErr } from "./lib/log";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, onPortForwardStatus, onResourceDelta } from "./api";
import {
  buildPrefsPayload,
  selectActiveClusterIds,
  selectClusterDegraded,
  useActiveClusterIds,
  useAppStore,
  useClusterLabels,
  useResolvedTheme,
  type ClusterTab,
  type SelectionMeta,
} from "./store";
import type { AppInfo, ResourceKind } from "./types";
import {
  FONT_SANS,
  UI_SCALE_BASELINE,
  UI_SCALE_DEFAULT,
  R_LG,
  FS_MD,
  clusterAccent,
} from "./theme";
import { AppHeader } from "./components/AppHeader";
import {
  TitleBar,
  ResizeEdges,
  TITLEBAR_INSET_PX,
} from "./components/TitleBar";
import { Rail } from "./components/Rail";
import { ClusterPanel } from "./components/ClusterPanel";
import { VirtualClusterPanel } from "./components/VirtualClusterPanel";
import { FleetLanding } from "./components/FleetLanding";
import { CommandPalette } from "./components/CommandPalette";
import { NamespaceModal } from "./components/NamespaceModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { BulkBar, type BulkAction } from "./components/BulkBar";
import {
  ComparePanel,
  compareTargetFromSelection,
  type CompareTarget,
} from "./components/ComparePanel";
import {
  InspectPanel,
  inspectTargetFromSelection,
  type InspectTarget,
} from "./components/inspect";
import {
  LogPanel,
  OBSERVABLE_KIND_IDS,
  type ObserveTab,
  type ObserveTarget,
} from "./components/LogPanel";
import { Dock, makeTerminalTab, makeYamlTab } from "./components/Dock";
import { ModalHost } from "./components/ModalHost";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { PortForwardsPanel } from "./components/PortForwardsPanel";
import { confirm, toast } from "./lib/dialog";
import {
  bulkClusterPrefix,
  clusterColorIndexMap,
  namespaceClusterTags,
} from "./lib/multiCluster";
import { IS_MAC } from "./lib/keyboard";
import { goToFleet } from "./lib/clusterTabs";
import { hotkeyIntent, intentPreventsDefault } from "./lib/hotkeys";
import { applyThemeCssVars } from "./lib/themeDom";
import { Icons } from "./components/ui";

const RAIL_COLLAPSED_W = 56;
const RAIL_OPEN_W = 220;

// Top-level shell. Owns the global keyboard layer (P3 + R-13) and renders
// every overlay (palette, settings, namespace modal, bulk bar, dock).
export default function App() {
  const [, setInfo] = useState<AppInfo | null>(null);
  const [, setReady] = useState(false);
  // Discovered namespaces across the active clusters, keyed by namespace
  // name → cluster ids that have it. The ns modal lists the sorted union;
  // in multi-cluster views it also labels namespaces that exist on only a
  // subset of the members.
  const [nsClusters, setNsClusters] = useState<Record<string, string[]>>({});
  const discoveredNs = useMemo(
    () => Object.keys(nsClusters).sort(),
    [nsClusters],
  );

  const themeMode = useAppStore((s) => s.themeMode);
  const themeId = useAppStore((s) => s.themeId);
  const paletteId = useAppStore((s) => s.paletteId);
  const themeOverrides = useAppStore((s) => s.themeOverrides);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const selectedContextName = useAppStore((s) => s.selectedContext);
  const selectedVirtualContextId = useAppStore(
    (s) => s.selectedVirtualContextId,
  );
  const virtualContexts = useAppStore((s) => s.virtualContexts);
  const scopeExtras = useAppStore((s) => s.scopeExtras);
  const selectContext = useAppStore((s) => s.selectContext);
  const selectedContext = useAppStore(
    (s) => s.contexts.find((c) => c.id === s.selectedContext) ?? null,
  );
  const contexts = useAppStore((s) => s.contexts);
  const allVirtualContexts = useAppStore((s) => s.virtualContexts);
  // Physical cluster set the app is observing: virtual-context members (or
  // the single selected context) plus any ad-hoc scope extras. Stable
  // identity — effects key on it.
  const activeClusterIds = useActiveClusterIds();
  const activeClusterKey = activeClusterIds.join(String.fromCharCode(0));
  const activeVirtualContext = useAppStore((s) =>
    s.selectedVirtualContextId
      ? s.virtualContexts.find((v) => v.id === s.selectedVirtualContextId) ??
        null
      : null,
  );
  // Resolved ContextInfos for the active multi-cluster scope, memoized so
  // VirtualClusterPanel's member fan stays referentially stable.
  const activeContexts = useMemo(
    () =>
      activeClusterIds
        .map((id) => contexts.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c != null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeClusterKey, contexts],
  );
  // Short display names for every cluster, shared by the Dock's tab titles,
  // the header crumb's multi-cluster summary and the bulk-failure prefixes.
  const clusterLabels = useClusterLabels();
  // Primary (first) cluster of a tab's scope — feeds the Dock's "new terminal"
  // default and chat target. Only meaningful for the visible (active) tab;
  // inactive Dock pairs are hidden, so a best-effort fallback is fine.
  const tabPrimaryContext = useCallback(
    (tab: ClusterTab): { id: string; name: string } => {
      const ids = selectActiveClusterIds({
        contexts,
        selectedContext: tab.selectedContext,
        virtualContexts: allVirtualContexts,
        selectedVirtualContextId: tab.selectedVirtualContextId,
        scopeExtras: tab.scopeExtras,
      });
      const first = ids[0] ?? "";
      const c = contexts.find((cc) => cc.id === first);
      return {
        id: first,
        name: clusterLabels[first]?.short ?? c?.name ?? first,
      };
    },
    [contexts, allVirtualContexts, clusterLabels],
  );
  const multiClusterActive =
    activeVirtualContext !== null || activeClusterIds.length > 1;
  // Origin labels for the namespace modal: a namespace that exists on only
  // a subset of the active members gets compressed cluster-name chips in
  // the member's accent color. undefined in single-cluster views and when
  // every namespace is everywhere — the modal renders nothing extra then.
  const nsTags = useMemo(() => {
    if (activeContexts.length < 2) return undefined;
    const tags = namespaceClusterTags(
      nsClusters,
      activeContexts.map((c) => ({
        id: c.id,
        name: clusterLabels[c.id]?.short ?? c.name,
      })),
    );
    const colorIdx = clusterColorIndexMap(activeContexts.map((c) => c.id));
    const out: Record<string, { label: string; color: string }[]> = {};
    for (const [ns, entries] of Object.entries(tags)) {
      out[ns] = entries.map((e) => ({
        label: e.label,
        color: clusterAccent(colorIdx[e.clusterId] ?? 0),
      }));
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [activeContexts, nsClusters]);
  const selectedKindLabel = useAppStore((s) => {
    const k = s.kinds.find((kk) => kk.id === s.selectedKindId);
    return k ? k.kind : null;
  });
  const selectedKind = useAppStore((s) =>
    s.kinds.find((kk) => kk.id === s.selectedKindId),
  );
  // Kind-name -> registry-id resolution for the Inspect drawer's cross-kind
  // links (a pod row's Pod / Node names).
  const kinds = useAppStore((s) => s.kinds);
  const navigateToDetail = useAppStore((s) => s.navigateToDetail);

  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const openPalette = useAppStore((s) => s.openPalette);
  const filterEditing = useAppStore((s) => s.filterEditing);
  const openFilterEditor = useAppStore((s) => s.openFilterEditor);
  const closeFilterEditor = useAppStore((s) => s.closeFilterEditor);
  const closePalette = useAppStore((s) => s.closePalette);
  const nsModalOpen = useAppStore((s) => s.nsModalOpen);
  const openNsModal = useAppStore((s) => s.openNsModal);
  const closeNsModal = useAppStore((s) => s.closeNsModal);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const addMenuOpen = useAppStore((s) => s.addMenuOpen);
  const setAddMenuOpen = useAppStore((s) => s.setAddMenuOpen);

  const selection = useAppStore((s) => s.selection);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const bulkClusterHealth = useAppStore((s) => s.clusterHealth);
  const bulkClusterReconnecting = useAppStore((s) => s.clusterReconnecting);
  // True when the current selection touches any degraded cluster. Mutating
  // bulk actions disable; read actions (Copy/Compare/Observe) stay live.
  const selectionDegraded = useMemo(
    () =>
      Array.from(selection.values()).some((m) =>
        selectClusterDegraded(
          {
            clusterHealth: bulkClusterHealth,
            clusterReconnecting: bulkClusterReconnecting,
          },
          m.clusterId,
        ),
      ),
    [selection, bulkClusterHealth, bulkClusterReconnecting],
  );
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);
  // Display name for a cluster id in bulk-failure prefixes. Imperative read —
  // resolved inside click handlers, so no store subscription is needed.
  const clusterLabelFor = (cid: string) =>
    clusterLabels[cid]?.short ??
    useAppStore.getState().contexts.find((c) => c.id === cid)?.name ??
    cid;

  // YAML compare drawer — armed from the bulk bar when exactly two rows of
  // one kind are selected (any kind; the killer use is the same object on
  // two members of a virtual context).
  const [compareTarget, setCompareTarget] = useState<CompareTarget | null>(
    null,
  );
  const compareActions = (): BulkAction[] => {
    if (!selectedKind || selection.size !== 2) return [];
    return [
      {
        icon: Icons.yaml,
        label: "Compare YAML",
        onClick: () => {
          const colorIdx = clusterColorIndexMap(activeClusterIds);
          const target = compareTargetFromSelection(
            selection,
            selectedKind.id,
            selectedKind.kind,
            clusterLabelFor,
            (cid) => colorIdx[cid] ?? 0,
          );
          if (target) setCompareTarget(target);
        },
      },
    ];
  };

  // Structured N-way comparison drawer — any kind, 2+ selected. Sibling to
  // Compare YAML: that one diffs a pair's raw manifests, this one compares
  // fields across N and merges their events and pods.
  const [inspectTarget, setInspectTarget] = useState<InspectTarget | null>(
    null,
  );
  const inspectActions = (): BulkAction[] => {
    if (!selectedKind || selection.size < 2) return [];
    return [
      {
        icon: Icons.layers,
        label: "Inspect",
        onClick: () => {
          const colorIdx = clusterColorIndexMap(activeClusterIds);
          const target = inspectTargetFromSelection(
            selection,
            selectedKind.id,
            selectedKind.kind,
            clusterLabelFor,
            (cid) => colorIdx[cid] ?? 0,
          );
          if (target) setInspectTarget(target);
        },
      },
    ];
  };

  // Aggregated logs/metrics drawer — armed from the bulk bar for pods and
  // pod-bearing workloads (deployments, statefulsets, daemonsets,
  // replicasets, jobs). The selection may span clusters; the panel groups
  // its resolve calls per cluster.
  const [observeTarget, setObserveTarget] = useState<{
    targets: ObserveTarget[];
    initialTab: ObserveTab;
  } | null>(null);
  const observeActions = (): BulkAction[] => {
    if (
      !selectedKind ||
      !OBSERVABLE_KIND_IDS.has(selectedKind.id) ||
      selection.size === 0
    ) {
      return [];
    }
    const open = (initialTab: ObserveTab) => () => {
      const targets: ObserveTarget[] = [];
      for (const meta of selection.values()) {
        // Pods and the observable workloads are all namespaced; a null
        // namespace means a malformed row — skip it rather than send a
        // request the backend will 404.
        if (!meta.namespace) continue;
        targets.push({
          clusterId: meta.clusterId,
          kindId: selectedKind.id,
          namespace: meta.namespace,
          name: meta.name,
        });
      }
      if (targets.length > 0) setObserveTarget({ targets, initialTab });
    };
    return [
      { icon: Icons.logs, label: "Logs", onClick: open("logs") },
      { icon: Icons.gauge, label: "Metrics", onClick: open("metrics") },
    ];
  };

  const openNotifications = useAppStore((s) => s.openNotifications);
  const openForwardsPanel = useAppStore((s) => s.openForwardsPanel);
  // Active = anything that isn't fully stopped. The store removes stopped
  // entries on Stopped events, so a count of forwards.length is correct.
  const activeForwards = useAppStore((s) => Object.keys(s.forwards).length);
  const unreadNotifications = useAppStore((s) => {
    const since = s.notificationsSeenAt;
    return s.notifications.reduce(
      (n, x) => (x.createdAt > since ? n + 1 : n),
      0,
    );
  });

  const selectedNamespaces = useAppStore((s) => s.selectedNamespaces);
  const setSelectedNamespaces = useAppStore((s) => s.setSelectedNamespaces);

  const dockTabs = useAppStore((s) => s.dockTabs);
  const addDockTab = useAppStore((s) => s.addDockTab);
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const railMode = useAppStore((s) => s.railMode);
  const dockSize = useAppStore((s) => s.dockSize);
  const clearMetrics = useAppStore((s) => s.clearMetrics);
  const hydrateForwards = useAppStore((s) => s.hydrateForwards);
  const applyForwardStatus = useAppStore((s) => s.applyForwardStatus);
  const hydrateTableViews = useAppStore((s) => s.hydrateTableViews);
  const hydratePrefs = useAppStore((s) => s.hydratePrefs);
  const settings = useAppStore((s) => s.settings);
  const uiScale = useAppStore((s) => s.settings.uiScale);
  const bumpUiScale = useAppStore((s) => s.bumpUiScale);
  const resetUiScale = useAppStore((s) => s.resetUiScale);
  const selectedKindId = useAppStore((s) => s.selectedKindId);
  const updateState = useAppStore((s) => s.updateState);
  const setAppVersion = useAppStore((s) => s.setAppVersion);
  const patchUpdateState = useAppStore((s) => s.patchUpdateState);
  const autoCheckEnabled = updateState.autoCheckEnabled;
  // Set once after the initial prefs load — gates the persist effect so the
  // hydration write doesn't immediately echo defaults back to disk.
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // macOS: keep the native window appearance in lockstep with the app theme so
  // the title-bar vibrancy material (and traffic-light rendering) matches —
  // light theme → light frost, dark theme → dark frost. No-op elsewhere.
  useEffect(() => {
    if (!IS_MAC) return;
    getCurrentWindow()
      .setTheme(themeMode)
      .catch(logErr("app"));
  }, [themeMode]);

  // Global UI scale via the webview's native page-zoom API. Routes to
  // WKWebView setPageZoom (macOS), webkit_web_view_set_zoom_level
  // (Linux), and the WebView2 zoom factor (Windows) — all of which
  // rescale layout *and* paint uniformly. CSS `zoom` did paint-only on
  // macOS WebKit, which caused the root 100vw/100vh box to overflow the
  // window above 1.0× and under-fill below. The applied factor is the
  // user-facing slider value multiplied by a hidden baseline so "100 %"
  // in Settings already renders 10 % larger than the raw theme baseline.
  // The Rust setup() pre-applies the persisted scale to the main webview
  // before the first paint; this effect keeps it in lockstep with the
  // slider afterward.
  useEffect(() => {
    getCurrentWebviewWindow()
      .setZoom(uiScale * UI_SCALE_BASELINE)
      .catch(logErr("app"));
  }, [uiScale]);

  useEffect(() => {
    api
      .ping()
      .then(setInfo)
      .catch(logErr("app"));
    api
      .getTableViews()
      .then((file) => hydrateTableViews(file.views))
      .catch(reportErr("app", "Couldn't load saved table views"));
    api
      .getPrefs()
      .then((p) => hydratePrefs(p))
      .catch(reportErr("app", "Couldn't load preferences — using defaults"))
      .finally(() => setPrefsLoaded(true));
    const unlisten = listen<void>("app://ready", () => setReady(true));

    // Port-forwards: hydrate from backend (which already restarted any pinned
    // entries from portforwards.json), then keep the store in lockstep with
    // every status transition. Listener mounts before the hydrate fetch so
    // an event that fires mid-await doesn't get lost.
    let unlistenPf: (() => void) | null = null;
    onPortForwardStatus((evt) => applyForwardStatus(evt.id, evt.status))
      .then((fn) => {
        unlistenPf = fn;
      })
      .catch(logErr("app"));
    api
      .pfList()
      .then((entries) => hydrateForwards(entries))
      .catch(reportErr("app", "Couldn't restore port-forwards"));

    return () => {
      unlisten.then((fn) => fn());
      if (unlistenPf) unlistenPf();
    };
  }, [hydrateTableViews, hydratePrefs, hydrateForwards, applyForwardStatus]);

  // Persist prefs whenever any of the watched fields change. Debounced so
  // dragging the refresh-interval slider doesn't pummel the disk. The
  // selection state (cluster, kind, namespaces, rail pin) rides the same
  // debounce — they all coalesce into one prefs.json write.
  useEffect(() => {
    if (!prefsLoaded) return;
    const t = setTimeout(() => {
      // Full-object write: the payload builder round-trips every persisted
      // field, so a field missing from the deps below would still be written
      // with its current value (it would just not trigger the write).
      api
        .setPrefs(buildPrefsPayload(useAppStore.getState()))
        .catch(logErr("app"));
    }, 250);
    return () => clearTimeout(t);
  }, [
    prefsLoaded,
    themeMode,
    themeId,
    paletteId,
    themeOverrides,
    railMode,
    selectedContextName,
    selectedVirtualContextId,
    virtualContexts,
    scopeExtras,
    selectedKindId,
    selectedNamespaces,
    settings,
    dockSize,
    updateState,
  ]);

  // Boot-time: cache the running app's CARGO_PKG_VERSION so the
  // `selectUpdateAvailable` derivation has a baseline to compare against.
  // Cheap, no-cluster Tauri call — runs once, ignored on failure.
  useEffect(() => {
    api
      .updaterInfo()
      .then((info) => setAppVersion(info.current_version))
      .catch(logErr("app"));
  }, [setAppVersion]);

  // Periodic background update check. First run 15s after launch (don't
  // compete with cluster connect / prefs hydrate for early bandwidth);
  // then every 6h while the window is open. Failures are silent — we
  // don't surface a toast for every flaky-network 6h cycle.
  useEffect(() => {
    if (!autoCheckEnabled) return;
    const run = () => {
      api
        .checkForUpdate()
        .then((out) => {
          const now = Date.now();
          if (out.kind === "update_available") {
            const v = out.release.version;
            const prev = useAppStore.getState().updateState.lastKnownVersion;
            const seen = useAppStore.getState().updateState.lastSeenVersion;
            patchUpdateState({ lastKnownVersion: v, lastCheckAt: now });
            // One-time notification: only fire when this is a freshly-
            // discovered version the user hasn't already skipped. The bell
            // log keeps the breadcrumb; the Settings → About dot is the
            // durable signal.
            if (prev !== v && seen !== v) {
              toast.info(
                `FerrisScope v${v} is available\nClick to see what's new, update, or skip.`,
                { route: { section: "about", anchor: "about-whatsnew" } },
              );
            }
          } else {
            patchUpdateState({ lastCheckAt: now });
          }
        })
        .catch(logErr("app"));
    };
    const kick = setTimeout(run, 15_000);
    const id = setInterval(run, 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(kick);
      clearInterval(id);
    };
  }, [autoCheckEnabled, patchUpdateState]);

  // Cluster metrics are no longer subscribed eagerly here. Each consumer
  // (ClusterBar gauges, ResourceTable's CPU/Mem cells when kind=pods,
  // MetricsTab) subscribes for itself via `useMetricsSubscription`; the
  // backend refcounts so concurrent subscribers share one polling task,
  // and polling stops when the last consumer unmounts. This keeps the
  // metrics-server LIST + kubelet/proxy stats fan-out off the apiserver
  // when the operator is on a kind that doesn't need them (Deployments,
  // ConfigMaps, etc.) — which used to noticeably delay the first Pods
  // LIST on metrics-server-equipped clusters.
  useEffect(() => {
    if (activeClusterIds.length === 0) clearMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClusterKey, clearMetrics]);

  // The set of physical clusters across ALL open tabs (not just the active
  // one). A cluster stays connected as long as some open tab references it;
  // switching tabs must NOT disconnect the cluster you switched away from —
  // its terminals, chats and node-exec sessions have to survive the switch.
  const openTabClusterIds = useMemo(() => {
    const set = new Set<string>();
    for (const tab of openTabs) {
      for (const id of selectActiveClusterIds({
        contexts,
        selectedContext: tab.selectedContext,
        virtualContexts: allVirtualContexts,
        selectedVirtualContextId: tab.selectedVirtualContextId,
        scopeExtras: tab.scopeExtras,
      })) {
        set.add(id);
      }
    }
    return [...set].sort();
  }, [openTabs, contexts, allVirtualContexts]);
  const openTabClusterKey = openTabClusterIds.join(String.fromCharCode(0));

  // Disconnect a cluster only when it leaves EVERY open tab — i.e. its tab was
  // closed, or the operator returned to Fleet (which clears all tabs). This is
  // the single disconnect path: `closeTab` / `goFleet` shrink `openTabs`, this
  // effect reconciles the backend by force-dropping watchers (which also reaps
  // the cluster's terminals, chats and unpinned forwards). Switching between
  // open tabs never lands here, so warm sessions persist.
  const prevOpenClusterIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevOpenClusterIdsRef.current;
    const departed = prev.filter((id) => !openTabClusterIds.includes(id));
    for (const cid of departed) {
      api.dropClusterWatchers(cid).catch(logErr("app"));
    }
    prevOpenClusterIdsRef.current = openTabClusterIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabClusterKey]);

  // Subscribe to namespaces on every active cluster so the modal lists the
  // union of what really exists. Side-subscriptions are cheap because
  // reflectors dedupe; keys are cluster-scoped so same-named namespaces on
  // two members collapse in the displayed union but track independently.
  useEffect(() => {
    const ids =
      activeClusterKey === ""
        ? []
        : activeClusterKey.split(String.fromCharCode(0));
    if (ids.length === 0) {
      setNsClusters({});
      return;
    }
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    // Keyed `${clusterId}::${uid}` — two clusters can carry the same
    // namespace uid only by coincidence, but scoping is free and exact.
    // The value keeps the origin cluster so the modal can label
    // namespaces that exist on only a subset of the members.
    const seen = new Map<string, { cid: string; name: string }>();

    const refresh = () => {
      const next: Record<string, string[]> = {};
      for (const { cid, name } of seen.values()) {
        const bucket = next[name];
        if (bucket) {
          if (!bucket.includes(cid)) bucket.push(cid);
        } else {
          next[name] = [cid];
        }
      }
      setNsClusters(next);
    };

    // Drop any selected namespaces that no longer exist in ANY active
    // cluster. Empty set means "all namespaces" — so a single-namespace
    // filter whose target was just deleted naturally falls back to the
    // all-namespaces view, and a multi-namespace filter simply loses
    // the deleted entry.
    const reconcileFilter = () => {
      const live = new Set(
        Array.from(seen.values(), (v) => v.name),
      );
      const sel = useAppStore.getState().selectedNamespaces;
      if (sel.size === 0) return;
      let changed = false;
      const next = new Set<string>();
      for (const name of sel) {
        if (live.has(name)) next.add(name);
        else changed = true;
      }
      if (changed) useAppStore.getState().setSelectedNamespaces(next);
    };

    for (const cid of ids) {
      void (async () => {
        try {
          const un = await onResourceDelta(cid, "namespaces", null, (delta) => {
            if (cancelled) return;
            if (delta.kind === "upsert") {
              const name =
                typeof delta.row.name === "string" ? delta.row.name : null;
              if (name) seen.set(`${cid}::${delta.row.uid}`, { cid, name });
            } else if (delta.kind === "delete") {
              seen.delete(`${cid}::${delta.uid}`);
              reconcileFilter();
            } else {
              return; // init_done — nothing to update on the namespace map
            }
            refresh();
          });
          if (cancelled) {
            un();
            return;
          }
          unlistens.push(un);
          const snap = await api.subscribeResource(cid, "namespaces", null);
          if (cancelled) return;
          for (const r of snap.rows) {
            const name = typeof r.name === "string" ? r.name : null;
            if (name) seen.set(`${cid}::${r.uid}`, { cid, name });
          }
          // Initial snapshot might already lack a namespace the operator
          // had filtered to (deleted while another scope was active).
          reconcileFilter();
          refresh();
        } catch {
          // Best-effort per member: if namespaces aren't available there
          // the modal still works with the other members' union.
        }
      })();
    }

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
      for (const cid of ids) {
        api.unsubscribeResource(cid, "namespaces").catch(logErr("app"));
      }
    };
  }, [activeClusterKey]);

  // Suppress the webview's native context menu app-wide so the chrome reads as
  // a desktop app, not a webpage. Text-entry contexts (input, textarea,
  // contenteditable) keep their native menu so paste / spellcheck still work.
  // Surfaces that want a real context menu (ResourceTable rows) call
  // preventDefault and stopPropagation on the synthetic event before it
  // bubbles, so this listener never fires for them.
  //
  // Disabled in dev (`vite dev` / `tauri dev`) so right-click reaches the
  // WebKit native menu — that's where "Inspect Element" lives, the only
  // way to reach the WebKit web inspector on Linux. Production builds
  // keep the suppressor.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onCtx = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        tgt.closest(
          "input, textarea, [contenteditable=''], [contenteditable='true']",
        )
      ) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Global keyboard layer. R-13: Esc cascades from the deepest layer outward.
  // Order: addMenu → palette → settings → ns modal → detail/log panels →
  // bulk selection. Detail/Log panels register their own Esc to close
  // themselves; this handler runs first only when the deeper layers are open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Chord → intent resolution lives in lib/hotkeys.ts (pure, tested
      // for both modifier conventions and non-Latin layouts); this handler
      // only maps intents onto store actions.
      const tgt = e.target as HTMLElement | null;
      const intent = hotkeyIntent(e, {
        scopeActive: activeContexts.length > 0,
        paletteOpen,
        addMenuOpen,
        settingsOpen,
        nsModalOpen,
        filterEditing,
        hasSelection: selection.size > 0,
        drawerOpen: !!compareTarget || !!observeTarget || !!inspectTarget,
        inTextInput:
          tgt != null &&
          tgt.closest(
            "input, textarea, [contenteditable=''], [contenteditable='true']",
          ) != null,
      });
      if (!intent) return;
      if (intentPreventsDefault(intent)) e.preventDefault();
      switch (intent) {
        case "toggle-palette":
          if (paletteOpen) closePalette();
          else openPalette();
          return;
        case "open-filter":
          openFilterEditor();
          return;
        case "open-ns-modal":
          openNsModal();
          return;
        case "open-settings":
          openSettings();
          return;
        case "toggle-theme":
          toggleTheme();
          return;
        case "zoom-in":
          bumpUiScale(1);
          return;
        case "zoom-out":
          bumpUiScale(-1);
          return;
        case "zoom-reset":
          resetUiScale();
          return;
        // Keyboard tab shortcuts bind to the FIRST active cluster — in a
        // multi-cluster view the tab title carries the member name so it's
        // obvious which cluster the terminal landed on; the "+" menu's
        // member picker covers deliberate targeting.
        case "new-terminal": {
          const target = activeContexts[0]!;
          addDockTab(
            makeTerminalTab(
              { mode: "shell", clusterId: target.id, namespace: null },
              target.name,
            ),
          );
          return;
        }
        case "new-yaml":
          addDockTab(makeYamlTab(activeContexts[0]!.id));
          return;
        case "esc-add-menu":
          setAddMenuOpen(false);
          return;
        case "esc-palette":
          closePalette();
          return;
        case "esc-filter":
          closeFilterEditor();
          return;
        case "esc-settings":
          closeSettings();
          return;
        case "esc-ns-modal":
          closeNsModal();
          return;
        case "esc-selection":
          clearSelection();
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    addMenuOpen,
    paletteOpen,
    settingsOpen,
    nsModalOpen,
    selection,
    compareTarget,
    observeTarget,
    inspectTarget,
    activeContexts,
    addDockTab,
    clearSelection,
    closeNsModal,
    closePalette,
    closeSettings,
    openNsModal,
    openPalette,
    openFilterEditor,
    closeFilterEditor,
    filterEditing,
    openSettings,
    setAddMenuOpen,
    toggleTheme,
    bumpUiScale,
    resetUiScale,
  ]);

  const resolved = useResolvedTheme();
  const t = resolved.tokens;
  // Publish theme-derived DOM state — body background/typography, the `:root`
  // CSS custom properties, and the native `color-scheme` — as a layout effect
  // rather than inline in the render body.
  //
  // These are idempotent DOM writes whose values change ONLY when the resolved
  // theme or mode changes. Running them inline meant they re-ran on every App
  // render (App re-renders on every selection toggle, since it subscribes to
  // `s.selection`), and writing to `document.*` during render is a side effect
  // that double-applies under concurrent/Strict-Mode double-render. Keying the
  // effect on `[resolved, themeMode]` runs it only when the theme actually
  // changes; `useLayoutEffect` applies it before paint, so there's no flash.
  useLayoutEffect(() => {
    applyThemeCssVars(resolved, themeMode, {
      isMac: IS_MAC,
      titlebarInsetPx: TITLEBAR_INSET_PX,
    });
    // Note: UI scale is applied via the webview's native page-zoom API in the
    // sibling useEffect above (and pre-applied from prefs in Rust setup()).
  }, [resolved, themeMode]);

  const leftInset = selectedContext
    ? railMode === "pinned"
      ? RAIL_OPEN_W
      : RAIL_COLLAPSED_W
    : 0;

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        // Transparent on macOS so the chrome (header + rail) can let the
        // vibrancy material show through; the <main> content repaints t.bg.
        background: IS_MAC ? "transparent" : t.bg,
        color: t.text,
        fontFamily: FONT_SANS,
        overflow: "hidden",
      }}
    >
      <TitleBar mode={themeMode} />
      <ResizeEdges />
      <AppHeader
        mode={themeMode}
        // In a multi-cluster view there is no single selected context; feed
        // the breadcrumb a synthetic one carrying the view's display name so
        // "Clusters › <view> › <kind> · <count>" stays intact.
        context={
          selectedContext ??
          (multiClusterActive && activeContexts.length > 0
            ? {
                ...activeContexts[0]!,
                name:
                  activeVirtualContext?.name ??
                  `${clusterLabels[activeContexts[0]!.id]?.short ?? activeContexts[0]!.name} +${activeContexts.length - 1}`,
                namespace: null,
              }
            : null)
        }
        selectedKindLabel={selectedKindLabel}
        unreadNotifications={unreadNotifications}
        activeForwards={activeForwards}
        onHome={() => void goToFleet()}
        onPalette={openPalette}
        onToggleTheme={toggleTheme}
        onOpenNotifications={openNotifications}
        onOpenSettings={() => openSettings()}
        onOpenForwards={openForwardsPanel}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {multiClusterActive && activeContexts.length > 0 ? (
          <>
            <Rail mode={themeMode} />
            <main
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                background: t.bg,
              }}
            >
              <VirtualClusterPanel
                // Remount on virtual-context switch so per-member connection
                // state never bleeds between virtual contexts.
                key={activeVirtualContext?.id ?? selectedContextName ?? "adhoc"}
                mode={themeMode}
                title={
                  activeVirtualContext
                    ? activeVirtualContext.name
                    : `${(selectedContext && clusterLabels[selectedContext.id]?.short) ?? selectedContext?.name ?? "Ad-hoc"} +${activeContexts.length - 1}`
                }
                viewScopeId={
                  activeVirtualContext
                    ? `vctx:${activeVirtualContext.id}`
                    : selectedContextName ?? "adhoc"
                }
                contexts={activeContexts}
              />
            </main>
          </>
        ) : selectedContext ? (
          <>
            <Rail mode={themeMode} />
            <main
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                // Opaque so the dense table stays readable; macOS vibrancy is
                // confined to the chrome (header + rail) around it.
                background: t.bg,
              }}
            >
              <ClusterPanel mode={themeMode} context={selectedContext} />
            </main>
          </>
        ) : (
          <main
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: t.bg,
            }}
          >
            <FleetLanding mode={themeMode} onSelect={selectContext} />
          </main>
        )}
      </div>

      {/* Bottom dock for terminals + YAML scratchpads. Right dock for AI
          chats. The Dock primitive filters its own placement; mounting two
          instances keeps the primitive simple. Each tab carries its own
          clusterId in its state; the Dock-level fallback is the first
          active cluster (covers the multi-cluster view, where there is no
          single `selectedContext`). */}
      {/* One Dock pair per open cluster tab. Only the active tab's pair is
          visible (`display: contents`); inactive pairs stay mounted but hidden
          (`display: none`) so their terminals keep their PTY and their chats
          keep their channel alive across a cluster switch. Tabs with no dock
          tabs render nothing. */}
      {openTabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const tabDockTabs = isActive ? dockTabs : tab.slice.dockTabs;
        if (tabDockTabs.length === 0) return null;
        const primary = tabPrimaryContext(tab);
        return (
          <div
            key={tab.id}
            style={{ display: isActive ? "contents" : "none" }}
          >
            <Dock
              mode={themeMode}
              clusterTabId={tab.id}
              clusterName={primary.name}
              clusterId={primary.id}
              leftInset={leftInset}
              placement="bottom"
            />
            <Dock
              mode={themeMode}
              clusterTabId={tab.id}
              clusterName={primary.name}
              clusterId={primary.id}
              leftInset={leftInset}
              placement="right"
            />
          </div>
        );
      })}

      {/* Bulk action bar — shows when rows are selected. Per-kind action sets
          (pods today, nodes for cordon/drain/delete). Shape per R-03.
          Hidden (zIndex 35 > drawer 31) while the compare drawer is open —
          the selection itself survives so the operator can act on the same
          rows after closing the diff. */}
      {!compareTarget && !observeTarget && !inspectTarget && selectedKind?.id === "pods" && activeContexts.length > 0 && selection.size > 0 && (
        <BulkBar
          mode={themeMode}
          count={selection.size}
          onClear={clearSelection}
          actions={[
            ...observeActions(),
            ...inspectActions(),
              ...compareActions(),
            ...buildPodBulkActions(
              selection,
              confirmDestructive,
              clearSelection,
              clusterLabelFor,
              selectionDegraded,
            ),
          ]}
        />
      )}
      {!compareTarget &&
        !observeTarget &&
        !inspectTarget &&
        selectedKind?.id === "nodes" &&
        activeContexts.length > 0 &&
        selection.size > 0 && (
          <BulkBar
            mode={themeMode}
            count={selection.size}
            onClear={clearSelection}
            actions={[
              ...inspectActions(),
              ...compareActions(),
              ...buildNodeBulkActions(
                selection,
                clearSelection,
                clusterLabelFor,
                selectionDegraded,
              ),
            ]}
          />
        )}
      {/* Generic bulk bar for everything that isn't pods or nodes. Copy +
          Delete only — both ride the dynamic API so no per-kind plumbing is
          needed. Restart / cordon / drain stay pod- and node-specific. */}
      {!compareTarget &&
        !observeTarget &&
        !inspectTarget &&
        selectedKind &&
        selectedKind.id !== "pods" &&
        selectedKind.id !== "nodes" &&
        activeContexts.length > 0 &&
        selection.size > 0 && (
          <BulkBar
            mode={themeMode}
            count={selection.size}
            onClear={clearSelection}
            actions={[
              ...observeActions(),
              ...inspectActions(),
              ...compareActions(),
              ...buildGenericBulkActions(
                selectedKind,
                selection,
                confirmDestructive,
                clearSelection,
                clusterLabelFor,
                selectionDegraded,
              ),
            ]}
          />
        )}

      {inspectTarget && (
        <InspectPanel
          mode={themeMode}
          target={inspectTarget}
          onClose={() => setInspectTarget(null)}
          onNavigate={(targetKindName, namespace, name) => {
            // Same Kind-name -> registry-id mapping the detail panel uses.
            // Every subject in one Inspect shares a kind, so the first
            // subject's cluster is the right scope for its pods.
            const target = kinds.find((k) => k.kind === targetKindName);
            if (!target) return;
            const clusterId = inspectTarget.subjects[0]?.clusterId ?? null;
            // Close first: the drawer sits at the same z-index as the detail
            // panel and would cover whatever we just opened.
            setInspectTarget(null);
            navigateToDetail(target.id, namespace, name, clusterId);
          }}
        />
      )}

      {compareTarget && (
        <ComparePanel
          mode={themeMode}
          target={compareTarget}
          onClose={() => setCompareTarget(null)}
        />
      )}

      {observeTarget && (
        <LogPanel
          mode={themeMode}
          targets={observeTarget.targets}
          initialTab={observeTarget.initialTab}
          onClose={() => setObserveTarget(null)}
        />
      )}

      {paletteOpen && (
        <CommandPalette mode={themeMode} onClose={closePalette} />
      )}

      {nsModalOpen && activeContexts.length > 0 && (
        <NamespaceModal
          mode={themeMode}
          namespaces={discoveredNs}
          clusterTags={nsTags}
          initial={selectedNamespaces}
          onApply={(next) => {
            setSelectedNamespaces(next);
            closeNsModal();
          }}
          onClose={closeNsModal}
        />
      )}

      {settingsOpen && (
        <SettingsPanel mode={themeMode} onClose={closeSettings} />
      )}

      <NotificationsPanel mode={themeMode} />
      <PortForwardsPanel mode={themeMode} />
      <ModalHost mode={themeMode} />

      {/* Floating reset chip — only visible when scale ≠ 100 %. Lives above
          the dock but below modals so it doesn't block confirmations. */}
      {Math.abs(uiScale - UI_SCALE_DEFAULT) > 1e-6 && (
        <button
          type="button"
          onClick={resetUiScale}
          title="Reset interface scale"
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 35,
            height: 28,
            padding: "0 12px",
            borderRadius: R_LG,
            border: `1px solid ${t.border}`,
            background: t.surface,
            color: t.text,
            fontFamily: FONT_SANS,
            fontSize: FS_MD,
            fontWeight: 500,
            fontVariantNumeric: "tabular-nums",
            cursor: "pointer",
            boxShadow:
              themeMode === "dark"
                ? "0 4px 12px rgba(0,0,0,0.35)"
                : "0 4px 12px rgba(15,20,30,0.12)",
          }}
        >
          {Math.round(uiScale * 100)}% · Reset
        </button>
      )}
    </div>
  );
}

// Pod-specific bulk actions. Logs / Edit YAML are intentionally absent until
// we ship a multi-stream log view and an apply API — bulk actions need to be
// reliable, idempotent, and obvious. Every action routes through each
// entry's own cluster — a virtual-context selection can span several.
function buildPodBulkActions(
  selection: Map<string, SelectionMeta>,
  confirmDestructive: boolean,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const prefix = bulkClusterPrefix(entries, labelFor);
  const summary = entries
    .slice(0, 5)
    .map(
      ([, m]) =>
        `${prefix(m)}${m.namespace ? `${m.namespace}/${m.name}` : m.name}`,
    )
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const runForAll = async (
    label: string,
    op: (m: SelectionMeta) => Promise<unknown>,
  ) => {
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          await op(m);
        } catch (e) {
          failures.push(
            `${prefix(m)}${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
          );
        }
      }),
    );
    if (failures.length > 0) {
      toast.bad(
        `${label} failed for ${failures.length} of ${count}:\n${failures
          .slice(0, 8)
          .join(
            "\n",
          )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
      );
    } else {
      toast.ok(`${label}: ${count} pod${count === 1 ? "" : "s"}.`);
    }
    clearSelection();
  };

  return [
    {
      icon: Icons.refresh,
      label: "Restart",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Rollout-restart owners of ${count} pod${count === 1 ? "" : "s"}?`,
              body: `This restarts the entire workload — every pod owned by each Deployment / StatefulSet / DaemonSet is recreated, not just the ones you selected. Pods owned by the same workload are restarted together (one rollout per workload).\n\nSelected pods:\n${summary}${more}`,
              confirmLabel: "Restart",
              tone: "danger",
            });
            if (!ok) return;
          }
          // One restart_pods call per origin cluster — the backend resolves
          // pod → owning workload within a single cluster.
          const byCluster = new Map<string, [string, string][]>();
          let noNs = 0;
          for (const [, m] of entries) {
            if (m.namespace == null) {
              noNs += 1;
              continue;
            }
            const bucket = byCluster.get(m.clusterId);
            const pair: [string, string] = [m.namespace, m.name];
            if (bucket) bucket.push(pair);
            else byCluster.set(m.clusterId, [pair]);
          }
          const multi = byCluster.size > 1;
          const cidPrefix = (cid: string) =>
            multi ? `[${labelFor(cid)}] ` : "";
          const patchedLines: string[] = [];
          const failureLines: string[] =
            noNs > 0 ? [`${noNs} selected pod(s) had no namespace`] : [];
          let patchedCount = 0;
          await Promise.all(
            Array.from(byCluster.entries()).map(async ([cid, pairs]) => {
              try {
                const report = await api.restartPods(cid, pairs);
                patchedCount += report.patched.length;
                for (const w of report.patched) {
                  patchedLines.push(
                    `${cidPrefix(cid)}${w.kind} ${w.namespace}/${w.name} (${w.pods.length} pod${w.pods.length === 1 ? "" : "s"})`,
                  );
                }
                for (const f of report.failures) {
                  failureLines.push(
                    `${cidPrefix(cid)}${f.namespace}/${f.pod}: ${f.error}`,
                  );
                }
              } catch (e) {
                failureLines.push(
                  `${cidPrefix(cid)}restart failed: ${String(e)}`,
                );
              }
            }),
          );
          const patchedSummary = patchedLines.join("\n");
          if (failureLines.length > 0) {
            toast.bad(
              `Restarted ${patchedCount} workload(s)${patchedSummary ? `:\n${patchedSummary}` : ""}\n\nFailures (${failureLines.length}):\n${failureLines.slice(0, 8).join("\n")}${failureLines.length > 8 ? `\n…and ${failureLines.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(
              `Restarted ${patchedCount} workload${patchedCount === 1 ? "" : "s"}${patchedSummary ? `:\n${patchedSummary}` : ""}`,
            );
          }
          clearSelection();
        })();
      },
    },
    {
      icon: Icons.copy,
      label: "Copy names",
      onClick: () => {
        const text = entries
          .map(([, m]) => (m.namespace ? `${m.namespace}/${m.name}` : m.name))
          .join("\n");
        navigator.clipboard
          .writeText(text)
          .then(() =>
            toast.ok(`Copied ${count} pod name${count === 1 ? "" : "s"}.`),
          )
          .catch(() => toast.bad("Couldn't copy to clipboard"));
      },
    },
    {
      // Graceful, PDB-aware bulk eviction. Sits ahead of Delete (raw DELETE)
      // so the budget-respecting path is the first destructive option, and
      // carries the divider that opens the destructive group.
      icon: Icons.podDrain,
      label: "Evict",
      disabled: degraded,
      separatorBefore: true,
      danger: true,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Evict ${count} pod${count === 1 ? "" : "s"}?`,
              body: `Graceful, PDB-aware eviction. A pod protected by a PodDisruptionBudget is refused (reported in the summary), not force-killed. Controller-owned pods reschedule; bare pods are gone.\n\n${summary}${more}`,
              confirmLabel: "Evict",
              tone: "danger",
            });
            if (!ok) return;
          }
          await runForAll("Evict", (m) => {
            // Pods are namespaced; guard anyway so a malformed selection lands
            // in the failure summary instead of a bad backend call.
            if (!m.namespace)
              return Promise.reject(new Error("pod has no namespace"));
            return api.evictPod(m.clusterId, m.namespace, m.name);
          });
        })();
      },
    },
    {
      icon: Icons.trash,
      label: "Delete",
      disabled: degraded,
      danger: true,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Delete ${count} pod${count === 1 ? "" : "s"}?`,
              body: `${summary}${more}`,
              confirmLabel: "Delete",
              tone: "danger",
            });
            if (!ok) return;
          }
          await runForAll("Delete", (m) =>
            api.deleteResource(m.clusterId, "pods", m.namespace, m.name, null),
          );
        })();
      },
    },
  ];
}

// Node-specific bulk actions. Cordon / Uncordon are split because a mixed
// selection (some cordoned, some not) needs both intents to be expressible
// without forcing the operator to deselect first. Drain and Delete confirm
// unconditionally — they have real-world consequences a `confirmDestructive`
// toggle shouldn't be able to silence.
function buildNodeBulkActions(
  selection: Map<string, SelectionMeta>,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const prefix = bulkClusterPrefix(entries, labelFor);
  const summary = entries
    .slice(0, 5)
    .map(([, m]) => `${prefix(m)}${m.name}`)
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const runForAll = async (
    label: string,
    op: (m: SelectionMeta) => Promise<unknown>,
  ) => {
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          await op(m);
        } catch (e) {
          failures.push(`${prefix(m)}${m.name}: ${String(e)}`);
        }
      }),
    );
    if (failures.length > 0) {
      toast.bad(
        `${label} failed for ${failures.length} of ${count}:\n${failures
          .slice(0, 8)
          .join(
            "\n",
          )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
      );
    } else {
      toast.ok(`${label}: ${count} node${count === 1 ? "" : "s"}.`);
    }
    clearSelection();
  };

  const drainAll = async () => {
    const reports: { node: string; ev: number; sk: number; fl: number }[] = [];
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          const r = await api.drainNode(m.clusterId, m.name, false);
          reports.push({
            node: `${prefix(m)}${m.name}`,
            ev: r.evicted.length,
            sk: r.skipped.length,
            fl: r.failures.length,
          });
        } catch (e) {
          failures.push(`${prefix(m)}${m.name}: ${String(e)}`);
        }
      }),
    );
    const lines = reports
      .map((r) => `${r.node}: ${r.ev} evicted, ${r.sk} skipped, ${r.fl} failed`)
      .join("\n");
    if (failures.length > 0 || reports.some((r) => r.fl > 0)) {
      toast.bad(
        `Drain results:\n${lines}${failures.length > 0 ? `\n\nDrain call failed:\n${failures.join("\n")}` : ""}`,
      );
    } else {
      toast.ok(`Drained ${count} node${count === 1 ? "" : "s"}:\n${lines}`);
    }
    clearSelection();
  };

  return [
    {
      icon: Icons.eye,
      label: "Cordon",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Cordon ${count} node${count === 1 ? "" : "s"}?`,
            body: `New pods won't schedule on:\n${summary}${more}`,
            confirmLabel: "Cordon",
          });
          if (!ok) return;
          await runForAll("Cordon", (m) =>
            api.cordonNode(m.clusterId, m.name, true),
          );
        })();
      },
    },
    {
      icon: Icons.check,
      label: "Uncordon",
      disabled: degraded,
      onClick: () => {
        void runForAll("Uncordon", (m) =>
          api.cordonNode(m.clusterId, m.name, false),
        );
      },
    },
    {
      icon: Icons.refresh,
      label: "Drain",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Drain ${count} node${count === 1 ? "" : "s"}?`,
            body: `Cordons each node and evicts every pod on it. DaemonSet-managed and mirror pods are skipped. PDB-protected pods may block; failures are reported per pod.\n\nNodes:\n${summary}${more}`,
            confirmLabel: "Drain",
            tone: "danger",
          });
          if (!ok) return;
          await drainAll();
        })();
      },
    },
    {
      icon: Icons.copy,
      label: "Copy names",
      onClick: () => {
        const text = entries.map(([, m]) => m.name).join("\n");
        navigator.clipboard
          .writeText(text)
          .then(() =>
            toast.ok(`Copied ${count} node name${count === 1 ? "" : "s"}.`),
          )
          .catch(() => toast.bad("Couldn't copy to clipboard"));
      },
    },
    {
      icon: Icons.trash,
      label: "Delete",
      disabled: degraded,
      separatorBefore: true,
      danger: true,
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Delete ${count} node${count === 1 ? "" : "s"}?`,
            body: `Removes the node from the cluster. The underlying machine isn't stopped. Pods on the node will be rescheduled by their controllers (orphaned bare pods become Lost).\n\n${summary}${more}`,
            confirmLabel: "Delete",
            tone: "danger",
          });
          if (!ok) return;
          await runForAll("Delete", (m) =>
            api.deleteResource(m.clusterId, "nodes", null, m.name, null),
          );
        })();
      },
    },
  ];
}

// Generic bulk actions for any kind that isn't pods or nodes. Copy + Delete
// ride the dynamic API; Restart is added for the workload kinds that support
// `kubectl rollout restart` (Deployment / StatefulSet / DaemonSet) and goes
// through the JSON merge-patch path (`api.restartWorkload`), not SSA — see
// `runRestartWorkload` in DetailPanel for the rationale.
const BULK_RESTARTABLE_KINDS = new Set([
  "deployments",
  "statefulsets",
  "daemonsets",
]);

function buildGenericBulkActions(
  kind: ResourceKind,
  selection: Map<string, SelectionMeta>,
  confirmDestructive: boolean,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const prefix = bulkClusterPrefix(entries, labelFor);
  const kindLabel = kind.kind.toLowerCase();
  const plural = kind.plural.toLowerCase();
  const summary = entries
    .slice(0, 5)
    .map(
      ([, m]) =>
        `${prefix(m)}${m.namespace ? `${m.namespace}/${m.name}` : m.name}`,
    )
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const actions: BulkAction[] = [];

  if (BULK_RESTARTABLE_KINDS.has(kind.id)) {
    actions.push({
      icon: Icons.refresh,
      label: "Restart",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Rollout-restart ${count} ${count === 1 ? kindLabel : plural}?`,
              body: `Patches each workload's pod-template annotation. Every pod owned by each is recreated; rollout respects maxSurge / maxUnavailable / PDBs.\n\n${summary}${more}`,
              confirmLabel: "Restart",
              tone: "danger",
            });
            if (!ok) return;
          }
          const failures: string[] = [];
          let noNs = 0;
          await Promise.all(
            entries.map(async ([, m]) => {
              if (!m.namespace) {
                noNs += 1;
                return;
              }
              try {
                await api.restartWorkload(
                  m.clusterId,
                  kind.kind,
                  m.namespace,
                  m.name,
                );
              } catch (e) {
                failures.push(
                  `${prefix(m)}${m.namespace}/${m.name}: ${String(e)}`,
                );
              }
            }),
          );
          const lines = [
            ...(noNs > 0
              ? [
                  `${noNs} selected ${noNs === 1 ? kindLabel : plural} had no namespace`,
                ]
              : []),
            ...failures,
          ];
          if (lines.length > 0) {
            toast.bad(
              `Restart failed for ${lines.length} of ${count}:\n${lines.slice(0, 8).join("\n")}${lines.length > 8 ? `\n…and ${lines.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(
              `Rollout restart triggered on ${count} ${count === 1 ? kindLabel : plural}.`,
            );
          }
          clearSelection();
        })();
      },
    });
  }

  actions.push(
    {
      icon: Icons.copy,
      label: "Copy names",
      onClick: () => {
        const text = entries
          .map(([, m]) => (m.namespace ? `${m.namespace}/${m.name}` : m.name))
          .join("\n");
        navigator.clipboard
          .writeText(text)
          .then(() =>
            toast.ok(
              `Copied ${count} ${count === 1 ? kindLabel : plural} name${count === 1 ? "" : "s"}.`,
            ),
          )
          .catch(() => toast.bad("Couldn't copy to clipboard"));
      },
    },
    {
      icon: Icons.trash,
      label: "Delete",
      disabled: degraded,
      separatorBefore: true,
      danger: true,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Delete ${count} ${count === 1 ? kindLabel : plural}?`,
              body: `${summary}${more}`,
              confirmLabel: "Delete",
              tone: "danger",
            });
            if (!ok) return;
          }
          const failures: string[] = [];
          await Promise.all(
            entries.map(async ([, m]) => {
              try {
                await api.deleteResource(
                  m.clusterId,
                  kind.id,
                  m.namespace,
                  m.name,
                  null,
                );
              } catch (e) {
                failures.push(
                  `${prefix(m)}${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
                );
              }
            }),
          );
          if (failures.length > 0) {
            toast.bad(
              `Delete failed for ${failures.length} of ${count}:\n${failures
                .slice(0, 8)
                .join(
                  "\n",
                )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(`Deleted ${count} ${count === 1 ? kindLabel : plural}.`);
          }
          clearSelection();
        })();
      },
    },
  );

  return actions;
}
