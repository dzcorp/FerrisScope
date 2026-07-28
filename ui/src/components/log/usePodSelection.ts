import { useEffect, useMemo, useRef, useState } from "react";
import type { ObservedPod } from "../../lib/logSources";
import {
  defaultSelection,
  reconcileSelection,
  selectablePods,
  selectionStreamCount,
  type SelectablePod,
} from "../../lib/logSelection";

// Which pods an aggregated log view streams.
//
// Starts as the greedy "as many as fit the budget" default so the panel is
// useful the instant it opens — the rail is an override, not a required step.
// After that the selection belongs to the operator, and pod-set churn only
// reconciles around it: pods that vanish are dropped, and a pod is offered
// automatically exactly once, the first time it appears.
//
// That once-only rule matters. Reconciling by "select anything that fits" would
// mean muting a noisy sidecar — which frees budget — silently resurrects every
// pod the operator had deselected a moment earlier.
export function usePodSelection(
  pods: ObservedPod[],
  excludedContainers: ReadonlySet<string>,
): {
  rows: SelectablePod[];
  selected: ReadonlySet<string>;
  setSelected: (next: ReadonlySet<string>) => void;
  streamCount: number;
} {
  const rows = useMemo(
    () => selectablePods(pods, excludedContainers),
    [pods, excludedContainers],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Every pod key this view has ever shown. Drives the "offer it once" rule
  // above; a pod that is deleted and recreated leaves the set and so counts as
  // new again, which is the behaviour you want after a rollout.
  const known = useRef<Set<string>>(new Set());
  // The first resolve arrives asynchronously, so "have we seeded yet" can't be
  // inferred from an empty selection — an empty selection is a valid choice.
  const seeded = useRef(false);

  useEffect(() => {
    if (rows.length === 0) return;
    const fresh = new Set<string>();
    for (const r of rows) if (!known.current.has(r.key)) fresh.add(r.key);
    const live = new Set(rows.map((r) => r.key));
    for (const k of known.current) if (!live.has(k)) known.current.delete(k);
    for (const k of fresh) known.current.add(k);

    if (!seeded.current) {
      seeded.current = true;
      setSelected(defaultSelection(rows));
      return;
    }
    if (fresh.size === 0) {
      // Still reconcile: pods may have gone away even when none arrived.
      setSelected((prev) => reconcileSelection(rows, prev, EMPTY));
      return;
    }
    setSelected((prev) => reconcileSelection(rows, prev, fresh));
  }, [rows]);

  return {
    rows,
    selected,
    setSelected,
    streamCount: selectionStreamCount(rows, selected),
  };
}

const EMPTY: ReadonlySet<string> = new Set();
