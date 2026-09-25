import { describe, expect, it, vi } from "vitest";
import { createIncrementalSorter } from "./incrementalSort";

type R = { id: string; v: number };
const byV = (a: R, b: R) => a.v - b.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const row = (id: string, v: number): R => ({ id, v });

describe("createIncrementalSorter", () => {
  it("matches a full sort through random add / change / remove rounds", () => {
    const sort = createIncrementalSorter<R>();
    let rows = Array.from({ length: 500 }, (_, i) => row(`r${i}`, (i * 7919) % 97));
    let seed = 1;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    expect(sort(rows, byV)).toEqual(rows.slice().sort(byV));
    for (let round = 0; round < 200; round++) {
      rows = rows.slice();
      const i = rand(rows.length);
      switch (rand(3)) {
        case 0:
          rows[i] = row(rows[i]!.id, rand(97)); // changed: new object
          break;
        case 1:
          rows.push(row(`n${round}`, rand(97)));
          break;
        default:
          rows.splice(i, 1);
      }
      expect(sort(rows, byV)).toEqual(rows.slice().sort(byV));
    }
  });

  it("places a few changed rows without re-sorting the rest", () => {
    const sort = createIncrementalSorter<R>();
    const rows = Array.from({ length: 1000 }, (_, i) => row(`r${i}`, i));
    const compare = vi.fn(byV);
    sort(rows, compare);
    compare.mockClear();
    const next = rows.slice();
    next[500] = row("r500", -1);
    expect(sort(next, compare)[0]!.id).toBe("r500");
    // One binary search, not an n·log n sort.
    expect(compare.mock.calls.length).toBeLessThan(20);
  });

  it("re-sorts fully when the comparator changes", () => {
    const sort = createIncrementalSorter<R>();
    const rows = [row("a", 1), row("b", 2), row("c", 3)];
    sort(rows, byV);
    const desc = (a: R, b: R) => -byV(a, b);
    expect(sort(rows, desc).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("drops rows that left the input", () => {
    const sort = createIncrementalSorter<R>();
    const a = row("a", 1);
    const b = row("b", 2);
    sort([a, b], byV);
    expect(sort([b], byV)).toEqual([b]);
  });
});
