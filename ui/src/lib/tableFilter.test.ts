// parseTableFilter is the operator's main "find a row" entry point. It's a
// small function but the bucket-detection rules (substring vs regex vs
// labels, dot is literal) are exactly the kind of thing that's silently
// easy to break.

import { describe, it, expect } from "vitest";
import { parseTableFilter, type TableFilterRow } from "./tableFilter";

// Test helpers — the predicate takes a row, not a bare string.
const n = (name: string): TableFilterRow => ({ name });
const l = (labels: Record<string, string>): TableFilterRow => ({
  name: "x",
  __labels: labels,
});

describe("parseTableFilter — name modes", () => {
  it("empty / whitespace-only input is the off mode and matches everything", () => {
    expect(parseTableFilter("").mode).toBe("off");
    expect(parseTableFilter("   ").mode).toBe("off");
    expect(parseTableFilter("").test(n("anything"))).toBe(true);
    expect(parseTableFilter("\t\n").test(n(""))).toBe(true);
  });

  it("bare alphanumeric input is substring + case-insensitive", () => {
    const f = parseTableFilter("Pod");
    expect(f.mode).toBe("substring");
    expect(f.test(n("nginx-pod-7d8"))).toBe(true);
    expect(f.test(n("NGINX-POD-7D8"))).toBe(true);
    expect(f.test(n("nginx"))).toBe(false);
  });

  it("a literal dot stays in substring mode (image tags shouldn't promote)", () => {
    const f = parseTableFilter("nginx-1.27");
    expect(f.mode).toBe("substring");
    // The dot is literal — would match if interpreted as regex.
    expect(f.test(n("nginx-1.27.0"))).toBe(true);
    // And won't match across an arbitrary char (regex `.` would have here).
    expect(f.test(n("nginx-1X27"))).toBe(false);
  });

  it("any other metachar promotes to regex", () => {
    // Bare trailing `*` is regex.
    expect(parseTableFilter("foo*").mode).toBe("regex");
    expect(parseTableFilter("api|web").mode).toBe("regex");
    expect(parseTableFilter("^prod-").mode).toBe("regex");
    expect(parseTableFilter("worker-\\d+").mode).toBe("regex");
  });

  it("regex is case-insensitive (operator-friendly)", () => {
    const f = parseTableFilter("^Worker-");
    expect(f.test(n("worker-0"))).toBe(true);
    expect(f.test(n("WORKER-1"))).toBe(true);
    expect(f.test(n("api-0"))).toBe(false);
  });

  it("invalid regex returns invalid:true and a never-matching predicate", () => {
    const f = parseTableFilter("(unclosed");
    expect(f.mode).toBe("regex");
    expect(f.invalid).toBe(true);
    expect(f.test(n("anything"))).toBe(false);
    expect(f.test(n(""))).toBe(false);
  });

  it("valid regex anchors still work", () => {
    const f = parseTableFilter("^api.*-prod$");
    expect(f.mode).toBe("regex");
    expect(f.test(n("api-foo-prod"))).toBe(true);
    expect(f.test(n("apifoo-prod"))).toBe(true);
    expect(f.test(n("apifoo-prod-stage"))).toBe(false);
  });
});

