import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, onMetrics, onPrometheusChanged } from "../../api";
import { tokens, FONT_MONO, type ThemeMode, type Tokens } from "../../theme";
import type {
  MetricsSnapshot,
  PromBackend,
  PromCacheEntry,
  VolumeMetric,
} from "../../types";

// The active TSDB for the surface body — Prom / VM / Thanos / etc. Each
// surface's outer render wraps its tree in a Provider once the cached
// entry resolves; nested `<PromBadge>` reads it so the badge label is
// always specific to whichever backend served the data. Defaults to
// "prometheus" when no Provider is in scope (e.g. degenerate render
// paths) so the existing behavior is preserved.
const PromBackendContext = createContext<PromBackend>("prometheus");

function backendShortLabel(b: PromBackend): string {
  switch (b) {
    case "prometheus":
      return "Prom";
    case "victoriametrics":
      return "VM";
    case "thanos":
      return "Thanos";
    case "mimir":
      return "Mimir";
    case "cortex":
      return "Cortex";
    case "m3":
      return "M3";
    case "promscale":
      return "Promscale";
    case "unknown":
      return "TSDB";
  }
}
import { DetailRow, Mute } from "./primitives";
import { Section } from "../ui";

// Per-pod / per-PVC metrics surface. CPU + memory come exclusively from
// Prometheus (PromQL range queries) — metrics-server is not used here, by
// design: a 30-sample 15s ring buffer is strictly worse than a 1h Prom
// window once Prom is around, and showing both side-by-side just confused
// operators about which one to trust. When Prom isn't detected on the
// cluster we surface an unavailable banner rather than falling back.
//
// Volumes are still pulled from the per-cluster MetricsService (kubelet
// stats/summary, 15s cadence) — that's a separate data axis from CPU/mem
// and Prom doesn't always have it.

// One time-series point. `t` is unix milliseconds (Prom returns seconds —
// we multiply on ingestion). `v` is the raw value in whatever unit the
// query produces (m, %, MiB, GiB, KiB/s, bytes — caller-tracked).
type ChartSample = { t: number; v: number };

type PromState = {
  samples: ChartSample[];
  loading: boolean;
  error: string | null;
};

// Grafana-style range presets. `windowMin` is the lookback window;
// `stepSec` is the resolution we hand Prom for the range query — tuned so
// each window lands near ~120 sample points (the upper end of what fits
// in our chart width without crowding) while staying coarse enough to
// keep the query cheap on big windows. The label is what the picker
// renders and what we surface back into each section title.
type RangeOption = { label: string; windowMin: number; stepSec: number };

const RANGE_PRESETS: RangeOption[] = [
  { label: "5m", windowMin: 5, stepSec: 5 },
  { label: "15m", windowMin: 15, stepSec: 15 },
  { label: "30m", windowMin: 30, stepSec: 15 },
  { label: "1h", windowMin: 60, stepSec: 30 },
  { label: "3h", windowMin: 180, stepSec: 60 },
  { label: "6h", windowMin: 360, stepSec: 120 },
  { label: "12h", windowMin: 720, stepSec: 300 },
  { label: "24h", windowMin: 1440, stepSec: 600 },
  { label: "7d", windowMin: 10080, stepSec: 3600 },
];

function findRange(label: string): RangeOption {
  return RANGE_PRESETS.find((r) => r.label === label) ?? RANGE_PRESETS[3]!;
}

type WorkloadKind =
  | "Deployment"
  | "StatefulSet"
  | "DaemonSet"
  | "ReplicaSet"
  | "Job";

type Mode =
  | { kind: "pod"; namespace: string; name: string }
  | { kind: "pvc"; namespace: string; name: string }
  | { kind: "node"; name: string }
  | { kind: "namespace"; name: string }
  | {
      kind: "workload";
      controllerKind: WorkloadKind;
      namespace: string;
      name: string;
    };

