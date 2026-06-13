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

import type {
  ClusterProbe,
  ResourceDelta,
  ResourceRow,
  SubscribeResult,
} from "../types";

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

/// Fleet info for a virtual context, aggregated across its members so the
/// fleet card can render the same anatomy as a single-cluster card (load
/// gauges, node/pod counts, health dot) in every fleet view style.
export type VirtualContextAggregate = {
  /// Members no longer present in any kubeconfig source.
  missing: number;
  /// Members whose last probe explicitly failed.
  unreachable: number;
  /// Σ nodes across members reporting a count; null when none have data.
  nodes: number | null;
  /// Σ pods across members reporting a count; null when none have data.
  pods: number | null;
  /// Σ used / Σ capacity across members reporting BOTH sides; null when
  /// none do. Per-member partial data (used without capacity) is excluded
  /// so one lopsided probe can't skew the fleet-wide ratio.
  cpuRatio: number | null;
  /// Same contract as `cpuRatio` for memory.
  memRatio: number | null;
  /// Mirrors the single-card dot semantics: any missing or unreachable
  /// member → "bad"; every present member probed healthy → "good";
  /// otherwise "unknown" (mixed unknowns / not yet probed).
  health: "good" | "bad" | "unknown";
};

export function aggregateVirtualContext(
  members: string[],
  knownContextIds: ReadonlySet<string>,
  probes: Record<string, ClusterProbe>,
): VirtualContextAggregate {
  let missing = 0;
  let unreachable = 0;
  let present = 0;
  let probedHealthy = 0;
  let nodes: number | null = null;
  let pods: number | null = null;
  let cpuUsed = 0;
  let cpuCap = 0;
  let memUsed = 0;
  let memCap = 0;
  for (const id of members) {
    if (!knownContextIds.has(id)) {
      // A stale probe for a member that left the kubeconfig must not keep
      // contributing numbers — skip it entirely.
      missing++;
      continue;
    }
    present++;
    const p = probes[id];
    if (!p) continue;
    if (p.healthy === false) unreachable++;
    if (p.healthy === true) probedHealthy++;
    if (p.nodes != null) nodes = (nodes ?? 0) + p.nodes;
    if (p.pods != null) pods = (pods ?? 0) + p.pods;
    if (
      p.cpu_used_milli != null &&
      p.cpu_capacity_milli != null &&
      p.cpu_capacity_milli > 0
    ) {
      cpuUsed += p.cpu_used_milli;
      cpuCap += p.cpu_capacity_milli;
    }
    if (
      p.mem_used_mib != null &&
      p.mem_capacity_mib != null &&
      p.mem_capacity_mib > 0
    ) {
      memUsed += p.mem_used_mib;
      memCap += p.mem_capacity_mib;
    }
  }
  const health =
    missing > 0 || unreachable > 0
      ? "bad"
      : present > 0 && probedHealthy === present
        ? "good"
        : "unknown";
  return {
    missing,
    unreachable,
    nodes,
    pods,
    cpuRatio: cpuCap > 0 ? cpuUsed / cpuCap : null,
    memRatio: memCap > 0 ? memUsed / memCap : null,
    health,
  };
}

/// Word-ish boundaries cluster names are tokenized on. Covers kebab/snake
/// conventions plus the `_`/`/`-heavy GKE and EKS context-name formats.
const NAME_TOKEN_SEP = /[-_./:\s]+/;

