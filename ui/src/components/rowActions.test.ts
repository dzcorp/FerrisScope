// Row context-menu composition. Pins which kinds surface "View logs":
// pods (gated on a non-empty container list) and the pod-bearing workloads
// (aggregated logs over the selector-resolved pods); nodes and arbitrary
// kinds don't.

import { describe, it, expect, vi } from "vitest";
import { actionsForRow, type RowActionContext } from "./rowActions";
import type { ResourceKind, ResourceRow } from "../types";

function kindOf(id: string, kind: string): ResourceKind {
  return {
    id,
    group: "",
    version: "v1",
    kind,
    plural: id,
    namespaced: true,
    category: "Workloads" as ResourceKind["category"],
    columns: [],
  };
}

function ctxFor(
  kind: ResourceKind,
  row: Partial<ResourceRow> = {},
): RowActionContext {
  return {
    kind,
    row: { uid: "u1", name: "obj", namespace: "default", ...row },
    openDetail: vi.fn(),
    openLogs: vi.fn(),
  };
}

function labels(ctx: RowActionContext): string[] {
  return actionsForRow(ctx)
    .filter((i) => i.kind === "item")
    .map((i) => (i.kind === "item" ? i.label : ""));
}

describe("actionsForRow — View logs availability", () => {
  it("pods: present, disabled without containers", () => {
    const withContainers = ctxFor(kindOf("pods", "Pod"), {
      containers: ["app"],
    });
    const items = actionsForRow(withContainers);
    const logs = items.find(
      (i) => i.kind === "item" && i.label === "View logs",
    );
    expect(logs).toBeTruthy();
    expect(logs!.kind === "item" && logs!.disabled).toBeFalsy();

    const empty = actionsForRow(ctxFor(kindOf("pods", "Pod")));
    const disabled = empty.find(
      (i) => i.kind === "item" && i.label === "View logs",
    );
    expect(disabled!.kind === "item" && disabled!.disabled).toBe(true);
  });

  it("every pod-bearing workload kind gets View logs", () => {
    for (const [id, kind] of [
      ["deployments", "Deployment"],
      ["statefulsets", "StatefulSet"],
      ["daemonsets", "DaemonSet"],
      ["replicasets", "ReplicaSet"],
      ["jobs", "Job"],
    ] as const) {
      expect(labels(ctxFor(kindOf(id, kind)))).toContain("View logs");
    }
  });

  it("nodes and generic kinds don't", () => {
    expect(labels(ctxFor(kindOf("nodes", "Node")))).not.toContain("View logs");
    expect(labels(ctxFor(kindOf("configmaps", "ConfigMap")))).not.toContain(
      "View logs",
    );
  });

  it("workload View logs invokes the openLogs callback", () => {
    const ctx = ctxFor(kindOf("deployments", "Deployment"));
    const item = actionsForRow(ctx).find(
      (i) => i.kind === "item" && i.label === "View logs",
    );
    if (item?.kind === "item") item.onClick();
    expect(ctx.openLogs).toHaveBeenCalledOnce();
  });
});
