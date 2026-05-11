// ANSI rendering / stripping is the difference between readable logs and
// `ESC[31m...` smeared across the operator's clipboard. The cache-warming
// behaviour also matters: a regression that fails to cache turns the log
// view into a parse-per-row CPU hog.

import { describe, it, expect } from "vitest";
import { isValidElement } from "react";
import { ansiToReact, stripAnsi } from "./ansi";

describe("stripAnsi", () => {
  it("plain text passes through (fast path)", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31merror\x1b[0m: boom")).toBe("error: boom");
    expect(stripAnsi("\x1b[1;33mwarn\x1b[0m line")).toBe("warn line");
  });

  it("strips OSC sequences (title sets, hyperlinks)", () => {
    expect(stripAnsi("\x1b]0;Title\x07body")).toBe("body");
    // Hyperlink OSC 8 wrapper around a label.
    const link = "\x1b]8;;https://example.invalid\x1b\\click\x1b]8;;\x1b\\";
    expect(stripAnsi(link)).toBe("click");
  });

  it("strips non-SGR CSI sequences (cursor moves, line erase, bracketed-paste)", () => {
    expect(stripAnsi("\x1b[2K\x1b[Hredraw")).toBe("redraw");
    expect(stripAnsi("\x1b[?2004hpasting\x1b[?2004l")).toBe("pasting");
  });

  it("drops stray BEL bytes", () => {
    expect(stripAnsi("ding\x07dong")).toBe("dingdong");
  });
});

describe("ansiToReact", () => {
  it("plain text fast-paths to the string itself", () => {
    expect(ansiToReact("hello")).toBe("hello");
    // Empty is fine too.
    expect(ansiToReact("")).toBe("");
  });

  it("ANSI-colored text returns an array of styled span elements", () => {
    const out = ansiToReact("\x1b[31mhi\x1b[0m there");
    // Array of ReactElement<span>.
    expect(Array.isArray(out)).toBe(true);
    const arr = out as ReadonlyArray<unknown>;
    expect(arr.every((e) => isValidElement(e))).toBe(true);
  });

  it("caches by exact input so the second call is the same node", () => {
    const a = "\x1b[31mcached\x1b[0m";
    const first = ansiToReact(a);
    const second = ansiToReact(a);
    // Reference equality — the LRU returns the same nodes back.
    expect(second).toBe(first);
  });

  it("escape-only sequence with no body returns the cleaned (empty) string", () => {
    // Bracketed-paste markers alone — after stripping there's no remaining
    // escape, so the fast path returns the cleaned string.
    const out = ansiToReact("\x1b[?2004h\x1b[?2004l");
    expect(out).toBe("");
  });
});
