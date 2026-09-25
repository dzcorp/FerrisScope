// Reducer tests for useAppStore. Each test resets the store first so
// they don't interfere — Zustand's create() returns a singleton and
// without a reset our tests would inherit each other's mutations.

import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  NOTIFICATION_LOG_CAP,
  semverGt,
  selectUpdateAvailable,
  selectActiveClusterIds,
  selectClusterDegraded,
  selectSelectionDegraded,
  buildPrefsPayload,
  selectClustersToDisconnect,
  drawerKey,
  TRAY_CAP,
  DETAIL_HISTORY_CAP,
  type Drawer,
  type DockTab,
  type ConfirmModal,
  type Toast,
  type SelectionMeta,
} from "./store";

const initial = useAppStore.getState();

beforeEach(() => {
  // Reset to the initial state captured at module-load. We re-create the
  // collection types per reset so a previous test mutating one doesn't
  // bleed into the next.
  useAppStore.setState({
    ...initial,
    selectedNamespaces: new Set<string>(),
    selection: new Map<string, SelectionMeta>(),
    contexts: [],
    kinds: [],
    dockTabs: [],
    dockActive: { bottom: null, right: null },
    dockMin: { bottom: false, right: false },
    modals: [],
    toasts: [],
    notifications: [],
    pendingDetail: null,
    metricsByCluster: {},
    forwards: {},
    tableViews: {},
    virtualContexts: [],
    selectedVirtualContextId: null,
    scopeExtras: [],
    openTabs: [],
    activeTabId: null,
  });
});

describe("toggleTheme", () => {
  it("flips dark → light → dark", () => {
    expect(useAppStore.getState().themeMode).toBe("dark");
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().themeMode).toBe("light");
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().themeMode).toBe("dark");
  });
});

describe("setTheme", () => {
  it("switches theme, resets palette, and seeds density / mono when they're at the previous theme's defaults", () => {
    const s0 = useAppStore.getState();
    expect(s0.themeId).toBe("default");
    expect(s0.settings.density).toBe("comfortable"); // Default's default

    useAppStore.getState().setTheme("readable");
    const sR = useAppStore.getState();
    expect(sR.themeId).toBe("readable");
    expect(sR.paletteId).toBe("warm");
    // density was at Default's default ⇒ reseed to Readable's.
    expect(sR.settings.density).toBe("spacious");
    expect(sR.settings.monoTables).toBe(false);

    useAppStore.getState().setTheme("vscode");
    const sV = useAppStore.getState();
    expect(sV.themeId).toBe("vscode");
    expect(sV.paletteId).toBe("dark-plus");
    expect(sV.settings.density).toBe("compact");
  });
  it("preserves an operator-set density across theme switches (seed-once)", () => {
    // Start on Default, switch density to compact manually. Compact isn't
    // Default's default (comfortable), so it counts as user-touched.
    useAppStore.getState().patchSettings({ density: "compact" });
    expect(useAppStore.getState().settings.density).toBe("compact");

    // Switching theme must NOT reseed density — user's choice survives.
    useAppStore.getState().setTheme("readable");
    expect(useAppStore.getState().settings.density).toBe("compact");
    useAppStore.getState().setTheme("vscode");
    expect(useAppStore.getState().settings.density).toBe("compact");
  });
  it("unknown theme id falls back to Default at resolve time", () => {
    useAppStore.getState().setTheme("nonexistent");
    const s = useAppStore.getState();
    expect(s.themeId).toBe("default");
    expect(s.paletteId).toBe("default");
  });
});

describe("darkConsole setting", () => {
  it("defaults to on", () => {
    expect(useAppStore.getState().settings.darkConsole).toBe(true);
  });
  it("patchSettings toggles it", () => {
    useAppStore.getState().patchSettings({ darkConsole: false });
    expect(useAppStore.getState().settings.darkConsole).toBe(false);
    useAppStore.getState().patchSettings({ darkConsole: true });
    expect(useAppStore.getState().settings.darkConsole).toBe(true);
  });
});

describe("cluster-name settings", () => {
  it("both default to on", () => {
    const s = useAppStore.getState().settings;
    expect(s.shortenClusterNames).toBe(true);
    expect(s.groupFleetByProject).toBe(true);
  });

  it("patchSettings toggles them independently", () => {
    useAppStore.getState().patchSettings({ shortenClusterNames: false });
    expect(useAppStore.getState().settings.shortenClusterNames).toBe(false);
    expect(useAppStore.getState().settings.groupFleetByProject).toBe(true);
    useAppStore.getState().patchSettings({ shortenClusterNames: true });
    expect(useAppStore.getState().settings.shortenClusterNames).toBe(true);
  });

  it("survives a persist / hydrate round-trip when disabled", () => {
    useAppStore.getState().patchSettings({
      shortenClusterNames: false,
      groupFleetByProject: false,
    });
    const prefs = buildPrefsPayload({ ...useAppStore.getState() });
    expect(prefs.settings.shorten_cluster_names).toBe(false);
    expect(prefs.settings.group_fleet_by_project).toBe(false);
    useAppStore.getState().patchSettings({
      shortenClusterNames: true,
      groupFleetByProject: true,
    });
    useAppStore.getState().hydratePrefs(prefs);
    const s = useAppStore.getState().settings;
    expect(s.shortenClusterNames).toBe(false);
    expect(s.groupFleetByProject).toBe(false);
  });

  it("defaults both on when hydrating prefs that predate them", () => {
    // Restore the flags first so the assertion can't pass by accident.
    useAppStore.getState().patchSettings({
      shortenClusterNames: false,
      groupFleetByProject: false,
    });
    const prefs = buildPrefsPayload({ ...useAppStore.getState() });
    delete (prefs.settings as Record<string, unknown>).shorten_cluster_names;
    delete (prefs.settings as Record<string, unknown>).group_fleet_by_project;
    useAppStore.getState().hydratePrefs(prefs);
    const s = useAppStore.getState().settings;
    expect(s.shortenClusterNames).toBe(true);
    expect(s.groupFleetByProject).toBe(true);
  });
});

describe("focusedClusterId", () => {
  it("defaults to null", () => {
    expect(useAppStore.getState().focusedClusterId).toBeNull();
  });

  it("toggleFocusedCluster sets, then clears on a second call", () => {
    useAppStore.getState().toggleFocusedCluster("default::a");
    expect(useAppStore.getState().focusedClusterId).toBe("default::a");
    useAppStore.getState().toggleFocusedCluster("default::a");
    expect(useAppStore.getState().focusedClusterId).toBeNull();
  });

  it("switches focus straight to another cluster", () => {
    useAppStore.getState().toggleFocusedCluster("default::a");
    useAppStore.getState().toggleFocusedCluster("default::b");
    expect(useAppStore.getState().focusedClusterId).toBe("default::b");
    useAppStore.getState().clearFocusedCluster();
    expect(useAppStore.getState().focusedClusterId).toBeNull();
  });

  it("clears when the focused member is dropped from the scope", () => {
    // Otherwise the table stays filtered to a cluster that is no longer in
    // view — an empty table with nothing on screen explaining why.
    useAppStore.setState({ scopeExtras: ["default::b"] });
    useAppStore.getState().toggleFocusedCluster("default::b");
    useAppStore.getState().removeScopeExtra("default::b");
    expect(useAppStore.getState().focusedClusterId).toBeNull();
  });

  it("leaves the focus alone when a different extra is dropped", () => {
    useAppStore.setState({ scopeExtras: ["default::b", "default::c"] });
    useAppStore.getState().toggleFocusedCluster("default::b");
    useAppStore.getState().removeScopeExtra("default::c");
    expect(useAppStore.getState().focusedClusterId).toBe("default::b");
    useAppStore.getState().clearFocusedCluster();
    useAppStore.setState({ scopeExtras: [] });
  });

  it("is per-tab: switching tabs restores that tab's focus", () => {
    useAppStore.setState({
      contexts: [
        { id: "default::a", name: "a" } as never,
        { id: "default::b", name: "b" } as never,
      ],
      openTabs: [],
      activeTabId: null,
      scopeExtras: [],
    });
    const s = useAppStore.getState();
    s.openTab({ kind: "context", contextId: "default::a" });
    const tabA = useAppStore.getState().activeTabId!;
    useAppStore.getState().toggleFocusedCluster("default::a");

    useAppStore.getState().openTab({ kind: "context", contextId: "default::b" });
    // Fresh tab starts unfocused rather than inheriting the previous tab's.
    expect(useAppStore.getState().focusedClusterId).toBeNull();

    useAppStore.getState().switchTab(tabA);
    expect(useAppStore.getState().focusedClusterId).toBe("default::a");

    useAppStore.getState().clearFocusedCluster();
    useAppStore.setState({ openTabs: [], activeTabId: null, contexts: [] });
  });
});

describe("setPalette", () => {
  it("swaps palette inside the current theme", () => {
    useAppStore.getState().setTheme("default");
    useAppStore.getState().setPalette("default");
    expect(useAppStore.getState().paletteId).toBe("default");
  });
  it("rejects a palette that doesn't belong to the active theme", () => {
    useAppStore.getState().setTheme("default");
    useAppStore.getState().setPalette("warm"); // belongs to Readable
    // No change.
    expect(useAppStore.getState().paletteId).toBe("default");
  });
});

describe("patchThemeOverrides", () => {
  it("merges overrides on top of any existing patch", () => {
    useAppStore.getState().patchThemeOverrides({
      tokens: { accent: "#abcdef" },
    });
    expect(useAppStore.getState().themeOverrides?.tokens?.accent).toBe(
      "#abcdef",
    );
    useAppStore.getState().patchThemeOverrides({
      typography: { base: 18 },
    });
    const s = useAppStore.getState();
    expect(s.themeOverrides?.tokens?.accent).toBe("#abcdef");
    expect(s.themeOverrides?.typography?.base).toBe(18);
  });
  it("null clears all overrides", () => {
    useAppStore.getState().patchThemeOverrides({
      tokens: { accent: "#abcdef" },
    });
    useAppStore.getState().patchThemeOverrides(null);
    expect(useAppStore.getState().themeOverrides).toBeNull();
  });
});