// Cached Prometheus entry for a cluster. `undefined` while loading, `null`
// when none configured. Subscribes to `prometheus://changed` so the panel
// lights up the moment background detection finishes.
//
// Detection is *lazy*: this hook is the trigger. The connect path no longer
// runs prometheus discovery (it raced the user's first resource watcher on
// the shared kube client). Instead, the first time any pod / pvc metrics
// tab mounts for a given cluster we kick `prometheus_redetect` in the
// background; the backend short-circuits if a cached entry was validated
// recently, so subsequent mounts are free.
//
// Cold-cache rule: `getPrometheusTarget` is a cache-only read. On first
// open of a freshly-connected cluster it returns `null`, but a redetect is
// already in flight — committing `null` here would flash "Prometheus is
// not detected" before discovery emits its result. So when the cache miss
// happens, we leave state as `undefined` (the "Detecting…" state) and let
// the redetect's `prometheus://changed` event resolve the question.
// `run_prometheus_detect` always emits exactly once, so we'll converge.
const PROM_DETECT_WATCHDOG_MS = 15_000;
function usePromEntry(clusterId: string): PromCacheEntry | null | undefined {
  const [e, setE] = useState<PromCacheEntry | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    setE(undefined);

    // Register the listener first so we can't miss an event fired between
    // the cache fetch resolving and us subscribing.
    onPrometheusChanged((evt) => {
      if (cancelled) return;
      if (evt.cluster_id !== clusterId) return;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      setE(evt.entry);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    api
      .getPrometheusTarget(clusterId)
      .then((v) => {
        if (cancelled) return;
        // Only commit a *cached* entry. On a cold cache (`v === null`) we
        // leave state at `undefined` and rely on the redetect below to
        // emit the final answer — see comment above the hook.
        if (v) setE(v);
        // Always nudge a redetect on metrics-tab open. The backend
        // short-circuits if the cached entry was validated within
        // PROM_VALIDATE_RECENT_MS — so this is cheap on a warm cache and
        // the only path that actually triggers discovery on a cold one.
        // Result lands via `prometheus://changed`.
        api.prometheusRedetect(clusterId).catch(() => {});
        // Watchdog: if the redetect never emits (cluster disconnected
        // between mount and dispatch, or any other backend short-circuit
        // before it could fire the event), don't spin forever — fall to
        // "missing" so the panel can render its banner.
        watchdog = setTimeout(() => {
          if (!cancelled)
            setE((cur) => (cur === undefined ? null : cur));
        }, PROM_DETECT_WATCHDOG_MS);
      })
      .catch(() => {
        if (!cancelled) setE(null);
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (watchdog) clearTimeout(watchdog);
    };
  }, [clusterId]);
  return e;
}

// Pull a PromQL range series for `windowMin` minutes back from "now",
// at `stepSec` resolution. Re-issued every `stepSec * 4` seconds so the
// chart slowly slides forward; we don't try to be clever about appending
// a single new sample because Prom's range API is cheap and idempotent.
function usePromRange(
  clusterId: string,
  query: string | null,
  windowMin: number,
  stepSec: number,
): PromState {
  const [samples, setSamples] = useState<ChartSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query) {
      setSamples([]);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      setLoading(true);
      setError(null);
      const end = Math.floor(Date.now() / 1000);
      const start = end - windowMin * 60;
      try {
        const data = (await api.prometheusQueryRange(
          clusterId,
          query,
          String(start),
          String(end),
          `${stepSec}s`,
        )) as {
          resultType?: string;
          result?: { values: [number, string][] }[];
        };
        if (cancelled) return;
        // Take the first series — these queries are scoped to a single
        // pod/PVC so there should only ever be one. If there are several
        // (multi-container, the user wrote a sum() etc), they collapse to
        // the first one and the user can refine the query later.
        const first = data.result && data.result[0];
        const out: ChartSample[] = first
          ? first.values
              .map(([ts, s]) => ({ t: ts * 1000, v: Number.parseFloat(s) }))
              .filter((p) => Number.isFinite(p.v))
          : [];
        setSamples(out);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    timer = setInterval(run, stepSec * 1000 * 4);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [clusterId, query, windowMin, stepSec]);

  return { samples, loading, error };
}

// One Prom result series tagged with its identifying label value (e.g.
// the mountpoint for a per-FS query, or the device name for a per-disk
// query). Used by `usePromRangeMulti` to expose every series the query
// returns rather than collapsing to the first one.
type PromMultiState = {
  series: { samples: ChartSample[]; label: string }[];
  loading: boolean;
  error: string | null;
};

// Like `usePromRange` but keeps every result series and labels each by
// the requested `labelKey` from the result's metric labels (e.g.
// `"mountpoint"`, `"device"`). Used for charts where one query produces
// several lines that share an axis — local-disk usage per filesystem,
// disk I/O per device, etc.
function usePromRangeMulti(
  clusterId: string,
  query: string | null,
  windowMin: number,
  stepSec: number,
  labelKey: string,
): PromMultiState {
  const [series, setSeries] = useState<PromMultiState["series"]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query) {
      setSeries([]);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      setLoading(true);
      setError(null);
      const end = Math.floor(Date.now() / 1000);
      const start = end - windowMin * 60;
      try {
        const data = (await api.prometheusQueryRange(
          clusterId,
          query,
          String(start),
          String(end),
          `${stepSec}s`,
        )) as {
          resultType?: string;
          result?: {
            metric?: Record<string, string>;
            values: [number, string][];
          }[];
        };
        if (cancelled) return;
        const out: PromMultiState["series"] = (data.result ?? []).map(
          (r) => ({
            label: r.metric?.[labelKey] ?? "",
            samples: r.values
              .map(([ts, s]) => ({ t: ts * 1000, v: Number.parseFloat(s) }))
              .filter((p) => Number.isFinite(p.v)),
          }),
        );
        // Stable order so colour assignment doesn't shuffle on every poll.
        out.sort((a, b) => a.label.localeCompare(b.label));
        setSeries(out);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    timer = setInterval(run, stepSec * 1000 * 4);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [clusterId, query, windowMin, stepSec, labelKey]);

  return { series, loading, error };
}

// Distinct, mode-aware palette for multi-series charts where colour is
// purely categorical (per-mountpoint, per-device). Status-coded tones
// (`bad` / `warn`) come last so the eye doesn't pre-attach meaning when
// only one or two series are present.
function seriesPalette(t: Tokens): string[] {
  return [t.accent, t.good, t.info, t.warn, t.bad];
}

function useMetricsSnapshot(
  clusterId: string | null,
): MetricsSnapshot | null {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  useEffect(() => {
    if (!clusterId) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    api
      .subscribeMetrics(clusterId)
      .then((initial) => {
        if (cancelled) return;
        if (initial) setSnap(initial);
      })
      .catch((e) => console.warn("metrics subscribe failed", e));
    onMetrics(clusterId, (s) => {
      if (cancelled) return;
      setSnap(s);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      api.unsubscribeMetrics(clusterId).catch(() => {});
    };
  }, [clusterId]);
  return snap;
}

export function MetricsTab(props: {
  mode: ThemeMode;
  clusterId: string;
  // Pod / PVC / Workload mode require namespace + name; node + namespace
  // mode require only name.
  namespace?: string;
  name?: string;
  // Selects the layout. Defaults to `pod` for backwards compatibility.
  kind?: "pod" | "pvc" | "node" | "namespace" | "workload";
  // Required when kind === "workload". Tells WorkloadMetrics which
  // kube_pod_owner / kube_<kind>_status_* lookup to use.
  controllerKind?: WorkloadKind;
}) {
  const t = tokens(props.mode);
  const target: Mode = useMemo(() => {
    if (!props.name) {
      throw new Error("MetricsTab requires name");
    }
    if (props.kind === "node") {
      return { kind: "node", name: props.name };
    }
    if (props.kind === "namespace") {
      return { kind: "namespace", name: props.name };
    }
    if (props.kind === "workload") {
      if (!props.namespace || !props.controllerKind) {
        throw new Error(
          "MetricsTab workload mode requires namespace + controllerKind",
        );
      }
      return {
        kind: "workload",
        controllerKind: props.controllerKind,
        namespace: props.namespace,
        name: props.name,
      };
    }
    if (!props.namespace) {
      // Hard error: this should be gated on a namespaced kind in DetailPanel.
      throw new Error("MetricsTab requires namespace for pod/pvc");
    }
    return props.kind === "pvc"
      ? { kind: "pvc", namespace: props.namespace, name: props.name }
      : { kind: "pod", namespace: props.namespace, name: props.name };
  }, [props.kind, props.namespace, props.name, props.controllerKind]);

  // Only pod / pvc surfaces need the per-cluster MetricsService snapshot
  // (kubelet volumes view). Everything else is Prom-only.
  const needsSnapshot = target.kind === "pod" || target.kind === "pvc";
  const snap = useMetricsSnapshot(needsSnapshot ? props.clusterId : null);

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "18px 22px 22px",
        background: t.bg,
        color: t.text,
      }}
    >
      {target.kind === "pod" && (
        <PodMetrics
          t={t}
          snap={snap}
          clusterId={props.clusterId}
          namespace={target.namespace}
          name={target.name}
        />
      )}
      {target.kind === "pvc" && (
        <PvcMetrics
          t={t}
          snap={snap}
          clusterId={props.clusterId}
          namespace={target.namespace}
          name={target.name}
        />
      )}
      {target.kind === "node" && (
        <NodeMetrics t={t} clusterId={props.clusterId} name={target.name} />
      )}
      {target.kind === "namespace" && (
        <NamespaceMetrics
          t={t}
          clusterId={props.clusterId}
          name={target.name}
        />
      )}
      {target.kind === "workload" && (
        <WorkloadMetrics
          t={t}
          clusterId={props.clusterId}
          controllerKind={target.controllerKind}
          namespace={target.namespace}
          name={target.name}
        />
      )}
    </div>
  );
}

function PodMetrics({
  t,
  snap,
  clusterId,
  namespace,
  name,
}: {
  t: Tokens;
  snap: MetricsSnapshot | null;
  clusterId: string;
  namespace: string;
  name: string;
}) {
  const podKey = `${namespace}/${name}`;
  const volumes = snap?.pod_volumes[podKey] ?? [];

  return (
    <>
      <PromPodHistory t={t} clusterId={clusterId} namespace={namespace} name={name} />

      {snap && !snap.volumes_available && volumes.length === 0 ? (
        <div style={{ marginTop: 22 }}>
          <UnavailableBanner t={t}>
            kubelet stats/summary not reachable — volume usage requires
            either RBAC for <code>nodes/proxy</code> or a route to each
            node's kubelet.
          </UnavailableBanner>
        </div>
      ) : null}

      {volumes.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <Section
            t={t}
            title="Volumes"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  fontFamily: FONT_MONO,
                  color: t.textMuted,
                }}
              >
                {volumes.length} mounted
              </span>
            }
          />
          {volumes.map((v) => (
            <VolumeRow key={v.volume_name} t={t} v={v} />
          ))}
        </div>
      )}
    </>
  );
}

