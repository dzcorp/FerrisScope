import { logErr } from "./log";
import { useEffect } from "react";
import { api, onMetrics } from "../api";
import { useAppStore } from "../store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { MetricsNeed, MetricsSnapshot } from "../types";

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
export function useMetricsSubscription(clusterId: string | null, need: MetricsNeed) {
  const setMetrics = useAppStore((s) => s.setMetrics);
  useEffect(() => {
    if (!clusterId) return;
    let live = true;
    const held = hold(clusterId, need, () => live, setMetrics);
    return () => {
      live = false;
      void held.then((release) => release());
    };
  }, [clusterId, need, setMetrics]);
}

// N-cluster variant for merged (virtual context) views: one effect that
// holds a metrics subscription per member. Pass an empty array to skip.
// The array's CONTENTS key the effect (not its identity), so callers may
// rebuild the array each render as long as the ids are stable.
export function useMetricsSubscriptions(clusterIds: string[], need: MetricsNeed) {
  const setMetrics = useAppStore((s) => s.setMetrics);
  const key = clusterIds.join(String.fromCharCode(0));
  useEffect(() => {
    const ids = key === "" ? [] : key.split(String.fromCharCode(0));
    if (ids.length === 0) return;
    let live = true;
    const held = ids.map((cid) => hold(cid, need, () => live, setMetrics));
    return () => {
      live = false;
      for (const h of held) void h.then((release) => release());
    };
  }, [key, need, setMetrics]);
}

// Listen, then subscribe; resolves to a release for exactly what was taken.
// The backend counts subscribers, so a consumer gone before its subscribe
// never sends it, and one whose subscribe failed never unsubscribes — an
// unmatched unsubscribe would drop another consumer's hold.
async function hold(
  clusterId: string,
  need: MetricsNeed,
  live: () => boolean,
  setMetrics: (clusterId: string, snap: MetricsSnapshot) => void,
): Promise<() => void> {
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await onMetrics(clusterId, (snap) => {
      if (live()) setMetrics(clusterId, snap);
    });
    if (!live()) return unlisten;
    const initial = await api.subscribeMetrics(clusterId, need);
    if (live() && initial) setMetrics(clusterId, initial);
  } catch {
    // Best-effort: unavailable metrics-server is not a hard error.
    const un = unlisten;
    return () => un?.();
  }
  const un = unlisten;
  return () => {
    un();
    api.unsubscribeMetrics(clusterId, need).catch(logErr("metrics-sub"));
  };
}
