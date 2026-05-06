import {
  statusDot,
  statusFill,
  statusIsTransient,
  type ThemeMode,
  type Tokens,
} from "../../theme";
import { Tooltip } from "./Tooltip";

type Props = {
  status: string;
  t: Tokens;
  mode: ThemeMode;
  dense?: boolean;
  compact?: boolean;
};

// Status badge — one rule per bucket per P5. Compact mode renders ambient
// statuses (Running, Terminating) as a bare dot since the color carries
// enough meaning in dense tables.
const AMBIENT = new Set(["Running", "Terminating"]);

export function StatusPill({ status, t, mode, dense, compact }: Props) {
  const transient = statusIsTransient(status);
  const dot = statusDot(status, t);

  if (compact && AMBIENT.has(status)) {
    const dotSize = dense ? 7 : 8;
    return (
      <Tooltip label={status}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: dense ? 14 : 18,
          }}
        >
          <span
            className={transient ? "fs-pulse-dot" : undefined}
            style={{
              width: dotSize,
              height: dotSize,
              borderRadius: "50%",
              background: dot,
              display: "inline-block",
            }}
          />
        </span>
      </Tooltip>
    );
  }

  const fill = statusFill(status, t, mode);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: dense ? 4 : 6,
        padding: dense ? "1px 6px" : "2px 8px",
        borderRadius: dense ? 3 : 10,
        background: fill.bg,
        color: fill.fg,
        fontSize: dense ? 10.5 : 11,
        fontWeight: 600,
        letterSpacing: dense ? 0 : -0.1,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      <span
        className={transient ? "fs-pulse-dot" : undefined}
        style={{
          width: dense ? 5 : 6,
          height: dense ? 5 : 6,
          borderRadius: 3,
          background: dot,
        }}
      />
      {status}
    </span>
  );
}
