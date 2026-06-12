import { useMemo } from "react";
import { useAppStore, useResolvedTheme } from "../../store";
import { FF_MONO, FS_SM, FS_XS, clusterAccent } from "../../theme";
import { BarGauge, EmptyState, LoadingLine } from "../ui";
import { useMetricsSubscriptions } from "../../lib/useMetricsSubscription";
import {
  clusterColorIndexMap,
  shortClusterNames,
} from "../../lib/multiCluster";
import type { ObservedPod } from "../../lib/logSources";
import type { MetricsSnapshot, PodMetric } from "../../types";

// Aggregated live-metrics pane for the logs/metrics panel: one row per
// observed pod (metrics-server snapshot, ~15 s cadence) plus a totals row.
// Works across clusters — each involved cluster gets its own subscription
// and rows carry a cluster chip when more than one is in play. History /
// charts stay in the detail panel's Prometheus-backed Metrics tab; this
// pane is the "what is this set consuming right now" view.

export type PodMetricRow = {
  clusterId: string;
  namespace: string;
  name: string;
  metric: PodMetric | null;
};

/// Join observed pods with the per-cluster snapshots. Pure — exported for
/// tests. Pods missing from a snapshot keep `metric: null` (pod just
/// started, metrics-server lagging, or unavailable on that cluster).
export function joinPodMetrics(
  pods: ObservedPod[],
  snapshots: Record<string, MetricsSnapshot>,
): PodMetricRow[] {
  return pods.map((p) => ({
    clusterId: p.clusterId,
    namespace: p.namespace,
    name: p.name,
    metric: snapshots[p.clusterId]?.pods[`${p.namespace}/${p.name}`] ?? null,
  }));
}

