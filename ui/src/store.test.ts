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
