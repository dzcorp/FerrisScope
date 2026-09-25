// Keeps a sorted copy of a row list across updates. Rows are immutable
// objects replaced on change, so between two calls with the same comparator
// every row object seen before is still in order: only new objects (added
// or changed rows) need placing, by binary search. A full sort runs when the
// comparator changes or too many rows are new for inserts to win.

export type Compare<T> = (a: T, b: T) => number;

/// Above this share of new rows a full sort is cheaper than inserting.
const FULL_SORT_RATIO = 0.25;

export function createIncrementalSorter<T extends object>(): (
  rows: readonly T[],
  compare: Compare<T>,
) => T[] {
  let lastCompare: Compare<T> | null = null;
  let sorted: T[] = [];
  let seen = new Set<T>();

  return (rows, compare) => {
    const next = new Set(rows);
    const fresh = rows.filter((r) => !seen.has(r));
    if (compare !== lastCompare || fresh.length > rows.length * FULL_SORT_RATIO) {
      sorted = rows.slice().sort(compare);
    } else {
      const kept = sorted.filter((r) => next.has(r));
      for (const r of fresh) kept.splice(upperBound(kept, r, compare), 0, r);
      sorted = kept;
    }
    lastCompare = compare;
    seen = next;
    return sorted;
  };
}

/// First index whose element sorts after `item` (inserts after equals).
function upperBound<T>(arr: readonly T[], item: T, compare: Compare<T>): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(arr[mid]!, item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
