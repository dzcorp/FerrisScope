import { memo, useRef } from "react";
import { useAppStore, type Drawer } from "../store";
import type { ThemeMode } from "../theme";
import { TabScopeProvider, useTabScope, useTabSlice } from "../lib/tabScope";
import { ComparePanel } from "./ComparePanel";
import { InspectPanel } from "./inspect";
import { LogPanel } from "./LogPanel";
import { DetailDrawer } from "./DetailDrawer";

type Entry = { id: string; drawer: Drawer; shown: boolean };

/// The tab's open drawer plus its minimised ones, all mounted under a stable
/// instance key: minimising hides a drawer instead of unmounting it, so logs
/// keep streaming and scroll / inner tabs survive a restore.
export function TabDrawers({ mode }: { mode: ThemeMode }) {
  const orderRef = useRef<string[]>([]);
  const { tabId, active } = useTabScope();
  const drawer = useTabSlice((v) => v.drawer);
  const drawerId = useTabSlice((v) => v.drawerId);
  const tray = useTabSlice((v) => v.tray);

  const live: Entry[] = tray.map((i) => ({ id: i.id, drawer: i.drawer, shown: false }));
  if (drawer) live.push({ id: drawerId ?? "drawer", drawer, shown: true });
  const entries = stableOrder(orderRef, live);

  return (
    <>
      {entries.map((e) => (
          <TabScopeProvider key={e.id} tabId={tabId} active={active && e.shown}>
            <div
              aria-hidden={!e.shown}
              // Visibility keeps a parked drawer's scroll offsets; display:none
              // would reset them in WebKit.
              style={{ display: "contents", visibility: e.shown ? "visible" : "hidden" }}
            >
              <DrawerBody mode={mode} drawer={e.drawer} instanceId={e.id} />
            </div>
          </TabScopeProvider>
      ))}
    </>
  );
}

/// Render order must never change for a mounted instance: React moves keyed
/// DOM nodes on reorder, and a detached-then-reattached scroller loses its
/// scroll offset. New ids append; the rest keep their first-seen slot.
export function stableOrder<T extends { id: string }>(ref: { current: string[] }, items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const kept = ref.current.filter((id) => byId.has(id));
  for (const i of items) if (!kept.includes(i.id)) kept.push(i.id);
  ref.current = kept;
  return kept.map((id) => byId.get(id)!);
}

// Memoised: tray edits re-render TabDrawers, and every parked panel would
// otherwise re-render with it.
const DrawerBody = memo(function DrawerBody({
  mode,
  drawer,
  instanceId,
}: {
  mode: ThemeMode;
  drawer: Drawer;
  instanceId: string;
}) {
  const closeDrawer = useAppStore((s) => s.closeDrawer);
  const minimizeDrawer = useAppStore((s) => s.minimizeDrawer);
  const onMinimize = () => minimizeDrawer();
  switch (drawer.kind) {
    case "logs":
      return (
        <LogPanel
          mode={mode}
          targets={drawer.targets}
          initialTab={drawer.initialTab}
          defaultContainer={drawer.defaultContainer}
          onClose={closeDrawer}
          onMinimize={onMinimize}
        />
      );
    case "compare":
      return (
        <ComparePanel mode={mode} target={drawer.target} onClose={closeDrawer} onMinimize={onMinimize} />
      );
    case "inspect": {
      const target = drawer.target;
      return (
        <InspectPanel
          mode={mode}
          target={target}
          onClose={closeDrawer}
          onMinimize={onMinimize}
          onNavigate={(targetKindName, namespace, name, fromCluster) => {
            const st = useAppStore.getState();
            const kind = st.kinds.find((k) => k.kind === targetKindName);
            // Close first either way: the drawer shares the detail panel's
            // z-index, and a dead click must not look like a hang.
            closeDrawer();
            if (!kind) return;
            // The row's own cluster — an Inspect can span clusters.
            const clusterId = fromCluster ?? target.subjects[0]?.clusterId ?? null;
            st.navigateToDetail(kind.id, namespace, name, clusterId);
          }}
        />
      );
    }
    case "detail":
      return <DetailDrawer mode={mode} drawer={drawer} instanceId={instanceId} />;
  }
});
