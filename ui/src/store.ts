import { useMemo } from "react";
import { create } from "zustand";
import type {
  ClusterHealthStatus,
  ContextInfo,
  ForwardEntry,
  ForwardStatus,
  GlobalForwardSession,
  HelperStatus,
  MetricsSnapshot,
  Prefs,
  PrefsRailMode,
  PrefsStartupScope,
  ResourceKind,
  SettingsTarget,
  TableView,
  VirtualContext,
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
  consoleTokens,
  getTheme,
  resolveTheme,
} from "./theme";
import type {
  ColorTokens,
  ResolvedTheme,
  ThemeMode,
  ThemeOverrides,
} from "./theme";

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

// One free-form label/value pair shown in a notification's expanded detail.
// `mono` renders the value monospaced (ids, names, error text).
export type NotificationDetail = { label: string; value: string; mono?: boolean };

// Structured context for a notification, surfaced only in the expanded row of
// the NotificationsPanel (never in the one-line toast/headline). The active
// kube `context`/`cluster` are auto-captured at emit time (see lib/dialog.ts);
// richer call sites add namespace/kind/name/reason. All fields optional so the
// common toast keeps working; a notification with no populated field carries no
// `meta` at all (the viewer then shows no expand affordance).
export type NotificationMeta = {
  context?: string | null; // kube context display name (ContextInfo.name)
  cluster?: string | null; // kubeconfig cluster (ContextInfo.cluster)
  namespace?: string | null;
  kind?: string | null;
  name?: string | null;
  reason?: string | null; // event reason / raw error text
  extra?: NotificationDetail[]; // arbitrary extras (ports, versions…)
};

export type Toast = {
  id: string;
  tone: ToastTone;
  // Single-line headline. The header-strip toast renders this with ellipsis;
  // multi-line context goes in `body` and is only visible in the panel.
  text: string;
  body?: string;
  // 0 = sticky (no auto-dismiss). Anything > 0 auto-dismisses after that many ms.
  durationMs: number;
  // Optional deep-link: clicking the toast (or its notification-log entry)
  // opens Settings at this target instead of the notifications panel. Used by
  // the "update available" toast to jump straight to About → What's new.
  route?: SettingsTarget;
  // Structured context surfaced only in the NotificationsPanel expanded row.
  meta?: NotificationMeta;
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
  // Mirrors `Toast.route` so a logged notification stays clickable after its
  // toast auto-dismisses (e.g. the update notice deep-links to About).
  route?: SettingsTarget;
  // Mirrors `Toast.meta` — structured detail shown when the operator expands
  // this entry in the NotificationsPanel.
  meta?: NotificationMeta;
};

export const NOTIFICATION_LOG_CAP = 50;

/// Metadata carried with each selected row. `clusterId` is the row's origin
/// cluster — rows from different clusters can share a Kubernetes uid, so the
/// map key is the scoped id (`${clusterId}::${uid}`, see lib/multiCluster)
/// and every bulk action routes through the entry's own cluster.
export type SelectionMeta = {
  clusterId: string;
  namespace: string | null;
  name: string;
};

/// One detail-history / pending-detail entry. `clusterId` is null when the
/// origin cluster is unknown (palette search from a build that predates
/// scoping, chat links) — resolution then falls back to name+namespace only.
export type DetailEntry = {
  clusterId: string | null;
  kindId: string;
  namespace: string | null;
  name: string;
};

/// Per-tab UI state snapshot. Everything here is scoped to a single open
/// cluster tab and swapped wholesale by `switchTab`. The top-level store fields
/// of the same names are the *live working copy* of the currently-active tab;
/// inactive tabs keep their last-stashed copy in `ClusterTab.slice`. Keeping the
/// top-level mirror means existing consumers (ResourceTable, DetailPanel, Dock,
/// AppHeader) read `s.detailHistory` etc. unchanged — only `switchTab` and the
/// Dock's cross-tab mount pool need to know about slices.
export type ScopeSlice = {
  selectedKindId: string | null;
  selectedNamespaces: Set<string>;
  selection: Map<string, SelectionMeta>;
  detailHistory: DetailEntry[];
  detailIndex: number;
  pendingDetail: DetailEntry | null;
  tableFilter: string;
  filterEditing: boolean;
  kindClusters: Record<string, string[]>;
  dockTabs: DockTab[];
  dockActiveId: string | null;
  dockMin: Record<DockPlacement, boolean>;
};

/// One open cluster tab. The anchor (`selectedContext` xor
/// `selectedVirtualContextId`) plus `scopeExtras` defines the scope; `slice`
/// holds the preserved UI state. Two tabs may resolve to an overlapping set of
/// physical clusters (a single-cluster tab and a virtual-context tab that
/// includes it) — per-cluster backend state (metrics, health, reflectors) is
/// shared across them, only the UI slice is per-tab.
export type ClusterTab = {
  id: string;
  selectedContext: string | null;
  selectedVirtualContextId: string | null;
  scopeExtras: string[];
  slice: ScopeSlice;
};

