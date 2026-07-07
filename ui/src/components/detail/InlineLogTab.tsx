import { useCallback, useMemo, useState } from "react";
import { useConsoleTokens, useResolvedTheme } from "../../store";
import { type ThemeMode, FF_MONO, FS_XS } from "../../theme";
import { EmptyState, ErrorBlock, LoadingLine } from "../ui";
import { LogView, type LogViewState } from "../log/LogView";
import { PreviousLogsBanner } from "../log/PreviousControls";
import { LogToolbar } from "../log/LogToolbar";
import {
  logStatusColor,
  streamStatusDetail,
  streamStatusLabel,
} from "../log/status";
import { useObservedPods } from "../LogPanel";
import {
  buildLogSources,
  containerUniverse,
  DEFAULT_TAIL_LINES,
  sourceKey,
  type LogViewSource,
} from "../../lib/logSources";

// Inline Pod-logs surface for the detail-panel "Logs" tab. The actual
// streaming + virtualization + footer toggles live in the shared
// `LogView` component; this file only owns the inline-tab chrome, which is
// now the shared `LogToolbar`. The full-overlay sibling is `LogPanel.tsx`.

// Popover chrome around the label text: 4px outer padding + 10px inner
// padding (×2) + 10px checkmark column + 8px gap + ~14px scrollbar/safety.
const POPOVER_CHROME = 56;

// Lazy canvas for `measureText`. Faster and reflow-free vs. DOM measurement.
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureLabel(text: string, font: string): number {
  if (!_measureCtx && typeof document !== "undefined") {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!_measureCtx) return text.length * 7;
  if (_measureCtx.font !== font) _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

export function InlineLogTab({
  clusterId,
  namespace,
  name,
  containers,
  defaultContainer,
}: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string;
  name: string;
  containers: string[];
  defaultContainer?: string | null;
}) {
  const t = useResolvedTheme().tokens;
  // The log body + footer render as a console (dark by default); the tab
  // chrome above stays in the active theme. See `useConsoleTokens`.
  const consoleT = useConsoleTokens();
  const initialContainer =
    (defaultContainer && containers.includes(defaultContainer)
      ? defaultContainer
      : containers[0]) ?? null;
  const [container, setContainer] = useState<string | null>(initialContainer);
  // Show the previously-terminated container instance instead of the live one
  // (crash diagnosis — issue #63). Single-pod only.
  const [previous, setPrevious] = useState(false);
  // First-open fetch tail. Defaults to the historical 200; the operator can
  // dial it up to the whole history from the toolbar.
  const [tailLines, setTailLines] = useState<number | null>(DEFAULT_TAIL_LINES);
  const [view, setView] = useState<LogViewState>({
    status: { kind: "starting" },
    paused: false,
    bufferedCount: 0,
    lineCount: 0,
  });

  // Size the popover to the longest container name. Without this the
  // popover inherits the trigger's width (which mirrors the *current*
  // selection), so picking a short name like `csi-resizer` clips longer
  // siblings to "cinder-c…" until the operator picks one to read its
  // full label.
  const popoverMinWidth = useMemo(() => {
    if (containers.length <= 1) return undefined;
    const font = "12.5px system-ui, -apple-system, Segoe UI, sans-serif";
    let widest = 0;
    for (const c of containers) {
      const w = measureLabel(c, font);
      if (w > widest) widest = w;
    }
    return Math.min(480, Math.ceil(widest) + POPOVER_CHROME);
  }, [containers]);

  const onStateChange = useCallback((s: LogViewState) => setView(s), []);

  // Single-pod surface — exactly one stream for the selected container
  // (none while the pod has no containers yet). `previous` and `tailLines`
  // both fold into the key so flipping either restarts the stream.
  const sources = useMemo<LogViewSource[]>(
    () =>
      container
        ? [
            {
              key: sourceKey(
                clusterId,
                namespace,
                name,
                container,
                previous,
                tailLines,
              ),
              clusterId,
              namespace,
              pod: name,
              container,
              previous,
              tailLines,
              label: "",
              colorIdx: 0,
            },
          ]
        : [],
    [clusterId, namespace, name, container, previous, tailLines],
  );

  // Terse label — the full reason behind `ended` / `error` / `waiting`
  // shows in the log body, so here it's only a hover `title` to avoid a
  // visible duplicate.
  const statusLabel = streamStatusLabel(
    view.status,
    view.paused,
    view.bufferedCount,
  );
  const statusDetail = streamStatusDetail(view.status);
  const statusColor = logStatusColor(view.status, view.paused, t);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <LogToolbar
        t={t}
        mode={{
          kind: "single",
          containers,
          active: container,
          onContainer: setContainer,
          popoverMinWidth,
          previous,
          onPrevious: setPrevious,
        }}
        tailLines={tailLines}
        onTailLines={setTailLines}
        statusLabel={statusLabel}
        statusDetail={statusDetail}
        statusColor={statusColor}
        style={{
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
        }}
      />
      {previous && <PreviousLogsBanner t={t} />}
      <LogView
        t={consoleT}
        chromeT={t}
        sources={sources}
        onStateChange={onStateChange}
      />
    </div>
  );
}

