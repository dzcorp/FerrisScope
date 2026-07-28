// Scrollback partitioning. The behaviour that matters is the one a single
// global ring got wrong: in an aggregated view, a chatty pod must not evict a
// quiet pod's history.

import { describe, it, expect } from "vitest";
import { LogRing, MIN_LINES_PER_SOURCE, perSourceCap } from "./logRing";

type Line = { id: number; src: string; text: string };

let seq = 0;
function line(src: string, text = ""): Line {
  return { id: ++seq, src, text };
}

describe("perSourceCap", () => {
  it("gives a lone source the whole buffer", () => {
    // Single-pod views must behave exactly as they did before partitioning.
    expect(perSourceCap(5_000, 1)).toBe(5_000);
    expect(perSourceCap(5_000, 0)).toBe(5_000);
  });

  it("splits evenly when the split stays above the floor", () => {
    expect(perSourceCap(20_000, 4)).toBe(5_000);
  });

  it("clamps to the floor rather than handing out unusable slivers", () => {
    // 5,000 / 24 is ~208 lines per pod — less scrollback than a default
    // `kubectl logs --tail`, which is what the floor exists to prevent.
    expect(perSourceCap(5_000, 24)).toBe(MIN_LINES_PER_SOURCE);
  });
});

describe("LogRing", () => {
  it("keeps arrival order across sources", () => {
    const r = new LogRing<Line>(100);
    r.setSourceCount(2);
    const a1 = line("a");
    const b1 = line("b");
    const a2 = line("a");
    r.push(a1);
    r.push(b1);
    r.push(a2);
    expect(r.toArray().map((l) => l.id)).toEqual([a1.id, b1.id, a2.id]);
    expect(r.size()).toBe(3);
  });

  it("a chatty source cannot evict a quiet source", () => {
    // The whole point. Two sources, tiny buffer: the quiet pod's single line
    // survives however much the loud one says.
    const r = new LogRing<Line>(4);
    r.setSourceCount(2);
    const quiet = line("quiet", "the one line I care about");
    r.push(quiet);
    for (let i = 0; i < 500; i++) r.push(line("loud"));
    const out = r.toArray();
    expect(out.some((l) => l.id === quiet.id)).toBe(true);
    // …and the loud source is still bounded by its own quota.
    expect(out.filter((l) => l.src === "loud")).toHaveLength(
      perSourceCap(4, 2),
    );
  });

  it("evicts a source's own oldest lines first", () => {
    const r = new LogRing<Line>(3);
    r.setSourceCount(3); // quota floors at MIN_LINES_PER_SOURCE, so force small
    const small = new LogRing<Line>(2);
    small.setSourceCount(1); // quota == 2
    const first = line("a");
    const second = line("a");
    const third = line("a");
    small.push(first);
    small.push(second);
    small.push(third);
    expect(small.toArray().map((l) => l.id)).toEqual([second.id, third.id]);
  });

  it("re-caps in place, keeping the newest lines per source", () => {
    const r = new LogRing<Line>(1_000);
    r.setSourceCount(1);
    const ids = Array.from({ length: 10 }, () => {
      const l = line("a");
      r.push(l);
      return l.id;
    });
    r.setTotalCap(4);
    expect(r.toArray().map((l) => l.id)).toEqual(ids.slice(-4));
  });

  it("shrinking the source count widens each surviving quota", () => {
    const r = new LogRing<Line>(2_000);
    r.setSourceCount(4); // quota 500
    for (let i = 0; i < 800; i++) r.push(line("a"));
    expect(r.size()).toBe(500);
    r.setSourceCount(1); // quota 2000 — but the dropped lines are gone for good
    for (let i = 0; i < 800; i++) r.push(line("a"));
    expect(r.size()).toBe(1_300);
  });

  it("clear drops everything", () => {
    const r = new LogRing<Line>(10);
    r.push(line("a"));
    r.push(line("b"));
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.toArray()).toEqual([]);
  });

  it("memoises the merge until the next push", () => {
    const r = new LogRing<Line>(10);
    r.setSourceCount(2);
    r.push(line("a"));
    r.push(line("b"));
    const first = r.toArray();
    expect(r.toArray()).toBe(first);
    r.push(line("a"));
    expect(r.toArray()).not.toBe(first);
  });

  it("merges many sources in id order", () => {
    // Interleave 8 sources round-robin; the merge must reproduce push order
    // exactly, since that is what the operator reads as "arrival order".
    const r = new LogRing<Line>(4_000);
    r.setSourceCount(8);
    const pushed: number[] = [];
    for (let i = 0; i < 200; i++) {
      const l = line(`s${i % 8}`);
      pushed.push(l.id);
      r.push(l);
    }
    expect(r.toArray().map((l) => l.id)).toEqual(pushed);
  });
});