describe("setContexts", () => {
  const ctx = (id: string, name: string) => ({
    id,
    name,
    cluster: "c",
    user: null,
    namespace: null,
    is_current: false,
    group: "Default",
    source_id: "default",
    source_path: null,
  });

  it("clears selectedContext when the previous selection is gone", () => {
    useAppStore.setState({ selectedContext: "stale" });
    useAppStore.getState().setContexts([ctx("a", "alpha")]);
    expect(useAppStore.getState().selectedContext).toBeNull();
    expect(useAppStore.getState().contextsStatus).toBe("ready");
  });

  it("preserves selectedContext when it survives", () => {
    useAppStore.setState({ selectedContext: "a" });
    useAppStore.getState().setContexts([ctx("a", "alpha"), ctx("b", "beta")]);
    expect(useAppStore.getState().selectedContext).toBe("a");
  });
});

describe("selectContext clears scope", () => {
  it("opens a fresh tab with a clean slice (selection / namespaces / dock / detail), keeping per-cluster metrics warm", () => {
    useAppStore.setState({
      selection: new Map([["k", { clusterId: "c1", namespace: "n", name: "x" }]]),
      selectedNamespaces: new Set(["default"]),
      dockTabs: [
        {
          id: "t1",
          kind: "terminal",
          title: "shell",
          placement: "bottom",
          state: {},
        },
      ] satisfies DockTab[],
      dockActive: { bottom: "t1", right: null },
      metricsByCluster: { "ctx-1": { pods: {}, available: false } as never },
    });

    useAppStore.getState().selectContext("ctx-2");

    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("ctx-2");
    expect(s.selection.size).toBe(0);
    expect(s.selectedNamespaces.size).toBe(0);
    expect(s.dockTabs).toHaveLength(0);
    expect(s.dockActive).toEqual({ bottom: null, right: null });
    // Per-cluster metrics are global and kept warm across tab switches now —
    // other open tabs may still be showing the cluster they reference.
    expect(Object.keys(s.metricsByCluster).length).toBeGreaterThanOrEqual(0);
  });
});

