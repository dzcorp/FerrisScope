// Reducer tests for useAppStore. Each test resets the store first so
// they don't interfere — Zustand's create() returns a singleton and
// without a reset our tests would inherit each other's mutations.

import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  NOTIFICATION_LOG_CAP,
  semverGt,
  selectUpdateAvailable,
  type DockTab,
  type ConfirmModal,
  type Toast,
} from "./store";

const initial = useAppStore.getState();

beforeEach(() => {
  // Reset to the initial state captured at module-load. We re-create the
  // collection types per reset so a previous test mutating one doesn't
  // bleed into the next.
  useAppStore.setState({
    ...initial,
    selectedNamespaces: new Set<string>(),
    selection: new Map<string, { namespace: string | null; name: string }>(),
    contexts: [],
    kinds: [],
    dockTabs: [],
    dockActiveId: null,
    modals: [],
    toasts: [],
    notifications: [],
    detailHistory: [],
    detailIndex: -1,
    pendingDetail: null,
    metrics: null,
    forwards: {},
    tableViews: {},
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
  it("drops selection / namespaces / dock / metrics so the next cluster starts clean", () => {
    useAppStore.setState({
      selection: new Map([["k", { namespace: "n", name: "x" }]]),
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
      dockActiveId: "t1",
      metrics: { pods: {}, available: false } as never,
      detailHistory: [{ kindId: "pods", namespace: "default", name: "x" }],
      detailIndex: 0,
    });

    useAppStore.getState().selectContext("ctx-2");

    const s = useAppStore.getState();
    expect(s.selectedContext).toBe("ctx-2");
    expect(s.selection.size).toBe(0);
    expect(s.selectedNamespaces.size).toBe(0);
    expect(s.dockTabs).toHaveLength(0);
    expect(s.dockActiveId).toBeNull();
    expect(s.metrics).toBeNull();
    expect(s.detailHistory).toHaveLength(0);
    expect(s.detailIndex).toBe(-1);
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
  it("appends entries to detailHistory and tracks index", () => {
    useAppStore.getState().navigateToDetail("pods", "default", "a");
    useAppStore.getState().navigateToDetail("pods", "default", "b");
    const s = useAppStore.getState();
    expect(s.detailHistory.map((e) => e.name)).toEqual(["a", "b"]);
    expect(s.detailIndex).toBe(1);
    expect(s.pendingDetail?.name).toBe("b");
    expect(s.selectedKindId).toBe("pods");
  });

  it("dedupes consecutive identical navigations", () => {
    useAppStore.getState().navigateToDetail("pods", "default", "a");
    useAppStore.getState().navigateToDetail("pods", "default", "a");
    expect(useAppStore.getState().detailHistory).toHaveLength(1);
  });

  it("drops the forward branch when navigating sideways from a back state", () => {
    useAppStore.getState().navigateToDetail("pods", "default", "a");
    useAppStore.getState().navigateToDetail("pods", "default", "b");
    useAppStore.getState().navigateToDetail("pods", "default", "c");
    // Simulate a "back" by lowering the index (the actual back action lives
    // elsewhere; we test the mutator's branch-drop behavior directly).
    useAppStore.setState({ detailIndex: 0 });
    useAppStore.getState().navigateToDetail("pods", "default", "x");
    const s = useAppStore.getState();
    expect(s.detailHistory.map((e) => e.name)).toEqual(["a", "x"]);
    expect(s.detailIndex).toBe(1);
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
    expect(s.dockActiveId).toBe("t1");
    // Only `bottom` un-minimised — `right` left alone so the chat panel
    // stays collapsed if it was.
    expect(s.dockMin.bottom).toBe(false);
    expect(s.dockMin.right).toBe(true);
  });

  it("closeDockTab on the active tab activates the next survivor in the same placement", () => {
    useAppStore.getState().addDockTab(mkTab("b1", "bottom"));
    useAppStore.getState().addDockTab(mkTab("b2", "bottom"));
    useAppStore.getState().addDockTab(mkTab("r1", "right"));
    // Active is r1 (last added). Closing it should leave the bottom group
    // alone and pick the last surviving right-placed tab — but there's
    // none, so fall through to the last overall tab.
    useAppStore.getState().closeDockTab("r1");
    expect(useAppStore.getState().dockActiveId).toBe("b2");
    // Closing the active b2 falls back to b1 (same placement).
    useAppStore.getState().closeDockTab("b2");
    expect(useAppStore.getState().dockActiveId).toBe("b1");
    // Closing the final tab nulls active.
    useAppStore.getState().closeDockTab("b1");
    expect(useAppStore.getState().dockActiveId).toBeNull();
  });

  it("closeDockTab on a non-active tab leaves the active selection alone", () => {
    useAppStore.getState().addDockTab(mkTab("a"));
    useAppStore.getState().addDockTab(mkTab("b"));
    // a is no longer active; closing it shouldn't move focus.
    expect(useAppStore.getState().dockActiveId).toBe("b");
    useAppStore.getState().closeDockTab("a");
    expect(useAppStore.getState().dockActiveId).toBe("b");
  });

  it("closeAllDockTabs / closeDockTabsByPlacement", () => {
    useAppStore.getState().addDockTab(mkTab("b1", "bottom"));
    useAppStore.getState().addDockTab(mkTab("r1", "right"));
    useAppStore.getState().closeDockTabsByPlacement("right");
    expect(useAppStore.getState().dockTabs.map((t) => t.id)).toEqual(["b1"]);
    // The active tab was r1; with right closed it falls back to the last
    // remaining tab.
    expect(useAppStore.getState().dockActiveId).toBe("b1");
    useAppStore.getState().closeAllDockTabs();
    expect(useAppStore.getState().dockTabs).toHaveLength(0);
    expect(useAppStore.getState().dockActiveId).toBeNull();
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
    useAppStore.getState().toggleSelection("uid-1", { namespace: "default", name: "p1" });
    expect(useAppStore.getState().selection.size).toBe(1);
    useAppStore.getState().toggleSelection("uid-1", { namespace: "default", name: "p1" });
    expect(useAppStore.getState().selection.size).toBe(0);
  });

  it("clearSelection wipes the map", () => {
    useAppStore.getState().toggleSelection("a", { namespace: null, name: "x" });
    useAppStore.getState().toggleSelection("b", { namespace: null, name: "y" });
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
    useAppStore.getState().setTableCount({ filtered: 3, total: 10 });
    expect(useAppStore.getState().tableCount).toEqual({ filtered: 3, total: 10 });
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

describe("cluster health", () => {
  it("applyClusterHealth records status + reason, clearClusterHealth removes both", () => {
    useAppStore.getState().applyClusterHealth("ctx", "unavailable", "tcp refused");
    expect(useAppStore.getState().clusterHealth["ctx"]).toBe("unavailable");
    expect(useAppStore.getState().clusterHealthReason["ctx"]).toBe("tcp refused");
    useAppStore.getState().clearClusterHealth("ctx");
    expect(useAppStore.getState().clusterHealth["ctx"]).toBeUndefined();
    expect(useAppStore.getState().clusterHealthReason["ctx"]).toBeUndefined();
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

describe("detail navigation back/forward", () => {
  it("back walks the history; forward returns; closeDetail clears", () => {
    const s = useAppStore.getState();
    s.navigateToDetail("pods", "default", "a");
    s.navigateToDetail("pods", "default", "b");
    s.navigateToDetail("pods", "default", "c");
    expect(useAppStore.getState().detailIndex).toBe(2);

    useAppStore.getState().detailBack();
    expect(useAppStore.getState().detailIndex).toBe(1);
    expect(useAppStore.getState().pendingDetail?.name).toBe("b");

    useAppStore.getState().detailBack();
    expect(useAppStore.getState().detailIndex).toBe(0);

    // Already at index 0 — further back is a no-op.
    useAppStore.getState().detailBack();
    expect(useAppStore.getState().detailIndex).toBe(0);

    useAppStore.getState().detailForward();
    expect(useAppStore.getState().detailIndex).toBe(1);
    expect(useAppStore.getState().pendingDetail?.name).toBe("b");

    // Past the end is a no-op.
    useAppStore.getState().detailForward();
    useAppStore.getState().detailForward();
    useAppStore.getState().detailForward();
    expect(useAppStore.getState().detailIndex).toBe(2);

    useAppStore.getState().closeDetail();
    expect(useAppStore.getState().detailHistory).toHaveLength(0);
    expect(useAppStore.getState().detailIndex).toBe(-1);
    expect(useAppStore.getState().pendingDetail).toBeNull();
  });

  it("pushDetailEntry adds to history but does NOT switch kind or arm pendingDetail", () => {
    const s = useAppStore.getState();
    s.pushDetailEntry("pods", "default", "a");
    expect(useAppStore.getState().detailHistory).toHaveLength(1);
    expect(useAppStore.getState().pendingDetail).toBeNull();
    // Pushing the same again is deduped.
    s.pushDetailEntry("pods", "default", "a");
    expect(useAppStore.getState().detailHistory).toHaveLength(1);
  });

  it("consumePendingDetail clears the slot once a panel has picked it up", () => {
    useAppStore.getState().navigateToDetail("pods", "default", "x");
    expect(useAppStore.getState().pendingDetail).not.toBeNull();
    useAppStore.getState().consumePendingDetail();
    expect(useAppStore.getState().pendingDetail).toBeNull();
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
