// ANSI → React renderer for pod logs.
//
// Pipeline:
//   1. `stripNonSgr` removes terminal-only chatter (OSC titles, bracketed-
//      paste mode toggles, line-erase, cursor moves, hyperlinks, BEL). A
//      log viewer has no cursor, so these only ever appear as garbage.
//   2. `anser` parses the remaining SGR sequences into typed chunks —
//      including 256-color, 24-bit truecolor, bold / dim / italic /
//      underline / strikethrough. Anything anser doesn't recognise is
//      dropped, not echoed.
//   3. Chunks are mapped to styled `<span>` runs — always safe React, no
//      `dangerouslySetInnerHTML`.
//
// Output is cached LRU-by-line so virtualised log views can mount/unmount
// rows during scroll without re-parsing.

import Anser from "anser";
import type { CSSProperties, ReactNode } from "react";

// Non-SGR escape sequences that have no meaning in a log viewer:
//   - OSC: `ESC ]` … `(BEL | ESC \)` — title sets, hyperlinks (OSC 8).
//   - CSI non-SGR: `ESC [` <params> <final byte ≠ 'm'> — `?2004h/l`,
//     `K`, `J`, `H`, cursor moves, etc. SGR (final 'm') is excluded so
//     anser still sees colour codes.
//   - Bare BEL — leftover bells / orphaned OSC terminators.
const OSC_SEQ = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const CSI_NON_SGR = /\x1b\[[0-9;?<>!]*[@-ln-~]/g;
const STRAY_BEL = /\x07/g;

function stripNonSgr(s: string): string {
  return s.replace(OSC_SEQ, "").replace(CSI_NON_SGR, "").replace(STRAY_BEL, "");
}

// LRU cache for parsed lines. Virtualised log views mount/unmount rows
// constantly during scroll; without a cache we'd re-parse the same string
// on every mount. Bound the cache so a 100k-line log doesn't pin every
// parsed ReactNode forever.
const ANSI_CACHE_MAX = 4096;
const ansiCache: Map<string, ReactNode> = new Map();

function styleFor(chunk: Anser.AnserJsonEntry): CSSProperties {
  const css: CSSProperties = {};
  // Anser exposes `fg_truecolor` for 24-bit, `fg` for 8/16/256 — both as
  // "r,g,b" decimal strings. Prefer truecolor when present.
  const fg = chunk.fg_truecolor || chunk.fg;
  const bg = chunk.bg_truecolor || chunk.bg;
  if (fg) css.color = `rgb(${fg})`;
  if (bg) css.background = `rgb(${bg})`;
  for (const d of chunk.decorations ?? []) {
    if (d === "bold") css.fontWeight = 700;
    else if (d === "dim") css.opacity = 0.7;
    else if (d === "italic") css.fontStyle = "italic";
    else if (d === "underline") {
      css.textDecoration = css.textDecoration
        ? `${css.textDecoration} underline`
        : "underline";
    } else if (d === "strikethrough") {
      css.textDecoration = css.textDecoration
        ? `${css.textDecoration} line-through`
        : "line-through";
    } else if (d === "reverse") {
      // Swap fg/bg. If only one is set, fall back to inheriting the other.
      const fgVal = typeof css.color === "string" ? css.color : undefined;
      const bgVal =
        typeof css.background === "string" ? css.background : undefined;
      css.color = bgVal ?? "var(--log-bg, #0a0c10)";
      css.background = fgVal ?? "var(--log-fg, #cbd5e1)";
    }
  }
  return css;
}

function parseAnsi(text: string): ReactNode {
  const cleaned = stripNonSgr(text);
  if (!cleaned.includes("\x1b")) return cleaned;
  const chunks = Anser.ansiToJson(cleaned, {
    json: true,
    remove_empty: true,
    use_classes: false,
  });
  const out: ReactNode[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || !chunk.content) continue;
    out.push(
      <span key={i} style={styleFor(chunk)}>
        {chunk.content}
      </span>,
    );
  }
  // Single-chunk fallback: if anser gave us one plain run, return it as a
  // string so React can avoid the keyed-fragment overhead.
  if (out.length === 0) return cleaned;
  return out;
}

export function ansiToReact(text: string): ReactNode {
  // Fast path: no escape / BEL bytes → return the string directly.
  if (!text.includes("\x1b") && !text.includes("\x07")) return text;

  const cached = ansiCache.get(text);
  if (cached !== undefined) {
    // Bump to most-recent on hit (Map preserves insertion order).
    ansiCache.delete(text);
    ansiCache.set(text, cached);
    return cached;
  }

  const parsed = parseAnsi(text);
  ansiCache.set(text, parsed);
  if (ansiCache.size > ANSI_CACHE_MAX) {
    const oldest = ansiCache.keys().next().value;
    if (oldest !== undefined) ansiCache.delete(oldest);
  }
  return parsed;
}

// Strip every escape sequence and bare control byte. Useful when copying
// log text — operators don't want `ESC[2m` smeared across their clipboard.
export function stripAnsi(text: string): string {
  if (!text.includes("\x1b") && !text.includes("\x07")) return text;
  return Anser.ansiToText(stripNonSgr(text));
}