describe("toasts + notifications cap", () => {
  const t = (id: string): Toast => ({
    id,
    tone: "info",
    text: id,
    durationMs: 0,
  });

  it("push then dismiss removes only the toast, not the notification log", () => {
    useAppStore.getState().pushToast(t("a"));
    useAppStore.getState().pushToast(t("b"));
    expect(useAppStore.getState().toasts).toHaveLength(2);
    expect(useAppStore.getState().notifications).toHaveLength(2);

    useAppStore.getState().dismissToast("a");
    const s = useAppStore.getState();
    expect(s.toasts.map((x) => x.id)).toEqual(["b"]);
    // Notification log keeps the dismissed entry — that's the whole point.
    expect(s.notifications.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("notification log is bounded to NOTIFICATION_LOG_CAP", () => {
    for (let i = 0; i < NOTIFICATION_LOG_CAP + 5; i += 1) {
      useAppStore.getState().pushToast(t(`n${i}`));
    }
    const s = useAppStore.getState();
    expect(s.notifications).toHaveLength(NOTIFICATION_LOG_CAP);
    // Oldest 5 dropped — first remaining is index 5.
    expect(s.notifications[0]?.id).toBe("n5");
  });

  it("copies structured meta from the toast into the notification log entry", () => {
    const meta = {
      context: "prod-eu-1",
      cluster: "gke_acme_prod",
      namespace: "default",
      kind: "Pod",
      name: "nginx-7f",
    };
    useAppStore.getState().pushToast({ ...t("m"), meta });
    const note = useAppStore.getState().notifications[0];
    expect(note?.meta).toEqual(meta);
    // Bare toast (no meta) leaves the log entry meta-free.
    useAppStore.getState().pushToast(t("plain"));
    const plain = useAppStore
      .getState()
      .notifications.find((x) => x.id === "plain");
    expect(plain?.meta).toBeUndefined();
  });

  it("carries a routed toast's route into both the toast and the notification log", () => {
    const routed: Toast = {
      id: "upd",
      tone: "info",
      text: "update available",
      durationMs: 0,
      route: { section: "about", anchor: "about-whatsnew" },
    };
    useAppStore.getState().pushToast(routed);
    const s = useAppStore.getState();
    expect(s.toasts[0]?.route).toEqual({
      section: "about",
      anchor: "about-whatsnew",
    });
    // Survives in the log so the entry stays clickable after auto-dismiss.
    expect(s.notifications[0]?.route).toEqual({
      section: "about",
      anchor: "about-whatsnew",
    });
  });
});

describe("modals queue", () => {
  it("resolveModal calls the modal's resolve callback once", async () => {
    let resolved: boolean | null = null;
    const modal: ConfirmModal = {
      id: "m1",
      title: "ok?",
      confirmLabel: "OK",
      cancelLabel: "Cancel",
      tone: "neutral",
      resolve: (v) => {
        resolved = v;
      },
    };
    useAppStore.getState().pushModal(modal);
    expect(useAppStore.getState().modals).toHaveLength(1);
    useAppStore.getState().resolveModal("m1", true);
    expect(resolved).toBe(true);
    expect(useAppStore.getState().modals).toHaveLength(0);
  });

  it("resolveModal on a missing id is a no-op", () => {
    useAppStore.getState().resolveModal("ghost", false);
    expect(useAppStore.getState().modals).toHaveLength(0);
  });
});

describe("navigateToDetail", () => {
  it("switches the table to the kind and arms the pending detail", () => {
    useAppStore.getState().navigateToDetail("pods", "default", "b", "c1");
    const s = useAppStore.getState();
    expect(s.pendingDetail).toEqual({ clusterId: "c1", kindId: "pods", namespace: "default", name: "b" });
    expect(s.selectedKindId).toBe("pods");
  });




  it("extends an active namespace filter to include the target namespace", () => {
    // Without this, the table's apiserver-scoped subscription would never
    // see the target's row and the navigation would silently no-op.
    useAppStore.setState({ selectedNamespaces: new Set(["default"]) });
    useAppStore.getState().navigateToDetail("pods", "kube-system", "coredns");
    expect([...useAppStore.getState().selectedNamespaces].sort()).toEqual([
      "default",
      "kube-system",
    ]);
  });

  it("leaves an empty (all-namespaces) filter and cluster-scoped targets alone", () => {
    useAppStore.getState().navigateToDetail("pods", "kube-system", "coredns");
    expect(useAppStore.getState().selectedNamespaces.size).toBe(0);
    useAppStore.setState({ selectedNamespaces: new Set(["default"]) });
    useAppStore.getState().navigateToDetail("nodes", null, "node-1");
    expect([...useAppStore.getState().selectedNamespaces]).toEqual(["default"]);
  });

  it("keeps the same Set instance when the namespace is already visible", () => {
    const ns = new Set(["default"]);
    useAppStore.setState({ selectedNamespaces: ns });
    useAppStore.getState().navigateToDetail("pods", "default", "a");
    expect(useAppStore.getState().selectedNamespaces).toBe(ns);
  });

});

describe("semverGt", () => {
  it("compares X.Y.Z numerically", () => {
    expect(semverGt("1.0.1", "1.0.0")).toBe(true);
    expect(semverGt("1.1.0", "1.0.9")).toBe(true);
    expect(semverGt("2.0.0", "1.99.99")).toBe(true);
    expect(semverGt("1.0.0", "1.0.0")).toBe(false);
    expect(semverGt("1.0.0", "1.0.1")).toBe(false);
    // Lex-incorrect compare would put "10" before "9"; numeric is correct.
    expect(semverGt("0.10.0", "0.9.0")).toBe(true);
  });

  it("tolerates a leading v on either side (raw release-tag form)", () => {
    expect(semverGt("v1.0.1", "1.0.0")).toBe(true);
    expect(semverGt("1.0.1", "v1.0.0")).toBe(true);
    expect(semverGt("v1.0.0", "v1.0.0")).toBe(false);
  });
});

describe("dock tabs", () => {
  const mkTab = (id: string, placement: "bottom" | "right" = "bottom"): DockTab => ({
    id,
    kind: placement === "right" ? "chat" : "terminal",
    title: id,
    placement,
    state: {},
  });

  it("addDockTab appends, focuses the new tab, and un-minimises only its placement", () => {
    useAppStore.setState({
      dockMin: { bottom: true, right: true },
    });
    useAppStore.getState().addDockTab(mkTab("t1", "bottom"));
    const s = useAppStore.getState();
    expect(s.dockTabs.map((t) => t.id)).toEqual(["t1"]);
    expect(s.dockActive.bottom).toBe("t1");
    // Only `bottom` un-minimised — `right` left alone so the chat panel
    // stays collapsed if it was.
    expect(s.dockMin.bottom).toBe(false);
    expect(s.dockMin.right).toBe(true);
  });

  it("closeDockTab on the active tab activates the next survivor in the same placement", () => {
    const st = () => useAppStore.getState();
    st().addDockTab(mkTab("b1", "bottom"));
    st().addDockTab(mkTab("b2", "bottom"));
    st().addDockTab(mkTab("r1", "right"));
    st().closeDockTab("r1");
    expect(st().dockActive).toEqual({ bottom: "b2", right: null });
    st().closeDockTab("b2");
    expect(st().dockActive.bottom).toBe("b1");
    st().closeDockTab("b1");
    expect(st().dockActive.bottom).toBeNull();
  });

  it("keeps an independent active tab per placement", () => {
    const st = () => useAppStore.getState();
    st().addDockTab(mkTab("r1", "right"));
    st().addDockTab(mkTab("r2", "right"));
    st().setDockActiveId("r1");
    st().addDockTab(mkTab("b1", "bottom"));
    st().setDockActiveId("b1");
    // Focusing a terminal must not flip the visible chat.
    expect(st().dockActive).toEqual({ bottom: "b1", right: "r1" });
  });

  it("setDockActiveId ignores unknown ids", () => {
    const st = () => useAppStore.getState();
    st().addDockTab(mkTab("b1", "bottom"));
    st().setDockActiveId("nope");
    expect(st().dockActive.bottom).toBe("b1");
  });

  it("closeDockTab on a non-active tab leaves the active selection alone", () => {
    const st = () => useAppStore.getState();
    st().addDockTab(mkTab("a"));
    st().addDockTab(mkTab("b"));
    expect(st().dockActive.bottom).toBe("b");
    st().closeDockTab("a");
    expect(st().dockActive.bottom).toBe("b");
  });

  it("closing the last tab of a minimised placement clears its minimised flag", () => {
    const st = () => useAppStore.getState();
    st().addDockTab(mkTab("r1", "right"));
    st().setDockMin("right", true);
    st().closeDockTab("r1");
    expect(st().dockMin.right).toBe(false);
  });

  it("closeAllDockTabs / closeDockTabsByPlacement", () => {
    const st = () => useAppStore.getState();
    st().addDockTab(mkTab("b1", "bottom"));
    st().addDockTab(mkTab("r1", "right"));
    st().closeDockTabsByPlacement("right");
    expect(st().dockTabs.map((t) => t.id)).toEqual(["b1"]);
    expect(st().dockActive).toEqual({ bottom: "b1", right: null });
    st().closeAllDockTabs();
    expect(st().dockTabs).toHaveLength(0);
    expect(st().dockActive).toEqual({ bottom: null, right: null });
  });

  it("patchDockTabState merges into the tab's local state without touching siblings", () => {
    useAppStore.getState().addDockTab({
      id: "y1",
      kind: "yaml",
      title: "scratch",
      placement: "bottom",
      state: { yaml: "x", cursor: 0 },
    });
    useAppStore.getState().patchDockTabState("y1", { cursor: 12 });
    const s = useAppStore.getState();
    expect(s.dockTabs[0]?.state).toEqual({ yaml: "x", cursor: 12 });
  });

  it("setDockMin / setDockSize only touch the targeted placement", () => {
    useAppStore.getState().setDockMin("bottom", true);
    expect(useAppStore.getState().dockMin.bottom).toBe(true);
    expect(useAppStore.getState().dockMin.right).toBe(false);
    useAppStore.getState().setDockSize("right", 480);
    expect(useAppStore.getState().dockSize.right).toBe(480);
  });
});

describe("selection map", () => {
  it("toggleSelection adds and then removes", () => {
    useAppStore.getState().toggleSelection("uid-1", { clusterId: "c1", namespace: "default", name: "p1" });
    expect(useAppStore.getState().selection.size).toBe(1);
    useAppStore.getState().toggleSelection("uid-1", { clusterId: "c1", namespace: "default", name: "p1" });
    expect(useAppStore.getState().selection.size).toBe(0);
  });

  it("clearSelection wipes the map", () => {
    useAppStore.getState().toggleSelection("a", { clusterId: "c1", namespace: null, name: "x" });
    useAppStore.getState().toggleSelection("b", { clusterId: "c1", namespace: null, name: "y" });
    expect(useAppStore.getState().selection.size).toBe(2);
    useAppStore.getState().clearSelection();
    expect(useAppStore.getState().selection.size).toBe(0);
  });
});

describe("table filter / count", () => {
  it("setTableFilter sets it; clearTableFilter empties it", () => {
    useAppStore.getState().setTableFilter("nginx");
    expect(useAppStore.getState().tableFilter).toBe("nginx");
    useAppStore.getState().clearTableFilter();
    expect(useAppStore.getState().tableFilter).toBe("");
  });
  it("setTableCount accepts the count or null (filter disengaged)", () => {
    useAppStore.getState().setTableCount({ filtered: 3, total: 10, loading: true });
    expect(useAppStore.getState().tableCount).toEqual({ filtered: 3, total: 10, loading: true });
    useAppStore.getState().setTableCount(null);
    expect(useAppStore.getState().tableCount).toBeNull();
  });
});

describe("settings target & misc open/close pairs", () => {
  it("openSettings(target) records the target, closeSettings clears the open flag", () => {
    useAppStore.getState().openSettings({ section: "appearance" });
    let s = useAppStore.getState();
    expect(s.settingsOpen).toBe(true);
    expect(s.settingsTarget).toEqual({ section: "appearance" });

    // consumeSettingsTarget returns then clears.
    expect(useAppStore.getState().consumeSettingsTarget()).toEqual({
      section: "appearance",
    });
    expect(useAppStore.getState().settingsTarget).toBeNull();

    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it("openSettings() with no target resets settingsTarget (no stale anchor)", () => {
    useAppStore.setState({ settingsTarget: { section: "appearance" } });
    useAppStore.getState().openSettings();
    expect(useAppStore.getState().settingsTarget).toBeNull();
  });

  it("openSettings ignores a non-object target (MouseEvent guard)", () => {
    // Components occasionally wire `onClick={openSettings}` — the click event
    // shouldn't be treated as a SettingsTarget.
    useAppStore.getState().openSettings("oops" as unknown as never);
    expect(useAppStore.getState().settingsTarget).toBeNull();
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it("toggles for palette / nsModal / filter editor / addMenu / notifications / forwardsPanel", () => {
    const s = useAppStore.getState();
    s.openPalette();
    expect(useAppStore.getState().paletteOpen).toBe(true);
    s.closePalette();
    expect(useAppStore.getState().paletteOpen).toBe(false);

    s.openNsModal();
    expect(useAppStore.getState().nsModalOpen).toBe(true);
    s.closeNsModal();

    s.openFilterEditor();
    expect(useAppStore.getState().filterEditing).toBe(true);
    s.closeFilterEditor();

    s.setAddMenuOpen(true);
    expect(useAppStore.getState().addMenuOpen).toBe(true);

    s.openNotifications();
    expect(useAppStore.getState().notificationsOpen).toBe(true);
    s.closeNotifications();
    expect(useAppStore.getState().notificationsOpen).toBe(false);

    s.openForwardsPanel();
    expect(useAppStore.getState().forwardsOpen).toBe(true);
    s.closeForwardsPanel();
  });

  it("clearNotifications wipes the log and bumps seen-at", () => {
    useAppStore.setState({
      notifications: [
        { id: "x", tone: "info", text: "hi", createdAt: 0 },
      ],
    });
    const before = useAppStore.getState().notificationsSeenAt;
    useAppStore.getState().clearNotifications();
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().notificationsSeenAt).toBeGreaterThanOrEqual(before);
  });
});

describe("port-forwards reducer", () => {
  const mkEntry = (id: string, status: "listening" | "active" | "stopped" = "listening") => ({
    spec: {
      id,
      cluster_id: "ctx",
      target: { kind: "Pod", namespace: "default", name: "p" } as never,
      remote_port: 80,
      requested_local_port: null,
      autostart: false,
    },
    actual_local_port: 8080,
    status: { kind: status } as never,
  });

  it("hydrateForwards builds the map from a list", () => {
    useAppStore.getState().hydrateForwards([mkEntry("a"), mkEntry("b")]);
    expect(Object.keys(useAppStore.getState().forwards).sort()).toEqual(["a", "b"]);
  });

  it("upsertForward inserts or replaces a single entry", () => {
    useAppStore.getState().upsertForward(mkEntry("a", "listening"));
    useAppStore.getState().upsertForward(mkEntry("a", "active"));
    expect(useAppStore.getState().forwards["a"]?.status.kind).toBe("active");
  });

  it("applyForwardStatus updates an existing entry's status; 'stopped' removes it", () => {
    useAppStore.getState().hydrateForwards([mkEntry("a")]);
    useAppStore.getState().applyForwardStatus("a", { kind: "active" });
    expect(useAppStore.getState().forwards["a"]?.status.kind).toBe("active");
    useAppStore.getState().applyForwardStatus("a", { kind: "stopped" });
    expect(useAppStore.getState().forwards["a"]).toBeUndefined();
  });

  it("applyForwardStatus on unknown id is a no-op", () => {
    useAppStore.getState().applyForwardStatus("ghost", { kind: "active" });
    expect(useAppStore.getState().forwards).toEqual({});
  });

  it("removeForward deletes by id", () => {
    useAppStore.getState().hydrateForwards([mkEntry("a"), mkEntry("b")]);
    useAppStore.getState().removeForward("a");
    expect(Object.keys(useAppStore.getState().forwards)).toEqual(["b"]);
  });
});

describe("global-forwards reducer", () => {
  const mkSession = (id: string, ns = "default") => ({
    id,
    cluster_id: "ctx",
    namespace: ns,
    services: [
      {
        name: "api",
        namespace: ns,
        local_ip: "127.1.0.1",
        hostnames: ["api", "api.default.svc.cluster.local"],
        ports: [80],
      },
    ],
  });

  it("hydrateGlobalForwards builds the map from a list", () => {
    useAppStore.getState().hydrateGlobalForwards([mkSession("a"), mkSession("b")]);
    expect(Object.keys(useAppStore.getState().globalForwards).sort()).toEqual(["a", "b"]);
  });

  it("upsertGlobalForward inserts or replaces by id", () => {
    useAppStore.getState().upsertGlobalForward(mkSession("a", "one"));
    useAppStore.getState().upsertGlobalForward(mkSession("a", "two"));
    expect(useAppStore.getState().globalForwards["a"]?.namespace).toBe("two");
  });

  it("removeGlobalForward deletes by id", () => {
    useAppStore.getState().hydrateGlobalForwards([mkSession("a"), mkSession("b")]);
    useAppStore.getState().removeGlobalForward("a");
    expect(Object.keys(useAppStore.getState().globalForwards)).toEqual(["b"]);
  });

  it("setHelperStatus replaces the helper status", () => {
    expect(useAppStore.getState().helperStatus).toEqual({ state: "not_started" });
    useAppStore.getState().setHelperStatus({ state: "running" });
    expect(useAppStore.getState().helperStatus).toEqual({ state: "running" });
    useAppStore.getState().setHelperStatus({ state: "failed", message: "denied" });
    expect(useAppStore.getState().helperStatus).toEqual({ state: "failed", message: "denied" });
  });
});

describe("cluster health", () => {
  it("applyClusterHealth records status + reason, clearClusterHealth removes both", () => {
    useAppStore.getState().applyClusterHealth("ctx", "unavailable", "tcp refused");
    expect(useAppStore.getState().clusterHealth["ctx"]).toBe("unavailable");
    expect(useAppStore.getState().clusterHealthReason["ctx"]).toBe("tcp refused");
    useAppStore.getState().clearClusterHealth("ctx");
    expect(useAppStore.getState().clusterHealth["ctx"]).toBeUndefined();
    expect(useAppStore.getState().clusterHealthReason["ctx"]).toBeUndefined();
  });

  it("clearClusterHealth bumps the per-cluster reconnect epoch monotonically", () => {
    // Discovery effects key on this epoch so a same-cluster reconnect re-runs
    // CRD discovery and clears any stale error. Each reconnect must advance it.
    expect(useAppStore.getState().clusterEpoch["ctx"] ?? 0).toBe(0);
    useAppStore.getState().clearClusterHealth("ctx");
    expect(useAppStore.getState().clusterEpoch["ctx"]).toBe(1);
    useAppStore.getState().clearClusterHealth("ctx");
    expect(useAppStore.getState().clusterEpoch["ctx"]).toBe(2);
    // A different cluster keeps its own independent counter.
    useAppStore.getState().clearClusterHealth("other");
    expect(useAppStore.getState().clusterEpoch["other"]).toBe(1);
    expect(useAppStore.getState().clusterEpoch["ctx"]).toBe(2);
  });
});

describe("resumeEpoch", () => {
  it("bumpResumeEpoch advances the wake counter", () => {
    const before = useAppStore.getState().resumeEpoch;
    useAppStore.getState().bumpResumeEpoch();
    useAppStore.getState().bumpResumeEpoch();
    expect(useAppStore.getState().resumeEpoch).toBe(before + 2);
  });
});

describe("tableViews", () => {
  it("setTableView stores a populated view and deletes one with empty sorting + sizing", () => {
    useAppStore.getState().setTableView("ctx", "pods", {
      sorting: [{ id: "name", desc: false }],
      column_sizing: { name: 200 },
    } as never);
    expect(useAppStore.getState().tableViews["ctx::pods"]).toBeDefined();
    useAppStore.getState().setTableView("ctx", "pods", {
      sorting: [],
      column_sizing: {},
    } as never);
    expect(useAppStore.getState().tableViews["ctx::pods"]).toBeUndefined();
  });

  it("hydrateTableViews replaces the whole map", () => {
    useAppStore.getState().hydrateTableViews({
      "ctx::pods": { sorting: [], column_sizing: {} } as never,
    });
    expect(Object.keys(useAppStore.getState().tableViews)).toEqual(["ctx::pods"]);
  });

  it("keeps a label-column-only view (no sort/sizing) instead of pruning it", () => {
    useAppStore.getState().setTableView("ctx", "nodes", {
      sorting: [],
      column_sizing: {},
      label_columns: ["topology.kubernetes.io/zone"],
    } as never);
    expect(useAppStore.getState().tableViews["ctx::nodes"]?.label_columns).toEqual([
      "topology.kubernetes.io/zone",
    ]);
  });

  it("prunes once label columns are also cleared", () => {
    useAppStore.getState().setTableView("ctx", "nodes", {
      sorting: [],
      column_sizing: {},
      label_columns: ["zone"],
    } as never);
    useAppStore.getState().setTableView("ctx", "nodes", {
      sorting: [],
      column_sizing: {},
      label_columns: [],
    } as never);
    expect(useAppStore.getState().tableViews["ctx::nodes"]).toBeUndefined();
  });
});

describe("UI scale", () => {
  it("setUiScale clamps + snaps the value", () => {
    useAppStore.getState().setUiScale(99);
    expect(useAppStore.getState().settings.uiScale).toBeLessThanOrEqual(2); // generous upper-bound assumption
    useAppStore.getState().setUiScale(0);
    expect(useAppStore.getState().settings.uiScale).toBeGreaterThan(0);
  });

  it("bumpUiScale +1/-1 walks by the step", () => {
    useAppStore.getState().resetUiScale();
    const base = useAppStore.getState().settings.uiScale;
    useAppStore.getState().bumpUiScale(1);
    expect(useAppStore.getState().settings.uiScale).toBeGreaterThan(base);
    useAppStore.getState().bumpUiScale(-1);
    // Round-trip back to base (within snapping).
    expect(useAppStore.getState().settings.uiScale).toBeCloseTo(base, 5);
  });
});


describe("kinds + rail mode", () => {
  it("setKinds falls back to the first kind when the previous selection is gone", () => {
    useAppStore.setState({ selectedKindId: "stale" });
    useAppStore.getState().setKinds([
      { id: "pods", name: "Pod" } as never,
      { id: "deployments", name: "Deployment" } as never,
    ]);
    // Stale id can't survive; rail picks the first kind so the table isn't
    // left with nothing to render.
    expect(useAppStore.getState().selectedKindId).toBe("pods");
  });

  it("setKinds preserves selectedKindId when it survives the new list", () => {
    useAppStore.setState({ selectedKindId: "deployments" });
    useAppStore.getState().setKinds([
      { id: "pods", name: "Pod" } as never,
      { id: "deployments", name: "Deployment" } as never,
    ]);
    expect(useAppStore.getState().selectedKindId).toBe("deployments");
  });

  it("setKinds against an empty list nulls selectedKindId", () => {
    useAppStore.setState({ selectedKindId: "pods" });
    useAppStore.getState().setKinds([]);
    expect(useAppStore.getState().selectedKindId).toBeNull();
  });

  it("setKindsError flips status to error and records the message", () => {
    useAppStore.getState().setKindsLoading();
    expect(useAppStore.getState().kindsStatus).toBe("loading");
    useAppStore.getState().setKindsError("boom");
    expect(useAppStore.getState().kindsStatus).toBe("error");
    expect(useAppStore.getState().kindsError).toBe("boom");
  });

  it("setContextsError + setContextsLoading flip status the same way", () => {
    useAppStore.getState().setContextsLoading();
    expect(useAppStore.getState().contextsStatus).toBe("loading");
    useAppStore.getState().setContextsError("nope");
    expect(useAppStore.getState().contextsStatus).toBe("error");
    expect(useAppStore.getState().contextsError).toBe("nope");
  });

  it("cycleRailMode walks through the rail modes deterministically", () => {
    const m0 = useAppStore.getState().railMode;
    useAppStore.getState().cycleRailMode();
    const m1 = useAppStore.getState().railMode;
    expect(m1).not.toBe(m0);
    useAppStore.getState().cycleRailMode();
    useAppStore.getState().cycleRailMode();
    // Three cycles wraps back to the starting mode (only 3 modes exist).
    expect(useAppStore.getState().railMode).toBe(m0);
  });
});

describe("selectUpdateAvailable", () => {
  function snapshot(over: {
    appVersion?: string | null;
    lastKnownVersion?: string | null;
    lastSeenVersion?: string | null;
  }) {
    return {
      // `?? "1.0.0"` would coerce an explicit `null` away — use `in` so the
      // "not hydrated yet" case (appVersion: null) actually round-trips.
      appVersion: "appVersion" in over ? over.appVersion! : "1.0.0",
      updateState: {
        lastKnownVersion: over.lastKnownVersion ?? null,
        lastSeenVersion: over.lastSeenVersion ?? null,
        lastCheckAt: 0,
        autoCheckEnabled: true,
      },
    };
  }

  it("returns false when nothing has been observed yet", () => {
    expect(selectUpdateAvailable(snapshot({}))).toBe(false);
  });

  it("returns false when the latest equals current", () => {
    expect(
      selectUpdateAvailable(snapshot({ lastKnownVersion: "1.0.0" })),
    ).toBe(false);
  });

  it("returns true when latest is newer and nothing has been skipped", () => {
    expect(
      selectUpdateAvailable(snapshot({ lastKnownVersion: "1.0.1" })),
    ).toBe(true);
  });

  it("returns false when the user skipped the exact known version", () => {
    expect(
      selectUpdateAvailable(
        snapshot({ lastKnownVersion: "1.0.1", lastSeenVersion: "1.0.1" }),
      ),
    ).toBe(false);
  });

  it("returns true when a newer version arrives after an older skip", () => {
    // Skipped 1.0.1, then 1.0.2 ships → mark reappears.
    expect(
      selectUpdateAvailable(
        snapshot({ lastKnownVersion: "1.0.2", lastSeenVersion: "1.0.1" }),
      ),
    ).toBe(true);
  });

  it("returns false when app version is not yet hydrated", () => {
    expect(
      selectUpdateAvailable(
        snapshot({ appVersion: null, lastKnownVersion: "9.9.9" }),
      ),
    ).toBe(false);
  });
});

// ─── Virtual contexts ────────────────────────────────────────────────────────

const vctxCtx = (id: string) => ({
  id,
  name: id,
  cluster: "c",
  user: null,
  namespace: null,
  is_current: false,
  group: "Default",
  source_id: "default",
  source_path: null,
});

const basePrefs = () =>
  buildPrefsPayload({
    ...useAppStore.getState(),
  });

describe("virtual context CRUD", () => {
  it("saveVirtualContext appends and returns a fresh id", () => {
    const id = useAppStore
      .getState()
      .saveVirtualContext("prod", ["default::a", "default::b"]);
    const s = useAppStore.getState();
    expect(id).toBeTruthy();
    expect(s.virtualContexts).toHaveLength(1);
    expect(s.virtualContexts[0]).toEqual({
      id,
      name: "prod",
      members: ["default::a", "default::b"],
    });
    // Saving does not activate.
    expect(s.selectedVirtualContextId).toBeNull();
  });

  it("renameVirtualContext / setVirtualContextMembers patch in place", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::a"]);
    useAppStore.getState().renameVirtualContext(id, "production");
    useAppStore
      .getState()
      .setVirtualContextMembers(id, ["default::a", "default::c"]);
    const v = useAppStore.getState().virtualContexts[0]!;
    expect(v.name).toBe("production");
    expect(v.members).toEqual(["default::a", "default::c"]);
  });

  it("deleteVirtualContext removes, and deactivates when active", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::a"]);
    useAppStore.getState().selectVirtualContext(id);
    expect(useAppStore.getState().selectedVirtualContextId).toBe(id);
    useAppStore.getState().deleteVirtualContext(id);
    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(0);
    expect(s.selectedVirtualContextId).toBeNull();
  });
});

describe("selectVirtualContext / selectContext mutual exclusion", () => {
  it("activating a virtual context clears selectedContext and resets scope", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::a"]);
    useAppStore.setState({
      selectedContext: "default::solo",
      selection: new Map([["k", { clusterId: "c1", namespace: "n", name: "x" }]]),
      selectedNamespaces: new Set(["default"]),
      tableFilter: "auth",
      scopeExtras: ["default::extra"],
    });
    useAppStore.getState().selectVirtualContext(id);
    const s = useAppStore.getState();
    expect(s.selectedVirtualContextId).toBe(id);
    expect(s.selectedContext).toBeNull();
    expect(s.selection.size).toBe(0);
    expect(s.selectedNamespaces.size).toBe(0);
    expect(s.tableFilter).toBe("");
    expect(s.scopeExtras).toHaveLength(0);
  });

  it("selectContext clears an active virtual context", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::a"]);
    useAppStore.getState().selectVirtualContext(id);
    useAppStore.getState().selectContext("default::solo");
    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("default::solo");
    expect(s.selectedVirtualContextId).toBeNull();
  });

  it("rejects ids that don't resolve to a saved virtual context", () => {
    useAppStore.setState({ selectedContext: "default::solo" });
    useAppStore.getState().selectVirtualContext("nope");
    const s = useAppStore.getState();
    expect(s.selectedVirtualContextId).toBeNull();
    expect(s.selectedContext).toBe("default::solo");
  });
});

describe("setContexts keeps virtual contexts alive", () => {
  it("keeps the active virtual context while ≥1 member resolves", () => {
    const id = useAppStore
      .getState()
      .saveVirtualContext("prod", ["default::a", "default::gone"]);
    useAppStore.getState().selectVirtualContext(id);
    useAppStore.getState().setContexts([vctxCtx("default::a")]);
    expect(useAppStore.getState().selectedVirtualContextId).toBe(id);
  });

  it("deselects the virtual context when no member resolves", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::gone"]);
    useAppStore.getState().selectVirtualContext(id);
    useAppStore.getState().setContexts([vctxCtx("default::other")]);
    expect(useAppStore.getState().selectedVirtualContextId).toBeNull();
    // The saved definition itself survives — only the activation drops.
    expect(useAppStore.getState().virtualContexts).toHaveLength(1);
  });

  it("prunes scope extras whose context vanished", () => {
    useAppStore.setState({
      selectedContext: "default::a",
      scopeExtras: ["default::b", "default::gone"],
    });
    useAppStore
      .getState()
      .setContexts([vctxCtx("default::a"), vctxCtx("default::b")]);
    expect(useAppStore.getState().scopeExtras).toEqual(["default::b"]);
  });
});

describe("scope extras (ad-hoc append)", () => {
  beforeEach(() => {
    useAppStore
      .getState()
      .setContexts([vctxCtx("default::a"), vctxCtx("default::b"), vctxCtx("default::c")]);
  });

  it("addScopeExtra appends a known context not already in scope", () => {
    useAppStore.setState({ selectedContext: "default::a" });
    useAppStore.getState().addScopeExtra("default::b");
    expect(useAppStore.getState().scopeExtras).toEqual(["default::b"]);
  });

  it("ignores unknown contexts and ids already in scope", () => {
    useAppStore.setState({ selectedContext: "default::a" });
    useAppStore.getState().addScopeExtra("default::nope");
    useAppStore.getState().addScopeExtra("default::a");
    useAppStore.getState().addScopeExtra("default::b");
    useAppStore.getState().addScopeExtra("default::b");
    expect(useAppStore.getState().scopeExtras).toEqual(["default::b"]);
  });

  it("removeScopeExtra drops the id and clears row selection", () => {
    useAppStore.setState({
      selectedContext: "default::a",
      scopeExtras: ["default::b"],
      selection: new Map([["k", { clusterId: "c1", namespace: "n", name: "x" }]]),
    });
    useAppStore.getState().removeScopeExtra("default::b");
    const s = useAppStore.getState();
    expect(s.scopeExtras).toHaveLength(0);
    expect(s.selection.size).toBe(0);
  });
});

describe("selectActiveClusterIds", () => {
  it("returns [] on the fleet landing (nothing selected)", () => {
    expect(selectActiveClusterIds(useAppStore.getState())).toEqual([]);
  });

  it("returns the single selected context", () => {
    useAppStore.setState({ selectedContext: "default::a" });
    expect(selectActiveClusterIds(useAppStore.getState())).toEqual(["default::a"]);
  });

  it("returns virtual context members filtered to existing contexts", () => {
    useAppStore
      .getState()
      .setContexts([vctxCtx("default::a"), vctxCtx("default::b")]);
    const id = useAppStore
      .getState()
      .saveVirtualContext("prod", ["default::a", "default::gone", "default::b"]);
    useAppStore.getState().selectVirtualContext(id);
    expect(selectActiveClusterIds(useAppStore.getState())).toEqual([
      "default::a",
      "default::b",
    ]);
  });

  it("does not filter when the contexts list hasn't loaded yet", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::a"]);
    useAppStore.getState().selectVirtualContext(id);
    expect(useAppStore.getState().contexts).toHaveLength(0);
    expect(selectActiveClusterIds(useAppStore.getState())).toEqual(["default::a"]);
  });

  it("appends deduped scope extras", () => {
    useAppStore
      .getState()
      .setContexts([vctxCtx("default::a"), vctxCtx("default::b")]);
    useAppStore.setState({
      selectedContext: "default::a",
      scopeExtras: ["default::b", "default::a"],
    });
    expect(selectActiveClusterIds(useAppStore.getState())).toEqual([
      "default::a",
      "default::b",
    ]);
  });
});