type AppState = {
  contexts: ContextInfo[];
  contextsStatus: Status;
  contextsError: string | null;
  selectedContext: string | null;

  // Open cluster tabs. Each tab preserves its own UI slice (dock tabs,
  // selection, detail history, filters…). `activeTabId === null` means the
  // Fleet landing is showing (no tab focused) while open tabs are kept warm in
  // the background. The top-level `selectedContext` / `selectedVirtualContextId`
  // / `scopeExtras` plus every `ScopeSlice` field are the live working copy of
  // the active tab; `switchTab` stashes them back into `openTabs` and hydrates
  // the target. See `ScopeSlice` / `ClusterTab`.
  openTabs: ClusterTab[];
  activeTabId: string | null;

  // Saved multi-cluster views (mirrors `prefs.virtual_contexts`). A virtual
  // context opens all member clusters at once; resource tables merge rows
  // across members. `selectedVirtualContextId` is mutually exclusive with
  // `selectedContext` — selecting one clears the other. The data plane only
  // ever sees member cluster ids, never the virtual id.
  virtualContexts: VirtualContext[];
  selectedVirtualContextId: string | null;
  // Ephemeral additions to the active scope ("+" menu → Add cluster…).
  // Appended to the active cluster set without saving anything; cleared on
  // any scope switch; never persisted. Lets the operator widen a single
  // cluster (or a saved virtual context) into an ad-hoc multi-cluster view.
  scopeExtras: string[];

  kinds: ResourceKind[];
  kindsStatus: Status;
  kindsError: string | null;
  selectedKindId: string | null;
  // Which member clusters actually serve a kind, keyed by kind id. Only
  // populated for dynamic (CRD / well-known) kinds, which are cluster-local
  // — the rail publishes it after per-member discovery so a merged table
  // never subscribes a kind on a cluster that lacks it. Built-in kinds have
  // no entry (= available everywhere).
  kindClusters: Record<string, string[]>;

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
  selection: Map<string, SelectionMeta>;

  // Cross-kind navigation slot. The detail panel sets this when the operator
  // clicks "Controlled By: StatefulSet foo" — it switches the visible kind via
  // selectKind() and parks the (namespace, name) here. The matching
  // ResourceTable picks it up after its subscription lands and resolves
  // namespace+name → uid against the just-arrived snapshot.
  pendingDetail: DetailEntry | null;

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
  detailHistory: DetailEntry[];
  detailIndex: number;

  // Per-(cluster, kind) table view state. Hydrated once at startup from
  // `<config>/table_views.json`; the table writes back through
  // `setTableView()` which both updates the map and persists to disk
  // (debounced inside the table). Key: `${clusterId}::${kindId}`.
  tableViews: Record<string, TableView>;

  // Latest metrics snapshot per cluster, if metrics-server is available
  // there. Refreshed every ~15s by the consumer-held subscriptions
  // (`useMetricsSubscription`); cluster bar gauges and pod table cells join
  // off this single source. Keyed by cluster id so a virtual context's
  // members each carry their own snapshot.
  metricsByCluster: Record<string, MetricsSnapshot>;

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
  // True while `useClusterConnection` is mid auto-reconnect for a cluster.
  // Distinct from `clusterHealth` because a wedged cluster's freshly-rebuilt
  // client can read momentarily "healthy" between retries — this flag keeps
  // the read-only gate + reconnecting banner steady across the whole session.
  // Set/cleared only by the hook; never persisted.
  clusterReconnecting: Record<string, boolean>;
  // Monotonic reconnect counter per cluster, bumped by `clearClusterHealth`
  // (i.e. on every manual or auto reconnect). Lets connection-independent
  // effects that would otherwise stay keyed on a same-cluster reconnect —
  // notably the Rail's CRD discovery — re-run and clear stale errors after a
  // reconnect fixes the underlying auth/reachability problem. Never persisted.
  clusterEpoch: Record<string, number>;

  // Active port-forwards keyed by id. Initially hydrated by api.pfList() at
  // App boot; mutated on every `portforward://status` event. Detail-panel
  // forward chips read this directly to render their state.
  forwards: Record<string, ForwardEntry>;
  // Whether the global port-forwards slide-over panel is open.
  forwardsOpen: boolean;
  // Global (DNS) forward sessions keyed by session id. Hydrated by
  // api.gfList(); mutated on enable/disable.
  globalForwards: Record<string, GlobalForwardSession>;
  // Lifecycle of the privileged helper, for surfacing the elevation/error
  // state in the panel.
  helperStatus: HelperStatus;

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
    // Force the logs + terminal surfaces to a dark, console-style palette even
    // under a light theme. Default on; toggled in Settings → Appearance.
    darkConsole: boolean;
    // What scope opens after a restart: the full last view (cluster /
    // virtual context / unsaved ad-hoc set), only the last single cluster,
    // or always the fleet landing. Settings → General.
    startupScope: PrefsStartupScope;
  };

  setContexts: (cs: ContextInfo[]) => void;
  setContextsError: (err: string) => void;
  setContextsLoading: () => void;
  selectContext: (name: string | null) => void;

  /// Open a cluster as a tab. If a tab already anchors this context/virtual id,
  /// switch to it (preserving its state); otherwise stash the active tab and
  /// push a fresh one. Passing the same id that's already active is a no-op.
  openTab: (anchor:
    | { kind: "context"; contextId: string }
    | { kind: "virtual"; virtualId: string }) => void;
  /// Switch the active tab. Stashes the current live state into the outgoing
  /// tab and hydrates the target's slice. No-op if `id` isn't an open tab.
  switchTab: (id: string) => void;
  /// Close an open tab, focusing a neighbour (or the Fleet landing when it was
  /// the last tab). Backend disconnect of now-unused clusters is the caller's
  /// job — read `selectClustersToDisconnect` first, then call this.
  closeTab: (id: string) => void;
  /// Drop to the Fleet landing without losing any open tab's state (stashes the
  /// active tab, sets `activeTabId = null`).
  goFleet: () => void;

  /// Activate a saved virtual context (or none). Clears `selectedContext`
  /// and applies the same scope-change reset as `selectContext`.
  selectVirtualContext: (id: string | null) => void;
  /// Create a virtual context from a name + member cluster ids. Returns the
  /// generated id. Does not activate it — callers decide.
  saveVirtualContext: (name: string, members: string[]) => string;
  renameVirtualContext: (id: string, name: string) => void;
  setVirtualContextMembers: (id: string, members: string[]) => void;
  /// Fold the current ad-hoc scope extras into virtual context `id`'s
  /// member list (deduped) and clear the extras. No-op when there are no
  /// extras or the id is unknown.
  absorbScopeExtras: (id: string) => void;
  /// Remove a virtual context; deactivates it first if it's active.
  deleteVirtualContext: (id: string) => void;
  /// Append a context to the active scope without saving. No-op when the id
  /// is already in scope or doesn't resolve against `contexts`.
  addScopeExtra: (contextId: string) => void;
  /// Drop an ad-hoc scope addition. Clears row selection — selected rows may
  /// belong to the removed cluster.
  removeScopeExtra: (contextId: string) => void;

  setKinds: (ks: ResourceKind[]) => void;
  setKindsError: (err: string) => void;
  setKindsLoading: () => void;
  selectKind: (id: string) => void;
  /// Replace the dynamic-kind availability map (rail publishes after
  /// per-member CRD discovery).
  setKindClusters: (m: Record<string, string[]>) => void;

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

  setSelection: (sel: Map<string, SelectionMeta>) => void;
  toggleSelection: (sid: string, meta: SelectionMeta) => void;
  clearSelection: () => void;

  setMetrics: (clusterId: string, snap: MetricsSnapshot) => void;
  /// Drop one cluster's snapshot, or all of them when no id is given.
  clearMetrics: (clusterId?: string) => void;

  applyClusterHealth: (
    clusterId: string,
    status: ClusterHealthStatus,
    reason: string | null,
  ) => void;
  clearClusterHealth: (clusterId: string) => void;
  setClusterReconnecting: (clusterId: string, value: boolean) => void;

  hydrateForwards: (entries: ForwardEntry[]) => void;
  upsertForward: (entry: ForwardEntry) => void;
  applyForwardStatus: (id: string, status: ForwardStatus) => void;
  removeForward: (id: string) => void;
  openForwardsPanel: () => void;
  closeForwardsPanel: () => void;

  hydrateGlobalForwards: (sessions: GlobalForwardSession[]) => void;
  upsertGlobalForward: (session: GlobalForwardSession) => void;
  removeGlobalForward: (id: string) => void;
  setHelperStatus: (status: HelperStatus) => void;

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

  navigateToDetail: (
    kindId: string,
    namespace: string | null,
    name: string,
    clusterId?: string | null,
  ) => void;
  pushDetailEntry: (
    kindId: string,
    namespace: string | null,
    name: string,
    clusterId?: string | null,
  ) => void;
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

