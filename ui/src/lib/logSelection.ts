/// Pure selection logic for the aggregated log view's source rail. No React.
///
/// The rail exists because the stream budget (`MAX_LOG_SOURCES`) is far smaller
/// than what a real selection resolves to — ten Deployments at fifty replicas
/// is 500 pods for 24 slots. Before the rail, `buildLogSources` simply took
/// whichever pods sorted first and reported "+476 over cap", which is an
/// arbitrary answer presented as a complete one. These helpers turn that into a
/// choice the operator makes.

import { MAX_LOG_SOURCES, podKey, type ObservedPod } from "./logSources";

/// One row in the rail.
export type SelectablePod = {
  key: string;
  clusterId: string;
  namespace: string;
  name: string;
  /// Streams this pod would contribute given the current container mute set —
  /// what it actually costs against `MAX_LOG_SOURCES`. Zero when every one of
  /// its containers is muted, which is worth showing rather than hiding.
  streamCount: number;
};

/// Rail rows for a resolved pod set, in the order `buildLogSources` walks them
/// so the rail and the "first N" default agree about what "first" means.
export function selectablePods(
  pods: ObservedPod[],
  excludedContainers: ReadonlySet<string>,
): SelectablePod[] {
  return pods.map((p) => ({
    key: podKey(p.clusterId, p.namespace, p.name),
    clusterId: p.clusterId,
    namespace: p.namespace,
    name: p.name,
    streamCount: p.containers.filter((c) => !excludedContainers.has(c.name))
      .length,
  }));
}

/// The pods a fresh view streams: greedily take pods in order until the next
/// one would not fit whole. Taking a pod's containers *partially* would show
/// one container of a two-container pod with no indication the other was
/// dropped, so a pod that doesn't fit is skipped entirely and the walk
/// continues — a 3-stream pod that doesn't fit shouldn't block the 1-stream
/// pods behind it.
export function defaultSelection(
  pods: SelectablePod[],
  budget: number = MAX_LOG_SOURCES,
): Set<string> {
  const out = new Set<string>();
  let used = 0;
  for (const p of pods) {
    // A fully-muted pod costs nothing; select it so un-muting a container
    // brings it back rather than leaving the operator wondering why.
    if (p.streamCount === 0) {
      out.add(p.key);
      continue;
    }
    if (used + p.streamCount > budget) continue;
    out.add(p.key);
    used += p.streamCount;
  }
  return out;
}

/// Streams the current selection costs. Pods no longer in the set (scaled down
/// while the panel was open) contribute nothing.
export function selectionStreamCount(
  pods: SelectablePod[],
  selected: ReadonlySet<string>,
): number {
  let n = 0;
  for (const p of pods) if (selected.has(p.key)) n += p.streamCount;
  return n;
}

/// Reconcile a selection against a pod set that has changed underneath it.
///
/// Pods that disappeared are dropped. Pods in `fresh` — ones the view has never
/// seen before, i.e. a scale-up or a rollout's new replicas — are selected if
/// they fit in the remaining budget.
///
/// `fresh` is the whole point of the signature. Auto-selecting *any* unselected
/// pod that happens to fit would mean muting a noisy sidecar (which frees
/// budget) silently resurrects every pod the operator had just deselected. A
/// pod is offered exactly once, when it first appears; after that its state is
/// the operator's.
///
/// Returns the same set instance when nothing changed, so React callers can
/// skip the re-render — pod watches fire on every status heartbeat.
export function reconcileSelection(
  pods: SelectablePod[],
  selected: ReadonlySet<string>,
  fresh: ReadonlySet<string>,
  budget: number = MAX_LOG_SOURCES,
): ReadonlySet<string> {
  const live = new Set(pods.map((p) => p.key));
  const kept = new Set<string>();
  for (const k of selected) if (live.has(k)) kept.add(k);
  const dropped = selected.size - kept.size;
  let used = selectionStreamCount(pods, kept);
  let added = 0;
  for (const p of pods) {
    if (kept.has(p.key) || !fresh.has(p.key)) continue;
    if (p.streamCount > 0 && used + p.streamCount > budget) continue;
    kept.add(p.key);
    used += p.streamCount;
    added += 1;
  }
  return dropped === 0 && added === 0 ? selected : kept;
}

/// Case-insensitive substring filter over pod name and namespace. Empty query
/// matches everything.
export function filterPods(
  pods: SelectablePod[],
  query: string,
): SelectablePod[] {
  const q = query.trim().toLowerCase();
  if (q === "") return pods;
  return pods.filter(
    (p) =>
      p.name.toLowerCase().includes(q) || p.namespace.toLowerCase().includes(q),
  );
}
