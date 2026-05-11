// Shared parsing for kube log lines. The backend now requests
// `timestamps: true`, so every line arrives with a leading RFC3339Nano
// prefix (e.g. `2024-01-01T12:34:56.789012345Z body…`). Both log
// surfaces (`InlineLogTab` and the full-overlay `LogPanel`) split it
// off the body the same way.

// Match `YYYY-MM-DDTHH:MM:SS(.fraction)?Z ` — kube apiserver always
// emits UTC nanoseconds, but we tolerate any fractional precision plus
// the no-fraction form.
const RFC3339_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

export function splitTimestamp(line: string): {
  ts: string | null;
  text: string;
} {
  // Only inspect the prefix region — `match` against a slice is faster
  // than a regex with `^` against a multi-KB string in V8.
  const head = line.length > 40 ? line.slice(0, 40) : line;
  const m = RFC3339_RE.exec(head);
  if (!m) return { ts: null, text: line };
  const d = new Date(m[1]!);
  if (Number.isNaN(d.getTime())) return { ts: null, text: line };
  const ts =
    `${d.getHours().toString().padStart(2, "0")}:` +
    `${d.getMinutes().toString().padStart(2, "0")}:` +
    `${d.getSeconds().toString().padStart(2, "0")}.` +
    `${d.getMilliseconds().toString().padStart(3, "0")}`;
  return { ts, text: line.slice(m[0].length) };
}