/// Fresh per-tab UI slice for a newly-opened tab. `selectedKindId` is seeded by
/// the caller (`openTab`) from the global kind list so a new tab lands on a
/// sensible default kind instead of an empty table.
function emptyScopeSlice(): ScopeSlice {
  return {
    selectedKindId: null,
    selectedNamespaces: new Set<string>(),
    selection: new Map<string, SelectionMeta>(),
    detailHistory: [],
    detailIndex: -1,
    pendingDetail: null,
    tableFilter: "",
    filterEditing: false,
    // Dynamic-kind availability is per-scope — the rail republishes after
    // re-discovering CRDs on the new scope's members.
    kindClusters: {},
    dockTabs: [],
    dockActiveId: null,
    dockMin: { bottom: false, right: false },
  };
}

/// Capture the active tab's live state (the top-level mirror) into a slice, so
/// it can be stashed back into `openTabs` on switch / close / fleet.
function captureScopeSlice(s: AppState): ScopeSlice {
  return {
    selectedKindId: s.selectedKindId,
    selectedNamespaces: s.selectedNamespaces,
    selection: s.selection,
    detailHistory: s.detailHistory,
    detailIndex: s.detailIndex,
    pendingDetail: s.pendingDetail,
    tableFilter: s.tableFilter,
    filterEditing: s.filterEditing,
    kindClusters: s.kindClusters,
    dockTabs: s.dockTabs,
    dockActiveId: s.dockActiveId,
    dockMin: s.dockMin,
  };
}

/// Top-level fields written when no tab is active (Fleet landing) — the live
/// mirror is emptied so stale rows/dock/detail from the last active tab don't
/// bleed onto the Fleet view. Anchor fields cleared too. Global per-cluster
/// state (metrics, health, tableViews) is intentionally NOT touched.
function fleetTopLevel() {
  return {
    selectedContext: null as string | null,
    selectedVirtualContextId: null as string | null,
    scopeExtras: [] as string[],
    ...emptyScopeSlice(),
  };
}

/// Write the active tab's live top-level state back into `openTabs`. No-op when
/// no tab is active (Fleet landing).
function stashActive(s: AppState): ClusterTab[] {
  if (s.activeTabId === null) return s.openTabs;
  return s.openTabs.map((t) =>
    t.id === s.activeTabId
      ? {
          ...t,
          selectedContext: s.selectedContext,
          selectedVirtualContextId: s.selectedVirtualContextId,
          scopeExtras: s.scopeExtras,
          slice: captureScopeSlice(s),
        }
      : t,
  );
}

/// Partial state that stashes the active tab and hydrates `id` as the new
/// active tab. Empty partial (no-op) when `id` isn't open or is already active.
function switchToTab(s: AppState, id: string): Partial<AppState> {
  if (s.activeTabId === id) return {};
  const target = s.openTabs.find((t) => t.id === id);
  if (!target) return {};
  return {
    openTabs: stashActive(s),
    activeTabId: id,
    selectedContext: target.selectedContext,
    selectedVirtualContextId: target.selectedVirtualContextId,
    scopeExtras: target.scopeExtras,
    ...target.slice,
  };
}

/// Partial state focusing a neighbour after removing tabs in `closeIds` from
/// `stashed` (which must already include the stashed active tab). Falls back to
/// the Fleet landing when nothing remains.
function focusAfterClose(
  s: AppState,
  stashed: ClusterTab[],
  closeIds: string[],
): Partial<AppState> {
  const remaining = stashed.filter((t) => !closeIds.includes(t.id));
  const activeClosed = s.activeTabId !== null && closeIds.includes(s.activeTabId);
  if (!activeClosed) return { openTabs: remaining };
  if (remaining.length === 0) {
    return { openTabs: [], activeTabId: null, ...fleetTopLevel() };
  }
  // Prefer the tab that slid into the closed tab's slot (same index, clamped).
  const oldIdx = stashed.findIndex((t) => t.id === s.activeTabId);
  const next = remaining[Math.min(Math.max(oldIdx, 0), remaining.length - 1)];
  if (!next) return { openTabs: [], activeTabId: null, ...fleetTopLevel() };
  return {
    openTabs: remaining,
    activeTabId: next.id,
    selectedContext: next.selectedContext,
    selectedVirtualContextId: next.selectedVirtualContextId,
    scopeExtras: next.scopeExtras,
    ...next.slice,
  };
}

