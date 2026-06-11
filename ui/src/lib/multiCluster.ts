// Pure helpers for multi-cluster (virtual context) views. No React — every
// function here is unit-testable in isolation and shared between the
// ResourceTable fan-out subscription, the store's bulk-action builders, and
// the command palette's cross-cluster search merge.
//
// Row identity: a Kubernetes uid is unique within one cluster but not across
// clusters (the same object synced by GitOps to two clusters can even carry
// different uids — but two *different* objects can collide too once we merge).
// Every merged row therefore gets a scoped id `${clusterId}::${uid}` and
// carries its origin cluster in `__clusterId`.

import type { ResourceDelta, ResourceRow, SubscribeResult } from "../types";

/// A resource row tagged with its origin cluster. `__sid` is the scoped uid
/// (`${clusterId}::${uid}`) used as the table row id and selection key; the
/// `__`-prefix keeps the synthetic fields from colliding with projected
/// column ids (backend column ids never start with an underscore).
export type ScopedRow = ResourceRow & {
  __clusterId: string;
  __sid: string;
};

export function scopedUid(clusterId: string, uid: string): string {
  return `${clusterId}::${uid}`;
}

/// Inverse of `scopedUid`. Cluster ids themselves contain `::`
/// (`"<source_id>::<context_name>"`), so split on the LAST occurrence —
/// Kubernetes uids (and the synthetic uids of helm rows) never contain `::`.
export function parseScopedUid(sid: string): {
  clusterId: string;
  uid: string;
} {
  const i = sid.lastIndexOf("::");
  if (i < 0) return { clusterId: "", uid: sid };
  return { clusterId: sid.slice(0, i), uid: sid.slice(i + 2) };
}

/// Tag a backend row with its origin cluster. Idempotent for already-scoped
/// rows from the same cluster.
export function scopeRow(clusterId: string, row: ResourceRow): ScopedRow {
  return {
    ...row,
    __clusterId: clusterId,
    __sid: scopedUid(clusterId, row.uid),
  };
}

/// Apply one delta from `clusterId`'s watcher to a scoped row map.
/// Returns true when the map changed (callers schedule a re-render flush);
/// `init_done` never mutates the map.
export function applyScopedDelta(
  map: Map<string, ScopedRow>,
  clusterId: string,
  delta: ResourceDelta,
): boolean {
  if (delta.kind === "upsert") {
    const scoped = scopeRow(clusterId, delta.row);
    map.set(scoped.__sid, scoped);
    return true;
  }
  if (delta.kind === "delete") {
    return map.delete(scopedUid(clusterId, delta.uid));
  }
  return false;
}

/// Merge per-cluster snapshots under any deltas already landed in `existing`
/// (deltas win — they're newer than the snapshot LIST). Mirrors the
/// single-cluster merge in ResourceTable's subscribe effect. Snapshots can't
/// double-count within a cluster (one namespace owns each object) and can't
/// collide across clusters (keys are scoped).
export function mergeScopedSnapshots(
  results: { clusterId: string; rows: ResourceRow[] }[],
  existing: Map<string, ScopedRow>,
): Map<string, ScopedRow> {
  const merged = new Map<string, ScopedRow>();
  for (const result of results) {
    for (const row of result.rows) {
      const scoped = scopeRow(result.clusterId, row);
      merged.set(scoped.__sid, scoped);
    }
  }
  for (const [sid, row] of existing) merged.set(sid, row);
  return merged;
}

/// Ready-flip heuristic for a fan of per-cluster subscriptions: ready when
/// every reachable cluster finished its initial sync, or any rows are
/// already visible (matching the single-cluster "first row drops the
/// spinner" behaviour).
export function allScopesInitDone(
  results: { result: SubscribeResult }[],
): boolean {
  return results.every((r) => r.result.init_done);
}

/// Stable color assignment: each member's accent index is its position in
/// the SORTED member list, so colors don't depend on selection order or on
/// which members happen to be reachable. Wraps past the accent list length
/// at render time (see `clusterAccent`).
export function clusterColorIndexMap(members: string[]): Record<string, number> {
  const sorted = [...members].sort();
  const out: Record<string, number> = {};
  sorted.forEach((id, i) => {
    out[id] = i;
  });
  return out;
}

/// Merge per-cluster full-text search results into one relevance-ordered
/// list. Backend scores are FTS5 bm25 — LOWER is more relevant — and the
/// scale is comparable across indexes, so a plain global sort works.
export function mergeSearchHits<H extends { score: number }>(
  results: { clusterId: string; hits: H[] }[],
  limit: number,
): { clusterId: string; hit: H }[] {
  return results
    .flatMap((r) => r.hits.map((hit) => ({ clusterId: r.clusterId, hit })))
    .sort((a, b) => a.hit.score - b.hit.score)
    .slice(0, limit);
}

/// Failure-line prefix for bulk actions: "[cluster] " only when the
/// selection actually spans more than one cluster, so single-cluster output
/// stays exactly as it always was.
export function bulkClusterPrefix<T extends { clusterId: string }>(
  entries: [string, T][],
  labelFor: (clusterId: string) => string,
): (m: T) => string {
  const distinct = new Set(entries.map(([, m]) => m.clusterId));
  return distinct.size > 1 ? (m) => `[${labelFor(m.clusterId)}] ` : () => "";
}

/// Group selection-style entries by their origin cluster, preserving entry
/// order within each group. Used by bulk-action builders to fan one
/// user-visible action out into per-cluster API calls.
export function groupByCluster<T extends { clusterId: string }>(
  entries: [string, T][],
): Map<string, [string, T][]> {
  const out = new Map<string, [string, T][]>();
  for (const entry of entries) {
    const key = entry[1].clusterId;
    const bucket = out.get(key);
    if (bucket) bucket.push(entry);
    else out.set(key, [entry]);
  }
  return out;
}
