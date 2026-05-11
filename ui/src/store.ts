import { useMemo } from "react";
import { create } from "zustand";
import type {
  ClusterHealthStatus,
  ContextInfo,
  ForwardEntry,
  ForwardStatus,
  MetricsSnapshot,
  Prefs,
  PrefsRailMode,
  ResourceKind,
  SettingsTarget,
  TableView,
} from "./types";

/// In-memory mirror of `crates/core/src/prefs.rs::UpdateState`. Persisted via
/// the same `set_prefs` round-trip as everything else. `lastKnownVersion` is
/// the most recent latest-release the background checker observed;
/// `lastSeenVersion` is the user's "Skip this version" acknowledgement.
export type UpdateStateSlice = {
  lastKnownVersion: string | null;
  lastSeenVersion: string | null;
  lastCheckAt: number;
  autoCheckEnabled: boolean;
};

/// Numeric-segment semver compare for "is a strictly greater than b?". The
/// updater only feeds us strings of the form `X.Y.Z` (Rust-side `semver` has
/// already validated them by the time they reach the store), so a plain split
/// + parseInt on dotted segments is sufficient. Pre-release suffixes after a
/// `-` are folded into segments via parseInt's leading-digit rule (e.g.
/// `"1.0.0-rc1"` → `[1,0,0,NaN]`), which is acceptable as a tie-breaker
/// heuristic — escalate to a real semver lib only if pre-releases actually
/// ship.
export function semverGt(a: string, b: string): boolean {
  // Release tags are published as `v1.0.0`; the Rust updater strips the `v`
  // on its way out, but accept either form so a raw tag from any code path
  // still compares correctly.
  const stripV = (s: string) =>
    s.startsWith("v") || s.startsWith("V") ? s.slice(1) : s;
  const pa = stripV(a).split(/[.-]/).map((p) => parseInt(p, 10));
  const pb = stripV(b).split(/[.-]/).map((p) => parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ra = pa[i];
    const rb = pb[i];
    const xa = ra !== undefined && Number.isFinite(ra) ? ra : 0;
    const xb = rb !== undefined && Number.isFinite(rb) ? rb : 0;
    if (xa > xb) return true;
    if (xa < xb) return false;
  }
  return false;
}

/// True when the background checker has seen a strictly-newer release than
/// the running binary and the user hasn't skipped that exact version. Drives
/// the dot on the Settings → About entry.
export function selectUpdateAvailable(s: {
  updateState: UpdateStateSlice;
  appVersion: string | null;
}): boolean {
  const lk = s.updateState.lastKnownVersion;
  const ls = s.updateState.lastSeenVersion;
  const cur = s.appVersion;
  if (!lk || !cur) return false;
  if (lk === ls) return false;
  return semverGt(lk, cur);
}
import {
  DEFAULT_PALETTE_ID,
  DEFAULT_THEME_ID,
  UI_SCALE_DEFAULT,
  UI_SCALE_STEP,
  clampUiScale,
  getTheme,
  resolveTheme,
} from "./theme";
import type { ResolvedTheme, ThemeMode, ThemeOverrides } from "./theme";

type Status = "idle" | "loading" | "ready" | "error";

export type DockTabKind = "terminal" | "yaml" | "chat";
// Where the dock anchors. "bottom" is the original full-width strip that hosts
// terminals + YAML scratchpads. "right" is the AI-chat side panel — vertical,
// resized from the left edge. The two placements share the dock primitive but
// render in independent slots with independent minimise state.
export type DockPlacement = "bottom" | "right";
export type DockTab = {
  id: string;
  kind: DockTabKind;
  title: string;
  // Where this tab lives. Optional for back-compat with persisted state from
  // before the placement axis existed; missing = "bottom".
  placement?: DockPlacement;
  // Tab-local state. Terminals carry a transcript; YAML tabs carry the editor
  // contents. Kept opaque on the store so the dock body decides the shape.
  state: Record<string, unknown>;
};

// Confirm modal — opened imperatively via the `confirm()` helper in lib/dialog.
// Body is plain text so the queue can be persisted / serialized later if we
// ever need to; rich modals can extend this with a `kind` discriminator.
export type ConfirmModal = {
  id: string;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "neutral" | "danger";
  resolve: (ok: boolean) => void;
};

export type ToastTone = "info" | "ok" | "warn" | "bad";
export type Toast = {
  id: string;
  tone: ToastTone;
  // Single-line headline. The header-strip toast renders this with ellipsis;
  // multi-line context goes in `body` and is only visible in the panel.
  text: string;
  body?: string;
  // 0 = sticky (no auto-dismiss). Anything > 0 auto-dismisses after that many ms.
  durationMs: number;
};

