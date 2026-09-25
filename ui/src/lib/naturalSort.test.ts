import { describe, expect, it } from "vitest";
import { sortFn_alphanumeric } from "@tanstack/react-table";
import { naturalComparator, naturalSortKey } from "./naturalSort";

const tanstack = (a: string, b: string): number =>
  Math.sign(sortFn_alphanumeric.sort!(a.toLowerCase(), b.toLowerCase(), {} as never, {} as never, ""));
const ours = (a: string, b: string): number => {
  const x = naturalSortKey(a);
  const y = naturalSortKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

describe("naturalSortKey", () => {
  it("orders like a natural sort", () => {
    const names = ["pod-10", "pod-2", "Pod-1", "pod", "pod-02", "pod-a", "10", "a", ""];
    expect([...names].sort(ours)).toEqual([
      "",
      "a",
      "pod",
      "Pod-1",
      "pod-2",
      "pod-02",
      "pod-10",
      "pod-a",
      "10",
    ]);
  });

  // TanStack falls back to lossy `parseInt` above 15 digits; parity is
  // checked below that, exact ordering above it separately.
  it("agrees with TanStack's alphanumeric sort on every pair", () => {
    const parts = ["", "a", "b", "ab", "A", "-", "0", "00", "1", "01", "2", "9", "10", "123456789012345", "x-1"];
    const samples: string[] = [];
    for (const p of parts) for (const q of parts) for (const r of ["", "z", "7"]) samples.push(p + q + r);
    // Pod-shaped names too.
    for (let i = 0; i < 60; i++) samples.push(`api-${(i * 7919) % 1000}-7f9c${i % 7}d-x${i}`);
    const comparable = samples.filter((x) => !/[0-9]{16,}/.test(x));
    for (const a of comparable) {
      for (const b of comparable) {
        if (ours(a, b) !== tanstack(a, b)) {
          throw new Error(`mismatch for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
      }
    }
  });

  it("orders long digit runs exactly", () => {
    expect(ours("1234567890123456780", "1234567890123456787")).toBe(-1);
  });
});

describe("naturalComparator", () => {
  it("encodes each object once per column", () => {
    let reads = 0;
    const cmp = naturalComparator<{ name: string }>((r) => {
      reads++;
      return r.name;
    });
    const rows = [{ name: "b-10" }, { name: "b-2" }, { name: "a" }];
    rows.sort(cmp);
    expect(rows.map((r) => r.name)).toEqual(["a", "b-2", "b-10"]);
    expect(reads).toBe(3);
    rows.sort(cmp);
    expect(reads).toBe(3);
  });
});
