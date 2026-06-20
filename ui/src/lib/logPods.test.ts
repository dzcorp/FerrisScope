import { describe, it, expect } from "vitest";
import { applyPodDelta, podKey, pruneAfterInit } from "./logPods";
import type { ObservedPod } from "./logSources";
import type { LogPodEvent } from "../types";

const pod = (name: string, containers: string[]): { namespace: string; name: string; containers: string[] } => ({
  namespace: "default",
  name,
  containers,
});

const observed = (
  clusterId: string,
  namespace: string,
  name: string,
): ObservedPod => ({ clusterId, namespace, name, containers: ["app"] });

describe("applyPodDelta", () => {
  it("adds a pod and reports the map changed", () => {
    const map = new Map<string, ObservedPod>();
    const changed = applyPodDelta(map, "cl1", {
      kind: "added",
      pod: pod("web-0", ["app"]),
    });
    expect(changed).toBe(true);
    expect(map.get(podKey("cl1", "default", "web-0"))).toEqual({
      clusterId: "cl1",
      namespace: "default",
      name: "web-0",
      containers: ["app"],
    });
  });

  it("removes a tracked pod, and is a no-op for an unknown one", () => {
    const map = new Map<string, ObservedPod>();
    applyPodDelta(map, "cl1", { kind: "added", pod: pod("web-0", ["app"]) });

    const removed: LogPodEvent = {
      kind: "removed",
      namespace: "default",
      name: "web-0",
    };
    expect(applyPodDelta(map, "cl1", removed)).toBe(true);
    expect(map.size).toBe(0);
    // Already gone → no change.
    expect(applyPodDelta(map, "cl1", removed)).toBe(false);
  });

  it("keeps clusters separate (same ns/name, different cluster)", () => {
    const map = new Map<string, ObservedPod>();
    applyPodDelta(map, "cl1", { kind: "added", pod: pod("web-0", ["app"]) });
    applyPodDelta(map, "cl2", { kind: "added", pod: pod("web-0", ["app"]) });
    expect(map.size).toBe(2);
  });

  it("re-adding an existing pod overwrites it (idempotent)", () => {
    const map = new Map<string, ObservedPod>();
    applyPodDelta(map, "cl1", { kind: "added", pod: pod("web-0", ["app"]) });
    applyPodDelta(map, "cl1", {
      kind: "added",
      pod: pod("web-0", ["app", "sidecar"]),
    });
    expect(map.size).toBe(1);
    expect(map.get(podKey("cl1", "default", "web-0"))?.containers).toEqual([
      "app",
      "sidecar",
    ]);
  });

  it("treats init_done as a no-op", () => {
    const map = new Map<string, ObservedPod>();
    expect(applyPodDelta(map, "cl1", { kind: "init_done" })).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe("pruneAfterInit", () => {
  it("drops a stale one-shot pod the watch never confirmed", () => {
    // Seed two pods (one-shot snapshot); the watch only confirms web-0.
    const map = new Map<string, ObservedPod>([
      [podKey("cl1", "default", "web-0"), observed("cl1", "default", "web-0")],
      [podKey("cl1", "default", "web-1"), observed("cl1", "default", "web-1")],
    ]);
    const confirmed = new Set([podKey("cl1", "default", "web-0")]);
    expect(pruneAfterInit(map, "cl1", "default", confirmed)).toBe(true);
    expect(map.has(podKey("cl1", "default", "web-0"))).toBe(true);
    expect(map.has(podKey("cl1", "default", "web-1"))).toBe(false);
  });

  it("keeps pods owned by a sibling watch in the same namespace", () => {
    // web-0 belongs to this target; api-0 to a sibling workload — both
    // confirmed, so a prune for either target must keep both.
    const map = new Map<string, ObservedPod>([
      [podKey("cl1", "default", "web-0"), observed("cl1", "default", "web-0")],
      [podKey("cl1", "default", "api-0"), observed("cl1", "default", "api-0")],
    ]);
    const confirmed = new Set([
      podKey("cl1", "default", "web-0"),
      podKey("cl1", "default", "api-0"),
    ]);
    expect(pruneAfterInit(map, "cl1", "default", confirmed)).toBe(false);
    expect(map.size).toBe(2);
  });

  it("never touches another namespace or cluster", () => {
    const map = new Map<string, ObservedPod>([
      [podKey("cl1", "other", "x-0"), observed("cl1", "other", "x-0")],
      [podKey("cl2", "default", "y-0"), observed("cl2", "default", "y-0")],
    ]);
    // Prune scoped to (cl1, default) with nothing confirmed there — both
    // entries are out of scope and survive.
    expect(pruneAfterInit(map, "cl1", "default", new Set())).toBe(false);
    expect(map.size).toBe(2);
  });
});
