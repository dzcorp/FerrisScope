/// Pure helpers for the aggregated logs surface: expanding observed pods into
/// per-container log sources with short display labels, merging per-stream
/// statuses into the one status the panel chrome shows, and serializing the
/// buffer for the "Download" action. No React in here.

import { shortClusterNames } from "./multiCluster";
import { stripAnsi } from "./ansi";

/// A pod the panel observes — output of `resolve_log_pods` plus the cluster
/// it came from.
export type ObservedPod = {
  clusterId: string;
  namespace: string;
  name: string;
  containers: string[];
};

/// One log stream the view runs: a concrete (cluster, namespace, pod,
/// container) tuple plus its display identity.
export type LogViewSource = {
  /// Stable identity — streams restart when the key set changes.
  key: string;
  clusterId: string;
  namespace: string;
  pod: string;
  container: string;
  /// Short prefix label shown on every line when more than one source is
  /// active ("" possible for a lone source).
  label: string;
  /// Index into the cluster-accent palette (see `theme.clusterAccent`).
  colorIdx: number;
};

/// Mirrors the per-stream status union in `components/log/LogView`. Defined
/// here so the aggregation logic stays pure and testable; LogView re-exports
/// it for the chrome components.
export type LogStatus =
  | { kind: "starting" }
  | { kind: "streaming" }
  | { kind: "waiting"; reason: string }
  | { kind: "ended"; reason: string }
  | { kind: "error"; message: string };

/// Hard cap on concurrent log streams per view. Each source is a follow
/// connection through the apiserver; an unbounded fan-out (DaemonSet on a
/// 500-node cluster) would hammer both the apiserver and the renderer.
export const MAX_LOG_SOURCES = 24;

export function sourceKey(
  clusterId: string,
  namespace: string,
  pod: string,
  container: string,
): string {
  return [clusterId, namespace, pod, container].join("\u0000");
}

/// Expand pods × containers into log sources, capped at `MAX_LOG_SOURCES`.
///
/// Label anatomy (kept minimal — only ambiguity adds segments):
///   pod                          one cluster, unique pod names, 1 container
///   pod/container                pod has several containers
///   ns/pod                       same pod name appears twice
///   cluster pod                  sources span clusters (short cluster names)
export function buildLogSources(
  pods: ObservedPod[],
  clusterNameFor: (clusterId: string) => string,
): { sources: LogViewSource[]; dropped: number } {
  const clusterIds = [...new Set(pods.map((p) => p.clusterId))];
  const multiCluster = clusterIds.length > 1;
  const clusterShorts = multiCluster
    ? shortClusterNames(clusterIds.map(clusterNameFor))
    : {};

  // Compress pod names the same way table cells compress cluster names —
  // pods of one workload share a long generated prefix that carries no
  // information inside this view. Falls back to full names on collision.
  const podShorts = shortClusterNames([...new Set(pods.map((p) => p.name))]);

  // A short pod name must stay unique across (cluster, namespace); when it
  // doesn't, prepend the namespace.
  const nameCount = new Map<string, number>();
  for (const p of pods) {
    const short = podShorts[p.name] ?? p.name;
    const scoped = `${p.clusterId}\u0000${short}`;
    nameCount.set(scoped, (nameCount.get(scoped) ?? 0) + 1);
  }

  const sources: LogViewSource[] = [];
  let dropped = 0;
  for (const p of pods) {
    const short = podShorts[p.name] ?? p.name;
    const ambiguous =
      (nameCount.get(`${p.clusterId}\u0000${short}`) ?? 0) > 1;
    const podLabel = ambiguous ? `${p.namespace}/${short}` : short;
    const clusterPrefix = multiCluster
      ? `${clusterShorts[clusterNameFor(p.clusterId)] ?? clusterNameFor(p.clusterId)} `
      : "";
    for (const container of p.containers) {
      if (sources.length >= MAX_LOG_SOURCES) {
        dropped += 1;
        continue;
      }
      const label =
        p.containers.length > 1
          ? `${clusterPrefix}${podLabel}/${container}`
          : `${clusterPrefix}${podLabel}`;
      sources.push({
        key: sourceKey(p.clusterId, p.namespace, p.name, container),
        clusterId: p.clusterId,
        namespace: p.namespace,
        pod: p.name,
        container,
        label,
        colorIdx: sources.length,
      });
    }
  }
  return { sources, dropped };
}

/// Merge per-stream statuses into the single status the chrome shows.
/// Liveness wins: as long as anything streams (or might), the view is live;
/// failures only take over once nothing is producing.
export function aggregateLogStatus(statuses: LogStatus[]): LogStatus {
  if (statuses.length === 0) return { kind: "starting" };
  if (statuses.length === 1) return statuses[0]!;
  if (statuses.some((s) => s.kind === "streaming")) return { kind: "streaming" };
  const waiting = statuses.find((s) => s.kind === "waiting");
  if (waiting) return waiting;
  if (statuses.some((s) => s.kind === "starting")) return { kind: "starting" };
  const errors = statuses.filter(
    (s): s is Extract<LogStatus, { kind: "error" }> => s.kind === "error",
  );
  if (errors.length === statuses.length) {
    return {
      kind: "error",
      message:
        errors.length === 1
          ? errors[0]!.message
          : `all ${errors.length} streams failed — ${errors[0]!.message}`,
    };
  }
  if (errors.length > 0) {
    return {
      kind: "ended",
      reason: `${statuses.length - errors.length} stream(s) ended, ${errors.length} failed`,
    };
  }
  return { kind: "ended", reason: "all streams ended" };
}

/// What `formatLogExport` needs of a buffered line. Matches LogView's
/// `LineEntry` structurally so the ring contents pass straight through.
export type ExportableLine = {
  text: string;
  ts: string | null;
  system: boolean;
  /// Index into the sources array; -1 for lines that predate a source
  /// (defensive — shouldn't happen).
  src: number;
};

/// Serialize the visible buffer to one plain-text document. ANSI escapes are
/// stripped; the source label is included whenever more than one source is
/// active so an aggregated download stays attributable.
export function formatLogExport(
  lines: ExportableLine[],
  sources: LogViewSource[],
): string {
  const multi = sources.length > 1;
  const out: string[] = [];
  for (const l of lines) {
    const parts: string[] = [];
    if (l.ts) parts.push(l.ts);
    if (multi && !l.system) {
      const label = sources[l.src]?.label;
      if (label) parts.push(`[${label}]`);
    }
    parts.push(l.system ? l.text : stripAnsi(l.text));
    out.push(parts.join(" "));
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

/// Default filename for the Download save dialog. `now` is injected so tests
/// stay deterministic.
export function suggestedLogFileName(
  sources: LogViewSource[],
  now: Date,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (sources.length === 1) {
    const s = sources[0]!;
    return `${s.pod}-${s.container}-${stamp}.log`;
  }
  const podCount = new Set(sources.map((s) => `${s.namespace}/${s.pod}`)).size;
  return `logs-${podCount}-pods-${stamp}.log`;
}
