import { memo, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { FONT_MONO, type Tokens } from "../../theme";
import { api } from "../../api";
import { useAppStore } from "../../store";

// Minimal Markdown renderer for chat. Handles the formats the system prompt
// asks the assistant to use:
//   - paragraphs (blank-line separated; single \n folded to a space, GFM-style)
//   - fenced code blocks (``` with optional language) with one-click copy
//   - inline code (`…`)
//   - **bold**, *italic* / _italic_, ~~strikethrough~~
//   - unordered lists (- / *), ordered lists (1.), task lists (- [ ] / - [x])
//   - headings (## and ###); # is intentionally not styled differently
//   - inline [text](url) AND bare http(s):// URLs (auto-linkified)
//   - GitHub-flavoured pipe tables (header row + ---|---|--- separator)
//   - horizontal rule (---)
//
// Deliberately small: no blockquotes, no images, no nested lists. We can
// extend incrementally as the assistant's output gets fancier — the goal is
// "looks right for kubectl-flavoured operator answers", not "ships
// CommonMark spec coverage". The assistant is told to stay within this set.

type Props = {
  text: string;
  t: Tokens;
};

// Memoized so a parent re-render with the same text+tokens skips the parse
// + render entirely. Tokens are stable per ThemeMode (see theme.ts), so
// the default shallow comparison is the right one. parseBlocks is also
// memoized via useMemo on `text`; useful when the same text re-renders
// because of unrelated state higher up.
export const Markdown = memo(function Markdown({ text, t }: Props) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {blocks.map((b, i) => renderBlock(b, i, t))}
    </div>
  );
});

// ─── Block-level parse ──────────────────────────────────────────────────────

type Align = "left" | "right" | "center";

type ListItem = { text: string; checked: boolean | null };

type Block =
  | { kind: "p"; text: string }
  | { kind: "code"; lang: string; body: string }
  | { kind: "h"; level: 2 | 3; text: string }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] }
  | { kind: "hr" }
  | {
      kind: "table";
      headers: string[];
      rows: string[][];
      aligns: Align[];
    };