describe("parseTableFilter — label mode", () => {
  it("any `=` switches to label mode", () => {
    expect(parseTableFilter("app=nginx").mode).toBe("labels");
    expect(parseTableFilter("app!=nginx").mode).toBe("labels");
    expect(parseTableFilter("app=").mode).toBe("labels");
  });

  it("plain value is exact + case-sensitive (kubectl `=`)", () => {
    const f = parseTableFilter("app=web");
    expect(f.test(l({ app: "web" }))).toBe(true);
    expect(f.test(l({ app: "web-frontend" }))).toBe(false);
    expect(f.test(l({ app: "WEB" }))).toBe(false);
    expect(f.test(l({ tier: "web" }))).toBe(false); // wrong key
    expect(f.test(n("web"))).toBe(false); // no labels at all
  });

  it("a metachar value matches as a case-insensitive regex", () => {
    const f = parseTableFilter("app=web.*");
    expect(f.test(l({ app: "web" }))).toBe(true);
    expect(f.test(l({ app: "web-frontend" }))).toBe(true);
    expect(f.test(l({ app: "WEB-API" }))).toBe(true); // case-insensitive
    expect(f.test(l({ app: "api" }))).toBe(false);
  });

  it("`|` in the value is OR (regex alternation)", () => {
    const f = parseTableFilter("app=nginx|mysql");
    expect(f.test(l({ app: "nginx" }))).toBe(true);
    expect(f.test(l({ app: "mysql" }))).toBe(true);
    expect(f.test(l({ app: "redis" }))).toBe(false);
  });

  it("empty value is an existence check (`key=`)", () => {
    const f = parseTableFilter("app=");
    expect(f.test(l({ app: "anything" }))).toBe(true);
    expect(f.test(l({ app: "" }))).toBe(true); // present, empty value
    expect(f.test(l({ tier: "x" }))).toBe(false);
    expect(f.test(n("x"))).toBe(false);
  });

  it("empty negated value is an absence check (`key!=`)", () => {
    const f = parseTableFilter("app!=");
    expect(f.test(l({ tier: "x" }))).toBe(true); // app absent
    expect(f.test(n("x"))).toBe(true); // no labels at all
    expect(f.test(l({ app: "nginx" }))).toBe(false);
  });

  it("`key!=value` is true when absent OR differing (kubectl `!=`)", () => {
    const f = parseTableFilter("app!=web");
    expect(f.test(l({ app: "api" }))).toBe(true); // differs
    expect(f.test(l({ tier: "x" }))).toBe(true); // absent
    expect(f.test(n("x"))).toBe(true); // no labels
    expect(f.test(l({ app: "web" }))).toBe(false); // equals
  });

  it("comma across DIFFERENT keys is AND", () => {
    const f = parseTableFilter("app=web,tier=prod");
    expect(f.test(l({ app: "web", tier: "prod" }))).toBe(true);
    expect(f.test(l({ app: "web", tier: "dev" }))).toBe(false);
    expect(f.test(l({ app: "web" }))).toBe(false);
    expect(f.test(l({ tier: "prod" }))).toBe(false);
  });

  it("comma across the SAME key is OR (the reported case)", () => {
    const f = parseTableFilter("app=nginx,app=redis");
    expect(f.test(l({ app: "nginx" }))).toBe(true);
    expect(f.test(l({ app: "redis" }))).toBe(true);
    expect(f.test(l({ app: "other" }))).toBe(false);
    expect(f.test(l({ tier: "x" }))).toBe(false);
  });

  it("mixes same-key OR with cross-key AND", () => {
    const f = parseTableFilter("app=web,app=api,tier=prod");
    // (app=web OR app=api) AND tier=prod
    expect(f.test(l({ app: "web", tier: "prod" }))).toBe(true);
    expect(f.test(l({ app: "api", tier: "prod" }))).toBe(true);
    expect(f.test(l({ app: "web", tier: "dev" }))).toBe(false); // wrong tier
    expect(f.test(l({ app: "db", tier: "prod" }))).toBe(false); // wrong app
  });

  it("same-key OR composes with regex values", () => {
    const f = parseTableFilter("app=web.*,app=db");
    expect(f.test(l({ app: "web-frontend" }))).toBe(true); // regex term
    expect(f.test(l({ app: "db" }))).toBe(true); // exact term
    expect(f.test(l({ app: "cache" }))).toBe(false);
  });

  it("negation stays an AND'd exclusion alongside same-key OR", () => {
    const f = parseTableFilter("app=web,app=api,app!=web");
    // app∈{web,api} but excluding web → effectively app=api only
    expect(f.test(l({ app: "api" }))).toBe(true);
    expect(f.test(l({ app: "web" }))).toBe(false);
    expect(f.test(l({ app: "db" }))).toBe(false);
  });

  it("AND + regex value compose", () => {
    const f = parseTableFilter("app=web.*,tier=prod");
    expect(f.test(l({ app: "web-frontend", tier: "prod" }))).toBe(true);
    expect(f.test(l({ app: "web-frontend", tier: "dev" }))).toBe(false);
  });

  it("invalid: empty key or bad regex value → invalid + never matches", () => {
    const noKey = parseTableFilter("=x");
    expect(noKey.mode).toBe("labels");
    expect(noKey.invalid).toBe(true);
    expect(noKey.test(l({ app: "x" }))).toBe(false);

    const badRe = parseTableFilter("app=(unclosed");
    expect(badRe.invalid).toBe(true);
    expect(badRe.test(l({ app: "(unclosed" }))).toBe(false);
  });

  it("tolerates trailing / doubled commas", () => {
    const f = parseTableFilter("app=web,");
    expect(f.invalid).toBeUndefined();
    expect(f.test(l({ app: "web" }))).toBe(true);
  });

  it("does not match JS object prototype members as labels", () => {
    // `labels[key]` would inherit these from Object.prototype; hasOwnProperty
    // must not. A pod without these labels must not match.
    for (const proto of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const exists = parseTableFilter(`${proto}=`);
      expect(exists.test(l({ app: "web" }))).toBe(false);
      const eq = parseTableFilter(`${proto}=x`);
      expect(eq.test(l({ app: "web" }))).toBe(false);
    }
    // …but a real label literally named `toString` still matches when present.
    expect(parseTableFilter("toString=").test(l({ toString: "v" }))).toBe(true);
  });

  it("a comma inside a regex quantifier is invalid (comma is the AND separator)", () => {
    const f = parseTableFilter("app=a{1,3}");
    expect(f.mode).toBe("labels");
    expect(f.invalid).toBe(true);
    expect(f.test(l({ app: "aaa" }))).toBe(false);
  });
});