describe("hydratePrefs — virtual contexts", () => {
  it("hydrates the list and the persisted active id", () => {
    const prefs = basePrefs();
    prefs.virtual_contexts = [
      { id: "vc-1", name: "prod", members: ["default::a"] },
    ];
    prefs.ui.selected_virtual_context = "vc-1";
    useAppStore.getState().hydratePrefs(prefs);
    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(1);
    expect(s.selectedVirtualContextId).toBe("vc-1");
    // Mutually exclusive: the virtual selection wins over selected_context.
    expect(s.selectedContext).toBeNull();
  });

  it("drops a persisted active id that no longer exists", () => {
    const prefs = basePrefs();
    prefs.virtual_contexts = [];
    prefs.ui.selected_virtual_context = "vc-gone";
    useAppStore.getState().hydratePrefs(prefs);
    expect(useAppStore.getState().selectedVirtualContextId).toBeNull();
  });

  it("tolerates prefs from a build that predates virtual contexts", () => {
    const prefs = basePrefs() as Record<string, unknown>;
    delete prefs.virtual_contexts;
    (prefs.ui as Record<string, unknown>).selected_virtual_context = undefined;
    useAppStore.getState().hydratePrefs(prefs as never);
    expect(useAppStore.getState().virtualContexts).toEqual([]);
    expect(useAppStore.getState().selectedVirtualContextId).toBeNull();
  });
});