function parseBlocks(input: string): Block[] {
  const lines = input.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.push({ kind: "code", lang, body: body.join("\n") });
      continue;
    }
    // Heading (## / ###). Treat # the same as ## so a stray top-level header
    // still renders sensibly.
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const hashes = heading[1] ?? "";
      const level: 2 | 3 = hashes.length >= 3 ? 3 : 2;
      out.push({ kind: "h", level, text: heading[2] ?? "" });
      i++;
      continue;
    }
    // GFM-style pipe table. Requires the next line to be a separator row
    // (`| --- | :---: | ---: |`); otherwise the line is treated as paragraph
    // text so a stray `|` in prose doesn't try to become a table.
    if (line.includes("|") && i + 1 < lines.length) {
      const sep = lines[i + 1] ?? "";
      if (TABLE_SEPARATOR_RE.test(sep)) {
        const headers = splitTableRow(line);
        if (headers.length > 0) {
          const aligns = parseAligns(sep, headers.length);
          const rows: string[][] = [];
          i += 2;
          while (i < lines.length) {
            const cur = lines[i] ?? "";
            if (cur.trim() === "" || !cur.includes("|")) break;
            // A separator row inside the body is not a data row — bail.
            if (TABLE_SEPARATOR_RE.test(cur)) break;
            rows.push(padRow(splitTableRow(cur), headers.length));
            i++;
          }
          out.push({ kind: "table", headers, rows, aligns });
          continue;
        }
      }
    }
    // Horizontal rule. Match before lists so `---` alone isn't read as a
    // bare bullet.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    // Bulleted / numbered list. Collect contiguous list lines, recognising
    // `- [ ]` / `- [x]` task-list markers up front.
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        const m = ordered
          ? /^\s*\d+\.\s+(.*)$/.exec(cur)
          : /^\s*[-*]\s+(.*)$/.exec(cur);
        if (!m) break;
        const rest = m[1] ?? "";
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(rest);
        if (task) {
          items.push({
            text: task[2] ?? "",
            checked: (task[1] ?? "") !== " ",
          });
        } else {
          items.push({ text: rest, checked: null });
        }
        i++;
      }
      out.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    // Blank line — separator.
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph: collect until blank line / list / heading / fence / table.
    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (cur.trim() === "") break;
      if (/^```/.test(cur)) break;
      if (/^#{1,3}\s+/.test(cur)) break;
      if (/^\s*[-*]\s+/.test(cur)) break;
      if (/^\s*\d+\.\s+/.test(cur)) break;
      // Table-start guard: stop the paragraph if the next two lines look
      // like a header + separator pair.
      if (cur.includes("|") && i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        if (TABLE_SEPARATOR_RE.test(next)) break;
      }
      buf.push(cur);
      i++;
    }
    out.push({ kind: "p", text: buf.join("\n") });
  }
  return out;
}

// Pipe-table helpers. The separator row uses dashes (any number ≥ 1; GFM
// canonical is 3 but real-world models routinely emit `|-|-|` or `|--|--|`),
// optional `:` on either end for alignment, and at least two columns so a
// bare `---` line stays a horizontal rule.
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?\s*$/;

function splitTableRow(line: string): string[] {
  // Strip outer leading/trailing pipes so we don't get empty cells.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function parseAligns(sep: string, count: number): Align[] {
  const cells = splitTableRow(sep);
  const out: Align[] = [];
  for (let i = 0; i < count; i++) {
    const c = cells[i] ?? "---";
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    out.push(left && right ? "center" : right ? "right" : "left");
  }
  return out;
}

function padRow(cells: string[], width: number): string[] {
  if (cells.length >= width) return cells.slice(0, width);
  return [...cells, ...Array(width - cells.length).fill("")];
}

// ─── Block render ───────────────────────────────────────────────────────────

function renderBlock(b: Block, key: number, t: Tokens): ReactNode {
  switch (b.kind) {
    case "p":
      // CommonMark folds a single newline inside a paragraph into a space.
      // We keep that behaviour so wrapped output from the model doesn't
      // render as a jagged column.
      return (
        <div key={key} style={{ lineHeight: 1.5, wordBreak: "break-word" }}>
          {renderInline(b.text.replace(/\n/g, " "), t)}
        </div>
      );
    case "code":
      return <CodeBlock key={key} lang={b.lang} body={b.body} t={t} />;
    case "h": {
      const fs = b.level === 2 ? 14 : 13;
      return (
        <div
          key={key}
          style={{
            fontSize: fs,
            fontWeight: 600,
            color: t.text,
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {renderInline(b.text, t)}
        </div>
      );
    }
    case "ul":
    case "ol": {
      const hasTask = b.items.some((it) => it.checked !== null);
      return (
        <ul
          key={key}
          style={{
            margin: 0,
            paddingLeft: hasTask ? 4 : 20,
            display: "flex",
            flexDirection: "column",
            gap: 3,
            listStyleType: hasTask
              ? "none"
              : b.kind === "ol"
                ? "decimal"
                : "disc",
          }}
        >
          {b.items.map((it, j) => (
            <li
              key={j}
              style={{
                lineHeight: 1.5,
                display: it.checked === null ? "list-item" : "flex",
                alignItems: it.checked === null ? undefined : "baseline",
                gap: it.checked === null ? undefined : 8,
              }}
            >
              {it.checked !== null && (
                <input
                  type="checkbox"
                  checked={it.checked}
                  readOnly
                  tabIndex={-1}
                  style={{
                    margin: 0,
                    pointerEvents: "none",
                    accentColor: t.accent,
                    flexShrink: 0,
                  }}
                />
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                {renderInline(it.text, t)}
              </span>
            </li>
          ))}
        </ul>
      );
    }
    case "hr":
      return (
        <hr
          key={key}
          style={{
            border: "none",
            borderTop: `1px solid ${t.borderSoft}`,
            margin: "4px 0",
          }}
        />
      );
    case "table":
      return <TableBlock key={key} block={b} t={t} />;
  }
}

function TableBlock({
  block,
  t,
}: {
  block: Extract<Block, { kind: "table" }>;
  t: Tokens;
}) {
  const cellPad = "5px 9px";
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 12.5,
          lineHeight: 1.4,
          width: "100%",
          tableLayout: "auto",
        }}
      >
        <thead>
          <tr>
            {block.headers.map((h, j) => (
              <th
                key={j}
                style={{
                  textAlign: block.aligns[j] ?? "left",
                  padding: cellPad,
                  borderBottom: `1px solid ${t.border}`,
                  background: t.surfaceAlt,
                  fontWeight: 600,
                  color: t.text,
                  // Headers are short labels — keep them on one line so
                  // single-word captions like "Status" don't break apart
                  // letter-by-letter when an adjacent cell is wide.
                  whiteSpace: "nowrap",
                  verticalAlign: "bottom",
                }}
              >
                {renderInline(h, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  style={{
                    textAlign: block.aligns[ci] ?? "left",
                    padding: cellPad,
                    borderBottom: `1px solid ${t.borderSoft}`,
                    color: t.text,
                    verticalAlign: "top",
                    // Wrap normally at spaces; only break inside an
                    // unbreakable token (e.g. a long URL) when it would
                    // otherwise overflow. Crucially this — unlike
                    // `word-break: break-word` — does NOT break ordinary
                    // multi-letter words mid-letter.
                    overflowWrap: "anywhere",
                  }}
                >
                  {renderInline(cell, t)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({
  lang,
  body,
  t,
}: {
  lang: string;
  body: string;
  t: Tokens;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard
      .writeText(body)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  return (
    <div
      style={{
        background: t.surfaceAlt,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "3px 8px",
          borderBottom: `1px solid ${t.borderSoft}`,
          minHeight: 18,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 0.4,
            textTransform: "lowercase",
          }}
        >
          {lang || ""}
        </div>
        <button
          type="button"
          onClick={onCopy}
          title="Copy"
          style={{
            background: "transparent",
            border: "none",
            color: copied ? t.good : t.textDim,
            fontFamily: FONT_MONO,
            fontSize: 10,
            cursor: "pointer",
            letterSpacing: 0.4,
            textTransform: "uppercase",
            padding: "0 2px",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          color: t.text,
          background: "transparent",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {body}
      </pre>
    </div>
  );
}

// ─── Inline render ──────────────────────────────────────────────────────────

const INLINE_CODE_STYLE = (t: Tokens): CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: "0.92em",
  background: t.surfaceAlt,
  border: `1px solid ${t.borderSoft}`,
  borderRadius: 3,
  padding: "0 4px",
});

const LINK_STYLE = (t: Tokens): CSSProperties => ({
  color: t.accent,
  textDecoration: "underline",
  cursor: "pointer",
});

// In-app deep links get a chip-ish look so the operator can tell at a glance
// they're navigation (single click → state change) rather than outbound
// (single click → leaves the app).
const FS_LINK_STYLE = (t: Tokens): CSSProperties => ({
  color: t.accent,
  textDecoration: "none",
  cursor: "pointer",
  background: t.surfaceAlt,
  border: `1px solid ${t.borderSoft}`,
  borderRadius: 3,
  padding: "0 5px",
  fontSize: "0.95em",
  display: "inline-flex",
  alignItems: "baseline",
});

// Word-character lookbehind helper for emphasis. Italic only fires when the
// opening marker is at start-of-string or follows a non-word char, AND when
// the closing marker is followed by EOS or a non-word char. That keeps
// `pod_name_var` from rendering `name` as italic — the markers are between
// word chars on both sides.
function isWord(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_]/.test(ch);
}

// Trailing punctuation that should NOT be eaten into an autolinked URL.
// Common case: "see https://example.org/foo." — the dot belongs to the
// sentence, not the URL. Same for trailing `)`, `]`, `>`, `,`, `;`, `:`.
const URL_TRAIL_PUNCT = ".,;:!?)]}>'\"";

function bareUrlAt(text: string, i: number): { url: string; len: number } | null {
  // Match http(s):// for outbound links AND `ferrisscope://` for in-app
  // navigation links the agent can synthesise. The OS opener handles the
  // first; the in-app router (executeFsUrl) handles the second.
  const slice = text.slice(i);
  const m = /^(?:https?|ferrisscope):\/\/[^\s<>`"'\\]+/u.exec(slice);
  if (!m) return null;
  let url = m[0];
  // Strip trailing punctuation. Walk back while the last char is in the
  // trail-punct set — handles `(see https://x.org/y).` and `https://x?a=1.`.
  while (url.length > 0 && URL_TRAIL_PUNCT.includes(url.slice(-1))) {
    url = url.slice(0, -1);
  }
  // Balance parens: if the URL has more `)` than `(`, peel back the extras.
  // Wikipedia / docs URLs commonly contain balanced parens we want to keep.
  let opens = 0;
  let closes = 0;
  for (const ch of url) {
    if (ch === "(") opens++;
    else if (ch === ")") closes++;
  }
  while (closes > opens && url.endsWith(")")) {
    url = url.slice(0, -1);
    closes--;
  }
  if (url.length < 8) return null; // shorter than "http://a"
  return { url, len: url.length };
}

// ─── In-app deep links ──────────────────────────────────────────────────────
//
// The agent can synthesise `ferrisscope://` URLs that, when clicked, drive
// the FerrisScope UI directly: switch kind, open a resource detail panel,
// switch cluster. Forms accepted by [`parseFsUrl`]:
//
//   ferrisscope://resource/<kind>/<namespace>/<name>
//     Open the detail panel for a namespaced resource. <kind> is matched
//     against ResourceKind.id ("pods", "deployments", "helm_releases", …)
//     first, then against ResourceKind.kind ("Pod", "Deployment", …) so the
//     agent can use whichever it knows.
//
//   ferrisscope://resource/<kind>/-/<name>
//     Same, but for cluster-scoped resources (Node, Namespace,
//     ClusterRole, …) — the literal `-` segment stands for "no namespace".
//
//   ferrisscope://kind/<kind>
//     Switch the rail to <kind>'s list view (no detail panel).
//
//   ferrisscope://cluster/<context_name>
//     Switch the active cluster. URL-decoded.
//
// Path segments are URL-decoded; spaces / colons / slashes in names work
// when the agent percent-encodes them.

type FsUrlIntent =
  | { kind: "resource"; kindRef: string; namespace: string | null; name: string }
  | { kind: "kindList"; kindRef: string }
  | { kind: "cluster"; context: string };

function parseFsUrl(url: string): FsUrlIntent | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ferrisscope:") return null;
  // `new URL("ferrisscope://resource/pods/foo/bar")` parses host="resource"
  // and pathname="/pods/foo/bar". Treat host + pathname uniformly.
  const head = parsed.host;
  const tail = parsed.pathname.replace(/^\/+/, "").split("/").map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (head === "resource") {
    const [kindRef, ns, name] = tail;
    if (!kindRef || ns === undefined || !name) return null;
    return {
      kind: "resource",
      kindRef,
      namespace: ns === "-" || ns === "" ? null : ns,
      name,
    };
  }
  if (head === "kind") {
    const [kindRef] = tail;
    if (!kindRef) return null;
    return { kind: "kindList", kindRef };
  }
  if (head === "cluster") {
    const [context] = tail;
    if (!context) return null;
    return { kind: "cluster", context };
  }
  return null;
}

