import { useEffect, useState } from "react";
import { api, onPrometheusChanged } from "../api";
import { logErr } from "./log";
import { clusterAllocationQuery, parseClusterAllocation, type ClusterAllocation } from "./promql";

const POLL_MS = 30_000;

/// Cluster CPU / memory requests, limits and allocatable from
/// kube-state-metrics. Uses an already-known Prometheus target only: the
/// always-on cluster bar must not trigger discovery. `null` until known or
/// when there is no Prometheus / kube-state-metrics.
export function useClusterAllocation(
  clusterId: string | null,
  enabled: boolean,
): ClusterAllocation | null {
  const [alloc, setAlloc] = useState<ClusterAllocation | null>(null);
  useEffect(() => {
    setAlloc(null);
    if (!enabled || !clusterId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let unlisten: (() => void) | null = null;
    const query = clusterAllocationQuery();
    // Bumped on stop so an answer still in flight can't repopulate.
    let gen = 0;
    let busy = false;
    const poll = async () => {
      const g = gen;
      busy = true;
      try {
        const data = await api.prometheusQueryInstant(clusterId, query);
        if (!cancelled && g === gen) setAlloc(parseClusterAllocation(data));
      } catch {
        if (!cancelled && g === gen) setAlloc(null);
      } finally {
        if (g === gen) busy = false;
      }
    };
    const start = () => {
      if (timer || cancelled) return;
      void poll();
      timer = setInterval(() => {
        if (!busy) void poll();
      }, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      gen++;
      busy = false;
      setAlloc(null);
    };
    onPrometheusChanged((evt) => {
      if (cancelled || evt.cluster_id !== clusterId) return;
      if (evt.entry?.target) start();
      else stop();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(logErr("metrics"));
    api
      .getPrometheusTarget(clusterId)
      .then((e) => {
        if (e?.target) start();
      })
      .catch(logErr("metrics"));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (unlisten) unlisten();
    };
  }, [clusterId, enabled]);
  return alloc;
}