// Persistent in-memory copy of every toast ever pushed (per session). Toasts
// auto-dismiss; notifications stay so the operator can review what happened
// while they were elsewhere. Capped — see NOTIFICATION_LOG_CAP.
export type Notification = {
  id: string;
  tone: ToastTone;
  text: string;
  body?: string;
  createdAt: number;
};

export const NOTIFICATION_LOG_CAP = 50;

type AppState = {
  contexts: ContextInfo[];
  contextsStatus: Status;
  contextsError: string | null;
  selectedContext: string | null;

  kinds: ResourceKind[];
  kindsStatus: Status;
  kindsError: string | null;
  selectedKindId: string | null;

  themeMode: ThemeMode;
  /// Active theme id from the bundled registry (`default`, `lens`, `vscode`,
  /// `readable`). Unknown ids fall back to Default at resolve time, so a
  /// theme can be removed without breaking persisted prefs.
  themeId: string;
  /// Palette id within the active theme. `default` for the Default theme,
  /// theme-specific otherwise (e.g. `lens`, `dark-plus`, `warm`).
  paletteId: string;
  /// Per-user overrides layered on top of the resolved theme. `null` means
  /// "use the theme as shipped". The Customize section of Settings writes
  /// here; the resolver merges shallowly.
  themeOverrides: ThemeOverrides | null;
  railMode: PrefsRailMode;

  // Empty set means "all namespaces" — matches HV2 namespace-modal semantics.
  selectedNamespaces: Set<string>;

  paletteOpen: boolean;
  nsModalOpen: boolean;
  settingsOpen: boolean;
  /// Pending deep-link target for the next time the Settings panel is
  /// open / re-opened. Consumed by the panel on mount, then cleared via
  /// `consumeSettingsTarget()` so re-opening the panel without a new
  /// `openSettings(target)` lands wherever the operator left off. `null`
  /// = no pending target → panel keeps its persisted active tab.
  settingsTarget: SettingsTarget | null;
  addMenuOpen: boolean;

  dockTabs: DockTab[];
  // Active tab id is global (not per-placement) — only one tab is "focused"
  // at a time across the whole UI, matching how a single editor cursor
  // semantics works in IDE-style apps.
  dockActiveId: string | null;
  // Per-placement minimise state. Minimising the bottom strip leaves the
  // right chat panel intact and vice versa.
  dockMin: Record<DockPlacement, boolean>;
  // Per-placement persisted size. `null` ⇒ use the first-launch default
  // computed from the viewport. Persisted via prefs.json.
  dockSize: Record<DockPlacement, number | null>;

  // Per-table multi-select. Keyed by uid (survives sort changes); the value
  // carries the (namespace, name) so the bulk-action bar can act on the
  // selection without round-tripping through the table's row map.
  selection: Map<string, { namespace: string | null; name: string }>;

  // Cross-kind navigation slot. The detail panel sets this when the operator
  // clicks "Controlled By: StatefulSet foo" — it switches the visible kind via
  // selectKind() and parks the (namespace, name) here. The matching
  // ResourceTable picks it up after its subscription lands and resolves
  // namespace+name → uid against the just-arrived snapshot.
  pendingDetail: { kindId: string; namespace: string | null; name: string } | null;

  // Visible-row count of the active table. Pushed from ResourceTable so the
  // header breadcrumb can render "Pods · 232" without lifting the table's
  // local row state. `filtered` reflects the namespace filter + tableFilter;
  // equal to `total` when no filter is active. `null` when no table is
  // mounted.
  tableCount: { filtered: number; total: number } | null;
  // Active per-table text filter. Lifted out of ResourceTable so the
  // breadcrumb input can drive it from a single global place — no second
  // filter box on the table chrome. Empty string = no filter.
  tableFilter: string;
  // Whether the inline filter input is open in the breadcrumb. Toggled by
  // Cmd+F / `/` / clicking the funnel chip. The input lives in `AppHeader`;
  // this flag lets the keyboard handler in `App.tsx` open it and the
  // input itself close it on Esc / Enter / blur.
  filterEditing: boolean;

  // Confirm-modal queue. Multiple opens stack; the topmost renders. Each
  // entry carries its `resolve` so the imperative `confirm()` helper can
  // await the operator's choice.
  modals: ConfirmModal[];

  // Toast stack — non-blocking notifications rendered bottom-center.
  toasts: Toast[];

  // Persistent in-memory log of every toast for the bell-icon history panel.
  // `notificationsSeenAt` is the operator's last "I've looked at the bell"
  // moment so the badge can show an unread count.
  notifications: Notification[];
  notificationsSeenAt: number;
  notificationsOpen: boolean;

  // Detail-panel browser-style history. Each link click in the detail panel
  // appends to this stack at `detailIndex+1` (truncating any forward branch),
  // mirroring browser back/forward. Cleared on rail kind-switch, cluster
  // switch, and explicit panel close — never persisted across those.
  detailHistory: { kindId: string; namespace: string | null; name: string }[];
  detailIndex: number;

  // Per-(cluster, kind) table view state. Hydrated once at startup from
  // `<config>/table_views.json`; the table writes back through
  // `setTableView()` which both updates the map and persists to disk
  // (debounced inside the table). Key: `${clusterId}::${kindId}`.
  tableViews: Record<string, TableView>;

  // Latest metrics snapshot for the active cluster, if metrics-server is
  // available. Refreshed every ~15s by a side-subscription mounted at the
  // App level — both the cluster bar gauges and the pod table cells join
  // off this single source.
  metrics: MetricsSnapshot | null;

  // Per-cluster apiserver health. Absent or "healthy" means we have no
  // negative signal; "unavailable" means the backend's heartbeat probe
  // saw 30s of failures, tore down watchers + metrics, and is awaiting
  // a manual reconnect. The unavailable banner reads this; the cluster
  // bar dims its rows when set. Cleared by `reconnectCluster` (which
  // also rebuilds the backend entry on the next `connectContext`).
  clusterHealth: Record<string, ClusterHealthStatus>;
  // Reason string from the last unavailable event, keyed the same way.
  // Surfaced verbatim in the banner so the operator can debug.
  clusterHealthReason: Record<string, string | null>;

  // Active port-forwards keyed by id. Initially hydrated by api.pfList() at
  // App boot; mutated on every `portforward://status` event. Detail-panel
  // forward chips read this directly to render their state.
  forwards: Record<string, ForwardEntry>;
  // Whether the global port-forwards slide-over panel is open.
  forwardsOpen: boolean;

  /// Running app's CARGO_PKG_VERSION, fetched once on launch via
  /// `api.updaterInfo()`. `null` until hydrated. Read by the
  /// `selectUpdateAvailable` derivation in the Settings panel.
  appVersion: string | null;

  /// Background update-check state — mirror of `prefs.update`. Persisted via
  /// the same `set_prefs` round-trip as `settings` / `ui` / `theme`.
  updateState: UpdateStateSlice;

  // App-level prefs that the design's settings panel exposes. Stored here so
  // they survive cluster switches per P8.
  settings: {
    refreshSec: number;
    confirmDestructive: boolean;
    showSystemNs: boolean;
    density: "compact" | "comfortable" | "spacious";
    monoTables: boolean;
    refreshOnLaunch: boolean;
    uiScale: number;
    fleetView: "tiles" | "mini" | "rows";
  };

  setContexts: (cs: ContextInfo[]) => void;
  setContextsError: (err: string) => void;
  setContextsLoading: () => void;
  selectContext: (name: string | null) => void;

  setKinds: (ks: ResourceKind[]) => void;
  setKindsError: (err: string) => void;
  setKindsLoading: () => void;
  selectKind: (id: string) => void;

  toggleTheme: () => void;
  /// Switch the active theme. Resets the palette to the new theme's
  /// `defaultPaletteId` so we never land on an invalid (theme, palette)
  /// pair, and seeds density / monoTables from the new theme's display
  /// defaults (user toggles win afterward).
  setTheme: (themeId: string) => void;
  /// Switch palette inside the active theme. No-op if the palette doesn't
  /// belong to the current theme.
  setPalette: (paletteId: string) => void;
  /// Merge-patch the theme overrides slot. Pass `null` to clear all
  /// overrides ("revert to theme defaults").
  patchThemeOverrides: (patch: ThemeOverrides | null) => void;
  setRailMode: (mode: PrefsRailMode) => void;
  cycleRailMode: () => void;

  setSelectedNamespaces: (ns: Set<string>) => void;

  openPalette: () => void;
  closePalette: () => void;
  setTableFilter: (q: string) => void;
  clearTableFilter: () => void;
  setTableCount: (c: { filtered: number; total: number } | null) => void;
  /// Open the inline filter input in the breadcrumb. Idempotent.
  openFilterEditor: () => void;
  closeFilterEditor: () => void;
  openNsModal: () => void;
  closeNsModal: () => void;
  openSettings: (target?: SettingsTarget) => void;
  closeSettings: () => void;
  /// Returns the pending settings target and clears it. SettingsPanel
  /// calls this on mount + every time `settingsOpen` flips to true so a
  /// follow-up re-open without a new deep-link doesn't re-scroll.
  consumeSettingsTarget: () => SettingsTarget | null;
  setAddMenuOpen: (open: boolean) => void;

  addDockTab: (tab: DockTab) => void;
  closeDockTab: (id: string) => void;
  closeAllDockTabs: () => void;
  closeDockTabsByPlacement: (placement: DockPlacement) => void;
  setDockActiveId: (id: string | null) => void;
  setDockMin: (placement: DockPlacement, min: boolean) => void;
  setDockSize: (placement: DockPlacement, size: number) => void;
  patchDockTabState: (id: string, patch: Record<string, unknown>) => void;
  patchDockTab: (id: string, patch: Partial<DockTab>) => void;

  setSelection: (
    sel: Map<string, { namespace: string | null; name: string }>,
  ) => void;
  toggleSelection: (
    uid: string,
    meta: { namespace: string | null; name: string },
  ) => void;
  clearSelection: () => void;

  setMetrics: (snap: MetricsSnapshot | null) => void;

  applyClusterHealth: (
    clusterId: string,
    status: ClusterHealthStatus,
    reason: string | null,
  ) => void;
  clearClusterHealth: (clusterId: string) => void;

  hydrateForwards: (entries: ForwardEntry[]) => void;
  upsertForward: (entry: ForwardEntry) => void;
  applyForwardStatus: (id: string, status: ForwardStatus) => void;
  removeForward: (id: string) => void;
  openForwardsPanel: () => void;
  closeForwardsPanel: () => void;

  hydrateTableViews: (views: Record<string, TableView>) => void;
  setTableView: (clusterId: string, kindId: string, view: TableView) => void;

  hydratePrefs: (prefs: Prefs) => void;

  pushModal: (m: ConfirmModal) => void;
  resolveModal: (id: string, ok: boolean) => void;

  pushToast: (t: Toast) => void;
  dismissToast: (id: string) => void;

  openNotifications: () => void;
  closeNotifications: () => void;
  clearNotifications: () => void;

  navigateToDetail: (kindId: string, namespace: string | null, name: string) => void;
  pushDetailEntry: (kindId: string, namespace: string | null, name: string) => void;
  detailBack: () => void;
  detailForward: () => void;
  closeDetail: () => void;
  consumePendingDetail: () => void;

  patchSettings: (patch: Partial<AppState["settings"]>) => void;
  setUiScale: (scale: number) => void;
  bumpUiScale: (direction: 1 | -1) => void;
  resetUiScale: () => void;

  /// One-shot setter used by App.tsx after the initial `updater_info` call.
  setAppVersion: (v: string | null) => void;
  /// Merge-patch the update-check slice (persists via the prefs round-trip).
  patchUpdateState: (patch: Partial<UpdateStateSlice>) => void;
};

