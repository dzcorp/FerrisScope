// Pure helpers shared by detail-panel summary components. Kept tiny and
// dependency-free so any kind's summary can use them without pulling React
// or theme tokens.

// Format an ISO-8601 timestamp as a relative duration suffix-free string
// ("3m", "5h", "2d"). Returns "—" for inputs that don't parse.
export function ageFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
