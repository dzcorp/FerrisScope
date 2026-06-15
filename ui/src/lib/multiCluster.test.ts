import { describe, it, expect } from "vitest";
import {
  scopedUid,
  parseScopedUid,
  scopeRow,
  applyScopedDelta,
  mergeScopedSnapshots,
  aggregateVirtualContext,
  clusterColorIndexMap,
  groupByCluster,
  bulkClusterPrefix,
  mergeSearchHits,
  shortClusterNames,
  defaultVirtualContextName,
  namespaceClusterTags,
  type ScopedRow,
} from "./multiCluster";
import { CLUSTER_ACCENTS, clusterAccent } from "../theme";
import type { ClusterProbe } from "../types";

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

describe("shortClusterNames", () => {
  it("strips the common token prefix from sibling names", () => {
    const shorts = shortClusterNames([
      "myproject-mystage-prod-07",
      "myproject-mystage-prod-08",
    ]);
    expect(shorts["myproject-mystage-prod-07"]).toBe("07");
    expect(shorts["myproject-mystage-prod-08"]).toBe("08");
  });

  it("strips common prefix AND suffix, keeping the differing middle", () => {
    const shorts = shortClusterNames([
      "gke_myproject_europe-west1_prod-07",
      "gke_myproject_us-east1_prod-07",
    ]);
    expect(shorts["gke_myproject_europe-west1_prod-07"]).toBe("europe-west1");
    expect(shorts["gke_myproject_us-east1_prod-07"]).toBe("us-east1");
  });

  it("keeps at least one token when a name is a prefix of a sibling", () => {
    const shorts = shortClusterNames(["prod", "prod-eu"]);
    expect(shorts["prod"]).toBe("prod");
    expect(shorts["prod-eu"]).toBe("prod-eu");
  });

  it("returns names untouched when nothing is common", () => {
    const shorts = shortClusterNames(["alpha", "beta-edge"]);
    expect(shorts["alpha"]).toBe("alpha");
    expect(shorts["beta-edge"]).toBe("beta-edge");
  });

  it("returns a single name untouched", () => {
    expect(shortClusterNames(["myproject-prod-07"])).toEqual({
      "myproject-prod-07": "myproject-prod-07",
    });
  });

  it("falls back to full names when shorts would collide", () => {
    // "a-b" and "a_b" tokenize identically — both must stay full.
    const shorts = shortClusterNames(["pre-a-b", "pre-a_b", "pre-c"]);
    expect(shorts["pre-a-b"]).toBe("pre-a-b");
    expect(shorts["pre-a_b"]).toBe("pre-a_b");
    expect(shorts["pre-c"]).toBe("c");
  });

  it("compresses 3+ siblings against the shared prefix only", () => {
    const shorts = shortClusterNames([
      "fleet-edge-paris",
      "fleet-edge-berlin",
      "fleet-edge-madrid",
    ]);
    expect(shorts["fleet-edge-paris"]).toBe("paris");
    expect(shorts["fleet-edge-berlin"]).toBe("berlin");
    expect(shorts["fleet-edge-madrid"]).toBe("madrid");
  });
});

describe("defaultVirtualContextName", () => {
  it("joins two dissimilar member names with ' + ' untouched", () => {
    expect(defaultVirtualContextName(["alpha", "beta-edge"], [])).toBe(
      "alpha + beta-edge",
    );
  });

  it("compresses sibling names with the table's shortClusterNames logic", () => {
    expect(defaultVirtualContextName(["prod-eu", "prod-us"], [])).toBe(
      "eu + us",
    );
    expect(
      defaultVirtualContextName(
        ["myproject-mystage-prod-07", "myproject-mystage-prod-08"],
        [],
      ),
    ).toBe("07 + 08");
  });

  it("uses '+N' beyond two members", () => {
    expect(defaultVirtualContextName(["a", "b", "c", "d"], [])).toBe("a +3");
    expect(
      defaultVirtualContextName(
        ["fleet-edge-paris", "fleet-edge-berlin", "fleet-edge-madrid"],
        [],
      ),
    ).toBe("paris +2");
  });

  it("dedupes against taken names case-insensitively", () => {
    expect(defaultVirtualContextName(["prod-eu", "prod-us"], ["EU + us"])).toBe(
      "eu + us (2)",
    );
    expect(
      defaultVirtualContextName(
        ["prod-eu", "prod-us"],
        ["eu + us", "eu + us (2)"],
      ),
    ).toBe("eu + us (3)");
  });
});