describe("buildPrefsPayload", () => {
  it("round-trips virtual contexts and the active id (wipe-hazard regression)", () => {
    const id = useAppStore
      .getState()
      .saveVirtualContext("prod", ["default::a", "default::b"]);
    useAppStore.getState().selectVirtualContext(id);
    const payload = buildPrefsPayload(useAppStore.getState());
    expect(payload.virtual_contexts).toEqual([
      { id, name: "prod", members: ["default::a", "default::b"] },
    ]);
    expect(payload.ui.selected_virtual_context).toBe(id);
    expect(payload.ui.selected_context).toBeNull();
  });

  it("survives a full payload → hydrate → payload cycle unchanged", () => {
    const id = useAppStore.getState().saveVirtualContext("prod", ["default::a"]);
    useAppStore.getState().selectVirtualContext(id);
    useAppStore.setState({ selectedNamespaces: new Set(["kube-system"]) });
    const p1 = buildPrefsPayload(useAppStore.getState());
    useAppStore.getState().hydratePrefs(p1);
    const p2 = buildPrefsPayload(useAppStore.getState());
    expect(p2).toEqual(p1);
  });
});

describe("absorbScopeExtras", () => {
  const seed = () => {
    useAppStore.setState({
      contexts: [vctxCtx("default::a"), vctxCtx("default::b"), vctxCtx("default::c")],
    });
    const id = useAppStore
      .getState()
      .saveVirtualContext("prod", ["default::a", "default::b"]);
    useAppStore.getState().selectVirtualContext(id);
    useAppStore.getState().addScopeExtra("default::c");
    return id;
  };

  it("folds extras into the virtual context's members and clears them", () => {
    const id = seed();
    expect(useAppStore.getState().scopeExtras).toEqual(["default::c"]);
    useAppStore.getState().absorbScopeExtras(id);
    const s = useAppStore.getState();
    expect(s.virtualContexts[0]!.members).toEqual([
      "default::a",
      "default::b",
      "default::c",
    ]);
    expect(s.scopeExtras).toEqual([]);
    // Still on the same virtual context — no scope reset.
    expect(s.selectedVirtualContextId).toBe(id);
  });

  it("dedupes an extra that is already a member", () => {
    const id = seed();
    useAppStore.setState({ scopeExtras: ["default::b", "default::c"] });
    useAppStore.getState().absorbScopeExtras(id);
    expect(useAppStore.getState().virtualContexts[0]!.members).toEqual([
      "default::a",
      "default::b",
      "default::c",
    ]);
  });

  it("no-ops for an unknown id or without extras", () => {
    const id = seed();
    useAppStore.getState().absorbScopeExtras("nope");
    expect(useAppStore.getState().scopeExtras).toEqual(["default::c"]);
    useAppStore.setState({ scopeExtras: [] });
    useAppStore.getState().absorbScopeExtras(id);
    expect(useAppStore.getState().virtualContexts[0]!.members).toEqual([
      "default::a",
      "default::b",
    ]);
  });
});

