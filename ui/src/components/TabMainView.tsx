import { useMemo } from "react";
import { selectActiveClusterIds, useAppStore, useClusterLabels } from "../store";
import type { ThemeMode } from "../theme";
import { useTabSlice } from "../lib/tabScope";
import { ClusterPanel } from "./ClusterPanel";
import { VirtualClusterPanel } from "./VirtualClusterPanel";

/// Main view of the selected cluster tab, rendered inside its
/// `TabScopeProvider` and reading that tab's scope.
export function TabMainView({ mode }: { mode: ThemeMode }) {
  const selectedContextId = useTabSlice((v) => v.selectedContext);
  const vctxId = useTabSlice((v) => v.selectedVirtualContextId);
  const scopeExtras = useTabSlice((v) => v.scopeExtras);
  const contexts = useAppStore((s) => s.contexts);
  const virtualContexts = useAppStore((s) => s.virtualContexts);
  const clusterLabels = useClusterLabels();

  const vctx = vctxId ? (virtualContexts.find((v) => v.id === vctxId) ?? null) : null;
  const selectedContext = contexts.find((c) => c.id === selectedContextId) ?? null;
  const clusterIds = useMemo(
    () =>
      selectActiveClusterIds({
        contexts,
        selectedContext: selectedContextId,
        virtualContexts,
        selectedVirtualContextId: vctxId,
        scopeExtras,
      }),
    [contexts, selectedContextId, virtualContexts, vctxId, scopeExtras],
  );
  const memberContexts = useMemo(
    () =>
      clusterIds
        .map((id) => contexts.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c != null),
    [clusterIds, contexts],
  );

  if ((vctx !== null || clusterIds.length > 1) && memberContexts.length > 0) {
    return (
      <VirtualClusterPanel
        // Remount on scope change so per-member connection state never
        // bleeds between virtual contexts.
        key={vctx?.id ?? selectedContextId ?? "adhoc"}
        mode={mode}
        title={
          vctx
            ? vctx.name
            : `${(selectedContext && clusterLabels[selectedContext.id]?.short) ?? selectedContext?.name ?? "Ad-hoc"} +${memberContexts.length - 1}`
        }
        viewScopeId={vctx ? `vctx:${vctx.id}` : (selectedContextId ?? "adhoc")}
        contexts={memberContexts}
      />
    );
  }
  if (selectedContext) return <ClusterPanel mode={mode} context={selectedContext} />;
  return null;
}