// PVC tab. Two distinct concerns:
//   • Instantaneous state — capacity, used, available, inodes, mounted-by.
//     Sourced from kubelet stats/summary because Prom doesn't expose the
//     mount info and replacing it with three more PromQL calls would be
//     more machinery than this surface needs. Renders even when Prom
//     isn't around.
//   • Historical chart — Prom-only (`kubelet_volume_stats_used_bytes`),
//     same range picker as pod / node panels. We do *not* keep a frontend
//     ring buffer here: same anti-pattern we removed from the pod tab —
//     Prom range queries are strictly better when available, and "no
//     history yet" is clearer than a sparkline that takes minutes to fill.
function PvcMetrics({
  t,
  snap,
  clusterId,
  namespace,
  name,
}: {
  t: Tokens;
  snap: MetricsSnapshot | null;
  clusterId: string;
  namespace: string;
  name: string;
}) {
  const key = `${namespace}/${name}`;
  const v = snap?.pvcs[key] ?? null;

  if (snap && !snap.volumes_available && !v) {
    return (
      <UnavailableBanner t={t}>
        kubelet stats/summary not reachable — volume usage requires either
        RBAC for <code>nodes/proxy</code> or a route to each node's kubelet.
      </UnavailableBanner>
    );
  }
  if (snap && snap.volumes_available && !v) {
    // Cluster-wide stats work; this PVC just isn't mounted.
    return (
      <UnavailableBanner t={t}>
        This PVC is not currently mounted by any pod, so kubelet has no
        usage to report. Bind it to a workload to see live usage.
      </UnavailableBanner>
    );
  }
  if (!v) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>Loading volume metrics…</span>
      </Mute>
    );
  }

  return (
    <>
      <Section t={t} title="Volume usage" />
      <UsageGauge t={t} v={v} />
      <DetailRow t={t} label="Mounted by">
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {v.pod_namespace}/{v.pod_name}
        </span>
      </DetailRow>
      <InodeRow t={t} v={v} />

      <PromPvcHistory t={t} clusterId={clusterId} namespace={namespace} name={name} />
    </>
  );
}

// ── Prometheus-backed sections ────────────────────────────────────────────
//
// Prom is the *only* CPU/memory source for the metrics tab. When detection
// is in flight we show a muted "Detecting…" line; when it resolves and no
// target exists we show an unavailable banner (no fallback). Queries are
// scoped to the single pod/PVC by label so we get exactly one series per
// metric — no aggregation logic on the frontend.

function PromPodHistory({
  t,
  clusterId,
  namespace,
  name,
}: {
  t: Tokens;
  clusterId: string;
  namespace: string;
  name: string;
}) {
  const entry = usePromEntry(clusterId);
  const target = entry?.target ?? null;
  const [range, setRange] = useState<RangeOption>(findRange("1h"));
  // The rate window scales with the step so we don't ratchet noise on long
  // ranges (Grafana's auto-resolution does the same). Floor at 2m for the
  // short windows so a single missed scrape doesn't blank the panel.
  const rateWindow = `${Math.max(120, range.stepSec * 4)}s`;
  // cAdvisor metrics. `container=""` excludes the per-container rollups
  // that double-count, leaving the pod-level total. `rate(...) * 1000`
  // converts core-seconds/s to milli-cores.
  const cpuQuery = target
    ? `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${name}",container!="",container!="POD"}[${rateWindow}])) * 1000`
    : null;
  const memQuery = target
    ? `sum(container_memory_working_set_bytes{namespace="${namespace}",pod="${name}",container!="",container!="POD"}) / (1024*1024)`
    : null;
  // Network is reported on the pod's infra container (shared netns) — we
  // don't filter by container, just sum across whatever cAdvisor labels
  // back. KiB/s for readability (most pods sit well under 1 MiB/s).
  const rxQuery = target
    ? `sum(rate(container_network_receive_bytes_total{namespace="${namespace}",pod="${name}"}[${rateWindow}])) / 1024`
    : null;
  const txQuery = target
    ? `sum(rate(container_network_transmit_bytes_total{namespace="${namespace}",pod="${name}"}[${rateWindow}])) / 1024`
    : null;
  const cpu = usePromRange(clusterId, cpuQuery, range.windowMin, range.stepSec);
  const mem = usePromRange(clusterId, memQuery, range.windowMin, range.stepSec);
  const rx = usePromRange(clusterId, rxQuery, range.windowMin, range.stepSec);
  const tx = usePromRange(clusterId, txQuery, range.windowMin, range.stepSec);

  if (entry === undefined) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>Detecting Prometheus…</span>
      </Mute>
    );
  }
  if (!target) {
    return (
      <UnavailableBanner t={t}>
        Prometheus is not detected on this cluster — CPU and memory metrics
        require Prometheus. Install it (with cAdvisor scraping enabled) or
        configure a target in settings.
      </UnavailableBanner>
    );
  }
  return (
    <PromBackendContext.Provider value={target.backend}>
      <RangePicker t={t} value={range} onChange={setRange} />
      <MetricSection
        t={t}
        title="CPU"
        state={cpu}
        unit="m"
        stroke={t.accent}
        windowLabel={range.label}
      />
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Memory"
          state={mem}
          unit="MiB"
          stroke={t.good}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Network RX"
          state={rx}
          unit="KiB/s"
          stroke={t.info}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Network TX"
          state={tx}
          unit="KiB/s"
          stroke={t.warn}
          windowLabel={range.label}
        />
      </div>
    </PromBackendContext.Provider>
  );
}

