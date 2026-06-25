// Normalises an xterm `getSelection()` string before it lands on the system
// clipboard.
//
// On Linux/webkit2gtk xterm v6 already returns clean text: rows joined with
// `\n`, soft-wrapped rows merged (no spurious newline), trailing whitespace
// trimmed per line. The two things it does NOT do — and that bite operators —
// are platform-consistent line endings and dropping the trailing newline:
//
//   * Windows joins rows with `\r\n`; some paste targets render the `\n` away
//     and collapse multi-line copies onto one line. We collapse `\r\n` (and any
//     lone `\r` from carriage-return redraws) to a single `\n`.
//   * A selection that reaches the end of a line carries a trailing newline.
//     Pasted into a shell that newline auto-executes the command; pasted into
//     an editor it leaves a stray blank line. We strip trailing whitespace and
//     leading blank lines, but preserve the first real line's indentation
//     (matters when copying nested YAML / code out of a `kubectl` pager).
//
// `eol` controls the line ending of the result. We always normalise internally
// to LF (so trimming is uniform), then re-emit CRLF on Windows so the copy
// matches what native Windows apps expect — caller passes `"crlf"` when
// `IS_WINDOWS`, `"lf"` (the default) on macOS / Linux.
export function normalizeTerminalSelection(
  sel: string,
  eol: "lf" | "crlf" = "lf",
): string {
  if (!sel) return "";
  const lf = sel
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}