function resolveKindId(ref: string): string | null {
  const state = useAppStore.getState();
  // Direct id match first (fast path — most agent links use the canonical id).
  if (state.kinds.some((k) => k.id === ref)) return ref;
  // Then case-insensitive match against the Kubernetes Kind name. Lets the
  // agent get away with `ferrisscope://resource/Pod/...` when it doesn't
  // remember our internal id naming.
  const lower = ref.toLowerCase();
  const byKind = state.kinds.find((k) => k.kind.toLowerCase() === lower);
  if (byKind) return byKind.id;
  // Last-ditch: a stray plural ("pods" was already a hit; "deployments" too;
  // "ingresses" is a kind id; this catches odd phrasings the agent invents).
  const byPlural = state.kinds.find((k) => k.plural.toLowerCase() === lower);
  return byPlural?.id ?? null;
}

function executeFsUrl(intent: FsUrlIntent): void {
  const state = useAppStore.getState();
  switch (intent.kind) {
    case "cluster":
      if (state.selectedContext !== intent.context) {
        state.selectContext(intent.context);
      }
      return;
    case "kindList": {
      const id = resolveKindId(intent.kindRef);
      if (id) state.selectKind(id);
      return;
    }
    case "resource": {
      const id = resolveKindId(intent.kindRef);
      if (id) state.navigateToDetail(id, intent.namespace, intent.name);
      return;
    }
  }
}