// Node detail metrics. We fire two queries per metric — node-exporter
// (machine) and cAdvisor (workload roll-up) — and pick the one with data
// at render time. Machine is preferred when present (true OS-level totals
// including kernel + system + idle-derived %); cAdvisor is the fallback so
// clusters without node-exporter (or without the `node` relabel) still
// render something. The active source is shown next to the section title
// because the *unit* differs (CPU %, vs CPU milli; Mem GiB vs MiB).
function NodeMetrics({
  t,
  clusterId,
  name,
}: {
  t: Tokens;
  clusterId: string;
  name: string;
}) {
  const entry = usePromEntry(clusterId);
  const target = entry?.target ?? null;
  const [range, setRange] = useState<RangeOption>(findRange("1h"));
  const rateWindow = `${Math.max(120, range.stepSec * 4)}s`;

  // Machine — node-exporter. Network filter excludes the usual virtual
  // interfaces so we don't double-count CNI overlay traffic against the
  // physical NIC. Mem is shown in GiB because nodes are typically sized
  // in GiB and MiB makes the y-axis unwieldy.
  const NIC_FILTER =
    'device!~"^(lo|veth.*|cali.*|cilium.*|cni.*|docker.*|flannel.*|kube-ipvs.*|lxc.*|tunl0|nodelocaldns)$"';
  const machineCpuQuery = target
    ? `(1 - avg(rate(node_cpu_seconds_total{node="${name}",mode="idle"}[${rateWindow}]))) * 100`
    : null;
  const machineMemQuery = target
    ? `(node_memory_MemTotal_bytes{node="${name}"} - node_memory_MemAvailable_bytes{node="${name}"}) / (1024*1024*1024)`
    : null;
  const machineRxQuery = target
    ? `sum(rate(node_network_receive_bytes_total{node="${name}",${NIC_FILTER}}[${rateWindow}])) / 1024`
    : null;
  const machineTxQuery = target
    ? `sum(rate(node_network_transmit_bytes_total{node="${name}",${NIC_FILTER}}[${rateWindow}])) / 1024`
    : null;

  // Workloads — cAdvisor roll-up by node label. Used as fallback.
  const cpuQuery = target
    ? `sum(rate(container_cpu_usage_seconds_total{node="${name}",container!="",container!="POD"}[${rateWindow}])) * 1000`
    : null;
  const memQuery = target
    ? `sum(container_memory_working_set_bytes{node="${name}",container!="",container!="POD"}) / (1024*1024)`
    : null;
  const rxQuery = target
    ? `sum(rate(container_network_receive_bytes_total{node="${name}"}[${rateWindow}])) / 1024`
    : null;
  const txQuery = target
    ? `sum(rate(container_network_transmit_bytes_total{node="${name}"}[${rateWindow}])) / 1024`
    : null;

  // Local disk — node-exporter. Filter virtual filesystems / pseudo
  // mounts that distort "disk usage" (tmpfs, overlayfs, fuse plugins,
  // kernel-only mounts) and skip loop / ramdisk / dm-virtual block
  // devices for I/O so the sparklines reflect physical hardware.
  const FS_FILTER =
    'fstype!~"^(tmpfs|devtmpfs|squashfs|overlay|nsfs|fuse.*|proc|sysfs|cgroup.*|configfs|debugfs|hugetlbfs|mqueue|pstore|ramfs|rpc_pipefs|securityfs|selinuxfs|tracefs|bpf|fusectl)$"';
  const DISK_FILTER = 'device!~"^(loop|ram|fd|dm-)\\\\d+$"';
  const fsUsageQuery = target
    ? `100 * (1 - node_filesystem_avail_bytes{node="${name}",${FS_FILTER}} / node_filesystem_size_bytes{node="${name}",${FS_FILTER}})`
    : null;
  const diskReadQuery = target
    ? `rate(node_disk_read_bytes_total{node="${name}",${DISK_FILTER}}[${rateWindow}]) / 1024`
    : null;
  const diskWriteQuery = target
    ? `rate(node_disk_written_bytes_total{node="${name}",${DISK_FILTER}}[${rateWindow}]) / 1024`
    : null;

  const machineCpu = usePromRange(
    clusterId,
    machineCpuQuery,
    range.windowMin,
    range.stepSec,
  );
  const machineMem = usePromRange(
    clusterId,
    machineMemQuery,
    range.windowMin,
    range.stepSec,
  );
  const machineRx = usePromRange(
    clusterId,
    machineRxQuery,
    range.windowMin,
    range.stepSec,
  );
  const machineTx = usePromRange(
    clusterId,
    machineTxQuery,
    range.windowMin,
    range.stepSec,
  );
  const cpu = usePromRange(clusterId, cpuQuery, range.windowMin, range.stepSec);
  const mem = usePromRange(clusterId, memQuery, range.windowMin, range.stepSec);
  const rx = usePromRange(clusterId, rxQuery, range.windowMin, range.stepSec);
  const tx = usePromRange(clusterId, txQuery, range.windowMin, range.stepSec);
  const fsUsage = usePromRangeMulti(
    clusterId,
    fsUsageQuery,
    range.windowMin,
    range.stepSec,
    "mountpoint",
  );
  const diskRead = usePromRangeMulti(
    clusterId,
    diskReadQuery,
    range.windowMin,
    range.stepSec,
    "device",
  );
  const diskWrite = usePromRangeMulti(
    clusterId,
    diskWriteQuery,
    range.windowMin,
    range.stepSec,
    "device",
  );

  if (entry === undefined) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>Detecting Prometheus…</span>
      </Mute>
    );
  }
  if (!target) {
    return (
      <UnavailableBanner t={t}>
        Prometheus is not detected on this cluster — node CPU, memory and
        network metrics require Prometheus. Install it (with cAdvisor and
        node-exporter scraping enabled) or configure a target in settings.
      </UnavailableBanner>
    );
  }
  return (
    <PromBackendContext.Provider value={target.backend}>
      <RangePicker t={t} value={range} onChange={setRange} />
      <FallbackChart
        t={t}
        title="CPU"
        stroke={t.accent}
        windowLabel={range.label}
        primary={{ state: machineCpu, unit: "%", source: "machine" }}
        fallback={{ state: cpu, unit: "m", source: "workloads" }}
      />
      <div style={{ marginTop: 22 }}>
        <FallbackChart
          t={t}
          title="Memory"
          stroke={t.good}
          windowLabel={range.label}
          primary={{ state: machineMem, unit: "GiB", source: "machine" }}
          fallback={{ state: mem, unit: "MiB", source: "workloads" }}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <FallbackChart
          t={t}
          title="Network RX"
          stroke={t.info}
          windowLabel={range.label}
          primary={{ state: machineRx, unit: "KiB/s", source: "machine" }}
          fallback={{ state: rx, unit: "KiB/s", source: "workloads" }}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <FallbackChart
          t={t}
          title="Network TX"
          stroke={t.warn}
          windowLabel={range.label}
          primary={{ state: machineTx, unit: "KiB/s", source: "machine" }}
          fallback={{ state: tx, unit: "KiB/s", source: "workloads" }}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MultiSeriesSection
          t={t}
          title="Filesystem usage"
          state={fsUsage}
          unit="%"
          windowLabel={range.label}
          countNoun="mounts"
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MultiSeriesSection
          t={t}
          title="Disk read"
          state={diskRead}
          unit="KiB/s"
          windowLabel={range.label}
          countNoun="devices"
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MultiSeriesSection
          t={t}
          title="Disk write"
          state={diskWrite}
          unit="KiB/s"
          windowLabel={range.label}
          countNoun="devices"
        />
      </div>
    </PromBackendContext.Provider>
  );
}

// Namespace-scoped metrics. Same four charts as the pod tab, just with
// the `pod=...` constraint dropped so cAdvisor's namespace label does
// the rolling up. Useful as an at-a-glance "how loaded is this namespace
// right now" surface.
function NamespaceMetrics({
  t,
  clusterId,
  name,
}: {
  t: Tokens;
  clusterId: string;
  name: string;
}) {
  const entry = usePromEntry(clusterId);
  const target = entry?.target ?? null;
  const [range, setRange] = useState<RangeOption>(findRange("1h"));
  const rateWindow = `${Math.max(120, range.stepSec * 4)}s`;

  const cpuQuery = target
    ? `sum(rate(container_cpu_usage_seconds_total{namespace="${name}",container!="",container!="POD"}[${rateWindow}])) * 1000`
    : null;
  const memQuery = target
    ? `sum(container_memory_working_set_bytes{namespace="${name}",container!="",container!="POD"}) / (1024*1024)`
    : null;
  const rxQuery = target
    ? `sum(rate(container_network_receive_bytes_total{namespace="${name}"}[${rateWindow}])) / 1024`
    : null;
  const txQuery = target
    ? `sum(rate(container_network_transmit_bytes_total{namespace="${name}"}[${rateWindow}])) / 1024`
    : null;
  // Pod count over time — handy on a namespace tab to see scale-up/down.
  const podsQuery = target
    ? `count(kube_pod_info{namespace="${name}"})`
    : null;

  const cpu = usePromRange(clusterId, cpuQuery, range.windowMin, range.stepSec);
  const mem = usePromRange(clusterId, memQuery, range.windowMin, range.stepSec);
  const rx = usePromRange(clusterId, rxQuery, range.windowMin, range.stepSec);
  const tx = usePromRange(clusterId, txQuery, range.windowMin, range.stepSec);
  const pods = usePromRange(
    clusterId,
    podsQuery,
    range.windowMin,
    range.stepSec,
  );

  if (entry === undefined) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>Detecting Prometheus…</span>
      </Mute>
    );
  }
  if (!target) {
    return (
      <UnavailableBanner t={t}>
        Prometheus is not detected on this cluster — namespace metrics
        require Prometheus scraping cAdvisor + kube-state-metrics. Install
        it or configure a target in settings.
      </UnavailableBanner>
    );
  }
  return (
    <PromBackendContext.Provider value={target.backend}>
      <RangePicker t={t} value={range} onChange={setRange} />
      <MetricSection
        t={t}
        title="CPU"
        state={cpu}
        unit="m"
        stroke={t.accent}
        windowLabel={range.label}
      />
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Memory"
          state={mem}
          unit="MiB"
          stroke={t.good}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Network RX"
          state={rx}
          unit="KiB/s"
          stroke={t.info}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Network TX"
          state={tx}
          unit="KiB/s"
          stroke={t.warn}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Pods"
          state={pods}
          unit="count"
          stroke={t.accent}
          windowLabel={range.label}
        />
      </div>
    </PromBackendContext.Provider>
  );
}