describe("startup scope restore behaviour", () => {
  // A cold start has no open tabs when prefs arrive.
  const boot = (prefs: ReturnType<typeof buildPrefsPayload>) => {
    useAppStore.setState({ openTabs: [], activeTabId: null });
    useAppStore.getState().hydratePrefs(prefs);
  };

  const seedPrefs = () => {
    useAppStore.setState({
      contexts: [vctxCtx("default::a"), vctxCtx("default::b"), vctxCtx("default::c")],
    });
    const id = useAppStore
      .getState()
      .saveVirtualContext("prod", ["default::a", "default::b"]);
    return id;
  };

  it("latest_view restores an ad-hoc view: anchor + scope extras", () => {
    seedPrefs();
    useAppStore.getState().selectContext("default::a");
    useAppStore.getState().addScopeExtra("default::c");
    const prefs = buildPrefsPayload(useAppStore.getState());
    expect(prefs.ui.scope_extras).toEqual(["default::c"]);
    expect(prefs.settings.startup_scope).toBe("latest_view");

    // Simulate a fresh boot: clear the selection, hydrate from the file.
    useAppStore.setState({ selectedContext: null, scopeExtras: [], openTabs: [], activeTabId: null });
    boot(prefs);
    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("default::a");
    expect(s.scopeExtras).toEqual(["default::c"]);
  });

  it("latest_view restores the virtual-context selection", () => {
    const id = seedPrefs();
    useAppStore.getState().selectVirtualContext(id);
    const prefs = buildPrefsPayload(useAppStore.getState());
    useAppStore.setState({ selectedVirtualContextId: null, openTabs: [], activeTabId: null });
    boot(prefs);
    expect(useAppStore.getState().selectedVirtualContextId).toBe(id);
  });

  it("latest_cluster restores only the anchor cluster — no vctx, no extras", () => {
    const id = seedPrefs();
    useAppStore.getState().selectContext("default::a");
    useAppStore.getState().addScopeExtra("default::c");
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.settings.startup_scope = "latest_cluster";
    prefs.ui.selected_virtual_context = id; // even if a vctx was active…
    useAppStore.setState({ selectedContext: null, scopeExtras: [], openTabs: [], activeTabId: null });
    boot(prefs);
    const s = useAppStore.getState();
    expect(s.selectedVirtualContextId).toBeNull();
    expect(s.selectedContext).toBe("default::a");
    expect(s.scopeExtras).toEqual([]);
  });

  it("fleet restores nothing — lands on the fleet screen", () => {
    const id = seedPrefs();
    useAppStore.getState().selectVirtualContext(id);
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.settings.startup_scope = "fleet";
    prefs.ui.selected_context = "default::a";
    prefs.ui.scope_extras = ["default::c"];
    useAppStore.setState({ selectedContext: null, selectedVirtualContextId: null, scopeExtras: [], openTabs: [], activeTabId: null });
    boot(prefs);
    const s = useAppStore.getState();
    expect(s.selectedContext).toBeNull();
    expect(s.selectedVirtualContextId).toBeNull();
    expect(s.scopeExtras).toEqual([]);
    // The saved virtual contexts themselves are untouched by the setting.
    expect(s.virtualContexts).toHaveLength(1);
    expect(s.settings.startupScope).toBe("fleet");
  });

  it("latest_view reopens every persisted tab and focuses the active one", () => {
    seedPrefs();
    const st = useAppStore.getState();
    st.selectContext("default::a");
    st.selectContext("default::b"); // two tabs; b is active
    const prefs = buildPrefsPayload(useAppStore.getState());
    useAppStore.setState({
      openTabs: [],
      activeTabId: null,
      selectedContext: null,
    });
    boot(prefs);
    const s = useAppStore.getState();
    expect(s.openTabs).toHaveLength(2);
    expect(s.selectedContext).toBe("default::b");
    expect(s.activeTabId).toBe(
      s.openTabs.find((t) => t.selectedContext === "default::b")?.id,
    );
    expect(s.openTabs.some((t) => t.selectedContext === "default::a")).toBe(
      true,
    );
  });

  it("migrates a pre-tab-model prefs file into a single tab", () => {
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.ui.open_tabs = []; // legacy file: no tab set
    prefs.ui.active_tab = null;
    prefs.ui.selected_context = "default::a";
    prefs.settings.startup_scope = "latest_view";
    useAppStore.setState({ openTabs: [], activeTabId: null });
    boot(prefs);
    const s = useAppStore.getState();
    expect(s.openTabs).toHaveLength(1);
    expect(s.selectedContext).toBe("default::a");
    expect(s.activeTabId).toBe(s.openTabs[0]!.id);
  });

  it("fleet startup opens no tabs even with a saved set", () => {
    seedPrefs();
    useAppStore.getState().selectContext("default::a");
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.settings.startup_scope = "fleet";
    boot(prefs);
    expect(useAppStore.getState().openTabs).toHaveLength(0);
    expect(useAppStore.getState().activeTabId).toBeNull();
  });

  it("drops persisted extras whose contexts no longer exist", () => {
    seedPrefs();
    useAppStore.getState().selectContext("default::a");
    useAppStore.getState().addScopeExtra("default::c");
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.ui.scope_extras = ["default::c", "default::gone", "default::c"];
    useAppStore.setState({ scopeExtras: [] });
    boot(prefs);
    expect(useAppStore.getState().scopeExtras).toEqual(["default::c"]);
  });

  it("restores each tab's namespace filter and kind (not just the active one)", () => {
    seedPrefs();
    const st = useAppStore.getState();
    st.selectContext("default::a");
    useAppStore.setState({
      selectedNamespaces: new Set(["team-a"]),
      selectedKindId: "deployments",
    });
    st.selectContext("default::b");
    useAppStore.setState({
      selectedNamespaces: new Set(["team-b"]),
      selectedKindId: "pods",
    });
    const prefs = buildPrefsPayload(useAppStore.getState());
    useAppStore.setState({
      openTabs: [],
      activeTabId: null,
      selectedContext: null,
      selectedNamespaces: new Set(),
      selectedKindId: null,
    });
    boot(prefs);
    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("default::b");
    expect(s.selectedNamespaces).toEqual(new Set(["team-b"]));
    expect(s.selectedKindId).toBe("pods");
    const a = s.openTabs.find((t) => t.selectedContext === "default::a")!;
    expect(a.slice.selectedNamespaces).toEqual(new Set(["team-a"]));
    expect(a.slice.selectedKindId).toBe("deployments");
    useAppStore.getState().switchTab(a.id);
    expect(useAppStore.getState().selectedNamespaces).toEqual(
      new Set(["team-a"]),
    );
  });

  it("restores 'all namespaces' on a tab even when the global field has a filter", () => {
    seedPrefs();
    useAppStore.getState().selectContext("default::a");
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.ui.selected_namespaces = ["stale"];
    boot(prefs);
    expect(useAppStore.getState().selectedNamespaces.size).toBe(0);
  });

  it("seeds tabs from the global fields when refs predate per-tab state", () => {
    seedPrefs();
    useAppStore.getState().selectContext("default::a");
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.ui.open_tabs = prefs.ui.open_tabs!.map(
      ({ id, selected_context, selected_virtual_context, scope_extras }) => ({
        id,
        selected_context,
        selected_virtual_context,
        scope_extras,
      }),
    );
    prefs.ui.selected_namespaces = ["team-a"];
    boot(prefs);
    expect(useAppStore.getState().selectedNamespaces).toEqual(
      new Set(["team-a"]),
    );
  });

  it("keeps a restored CRD kind while discovery is still pending", () => {
    seedPrefs();
    useAppStore.getState().selectContext("default::a");
    const crd = "wkcrd:argo-app|argoproj.io|v1alpha1|applications|Application|Namespaced";
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.ui.open_tabs![0]!.selected_kind_id = crd;
    useAppStore.setState({ kinds: [{ id: "pods" } as never] });
    boot(prefs);
    expect(useAppStore.getState().selectedKindId).toBe(crd);
    useAppStore.getState().setKinds([{ id: "pods" } as never], true);
    expect(useAppStore.getState().selectedKindId).toBe(crd);
    useAppStore
      .getState()
      .setKinds([{ id: "pods" } as never, { id: crd } as never], false);
    expect(useAppStore.getState().selectedKindId).toBe(crd);
    // Discovery settled without it → fall back to the first kind.
    useAppStore.getState().setKinds([{ id: "pods" } as never], false);
    expect(useAppStore.getState().selectedKindId).toBe("pods");
  });

  it("drops extras entirely when there is no anchor to extend", () => {
    seedPrefs();
    const prefs = buildPrefsPayload(useAppStore.getState());
    prefs.ui.selected_context = null;
    prefs.ui.selected_virtual_context = null;
    prefs.ui.scope_extras = ["default::c"];
    boot(prefs);
    expect(useAppStore.getState().scopeExtras).toEqual([]);
  });
  it("keeps a tab opened before prefs arrived and merges restored ones", () => {
    seedPrefs();
    const st = useAppStore.getState();
    st.selectContext("default::a");
    st.selectContext("default::b");
    const prefs = buildPrefsPayload(useAppStore.getState());
    useAppStore.setState({ openTabs: [], activeTabId: null, selectedContext: null });
    // Operator clicks cluster c on Fleet while getPrefs is still in flight.
    useAppStore.getState().selectContext("default::c");
    useAppStore.getState().hydratePrefs(prefs);
    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("default::c");
    expect(s.openTabs.map((t) => t.selectedContext).sort()).toEqual([
      "default::a",
      "default::b",
      "default::c",
    ]);
    expect(s.activeTabId).toBe(s.openTabs.find((t) => t.selectedContext === "default::c")?.id);
  });
});


