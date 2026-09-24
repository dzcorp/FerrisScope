import { drawerKey, useAppStore, useClusterLabels, type Drawer } from "../store";
import type { ThemeMode } from "../theme";
import { readTab, useTabScope } from "../lib/tabScope";
import { lookupRow } from "../lib/rowRegistry";
import { scopedUid } from "../lib/multiCluster";
import { resolveResourceKind } from "../lib/resourceKinds";
import { findDetailRow, useDetailRow } from "../lib/detailWatch";
import { toast } from "../lib/dialog";
import { logErr } from "../lib/log";
import { DetailPanel } from "./DetailPanel";
import { makeTerminalTab } from "./Dock";
import { openNodeDebugTab } from "./ResourceTable";

type DetailDrawer = Extract<Drawer, { kind: "detail" }>;

/// Hosts a detail drawer outside the table: it stays mounted while parked,
/// watches its own object, and follows links within its own back/forward
/// history instead of switching the table.
export function DetailDrawer({
  mode,
  drawer,
  instanceId,
}: {
  mode: ThemeMode;
  drawer: DetailDrawer;
  instanceId: string;
}) {
  const { tabId } = useTabScope();
  const kind = useAppStore(
    (s) => s.kinds.find((k) => k.id === drawer.kindId) ?? s.kindCache[drawer.kindId] ?? null,
  );
  const closeDrawer = useAppStore((s) => s.closeDrawer);
  const minimizeDrawer = useAppStore((s) => s.minimizeDrawer);
  const navigateDrawerDetail = useAppStore((s) => s.navigateDrawerDetail);
  const back = useAppStore((s) => s.drawerDetailBack);
  const forward = useAppStore((s) => s.drawerDetailForward);
  const addDockTab = useAppStore((s) => s.addDockTab);
  const saveDrawerView = useAppStore((s) => s.saveDrawerView);
  const labels = useClusterLabels();
  const { clusterId, namespace, name, uid } = drawer;
  const watched = useDetailRow(clusterId, kind, namespace, uid);
  if (!kind) return null;

  const label = (cid: string) =>
    labels[cid]?.short ?? useAppStore.getState().contexts.find((c) => c.id === cid)?.name ?? cid;

  const follow = async (
    targetKindName: string,
    ns: string | null,
    n: string,
    cid: string,
    group?: string,
  ) => {
    const from = drawerKey(drawer);
    const target = resolveResourceKind(
      useAppStore.getState().kinds,
      readTab(tabId).kindClusters,
      targetKindName,
      cid,
      group,
    );
    if (!target) return;
    const row = await findDetailRow(cid, target, target.namespaced ? ns : null, n);
    // The operator may have closed, hidden or re-targeted the panel meanwhile.
    const now = useAppStore.getState().drawer;
    if (!now || drawerKey(now) !== from) return;
    if (!row) {
      toast.warn(`${ns ? `${ns}/` : ""}${n} not found — it may have been deleted`);
      return;
    }
    navigateDrawerDetail({
      kindId: target.id,
      clusterId: cid,
      uid: row.uid,
      namespace: target.namespaced ? (typeof row.namespace === "string" ? row.namespace : ns) : null,
      name: n,
    });
  };

  return (
    <DetailPanel
      // A different kind means different tabs and sections: start fresh.
      // Same-kind navigation keeps the panel and its inner tab.
      key={drawer.kindId}
      mode={mode}
      clusterId={clusterId}
      kind={kind}
      target={drawer}
      // The delta listener must use the channel that carries this row: the
      // watcher scoped to its own namespace, or All for cluster-scoped kinds.
      subscribeNamespaces={kind.namespaced && namespace ? [namespace] : null}
      row={lookupRow(tabId, scopedUid(clusterId, uid)) ?? watched}
      initialView={drawer.view}
      onLeave={(view) => saveDrawerView(tabId, instanceId, drawerKey(drawer), view)}
      history={{
        prev: drawer.back?.[drawer.back.length - 1] ?? null,
        next: drawer.forward?.[0] ?? null,
        onBack: back,
        onForward: forward,
      }}
      onClose={closeDrawer}
      onMinimize={minimizeDrawer}
      onNavigate={(targetKindName, ns, n, cid = clusterId, group) => {
        follow(targetKindName, ns, n, cid, group).catch((e: unknown) => {
          logErr("detail")(e);
          toast.bad(`Couldn't open ${n}`);
        });
      }}
      onOpenExec={
        kind.id === "pods"
          ? (container) => {
              if (!namespace) {
                toast.bad("Pod has no namespace — can't exec.");
                return;
              }
              addDockTab(
                makeTerminalTab(
                  { mode: "exec", clusterId, namespace, pod: name, container: container ?? null },
                  label(clusterId),
                ),
              );
              closeDrawer();
            }
          : kind.id === "nodes"
            ? () => {
                openNodeDebugTab(clusterId, label(clusterId), name, addDockTab);
                closeDrawer();
              }
            : undefined
      }
    />
  );
}
