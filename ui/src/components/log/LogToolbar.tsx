import type { CSSProperties, ReactNode } from "react";
import type { Tokens } from "../../theme";
import { FF_MONO, FS_SM } from "../../theme";
import { Select } from "../ui";
import { PreviousLogsToggle } from "./PreviousControls";
import { TAIL_OPTIONS } from "../../lib/logSources";
import { containerLabel } from "../../lib/podContainers";
import { ContainerMuteMenu } from "./ContainerMuteMenu";
import type { LogContainer } from "../../types";

// Shared control strip for all three log surfaces — the slide-in overlay
// (`LogPanel`), the single-pod detail tab (`InlineLogTab`) and the workload
// detail tab (`InlineWorkloadLogTab`). Before this the three hand-rolled the
// same container Select / previous toggle / status pill with subtly diverged
// styling; now the anatomy lives here once. Purely presentational — every bit
// of state (container, previous, tail, muted set) is owned by the caller.

const CONTROL_H = 26;
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
      // Every loggable container on the pod — init containers and native
      // sidecars included, in picker order (see `orderContainers`). A lone
      // container renders as static text (nothing to pick); 2+ get the Select.
      containers: LogContainer[];
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
      // Pods the source rail currently has selected — usually fewer than
      // `podCount` once a selection exceeds the stream budget.
      selectedPodCount: number;
      streamCount: number;
      // Streams dropped by the MAX_LOG_SOURCES cap (0 when none).
      dropped: number;
      // Distinct containers across the resolved pods (see `containerUniverse`).
      // Rendered as mute toggles — muting one drops it from every pod's merged
      // stream.
      universe: LogContainer[];
      excluded: ReadonlySet<string>;
      onToggleContainer: (c: string) => void;
      // Source-rail disclosure. The rail itself renders below the toolbar (it
      // needs the full panel width), so the toolbar only owns the trigger.
      railOpen: boolean;
      onToggleRail: () => void;
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
          // Value stays the bare container name (that's what the kubelet takes);
          // only the label carries the "(init)" / "(sidecar)" suffix.
          options={mode.containers.map((c) => ({
            value: c.name,
            label: containerLabel(c),
          }))}
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
          container: {mode.containers[0] ? containerLabel(mode.containers[0]) : "—"}
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
      <button
        type="button"
        onClick={mode.onToggleRail}
        aria-expanded={mode.railOpen}
        title="Choose which pods stream"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 22,
          padding: "0 8px",
          borderRadius: "var(--fs-radius-sm, 4px)",
          border: `1px solid ${mode.dropped > 0 ? t.warn : t.border}`,
          background: t.chip,
          color: t.textDim,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          cursor: "pointer",
        }}
      >
        {mode.selectedPodCount}/{mode.podCount} pods · {mode.streamCount} streams
        {/* `dropped` means the selection still exceeds the budget — the rail is
            where that gets resolved, so point at it rather than just reporting
            the overflow. */}
        {mode.dropped > 0 ? ` · +${mode.dropped} over cap` : ""}
      </button>
      <ContainerMuteMenu
        t={t}
        universe={mode.universe}
        excluded={mode.excluded}
        onToggle={mode.onToggleContainer}
      />
    </>
  );
}
