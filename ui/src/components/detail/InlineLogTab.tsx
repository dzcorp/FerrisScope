import { useCallback, useMemo, useState } from "react";
import { useConsoleTokens, useResolvedTheme } from "../../store";
import { FF_MONO, type ThemeMode, FS_SM, FS_XS } from "../../theme";
import { EmptyState, ErrorBlock, LoadingLine, Select } from "../ui";
import { LogView, type LogViewState } from "../log/LogView";
import { streamStatusDetail, streamStatusLabel } from "../log/status";
import { useObservedPods } from "../LogPanel";
import {
  buildLogSources,
  sourceKey,
  type LogViewSource,
} from "../../lib/logSources";

// Inline Pod-logs surface for the detail-panel "Logs" tab. The actual
// streaming + virtualization + footer toggles live in the shared
// `LogView` component; this file only owns the inline-tab chrome
// (container selector + compact status pill). The full-overlay sibling
// is `LogPanel.tsx`.

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
  // (none while the pod has no containers yet).
  const sources = useMemo<LogViewSource[]>(
    () =>
      container
        ? [
            {
              key: sourceKey(clusterId, namespace, name, container),
              clusterId,
              namespace,
              pod: name,
              container,
              label: "",
              colorIdx: 0,
            },
          ]
        : [],
    [clusterId, namespace, name, container],
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
  const statusColor = view.paused
    ? t.warn
    : view.status.kind === "error"
      ? t.bad
      : view.status.kind === "streaming"
        ? t.good
        : view.status.kind === "waiting"
          ? t.warn
          : t.textMuted;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        {containers.length > 1 ? (
          <Select
            t={t}
            fullWidth={false}
            value={container ?? ""}
            onChange={(v) => setContainer(v)}
            options={containers.map((c) => ({ value: c, label: c }))}
            popoverMinWidth={popoverMinWidth}
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              height: 26,
              padding: "3px 28px 3px 8px",
            }}
          />
        ) : (
          <span
            style={{
              fontSize: FS_SM,
              color: t.textMuted,
              fontFamily: FF_MONO,
            }}
          >
            container: {container ?? "—"}
          </span>
        )}
        <span
          title={statusDetail ?? undefined}
          style={{
            fontSize: FS_SM,
            color: statusColor,
            fontFamily: FF_MONO,
          }}
        >
          {statusLabel}
        </span>
      </div>
      <LogView t={consoleT} sources={sources} onStateChange={onStateChange} />
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
  const [view, setView] = useState<LogViewState>({
    status: { kind: "starting" },
    paused: false,
    bufferedCount: 0,
    lineCount: 0,
  });
  const onStateChange = useCallback((s: LogViewState) => setView(s), []);

  // One cluster only, so the cluster-prefix branch of the label builder
  // never engages — the name lookup can be a stub.
  const built = useMemo(
    () =>
      state.kind === "ready"
        ? buildLogSources(state.pods, () => "")
        : { sources: [] as LogViewSource[], dropped: 0 },
    [state],
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
            fontSize: FS_SM,
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
  const statusColor = view.paused
    ? t.warn
    : view.status.kind === "error"
      ? t.bad
      : view.status.kind === "streaming"
        ? t.good
        : view.status.kind === "waiting"
          ? t.warn
          : t.textMuted;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{ fontSize: FS_SM, color: t.textMuted, fontFamily: FF_MONO }}
        >
          {state.pods.length} pods · {built.sources.length} streams
          {built.dropped > 0 ? ` (+${built.dropped} over cap)` : ""}
        </span>
        <span
          title={statusDetail ?? undefined}
          style={{ fontSize: FS_SM, color: statusColor, fontFamily: FF_MONO }}
        >
          {statusLabel}
        </span>
        {state.warnings.length > 0 && (
          <span
            title={state.warnings.join("\n")}
            style={{ fontSize: FS_XS, color: t.warn, fontFamily: FF_MONO }}
          >
            {state.warnings.length} warning
            {state.warnings.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <LogView
        t={consoleT}
        sources={built.sources}
        onStateChange={onStateChange}
      />
    </div>
  );
}