export function formatCpuMilli(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} cores` : `${n}m`;
}

export function formatMemMib(n: number): string {
  // Mirrors the pods-table cell formatting (design/data.jsx fmtMi).
  return n >= 1024 ? `${(n / 1024).toFixed(1)} Gi` : `${n} Mi`;
}

export function MetricsPane({ pods }: { pods: ObservedPod[] }) {
  const t = useResolvedTheme().tokens;
  const clusterIds = useMemo(
    () => [...new Set(pods.map((p) => p.clusterId))].sort(),
    [pods],
  );
  useMetricsSubscriptions(clusterIds);
  const metricsByCluster = useAppStore((s) => s.metricsByCluster);
  const contexts = useAppStore((s) => s.contexts);

  const multiCluster = clusterIds.length > 1;
  const clusterMeta = useMemo(() => {
    const nameFor = (cid: string) =>
      contexts.find((c) => c.id === cid)?.name ?? cid;
    const shorts = shortClusterNames(clusterIds.map(nameFor));
    const colorIdx = clusterColorIndexMap(clusterIds);
    return Object.fromEntries(
      clusterIds.map((cid) => [
        cid,
        {
          name: nameFor(cid),
          short: shorts[nameFor(cid)] ?? nameFor(cid),
          color: clusterAccent(colorIdx[cid] ?? 0),
        },
      ]),
    );
  }, [clusterIds, contexts]);

  const rows = useMemo(
    () => joinPodMetrics(pods, metricsByCluster),
    [pods, metricsByCluster],
  );
  // Heaviest consumers first; pods without data trail, sorted by name so
  // the order is stable while metrics trickle in.
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const av = a.metric?.cpu_milli ?? -1;
        const bv = b.metric?.cpu_milli ?? -1;
        if (av !== bv) return bv - av;
        return a.name.localeCompare(b.name);
      }),
    [rows],
  );

  const withData = rows.filter((r) => r.metric != null);
  const totalCpu = withData.reduce((n, r) => n + r.metric!.cpu_milli, 0);
  const totalMem = withData.reduce((n, r) => n + r.metric!.mem_mib, 0);
  const maxCpu = Math.max(1, ...withData.map((r) => r.metric!.cpu_milli));
  const maxMem = Math.max(1, ...withData.map((r) => r.metric!.mem_mib));

  // Clusters whose snapshot says metrics-server isn't there — the rows from
  // them will sit at "—" forever, so say why.
  const unavailable = clusterIds.filter((cid) => {
    const snap = metricsByCluster[cid];
    return snap != null && !snap.available;
  });
  const anySnapshot = clusterIds.some((cid) => metricsByCluster[cid] != null);

  if (pods.length === 0) {
    return (
      <EmptyState
        t={t}
        title="No pods to observe"
        hint="Nothing in the current selection resolved to a pod."
      />
    );
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "14px 22px" }}>
      {unavailable.length > 0 && (
        <div
          style={{
            marginBottom: 10,
            fontSize: FS_SM,
            fontFamily: FF_MONO,
            color: t.warn,
          }}
        >
          metrics-server not detected on{" "}
          {unavailable.map((cid) => clusterMeta[cid]?.name ?? cid).join(", ")}
        </div>
      )}
      {!anySnapshot ? (
        <LoadingLine t={t} label="Waiting for metrics…" />
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 28,
              padding: "4px 0 14px",
              borderBottom: `1px solid ${t.borderSoft}`,
              marginBottom: 10,
            }}
          >
            <TotalStat
              label="Total CPU"
              value={formatCpuMilli(totalCpu)}
              dim={t.textMuted}
              text={t.text}
            />
            <TotalStat
              label="Total memory"
              value={formatMemMib(totalMem)}
              dim={t.textMuted}
              text={t.text}
            />
            <TotalStat
              label="Pods reporting"
              value={`${withData.length}/${rows.length}`}
              dim={t.textMuted}
              text={t.text}
            />
          </div>
          <div role="table" aria-label="Per-pod metrics">
            {sorted.map((r) => {
              const meta = clusterMeta[r.clusterId];
              return (
                <div
                  key={`${r.clusterId} ${r.namespace}/${r.name}`}
                  role="row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: multiCluster
                      ? "minmax(0, 1fr) 110px 150px 150px"
                      : "minmax(0, 1fr) 150px 150px",
                    gap: 12,
                    alignItems: "center",
                    padding: "5px 0",
                    borderBottom: `1px solid ${t.borderSoft}`,
                    fontFamily: FF_MONO,
                    fontSize: FS_SM,
                  }}
                >
                  <span
                    title={`${r.namespace}/${r.name}`}
                    style={{
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.name}
                  </span>
                  {multiCluster && (
                    <span
                      title={meta?.name}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        color: t.textDim,
                        fontSize: FS_XS,
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: meta?.color ?? t.textMuted,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {meta?.short ?? r.clusterId}
                      </span>
                    </span>
                  )}
                  <MetricCell
                    value={r.metric ? formatCpuMilli(r.metric.cpu_milli) : null}
                    ratio={r.metric ? r.metric.cpu_milli / maxCpu : 0}
                    accent={t.accent}
                    track={t.borderSoft}
                    dim={t.textMuted}
                    text={t.textDim}
                  />
                  <MetricCell
                    value={r.metric ? formatMemMib(r.metric.mem_mib) : null}
                    ratio={r.metric ? r.metric.mem_mib / maxMem : 0}
                    accent={t.accent}
                    track={t.borderSoft}
                    dim={t.textMuted}
                    text={t.textDim}
                  />
                </div>
              );
            })}
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              color: t.textMuted,
            }}
          >
            metrics-server snapshot · refreshes ~15 s · per-pod history lives
            in the pod detail's Metrics tab
          </div>
        </>
      )}
    </div>
  );
}

function TotalStat({
  label,
  value,
  dim,
  text,
}: {
  label: string;
  value: string;
  dim: string;
  text: string;
}) {
  return (
    <div style={{ fontFamily: FF_MONO }}>
      <div
        style={{
          fontSize: FS_XS,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          color: dim,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: FS_SM, fontWeight: 600, color: text }}>
        {value}
      </div>
    </div>
  );
}

function MetricCell({
  value,
  ratio,
  accent,
  track,
  dim,
  text,
}: {
  value: string | null;
  ratio: number;
  accent: string;
  track: string;
  dim: string;
  text: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        justifyContent: "flex-end",
        fontVariantNumeric: "tabular-nums",
        color: value == null ? dim : text,
      }}
    >
      <span>{value ?? "—"}</span>
      <BarGauge
        value={Math.max(0, Math.min(1, ratio))}
        color={accent}
        track={track}
        width={48}
        height={4}
      />
    </span>
  );
}
