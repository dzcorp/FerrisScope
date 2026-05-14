import { useCallback, useMemo, useState } from "react";
import { useResolvedTheme } from "../../store";
import { FF_MONO, type ThemeMode, FS_SM } from "../../theme";
import { Select } from "../ui";
import { LogView, type LogViewState } from "../log/LogView";
import { streamStatusDetail, streamStatusLabel } from "../log/status";

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
      <LogView
        t={t}
        clusterId={clusterId}
        namespace={namespace}
        pod={name}
        container={container}
        onStateChange={onStateChange}
      />
    </div>
  );
}
