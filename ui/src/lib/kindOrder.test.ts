import { describe, it, expect } from "vitest";
import { railRank } from "./kindOrder";
import type { ResourceKind } from "../types";

const k = (id: string, category: string, kind = id) => ({ id, category, kind }) as ResourceKind;

describe("railRank", () => {
  it("orders by rail group, then registry order, CRDs alphabetical last in their group", () => {
    const kinds = [
      k("configmaps", "Config"),
      k("crd:zeta", "CustomResources", "Zeta"),
      k("pods", "Workloads"),
      k("customresourcedefinitions", "CustomResources"),
      k("deployments", "Workloads"),
      k("crd:alpha", "CustomResources", "Alpha"),
      k("services", "Network"),
    ];
    const rank = railRank(kinds);
    const ordered = [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    expect(ordered).toEqual([
      "pods",
      "deployments",
      "services",
      "configmaps",
      "customresourcedefinitions",
      "crd:alpha",
      "crd:zeta",
    ]);
  });
});
