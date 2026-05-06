import { describe, it, expect } from "vitest";
import {
  kvBufferAdd,
  kvBufferDirty,
  kvBufferDuplicates,
  kvBufferFromPairs,
  kvBufferReplace,
  kvBufferToggleDelete,
  kvBufferToMap,
  type KvBuffer,
  type KvRow,
} from "./edit";

// Helper for `noUncheckedIndexedAccess: true` — every test below indexes
// into a buffer whose shape it just constructed, so the row is known to
// exist. Doing the lookup once with a clear error message beats a sea of
// `!` assertions inline.
function row(b: KvBuffer, i: number): KvRow {
  const r = b.rows[i];
  if (!r) throw new Error(`buffer has no row at index ${i}`);
  return r;
}

describe("kvBufferFromPairs", () => {
  it("preserves originals so dirty detection has a baseline", () => {
    const b = kvBufferFromPairs([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(b.rows).toHaveLength(2);
    expect(row(b, 0)).toMatchObject({
      key: "a",
      value: "1",
      originalKey: "a",
      originalValue: "1",
      isNew: false,
      deleted: false,
    });
    expect(kvBufferDirty(b)).toBe(0);
  });
});

describe("kvBufferAdd", () => {
  it("appends a blank, isNew row with a fresh id", () => {
    const b = kvBufferFromPairs([["a", "1"]]);
    const next = kvBufferAdd(b);
    expect(next.rows).toHaveLength(2);
    const fresh = row(next, 1);
    expect(fresh.isNew).toBe(true);
    expect(fresh.key).toBe("");
    expect(fresh.value).toBe("");
    // Brand-new empty rows don't count as dirty until they have content.
    expect(kvBufferDirty(next)).toBe(0);
  });
});

describe("kvBufferReplace + dirty", () => {
  it("counts an edited existing row as 1 dirty", () => {
    const b = kvBufferFromPairs([["a", "1"]]);
    const next = kvBufferReplace(b, row(b, 0).id, { value: "1.5" });
    expect(kvBufferDirty(next)).toBe(1);
  });

  it("counts a filled-in new row as 1 dirty", () => {
    const b = kvBufferFromPairs([]);
    const added = kvBufferAdd(b);
    const filled = kvBufferReplace(added, row(added, 0).id, {
      key: "k",
      value: "v",
    });
    expect(kvBufferDirty(filled)).toBe(1);
  });

  it("does not double-count an unchanged edit", () => {
    const b = kvBufferFromPairs([["a", "1"]]);
    const same = kvBufferReplace(b, row(b, 0).id, { value: "1" });
    expect(kvBufferDirty(same)).toBe(0);
  });
});

describe("kvBufferToggleDelete", () => {
  it("flags an existing row as deleted (1 dirty) without removing it", () => {
    const b = kvBufferFromPairs([["a", "1"]]);
    const removed = kvBufferToggleDelete(b, row(b, 0).id);
    expect(removed.rows).toHaveLength(1);
    expect(row(removed, 0).deleted).toBe(true);
    expect(kvBufferDirty(removed)).toBe(1);
    // Toggle again → restore, dirty back to 0.
    const restored = kvBufferToggleDelete(removed, row(removed, 0).id);
    expect(row(restored, 0).deleted).toBe(false);
    expect(kvBufferDirty(restored)).toBe(0);
  });

  it("removes a brand-new row outright on delete", () => {
    const b = kvBufferAdd(kvBufferFromPairs([]));
    const id = row(b, 0).id;
    const next = kvBufferToggleDelete(b, id);
    expect(next.rows).toHaveLength(0);
  });
});

describe("kvBufferToMap", () => {
  it("net-effect map drops deleted + empty-key rows", () => {
    const b0 = kvBufferFromPairs([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    const b1 = kvBufferToggleDelete(b0, row(b0, 1).id);
    const b2 = kvBufferAdd(b1);
    // Append an empty-key row that should be dropped.
    expect(kvBufferToMap(b2)).toEqual({ a: "1", c: "3" });
  });

  it("uses live key/value, not original, after a rename", () => {
    const b = kvBufferFromPairs([["k", "v"]]);
    const renamed = kvBufferReplace(b, row(b, 0).id, { key: "k2" });
    expect(kvBufferToMap(renamed)).toEqual({ k2: "v" });
  });
});

describe("kvBufferDuplicates", () => {
  it("flags repeated keys (case-sensitive)", () => {
    const b = kvBufferFromPairs([
      ["a", "1"],
      ["a", "2"],
      ["b", "3"],
    ]);
    expect(Array.from(kvBufferDuplicates(b))).toEqual(["a"]);
  });

  it("ignores deleted rows when computing duplicates", () => {
    const b0 = kvBufferFromPairs([
      ["a", "1"],
      ["a", "2"],
    ]);
    const b1 = kvBufferToggleDelete(b0, row(b0, 1).id);
    expect(kvBufferDuplicates(b1).size).toBe(0);
  });

  it("ignores empty-key new rows", () => {
    const b = kvBufferAdd(kvBufferFromPairs([["a", "1"]]));
    expect(kvBufferDuplicates(b).size).toBe(0);
  });
});
