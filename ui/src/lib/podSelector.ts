// Client-side label-selector matching for pod deltas.
//
// The backend does the authoritative selection server-side; this only decides
// whether a *live delta* off the pods watcher belongs to the workload being
// viewed. Pod labels ride the bus already (the watcher injects `__labels`), so
// no extra payload is needed for the join.

import type { LabelSelectorSummary, ResourceRow } from "../types";

/// Every `match_labels` pair must be present and equal on the pod. An absent
/// or wholly empty selector matches *nothing* — over-matching a namespace is
/// worse than showing an empty list.
export function matchesLabelSelector(
  labels: Record<string, string> | undefined,
  selector: LabelSelectorSummary | null,
): boolean {
  if (!selector) return false;
  const pairs = selector.match_labels;
  if (pairs.length === 0) return false;
  if (!labels) return false;
  return pairs.every(([k, v]) => labels[k] === v);
}

/// `LabelSelectorSummary` carries `match_expressions` as a *count*, not the
/// expressions themselves, so a selector using them can't be evaluated here.
/// Callers must then trust only the server-fetched list and refuse to admit
/// unknown pods from the delta stream.
export function selectorIsClientEvaluable(
  selector: LabelSelectorSummary | null,
): boolean {
  return !!selector && selector.match_expressions === 0;
}

/// Whether a pod delta should be folded into a workload's pod list.
///
/// `namespace` is load-bearing, not decoration: the delta stream is
/// CLUSTER-WIDE while the server-side list is namespaced, so matching on
/// labels alone would pull in a same-labelled pod from another namespace —
/// `app=web` in both `staging` and `production` is the common case, and
/// workload panels hide the namespace column, so the operator couldn't see it.
///
/// `known` is the set of uids the server-fetched list already vouched for.
/// When the selector uses `matchExpressions` we can only confirm updates to
/// pods we were told about — admitting a new pod on `matchLabels` alone could
/// pull in one the expressions exclude.
export function acceptsPodDelta(
  row: ResourceRow,
  namespace: string | null,
  selector: LabelSelectorSummary | null,
  known: ReadonlySet<string>,
): boolean {
  if (namespace !== null && row.namespace !== namespace) return false;
  // A missing selector is not the same as one we merely can't evaluate. The
  // branch below trusts the server-fetched list for `matchExpressions`, but
  // with no selector there was no selection to trust — `matchesLabelSelector`
  // already answers `false` here, so accepting known pods would contradict it.
  if (!selector) return false;
  if (known.has(row.uid)) {
    return selectorIsClientEvaluable(selector)
      ? matchesLabelSelector(row.__labels, selector)
      : true;
  }
  if (!selectorIsClientEvaluable(selector)) return false;
  return matchesLabelSelector(row.__labels, selector);
}
