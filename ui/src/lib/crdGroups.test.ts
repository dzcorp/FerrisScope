import { describe, it, expect } from "vitest";
import { compareApiGroups, sortApiGroups } from "./crdGroups";

describe("compareApiGroups", () => {
  it("keeps a shared domain family contiguous", () => {
    // Plain .sort() would interleave cert-manager.io between the gke.io
    // family; domain-hierarchy sort keeps gke.* together.
    const groups = [
      "cert-manager.io",
      "node.gke.io",
      "argoproj.io",
      "gke.io",
      "auto.gke.io",
    ];
    expect(sortApiGroups(groups)).toEqual([
      "argoproj.io",
      "cert-manager.io",
      "gke.io",
      "auto.gke.io",
      "node.gke.io",
    ]);
  });

  it("heads a family with its shortest (most general) parent group", () => {
    expect(sortApiGroups(["auto.gke.io", "gke.io", "node.gke.io"])).toEqual([
      "gke.io",
      "auto.gke.io",
      "node.gke.io",
    ]);
  });

  it("orders by TLD first, then org", () => {
    expect(sortApiGroups(["foo.example.com", "foo.example.io"])).toEqual([
      "foo.example.com",
      "foo.example.io",
    ]);
  });

  it("is a total order — reflexive, and stable regardless of input order", () => {
    expect(compareApiGroups("gke.io", "gke.io")).toBe(0);
    const forward = sortApiGroups(["a.io", "b.io", "a.a.io"]);
    const reversed = sortApiGroups(["a.a.io", "b.io", "a.io"]);
    expect(forward).toEqual(reversed);
  });

  it("handles single-segment and empty groups without throwing", () => {
    expect(sortApiGroups(["", "io", "gke.io"])).toEqual(["", "io", "gke.io"]);
  });
});
