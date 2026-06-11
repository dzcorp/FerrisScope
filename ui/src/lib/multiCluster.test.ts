import { describe, it, expect } from "vitest";
import {
  scopedUid,
  parseScopedUid,
  scopeRow,
  applyScopedDelta,
  mergeScopedSnapshots,
  clusterColorIndexMap,
  groupByCluster,
  bulkClusterPrefix,
  mergeSearchHits,
  type ScopedRow,
} from "./multiCluster";
import { CLUSTER_ACCENTS, clusterAccent } from "../theme";

// Real-world shaped cluster id: the composite ContextInfo.id itself
// contains "::", which is exactly the parsing hazard these tests pin.
const CID_A = "default::prod-eu";
const CID_B = "src-9f2::edge cluster 1"; // spaces are legal in context names

describe("scopedUid / parseScopedUid", () => {
  it("round-trips ids whose cluster part contains :: and spaces", () => {
    const sid = scopedUid(CID_B, "0c1d-22");
    expect(sid).toBe("src-9f2::edge cluster 1::0c1d-22");
    expect(parseScopedUid(sid)).toEqual({
      clusterId: CID_B,
      uid: "0c1d-22",
    });
  });

  it("splits on the LAST :: so multi-:: cluster ids survive", () => {
    const sid = scopedUid("a::b::c", "uid-1");
    expect(parseScopedUid(sid)).toEqual({ clusterId: "a::b::c", uid: "uid-1" });
  });

  it("tolerates an unscoped uid (no separator)", () => {
    expect(parseScopedUid("bare-uid")).toEqual({
      clusterId: "",
      uid: "bare-uid",
    });
  });
});

describe("scopeRow", () => {
  it("tags the row and preserves projected columns", () => {
    const scoped = scopeRow(CID_A, { uid: "u1", name: "web", phase: "Running" });
    expect(scoped.__clusterId).toBe(CID_A);
    expect(scoped.__sid).toBe(`${CID_A}::u1`);
    expect(scoped.name).toBe("web");
    expect(scoped.uid).toBe("u1");
  });
});

describe("applyScopedDelta", () => {
  it("upserts under the scoped key — same uid from two clusters coexists", () => {
    const map = new Map<string, ScopedRow>();
    expect(
      applyScopedDelta(map, CID_A, { kind: "upsert", row: { uid: "u1", name: "a" } }),
    ).toBe(true);
    applyScopedDelta(map, CID_B, { kind: "upsert", row: { uid: "u1", name: "b" } });
    expect(map.size).toBe(2);
    expect(map.get(`${CID_A}::u1`)?.name).toBe("a");
    expect(map.get(`${CID_B}::u1`)?.name).toBe("b");
  });

  it("deletes only the matching cluster's row", () => {
    const map = new Map<string, ScopedRow>();
    applyScopedDelta(map, CID_A, { kind: "upsert", row: { uid: "u1" } });
    applyScopedDelta(map, CID_B, { kind: "upsert", row: { uid: "u1" } });
    expect(applyScopedDelta(map, CID_A, { kind: "delete", uid: "u1" })).toBe(true);
    expect(map.size).toBe(1);
    expect(map.has(`${CID_B}::u1`)).toBe(true);
  });

  it("returns false for init_done and for deleting a missing uid", () => {
    const map = new Map<string, ScopedRow>();
    expect(applyScopedDelta(map, CID_A, { kind: "init_done" })).toBe(false);
    expect(applyScopedDelta(map, CID_A, { kind: "delete", uid: "nope" })).toBe(
      false,
    );
  });
});

describe("mergeScopedSnapshots", () => {
  it("merges per-cluster snapshots and lets landed deltas win", () => {
    const existing = new Map<string, ScopedRow>();
    // A delta updated u1 on cluster A while the snapshot was in flight.
    applyScopedDelta(existing, CID_A, {
      kind: "upsert",
      row: { uid: "u1", phase: "Running" },
    });
    const merged = mergeScopedSnapshots(
      [
        { clusterId: CID_A, rows: [{ uid: "u1", phase: "Pending" }, { uid: "u2" }] },
        { clusterId: CID_B, rows: [{ uid: "u1" }] },
      ],
      existing,
    );
    expect(merged.size).toBe(3);
    // Delta (Running) beats snapshot (Pending).
    expect(merged.get(`${CID_A}::u1`)?.phase).toBe("Running");
    expect(merged.get(`${CID_B}::u1`)).toBeDefined();
  });
});

describe("clusterColorIndexMap", () => {
  it("assigns by sorted order, independent of member order", () => {
    const a = clusterColorIndexMap(["z::1", "a::1", "m::1"]);
    const b = clusterColorIndexMap(["m::1", "z::1", "a::1"]);
    expect(a).toEqual(b);
    expect(a["a::1"]).toBe(0);
    expect(a["m::1"]).toBe(1);
    expect(a["z::1"]).toBe(2);
  });
});

describe("clusterAccent", () => {
  it("wraps past the palette length and never returns undefined", () => {
    expect(clusterAccent(0)).toBe(CLUSTER_ACCENTS[0]);
    expect(clusterAccent(CLUSTER_ACCENTS.length)).toBe(CLUSTER_ACCENTS[0]);
    expect(clusterAccent(-1)).toBeTruthy();
    expect(clusterAccent(Number.NaN)).toBe(CLUSTER_ACCENTS[0]);
  });
});

describe("groupByCluster", () => {
  it("buckets entries by clusterId preserving order", () => {
    const grouped = groupByCluster([
      ["s1", { clusterId: CID_A, name: "x" }],
      ["s2", { clusterId: CID_B, name: "y" }],
      ["s3", { clusterId: CID_A, name: "z" }],
    ]);
    expect([...grouped.keys()]).toEqual([CID_A, CID_B]);
    expect(grouped.get(CID_A)!.map(([id]) => id)).toEqual(["s1", "s3"]);
    expect(grouped.get(CID_B)!.map(([id]) => id)).toEqual(["s2"]);
  });
});

describe("bulkClusterPrefix", () => {
  const labelFor = (cid: string) => cid.split("::")[1] ?? cid;

  it("returns empty prefixes for a single-cluster selection (output unchanged)", () => {
    const entries: [string, { clusterId: string; name: string }][] = [
      ["s1", { clusterId: CID_A, name: "a" }],
      ["s2", { clusterId: CID_A, name: "b" }],
    ];
    const prefix = bulkClusterPrefix(entries, labelFor);
    expect(prefix(entries[0]![1])).toBe("");
  });

  it("prefixes with the cluster label when the selection spans clusters", () => {
    const entries: [string, { clusterId: string; name: string }][] = [
      ["s1", { clusterId: CID_A, name: "a" }],
      ["s2", { clusterId: CID_B, name: "b" }],
    ];
    const prefix = bulkClusterPrefix(entries, labelFor);
    expect(prefix(entries[0]![1])).toBe("[prod-eu] ");
    expect(prefix(entries[1]![1])).toBe("[edge cluster 1] ");
  });
});

describe("mergeSearchHits", () => {
  it("globally orders by bm25 score (lower = better) and caps at limit", () => {
    const merged = mergeSearchHits(
      [
        { clusterId: CID_A, hits: [{ score: -3 }, { score: -1 }] },
        { clusterId: CID_B, hits: [{ score: -2 }] },
      ],
      2,
    );
    expect(merged.map((m) => m.clusterId)).toEqual([CID_A, CID_B]);
    expect(merged.map((m) => m.hit.score)).toEqual([-3, -2]);
  });
});
