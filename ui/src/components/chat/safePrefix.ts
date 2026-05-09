// Streaming-render hold-back utility.
//
// Token-by-token markdown streams flash partial constructs:
// `[label](htt` is rendered as raw text, then "jumps" to a proper link
// once the close `)` arrives. This module gives us the safe-prefix
// boundary — the longest prefix that doesn't end mid-construct — so the
// bubble renders the head and holds the tail until it's safe.
//
// Hard cap: if we'd hold back more than MAX_HOLDBACK_CHARS waiting for
// a close, we flush everything anyway. Streaming UX beats theoretical
// correctness when the model produces malformed output (or just took a
// long pause inside a long URL).

/** Cap on held-back chars. Above this we flush — usually means malformed
 * output, and a stalled bubble is worse than briefly-mid-render markdown. */
export const MAX_HOLDBACK_CHARS = 200;

/**
 * Length of the longest prefix of `text` safe to render as markdown
 * mid-stream. The slice `text.slice(0, safePrefixLength(text))` is what
 * the bubble renders; the remainder waits for the next delta.
 *
 * Detects mid-stream:
 *   - Inline link in progress: `[label]` or `[label](url` not closed.
 *   - Inline code in progress: a backtick on a line not yet matched.
 *   - Bold / strike in progress: unmatched `**` or `~~` markers.
 *   - Pipe-table row in progress: line starts with `|` and lacks `\n`.
 *
 * Inside a fenced code block (open ``` without a matching close yet)
 * the entire text is safe to render — the markdown renderer treats the
 * unclosed fence as an open code block and shows the body verbatim, no
 * inline-construct races.
 */
export function safePrefixLength(text: string): number {
  if (!text) return 0;

  // Open fenced code? Body renders fine as-is.
  if (insideOpenFence(text)) return text.length;

  let cut: number | null = null;
  const note = (i: number) => {
    if (cut === null || i < cut) cut = i;
  };

  noteUnclosedLink(text, note);
  noteUnclosedInlineCode(text, note);
  noteUnclosedRun(text, "**", note);
  noteUnclosedRun(text, "~~", note);
  noteMidLineTableRow(text, note);

  if (cut === null) return text.length;
  if (text.length - cut > MAX_HOLDBACK_CHARS) return text.length;
  return cut;
}

function insideOpenFence(text: string): boolean {
  // Count lines that begin with three backticks. Odd = open. We don't
  // care about info strings or nested fences — the renderer's parse is
  // line-oriented and treats an open fence as "everything until close
  // is code body", so this binary check is enough.
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) count++;
  }
  return count % 2 === 1;
}

/** `[label]` or `[label](url` not closed. */
function noteUnclosedLink(text: string, note: (i: number) => void): void {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("[", i);
    if (open === -1) return;
    if (open > 0 && text[open - 1] === "\\") {
      i = open + 1;
      continue;
    }
    const closeBracket = text.indexOf("]", open + 1);
    if (closeBracket === -1) {
      note(open);
      return;
    }
    if (text[closeBracket + 1] === "(") {
      const closeParen = text.indexOf(")", closeBracket + 2);
      if (closeParen === -1) {
        note(open);
        return;
      }
      i = closeParen + 1;
    } else {
      i = closeBracket + 1;
    }
  }
}

/** Single-line inline code: a backtick run on a non-fence line not
 * matched by an equal-length close run. We pair backticks line-by-line
 * since markdown inline code doesn't span newlines. */
function noteUnclosedInlineCode(text: string, note: (i: number) => void): void {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      // Fence delimiter, handled elsewhere.
      offset += line.length + 1;
      continue;
    }
    let p = 0;
    let openAt = -1;
    let openRun = 0;
    while (p < line.length) {
      if (line[p] !== "`") {
        p++;
        continue;
      }
      const start = p;
      let n = 0;
      while (p < line.length && line[p] === "`") {
        n++;
        p++;
      }
      if (openAt === -1) {
        openAt = start;
        openRun = n;
      } else if (n === openRun) {
        openAt = -1;
        openRun = 0;
      } else {
        // Mismatched run length — keep the original open marker, the
        // close hasn't arrived. (We don't try multi-line runs.)
      }
    }
    if (openAt !== -1) note(offset + openAt);
    offset += line.length + 1;
  }
}

/** Unmatched run of an emphasis marker (`**` or `~~`). Counts pair-wise
 * across the whole text — odd count means the last open hasn't closed. */
function noteUnclosedRun(text: string, marker: string, note: (i: number) => void): void {
  const positions: number[] = [];
  let p = 0;
  while (true) {
    const idx = text.indexOf(marker, p);
    if (idx === -1) break;
    // Skip escapes (`\**`).
    if (idx > 0 && text[idx - 1] === "\\") {
      p = idx + 1;
      continue;
    }
    positions.push(idx);
    p = idx + marker.length;
  }
  if (positions.length % 2 === 1) {
    note(positions[positions.length - 1]!);
  }
}

/** A trailing line that starts with optional whitespace + `|` and
 * hasn't been terminated by `\n` is a mid-render table row. */
function noteMidLineTableRow(text: string, note: (i: number) => void): void {
  const lastNL = text.lastIndexOf("\n");
  const tail = text.slice(lastNL + 1);
  if (tail.length === 0) return;
  if (/^\s*\|/.test(tail)) note(lastNL + 1);
}
