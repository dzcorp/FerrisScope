import {
  statusDot,
  statusIsAmbient,
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

// Status label: a short bar in the bucket color plus the status in body text.
// Transient statuses breathe (`.fs-breathe`). Compact mode drops the text for
// ambient statuses (`statusIsAmbient`).

export function StatusPill({ status, t, dense, compact }: Props) {
  const bar = (
    <span
      data-status-bar=""
      className={statusIsTransient(status) ? "fs-breathe" : undefined}
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: 3,
        // em so the bar follows each theme's type scale.
        height: "0.95em",
        borderRadius: 2,
        background: statusDot(status, t),
      }}
    />
  );

  if (compact && statusIsAmbient(status)) {
    return (
      <Tooltip label={status}>
        <span
          role="img"
          aria-label={status}
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: dense ? 14 : 18,
            fontSize: dense ? "var(--fs-fs-sm, 11px)" : "var(--fs-fs-md, 12.5px)",
          }}
        >
          {bar}
        </span>
      </Tooltip>
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: dense ? 5 : 7,
        color: t.text,
        fontSize: dense ? "var(--fs-fs-sm, 11px)" : "var(--fs-fs-md, 12.5px)",
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {bar}
      {status}
    </span>
  );
}
