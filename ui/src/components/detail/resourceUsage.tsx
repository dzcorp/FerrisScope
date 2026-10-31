import { useEffect, useState } from "react";
import { api } from "../../api";
import { useAppStore } from "../../store";
import { usageColor, type Tokens } from "../../theme";
import type { ContainerMetric, PodResourceTotals } from "../../types";
import { Section } from "../ui";
import { formatQuantity, parseQuantity } from "./helpers";
import { DetailRow, SubGrid, type SubEntry, type SubGroup } from "./primitives";

/// metrics-server reading: millicores / MiB.
export type Usage = { cpu_milli: number; mem_mib: number };

const MIB = 1024 * 1024;

/// Requests / Limits rows with live usage folded into the cpu and memory
/// entries, tinted against the value they sit on. The amount is spelled out
/// once, on the first row that can judge it; later rows give only the share.
export function resourceGroups(
  t: Tokens,
  requests: Record<string, string> | null,
  limits: Record<string, string> | null,
  usage: Usage | null,
): SubGroup[] {
  // `scale` turns a parsed quantity (cores / bytes) into the usage unit.
  const used: Record<string, { n: number; text: string; scale: number }> = usage
    ? {
        cpu: {
          n: usage.cpu_milli,
          text: formatQuantity("cpu", `${usage.cpu_milli}m`),
          scale: 1000,
        },
        memory: {
          n: usage.mem_mib,
          text: formatQuantity("memory", `${usage.mem_mib}Mi`),
          scale: 1 / MIB,
        },
      }
    : {};
  const amountShown = new Set<string>();
  const entry = (k: string, v: string): SubEntry => {
    const u = used[k];
    const basis = u ? (parseQuantity(v) ?? 0) * u.scale : 0;
    if (!u || !(basis > 0)) return { key: k, value: formatQuantity(k, v) };
    const pct = `${Math.round((u.n / basis) * 100)}%`;
    const note = amountShown.has(k) ? `${pct} used` : `${u.text} used (${pct})`;
    amountShown.add(k);
    return {
      key: k,
      value: formatQuantity(k, v),
      children: (
        <span style={{ color: usageColor(u.n, basis, t) }}>
          <span style={{ color: t.textMuted }}>·</span> {note}
        </span>
      ),
    };
  };
  const group = (label: string, m: Record<string, string> | null): SubGroup[] =>
    m && Object.keys(m).length > 0
      ? [{ label, entries: Object.entries(m).map(([k, v]) => entry(k, v)) }]
      : [];
  return [...group("Requests", requests), ...group("Limits", limits)];
}

// Container cards of one pod ask together on each snapshot; they share the
// read in flight.
const inflight = new Map<string, { stamp: number; p: Promise<ContainerMetric[]> }>();

function podContainers(
  clusterId: string,
  namespace: string,
  pod: string,
  stamp: number,
): Promise<ContainerMetric[]> {
  const key = `${clusterId}\0${namespace}/${pod}`;
  const hit = inflight.get(key);
  if (hit && hit.stamp === stamp) return hit.p;
  const p = api.podContainerMetrics(clusterId, namespace, pod).finally(() => {
    if (inflight.get(key)?.p === p) inflight.delete(key);
  });
  inflight.set(key, { stamp, p });
  return p;
}

/// Live usage of one container, refreshed with each metrics snapshot. Reads
/// the cluster's running `pods` subscription; it doesn't start one.
export function useContainerUsage(
  clusterId: string,
  namespace: string | null,
  pod: string,
  container: string,
): Usage | null {
  const stamp = useAppStore((s) => s.metricsByCluster[clusterId]?.fetched_at_unix_ms ?? null);
  const id = `${clusterId}\0${namespace ?? ""}/${pod}\0${container}`;
  // Tagged with what it was read for, so another pod never shows it.
  const [state, setState] = useState<{ id: string; usage: Usage | null } | null>(null);
  useEffect(() => {
    if (stamp == null || namespace == null) return;
    let live = true;
    podContainers(clusterId, namespace, pod, stamp)
      .then((cs) => {
        if (!live) return;
        const c = cs.find((x) => x.name === container);
        setState((prev) =>
          prev?.id === id &&
          prev.usage?.cpu_milli === c?.cpu_milli &&
          prev.usage?.mem_mib === c?.mem_mib
            ? prev
            : { id, usage: c ? { cpu_milli: c.cpu_milli, mem_mib: c.mem_mib } : null },
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [clusterId, namespace, pod, container, stamp, id]);
  // No snapshot (metrics cleared) means no reading, not the last one.
  return stamp != null && state?.id === id ? state.usage : null;
}

// Its own component so the metrics tick re-renders only this section.
export function PodResources({
  t,
  totals,
  clusterId,
  namespace,
  name,
}: {
  t: Tokens;
  totals: PodResourceTotals;
  clusterId: string;
  namespace: string | null;
  name: string;
}) {
  const key = `${namespace ?? ""}/${name}`;
  const cpu = useAppStore((s) => s.metricsByCluster[clusterId]?.pods[key]?.cpu_milli ?? null);
  const mem = useAppStore((s) => s.metricsByCluster[clusterId]?.pods[key]?.mem_mib ?? null);
  const groups = resourceGroups(
    t,
    totals.requests,
    totals.limits,
    cpu != null && mem != null ? { cpu_milli: cpu, mem_mib: mem } : null,
  );
  if (groups.length === 0) return null;
  return (
    <>
      <Section t={t} title="Resources" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Sum of containers">
          <SubGrid t={t} groups={groups} />
        </DetailRow>
      </div>
    </>
  );
}
