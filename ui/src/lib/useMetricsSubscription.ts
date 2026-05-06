import { useEffect } from "react";
import { api, onMetrics } from "../api";
import { useAppStore } from "../store";

// Subscribe to cluster metrics for `clusterId` for the lifetime of the
// component that calls this hook. The backend refcounts subscribers so
// multiple components calling this for the same cluster share one polling
// task; when the last consumer unmounts, polling stops (Drop on the
// MetricsService aborts its task). The first poll is itself delayed
// server-side (see `INITIAL_POLL_DELAY` in core/src/metrics.rs) so it can't
// race the user-clicked watcher's LIST on a freshly-connected cluster.
//
// This is a *replacement* for the old eager subscription that App.tsx held
// on every cluster connect — that hit metrics-server + kubelet stats
// regardless of whether anything in the UI consumed them, and visibly
// delayed Pods LISTs on clusters that had the observability stack
// installed. Today only views that need metrics (cluster gauges, Pods
// CPU/Mem cells, the per-pod/PVC MetricsTab) pay the cost.
//
// Pass `clusterId = null` to skip the subscription (e.g. when the consuming
// view is rendered without an active cluster). The hook will tear down a
// prior subscription cleanly across cluster switches.
export function useMetricsSubscription(clusterId: string | null) {
  const setMetrics = useAppStore((s) => s.setMetrics);
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await onMetrics(clusterId, (snap) => {
          if (!cancelled) setMetrics(snap);
        });
        const initial = await api.subscribeMetrics(clusterId);
        if (!cancelled && initial) setMetrics(initial);
      } catch {
        // Best-effort: unavailable metrics-server is not a hard error.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      api.unsubscribeMetrics(clusterId).catch(() => {});
    };
  }, [clusterId, setMetrics]);
}
