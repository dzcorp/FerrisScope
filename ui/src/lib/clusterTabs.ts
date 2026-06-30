// Orchestration helpers for the cluster-tab model. The store owns the pure
// tab state (open / switch / close); these helpers add the side effects the
// store deliberately stays out of — backend disconnect of clusters that no
// other open tab still uses.

import { confirm } from "./dialog";
import { selectActiveClusterIds, useAppStore, type ClusterTab } from "../store";

/// Live terminal/chat dock sessions a tab is holding. For the active tab these
/// live in the top-level mirror; for a background tab, in its stashed slice.
function tabLiveSessions(tab: ClusterTab): number {
  const s = useAppStore.getState();
  const dockTabs =
    s.activeTabId === tab.id ? s.dockTabs : tab.slice.dockTabs;
  return dockTabs.filter((d) => d.kind === "terminal" || d.kind === "chat")
    .length;
}

/// Close a cluster tab. When the tab is holding live terminal/chat sessions,
/// confirm first — closing kills those PTYs / chat runtimes and they can't be
/// restored. Disconnecting the (now-unreferenced) cluster is NOT done here: the
/// store just removes the tab, and App's open-tab→connection reconcile effect
/// disconnects any cluster that no longer appears in any open tab. That single
/// path also covers `goToFleet`, and keeps a cluster shared by a sibling tab
/// connected. Fire-and-forget from click handlers (`void closeClusterTab(id)`).
export async function closeClusterTab(tabId: string): Promise<void> {
  const s = useAppStore.getState();
  const tab = s.openTabs.find((t) => t.id === tabId);
  if (!tab) return;
  const live = tabLiveSessions(tab);
  if (live > 0) {
    const ok = await confirm({
      title: "Close cluster tab?",
      body: `This tab has ${live} live ${
        live === 1 ? "session" : "sessions"
      } (terminals / chats) that will be closed. This can't be undone.`,
      confirmLabel: "Close tab",
      cancelLabel: "Keep open",
      tone: "danger",
    });
    if (!ok) return;
  }
  useAppStore.getState().closeTab(tabId);
}

/// Return to the Fleet landing: a full reset that closes every open tab and
/// disconnects all clusters (via the reconcile effect). Confirms first when any
/// open tab is holding live sessions, so a stray click on the logo / Clusters
/// crumb can't silently kill terminals across every cluster.
export async function goToFleet(): Promise<void> {
  const s = useAppStore.getState();
  if (s.openTabs.length === 0 && s.activeTabId === null) return;
  const live = s.openTabs.reduce((n, t) => n + tabLiveSessions(t), 0);
  if (live > 0) {
    const ok = await confirm({
      title: "Return to Fleet?",
      body: `This closes all ${s.openTabs.length} open ${
        s.openTabs.length === 1 ? "cluster" : "clusters"
      } and ${live} live ${
        live === 1 ? "session" : "sessions"
      } (terminals / chats). This can't be undone.`,
      confirmLabel: "Close all",
      cancelLabel: "Stay",
      tone: "danger",
    });
    if (!ok) return;
  }
  useAppStore.getState().goFleet();
}

/// Human label for a tab: the context name for a single cluster, the virtual
/// context's name for a merged view, falling back to the raw id.
export function clusterTabLabel(
  tab: ClusterTab,
  contexts: { id: string; name: string }[],
  virtualContexts: { id: string; name: string }[],
): string {
  if (tab.selectedVirtualContextId) {
    const v = virtualContexts.find((vc) => vc.id === tab.selectedVirtualContextId);
    if (v) return v.name;
  }
  if (tab.selectedContext) {
    const c = contexts.find((cc) => cc.id === tab.selectedContext);
    if (c) return c.name;
    return tab.selectedContext;
  }
  return tab.selectedVirtualContextId ?? "cluster";
}

/// Primary (first) physical cluster id of a tab's scope — used to colour its
/// chip consistently with the rest of the multi-cluster UI.
export function clusterTabPrimaryId(
  tab: ClusterTab,
  contexts: { id: string; name: string }[],
  virtualContexts: { id: string; name: string; members?: string[] }[],
): string {
  const ids = selectActiveClusterIds({
    contexts: contexts as never,
    selectedContext: tab.selectedContext,
    virtualContexts: virtualContexts as never,
    selectedVirtualContextId: tab.selectedVirtualContextId,
    scopeExtras: tab.scopeExtras,
  });
  return ids[0] ?? tab.selectedContext ?? "";
}