// Inline aggregated-logs surface for workload detail tabs (Deployment /
// StatefulSet / DaemonSet / ReplicaSet / Job). Resolves the workload's pods
// via its label selector, then streams every container interleaved — same
// engine as the overlay panel, detail-tab chrome.
export function InlineWorkloadLogTab({
  clusterId,
  kindId,
  namespace,
  name,
}: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  namespace: string;
  name: string;
}) {
  const t = useResolvedTheme().tokens;
  const consoleT = useConsoleTokens();
  const targets = useMemo(
    () => [{ clusterId, kindId, namespace, name }],
    [clusterId, kindId, namespace, name],
  );
  const { state, retry } = useObservedPods(targets);
  const [tailLines, setTailLines] = useState<number | null>(DEFAULT_TAIL_LINES);
  // Containers muted across the whole workload (noisy sidecars — istio-proxy,
  // linkerd, etc.). Excluded from every pod's merged stream.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [view, setView] = useState<LogViewState>({
    status: { kind: "starting" },
    paused: false,
    bufferedCount: 0,
    lineCount: 0,
  });
  const onStateChange = useCallback((s: LogViewState) => setView(s), []);

  const toggleContainer = useCallback((c: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);

  const pods = state.kind === "ready" ? state.pods : [];
  const universe = useMemo(() => containerUniverse(pods), [pods]);
  // One cluster only, so the cluster-prefix branch of the label builder
  // never engages — the name lookup can be a stub.
  const built = useMemo(
    () =>
      state.kind === "ready"
        ? buildLogSources(state.pods, () => "", {
            tailLines,
            excludedContainers: excluded,
          })
        : { sources: [] as LogViewSource[], dropped: 0 },
    [state, tailLines, excluded],
  );

  if (state.kind === "loading") {
    return <LoadingLine t={t} label="Resolving pods…" />;
  }
  if (state.kind === "error") {
    return (
      <div style={{ padding: 18 }}>
        <ErrorBlock t={t} message={state.message} kindLabel="pods" verb="load" />
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
            fontSize: FS_XS,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (state.pods.length === 0) {
    return (
      <EmptyState
        t={t}
        title="No pods"
        hint={
          state.warnings[0] ??
          "The workload's selector matched no running pods."
        }
      />
    );
  }

  const statusLabel = streamStatusLabel(
    view.status,
    view.paused,
    view.bufferedCount,
  );
  const statusDetail = streamStatusDetail(view.status);
  const statusColor = logStatusColor(view.status, view.paused, t);
  // Every container muted — nothing to stream. Guard so LogView isn't handed
  // an empty source set with no explanation.
  const allMuted = built.sources.length === 0;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <LogToolbar
        t={t}
        mode={{
          kind: "aggregated",
          podCount: state.pods.length,
          streamCount: built.sources.length,
          dropped: built.dropped,
          universe,
          excluded,
          onToggleContainer: toggleContainer,
        }}
        tailLines={tailLines}
        onTailLines={setTailLines}
        statusLabel={statusLabel}
        statusDetail={statusDetail}
        statusColor={statusColor}
        rightExtra={
          state.warnings.length > 0 ? (
            <span
              title={state.warnings.join("\n")}
              style={{ fontSize: FS_XS, color: t.warn, fontFamily: FF_MONO }}
            >
              {state.warnings.length} warning
              {state.warnings.length > 1 ? "s" : ""}
            </span>
          ) : undefined
        }
        style={{
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
        }}
      />
      {allMuted ? (
        <EmptyState
          t={t}
          title="All containers muted"
          hint="Re-enable a container chip above to stream its logs."
        />
      ) : (
        <LogView
          t={consoleT}
          chromeT={t}
          sources={built.sources}
          onStateChange={onStateChange}
        />
      )}
    </div>
  );
}
