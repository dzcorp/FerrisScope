import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppStore, useConsoleTokens, useResolvedTheme } from "../store";
import { tokens, FF_MONO, type ThemeMode, FS_LG, FS_SM, FS_XS } from "../theme";
import {
  EmptyState,
  ErrorBlock,
  Eyebrow,
  IconBtn,
  Icons,
  LoadingLine,
  Select,
  StatusPill,
  TabButton,
  Tooltip,
} from "./ui";
import { LogView, type LogStatus, type LogViewState } from "./log/LogView";
import { PreviousLogsBanner } from "./log/PreviousControls";
import { MetricsPane } from "./log/MetricsPane";
import { LogToolbar } from "./log/LogToolbar";
import { streamStatusDetail, streamStatusLabel } from "./log/status";
import { api } from "../api";
import {
  buildLogSources,
  containerUniverse,
  DEFAULT_TAIL_LINES,
  sourceKey,
  type LogViewSource,
  type ObservedPod,
} from "../lib/logSources";
import { applyPodDelta, podKey, pruneAfterInit } from "../lib/logPods";
import { logErr } from "../lib/log";
import type { LogPodTarget } from "../types";

// One requested observation — a pod or a pod-bearing workload on a specific
// cluster. Workloads expand to their pods via `resolve_log_pods`; pod
// targets that already carry their container list skip the round-trip.
export type ObserveTarget = {
  clusterId: string;
  kindId: string;
  namespace: string;
  name: string;
  containers?: string[];
};

export type ObserveTab = "logs" | "metrics";

const KIND_LABELS: Record<string, string> = {
  pods: "Pod",
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
  replicasets: "ReplicaSet",
  jobs: "Job",
};

/// Kinds the logs/metrics panel can observe — pods plus everything
/// `resolve_log_pods` expands. Shared by the bulk bar and row actions.
export const OBSERVABLE_KIND_IDS = new Set(Object.keys(KIND_LABELS));

/// Cap on the targets one panel resolves. A 100+-row bulk selection would
/// otherwise turn into 100+ backend lookups before a single line streams —
/// and the stream fan-out is capped (MAX_LOG_SOURCES) far below that
/// anyway. Overflow is surfaced as a warning, not an error.
export const MAX_OBSERVE_TARGETS = 50;

type ResolveState =
  | { kind: "loading" }
  | { kind: "ready"; pods: ObservedPod[]; warnings: string[] }
  | { kind: "error"; message: string };