/// Resolve a tab's scope to the set of physical cluster ids it spans (single
/// context, virtual-context members, plus ad-hoc extras).
function tabClusterIds(
  s: Pick<AppState, "contexts" | "virtualContexts">,
  tab: ClusterTab,
): string[] {
  return selectActiveClusterIds({
    contexts: s.contexts,
    selectedContext: tab.selectedContext,
    virtualContexts: s.virtualContexts,
    selectedVirtualContextId: tab.selectedVirtualContextId,
    scopeExtras: tab.scopeExtras,
  });
}

/// Clusters that closing `tabId` would leave with no remaining open tab — the
/// set the caller should disconnect backend-side. Clusters shared by another
/// open tab (e.g. a virtual-context member) are excluded. Pure; call before
/// `closeTab` and feed the result to `api.closeClusterTab`.
export function selectClustersToDisconnect(
  s: Pick<AppState, "openTabs" | "contexts" | "virtualContexts">,
  tabId: string,
): string[] {
  const tab = s.openTabs.find((t) => t.id === tabId);
  if (!tab) return [];
  const mine = tabClusterIds(s, tab);
  const othersUse = new Set<string>();
  for (const t of s.openTabs) {
    if (t.id === tabId) continue;
    for (const c of tabClusterIds(s, t)) othersUse.add(c);
  }
  return mine.filter((c) => !othersUse.has(c));
}

/// Apply `fn` to the dock tab with `id` wherever it lives — the active tab's
/// live top-level `dockTabs`, or a background tab's stashed slice. A hidden
/// tab's terminal/chat may still patch its own state (e.g. a chat streaming in
/// the background); routing by ownership keeps that update off the active tab.
function patchOwningDockTab(
  s: AppState,
  id: string,
  fn: (t: DockTab) => DockTab,
): Partial<AppState> {
  if (s.dockTabs.some((t) => t.id === id)) {
    return { dockTabs: s.dockTabs.map((t) => (t.id === id ? fn(t) : t)) };
  }
  let touched = false;
  const openTabs = s.openTabs.map((tab) => {
    if (!tab.slice.dockTabs.some((t) => t.id === id)) return tab;
    touched = true;
    return {
      ...tab,
      slice: {
        ...tab.slice,
        dockTabs: tab.slice.dockTabs.map((t) => (t.id === id ? fn(t) : t)),
      },
    };
  });
  return touched ? { openTabs } : {};
}

/// Make sure a detail-navigation target's namespace is visible. An active
/// namespace filter that excludes it would keep the target's row out of the
/// table (the subscription is namespace-scoped at the apiserver), so the
/// navigation would silently never resolve. Extending — not replacing — the
/// filter keeps the operator's other selections intact. Returns the same Set
/// when nothing changes so referential equality holds.
function namespacesIncluding(
  current: Set<string>,
  namespace: string | null,
): Set<string> {
  if (namespace == null || current.size === 0 || current.has(namespace)) {
    return current;
  }
  return new Set([...current, namespace]);
}

