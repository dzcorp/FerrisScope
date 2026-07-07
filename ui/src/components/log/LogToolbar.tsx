import type { CSSProperties, ReactNode } from "react";
import type { Tokens } from "../../theme";
import { FF_MONO, FS_SM, FS_XS } from "../../theme";
import { Select } from "../ui";
import { PreviousLogsToggle } from "./PreviousControls";
import { TAIL_OPTIONS } from "../../lib/logSources";

// Shared control strip for all three log surfaces — the slide-in overlay
// (`LogPanel`), the single-pod detail tab (`InlineLogTab`) and the workload
// detail tab (`InlineWorkloadLogTab`). Before this the three hand-rolled the
// same container Select / previous toggle / status pill with subtly diverged
// styling; now the anatomy lives here once. Purely presentational — every bit
// of state (container, previous, tail, muted set) is owned by the caller.

const CONTROL_H = 26;
const RADIUS = "var(--fs-radius-sm, 4px)";
// Popover min width for the tail picker — fits the longest label ("all
// history") without clipping. See the `popoverMinWidth` note below.
const TAIL_POPOVER_MIN_W = 150;

// `null` tail (whole history) can't be a Select value, so encode it as the
// sentinel string "all" on the wire between the Select and the caller.
const ALL = "all";
function encodeTail(v: number | null): string {
  return v == null ? ALL : String(v);
}
function decodeTail(v: string): number | null {
  return v === ALL ? null : Number(v);
}

export type LogToolbarMode =
  | {
      kind: "single";
      // Every container on the pod. A lone container renders as static text
      // (nothing to pick); 2+ get the Select.
      containers: string[];
      active: string | null;
      onContainer: (c: string) => void;
      // Pre-measured so the popover fits the longest container name (see
      // InlineLogTab's canvas measurement) rather than the trigger width.
      popoverMinWidth?: number;
      previous: boolean;
      onPrevious: (v: boolean) => void;
    }
  | {
      kind: "aggregated";
      podCount: number;
      streamCount: number;
      // Streams dropped by the MAX_LOG_SOURCES cap (0 when none).
      dropped: number;
      // Distinct container names across the resolved pods (see
      // `containerUniverse`). Rendered as mute toggles — muting one drops it
      // from every pod's merged stream.
      universe: string[];
      excluded: ReadonlySet<string>;
      onToggleContainer: (c: string) => void;
    };

export function LogToolbar({
  t,
  mode,
  tailLines,
  onTailLines,
  statusLabel,
  statusDetail,
  statusColor,
  statusNode,
  rightExtra,
  style,
}: {
  t: Tokens;
  mode: LogToolbarMode;
  tailLines: number | null;
  onTailLines: (v: number | null) => void;
  // Simple status: a coloured label (used by the two detail tabs). Ignored when
  // `statusNode` is supplied.
  statusLabel?: string;
  statusDetail?: string | null;
  statusColor?: string;
  // Rich status: a caller-rendered element (the overlay panel passes its
  // `StatusPill`-based `StreamStatus`). Takes precedence over `statusLabel`.
  statusNode?: ReactNode;
  // Rendered after the status (e.g. a warnings badge). Kept generic so the
  // toolbar doesn't grow a prop per surface.
  rightExtra?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        ...style,
      }}
    >
      {mode.kind === "single" ? (
        <SingleControls t={t} mode={mode} />
      ) : (
        <AggregatedControls t={t} mode={mode} />
      )}

      <Select
        t={t}
        fullWidth={false}
        value={encodeTail(tailLines)}
        onChange={(v) => onTailLines(decodeTail(v))}
        options={TAIL_OPTIONS.map((o) => ({
          value: encodeTail(o.value),
          label: o.label,
        }))}
        // Without a min width the popover inherits the (narrow) trigger width
        // and clips the option labels ("all history", "5k lines"). Pin it wide
        // enough for the longest label.
        popoverMinWidth={TAIL_POPOVER_MIN_W}
        style={{
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          height: CONTROL_H,
          padding: "3px 28px 3px 8px",
        }}
      />

      {statusNode !== undefined ? (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          {statusNode}
        </div>
      ) : (
        <span
          title={statusDetail ?? undefined}
          style={{
            marginLeft: "auto",
            fontSize: FS_SM,
            color: statusColor,
            fontFamily: FF_MONO,
          }}
        >
          {statusLabel}
        </span>
      )}
      {rightExtra}
    </div>
  );
}

function SingleControls({
  t,
  mode,
}: {
  t: Tokens;
  mode: Extract<LogToolbarMode, { kind: "single" }>;
}) {
  return (
    <>
      {mode.containers.length > 1 ? (
        <Select
          t={t}
          fullWidth={false}
          value={mode.active ?? ""}
          onChange={(v) => mode.onContainer(v)}
          options={mode.containers.map((c) => ({ value: c, label: c }))}
          popoverMinWidth={mode.popoverMinWidth}
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            height: CONTROL_H,
            padding: "3px 28px 3px 8px",
          }}
        />
      ) : (
        <span style={{ fontSize: FS_SM, color: t.textMuted, fontFamily: FF_MONO }}>
          container: {mode.active ?? "—"}
        </span>
      )}
      <PreviousLogsToggle t={t} active={mode.previous} onToggle={mode.onPrevious} />
    </>
  );
}

function AggregatedControls({
  t,
  mode,
}: {
  t: Tokens;
  mode: Extract<LogToolbarMode, { kind: "aggregated" }>;
}) {
  return (
    <>
      <span style={{ fontSize: FS_SM, color: t.textMuted, fontFamily: FF_MONO }}>
        {mode.podCount} pods · {mode.streamCount} streams
        {mode.dropped > 0 ? ` (+${mode.dropped} over cap)` : ""}
      </span>
      {mode.universe.length > 1 && (
        <div
          style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
        >
          <span style={{ fontSize: FS_XS, color: t.textMuted }}>containers:</span>
          {mode.universe.map((c) => {
            const muted = mode.excluded.has(c);
            const hint = muted
              ? `${c} muted — click to include`
              : `Mute ${c} across all pods`;
            return (
              <button
                key={c}
                type="button"
                onClick={() => mode.onToggleContainer(c)}
                title={hint}
                aria-label={hint}
                aria-pressed={!muted}
                style={{
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  height: 22,
                  padding: "0 8px",
                  borderRadius: RADIUS,
                  border: `1px solid ${muted ? t.borderSoft : t.border}`,
                  background: muted ? "transparent" : t.chip,
                  color: muted ? t.textMuted : t.textDim,
                  textDecoration: muted ? "line-through" : "none",
                  cursor: "pointer",
                }}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
