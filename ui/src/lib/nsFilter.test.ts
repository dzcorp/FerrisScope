import { describe, expect, it } from "vitest";
import { prunedNamespaceFilter } from "./nsFilter";

describe("prunedNamespaceFilter", () => {
  const sel = new Set(["team-a", "team-b"]);

  it("keeps a restored filter while the namespace list is still syncing", () => {
    expect(prunedNamespaceFilter(sel, new Set(), 0, 1)).toBeNull();
    expect(prunedNamespaceFilter(sel, new Set(["x"]), 1, 2)).toBeNull();
  });

  it("drops namespaces missing from every member once synced", () => {
    expect(prunedNamespaceFilter(sel, new Set(["team-a"]), 2, 2)).toEqual(
      new Set(["team-a"]),
    );
    expect(prunedNamespaceFilter(sel, new Set(), 1, 1)).toEqual(new Set());
  });

  it("no-ops when everything is live or the filter is 'all'", () => {
    expect(
      prunedNamespaceFilter(sel, new Set(["team-a", "team-b", "c"]), 1, 1),
    ).toBeNull();
    expect(prunedNamespaceFilter(new Set(), new Set(), 1, 1)).toBeNull();
  });
});