export const useAppStore = create<AppState>((set, get) => ({
  contexts: [],
  contextsStatus: "idle",
  contextsError: null,
  selectedContext: null,

  openTabs: [],
  activeTabId: null,

  virtualContexts: [],
  selectedVirtualContextId: null,
  scopeExtras: [],

  kinds: [],
  kindsStatus: "idle",
  kindsError: null,
  selectedKindId: null,
  kindClusters: {},

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

  selection: new Map<string, SelectionMeta>(),

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

  metricsByCluster: {},

  clusterHealth: {},
  clusterHealthReason: {},
  clusterReconnecting: {},
  clusterEpoch: {},

  forwards: {},
  forwardsOpen: false,
  globalForwards: {},
  helperStatus: { state: "not_started" },

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
    darkConsole: true,
    startupScope: "latest_view",
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
    set((s) => {
      // An active virtual context stays selected while at least one member
      // still resolves against the refreshed context list — a temporarily
      // missing kubeconfig shouldn't kick the operator back to the fleet.
      const activeVctx = s.selectedVirtualContextId
        ? s.virtualContexts.find((v) => v.id === s.selectedVirtualContextId)
        : undefined;
      const vctxAlive =
        !!activeVctx && activeVctx.members.some((m) => cs.some((c) => c.id === m));
      const selectedContext =
        s.selectedContext && cs.some((c) => c.id === s.selectedContext)
          ? s.selectedContext
          : null;
      // Ad-hoc extras only make sense while their anchor scope survives;
      // individually, an extra whose context vanished is pruned.
      const anchorAlive = vctxAlive || selectedContext !== null;
      return {
        contexts: cs,
        contextsStatus: "ready",
        contextsError: null,
        selectedContext,
        selectedVirtualContextId: vctxAlive ? s.selectedVirtualContextId : null,
        scopeExtras: anchorAlive
          ? s.scopeExtras.filter((id) => cs.some((c) => c.id === id))
          : [],
      };
    }),
  setContextsError: (err) =>
    set({ contextsStatus: "error", contextsError: err }),
  // Opening / switching clusters now goes through the tab model. `null` drops
  // to the Fleet landing without discarding any open tab's state.
  selectContext: (name) =>
    name === null
      ? get().goFleet()
      : get().openTab({ kind: "context", contextId: name }),

  selectVirtualContext: (id) =>
    id === null
      ? get().goFleet()
      : get().openTab({ kind: "virtual", virtualId: id }),

  openTab: (anchor) =>
    set((s) => {
      // Already open under this anchor → switch, preserving its slice.
      const existing =
        anchor.kind === "context"
          ? s.openTabs.find(
              (t) =>
                t.selectedContext === anchor.contextId &&
                t.selectedVirtualContextId === null,
            )
          : s.openTabs.find(
              (t) => t.selectedVirtualContextId === anchor.virtualId,
            );
      if (existing) return switchToTab(s, existing.id);

      // Reject a virtual anchor that doesn't resolve — a stale palette entry or
      // removed virtual context must not push an empty tab. Plain contexts are
      // accepted even if not yet in `contexts` (kubeconfig may be transiently
      // missing or still loading); `selectActiveClusterIds` filters members.
      if (
        anchor.kind === "virtual" &&
        !s.virtualContexts.some((v) => v.id === anchor.virtualId)
      ) {
        return {};
      }

      const slice = emptyScopeSlice();
      slice.selectedKindId = s.kinds[0]?.id ?? null;
      const tab: ClusterTab = {
        id: crypto.randomUUID(),
        selectedContext: anchor.kind === "context" ? anchor.contextId : null,
        selectedVirtualContextId:
          anchor.kind === "virtual" ? anchor.virtualId : null,
        scopeExtras: [],
        slice,
      };
      return {
        openTabs: [...stashActive(s), tab],
        activeTabId: tab.id,
        selectedContext: tab.selectedContext,
        selectedVirtualContextId: tab.selectedVirtualContextId,
        scopeExtras: tab.scopeExtras,
        ...slice,
      };
    }),

  switchTab: (id) => set((s) => switchToTab(s, id)),

  closeTab: (id) =>
    set((s) => focusAfterClose(s, stashActive(s), [id])),

  // Returning to Fleet is a full reset: close every open tab and clear the
  // live mirror. App's open-tab→connection reconcile effect then disconnects
  // all the now-unreferenced clusters (tearing down their watchers, terminals,
  // chats and unpinned forwards). The caller (`goToFleet`) confirms first when
  // live sessions would be lost.
  goFleet: () =>
    set(() => ({
      openTabs: [],
      activeTabId: null,
      ...fleetTopLevel(),
    })),
  saveVirtualContext: (name, members) => {
    const id = crypto.randomUUID();
    set((s) => ({
      virtualContexts: [...s.virtualContexts, { id, name, members }],
    }));
    return id;
  },
  renameVirtualContext: (id, name) =>
    set((s) => ({
      virtualContexts: s.virtualContexts.map((v) =>
        v.id === id ? { ...v, name } : v,
      ),
    })),
  setVirtualContextMembers: (id, members) =>
    set((s) => ({
      virtualContexts: s.virtualContexts.map((v) =>
        v.id === id ? { ...v, members } : v,
      ),
    })),
  absorbScopeExtras: (id) =>
    set((s) => {
      // Fold the ad-hoc extras into a saved virtual context's definition:
      // the temporary widening becomes permanent and the view is no longer
      // "dirty". No-op without extras or for an unknown id.
      const vctx = s.virtualContexts.find((v) => v.id === id);
      if (!vctx || s.scopeExtras.length === 0) return {};
      const members = [
        ...vctx.members,
        ...s.scopeExtras.filter((e) => !vctx.members.includes(e)),
      ];
      return {
        virtualContexts: s.virtualContexts.map((v) =>
          v.id === id ? { ...v, members } : v,
        ),
        scopeExtras: [],
      };
    }),
  deleteVirtualContext: (id) =>
    set((s) => {
      const virtualContexts = s.virtualContexts.filter((v) => v.id !== id);
      // Close any open tab anchored on the deleted virtual context — its scope
      // no longer resolves.
      const closeIds = s.openTabs
        .filter((t) => t.selectedVirtualContextId === id)
        .map((t) => t.id);
      if (closeIds.length === 0) return { virtualContexts };
      return {
        virtualContexts,
        ...focusAfterClose(s, stashActive(s), closeIds),
      };
    }),
  addScopeExtra: (contextId) =>
    set((s) => {
      if (!s.contexts.some((c) => c.id === contextId)) return {};
      // Extras extend an existing scope; without an anchor (selected
      // context or virtual context) there is nothing to extend — matches
      // the reconciliation in setContexts, which clears orphaned extras.
      if (s.selectedContext === null && s.selectedVirtualContextId === null) {
        return {};
      }
      if (selectActiveClusterIds(s).includes(contextId)) return {};
      return { scopeExtras: [...s.scopeExtras, contextId] };
    }),
  removeScopeExtra: (contextId) =>
    set((s) => ({
      scopeExtras: s.scopeExtras.filter((id) => id !== contextId),
      selection: new Map<string, SelectionMeta>(),
    })),

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
  setKindClusters: (m) => set({ kindClusters: m }),
  selectKind: (id) =>
    set({
      selectedKindId: id,
      selection: new Map<string, SelectionMeta>(),
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
      selection: new Map<string, SelectionMeta>(),
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
    // Defensive: a dock tab owned by a backgrounded cluster tab (closed e.g.
    // via a background lifecycle) lives in that tab's slice, not the live
    // top-level. Remove it there and fix that slice's active id.
    if (!s.dockTabs.some((t) => t.id === id)) {
      set({
        openTabs: s.openTabs.map((tab) => {
          if (!tab.slice.dockTabs.some((t) => t.id === id)) return tab;
          const rest = tab.slice.dockTabs.filter((t) => t.id !== id);
          return {
            ...tab,
            slice: {
              ...tab.slice,
              dockTabs: rest,
              dockActiveId:
                tab.slice.dockActiveId === id
                  ? (rest[rest.length - 1]?.id ?? null)
                  : tab.slice.dockActiveId,
            },
          };
        }),
      });
      return;
    }
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
    set((s) =>
      patchOwningDockTab(s, id, (t) => ({
        ...t,
        state: { ...t.state, ...patch },
      })),
    ),
  patchDockTab: (id, patch) =>
    set((s) => patchOwningDockTab(s, id, (t) => ({ ...t, ...patch }))),

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
      selection: new Map<string, SelectionMeta>(),
    }),

  setMetrics: (clusterId, snap) =>
    set((s) => ({
      metricsByCluster: { ...s.metricsByCluster, [clusterId]: snap },
    })),
  clearMetrics: (clusterId) =>
    set((s) => {
      if (clusterId === undefined) return { metricsByCluster: {} };
      if (!(clusterId in s.metricsByCluster)) return {};
      const next = { ...s.metricsByCluster };
      delete next[clusterId];
      return { metricsByCluster: next };
    }),

  applyClusterHealth: (clusterId, status, reason) =>
    set((s) => ({
      clusterHealth: { ...s.clusterHealth, [clusterId]: status },
      clusterHealthReason: { ...s.clusterHealthReason, [clusterId]: reason },
    })),
  clearClusterHealth: (clusterId) =>
    set((s) => {
      const { [clusterId]: _h, ...rest } = s.clusterHealth;
      const { [clusterId]: _r, ...restR } = s.clusterHealthReason;
      // Bump the reconnect epoch so effects keyed on it (Rail CRD discovery)
      // re-run against the freshly-rebuilt client and drop any stale error.
      return {
        clusterHealth: rest,
        clusterHealthReason: restR,
        clusterEpoch: {
          ...s.clusterEpoch,
          [clusterId]: (s.clusterEpoch[clusterId] ?? 0) + 1,
        },
      };
    }),
  setClusterReconnecting: (clusterId, value) =>
    set((s) => {
      if ((s.clusterReconnecting[clusterId] ?? false) === value) return s;
      if (value) {
        return {
          clusterReconnecting: { ...s.clusterReconnecting, [clusterId]: true },
        };
      }
      const { [clusterId]: _x, ...rest } = s.clusterReconnecting;
      return { clusterReconnecting: rest };
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

  hydrateGlobalForwards: (sessions) =>
    set({
      globalForwards: Object.fromEntries(sessions.map((s) => [s.id, s])),
    }),
  upsertGlobalForward: (session) =>
    set((s) => ({
      globalForwards: { ...s.globalForwards, [session.id]: session },
    })),
  removeGlobalForward: (id) =>
    set((s) => {
      const next = { ...s.globalForwards };
      delete next[id];
      return { globalForwards: next };
    }),
  setHelperStatus: (status) => set({ helperStatus: status }),

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
      // Older prefs files predate virtual contexts; serde defaults the list
      // server-side but tolerate an absent field from transitional builds.
      const virtualContexts = prefs.virtual_contexts ?? [];
      // Restore-on-launch behaviour (Settings → General): "latest_view"
      // reopens everything (virtual context + ad-hoc extras), "latest_cluster"
      // only the anchor cluster, "fleet" starts fresh. The persisted
      // selection fields stay in the file either way — only the restore is
      // gated, so flipping the setting back restores the old behaviour.
      const startupScope = prefs.settings.startup_scope ?? "latest_view";
      // A persisted virtual-context selection only survives if the virtual
      // context itself still exists. Wins over `selected_context` when both
      // are set (they're mutually exclusive; trust the virtual one).
      const selectedVirtualContextId =
        startupScope === "latest_view" &&
        prefs.ui.selected_virtual_context &&
        virtualContexts.some((v) => v.id === prefs.ui.selected_virtual_context)
          ? prefs.ui.selected_virtual_context
          : null;
      // Honor the persisted cluster selection only if it's still present in
      // whatever the contexts list currently has. If not (file moved), drop
      // silently — better than dangling on a missing id.
      const selectedContext =
        startupScope === "fleet"
          ? null
          : selectedVirtualContextId
            ? null
            : prefs.ui.selected_context &&
                (s.contexts.length === 0 ||
                  s.contexts.some((c) => c.id === prefs.ui.selected_context))
              ? prefs.ui.selected_context
              : s.selectedContext;
      // Ad-hoc extras (an unsaved multi-cluster view) come back only under
      // "latest_view" and only with an anchor to extend. setContexts prunes
      // members that no longer resolve once the kubeconfig list lands.
      const scopeExtras =
        startupScope === "latest_view" &&
        (selectedVirtualContextId !== null || selectedContext !== null)
          ? [...new Set(prefs.ui.scope_extras ?? [])].filter(
              (e) =>
                s.contexts.length === 0 || s.contexts.some((c) => c.id === e),
            )
          : [];

      // Persisted kind, validated against the (possibly not-yet-loaded) kind
      // list. Used both for the active tab's mirror and to seed restored tabs.
      const restoredKindId =
        prefs.ui.selected_kind_id &&
        (s.kinds.length === 0 ||
          s.kinds.some((k) => k.id === prefs.ui.selected_kind_id))
          ? prefs.ui.selected_kind_id
          : null;

      // Reconstruct the open cluster tabs (refs only — live slices like
      // terminals/chats can't survive a restart). "fleet" ignores the saved
      // set; "latest_cluster" keeps only the active tab; "latest_view" reopens
      // everything. A tab whose anchor no longer resolves is dropped (lenient
      // while the kubeconfig list is still loading — `s.contexts` empty).
      const refResolves = (ref: {
        selected_context: string | null;
        selected_virtual_context: string | null;
      }) => {
        if (ref.selected_virtual_context) {
          return virtualContexts.some(
            (v) => v.id === ref.selected_virtual_context,
          );
        }
        if (ref.selected_context) {
          return (
            s.contexts.length === 0 ||
            s.contexts.some((c) => c.id === ref.selected_context)
          );
        }
        return false;
      };
      const makeTabSlice = (): ScopeSlice => {
        const sl = emptyScopeSlice();
        sl.selectedKindId = restoredKindId;
        return sl;
      };
      // One tab built from the legacy single-anchor fields — used for
      // "latest_cluster" (which strips vctx + extras above) and as the
      // migration path for pre-tabs prefs files under "latest_view".
      const singleAnchorTab = (): ClusterTab[] => {
        if (selectedContext === null && selectedVirtualContextId === null) {
          return [];
        }
        return [
          {
            id: crypto.randomUUID(),
            selectedContext,
            selectedVirtualContextId,
            scopeExtras,
            slice: makeTabSlice(),
          },
        ];
      };

      let openTabs: ClusterTab[];
      let activeTabId: string | null;
      if (startupScope === "fleet") {
        // Fleet ignores the saved set entirely.
        openTabs = [];
        activeTabId = null;
      } else if (startupScope === "latest_cluster") {
        openTabs = singleAnchorTab();
        activeTabId = openTabs[0]?.id ?? null;
      } else {
        // latest_view: reopen the full persisted set; fall back to the single
        // anchor when the file predates the tab model.
        const refs = (prefs.ui.open_tabs ?? []).filter(refResolves);
        if (refs.length > 0) {
          openTabs = refs.map((ref) => ({
            id: ref.id || crypto.randomUUID(),
            selectedContext: ref.selected_virtual_context
              ? null
              : (ref.selected_context ?? null),
            selectedVirtualContextId: ref.selected_virtual_context ?? null,
            scopeExtras: ref.scope_extras ?? [],
            slice: makeTabSlice(),
          }));
          const wantActive = prefs.ui.active_tab ?? null;
          activeTabId = (
            openTabs.find((tb) => tb.id === wantActive) ?? openTabs[0]!
          ).id;
        } else {
          openTabs = singleAnchorTab();
          activeTabId = openTabs[0]?.id ?? null;
        }
      }
      const activeTab = openTabs.find((tb) => tb.id === activeTabId) ?? null;

      return {
      openTabs,
      activeTabId,
      themeMode,
      themeId,
      paletteId,
      themeOverrides,
      railMode: prefs.ui.rail_mode,
      virtualContexts,
      // The top-level anchor mirror follows the active tab (which `active_tab`
      // chose), not the legacy single-selection fields.
      selectedVirtualContextId: activeTab
        ? activeTab.selectedVirtualContextId
        : null,
      selectedContext: activeTab ? activeTab.selectedContext : null,
      scopeExtras: activeTab ? activeTab.scopeExtras : [],
      selectedKindId: activeTab ? activeTab.slice.selectedKindId : null,
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
        // Older prefs predate dark_console; default on so a light-theme user
        // gets the console treatment without re-opting.
        darkConsole: prefs.settings.dark_console ?? true,
        startupScope,
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
      // Prune a view only when it carries nothing worth persisting. A view
      // with custom label columns but no sort/sizing must survive.
      if (
        view.sorting.length === 0 &&
        Object.keys(view.column_sizing).length === 0 &&
        (view.label_columns?.length ?? 0) === 0
      ) {
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
        route: toast.route,
        meta: toast.meta,
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

  navigateToDetail: (kindId, namespace, name, clusterId = null) =>
    set((s) => {
      const entry: DetailEntry = { clusterId, kindId, namespace, name };
      // Browser semantics: going back then sideways drops the forward branch.
      const head = s.detailHistory.slice(0, s.detailIndex + 1);
      const last = head[head.length - 1];
      const dup =
        !!last &&
        last.kindId === entry.kindId &&
        last.namespace === entry.namespace &&
        last.name === entry.name &&
        last.clusterId === entry.clusterId;
      const nextHistory = dup ? head : [...head, entry];
      return {
        // Switch kind in the same tick so the table re-mounts already knowing
        // it should auto-open this object's detail.
        selectedKindId: kindId,
        selection: new Map<string, SelectionMeta>(),
        pendingDetail: entry,
        detailHistory: nextHistory,
        detailIndex: nextHistory.length - 1,
        selectedNamespaces: namespacesIncluding(
          s.selectedNamespaces,
          namespace,
        ),
      };
    }),
  pushDetailEntry: (kindId, namespace, name, clusterId = null) =>
    set((s) => {
      const entry: DetailEntry = { clusterId, kindId, namespace, name };
      const head = s.detailHistory.slice(0, s.detailIndex + 1);
      const last = head[head.length - 1];
      if (
        last &&
        last.kindId === entry.kindId &&
        last.namespace === entry.namespace &&
        last.name === entry.name &&
        last.clusterId === entry.clusterId
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
        selection: new Map<string, SelectionMeta>(),
        pendingDetail: { ...e },
        selectedNamespaces: namespacesIncluding(
          s.selectedNamespaces,
          e.namespace,
        ),
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
        selection: new Map<string, SelectionMeta>(),
        pendingDetail: { ...e },
        selectedNamespaces: namespacesIncluding(
          s.selectedNamespaces,
          e.namespace,
        ),
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

/// Build the full `Prefs` payload for `set_prefs` from store state. The
/// backend overwrites prefs.json with exactly this object, so EVERY persisted
/// field must round-trip through here — omitting one silently erases it on
/// the next settings change. Pure and exported so the wipe hazard stays
/// regression-testable.
export function buildPrefsPayload(s: {
  themeId: string;
  paletteId: string;
  themeMode: ThemeMode;
  themeOverrides: ThemeOverrides | null;
  settings: AppState["settings"];
  selectedContext: string | null;
  selectedVirtualContextId: string | null;
  selectedKindId: string | null;
  selectedNamespaces: Set<string>;
  scopeExtras: string[];
  railMode: PrefsRailMode;
  dockSize: Record<DockPlacement, number | null>;
  updateState: UpdateStateSlice;
  virtualContexts: VirtualContext[];
  openTabs: ClusterTab[];
  activeTabId: string | null;
}): Prefs {
  return {
    theme: {
      id: s.themeId,
      palette_id: s.paletteId,
      mode: s.themeMode,
      overrides: s.themeOverrides,
    },
    settings: {
      refresh_sec: s.settings.refreshSec,
      confirm_destructive: s.settings.confirmDestructive,
      show_system_ns: s.settings.showSystemNs,
      density: s.settings.density,
      mono_tables: s.settings.monoTables,
      refresh_on_launch: s.settings.refreshOnLaunch,
      ui_scale: s.settings.uiScale,
      fleet_view: s.settings.fleetView,
      dark_console: s.settings.darkConsole,
      startup_scope: s.settings.startupScope,
    },
    ui: {
      selected_context: s.selectedContext,
      selected_virtual_context: s.selectedVirtualContextId,
      selected_kind_id: s.selectedKindId,
      selected_namespaces: Array.from(s.selectedNamespaces).sort(),
      scope_extras: s.scopeExtras,
      rail_mode: s.railMode,
      dock_size_right: s.dockSize.right,
      dock_size_bottom: s.dockSize.bottom,
      // Open cluster tabs, refs only. The active tab's anchor lives in the live
      // top-level mirror (the slice in `openTabs` is stale until the next
      // switch), so overlay it here rather than reading the stashed copy.
      open_tabs: s.openTabs.map((tab) =>
        tab.id === s.activeTabId
          ? {
              id: tab.id,
              selected_context: s.selectedContext,
              selected_virtual_context: s.selectedVirtualContextId,
              scope_extras: s.scopeExtras,
            }
          : {
              id: tab.id,
              selected_context: tab.selectedContext,
              selected_virtual_context: tab.selectedVirtualContextId,
              scope_extras: tab.scopeExtras,
            },
      ),
      active_tab: s.activeTabId,
    },
    update: {
      last_known_version: s.updateState.lastKnownVersion,
      last_seen_version: s.updateState.lastSeenVersion,
      last_check_at: s.updateState.lastCheckAt,
      auto_check_enabled: s.updateState.autoCheckEnabled,
    },
    virtual_contexts: s.virtualContexts,
  };
}

/// The physical cluster ids the app is currently observing, in stable order.
/// Virtual context active → its members (filtered to contexts that still
/// exist); otherwise the single selected context; either way ad-hoc
/// `scopeExtras` are appended (deduped, also filtered). Empty array = fleet
/// landing. Pure — usable from reducers and tests; components prefer
/// `useActiveClusterIds()` for a referentially-stable value.
export function selectActiveClusterIds(s: {
  contexts: ContextInfo[];
  selectedContext: string | null;
  virtualContexts: VirtualContext[];
  selectedVirtualContextId: string | null;
  scopeExtras: string[];
}): string[] {
  const exists = (id: string) =>
    s.contexts.length === 0 || s.contexts.some((c) => c.id === id);
  const base: string[] = [];
  if (s.selectedVirtualContextId) {
    const vctx = s.virtualContexts.find(
      (v) => v.id === s.selectedVirtualContextId,
    );
    if (vctx) base.push(...vctx.members.filter(exists));
  } else if (s.selectedContext) {
    base.push(s.selectedContext);
  }
  for (const id of s.scopeExtras) {
    if (exists(id) && !base.includes(id)) base.push(id);
  }
  return base;
}

/// True when a cluster is not currently usable for writes: either the health
/// probe declared it unavailable, or the connection hook is mid auto-reconnect
/// (a freshly-rebuilt-but-unverified client). Read by every write affordance
/// (row menu, bulk bar, detail buttons, inline edit, YAML/Helm save) to gate
/// itself down to read-only. Pure — usable from reducers, imperative menu
/// builders, and tests. The backend stays the final arbiter; this is courtesy
/// disabling so the operator isn't firing doomed mutations at a dead apiserver.
export function selectClusterDegraded(
  s: {
    clusterHealth: Record<string, ClusterHealthStatus>;
    clusterReconnecting: Record<string, boolean>;
  },
  clusterId: string,
): boolean {
  return (
    s.clusterHealth[clusterId] === "unavailable" ||
    s.clusterReconnecting[clusterId] === true
  );
}

/// Hook form of `selectActiveClusterIds` with a referentially-stable result:
/// the array identity only changes when the joined id list changes, so
/// effects keyed on it don't re-fire on unrelated store updates.
export function useActiveClusterIds(): string[] {
  const joined = useAppStore((s) => selectActiveClusterIds(s).join("\u0000"));
  return useMemo(
    () => (joined === "" ? [] : joined.split("\u0000")),
    [joined],
  );
}

/// Combined reconnect-epoch of every active cluster. Bumps whenever any active
/// cluster is reconnected (`clearClusterHealth`). A plain number so effects can
/// add it to their dependency array to re-run on reconnect even when the active
/// id set itself is unchanged (same-cluster reconnect). Epochs only ever
/// increase, so summing is a sound change-detector.
export function useActiveClusterEpoch(): number {
  return useAppStore((s) => {
    let sum = 0;
    for (const id of selectActiveClusterIds(s)) sum += s.clusterEpoch[id] ?? 0;
    return sum;
  });
}

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

/// Console (logs + terminal) color tokens. Mirrors `useResolvedTheme` but
/// honours the `darkConsole` setting: when on, the surface resolves the active
/// theme's dark palette even under a light theme so it reads like a terminal.
/// When off, it follows the active mode like any other panel.
export function useConsoleTokens(): ColorTokens {
  const themeId = useAppStore((s) => s.themeId);
  const paletteId = useAppStore((s) => s.paletteId);
  const mode = useAppStore((s) => s.themeMode);
  const overrides = useAppStore((s) => s.themeOverrides);
  const darkConsole = useAppStore((s) => s.settings.darkConsole);
  return useMemo(
    () => consoleTokens({ themeId, paletteId, mode, overrides, darkConsole }),
    [themeId, paletteId, mode, overrides, darkConsole],
  );
}
