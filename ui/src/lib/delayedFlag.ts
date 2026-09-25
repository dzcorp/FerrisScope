import { useEffect, useState } from "react";

// Loading hints wait this long so a fast load never flashes one.
export const LOADING_HINT_DELAY_MS = 400;

/// `true` once `active` has stayed true for `afterMs`; resets when it drops.
export function useDelayedFlag(active: boolean, afterMs = LOADING_HINT_DELAY_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!active) return;
    const timer = window.setTimeout(() => setSlow(true), afterMs);
    return () => window.clearTimeout(timer);
  }, [active, afterMs]);
  return slow;
}

/// Counts down a set of parallel initial syncs, calling `onAllDone` once when
/// the last one finishes (immediately if there are none). Repeat or unknown
/// `done` calls are ignored.
export function syncTracker(count: number, onAllDone: () => void) {
  const pending = new Set(Array.from({ length: count }, (_, i) => i));
  if (pending.size === 0) onAllDone();
  return {
    done(i: number) {
      if (pending.delete(i) && pending.size === 0) onAllDone();
    },
  };
}
