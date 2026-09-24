import type { ScopedRow } from "./multiCluster";

type RowsRef = { current: Map<string, ScopedRow> };

// Each tab's mounted table publishes its live row map (by scoped uid) so a
// detail drawer, which no longer renders inside the table, can seed its row.
const registry = new Map<string, RowsRef>();

const keyOf = (tabId: string | null) => tabId ?? "";

export function publishRows(tabId: string | null, ref: RowsRef): () => void {
  registry.set(keyOf(tabId), ref);
  return () => {
    if (registry.get(keyOf(tabId)) === ref) registry.delete(keyOf(tabId));
  };
}

export function lookupRow(tabId: string | null, sid: string): ScopedRow | null {
  return registry.get(keyOf(tabId))?.current.get(sid) ?? null;
}