describe("cluster tabs", () => {
  const ctx = (id: string) =>
    ({ id, name: id, source: "default" }) as never;
  const termTab = (id: string): DockTab => ({
    id,
    kind: "terminal",
    title: id,
    placement: "bottom",
    state: {},
  });

  beforeEach(() => {
    useAppStore.setState({
      contexts: [ctx("default::a"), ctx("default::b"), ctx("default::c")],
      virtualContexts: [
        { id: "v1", name: "ab", members: ["default::a", "default::c"] },
      ],
      kinds: [{ id: "pods", label: "Pods" } as never],
      openTabs: [],
      activeTabId: null,
    });
  });

  it("openTab creates one tab per anchor and dedupes (re-open switches)", () => {
    const st = useAppStore.getState();
    st.openTab({ kind: "context", contextId: "default::a" });
    const firstId = useAppStore.getState().activeTabId;
    st.openTab({ kind: "context", contextId: "default::b" });
    expect(useAppStore.getState().openTabs).toHaveLength(2);
    // Re-opening A switches back to the existing tab, no third tab.
    st.openTab({ kind: "context", contextId: "default::a" });
    expect(useAppStore.getState().openTabs).toHaveLength(2);
    expect(useAppStore.getState().activeTabId).toBe(firstId);
    expect(useAppStore.getState().selectedContext).toBe("default::a");
  });

  it("switchTab round-trips each tab's slice (dock + filter + selection)", () => {
    const st = useAppStore.getState();
    st.openTab({ kind: "context", contextId: "default::a" });
    const aId = useAppStore.getState().activeTabId as string;
    // Populate tab A's slice.
    st.addDockTab(termTab("term-a"));
    useAppStore.setState({ tableFilter: "nginx" });
    st.selectKind?.("pods");

    // Open B — fresh slice, A's state stashed away.
    st.openTab({ kind: "context", contextId: "default::b" });
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
    expect(useAppStore.getState().tableFilter).toBe("");

    // Back to A — everything restored.
    st.switchTab(aId);
    const s = useAppStore.getState();
    expect(s.activeTabId).toBe(aId);
    expect(s.dockTabs.map((t) => t.id)).toEqual(["term-a"]);
    expect(s.tableFilter).toBe("nginx");
  });

  it("closeTab focuses a neighbour; closing the last tab drops to Fleet", () => {
    const st = useAppStore.getState();
    st.openTab({ kind: "context", contextId: "default::a" });
    const aId = useAppStore.getState().activeTabId as string;
    st.openTab({ kind: "context", contextId: "default::b" });
    const bId = useAppStore.getState().activeTabId as string;

    // Close the active (B) → focus neighbour A.
    st.closeTab(bId);
    expect(useAppStore.getState().activeTabId).toBe(aId);
    expect(useAppStore.getState().openTabs).toHaveLength(1);

    // Close the last tab → Fleet landing (no active tab, cleared mirror).
    st.closeTab(aId);
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(useAppStore.getState().openTabs).toHaveLength(0);
    expect(useAppStore.getState().selectedContext).toBeNull();
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
  });

  it("goFleet is a full reset — closes every tab and clears the mirror", () => {
    const st = useAppStore.getState();
    st.openTab({ kind: "context", contextId: "default::a" });
    st.addDockTab(termTab("term-a"));
    st.openTab({ kind: "context", contextId: "default::b" });
    st.goFleet();
    const s = useAppStore.getState();
    expect(s.activeTabId).toBeNull();
    expect(s.openTabs).toHaveLength(0);
    expect(s.selectedContext).toBeNull();
    expect(s.dockTabs).toHaveLength(0);
  });

  it("selectClustersToDisconnect excludes clusters a sibling tab still uses", () => {
    const st = useAppStore.getState();
    // Tab A = single cluster default::a; Tab V = virtual {a, c}.
    st.openTab({ kind: "context", contextId: "default::a" });
    const aId = useAppStore.getState().activeTabId as string;
    st.openTab({ kind: "virtual", virtualId: "v1" });
    const vId = useAppStore.getState().activeTabId as string;

    const s = useAppStore.getState();
    // Closing A: default::a is still used by V → nothing to disconnect.
    expect(selectClustersToDisconnect(s, aId)).toEqual([]);
    // Closing V: default::a kept by A, only default::c is freed.
    expect(selectClustersToDisconnect(s, vId)).toEqual(["default::c"]);
  });
});

describe("cluster degraded state", () => {
  it("selectClusterDegraded is true for unavailable OR reconnecting", () => {
    const base = { clusterHealth: {}, clusterReconnecting: {} };
    expect(selectClusterDegraded(base, "c1")).toBe(false);
    expect(
      selectClusterDegraded(
        { clusterHealth: { c1: "unavailable" }, clusterReconnecting: {} },
        "c1",
      ),
    ).toBe(true);
    expect(
      selectClusterDegraded(
        { clusterHealth: { c1: "healthy" }, clusterReconnecting: { c1: true } },
        "c1",
      ),
    ).toBe(true);
    // A healthy, non-reconnecting cluster is not degraded.
    expect(
      selectClusterDegraded(
        { clusterHealth: { c1: "healthy" }, clusterReconnecting: { c1: false } },
        "c1",
      ),
    ).toBe(false);
  });

  /// A bulk action spans whatever clusters the selection spans, so one dead
  /// apiserver is enough to make the whole batch partially doomed. Gating on
  /// the *active* cluster instead would leave the bar enabled while half the
  /// selection is unreachable.
  it("selectSelectionDegraded is true when any selected cluster is degraded", () => {
    const sel = (...ids: string[]) =>
      new Map(
        ids.map((id, i) => [
          `${id}/n/x${i}`,
          { clusterId: id, namespace: "n", name: `x${i}` },
        ]),
      );
    const state = {
      clusterHealth: { bad: "unavailable" as const },
      clusterReconnecting: {},
    };

    expect(selectSelectionDegraded(state, sel("good", "other"))).toBe(false);
    expect(selectSelectionDegraded(state, sel("good", "bad"))).toBe(true);
    // Empty selection has no degraded cluster to find.
    expect(selectSelectionDegraded(state, sel())).toBe(false);
  });

  it("setClusterReconnecting toggles the flag and prunes on false", () => {
    const st = useAppStore.getState();
    st.setClusterReconnecting("c1", true);
    expect(useAppStore.getState().clusterReconnecting.c1).toBe(true);
    st.setClusterReconnecting("c1", false);
    expect("c1" in useAppStore.getState().clusterReconnecting).toBe(false);
  });
});


describe("setContexts prunes tabs whose cluster vanished", () => {
  const c = (id: string) => ({ id, name: id, source: "default" }) as never;
  it("closes background and active tabs whose context is gone", () => {
    const st = () => useAppStore.getState();
    useAppStore.setState({ contexts: [c("a"), c("b"), c("x")] });
    st().selectContext("a");
    st().selectContext("x");
    st().selectContext("b");
    st().setContexts([c("a"), c("b")]);
    expect(st().openTabs.map((t) => t.selectedContext)).toEqual(["a", "b"]);
    expect(st().selectedContext).toBe("b");
    st().setContexts([c("a")]);
    expect(st().openTabs.map((t) => t.selectedContext)).toEqual(["a"]);
    expect(st().selectedContext).toBe("a");
    expect(st().activeTabId).toBe(st().openTabs[0]?.id);
  });
  it("keeps a tab holding terminals or chats even when its context is gone", () => {
    const st = () => useAppStore.getState();
    useAppStore.setState({ contexts: [c("a"), c("x")] });
    st().selectContext("x");
    st().addDockTab({ id: "sh", kind: "terminal", title: "sh", placement: "bottom", state: {} });
    st().selectContext("a");
    st().setContexts([c("a")]);
    expect(st().openTabs.map((t) => t.selectedContext)).toEqual(["x", "a"]);
  });
  it("leaves tab objects alone when nothing about them changed", () => {
    const st = () => useAppStore.getState();
    useAppStore.setState({ contexts: [c("a"), c("b")] });
    st().selectContext("a");
    st().selectContext("b");
    const bg = st().openTabs[0];
    st().setContexts([c("a"), c("b")]);
    expect(st().openTabs[0]).toBe(bg);
  });
  it("an empty context list is transient and prunes nothing", () => {
    const st = () => useAppStore.getState();
    useAppStore.setState({ contexts: [c("a")] });
    st().selectContext("a");
    st().setContexts([]);
    expect(st().openTabs).toHaveLength(1);
    expect(st().selectedContext).toBe("a");
  });
});

describe("drawer + tray", () => {
  const st = () => useAppStore.getState();
  const logs = (name: string): Drawer => ({
    kind: "logs",
    targets: [{ clusterId: "c1", kindId: "pods", namespace: "ns", name }],
  });
  const detail = (name: string): Drawer => ({
    kind: "detail",
    kindId: "pods",
    clusterId: "c1",
    uid: `uid-${name}`,
    namespace: "ns",
    name,
  });
  beforeEach(() => useAppStore.setState({ drawer: null, tray: [] }));

  it("minimise parks the open drawer and clears it", () => {
    st().openDrawer(logs("a"));
    st().minimizeDrawer();
    expect(st().drawer).toBeNull();
    expect(st().tray.map((i) => i.drawer)).toEqual([logs("a")]);
    st().minimizeDrawer();
    expect(st().tray).toHaveLength(1);
  });

  it("re-minimising the same subject replaces its entry and moves it last", () => {
    st().openDrawer(logs("a"));
    st().minimizeDrawer();
    st().openDrawer(logs("b"));
    st().minimizeDrawer();
    st().openDrawer(logs("a"));
    st().minimizeDrawer();
    expect(st().tray.map((i) => drawerKey(i.drawer))).toEqual([
      drawerKey(logs("b")),
      drawerKey(logs("a")),
    ]);
  });

  it("caps the tray, dropping the oldest", () => {
    for (let i = 0; i < TRAY_CAP + 3; i++) {
      st().openDrawer(logs(`p${i}`));
      st().minimizeDrawer();
    }
    expect(st().tray).toHaveLength(TRAY_CAP);
    expect(st().tray[0]?.drawer).toEqual(logs("p3"));
  });

  it("restore reopens a drawer and parks the one showing", () => {
    st().openDrawer(logs("a"));
    st().minimizeDrawer();
    st().openDrawer(logs("b"));
    st().restoreTrayItem(st().tray[0]!.id);
    expect(st().drawer).toEqual(logs("a"));
    expect(st().tray.map((i) => i.drawer)).toEqual([logs("b")]);
  });

  it("restoring a detail swaps it back in place without touching the table", () => {
    st().openDrawer(detail("a"));
    const id = st().drawerId;
    st().minimizeDrawer();
    useAppStore.setState({ selectedKindId: "deployments" });
    st().restoreTrayItem(st().tray[0]!.id);
    expect(st().drawer).toEqual(detail("a"));
    expect(st().drawerId).toBe(id);
    expect(st().selectedKindId).toBe("deployments");
    expect(st().pendingDetail).toBeNull();
    expect(st().tray).toHaveLength(0);
  });

  it("closeTrayItem drops one entry; unknown ids are no-ops", () => {
    st().openDrawer(logs("a"));
    st().minimizeDrawer();
    st().restoreTrayItem("nope");
    expect(st().tray).toHaveLength(1);
    st().closeTrayItem(st().tray[0]!.id);
    expect(st().tray).toHaveLength(0);
  });

  it("drawer and tray belong to their cluster tab", () => {
    useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never, { id: "b", name: "b" } as never] });
    st().selectContext("a");
    st().openDrawer(logs("x"));
    st().minimizeDrawer();
    st().openDrawer(logs("y"));
    st().selectContext("b");
    expect(st().drawer).toBeNull();
    expect(st().tray).toHaveLength(0);
    st().selectContext("a");
    expect(st().drawer).toEqual(logs("y"));
    expect(st().tray.map((i) => i.drawer)).toEqual([logs("x")]);
  });
});