// Workload-scoped metrics. CPU / Mem / Net are summed over pods owned by
// this controller using a kube_pod_owner join (kube-state-metrics is
// required — same prerequisite as node metrics). Deployment is special-
// cased because pods are owned by ReplicaSet which is owned by the
// Deployment, so we chain the owner lookup through kube_replicaset_owner.
//
// The 5th chart ("Replicas") is per-kind: kube_state metrics names differ
// across controllers, so each WorkloadKind picks its own series via
// `replicaSeries()` below.
function WorkloadMetrics({
  t,
  clusterId,
  controllerKind,
  namespace,
  name,
}: {
  t: Tokens;
  clusterId: string;
  controllerKind: WorkloadKind;
  namespace: string;
  name: string;
}) {
  const entry = usePromEntry(clusterId);
  const target = entry?.target ?? null;
  const [range, setRange] = useState<RangeOption>(findRange("1h"));
  const rateWindow = `${Math.max(120, range.stepSec * 4)}s`;

  // Owner-ref join expression. For controllers that directly own pods this
  // is a one-step join; for Deployments we chain through ReplicaSet.
  // Returned expression has shape `<expr>` and is meant to be the
  // right-hand side of `* on(namespace,pod) group_left()`.
  const ownerJoin =
    controllerKind === "Deployment"
      ? `(kube_pod_owner{namespace="${namespace}",owner_kind="ReplicaSet"} * on(namespace,owner_name) group_left() label_replace(kube_replicaset_owner{namespace="${namespace}",owner_kind="Deployment",owner_name="${name}"},"owner_name","$1","replicaset","(.+)"))`
      : `kube_pod_owner{namespace="${namespace}",owner_kind="${controllerKind}",owner_name="${name}"}`;

  const cpuQuery = target
    ? `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}",container!="",container!="POD"}[${rateWindow}]) * on(namespace,pod) group_left() ${ownerJoin}) * 1000`
    : null;
  const memQuery = target
    ? `sum(container_memory_working_set_bytes{namespace="${namespace}",container!="",container!="POD"} * on(namespace,pod) group_left() ${ownerJoin}) / (1024*1024)`
    : null;
  const rxQuery = target
    ? `sum(rate(container_network_receive_bytes_total{namespace="${namespace}"}[${rateWindow}]) * on(namespace,pod) group_left() ${ownerJoin}) / 1024`
    : null;
  const txQuery = target
    ? `sum(rate(container_network_transmit_bytes_total{namespace="${namespace}"}[${rateWindow}]) * on(namespace,pod) group_left() ${ownerJoin}) / 1024`
    : null;

  const cpu = usePromRange(clusterId, cpuQuery, range.windowMin, range.stepSec);
  const mem = usePromRange(clusterId, memQuery, range.windowMin, range.stepSec);
  const rx = usePromRange(clusterId, rxQuery, range.windowMin, range.stepSec);
  const tx = usePromRange(clusterId, txQuery, range.windowMin, range.stepSec);

  // Replica chart — per-kind series.
  const replicas = replicaSeries(controllerKind, namespace, name, target != null);
  // Hooks are called unconditionally — array length is fixed per
  // controllerKind so React's rules-of-hooks invariants hold.
  const replicaStates = replicas.map((r) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    usePromRange(clusterId, r.query, range.windowMin, range.stepSec),
  );

  if (entry === undefined) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>Detecting Prometheus…</span>
      </Mute>
    );
  }
  if (!target) {
    return (
      <UnavailableBanner t={t}>
        Prometheus is not detected on this cluster — workload metrics
        require Prometheus scraping cAdvisor + kube-state-metrics. Install
        it or configure a target in settings.
      </UnavailableBanner>
    );
  }
  return (
    <PromBackendContext.Provider value={target.backend}>
      <RangePicker t={t} value={range} onChange={setRange} />
      <MetricSection
        t={t}
        title="CPU"
        state={cpu}
        unit="m"
        stroke={t.accent}
        windowLabel={range.label}
      />
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Memory"
          state={mem}
          unit="MiB"
          stroke={t.good}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Network RX"
          state={rx}
          unit="KiB/s"
          stroke={t.info}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <MetricSection
          t={t}
          title="Network TX"
          state={tx}
          unit="KiB/s"
          stroke={t.warn}
          windowLabel={range.label}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <Section
          t={t}
          title={`${replicaTitle(controllerKind)} (count, ${range.label})`}
          right={<PromBadge t={t} />}
        />
        <PromMultiChart
          t={t}
          unit="count"
          states={replicas.map((r, i) => ({
            state: replicaStates[i]!,
            stroke: replicaStrokes(t)[r.tone],
            label: r.label,
          }))}
        />
      </div>
    </PromBackendContext.Provider>
  );
}

type ReplicaTone = "desired" | "ready" | "bad";

function replicaStrokes(t: Tokens): Record<ReplicaTone, string> {
  return { desired: t.accent, ready: t.good, bad: t.bad };
}

function replicaTitle(k: WorkloadKind): string {
  if (k === "DaemonSet") return "Pods scheduled";
  if (k === "Job") return "Job pods";
  return "Replicas";
}

// Per-kind kube-state-metrics series for the Replicas chart. Names differ
// across workload kinds; this keeps the dispatch in one place.
function replicaSeries(
  k: WorkloadKind,
  ns: string,
  name: string,
  haveTarget: boolean,
): { label: string; tone: ReplicaTone; query: string | null }[] {
  if (!haveTarget) {
    // Return placeholders so the hook count stays stable across renders.
    return [
      { label: "_", tone: "desired", query: null },
      { label: "_", tone: "ready", query: null },
      { label: "_", tone: "bad", query: null },
    ];
  }
  const sel = `namespace="${ns}"`;
  switch (k) {
    case "Deployment":
      return [
        {
          label: "desired",
          tone: "desired",
          query: `kube_deployment_spec_replicas{${sel},deployment="${name}"}`,
        },
        {
          label: "available",
          tone: "ready",
          query: `kube_deployment_status_replicas_available{${sel},deployment="${name}"}`,
        },
        {
          label: "unavailable",
          tone: "bad",
          query: `kube_deployment_status_replicas_unavailable{${sel},deployment="${name}"}`,
        },
      ];
    case "StatefulSet":
      return [
        {
          label: "desired",
          tone: "desired",
          query: `kube_statefulset_replicas{${sel},statefulset="${name}"}`,
        },
        {
          label: "ready",
          tone: "ready",
          query: `kube_statefulset_status_replicas_ready{${sel},statefulset="${name}"}`,
        },
        {
          label: "current",
          tone: "bad",
          query: `kube_statefulset_status_replicas_current{${sel},statefulset="${name}"}`,
        },
      ];
    case "DaemonSet":
      return [
        {
          label: "desired",
          tone: "desired",
          query: `kube_daemonset_status_desired_number_scheduled{${sel},daemonset="${name}"}`,
        },
        {
          label: "ready",
          tone: "ready",
          query: `kube_daemonset_status_number_ready{${sel},daemonset="${name}"}`,
        },
        {
          label: "misscheduled",
          tone: "bad",
          query: `kube_daemonset_status_number_misscheduled{${sel},daemonset="${name}"}`,
        },
      ];
    case "Job":
      return [
        {
          label: "active",
          tone: "desired",
          query: `kube_job_status_active{${sel},job_name="${name}"}`,
        },
        {
          label: "succeeded",
          tone: "ready",
          query: `kube_job_status_succeeded{${sel},job_name="${name}"}`,
        },
        {
          label: "failed",
          tone: "bad",
          query: `kube_job_status_failed{${sel},job_name="${name}"}`,
        },
      ];
    case "ReplicaSet":
      return [
        {
          label: "desired",
          tone: "desired",
          query: `kube_replicaset_spec_replicas{${sel},replicaset="${name}"}`,
        },
        {
          label: "ready",
          tone: "ready",
          query: `kube_replicaset_status_ready_replicas{${sel},replicaset="${name}"}`,
        },
        {
          label: "fully labeled",
          tone: "bad",
          query: `kube_replicaset_status_fully_labeled_replicas{${sel},replicaset="${name}"}`,
        },
      ];
  }
}

