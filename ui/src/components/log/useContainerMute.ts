import { useCallback, useEffect, useRef, useState } from "react";
import { initOnlyContainerNames, type ObservedPod } from "../../lib/logSources";

// Mute state for an aggregated log view, shared by the slide-in `LogPanel` and
// the workload detail tab.
//
// Init containers start muted. They've already terminated, so their log is a
// fixed dump rather than a stream, and letting them compete for the
// `MAX_LOG_SOURCES` budget means a rollout with a migration step can push every
// live container out of the view. It's a default, not a rule — the toolbar
// un-mutes them like any other container.
//
// Seeding is per-name and once-only: a name that has been seeded is never
// re-added, so an operator's un-mute survives the pod deltas that arrive as a
// workload scales or rolls. Names are only ever *added* to the seeded set, so a
// container that disappears and comes back doesn't silently re-mute either.
export function useContainerMute(pods: ObservedPod[]): {
  excluded: ReadonlySet<string>;
  toggle: (name: string) => void;
} {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const seeded = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh = initOnlyContainerNames(pods).filter(
      (n) => !seeded.current.has(n),
    );
    if (fresh.length === 0) return;
    for (const n of fresh) seeded.current.add(n);
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const n of fresh) next.add(n);
      return next;
    });
  }, [pods]);

  const toggle = useCallback((name: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return { excluded, toggle };
}