describe("namespaceClusterTags", () => {
  const MEMBERS = [
    { id: "default::fleet-prod-eu", name: "fleet-prod-eu" },
    { id: "default::fleet-prod-us", name: "fleet-prod-us" },
  ];

  it("tags only namespaces missing from some reporting member", () => {
    const tags = namespaceClusterTags(
      {
        default: ["default::fleet-prod-eu", "default::fleet-prod-us"],
        "eu-only": ["default::fleet-prod-eu"],
      },
      MEMBERS,
    );
    expect(tags["default"]).toBeUndefined();
    expect(tags["eu-only"]).toEqual([
      { clusterId: "default::fleet-prod-eu", label: "eu" },
    ]);
  });

  it("returns no tags for single-member views", () => {
    expect(
      namespaceClusterTags({ a: ["default::fleet-prod-eu"] }, [MEMBERS[0]!]),
    ).toEqual({});
  });

  it("ignores a member that reported nothing (down cluster)", () => {
    // prod-us never reported a namespace — nothing should be flagged as
    // partial just because it is unreachable.
    const tags = namespaceClusterTags(
      {
        default: ["default::fleet-prod-eu"],
        web: ["default::fleet-prod-eu"],
      },
      MEMBERS,
    );
    expect(tags).toEqual({});
  });

  it("drops cluster ids that are no longer members", () => {
    const tags = namespaceClusterTags(
      {
        default: [
          "default::fleet-prod-eu",
          "default::fleet-prod-us",
          "default::gone",
        ],
        "us-only": ["default::fleet-prod-us", "default::gone"],
      },
      MEMBERS,
    );
    expect(tags["default"]).toBeUndefined();
    expect(tags["us-only"]).toEqual([
      { clusterId: "default::fleet-prod-us", label: "us" },
    ]);
  });
});

describe("aggregateVirtualContext", () => {
  const probe = (over: Partial<ClusterProbe>): ClusterProbe => ({
    context_name: "x",
    server_version: null,
    nodes: null,
    pods: null,
    cpu_used_milli: null,
    cpu_capacity_milli: null,
    mem_used_mib: null,
    mem_capacity_mib: null,
    healthy: null,
    fetched_at_unix_ms: 0,
    last_error: null,
    ...over,
  });
  const known = new Set([CID_A, CID_B]);

  it("sums nodes/pods across members and pools cpu/mem into one ratio", () => {
    const agg = aggregateVirtualContext([CID_A, CID_B], known, {
      [CID_A]: probe({
        nodes: 3,
        pods: 10,
        cpu_used_milli: 500,
        cpu_capacity_milli: 1000,
        mem_used_mib: 1024,
        mem_capacity_mib: 4096,
        healthy: true,
      }),
      [CID_B]: probe({
        nodes: 2,
        pods: 20,
        cpu_used_milli: 250,
        cpu_capacity_milli: 500,
        mem_used_mib: 1024,
        mem_capacity_mib: 4096,
        healthy: true,
      }),
    });
    expect(agg.nodes).toBe(5);
    expect(agg.pods).toBe(30);
    expect(agg.cpuRatio).toBeCloseTo(750 / 1500);
    expect(agg.memRatio).toBeCloseTo(2048 / 8192);
    expect(agg.health).toBe("good");
    expect(agg.missing).toBe(0);
    expect(agg.unreachable).toBe(0);
  });

  it("returns nulls when no member has data yet", () => {
    const agg = aggregateVirtualContext([CID_A, CID_B], known, {});
    expect(agg.nodes).toBeNull();
    expect(agg.pods).toBeNull();
    expect(agg.cpuRatio).toBeNull();
    expect(agg.memRatio).toBeNull();
    expect(agg.health).toBe("unknown");
  });

  it("excludes per-member partial cpu data (used without capacity) from the ratio", () => {
    const agg = aggregateVirtualContext([CID_A, CID_B], known, {
      [CID_A]: probe({ cpu_used_milli: 900, healthy: true }),
      [CID_B]: probe({
        cpu_used_milli: 100,
        cpu_capacity_milli: 1000,
        healthy: true,
      }),
    });
    expect(agg.cpuRatio).toBeCloseTo(0.1);
  });

  it("a member missing from the kubeconfig is counted and its stale probe ignored", () => {
    const agg = aggregateVirtualContext(
      [CID_A, "default::gone"],
      known,
      {
        [CID_A]: probe({ nodes: 3, healthy: true }),
        "default::gone": probe({ nodes: 99, healthy: true }),
      },
    );
    expect(agg.missing).toBe(1);
    expect(agg.nodes).toBe(3);
    expect(agg.health).toBe("bad");
  });

  it("an unreachable member flips health to bad but keeps the others' numbers", () => {
    const agg = aggregateVirtualContext([CID_A, CID_B], known, {
      [CID_A]: probe({ nodes: 3, pods: 10, healthy: true }),
      [CID_B]: probe({ healthy: false, last_error: "timeout" }),
    });
    expect(agg.unreachable).toBe(1);
    expect(agg.nodes).toBe(3);
    expect(agg.pods).toBe(10);
    expect(agg.health).toBe("bad");
  });

  it("stays unknown when only some members are probed healthy", () => {
    const agg = aggregateVirtualContext([CID_A, CID_B], known, {
      [CID_A]: probe({ healthy: true }),
    });
    expect(agg.health).toBe("unknown");
  });
});