// One chart per metric, choosing between two PromQL sources. Prefer primary
// when it has plottable data (≥2 samples); fall back to secondary when it
// doesn't. Section title carries the active source's unit and a small label
// so the operator can tell which one rendered. While both are still loading
// we show the primary so the user sees the more authoritative source first.
function FallbackChart({
  t,
  title,
  stroke,
  windowLabel,
  primary,
  fallback,
}: {
  t: Tokens;
  title: string;
  stroke: string;
  windowLabel?: string;
  primary: { state: PromState; unit: string; source: string };
  fallback: { state: PromState; unit: string; source: string };
}) {
  const usingFallback =
    primary.state.samples.length < 2 &&
    !primary.state.loading &&
    fallback.state.samples.length >= 2;
  const active = usingFallback ? fallback : primary;
  return (
    <MetricSection
      t={t}
      title={title}
      state={active.state}
      unit={active.unit}
      stroke={stroke}
      windowLabel={windowLabel}
      extraRight={
        <span
          style={{
            fontSize: 10,
            fontFamily: FONT_MONO,
            color: t.textMuted,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          {active.source}
        </span>
      }
    />
  );
}

function PromPvcHistory({
  t,
  clusterId,
  namespace,
  name,
}: {
  t: Tokens;
  clusterId: string;
  namespace: string;
  name: string;
}) {
  const entry = usePromEntry(clusterId);
  const target = entry?.target ?? null;
  const [range, setRange] = useState<RangeOption>(findRange("6h"));
  // kube-state-metrics exposes capacity; kubelet exposes usage. Both ride
  // the same `persistentvolumeclaim` label so the join is implicit when
  // displayed side-by-side.
  const usedQuery = target
    ? `kubelet_volume_stats_used_bytes{namespace="${namespace}",persistentvolumeclaim="${name}"}`
    : null;
  const used = usePromRange(clusterId, usedQuery, range.windowMin, range.stepSec);

  if (!target) return null;
  return (
    <PromBackendContext.Provider value={target.backend}>
      <div style={{ marginTop: 26 }}>
        <RangePicker t={t} value={range} onChange={setRange} />
        <MetricSection
          t={t}
          title="Used"
          state={used}
          unit="bytes"
          stroke={t.accent}
          windowLabel={range.label}
        />
      </div>
    </PromBackendContext.Provider>
  );
}

// Range picker — Grafana-style chip row. Highlighted chip is the active
// preset; clicking another swaps the window for every chart in the
// surface (CPU, Mem, RX, TX) atomically because they share one state.
function RangePicker({
  t,
  value,
  onChange,
}: {
  t: Tokens;
  value: RangeOption;
  onChange: (r: RangeOption) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        marginBottom: 14,
      }}
    >
      {RANGE_PRESETS.map((o) => {
        const active = o.label === value.label;
        return (
          <button
            key={o.label}
            type="button"
            onClick={() => onChange(o)}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              fontFamily: FONT_MONO,
              fontVariantNumeric: "tabular-nums",
              background: active ? t.accent : "transparent",
              color: active ? "#fff" : t.textMuted,
              border: `1px solid ${active ? t.accent : t.border}`,
              borderRadius: 3,
              cursor: "pointer",
              letterSpacing: 0.3,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PromBadge({ t }: { t: Tokens }) {
  const backend = useContext(PromBackendContext);
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: FONT_MONO,
        color: t.accent,
        background: t.accentSoft,
        padding: "2px 6px",
        borderRadius: 3,
        letterSpacing: 0.4,
        textTransform: "uppercase",
      }}
    >
      {backendShortLabel(backend)}
    </span>
  );
}

function PromChart({
  t,
  state,
  stroke,
  unit,
}: {
  t: Tokens;
  state: PromState;
  stroke: string;
  unit: string;
}) {
  if (state.error) {
    return (
      <div
        style={{
          padding: "8px 10px",
          background: "rgba(244,63,94,0.08)",
          border: `1px solid rgba(244,63,94,0.4)`,
          color: t.text,
          fontSize: 11.5,
          borderRadius: 3,
          fontFamily: FONT_MONO,
          wordBreak: "break-word",
        }}
      >
        {state.error}
      </div>
    );
  }
  if (state.samples.length < 2) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>
          {state.loading ? "Querying Prometheus…" : "No samples in range"}
        </span>
      </Mute>
    );
  }
  return (
    <Chart
      t={t}
      series={[{ samples: state.samples, stroke, label: "" }]}
      unit={unit}
    />
  );
}

// Multi-series variant of PromChart. Used by surfaces that have several
// related lines on one chart (replicas: desired / ready / unavailable).
// `states` and `seriesMeta` are zipped into ChartSeries[]; if all of them
// have <2 samples we fall back to the single-series loading/empty UX of
// PromChart so the empty/error state stays consistent.
function PromMultiChart({
  t,
  unit,
  states,
}: {
  t: Tokens;
  unit: string;
  states: { state: PromState; stroke: string; label: string }[];
}) {
  const firstError = states.find((s) => s.state.error)?.state.error;
  if (firstError) {
    return (
      <div
        style={{
          padding: "8px 10px",
          background: "rgba(244,63,94,0.08)",
          border: `1px solid rgba(244,63,94,0.4)`,
          color: t.text,
          fontSize: 11.5,
          borderRadius: 3,
          fontFamily: FONT_MONO,
          wordBreak: "break-word",
        }}
      >
        {firstError}
      </div>
    );
  }
  const anyHasData = states.some((s) => s.state.samples.length >= 2);
  const anyLoading = states.some((s) => s.state.loading);
  if (!anyHasData) {
    return (
      <Mute t={t}>
        <span style={{ fontSize: 12 }}>
          {anyLoading ? "Querying Prometheus…" : "No samples in range"}
        </span>
      </Mute>
    );
  }
  return (
    <Chart
      t={t}
      unit={unit}
      series={states.map((s) => ({
        samples: s.state.samples,
        stroke: s.stroke,
        label: s.label,
      }))}
    />
  );
}

// Section + chart + current-value chip + Prom badge. The standard wrapper
// every per-metric surface uses, so tooltip / axis / latest-value formatting
// stays consistent across pod, node and pvc panels.
function MetricSection({
  t,
  title,
  state,
  unit,
  stroke,
  windowLabel = "1h",
  extraRight,
}: {
  t: Tokens;
  title: string;
  state: PromState;
  unit: string;
  stroke: string;
  windowLabel?: string;
  extraRight?: React.ReactNode;
}) {
  const last = state.samples[state.samples.length - 1] ?? null;
  return (
    <>
      <Section
        t={t}
        title={`${title} (${unit}, ${windowLabel})`}
        right={
          <span
            style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
          >
            {last && (
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.text,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatValue(last.v, unit)}
              </span>
            )}
            {extraRight}
            <PromBadge t={t} />
          </span>
        }
      />
      <PromChart t={t} state={state} stroke={stroke} unit={unit} />
    </>
  );
}

