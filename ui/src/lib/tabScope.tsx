import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppStore, type ClusterTab, type ScopeSlice, type TabAnchors } from "../store";
import type { ResourceKind } from "../types";

// Which cluster tab a subtree belongs to, and whether it is shown (parked
// drawers and background docks are not). Outside any provider (tests, Fleet)
// the subtree behaves as the active tab.
type TabScope = { tabId: string | null; active: boolean };

const TabScopeContext = createContext<TabScope>({ tabId: null, active: true });

export function TabScopeProvider({
  tabId,
  active,
  children,
}: TabScope & { children: ReactNode }) {
  const value = useMemo(() => ({ tabId, active }), [tabId, active]);
  return <TabScopeContext.Provider value={value}>{children}</TabScopeContext.Provider>;
}

export function useTabScope(): TabScope {
  return useContext(TabScopeContext);
}

/// False inside a hidden tab. Anything global — Esc layers, window hotkeys,
/// the header count, drawer width, polling — must stand down when false.
export function useTabActive(): boolean {
  return useContext(TabScopeContext).active;
}

export type TabView = ScopeSlice & TabAnchors;

type StoreState = ReturnType<typeof useAppStore.getState>;

/// The slice + anchors of `tabId` as of `s`: the live mirror for the active
/// tab (or no tab), the stashed copy otherwise.
// Tabs are replaced, never mutated, so a view per tab object stays valid and
// selectors don't allocate on every store update.
const views = new WeakMap<ClusterTab, TabView>();

export function tabViewOf(s: StoreState, tabId: string | null): TabView {
  if (tabId === null || tabId === s.activeTabId) return s;
  const tab = s.openTabs.find((t) => t.id === tabId);
  if (!tab) return s;
  let v = views.get(tab);
  if (!v) {
    v = { ...tab.slice, ...tab };
    views.set(tab, v);
  }
  return v;
}

/// Select from this subtree's tab. Selectors must return stable references
/// (a field, not a fresh object), like any zustand selector.
export function useTabSlice<T>(sel: (v: TabView) => T): T {
  const { tabId } = useTabScope();
  return useAppStore((s) => sel(tabViewOf(s, tabId)));
}

/// Non-hook read of this subtree's tab, for callbacks and effects.
export function readTab(tabId: string | null): TabView {
  return tabViewOf(useAppStore.getState(), tabId);
}

/// Write slice fields to `tabId` — the mirror when it's active (or null),
/// its stashed slice otherwise. For effect-driven writes that may fire while
/// the tab is hidden; user-triggered writes happen only in the active tab.
export function writeTab(tabId: string | null, patch: Partial<ScopeSlice>): void {
  useAppStore.getState().patchTab(tabId, patch);
}

/// This tab's selected kind. Falls back to the session kind cache: `kinds`
/// follows the active scope, so a hidden tab's CRD may be missing from it.
export function useTabKind(): ResourceKind | null {
  const id = useTabSlice((v) => v.selectedKindId);
  return useAppStore((s) =>
    id ? (s.kinds.find((k) => k.id === id) ?? s.kindCache[id] ?? null) : null,
  );
}
