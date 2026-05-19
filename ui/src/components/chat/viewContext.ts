import { useAppStore } from "../../store";
import type { ChatViewContext } from "../../types";

/// Build a `ChatViewContext` from the current store state, used to brief
/// the assistant on what the operator is looking at when they hit send.
/// Returns `undefined` when there's nothing useful — the backend already
/// skips the prompt block on empty payloads, but skipping the IPC arg
/// entirely keeps the wire neat. The snapshot is taken at call-time
/// (no re-render subscription) and the function is directly unit-testable.
export function snapshotViewContext(): ChatViewContext | undefined {
  const s = useAppStore.getState();
  const clusterId = s.selectedContext ?? undefined;
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
  if (!clusterId && !kindId && !namespaces && !selected) return undefined;
  return { clusterId, kindId, kindLabel, namespaces, selected };
}
