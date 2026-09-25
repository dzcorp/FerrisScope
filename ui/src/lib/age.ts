import { useEffect, useState } from "react";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/// Parsed epoch ms of an ISO timestamp, or null.
function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/// "42s" / "5m" / "3h" / "12d", or "—" when `value` isn't a timestamp.
export function formatAge(value: unknown, nowMs: number): string {
  const t = parseIso(value);
  if (t === null) return "—";
  const age = Math.max(0, nowMs - t);
  if (age < MINUTE) return `${Math.floor(age / SECOND)}s`;
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  return `${Math.floor(age / DAY)}d`;
}

/// Milliseconds until `formatAge` would print something else, or null when
/// it never will ("—").
export function msUntilAgeChanges(value: unknown, nowMs: number): number | null {
  const t = parseIso(value);
  if (t === null) return null;
  const age = Math.max(0, nowMs - t);
  const unit = age < MINUTE ? SECOND : age < HOUR ? MINUTE : age < DAY ? HOUR : DAY;
  return unit - (age % unit);
}

/// Live age label that re-renders only when its text changes: every second
/// under a minute, then once a minute, hour or day.
export function useAgeLabel(value: unknown): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = msUntilAgeChanges(value, now);
    if (wait === null) return;
    const id = setTimeout(() => setNow(Date.now()), wait + 5);
    return () => clearTimeout(id);
  }, [value, now]);
  return formatAge(value, now);
}
