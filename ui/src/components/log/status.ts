import type { LogStatus } from "./LogView";

// Terse, glanceable label for a log stream's status — rendered in the
// chrome (LogPanel pill / InlineLogTab status text). The full reason
// behind an `ended` / `error` / `waiting` status is intentionally NOT
// inlined here: it already shows in the log body (the system
// "— stream ended:" line, the `waiting` placeholder, or the ErrorBlock),
// so repeating it in the chrome was a duplicate. Surface it as a hover
// tooltip via `streamStatusDetail` instead.
export function streamStatusLabel(
  status: LogStatus,
  paused: boolean,
  bufferedCount: number,
): string {
  if (paused) {
    return bufferedCount > 0 ? `paused · ${bufferedCount} buffered` : "paused";
  }
  switch (status.kind) {
    case "starting":
      return "connecting…";
    case "streaming":
      return "streaming";
    case "waiting":
      return "waiting for container…";
    case "ended":
      return "ended";
    case "error":
      return "error";
  }
}

// The detail string behind a status — surfaced as a tooltip/title in the
// chrome so the operator can still read it on hover without cluttering
// the inline label or duplicating the body. `null` when there's nothing
// extra to show.
export function streamStatusDetail(status: LogStatus): string | null {
  switch (status.kind) {
    case "waiting":
    case "ended":
      return status.reason;
    case "error":
      return status.message;
    default:
      return null;
  }
}
