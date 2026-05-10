import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, onPortForwardStatus, onResourceDelta } from "./api";
import { useAppStore } from "./store";
import type { AppInfo, ResourceKind } from "./types";
import { tokens, FONT_SANS, UI_SCALE_DEFAULT } from "./theme";
import { AppHeader } from "./components/AppHeader";
import { TitleBar, ResizeEdges, TITLEBAR_INSET_PX } from "./components/TitleBar";
import { Rail } from "./components/Rail";
import { ClusterPanel } from "./components/ClusterPanel";
import { FleetLanding } from "./components/FleetLanding";
import { CommandPalette } from "./components/CommandPalette";
import { NamespaceModal } from "./components/NamespaceModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { BulkBar, type BulkAction } from "./components/BulkBar";
import { Dock, makeTerminalTab, makeYamlTab } from "./components/Dock";
import { ModalHost } from "./components/ModalHost";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { PortForwardsPanel } from "./components/PortForwardsPanel";
import { confirm, toast } from "./lib/dialog";
import { latinLetter } from "./lib/keyboard";
import { Icons } from "./components/ui";

const RAIL_COLLAPSED_W = 56;
const RAIL_OPEN_W = 220;

// Top-level shell. Owns the global keyboard layer (P3 + R-13) and renders
// every overlay (palette, settings, namespace modal, bulk bar, dock).
export default function App() {
  const [, setInfo] = useState<AppInfo | null>(null);
  const [, setReady] = useState(false);
  // Discovered namespaces in the live cluster — used by the ns modal so the
  // operator picks from a real list instead of a free-text field.
  const [discoveredNs, setDiscoveredNs] = useState<string[]>([]);

  const themeMode = useAppStore((s) => s.themeMode);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const selectedContextName = useAppStore((s) => s.selectedContext);
  const selectContext = useAppStore((s) => s.selectContext);
  const selectedContext = useAppStore(
    (s) => s.contexts.find((c) => c.id === s.selectedContext) ?? null,
  );
  const selectedKindLabel = useAppStore((s) => {
    const k = s.kinds.find((kk) => kk.id === s.selectedKindId);
    return k ? k.kind : null;
  });
  const selectedKind = useAppStore((s) =>
    s.kinds.find((kk) => kk.id === s.selectedKindId),
  );

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
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);

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
  const railMode = useAppStore((s) => s.railMode);
  const dockSize = useAppStore((s) => s.dockSize);
  const setMetrics = useAppStore((s) => s.setMetrics);
  const hydrateForwards = useAppStore((s) => s.hydrateForwards);
  const applyForwardStatus = useAppStore((s) => s.applyForwardStatus);
  const hydrateTableViews = useAppStore((s) => s.hydrateTableViews);
  const hydratePrefs = useAppStore((s) => s.hydratePrefs);
  const settings = useAppStore((s) => s.settings);
  const uiScale = useAppStore((s) => s.settings.uiScale);
  const bumpUiScale = useAppStore((s) => s.bumpUiScale);
  const resetUiScale = useAppStore((s) => s.resetUiScale);
  const selectedKindId = useAppStore((s) => s.selectedKindId);
  // Set once after the initial prefs load — gates the persist effect so the
  // hydration write doesn't immediately echo defaults back to disk.
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  useEffect(() => {
    api
      .ping()
      .then(setInfo)
      .catch(() => {});
    api
      .getTableViews()
      .then((file) => hydrateTableViews(file.views))
      .catch(() => {});
    api
      .getPrefs()
      .then((p) => hydratePrefs(p))
      .catch(() => {})
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
      .catch(() => {});
    api
      .pfList()
      .then((entries) => hydrateForwards(entries))
      .catch(() => {});

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
      api
        .setPrefs({
          theme: themeMode,
          settings: {
            refresh_sec: settings.refreshSec,
            confirm_destructive: settings.confirmDestructive,
            show_system_ns: settings.showSystemNs,
            density: settings.density,
            mono_tables: settings.monoTables,
            refresh_on_launch: settings.refreshOnLaunch,
            ui_scale: settings.uiScale,
            fleet_view: settings.fleetView,
          },
          ui: {
            selected_context: selectedContextName,
            selected_kind_id: selectedKindId,
            selected_namespaces: Array.from(selectedNamespaces).sort(),
            rail_mode: railMode,
            dock_size_right: dockSize.right,
            dock_size_bottom: dockSize.bottom,
          },
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [
    prefsLoaded,
    themeMode,
    railMode,
    selectedContextName,
    selectedKindId,
    selectedNamespaces,
    settings,
    dockSize,
  ]);

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
    if (!selectedContextName) setMetrics(null);
  }, [selectedContextName, setMetrics]);

  // When the operator leaves a cluster, force-drop every still-running
  // watcher for it. Watchers normally linger ~60 s after their last
  // subscriber unmounts so kind→kind navigation stays warm; on a context
  // switch we don't want to carry that idle traffic on a cluster we're
  // no longer viewing. Cleanup runs on the *previous* cluster only —
  // `cleanup` of a useEffect captures the old value, then the new effect
  // body runs for the new cluster.
  useEffect(() => {
    if (!selectedContextName) return;
    const leaving = selectedContextName;
    return () => {
      api.dropClusterWatchers(leaving).catch(() => {});
    };
  }, [selectedContextName]);

  // Subscribe to namespaces on the active cluster so the modal lists what
  // really exists. Side-subscription is cheap because reflectors dedupe.
  useEffect(() => {
    if (!selectedContextName) {
      setDiscoveredNs([]);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const seen = new Map<string, string>();

    const refresh = () =>
      setDiscoveredNs(Array.from(new Set(seen.values())).sort());

    // Drop any selected namespaces that no longer exist in the cluster.
    // Empty set means "all namespaces" — so a single-namespace filter
    // whose target was just deleted naturally falls back to the
    // all-namespaces view, and a multi-namespace filter simply loses
    // the deleted entry. Called with the current `seen` snapshot from
    // the delta handler (so we reconcile against the freshly-deleted
    // state, not a stale read).
    const reconcileFilter = () => {
      const live = new Set(seen.values());
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

    (async () => {
      try {
        unlisten = await onResourceDelta(
          selectedContextName,
          "namespaces",
          (delta) => {
            if (cancelled) return;
            if (delta.kind === "upsert") {
              const name =
                typeof delta.row.name === "string" ? delta.row.name : null;
              if (name) seen.set(delta.row.uid, name);
            } else if (delta.kind === "delete") {
              seen.delete(delta.uid);
              reconcileFilter();
            } else {
              return; // init_done — nothing to update on the namespace map
            }
            refresh();
          },
        );
        const snap = await api.subscribeResource(
          selectedContextName,
          "namespaces",
          null,
        );
        if (cancelled) return;
        for (const r of snap.rows) {
          const name = typeof r.name === "string" ? r.name : null;
          if (name) seen.set(r.uid, name);
        }
        // Initial snapshot might already lack a namespace the operator had
        // filtered to (e.g. it was deleted while another cluster was active).
        reconcileFilter();
        refresh();
      } catch {
        // Best-effort: if namespaces aren't available the modal still works
        // with an empty list.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      api
        .unsubscribeResource(selectedContextName, "namespaces")
        .catch(() => {});
    };
  }, [selectedContextName]);

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
      if (tgt && tgt.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) {
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
      const meta = e.metaKey || e.ctrlKey;

      // `latinLetter` resolves the physical Latin letter regardless of
      // active keyboard layout — Cmd+F on a Russian / Greek / Hebrew /
      // Arabic layout otherwise misses because `e.key` is the localized
      // character (`а` / `φ` / `כ` / …) not "f".
      const letter = latinLetter(e);
      if (meta && letter === "k") {
        e.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
        return;
      }
      // Cmd/Ctrl+F — open the inline filter input in the breadcrumb.
      // Mirrors browsers' "find on page"; only fires when a kind table is
      // mounted (otherwise the input has nothing to filter).
      if (meta && letter === "f" && selectedContextName) {
        e.preventDefault();
        openFilterEditor();
        return;
      }
      // `/` (vim-style) — same as Cmd+F. Only fires outside an input so
      // typing slashes in text fields keeps working.
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        selectedContextName
      ) {
        const tgt = e.target as HTMLElement | null;
        if (
          !tgt ||
          !tgt.closest(
            "input, textarea, [contenteditable=''], [contenteditable='true']",
          )
        ) {
          e.preventDefault();
          openFilterEditor();
          return;
        }
      }
      if (meta && letter === "i" && selectedContextName) {
        e.preventDefault();
        openNsModal();
        return;
      }
      if (meta && e.key === "," ) {
        e.preventDefault();
        openSettings();
        return;
      }
      if (meta && e.shiftKey && letter === "l") {
        e.preventDefault();
        toggleTheme();
        return;
      }
      // Global UI scale. Cmd/Ctrl + and Cmd/Ctrl - nudge by one step;
      // Cmd/Ctrl 0 resets. `=` is matched alongside `+` because `+` requires
      // Shift on most layouts and platform keymaps surface the unshifted key.
      if (meta && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        bumpUiScale(1);
        return;
      }
      if (meta && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        bumpUiScale(-1);
        return;
      }
      if (meta && e.key === "0") {
        e.preventDefault();
        resetUiScale();
        return;
      }
      if (meta && e.key === "`" && selectedContextName) {
        e.preventDefault();
        addDockTab(
          makeTerminalTab(
            { mode: "shell", clusterId: selectedContextName, namespace: null },
            selectedContext?.name ?? selectedContextName,
          ),
        );
        return;
      }
      if (meta && e.shiftKey && letter === "y" && selectedContextName) {
        e.preventDefault();
        addDockTab(makeYamlTab(selectedContextName));
        return;
      }

      if (e.key === "Escape") {
        if (addMenuOpen) {
          setAddMenuOpen(false);
          return;
        }
        if (paletteOpen) {
          closePalette();
          return;
        }
        if (filterEditing) {
          closeFilterEditor();
          return;
        }
        if (settingsOpen) {
          closeSettings();
          return;
        }
        if (nsModalOpen) {
          closeNsModal();
          return;
        }
        // DetailPanel and LogPanel register their own Esc to close.
        if (selection.size > 0) {
          clearSelection();
          return;
        }
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
    selectedContextName,
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

  const t = tokens(themeMode);
  document.body.style.background = t.bg;
  document.body.style.color = t.text;
  // Publish the custom-titlebar height (Linux only — 0 elsewhere) as a
  // CSS variable. Every fixed-position overlay (scrim, side panel,
  // modal, dock) reads `var(--fs-titlebar-h, 0px)` for its top inset so
  // the titlebar stays accessible (drag, close) above modals — matching
  // native macOS/Windows behavior.
  document.documentElement.style.setProperty(
    "--fs-titlebar-h",
    `${TITLEBAR_INSET_PX}px`,
  );
  // Tell native form controls (select dropdowns, scrollbars, autofill) to
  // theme themselves to match — otherwise the OS defaults to light, leaving
  // a white dropdown list on a dark page.
  document.documentElement.style.colorScheme = themeMode;
  // Global UI scale via CSS `zoom` on the root. Chosen over rem/font-size
  // because the codebase pins pixel literals (`fontSize: 12.5`, paddings)
  // throughout — `zoom` scales every pixel uniformly and is supported in
  // both webview engines we ship to (WebKit on macOS, WebKitGTK on Linux).
  document.documentElement.style.zoom = String(uiScale);

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
        background: t.bg,
        color: t.text,
        fontFamily: FONT_SANS,
        overflow: "hidden",
      }}
    >
      <TitleBar mode={themeMode} />
      <ResizeEdges />
      <AppHeader
        mode={themeMode}
        context={selectedContext}
        selectedKindLabel={selectedKindLabel}
        unreadNotifications={unreadNotifications}
        activeForwards={activeForwards}
        onHome={() => selectContext(null)}
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
        {selectedContext ? (
          <>
            <Rail mode={themeMode} />
            <main
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
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
            }}
          >
            <FleetLanding mode={themeMode} onSelect={selectContext} />
          </main>
        )}
      </div>

      {/* Bottom dock for terminals + YAML scratchpads. Right dock for AI
          chats. The Dock primitive filters its own placement; mounting two
          instances keeps the primitive simple. */}
      {selectedContext && dockTabs.length > 0 && (
        <>
          <Dock
            mode={themeMode}
            clusterName={selectedContext.name}
            clusterId={selectedContextName}
            leftInset={leftInset}
            placement="bottom"
          />
          <Dock
            mode={themeMode}
            clusterName={selectedContext.name}
            clusterId={selectedContextName}
            leftInset={leftInset}
            placement="right"
          />
        </>
      )}

      {/* Bulk action bar — shows when rows are selected. Per-kind action sets
          (pods today, nodes for cordon/drain/delete). Shape per R-03. */}
      {selectedKind?.id === "pods" &&
        selectedContext &&
        selection.size > 0 && (
          <BulkBar
            mode={themeMode}
            count={selection.size}
            onClear={clearSelection}
            actions={buildPodBulkActions(
              selectedContext.id,
              selection,
              confirmDestructive,
              clearSelection,
            )}
          />
        )}
      {selectedKind?.id === "nodes" &&
        selectedContext &&
        selection.size > 0 && (
          <BulkBar
            mode={themeMode}
            count={selection.size}
            onClear={clearSelection}
            actions={buildNodeBulkActions(
              selectedContext.id,
              selection,
              clearSelection,
            )}
          />
        )}
      {/* Generic bulk bar for everything that isn't pods or nodes. Copy +
          Delete only — both ride the dynamic API so no per-kind plumbing is
          needed. Restart / cordon / drain stay pod- and node-specific. */}
      {selectedKind &&
        selectedKind.id !== "pods" &&
        selectedKind.id !== "nodes" &&
        selectedContext &&
        selection.size > 0 && (
          <BulkBar
            mode={themeMode}
            count={selection.size}
            onClear={clearSelection}
            actions={buildGenericBulkActions(
              selectedContext.id,
              selectedKind,
              selection,
              confirmDestructive,
              clearSelection,
            )}
          />
        )}

      {paletteOpen && (
        <CommandPalette mode={themeMode} onClose={closePalette} />
      )}

      {nsModalOpen && selectedContext && (
        <NamespaceModal
          mode={themeMode}
          namespaces={discoveredNs}
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
            borderRadius: 999,
            border: `1px solid ${t.border}`,
            background: t.surface,
            color: t.text,
            fontFamily: FONT_SANS,
            fontSize: 12,
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
// reliable, idempotent, and obvious.
function buildPodBulkActions(
  clusterId: string,
  selection: Map<string, { namespace: string | null; name: string }>,
  confirmDestructive: boolean,
  clearSelection: () => void,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const summary = entries
    .slice(0, 5)
    .map(([, m]) => (m.namespace ? `${m.namespace}/${m.name}` : m.name))
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const runForAll = async (
    label: string,
    op: (ns: string | null, name: string) => Promise<unknown>,
  ) => {
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          await op(m.namespace, m.name);
        } catch (e) {
          failures.push(
            `${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
          );
        }
      }),
    );
    if (failures.length > 0) {
      toast.bad(
        `${label} failed for ${failures.length} of ${count}:\n${failures
          .slice(0, 8)
          .join("\n")}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
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
          const pairs: [string, string][] = entries
            .filter(
              (e): e is [string, { namespace: string; name: string }] =>
                e[1].namespace != null,
            )
            .map(([, m]) => [m.namespace, m.name]);
          const noNs = entries.length - pairs.length;
          try {
            const report = await api.restartPods(clusterId, pairs);
            const patchedSummary = report.patched
              .map(
                (w) =>
                  `${w.kind} ${w.namespace}/${w.name} (${w.pods.length} pod${w.pods.length === 1 ? "" : "s"})`,
              )
              .join("\n");
            const failureLines = [
              ...(noNs > 0
                ? [`${noNs} selected pod(s) had no namespace`]
                : []),
              ...report.failures.map(
                (f) => `${f.namespace}/${f.pod}: ${f.error}`,
              ),
            ];
            if (failureLines.length > 0) {
              toast.bad(
                `Restarted ${report.patched.length} workload(s)${patchedSummary ? `:\n${patchedSummary}` : ""}\n\nFailures (${failureLines.length}):\n${failureLines.slice(0, 8).join("\n")}${failureLines.length > 8 ? `\n…and ${failureLines.length - 8} more` : ""}`,
              );
            } else {
              toast.ok(
                `Restarted ${report.patched.length} workload${report.patched.length === 1 ? "" : "s"}${patchedSummary ? `:\n${patchedSummary}` : ""}`,
              );
            }
          } catch (e) {
            toast.bad(`Restart failed: ${String(e)}`);
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
          .map(([, m]) =>
            m.namespace ? `${m.namespace}/${m.name}` : m.name,
          )
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
      icon: Icons.trash,
      label: "Delete",
      separatorBefore: true,
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
          await runForAll("Delete", (ns, name) =>
            api.deleteResource(clusterId, "pods", ns, name, null),
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
  clusterId: string,
  selection: Map<string, { namespace: string | null; name: string }>,
  clearSelection: () => void,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const summary = entries
    .slice(0, 5)
    .map(([, m]) => m.name)
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const runForAll = async (
    label: string,
    op: (name: string) => Promise<unknown>,
  ) => {
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          await op(m.name);
        } catch (e) {
          failures.push(`${m.name}: ${String(e)}`);
        }
      }),
    );
    if (failures.length > 0) {
      toast.bad(
        `${label} failed for ${failures.length} of ${count}:\n${failures
          .slice(0, 8)
          .join("\n")}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
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
          const r = await api.drainNode(clusterId, m.name, false);
          reports.push({
            node: m.name,
            ev: r.evicted.length,
            sk: r.skipped.length,
            fl: r.failures.length,
          });
        } catch (e) {
          failures.push(`${m.name}: ${String(e)}`);
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
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Cordon ${count} node${count === 1 ? "" : "s"}?`,
            body: `New pods won't schedule on:\n${summary}${more}`,
            confirmLabel: "Cordon",
          });
          if (!ok) return;
          await runForAll("Cordon", (name) =>
            api.cordonNode(clusterId, name, true),
          );
        })();
      },
    },
    {
      icon: Icons.check,
      label: "Uncordon",
      onClick: () => {
        void runForAll("Uncordon", (name) =>
          api.cordonNode(clusterId, name, false),
        );
      },
    },
    {
      icon: Icons.refresh,
      label: "Drain",
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
          await runForAll("Delete", (name) =>
            api.deleteResource(clusterId, "nodes", null, name, null),
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
  clusterId: string,
  kind: ResourceKind,
  selection: Map<string, { namespace: string | null; name: string }>,
  confirmDestructive: boolean,
  clearSelection: () => void,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const kindLabel = kind.kind.toLowerCase();
  const plural = kind.plural.toLowerCase();
  const summary = entries
    .slice(0, 5)
    .map(([, m]) => (m.namespace ? `${m.namespace}/${m.name}` : m.name))
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const actions: BulkAction[] = [];

  if (BULK_RESTARTABLE_KINDS.has(kind.id)) {
    actions.push({
      icon: Icons.refresh,
      label: "Restart",
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
                  clusterId,
                  kind.kind,
                  m.namespace,
                  m.name,
                );
              } catch (e) {
                failures.push(`${m.namespace}/${m.name}: ${String(e)}`);
              }
            }),
          );
          const lines = [
            ...(noNs > 0
              ? [`${noNs} selected ${noNs === 1 ? kindLabel : plural} had no namespace`]
              : []),
            ...failures,
          ];
          if (lines.length > 0) {
            toast.bad(
              `Restart failed for ${lines.length} of ${count}:\n${lines.slice(0, 8).join("\n")}${lines.length > 8 ? `\n…and ${lines.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(`Rollout restart triggered on ${count} ${count === 1 ? kindLabel : plural}.`);
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
          .map(([, m]) =>
            m.namespace ? `${m.namespace}/${m.name}` : m.name,
          )
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
                  clusterId,
                  kind.id,
                  m.namespace,
                  m.name,
                  null,
                );
              } catch (e) {
                failures.push(
                  `${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
                );
              }
            }),
          );
          if (failures.length > 0) {
            toast.bad(
              `Delete failed for ${failures.length} of ${count}:\n${failures
                .slice(0, 8)
                .join("\n")}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(
              `Deleted ${count} ${count === 1 ? kindLabel : plural}.`,
            );
          }
          clearSelection();
        })();
      },
    },
  );

  return actions;
}
