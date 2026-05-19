// Snapshot helper used by DockChat to brief the assistant on what the
// operator is currently looking at. Tests cover the empty-state opt-out,
// the kind label lookup, and the namespace / selection projections.

import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store";
import type { ResourceKind } from "../../types";
import { snapshotViewContext } from "./viewContext";

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({
    ...initial,
    selectedContext: null,
    selectedKindId: null,
    selectedNamespaces: new Set<string>(),
    selection: new Map<string, { namespace: string | null; name: string }>(),
    kinds: [],
  });
});

const deploymentsKind: ResourceKind = {
  id: "deployments",
  group: "apps",
  version: "v1",
  kind: "Deployment",
  plural: "deployments",
  namespaced: true,
  category: "Workloads",
  columns: [],
};

describe("snapshotViewContext", () => {
  it("returns undefined when nothing is selected", () => {
    expect(snapshotViewContext()).toBeUndefined();
  });

  it("captures cluster + kind label + namespaces + selection", () => {
    useAppStore.setState({
      selectedContext: "kind-dev",
      selectedKindId: "deployments",
      kinds: [deploymentsKind],
      selectedNamespaces: new Set(["default", "kube-system"]),
      selection: new Map([
        ["uid-a", { namespace: "default", name: "api" }],
        ["uid-b", { namespace: "default", name: "web" }],
      ]),
    });
    const snap = snapshotViewContext();
    expect(snap).toBeDefined();
    expect(snap!.clusterId).toBe("kind-dev");
    expect(snap!.kindId).toBe("deployments");
    expect(snap!.kindLabel).toBe("Deployment");
    expect(snap!.namespaces?.sort()).toEqual(["default", "kube-system"]);
    expect(snap!.selected).toEqual([
      { namespace: "default", name: "api" },
      { namespace: "default", name: "web" },
    ]);
  });

  it("omits namespaces when none are filtered (all-namespaces mode)", () => {
    useAppStore.setState({
      selectedContext: "kind-dev",
      selectedKindId: "deployments",
      kinds: [deploymentsKind],
    });
    const snap = snapshotViewContext();
    expect(snap?.namespaces).toBeUndefined();
    expect(snap?.selected).toBeUndefined();
  });

  it("maps null namespace on a cluster-scoped selection to undefined", () => {
    useAppStore.setState({
      selectedContext: "kind-dev",
      selectedKindId: "nodes",
      selection: new Map([
        ["uid-n", { namespace: null, name: "node-1" }],
      ]),
    });
    const snap = snapshotViewContext();
    expect(snap?.selected).toEqual([{ namespace: undefined, name: "node-1" }]);
  });

  it("omits kindLabel when the kind id isn't in the loaded kinds list", () => {
    useAppStore.setState({
      selectedContext: "kind-dev",
      selectedKindId: "deployments",
      kinds: [],
    });
    const snap = snapshotViewContext();
    expect(snap?.kindId).toBe("deployments");
    expect(snap?.kindLabel).toBeUndefined();
  });
});