// Multi-series sibling of MetricSection. Used for charts where one query
// returns several series (per-mountpoint, per-device) — strokes cycle
// through `seriesPalette(t)` and the legend below the chart names each
// line. The right slot shows the series count instead of a current-value
// chip (which doesn't have an obvious meaning when there are 5 lines).
function MultiSeriesSection({
  t,
  title,
  state,
  unit,
  windowLabel = "1h",
  countNoun,
}: {
  t: Tokens;
  title: string;
  state: PromMultiState;
  unit: string;
  windowLabel?: string;
  countNoun: string;
}) {
  const palette = seriesPalette(t);
  const chartSeries: ChartSeries[] = state.series.map((s, i) => ({
    samples: s.samples,
    stroke: palette[i % palette.length]!,
    label: s.label || `series ${i + 1}`,
  }));
  const have = chartSeries.some((s) => s.samples.length >= 2);
  return (
    <>
      <Section
        t={t}
        title={`${title} (${unit}, ${windowLabel})`}
        right={
          <span
            style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
          >
            {have && (
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.textMuted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {state.series.length} {countNoun}
              </span>
            )}
            <PromBadge t={t} />
          </span>
        }
      />
      {state.error ? (
        <div
          style={{
            padding: "8px 10px",
            background: "rgba(244,63,94,0.08)",
            border: `1px solid rgba(244,63,94,0.4)`,
            color: t.text,
            fontSize: 11.5,
            borderRadius: 3,
            fontFamily: FONT_MONO,
            wordBreak: "break-word",
          }}
        >
          {state.error}
        </div>
      ) : !have ? (
        <Mute t={t}>
          <span style={{ fontSize: 12 }}>
            {state.loading ? "Querying Prometheus…" : "No samples in range"}
          </span>
        </Mute>
      ) : (
        <Chart t={t} series={chartSeries} unit={unit} />
      )}
    </>
  );
}

function VolumeRow({ t, v }: { t: Tokens; v: VolumeMetric }) {
  const label = v.pvc_name ?? v.volume_name;
  return (
    <div style={{ marginBottom: 14 }}>
      <DetailRow
        t={t}
        label={label}
      >
        <UsageGaugeInline t={t} v={v} />
      </DetailRow>
    </div>
  );
}

function UsageGauge({ t, v }: { t: Tokens; v: VolumeMetric }) {
  const pct = v.capacity_bytes > 0 ? v.used_bytes / v.capacity_bytes : 0;
  const tone = gaugeTone(t, pct);
  return (
    <div style={{ marginBottom: 14 }}>
      <DetailRow t={t} label="Used">
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {fmtBytes(v.used_bytes)} / {fmtBytes(v.capacity_bytes)}{" "}
          <span style={{ color: tone, marginLeft: 8 }}>
            ({(pct * 100).toFixed(1)}%)
          </span>
        </span>
      </DetailRow>
      <DetailRow t={t} label="Available">
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {fmtBytes(v.available_bytes)}
        </span>
      </DetailRow>
      <Bar t={t} pct={pct} tone={tone} />
    </div>
  );
}

function UsageGaugeInline({ t, v }: { t: Tokens; v: VolumeMetric }) {
  const pct = v.capacity_bytes > 0 ? v.used_bytes / v.capacity_bytes : 0;
  const tone = gaugeTone(t, pct);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 12,
          minWidth: 200,
        }}
      >
        {fmtBytes(v.used_bytes)} / {fmtBytes(v.capacity_bytes)}{" "}
        <span style={{ color: tone }}>({(pct * 100).toFixed(1)}%)</span>
      </span>
      <Bar t={t} pct={pct} tone={tone} compact />
    </div>
  );
}

function InodeRow({ t, v }: { t: Tokens; v: VolumeMetric }) {
  if (v.capacity_inodes === 0) return null;
  const pct = v.used_inodes / v.capacity_inodes;
  return (
    <DetailRow t={t} label="Inodes">
      <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
        {v.used_inodes.toLocaleString()} / {v.capacity_inodes.toLocaleString()}{" "}
        <span style={{ color: gaugeTone(t, pct), marginLeft: 8 }}>
          ({(pct * 100).toFixed(1)}%)
        </span>
      </span>
    </DetailRow>
  );
}