function renderLink(url: string, label: ReactNode, t: Tokens, key: number): ReactNode {
  const fsIntent = url.startsWith("ferrisscope://") ? parseFsUrl(url) : null;
  if (fsIntent) {
    return (
      <a
        key={key}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          executeFsUrl(fsIntent);
        }}
        title="Open in FerrisScope"
        style={FS_LINK_STYLE(t)}
      >
        <span style={{ marginRight: 3 }}>↗</span>
        {label}
      </a>
    );
  }
  return (
    <a
      key={key}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        // Plain click → hand off to the OS opener so it lands in the user's
        // default browser, not the embedded webview. Modifier-clicks fall
        // through to the native handler so middle-click / cmd-click still
        // do something sensible (the webview will open them per its own
        // policy — this is belt-and-braces).
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }
        e.preventDefault();
        api.openExternal(url).catch(() => {});
      }}
      style={LINK_STYLE(t)}
    >
      {label}
    </a>
  );
}

function renderInline(text: string, t: Tokens): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // Inline code — highest priority; anything inside is rendered
    // verbatim. EXCEPT: models routinely wrap `[label](url)` link
    // syntax in backticks (often because the system prompt documents
    // the syntax that way), which would otherwise render as literal
    // `[label](url)` text instead of a link. If the code span's body
    // matches a link pattern, recurse on it as inline content so the
    // link parser fires.
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i) {
        const body = text.slice(i + 1, close);
        const linkOnly =
          /^\s*\[[^\]]+\]\s*\([^)]+\)\s*$/.test(body) ? body.trim() : null;
        flush();
        if (linkOnly) {
          out.push(...renderInline(linkOnly, t));
        } else {
          out.push(
            <code key={out.length} style={INLINE_CODE_STYLE(t)}>
              {body}
            </code>,
          );
        }
        i = close + 1;
        continue;
      }
    }
    // Bold (**text**).
    if (c === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close > i + 1) {
        flush();
        out.push(
          <strong key={out.length}>
            {renderInline(text.slice(i + 2, close), t)}
          </strong>,
        );
        i = close + 2;
        continue;
      }
    }
    // Strikethrough (~~text~~).
    if (c === "~" && text[i + 1] === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close > i + 1) {
        flush();
        out.push(
          <s key={out.length} style={{ color: t.textDim }}>
            {renderInline(text.slice(i + 2, close), t)}
          </s>,
        );
        i = close + 2;
        continue;
      }
    }
    // Italic (*text* or _text_). Word-boundary aware: skip when the
    // opener is between two word chars (e.g. inside `pod_name_var`) and
    // require the next char after open to not be whitespace.
    if (c === "*" || c === "_") {
      const prev = text[i - 1];
      const next = text[i + 1];
      const openerOk = !isWord(prev) && next && next !== " " && next !== "\n";
      if (openerOk) {
        const close = text.indexOf(c, i + 1);
        if (close > i + 1) {
          const beforeClose = text[close - 1];
          const afterClose = text[close + 1];
          const closerOk =
            beforeClose !== " " &&
            beforeClose !== "\n" &&
            !isWord(afterClose);
          if (closerOk) {
            flush();
            out.push(
              <em key={out.length}>
                {renderInline(text.slice(i + 1, close), t)}
              </em>,
            );
            i = close + 1;
            continue;
          }
        }
      }
    }
    // Link [text](url). Tolerant of whitespace between `]` and `(` —
    // models sometimes wrap a long link across two lines, and our
    // paragraph collapse (\n→space) leaves a literal `] (url)` that
    // a strict parser rejects. Skip past any spaces / tabs to find
    // the `(`.
    if (c === "[") {
      const closeB = text.indexOf("]", i + 1);
      if (closeB > 0) {
        let openP = closeB + 1;
        while (openP < text.length && (text[openP] === " " || text[openP] === "\t")) {
          openP++;
        }
        if (text[openP] === "(") {
          const closeP = text.indexOf(")", openP + 1);
          if (closeP > 0) {
            flush();
            const linkText = text.slice(i + 1, closeB);
            // URL may have leading whitespace from line-wrap collapse;
            // trim it so the resulting href is clean. Trailing
            // whitespace is similarly stripped.
            const url = text.slice(openP + 1, closeP).trim();
            out.push(
              renderLink(url, renderInline(linkText, t), t, out.length),
            );
            i = closeP + 1;
            continue;
          }
        }
      }
    }
    // Bare http(s):// or ferrisscope:// URL. Only fire at a non-word
    // boundary so we don't mangle e.g. `xhttp://...` (rare, but free).
    if (
      (c === "h" || c === "H" || c === "f" || c === "F") &&
      !isWord(text[i - 1])
    ) {
      const m = bareUrlAt(text, i);
      if (m) {
        flush();
        out.push(renderLink(m.url, m.url, t, out.length));
        i += m.len;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