/// Compact display names for a set of member clusters: strips the token
/// prefix and suffix common to ALL names so siblings like
/// `myproject-mystage-prod-07` / `myproject-mystage-prod-08` render as
/// `07` / `08` in tight surfaces (table cells, namespace labels). Keyed by
/// the full name. Guarantees:
/// - every name keeps at least one token (a name that is a token-prefix of
///   a sibling never compresses to "");
/// - results stay unique — on a collision (e.g. `a-b` vs `a_b` tokenize
///   identically) the colliding names fall back to their full form;
/// - a single name (or empty input) is returned untouched — compression
///   only makes sense against siblings.
export function shortClusterNames(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) out[n] = n;
  if (names.length < 2) return out;

  const tokens = names.map((n) => n.split(NAME_TOKEN_SEP).filter(Boolean));
  if (tokens.some((t) => t.length === 0)) return out;
  const minLen = Math.min(...tokens.map((t) => t.length));

  // Greedy common prefix, capped so the shortest name keeps ≥1 token.
  let prefix = 0;
  while (
    prefix < minLen - 1 &&
    tokens.every((t) => t[prefix] === tokens[0]![prefix])
  ) {
    prefix++;
  }
  // Common suffix out of the remaining budget.
  let suffix = 0;
  while (
    prefix + suffix < minLen - 1 &&
    tokens.every(
      (t) => t[t.length - 1 - suffix] === tokens[0]![tokens[0]!.length - 1 - suffix],
    )
  ) {
    suffix++;
  }
  if (prefix === 0 && suffix === 0) return out;

  const shorts = tokens.map((t) => t.slice(prefix, t.length - suffix).join("-"));
  // Uniqueness check: identical inputs or separator-only differences can
  // collapse to the same short — those keep their full names.
  const counts = new Map<string, number>();
  for (const s of shorts) counts.set(s, (counts.get(s) ?? 0) + 1);
  names.forEach((n, i) => {
    const s = shorts[i]!;
    if (s.length > 0 && counts.get(s) === 1) out[n] = s;
  });
  return out;
}

/// Per-namespace origin labels for the namespace modal in multi-cluster
/// views. A namespace present on EVERY reporting member needs no label —
/// only the ones that exist on a subset get tagged with the (compressed)
/// names of the members that have them. Members that reported no
/// namespaces at all (down, or namespaces listing forbidden) are excluded
/// from the "present everywhere" comparison so one dead cluster doesn't
/// flag every namespace as partial.
export function namespaceClusterTags(
  nsClusters: Record<string, string[]>,
  members: { id: string; name: string }[],
): Record<string, { clusterId: string; label: string }[]> {
  if (members.length < 2) return {};
  const memberIds = new Set(members.map((m) => m.id));
  const reporting = new Set<string>();
  for (const cids of Object.values(nsClusters)) {
    for (const cid of cids) if (memberIds.has(cid)) reporting.add(cid);
  }
  if (reporting.size < 2) return {};
  const shorts = shortClusterNames(members.map((m) => m.name));
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const out: Record<string, { clusterId: string; label: string }[]> = {};
  for (const [ns, cids] of Object.entries(nsClusters)) {
    const present = [...new Set(cids.filter((cid) => reporting.has(cid)))];
    if (present.length === 0 || present.length >= reporting.size) continue;
    out[ns] = present.sort().map((cid) => {
      const full = nameOf.get(cid);
      return { clusterId: cid, label: (full && shorts[full]) ?? full ?? cid };
    });
  }
  return out;
}

/// Pregenerated name for a virtual context the operator didn't bother to
/// name: "a + b" for two members, "a +N" beyond — same shape as the ad-hoc
/// view title. Member names are compressed first with the same
/// `shortClusterNames` logic the table and namespace labels use, so
/// sibling clusters like `myproject-prod-07` / `-08` generate "07 + 08"
/// instead of two full names glued together. Deduped against existing
/// names (case-insensitive) with a " (2)", " (3)"… suffix so saving twice
/// never trips the duplicate guard.
export function defaultVirtualContextName(
  memberNames: string[],
  takenNames: string[],
): string {
  const shorts = shortClusterNames(memberNames);
  const display = memberNames.map((n) => shorts[n] ?? n);
  const first = display[0] ?? "virtual context";
  const base =
    display.length === 2
      ? `${first} + ${display[1]}`
      : display.length > 2
        ? `${first} +${display.length - 1}`
        : first;
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
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
