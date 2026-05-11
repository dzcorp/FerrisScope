// parseTableFilter is the operator's main "find a row" entry point. It's a
// small function but the bucket-detection rules (substring vs regex, dot is
// literal) are exactly the kind of thing that's silently easy to break.

import { describe, it, expect } from "vitest";
import { parseTableFilter } from "./tableFilter";

describe("parseTableFilter — mode detection", () => {
  it("empty / whitespace-only input is the off mode and matches everything", () => {
    expect(parseTableFilter("").mode).toBe("off");
    expect(parseTableFilter("   ").mode).toBe("off");
    expect(parseTableFilter("").test("anything")).toBe(true);
    expect(parseTableFilter("\t\n").test("")).toBe(true);
  });

  it("bare alphanumeric input is substring + case-insensitive", () => {
    const f = parseTableFilter("Pod");
    expect(f.mode).toBe("substring");
    expect(f.test("nginx-pod-7d8")).toBe(true);
    expect(f.test("NGINX-POD-7D8")).toBe(true);
    expect(f.test("nginx")).toBe(false);
  });

  it("a literal dot stays in substring mode (image tags shouldn't promote)", () => {
    const f = parseTableFilter("nginx-1.27");
    expect(f.mode).toBe("substring");
    // The dot is literal — would match if interpreted as regex.
    expect(f.test("nginx-1.27.0")).toBe(true);
    // And won't match across an arbitrary char (regex `.` would have here).
    expect(f.test("nginx-1X27")).toBe(false);
  });

  it("any other metachar promotes to regex", () => {
    for (const ch of ["|", "*", "+", "?", "(", ")", "^", "$", "[", "]", "{", "}", "\\"]) {
      const f = parseTableFilter(`x${ch}y`.replace(/[()[\]{}]/g, "")); // simpler probe
      // Even a bare trailing `*` is regex.
      expect(parseTableFilter("foo*").mode).toBe("regex");
    }
    expect(parseTableFilter("api|web").mode).toBe("regex");
    expect(parseTableFilter("^prod-").mode).toBe("regex");
    expect(parseTableFilter("worker-\\d+").mode).toBe("regex");
  });

  it("regex is case-insensitive (operator-friendly)", () => {
    const f = parseTableFilter("^Worker-");
    expect(f.test("worker-0")).toBe(true);
    expect(f.test("WORKER-1")).toBe(true);
    expect(f.test("api-0")).toBe(false);
  });

  it("invalid regex returns invalid:true and a never-matching predicate", () => {
    const f = parseTableFilter("(unclosed");
    expect(f.mode).toBe("regex");
    expect(f.invalid).toBe(true);
    expect(f.test("anything")).toBe(false);
    expect(f.test("")).toBe(false);
  });

  it("valid regex anchors still work", () => {
    const f = parseTableFilter("^api.*-prod$");
    expect(f.mode).toBe("regex");
    expect(f.test("api-foo-prod")).toBe(true);
    expect(f.test("apifoo-prod")).toBe(true);
    expect(f.test("apifoo-prod-stage")).toBe(false);
  });
});