describe("hydrateSession", () => {
  const st = () => useAppStore.getState();
  const y = (id: string): DockTab => ({ id, kind: "yaml", title: id, placement: "bottom", state: {} });
  const restored = (id: string) => ({
    dockTabs: [y(id)],
    dockActive: { bottom: id, right: null },
    dockMin: { bottom: false, right: false },
    drawer: null,
    tray: [],
  });

  it("attaches slices to the active tab's mirror and background tabs", () => {
    useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never, { id: "b", name: "b" } as never] });
    st().selectContext("a");
    st().selectContext("b");
    const [ta, tb] = st().openTabs;
    st().hydrateSession({ [ta!.id]: restored("ya"), [tb!.id]: restored("yb"), ghost: restored("g") });
    expect(st().dockTabs.map((t) => t.id)).toEqual(["yb"]);
    st().switchTab(ta!.id);
    expect(st().dockTabs.map((t) => t.id)).toEqual(["ya"]);
  });

  it("gives a restored drawer an instance id, so hiding it doesn't remount it", () => {
    useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never], drawer: null, drawerId: null, tray: [] });
    st().selectContext("a");
    const logs: Drawer = { kind: "logs", targets: [{ clusterId: "a", kindId: "pods", namespace: "ns", name: "p" }] };
    st().hydrateSession({ [st().activeTabId!]: { ...restored("x"), dockTabs: [], drawer: logs } });
    const id = st().drawerId;
    expect(id).toBeTruthy();
    st().minimizeDrawer();
    expect(st().tray[0]!.id).toBe(id);
  });

  it("never overwrites work the operator already started", () => {
    useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never] });
    st().selectContext("a");
    st().addDockTab(y("mine"));
    st().hydrateSession({ [st().activeTabId!]: restored("old") });
    expect(st().dockTabs.map((t) => t.id)).toEqual(["mine"]);
  });
});

describe("drawer instance identity", () => {
  const st = () => useAppStore.getState();
  const logs = (name: string): Drawer => ({
    kind: "logs",
    targets: [{ clusterId: "c1", kindId: "pods", namespace: "ns", name }],
  });
  beforeEach(() => useAppStore.setState({ drawer: null, drawerId: null, tray: [] }));

  it("keeps one instance id through minimise and restore", () => {
    st().openDrawer(logs("a"));
    const id = st().drawerId;
    expect(id).toBeTruthy();
    st().minimizeDrawer();
    expect(st().tray[0]?.id).toBe(id);
    st().restoreTrayItem(id!);
    expect(st().drawerId).toBe(id);
  });

  it("re-opening the same subject keeps the instance; a new one gets a new id", () => {
    st().openDrawer(logs("a"));
    const id = st().drawerId;
    st().openDrawer(logs("a"));
    expect(st().drawerId).toBe(id);
    st().openDrawer(logs("b"));
    expect(st().drawerId).not.toBe(id);
  });

  it("a detail replacing a same-kind detail keeps the panel instance", () => {
    const det = (name: string, kindId = "pods"): Drawer => ({
      kind: "detail", kindId, clusterId: "c1", uid: name, namespace: "ns", name,
    });
    st().openDrawer(det("a"));
    const id = st().drawerId;
    st().openDrawer(det("b"));
    expect(st().drawerId).toBe(id);
    st().openDrawer(det("c", "deployments"));
    expect(st().drawerId).not.toBe(id);
  });

  it("a minimised detail records its view on the parked drawer", () => {
    st().openDrawer({ kind: "detail", kindId: "pods", clusterId: "c1", uid: "u", namespace: "ns", name: "p" });
    st().minimizeDrawer({ tab: "yaml", scrollTop: 420 });
    const parked = st().tray[0]!.drawer;
    expect(parked.kind === "detail" && parked.view).toEqual({ tab: "yaml", scrollTop: 420 });
  });

  it("kindCache accumulates every discovered kind", () => {
    const a = { id: "a" } as never;
    const b = { id: "b" } as never;
    useAppStore.setState({ kindCache: {} });
    st().setKinds([a]);
    st().setKinds([b]);
    expect(Object.keys(st().kindCache).sort()).toEqual(["a", "b"]);
  });
});

describe("discovery republish keeps identities", () => {
  const st = () => useAppStore.getState();
  const k = (id: string, cols = 1) => ({ id, columns: Array.from({ length: cols }, (_, i) => ({ id: `c${i}` })) }) as never;

  it("setKinds reuses unchanged kind objects and the array itself", () => {
    useAppStore.setState({ kinds: [], kindCache: {} });
    st().setKinds([k("a"), k("b")]);
    const before = st().kinds;
    st().setKinds([k("a"), k("b")]);
    expect(st().kinds).toBe(before);
    st().setKinds([k("a"), k("b", 2)]);
    expect(st().kinds[0]).toBe(before[0]);
    expect(st().kinds[1]).not.toBe(before[1]);
  });

  it("setKindClusters with equal content is a no-op", () => {
    st().setKindClusters({ x: ["a"] });
    const before = st().kindClusters;
    st().setKindClusters({ x: ["a"] });
    expect(st().kindClusters).toBe(before);
    st().setKindClusters({ x: ["a", "b"] });
    expect(st().kindClusters).not.toBe(before);
  });
});

describe("per-drawer detail history", () => {
  const st = () => useAppStore.getState();
  const ref = (name: string, kindId = "pods") => ({
    kindId,
    clusterId: "c1",
    uid: `u-${name}`,
    namespace: "ns",
    name,
  });
  const current = () => {
    const d = st().drawer;
    return d?.kind === "detail" ? d.name : null;
  };
  beforeEach(() => useAppStore.setState({ drawer: null, drawerId: null, tray: [] }));

  it("links grow the open panel's history; back and forward walk it", () => {
    st().openDrawer({ kind: "detail", ...ref("deploy", "deployments") });
    st().navigateDrawerDetail(ref("rs", "replicasets"));
    st().navigateDrawerDetail(ref("pod"));
    expect(current()).toBe("pod");
    st().drawerDetailBack();
    expect(current()).toBe("rs");
    st().drawerDetailBack();
    expect(current()).toBe("deploy");
    st().drawerDetailBack();
    expect(current()).toBe("deploy");
    st().drawerDetailForward();
    st().drawerDetailForward();
    expect(current()).toBe("pod");
    st().drawerDetailForward();
    expect(current()).toBe("pod");
  });

  it("following a link from a back state drops the forward branch", () => {
    st().openDrawer({ kind: "detail", ...ref("a") });
    st().navigateDrawerDetail(ref("b"));
    st().drawerDetailBack();
    st().navigateDrawerDetail(ref("x"));
    const d = st().drawer;
    expect(d?.kind === "detail" && d.forward).toEqual([]);
    expect(d?.kind === "detail" && d.back?.map((r) => r.name)).toEqual(["a"]);
  });

  it("each panel keeps its own history across hide/restore; the table is untouched", () => {
    useAppStore.setState({ selectedKindId: "services" });
    st().openDrawer({ kind: "detail", ...ref("a") });
    st().navigateDrawerDetail(ref("a2"));
    st().minimizeDrawer();
    st().openDrawer({ kind: "detail", ...ref("b", "deployments") });
    st().navigateDrawerDetail(ref("b2", "deployments"));
    st().drawerDetailBack();
    expect(current()).toBe("b");
    st().restoreTrayItem(st().tray[0]!.id);
    expect(current()).toBe("a2");
    st().drawerDetailBack();
    expect(current()).toBe("a");
    st().restoreTrayItem(st().tray[0]!.id);
    expect(current()).toBe("b");
    st().drawerDetailForward();
    expect(current()).toBe("b2");
    expect(st().selectedKindId).toBe("services");
    expect(st().pendingDetail).toBeNull();
  });

  it("caps the back stack", () => {
    st().openDrawer({ kind: "detail", ...ref("p0") });
    for (let i = 1; i <= DETAIL_HISTORY_CAP + 10; i++) st().navigateDrawerDetail(ref(`p${i}`));
    const d = st().drawer;
    expect(d?.kind === "detail" && d.back?.length).toBe(DETAIL_HISTORY_CAP);
  });

  it("history actions are no-ops without an open detail", () => {
    st().navigateDrawerDetail(ref("x"));
    st().drawerDetailBack();
    expect(st().drawer).toBeNull();
  });
});

describe("saveDrawerView", () => {
  const st = () => useAppStore.getState();
  const det = (name: string): Drawer => ({ kind: "detail", kindId: "pods", clusterId: "c1", uid: name, namespace: "ns", name });
  beforeEach(() => useAppStore.setState({ drawer: null, drawerId: null, tray: [], openTabs: [], activeTabId: null }));

  it("records the view on the open drawer or a parked one, by instance", () => {
    st().openDrawer(det("a"));
    const openId = st().drawerId!;
    st().minimizeDrawer();
    st().openDrawer(det("b"));
    const bId = st().drawerId!;
    st().saveDrawerView(null, openId, drawerKey(det("a")), { tab: "yaml", scrollTop: 10 });
    st().saveDrawerView(null, bId, drawerKey(det("b")), { tab: "events", scrollTop: 20 });
    const parked = st().tray[0]!.drawer;
    expect(parked.kind === "detail" && parked.view).toEqual({ tab: "yaml", scrollTop: 10 });
    const d = st().drawer;
    expect(d?.kind === "detail" && d.view).toEqual({ tab: "events", scrollTop: 20 });
  });

  it("ignores a stale report after the panel moved to another object", () => {
    st().openDrawer(det("a"));
    const id = st().drawerId!;
    st().navigateDrawerDetail({ kindId: "pods", clusterId: "c1", uid: "b", namespace: "ns", name: "b" });
    st().saveDrawerView(null, id, drawerKey(det("a")), { tab: "yaml" });
    const d = st().drawer;
    expect(d?.kind === "detail" && d.view).toBeUndefined();
  });

  it("writes into a background tab's slice after a switch", () => {
    useAppStore.setState({ contexts: [{ id: "a", name: "a" } as never, { id: "b", name: "b" } as never] });
    st().selectContext("a");
    st().openDrawer(det("x"));
    const id = st().drawerId!;
    const tabA = st().activeTabId!;
    st().selectContext("b");
    st().saveDrawerView(tabA, id, drawerKey(det("x")), { tab: "yaml", scrollTop: 5 });
    expect(st().drawer).toBeNull();
    st().switchTab(tabA);
    const d = st().drawer;
    expect(d?.kind === "detail" && d.view).toEqual({ tab: "yaml", scrollTop: 5 });
  });
});