function Bar({
  t,
  pct,
  tone,
  compact = false,
}: {
  t: Tokens;
  pct: number;
  tone: string;
  compact?: boolean;
}) {
  const w = Math.max(0, Math.min(1, pct));
  return (
    <div
      style={{
        marginTop: compact ? 0 : 6,
        height: compact ? 4 : 6,
        flex: compact ? 1 : undefined,
        background: t.surfaceAlt,
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${(w * 100).toFixed(2)}%`,
          background: tone,
          transition: "width 200ms linear",
        }}
      />
    </div>
  );
}

function gaugeTone(t: Tokens, pct: number): string {
  if (pct >= 0.9) return t.bad;
  if (pct >= 0.75) return t.warn;
  return t.good;
}

function fmtBytes(b: number): string {
  if (b === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(b) / 10));
  const n = b / 1024 ** i;
  const decimals = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(decimals)} ${units[i]}`;
}

function UnavailableBanner({
  t,
  children,
}: {
  t: Tokens;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "rgba(245,158,11,0.12)",
        border: `1px solid rgba(245,158,11,0.4)`,
        color: t.text,
        fontSize: 12,
        borderRadius: 3,
        marginBottom: 18,
      }}
    >
      {children}
    </div>
  );
}

// Chart with axes, grid, hover crosshair and absolute-positioned tooltip.
// Width is tracked via ResizeObserver so the SVG fills its container with
// 1px-per-1unit-of-viewBox mapping — that keeps the hover math direct
// (clientX − rect.left == SVG x). Three y-axis ticks (min/mid/max) and
// three x-axis ticks (oldest / midpoint / now) are enough density for a
// 60-min window without crowding.
// One drawn line. Each MultiChart accepts an array of these — single-series
// charts wrap a single ChartSeries; multi-series (e.g. Replicas: desired /
// ready / unavailable) pass several. Series are assumed to share the same
// timestamp domain — Prom range queries with the same start/end/step give
// us that for free.
type ChartSeries = {
  samples: ChartSample[];
  stroke: string;
  label: string;
};

function Chart({
  t,
  series,
  unit,
  height = 130,
}: {
  t: Tokens;
  series: ChartSeries[];
  unit: string;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<{ idx: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(160, Math.floor(entry.contentRect.width));
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Use the longest series as the time/index reference. All series share
  // the same Prom step, so they line up sample-for-sample anyway.
  const ref = series.reduce<ChartSeries | null>(
    (acc, s) => (s.samples.length > (acc?.samples.length ?? 0) ? s : acc),
    null,
  );
  if (!ref || ref.samples.length < 2) return null;

  const PAD_L = 56;
  const PAD_R = 12;
  const PAD_T = 8;
  // Slightly taller bottom padding when we render a legend.
  const showLegend = series.length > 1;
  const PAD_B = showLegend ? 38 : 22;
  const innerW = Math.max(20, width - PAD_L - PAD_R);
  const innerH = Math.max(20, height - PAD_T - PAD_B);

  let vMin = Infinity;
  let vMax = -Infinity;
  for (const s of series) {
    for (const p of s.samples) {
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
  }
  if (vMin === vMax) {
    const pad = vMin === 0 ? 1 : Math.abs(vMin) * 0.1;
    vMin -= pad;
    vMax += pad;
  } else {
    const headroom = (vMax - vMin) * 0.06;
    vMin -= headroom;
    vMax += headroom;
  }
  const valSpan = vMax - vMin;

  const tFirst = ref.samples[0]!.t;
  const tLast = ref.samples[ref.samples.length - 1]!.t;
  const tSpan = Math.max(1, tLast - tFirst);

  const xOf = (s: ChartSample) =>
    PAD_L + ((s.t - tFirst) / tSpan) * innerW;
  const yOf = (s: ChartSample) =>
    PAD_T + ((vMax - s.v) / valSpan) * innerH;

  const paths = series.map((sr) => {
    let p = "";
    for (let i = 0; i < sr.samples.length; i++) {
      const s = sr.samples[i]!;
      p += `${i === 0 ? "M" : "L"}${xOf(s).toFixed(1)},${yOf(s).toFixed(1)} `;
    }
    return p.trim();
  });

  const yTicks = [vMax, (vMax + vMin) / 2, vMin];
  const xTicks: ChartSample[] = [
    ref.samples[0]!,
    ref.samples[Math.floor((ref.samples.length - 1) / 2)]!,
    ref.samples[ref.samples.length - 1]!,
  ];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    if (cx < PAD_L || cx > PAD_L + innerW) {
      setHover(null);
      return;
    }
    const ratio = (cx - PAD_L) / innerW;
    const idx = Math.max(
      0,
      Math.min(
        ref.samples.length - 1,
        Math.round(ratio * (ref.samples.length - 1)),
      ),
    );
    setHover({ idx });
  };

  const hoveredRef = hover ? ref.samples[hover.idx] : null;
  const hx = hoveredRef ? xOf(hoveredRef) : 0;
  const gridColor = t.borderSoft;
  const axisTextColor = t.textMuted;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: "block" }}
      >
        {yTicks.map((v, i) => {
          const y = PAD_T + ((vMax - v) / valSpan) * innerH;
          return (
            <g key={`y-${i}`}>
              <line
                x1={PAD_L}
                x2={width - PAD_R}
                y1={y}
                y2={y}
                stroke={gridColor}
                strokeWidth={1}
                strokeDasharray={i === 1 ? "2 4" : undefined}
              />
              <text
                x={PAD_L - 6}
                y={y + 3.5}
                fontSize={10}
                fontFamily={FONT_MONO}
                fill={axisTextColor}
                textAnchor="end"
              >
                {formatValueShort(v, unit)}
              </text>
            </g>
          );
        })}

        {xTicks.map((s, i) => {
          const x = xOf(s);
          const anchor =
            i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle";
          return (
            <text
              key={`x-${i}`}
              x={x}
              y={PAD_T + innerH + 14}
              fontSize={10}
              fontFamily={FONT_MONO}
              fill={axisTextColor}
              textAnchor={anchor}
            >
              {formatRelTime(s.t, tLast)}
            </text>
          );
        })}

        {paths.map((d, i) => (
          <path
            key={`p-${i}`}
            d={d}
            fill="none"
            stroke={series[i]!.stroke}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {hoveredRef && (
          <>
            <line
              x1={hx}
              x2={hx}
              y1={PAD_T}
              y2={PAD_T + innerH}
              stroke={t.textMuted}
              strokeDasharray="2 3"
              strokeWidth={1}
            />
            {series.map((sr, i) => {
              const p = sr.samples[hover!.idx];
              if (!p) return null;
              return (
                <circle
                  key={`d-${i}`}
                  cx={xOf(p)}
                  cy={yOf(p)}
                  r={3.5}
                  fill={sr.stroke}
                  stroke={t.bg}
                  strokeWidth={1.5}
                />
              );
            })}
          </>
        )}

        {showLegend && (
          <g>
            {series.map((sr, i) => {
              const x = PAD_L + i * 110;
              const y = height - 8;
              return (
                <g key={`l-${i}`}>
                  <line
                    x1={x}
                    x2={x + 14}
                    y1={y - 3}
                    y2={y - 3}
                    stroke={sr.stroke}
                    strokeWidth={2}
                  />
                  <text
                    x={x + 18}
                    y={y}
                    fontSize={10}
                    fontFamily={FONT_MONO}
                    fill={t.textMuted}
                  >
                    {sr.label}
                  </text>
                </g>
              );
            })}
          </g>
        )}
      </svg>

      {hoveredRef && hover && (
        <div
          style={{
            position: "absolute",
            left: Math.min(Math.max(hx + 10, PAD_L), width - 170),
            top: 4,
            background: t.surface,
            border: `1px solid ${t.border}`,
            padding: "5px 9px",
            fontSize: 11,
            fontFamily: FONT_MONO,
            borderRadius: 3,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
            color: t.text,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div style={{ color: t.textMuted, fontSize: 10, marginBottom: 2 }}>
            {formatRelTime(hoveredRef.t, tLast)}
          </div>
          {series.map((sr, i) => {
            const p = sr.samples[hover.idx];
            if (!p) return null;
            return (
              <div
                key={`tip-${i}`}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  lineHeight: 1.4,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: sr.stroke,
                    display: "inline-block",
                  }}
                />
                {showLegend && (
                  <span style={{ color: t.textMuted, minWidth: 60 }}>
                    {sr.label}
                  </span>
                )}
                <span>{formatValue(p.v, unit)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Format a value with its unit for the tooltip / current-value chip.
function formatValue(v: number, unit: string): string {
  if (unit === "%") return `${v.toFixed(1)}%`;
  if (unit === "m") return `${Math.round(v)} m`;
  if (unit === "MiB") return `${v.toFixed(1)} MiB`;
  if (unit === "GiB") return `${v.toFixed(2)} GiB`;
  if (unit === "KiB/s") return `${v.toFixed(1)} KiB/s`;
  if (unit === "bytes") return fmtBytes(v);
  if (unit === "count") return Number.isInteger(v) ? `${v}` : v.toFixed(1);
  return v.toFixed(2);
}

// Compact form for the y-axis ticks, where horizontal space is tight.
function formatValueShort(v: number, unit: string): string {
  if (unit === "%") return `${v.toFixed(0)}`;
  if (unit === "m") {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return `${Math.round(v)}`;
  }
  if (unit === "MiB" || unit === "GiB") {
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  }
  if (unit === "KiB/s") {
    if (Math.abs(v) >= 1024) return `${(v / 1024).toFixed(1)}M`;
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  }
  if (unit === "bytes") return fmtBytes(v);
  if (unit === "count") return Number.isInteger(v) ? `${v}` : v.toFixed(1);
  return v.toFixed(1);
}

// Relative-time label vs the most recent sample. Anchored to "now" so the
// rightmost tick reads "now" and ticks count back.
function formatRelTime(ts: number, latest: number): string {
  const diff = Math.max(0, Math.round((latest - ts) / 1000));
  if (diff < 30) return "now";
  if (diff < 60) return `−${diff}s`;
  if (diff < 3600) return `−${Math.round(diff / 60)}m`;
  if (diff < 86400) return `−${Math.round(diff / 3600)}h`;
  return `−${Math.round(diff / 86400)}d`;
}