export const useAppStore = create<AppState>((set, get) => ({
  contexts: [],
  contextsStatus: "idle",
  contextsError: null,
  selectedContext: null,

  kinds: [],
  kindsStatus: "idle",
  kindsError: null,
  selectedKindId: null,

  themeMode: "dark",
  themeId: DEFAULT_THEME_ID,
  paletteId: DEFAULT_PALETTE_ID,
  themeOverrides: null,
  railMode: "auto",

  selectedNamespaces: new Set<string>(),

  paletteOpen: false,
  nsModalOpen: false,
  settingsOpen: false,
  settingsTarget: null,
  addMenuOpen: false,

  dockTabs: [],
  dockActiveId: null,
  dockMin: { bottom: false, right: false },
  dockSize: { bottom: null, right: null },

  selection: new Map<string, { namespace: string | null; name: string }>(),

  pendingDetail: null,
  tableCount: null,
  tableFilter: "",
  filterEditing: false,

  modals: [],
  toasts: [],
  notifications: [],
  notificationsSeenAt: Date.now(),
  notificationsOpen: false,

  detailHistory: [],
  detailIndex: -1,

  metrics: null,

  clusterHealth: {},
  clusterHealthReason: {},

  forwards: {},
  forwardsOpen: false,

  tableViews: {},

  settings: {
    refreshSec: 15,
    confirmDestructive: true,
    showSystemNs: false,
    density: "comfortable",
    monoTables: true,
    refreshOnLaunch: true,
    uiScale: UI_SCALE_DEFAULT,
    fleetView: "tiles",
  },

  appVersion: null,
  updateState: {
    lastKnownVersion: null,
    lastSeenVersion: null,
    lastCheckAt: 0,
    autoCheckEnabled: true,
  },

  setContextsLoading: () =>
    set({ contextsStatus: "loading", contextsError: null }),
  setContexts: (cs) =>
    set((s) => ({
      contexts: cs,
      contextsStatus: "ready",
      contextsError: null,
      selectedContext:
        s.selectedContext && cs.some((c) => c.id === s.selectedContext)
          ? s.selectedContext
          : null,
    })),
  setContextsError: (err) =>
    set({ contextsStatus: "error", contextsError: err }),
  selectContext: (name) =>
    set({
      selectedContext: name,
      // Cluster scope changed: drop any selection / dock / ns filter / metrics.
      selection: new Map<string, { namespace: string | null; name: string }>(),
      selectedNamespaces: new Set<string>(),
      dockTabs: [],
      dockActiveId: null,
      dockMin: { bottom: false, right: false },
      metrics: null,
      // Detail history references the previous cluster's objects — drop it.
      detailHistory: [],
      detailIndex: -1,
      pendingDetail: null,
      tableFilter: "",
      filterEditing: false,
    }),

  setKindsLoading: () => set({ kindsStatus: "loading", kindsError: null }),
  setKinds: (ks) =>
    set((s) => ({
      kinds: ks,
      kindsStatus: "ready",
      kindsError: null,
      selectedKindId:
        s.selectedKindId && ks.some((k) => k.id === s.selectedKindId)
          ? s.selectedKindId
          : ks[0]?.id ?? null,
    })),
  setKindsError: (err) => set({ kindsStatus: "error", kindsError: err }),
  selectKind: (id) =>
    set({
      selectedKindId: id,
      selection: new Map<string, { namespace: string | null; name: string }>(),
      // Explicit kind switch via the rail / palette is a context change —
      // back/forward history from the previous flow no longer makes sense.
      detailHistory: [],
      detailIndex: -1,
      pendingDetail: null,
      // `tableFilter` deliberately survives kind switches. Same operator
      // intent often spans kinds ("find anything called 'auth'") and the
      // breadcrumb chip keeps the active term visible so it can't hide
      // rows silently. Cleared explicitly on cluster change below.
      filterEditing: false,
    }),

  toggleTheme: () =>
    set((s) => ({ themeMode: s.themeMode === "dark" ? "light" : "dark" })),
  setTheme: (themeId) =>
    set((s) => {
      const prev = getTheme(s.themeId);
      const next = getTheme(themeId);
      // Seed-once semantic: density / monoTables get the new theme's
      // defaults only if they currently match the *previous* theme's
      // defaults — i.e. the operator hasn't explicitly chosen anything.
      // Once they touch a setting (it diverges from its theme's default),
      // their choice survives every subsequent theme switch.
      const densityUntouched =
        s.settings.density === prev.display.densityDefault;
      const monoUntouched =
        s.settings.monoTables === prev.display.monoTablesDefault;
      return {
        themeId: next.id,
        paletteId: next.defaultPaletteId,
        themeOverrides: null,
        settings: {
          ...s.settings,
          density: densityUntouched
            ? next.display.densityDefault
            : s.settings.density,
          monoTables: monoUntouched
            ? next.display.monoTablesDefault
            : s.settings.monoTables,
        },
      };
    }),
  setPalette: (paletteId) =>
    set((s) => {
      const theme = getTheme(s.themeId);
      // Reject palettes that don't belong to the current theme — the caller
      // should `setTheme` first. Silent no-op rather than throwing so a
      // stray click in the UI can't crash the panel.
      if (!theme.palettes.some((p) => p.id === paletteId)) return {};
      return { paletteId };
    }),
  patchThemeOverrides: (patch) =>
    set((s) => {
      if (patch === null) return { themeOverrides: null };
      const cur = s.themeOverrides ?? {};
      return { themeOverrides: { ...cur, ...patch } };
    }),
  setRailMode: (mode) => set({ railMode: mode }),
  // Footer chip steps through auto → pinned → collapsed → auto. Keeps
  // a single click affordance in the rail without dedicating three
  // buttons to a tri-state.
  cycleRailMode: () =>
    set((s) => ({
      railMode:
        s.railMode === "auto"
          ? "pinned"
          : s.railMode === "pinned"
            ? "collapsed"
            : "auto",
    })),

  setSelectedNamespaces: (ns) =>
    set({
      selectedNamespaces: ns,
      selection: new Map<string, { namespace: string | null; name: string }>(),
    }),

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  setTableFilter: (q) => set({ tableFilter: q }),
  clearTableFilter: () => set({ tableFilter: "" }),
  setTableCount: (c) => set({ tableCount: c }),
  openFilterEditor: () => set({ filterEditing: true }),
  closeFilterEditor: () => set({ filterEditing: false }),
  openNsModal: () => set({ nsModalOpen: true }),
  closeNsModal: () => set({ nsModalOpen: false }),
  openSettings: (target) =>
    set({
      settingsOpen: true,
      // Replace any pending target — last-call-wins semantics. A bare
      // `openSettings()` clears the pointer so the panel restores its
      // persisted active tab instead of jumping back to a stale anchor.
      // Type-guard so a stray non-target value (e.g. a MouseEvent
      // forwarded by `<IconBtn onClick={openSettings} />`) doesn't
      // poison `settingsTarget` and leave the panel rendering with
      // `active = undefined` (i.e. the empty body the operator
      // reported). We only accept objects with a string `section`.
      settingsTarget:
        target &&
        typeof target === "object" &&
        typeof (target as SettingsTarget).section === "string"
          ? target
          : null,
    }),
  closeSettings: () => set({ settingsOpen: false }),
  consumeSettingsTarget: () => {
    const target = get().settingsTarget;
    if (target) set({ settingsTarget: null });
    return target;
  },
  setAddMenuOpen: (open) => set({ addMenuOpen: open }),

  addDockTab: (tab) =>
    set((s) => {
      const placement = tab.placement ?? "bottom";
      return {
        dockTabs: [...s.dockTabs, tab],
        dockActiveId: tab.id,
        // Restoring a minimised dock when a new tab is added applies only
        // to the placement that received the tab — leave the other one alone.
        dockMin: { ...s.dockMin, [placement]: false },
        addMenuOpen: false,
      };
    }),
  closeDockTab: (id) => {
    const s = get();
    const closing = s.dockTabs.find((t) => t.id === id);
    const closingPlacement = closing?.placement ?? "bottom";
    const next = s.dockTabs.filter((t) => t.id !== id);
    // When the closed tab was active, prefer the next tab in the same
    // placement so focus stays where the operator was working.
    const samePlacementSurvivor = [...next]
      .reverse()
      .find((t) => (t.placement ?? "bottom") === closingPlacement);
    const last = next[next.length - 1];
    set({
      dockTabs: next,
      dockActiveId:
        next.length === 0
          ? null
          : s.dockActiveId === id
            ? (samePlacementSurvivor?.id ?? last?.id ?? null)
            : s.dockActiveId,
    });
  },
  closeAllDockTabs: () =>
    set({
      dockTabs: [],
      dockActiveId: null,
      dockMin: { bottom: false, right: false },
    }),
  closeDockTabsByPlacement: (placement) =>
    set((s) => {
      const next = s.dockTabs.filter((t) => (t.placement ?? "bottom") !== placement);
      const stillActive = next.some((t) => t.id === s.dockActiveId);
      return {
        dockTabs: next,
        dockActiveId: stillActive ? s.dockActiveId : (next[next.length - 1]?.id ?? null),
        dockMin: { ...s.dockMin, [placement]: false },
      };
    }),
  setDockActiveId: (id) => set({ dockActiveId: id }),
  setDockMin: (placement, min) =>
    set((s) => ({ dockMin: { ...s.dockMin, [placement]: min } })),
  setDockSize: (placement, size) =>
    set((s) => ({ dockSize: { ...s.dockSize, [placement]: size } })),
  patchDockTabState: (id, patch) =>
    set((s) => ({
      dockTabs: s.dockTabs.map((t) =>
        t.id === id ? { ...t, state: { ...t.state, ...patch } } : t,
      ),
    })),
  patchDockTab: (id, patch) =>
    set((s) => ({
      dockTabs: s.dockTabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  setSelection: (sel) => set({ selection: sel }),
  toggleSelection: (uid, meta) =>
    set((s) => {
      const next = new Map(s.selection);
      if (next.has(uid)) next.delete(uid);
      else next.set(uid, meta);
      return { selection: next };
    }),
  clearSelection: () =>
    set({
      selection: new Map<string, { namespace: string | null; name: string }>(),
    }),

  setMetrics: (snap) => set({ metrics: snap }),

  applyClusterHealth: (clusterId, status, reason) =>
    set((s) => ({
      clusterHealth: { ...s.clusterHealth, [clusterId]: status },
      clusterHealthReason: { ...s.clusterHealthReason, [clusterId]: reason },
    })),
  clearClusterHealth: (clusterId) =>
    set((s) => {
      const { [clusterId]: _h, ...rest } = s.clusterHealth;
      const { [clusterId]: _r, ...restR } = s.clusterHealthReason;
      return { clusterHealth: rest, clusterHealthReason: restR };
    }),

  hydrateForwards: (entries) =>
    set({
      forwards: Object.fromEntries(entries.map((e) => [e.spec.id, e])),
    }),
  upsertForward: (entry) =>
    set((s) => ({ forwards: { ...s.forwards, [entry.spec.id]: entry } })),
  // Status events carry only `{ id, status }` — patch the existing entry's
  // status if we know about it. A `stopped` for an unknown id is a no-op
  // (the entry was already pruned).
  applyForwardStatus: (id, status) =>
    set((s) => {
      const cur = s.forwards[id];
      if (!cur) {
        if (status.kind === "stopped") return {};
        return {};
      }
      if (status.kind === "stopped") {
        const next = { ...s.forwards };
        delete next[id];
        return { forwards: next };
      }
      return {
        forwards: { ...s.forwards, [id]: { ...cur, status } },
      };
    }),
  removeForward: (id) =>
    set((s) => {
      const next = { ...s.forwards };
      delete next[id];
      return { forwards: next };
    }),
  openForwardsPanel: () => set({ forwardsOpen: true }),
  closeForwardsPanel: () => set({ forwardsOpen: false }),

  hydrateTableViews: (views) => set({ tableViews: views }),

  hydratePrefs: (prefs) =>
    set((s) => {
      // Theme can arrive as either the new record or the legacy bare string
      // ("dark" / "light"). The Rust side migrates the on-disk file, but
      // transitional builds may still send the old shape — fall back to
      // Default theme + default palette in that case.
      const themeWire = prefs.theme as
        | { id?: string; palette_id?: string; mode?: ThemeMode; overrides?: unknown }
        | "light"
        | "dark";
      let themeMode: ThemeMode;
      let themeId: string;
      let paletteId: string;
      let themeOverrides: ThemeOverrides | null;
      if (typeof themeWire === "string") {
        themeMode = themeWire;
        themeId = DEFAULT_THEME_ID;
        paletteId = DEFAULT_PALETTE_ID;
        themeOverrides = null;
      } else {
        themeMode = themeWire.mode ?? "dark";
        themeId = themeWire.id ?? DEFAULT_THEME_ID;
        paletteId = themeWire.palette_id ?? DEFAULT_PALETTE_ID;
        const ov = themeWire.overrides;
        themeOverrides =
          ov && typeof ov === "object" && !Array.isArray(ov)
            ? (ov as ThemeOverrides)
            : null;
      }
      return {
      themeMode,
      themeId,
      paletteId,
      themeOverrides,
      railMode: prefs.ui.rail_mode,
      // Honor the persisted cluster/kind selection only if it's still present
      // in whatever the contexts/kinds list currently has. If not (file moved,
      // kind unknown), drop silently — better than dangling on a missing id.
      selectedContext:
        prefs.ui.selected_context &&
        (s.contexts.length === 0 ||
          s.contexts.some((c) => c.id === prefs.ui.selected_context))
          ? prefs.ui.selected_context
          : s.selectedContext,
      selectedKindId:
        prefs.ui.selected_kind_id &&
        (s.kinds.length === 0 ||
          s.kinds.some((k) => k.id === prefs.ui.selected_kind_id))
          ? prefs.ui.selected_kind_id
          : s.selectedKindId,
      selectedNamespaces: new Set(prefs.ui.selected_namespaces),
      dockSize: {
        right: prefs.ui.dock_size_right,
        bottom: prefs.ui.dock_size_bottom,
      },
      settings: {
        refreshSec: prefs.settings.refresh_sec,
        confirmDestructive: prefs.settings.confirm_destructive,
        showSystemNs: prefs.settings.show_system_ns,
        density: prefs.settings.density,
        monoTables: prefs.settings.mono_tables,
        refreshOnLaunch: prefs.settings.refresh_on_launch,
        // Older prefs files predate ui_scale; serde fills 1.0 server-side
        // but be tolerant if a stale type ever ships through.
        uiScale: clampUiScale(prefs.settings.ui_scale ?? UI_SCALE_DEFAULT),
        fleetView: prefs.settings.fleet_view ?? "tiles",
      },
      // `prefs.update` lands populated by `#[serde(default)]` on the Rust side
      // for prefs.json files written before this block existed.
      updateState: {
        lastKnownVersion: prefs.update?.last_known_version ?? null,
        lastSeenVersion: prefs.update?.last_seen_version ?? null,
        lastCheckAt: prefs.update?.last_check_at ?? 0,
        autoCheckEnabled: prefs.update?.auto_check_enabled ?? true,
      },
      };
    }),
  setTableView: (clusterId, kindId, view) =>
    set((s) => {
      const key = `${clusterId}::${kindId}`;
      const next = { ...s.tableViews };
      if (view.sorting.length === 0 && Object.keys(view.column_sizing).length === 0) {
        delete next[key];
      } else {
        next[key] = view;
      }
      return { tableViews: next };
    }),

  pushModal: (m) => set((s) => ({ modals: [...s.modals, m] })),
  resolveModal: (id, ok) =>
    set((s) => {
      const m = s.modals.find((x) => x.id === id);
      if (m) m.resolve(ok);
      return { modals: s.modals.filter((x) => x.id !== id) };
    }),

  pushToast: (toast) =>
    set((s) => {
      const note: Notification = {
        id: toast.id,
        tone: toast.tone,
        text: toast.text,
        body: toast.body,
        createdAt: Date.now(),
      };
      const next = [...s.notifications, note];
      // Drop oldest if over the cap so the log stays bounded.
      const trimmed =
        next.length > NOTIFICATION_LOG_CAP
          ? next.slice(next.length - NOTIFICATION_LOG_CAP)
          : next;
      return {
        toasts: [...s.toasts, toast],
        notifications: trimmed,
      };
    }),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  openNotifications: () =>
    set({ notificationsOpen: true, notificationsSeenAt: Date.now() }),
  closeNotifications: () => set({ notificationsOpen: false }),
  clearNotifications: () =>
    set({ notifications: [], notificationsSeenAt: Date.now() }),

  navigateToDetail: (kindId, namespace, name) =>
    set((s) => {
      const entry = { kindId, namespace, name };
      // Browser semantics: going back then sideways drops the forward branch.
      const head = s.detailHistory.slice(0, s.detailIndex + 1);
      const last = head[head.length - 1];
      const dup =
        !!last &&
        last.kindId === entry.kindId &&
        last.namespace === entry.namespace &&
        last.name === entry.name;
      const nextHistory = dup ? head : [...head, entry];
      return {
        // Switch kind in the same tick so the table re-mounts already knowing
        // it should auto-open this object's detail.
        selectedKindId: kindId,
        selection: new Map<string, { namespace: string | null; name: string }>(),
        pendingDetail: entry,
        detailHistory: nextHistory,
        detailIndex: nextHistory.length - 1,
      };
    }),
  pushDetailEntry: (kindId, namespace, name) =>
    set((s) => {
      const entry = { kindId, namespace, name };
      const head = s.detailHistory.slice(0, s.detailIndex + 1);
      const last = head[head.length - 1];
      if (
        last &&
        last.kindId === entry.kindId &&
        last.namespace === entry.namespace &&
        last.name === entry.name
      ) {
        return {};
      }
      const nextHistory = [...head, entry];
      return {
        detailHistory: nextHistory,
        detailIndex: nextHistory.length - 1,
      };
    }),
  detailBack: () =>
    set((s) => {
      if (s.detailIndex <= 0) return {};
      const i = s.detailIndex - 1;
      const e = s.detailHistory[i]!;
      return {
        detailIndex: i,
        selectedKindId: e.kindId,
        selection: new Map<string, { namespace: string | null; name: string }>(),
        pendingDetail: { kindId: e.kindId, namespace: e.namespace, name: e.name },
      };
    }),
  detailForward: () =>
    set((s) => {
      if (s.detailIndex >= s.detailHistory.length - 1) return {};
      const i = s.detailIndex + 1;
      const e = s.detailHistory[i]!;
      return {
        detailIndex: i,
        selectedKindId: e.kindId,
        selection: new Map<string, { namespace: string | null; name: string }>(),
        pendingDetail: { kindId: e.kindId, namespace: e.namespace, name: e.name },
      };
    }),
  closeDetail: () =>
    set({ detailHistory: [], detailIndex: -1, pendingDetail: null }),
  consumePendingDetail: () => set({ pendingDetail: null }),

  patchSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  setUiScale: (scale) =>
    set((s) => ({
      settings: { ...s.settings, uiScale: clampUiScale(scale) },
    })),
  bumpUiScale: (direction) =>
    set((s) => ({
      settings: {
        ...s.settings,
        uiScale: clampUiScale(s.settings.uiScale + direction * UI_SCALE_STEP),
      },
    })),
  resetUiScale: () =>
    set((s) => ({
      settings: { ...s.settings, uiScale: UI_SCALE_DEFAULT },
    })),

  setAppVersion: (v) => set({ appVersion: v }),
  patchUpdateState: (patch) =>
    set((s) => ({ updateState: { ...s.updateState, ...patch } })),
}));

/// Resolve the active theme into a ready-to-use bag of tokens, typography,
/// sizing and display flags. Components subscribe to the four theme-relevant
/// slices and only recompute the result when one of them changes —
/// preserving referential equality across unrelated renders so children
/// memoised on `t` (the color tokens) don't re-render needlessly.
export function useResolvedTheme(): ResolvedTheme {
  const themeId = useAppStore((s) => s.themeId);
  const paletteId = useAppStore((s) => s.paletteId);
  const mode = useAppStore((s) => s.themeMode);
  const overrides = useAppStore((s) => s.themeOverrides);
  return useMemo(
    () => resolveTheme({ themeId, paletteId, mode, overrides }),
    [themeId, paletteId, mode, overrides],
  );
}