// Resolve observe-targets to concrete pods, one backend call per involved
// cluster. Re-runs when the target set changes; `retry` re-runs in place.
// Best-effort across clusters: a cluster that fails outright becomes a
// warning while the others' pods still stream — unless *everything* failed,
// which surfaces as the error state.
export function useObservedPods(targets: ObserveTarget[]): {
  state: ResolveState;
  retry: () => void;
} {
  const [state, setState] = useState<ResolveState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const key = targets
    .map((t) => [t.clusterId, t.kindId, t.namespace, t.name].join("\u0000"))
    .join("\u0001");
  const targetsRef = useRef(targets);
  useLayoutEffect(() => {
    targetsRef.current = targets;
  });
  useEffect(() => {
    const all = targetsRef.current;
    const reqs = all.slice(0, MAX_OBSERVE_TARGETS);
    const skipped = all.length - reqs.length;
    const capWarnings =
      skipped > 0
        ? [
            `selection capped — observing the first ${MAX_OBSERVE_TARGETS} of ${all.length} targets (narrow the selection for the rest)`,
          ]
        : [];
    if (reqs.length === 0) {
      setState({ kind: "ready", pods: [], warnings: [] });
      return;
    }
    // Fast path: a pods-only request with known container lists (the table
    // row already carries them) needs no backend round-trip.
    if (reqs.every((t) => t.kindId === "pods" && t.containers != null)) {
      setState({
        kind: "ready",
        pods: reqs.map((t) => ({
          clusterId: t.clusterId,
          namespace: t.namespace,
          name: t.name,
          containers: t.containers ?? [],
        })),
        warnings: capWarnings,
      });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    // The pod map is mutated by both the one-shot resolve (initial set) and the
    // live workload watches (add/remove as pods scale / roll / recreate). Keyed
    // clusterId\0ns\0name so multi-cluster selections can't collide.
    const podMap = new Map<string, ObservedPod>();
    // Union of pod keys the live watches have confirmed (added, minus removed),
    // used to prune stale one-shot-seeded pods on a watch's `init_done` — see
    // `pruneAfterInit`.
    const watchConfirmed = new Set<string>();
    const warnings: string[] = [...capWarnings];
    const handles: { watchId: string; close: () => void }[] = [];

    const flushReady = () => {
      if (cancelled) return;
      setState({
        kind: "ready",
        pods: [...podMap.values()],
        warnings: [...warnings],
      });
    };

    void (async () => {
      // 1. One-shot resolve for the initial set + per-target warnings (pods and
      // workloads both — `resolveLogPods` expands workloads by selector).
      const byCluster = new Map<string, ObserveTarget[]>();
      for (const t of reqs) {
        const list = byCluster.get(t.clusterId) ?? [];
        list.push(t);
        byCluster.set(t.clusterId, list);
      }
      const entries = [...byCluster.entries()];
      const results = await Promise.allSettled(
        entries.map(([cid, ts]) =>
          api.resolveLogPods(
            cid,
            ts.map(
              (t): LogPodTarget => ({
                kind_id: t.kindId,
                namespace: t.namespace,
                name: t.name,
              }),
            ),
          ),
        ),
      );
      if (cancelled) return;
      const clusterName = (cid: string) =>
        useAppStore.getState().contexts.find((c) => c.id === cid)?.name ?? cid;
      results.forEach((res, i) => {
        const cid = entries[i]![0];
        if (res.status === "fulfilled") {
          for (const p of res.value.pods) {
            podMap.set(podKey(cid, p.namespace, p.name), { clusterId: cid, ...p });
          }
          warnings.push(...res.value.warnings);
        } else {
          warnings.push(`${clusterName(cid)}: ${String(res.reason)}`);
        }
      });
      if (podMap.size === 0 && results.every((r) => r.status === "rejected")) {
        setState({
          kind: "error",
          message: warnings.join("\n") || "pod resolution failed",
        });
        return;
      }
      flushReady();

      // 2. Live pod-set watch per workload target. The watch re-confirms the
      // initial set (idempotent — `applyPodDelta` keys by pod) and then keeps it
      // current. A watch that can't arm (no selector / RBAC) is non-fatal: the
      // one-shot seed already stands, so we just log and carry on.
      for (const t of reqs) {
        if (cancelled) break;
        if (t.kindId === "pods") continue;
        try {
          const handle = await api.watchLogPods(
            t.clusterId,
            { kind_id: t.kindId, namespace: t.namespace, name: t.name },
            (evt) => {
              if (cancelled) return;
              if (evt.kind === "init_done") {
                // Watch's initial list is complete — drop any one-shot-seeded
                // pod it didn't confirm (deleted in the resolve→watch window).
                if (
                  pruneAfterInit(podMap, t.clusterId, t.namespace, watchConfirmed)
                )
                  flushReady();
                return;
              }
              if (evt.kind === "added")
                watchConfirmed.add(
                  podKey(t.clusterId, evt.pod.namespace, evt.pod.name),
                );
              else
                watchConfirmed.delete(
                  podKey(t.clusterId, evt.namespace, evt.name),
                );
              if (applyPodDelta(podMap, t.clusterId, evt)) flushReady();
            },
          );
          if (cancelled) {
            handle.close();
            void api.unwatchLogPods(handle.watchId);
            break;
          }
          handles.push(handle);
        } catch (e) {
          logErr("logs")(e);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const h of handles) {
        h.close();
        void api.unwatchLogPods(h.watchId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, retry };
}

type Props = {
  mode: ThemeMode;
  targets: ObserveTarget[];
  // Optional starting container — only meaningful when the request resolves
  // to exactly one pod (the single-pod surface keeps its container Select).
  defaultContainer?: string | null;
  initialTab?: ObserveTab;
  onClose: () => void;
};

// Logs & metrics panel — slides in from the right (R-09 prefers panels over
// modals). Streams every resolved pod's containers in one aggregated view
// (single pod keeps the per-container Select); the Metrics tab shows the
// live metrics-server snapshot for the same pod set. All streaming +
// virtualization + footer toggles live in the shared `LogView`; this file
// owns the slide-in chrome, target resolution, and the tab strip.
export function LogPanel({
  mode,
  targets,
  defaultContainer,
  initialTab,
  onClose,
}: Props) {
  const t = useResolvedTheme().tokens;
  // Panel chrome (title bar, tabs, Selects) follows the theme; the log body
  // + footer render as a console (dark by default).
  const consoleT = useConsoleTokens();
  const contexts = useAppStore((s) => s.contexts);
  const [tab, setTab] = useState<ObserveTab>(initialTab ?? "logs");
  const { state, retry } = useObservedPods(targets);
  const [container, setContainer] = useState<string | null>(
    defaultContainer ?? null,
  );
  // Show the previously-terminated container instance instead of the live one
  // (crash diagnosis — issue #63). Single-pod only; aggregated views stay live.
  const [previous, setPrevious] = useState(false);
  // First-open fetch tail (200 by default; up to whole history). Folded into
  // the stream key so changing it restarts cleanly.
  const [tailLines, setTailLines] = useState<number | null>(DEFAULT_TAIL_LINES);
  // Containers muted across an aggregated view (noisy sidecars). Excluded from
  // every pod's merged stream; ignored in single-pod mode.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleContainer = useCallback((c: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);
  const [view, setView] = useState<LogViewState>({
    status: { kind: "starting" },
    paused: false,
    bufferedCount: 0,
    lineCount: 0,
  });
  const onStateChange = useCallback((s: LogViewState) => setView(s), []);

  // Esc closes the panel. The LogView find bar's own Esc stops propagation
  // before this fires, so dismissing a search never also closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const clusterNameFor = useCallback(
    (cid: string) => contexts.find((c) => c.id === cid)?.name ?? cid,
    [contexts],
  );

  const singlePod =
    state.kind === "ready" && state.pods.length === 1 ? state.pods[0]! : null;
  const activeContainer = singlePod
    ? container && singlePod.containers.includes(container)
      ? container
      : singlePod.containers[0] ?? null
    : null;

  const built = useMemo((): { sources: LogViewSource[]; dropped: number } => {
    if (state.kind !== "ready") return { sources: [], dropped: 0 };
    if (singlePod) {
      if (!activeContainer) return { sources: [], dropped: 0 };
      return {
        sources: [
          {
            key: sourceKey(
              singlePod.clusterId,
              singlePod.namespace,
              singlePod.name,
              activeContainer,
              previous,
              tailLines,
            ),
            clusterId: singlePod.clusterId,
            namespace: singlePod.namespace,
            pod: singlePod.name,
            container: activeContainer,
            previous,
            tailLines,
            label: "",
            colorIdx: 0,
          },
        ],
        dropped: 0,
      };
    }
    return buildLogSources(state.pods, clusterNameFor, {
      tailLines,
      excludedContainers: excluded,
    });
  }, [state, singlePod, activeContainer, previous, tailLines, excluded, clusterNameFor]);

  // Distinct container names across the aggregated pod set (single-pod uses
  // the container Select instead). Drives the toolbar's mute chips.
  const universe = useMemo(
    () => (singlePod ? [] : containerUniverse(state.kind === "ready" ? state.pods : [])),
    [singlePod, state],
  );

  if (targets.length === 0) return null;

  const kindLabel = KIND_LABELS[targets[0]!.kindId] ?? "Resource";
  const multi = targets.length > 1;
  const eyebrowText = multi
    ? `${targets.length} ${kindLabel}s · aggregated`
    : `${kindLabel} logs & metrics`;
  const title = multi
    ? targets
        .slice(0, 3)
        .map((x) => x.name)
        .join(", ") + (targets.length > 3 ? ` +${targets.length - 3}` : "")
    : targets[0]!.name;
  const warnings = state.kind === "ready" ? state.warnings : [];

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 30,
          animation: "fs-fade-in .18s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: multi ? 860 : 680,
          maxWidth: "94vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 31,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
        }}
      >
        <header
          style={{
            padding: "16px 22px 0",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <Eyebrow t={t}>{eyebrowText}</Eyebrow>
              {!multi && targets[0]!.namespace && (
                <>
                  <span style={{ color: t.textMuted, fontSize: FS_SM }}>·</span>
                  <span
                    style={{
                      fontFamily: FF_MONO,
                      fontSize: FS_SM,
                      color: t.textDim,
                    }}
                  >
                    {targets[0]!.namespace}
                  </span>
                </>
              )}
            </div>
            <div
              style={{
                fontSize: FS_LG,
                fontWeight: 600,
                fontFamily: FF_MONO,
                wordBreak: "break-all",
                lineHeight: 1.3,
                color: t.text,
              }}
            >
              {title}
            </div>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              {tab === "logs" ? (
                state.kind === "ready" && (
                  <LogToolbar
                    t={t}
                    mode={
                      singlePod
                        ? {
                            kind: "single",
                            containers: singlePod.containers,
                            active: activeContainer,
                            onContainer: setContainer,
                            previous,
                            onPrevious: setPrevious,
                          }
                        : {
                            kind: "aggregated",
                            podCount: state.pods.length,
                            streamCount: built.sources.length,
                            dropped: built.dropped,
                            universe,
                            excluded,
                            onToggleContainer: toggleContainer,
                          }
                    }
                    tailLines={tailLines}
                    onTailLines={setTailLines}
                    statusNode={
                      <StreamStatus
                        status={view.status}
                        paused={view.paused}
                        bufferedCount={view.bufferedCount}
                        t={t}
                        mode={mode}
                      />
                    }
                    style={{ width: "100%" }}
                  />
                )
              ) : /* Metrics tab: only the source picker/summary is relevant —
                   previous/tail/status are log-specific. */
              singlePod && singlePod.containers.length > 1 ? (
                <Select
                  t={t}
                  fullWidth={false}
                  value={activeContainer ?? ""}
                  onChange={(v) => setContainer(v)}
                  options={singlePod.containers.map((c) => ({
                    value: c,
                    label: c,
                  }))}
                  style={{
                    fontFamily: FF_MONO,
                    fontSize: FS_SM,
                    height: 26,
                    padding: "3px 28px 3px 8px",
                  }}
                />
              ) : singlePod ? (
                <span
                  style={{
                    fontSize: FS_SM,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  container: {activeContainer ?? "—"}
                </span>
              ) : state.kind === "ready" ? (
                <span
                  style={{
                    fontSize: FS_SM,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  {state.pods.length} pods
                </span>
              ) : null}
            </div>
          </div>
          <IconBtn t={t} title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>

        {warnings.length > 0 && (
          <div
            style={{
              margin: "8px 22px 0",
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              color: t.warn,
              flexShrink: 0,
            }}
          >
            {warnings.slice(0, 4).map((w, i) => (
              <div key={i} style={{ wordBreak: "break-all" }}>
                {w}
              </div>
            ))}
            {warnings.length > 4 && <div>+{warnings.length - 4} more</div>}
          </div>
        )}

        <div
          style={{
            display: "flex",
            borderBottom: `1px solid ${t.borderSoft}`,
            padding: "4px 12px 0",
            flexShrink: 0,
          }}
        >
          <TabButton t={t} active={tab === "logs"} onClick={() => setTab("logs")}>
            Logs
          </TabButton>
          <TabButton
            t={t}
            active={tab === "metrics"}
            onClick={() => setTab("metrics")}
          >
            Metrics
          </TabButton>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: t.surfaceAlt,
          }}
        >
          {state.kind === "loading" ? (
            <LoadingLine t={t} label="Resolving pods…" />
          ) : state.kind === "error" ? (
            <div style={{ padding: 18 }}>
              <ErrorBlock
                t={t}
                message={state.message}
                kindLabel="pods"
                verb="load"
              />
              <button
                type="button"
                onClick={retry}
                style={{
                  marginTop: 10,
                  padding: "4px 12px",
                  border: `1px solid ${t.border}`,
                  borderRadius: 4,
                  background: t.surface,
                  color: t.text,
                  fontFamily: FF_MONO,
                  fontSize: FS_SM,
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
            </div>
          ) : state.pods.length === 0 ? (
            <EmptyState
              t={t}
              title="No pods to observe"
              hint={
                warnings.length > 0
                  ? "Nothing in the selection resolved to a pod — see the notes above."
                  : "Nothing in the selection resolved to a pod."
              }
            />
          ) : tab === "logs" ? (
            <>
              {singlePod && previous && <PreviousLogsBanner t={t} />}
              <LogView
                t={consoleT}
                chromeT={t}
                sources={built.sources}
                onStateChange={onStateChange}
              />
            </>
          ) : (
            <MetricsPane pods={state.pods} />
          )}
        </div>
      </div>
    </>
  );
}

function StreamStatus({
  status,
  paused,
  bufferedCount,
  t,
  mode,
}: {
  status: LogStatus;
  paused: boolean;
  bufferedCount: number;
  t: ReturnType<typeof tokens>;
  mode: ThemeMode;
}) {
  if (paused) {
    return (
      <span
        style={{
          fontSize: FS_SM,
          color: t.warn,
          fontFamily: FF_MONO,
        }}
      >
        {streamStatusLabel(status, paused, bufferedCount)}
      </span>
    );
  }
  if (status.kind === "starting")
    return <StatusPill status="Pending" t={t} mode={mode} dense />;
  if (status.kind === "streaming")
    return <StatusPill status="Running" t={t} mode={mode} dense />;
  if (status.kind === "error")
    return <StatusPill status="Error" t={t} mode={mode} dense />;
  // `waiting` / `ended`: keep the chrome label terse — the full reason
  // already lives in the log body, so it's a hover tooltip here, not an
  // inlined duplicate.
  const detail = streamStatusDetail(status);
  return (
    <Tooltip label={detail ?? ""}>
      <span
        style={{
          fontSize: FS_SM,
          color: status.kind === "waiting" ? t.warn : t.textMuted,
          fontFamily: FF_MONO,
        }}
      >
        {streamStatusLabel(status, paused, bufferedCount)}
      </span>
    </Tooltip>
  );
}
