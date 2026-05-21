// Pure helpers for the in-place log find bar. Kept React-free so the matching
// and highlight-splitting logic can be unit-tested without rendering a
// virtualized list. `LogView` owns the find UI; these own the string work.

import { stripAnsi } from "./ansi";

// Indices (into `lines`) of every line whose *visible* text contains `query`,
// case-insensitive. ANSI escape codes are stripped before matching so a search
// for "error" still hits a red-coloured `\x1b[31merror\x1b[0m` line. A blank
// query matches nothing — the find bar shows "0" rather than selecting every
// line.
export function findLogMatches(
  lines: { text: string }[],
  query: string,
): number[] {
  const q = query.toLowerCase();
  if (q.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (stripAnsi(lines[i]!.text).toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

export type HighlightSegment = { text: string; match: boolean };

// Split `text` into alternating non-match / match segments for `query`
// (case-insensitive, non-overlapping, left-to-right). Used to render
// <mark>-style highlights on matched lines while preserving the original
// casing of the source text. An empty query (or empty text) returns the whole
// string as a single non-match segment, so callers can detect "no highlight"
// via `segments.length === 1 && !segments[0].match`.
export function splitHighlight(
  text: string,
  query: string,
): HighlightSegment[] {
  if (query.length === 0 || text.length === 0) {
    return [{ text, match: false }];
  }
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: HighlightSegment[] = [];
  let from = 0;
  let idx = hay.indexOf(needle, from);
  while (idx !== -1) {
    if (idx > from) out.push({ text: text.slice(from, idx), match: false });
    out.push({ text: text.slice(idx, idx + needle.length), match: true });
    from = idx + needle.length;
    idx = hay.indexOf(needle, from);
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return out;
}
