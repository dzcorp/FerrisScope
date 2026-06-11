import { selectActiveClusterIds, useAppStore } from "../../store";
import type { ChatViewContext } from "../../types";

/// Build a `ChatViewContext` from the current store state, used to brief
/// the assistant on what the operator is looking at when they hit send.
/// Returns `undefined` when there's nothing useful — the backend already
/// skips the prompt block on empty payloads, but skipping the IPC arg
/// entirely keeps the wire neat. The snapshot is taken at call-time
/// (no re-render subscription) and the function is directly unit-testable.
export function snapshotViewContext(): ChatViewContext | undefined {
  const s = useAppStore.getState();
  // Multi-cluster view: send the member list instead of a single cluster
  // id — the prompt block tells the model the view merges several clusters
  // and that it can switch between them. Covers both a saved virtual
  // context and an ad-hoc scope widened via "Add cluster…".
  const activeIds = selectActiveClusterIds(s);
  const activeVctx = s.selectedVirtualContextId
    ? s.virtualContexts.find((v) => v.id === s.selectedVirtualContextId)
    : undefined;
  const multi = activeVctx !== undefined || activeIds.length > 1;
  const virtualContext = multi
    ? {
        name:
          activeVctx?.name ??
          `${s.contexts.find((c) => c.id === activeIds[0])?.name ?? "ad-hoc"} +${activeIds.length - 1}`,
        memberClusterIds: activeIds,
      }
    : undefined;
  const clusterId = multi ? undefined : s.selectedContext ?? undefined;
  const kindId = s.selectedKindId ?? undefined;
  const kindLabel = kindId
    ? s.kinds.find((k) => k.id === kindId)?.kind
    : undefined;
  const namespaces =
    s.selectedNamespaces.size > 0 ? Array.from(s.selectedNamespaces) : undefined;
  const selected =
    s.selection.size > 0
      ? Array.from(s.selection.values()).map((r) => ({
          namespace: r.namespace ?? undefined,
          name: r.name,
        }))
      : undefined;
  if (!clusterId && !kindId && !namespaces && !selected && !virtualContext) {
    return undefined;
  }
  return { clusterId, kindId, kindLabel, namespaces, selected, virtualContext };
}
