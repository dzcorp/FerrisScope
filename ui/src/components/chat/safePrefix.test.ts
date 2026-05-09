import { describe, expect, it } from "vitest";
import { MAX_HOLDBACK_CHARS, safePrefixLength } from "./safePrefix";

describe("safePrefixLength", () => {
  it("renders empty as 0", () => {
    expect(safePrefixLength("")).toBe(0);
  });

  it("renders plain prose in full", () => {
    const t = "Hello world, this is just text.";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("holds back partial inline link label", () => {
    const t = "See [foo";
    expect(safePrefixLength(t)).toBe(4); // up to "See "
  });

  it("holds back partial inline link url", () => {
    const t = "See [label](htt";
    expect(safePrefixLength(t)).toBe(4);
  });

  it("flushes once link closes", () => {
    const t = "See [label](https://x) more";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("holds back partial inline code", () => {
    const t = "Run `kubectl get";
    expect(safePrefixLength(t)).toBe(4); // up to "Run "
  });

  it("flushes once inline code closes", () => {
    const t = "Run `kubectl get pods`.";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("holds back partial bold", () => {
    const t = "This is **import";
    expect(safePrefixLength(t)).toBe(8); // up to "This is "
  });

  it("flushes once bold closes", () => {
    const t = "This is **important** text";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("holds back partial strike", () => {
    const t = "Old: ~~deprecat";
    expect(safePrefixLength(t)).toBe(5);
  });

  it("holds back mid-line table row", () => {
    const t = "| name | status |\n| ---- | ------ |\n| pod-a | Run";
    // The last line "| pod-a | Run" is mid-row; safe prefix = up to 2nd \n
    const lastNL = t.lastIndexOf("\n");
    expect(safePrefixLength(t)).toBe(lastNL + 1);
  });

  it("flushes table row once newline lands", () => {
    const t = "| name |\n| ---- |\n| pod-a |\n";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("renders inside an open fenced code block in full", () => {
    const t = "```yaml\napiVersion: v1\nkind: Pod\nmetadata:";
    // Fence is open; everything is safe to render as code body.
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("re-checks after a fence closes", () => {
    const t = "```yaml\nfoo: bar\n```\nNow [label](htt";
    // Fence closed; the trailing partial link should hold back.
    const linkOpen = t.indexOf("[label]");
    expect(safePrefixLength(t)).toBe(linkOpen);
  });

  it("flushes when held-back tail exceeds MAX_HOLDBACK_CHARS", () => {
    const head = "OK ";
    const giant = "[" + "x".repeat(MAX_HOLDBACK_CHARS + 50);
    const t = head + giant;
    // Past the cap, we give up and render everything.
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("ignores escaped link bracket", () => {
    const t = "Use \\[brackets\\] like this.";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("handles multiple closed links plus trailing partial", () => {
    const t = "[a](x) and [b](y) and [c";
    const lastOpen = t.lastIndexOf("[c");
    expect(safePrefixLength(t)).toBe(lastOpen);
  });

  it("does not hold back mid-paragraph after a complete link", () => {
    const t = "[a](x) trailing prose without anything open";
    expect(safePrefixLength(t)).toBe(t.length);
  });

  it("handles backtick mismatch (close run shorter than open)", () => {
    const t = "Code: ``not yet`";
    // Open is ``, close run is ` (length 1) — still unclosed.
    expect(safePrefixLength(t)).toBeLessThan(t.length);
  });

  it("treats label-only [text] (reference style) as safe", () => {
    // Plain `[text]` not followed by `(` renders as literal `[text]`.
    const t = "Some [text] and more.";
    expect(safePrefixLength(t)).toBe(t.length);
  });
});
