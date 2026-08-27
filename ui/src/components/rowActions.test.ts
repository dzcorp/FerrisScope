// Row context-menu composition. Pins which kinds surface "View logs":
// pods (gated on a non-empty container list) and the pod-bearing workloads
// (aggregated logs over the selector-resolved pods); nodes and arbitrary
// kinds don't.

import { describe, it, expect, vi } from "vitest";
import {
  actionsForRow,
  actionsForSelection,
  menuScopeFor,
  selectionMenuHeader,
  type RowActionContext,
} from "./rowActions";
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
      container_states: [{ name: "app", kind: "main" }],
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

describe("actionsForRow — Evict pod", () => {
  it("pods with an evict callback surface a danger 'Evict pod' item", () => {
    const ctx: RowActionContext = {
      ...ctxFor(kindOf("pods", "Pod"), { container_states: [{ name: "app", kind: "main" }] }),
      evict: vi.fn(),
    };
    const item = actionsForRow(ctx).find(
      (i) => i.kind === "item" && i.label === "Evict pod",
    );
    expect(item).toBeTruthy();
    expect(item!.kind === "item" && item!.danger).toBe(true);
    if (item?.kind === "item") item.onClick();
    expect(ctx.evict).toHaveBeenCalledOnce();
  });

  it("no 'Evict pod' item without the callback, and never for non-pods", () => {
    expect(labels(ctxFor(kindOf("pods", "Pod")))).not.toContain("Evict pod");
    expect(
      labels({ ...ctxFor(kindOf("nodes", "Node")), evict: vi.fn() }),
    ).not.toContain("Evict pod");
  });
});

describe("actionsForRow — read-only gating", () => {
  // A pod ctx wired with every optional write callback so all mutating items
  // are present in the menu (they're only pushed when their callback exists).
  const podCtx = (): RowActionContext => ({
    ...ctxFor(kindOf("pods", "Pod"), { container_states: [{ name: "app", kind: "main" }] }),
    openExec: vi.fn(),
    openYamlEdit: vi.fn(),
    openPortForward: vi.fn(),
    restart: vi.fn(),
    evict: vi.fn(),
    delete: vi.fn(),
  });

  const disabledFor = (label: string, readOnly: boolean): boolean | undefined => {
    const item = actionsForRow(podCtx(), { readOnly }).find(
      (i) => i.kind === "item" && i.label === label,
    );
    return item?.kind === "item" ? item.disabled : undefined;
  };

  it("disables every write action when readOnly", () => {
    for (const label of [
      "Delete pod",
      "Evict pod",
      "Restart pod",
      "Exec shell",
      "Edit YAML",
      "Port forward",
    ]) {
      expect(disabledFor(label, true)).toBe(true);
      expect(disabledFor(label, false)).toBeFalsy();
    }
  });

  it("keeps read/navigation actions enabled when readOnly", () => {
    // Namespaced row → the copy item is labelled "Copy namespace/name".
    for (const label of [
      "View details",
      "View logs",
      "Copy namespace/name",
      "Copy UID",
    ]) {
      expect(disabledFor(label, true)).toBeFalsy();
    }
  });
});

describe("actionsForRow — batch workloads", () => {
  it("cronjobs: Run now leads, suspend label reflects current state", () => {
    const kind = kindOf("cronjobs", "CronJob");
    // The CronJob row projects `suspend` as a string — it backs a text
    // column — so the caller normalises it, not this module.
    const ctx = ctxFor(kind);
    ctx.trigger = vi.fn();
    ctx.suspendTo = { target: true, run: vi.fn() };
    expect(labels(ctx).slice(0, 3)).toEqual([
      "View details",
      "Run now",
      "Suspend cron job",
    ]);

    ctx.suspendTo = { target: false, run: vi.fn() };
    expect(labels(ctx)).toContain("Resume cron job");
  });

  it("cronjobs: delete is present and last, and reads as a CronJob delete", () => {
    const kind = kindOf("cronjobs", "CronJob");
    const ctx = ctxFor(kind);
    ctx.delete = vi.fn();
    const all = labels(ctx);
    expect(all.at(-1)).toBe("Delete cronjob");
  });

  it("jobs: Re-run and Suspend sit with the other job actions", () => {
    const kind = kindOf("jobs", "Job");
    const ctx = ctxFor(kind);
    ctx.rerun = vi.fn();
    ctx.suspendTo = { target: true, run: vi.fn() };
    expect(labels(ctx).slice(0, 4)).toEqual([
      "View details",
      "View logs",
      "Re-run job",
      "Suspend job",
    ]);
  });

  it("omits batch actions when the caller supplies no callback", () => {
    // A kind whose callbacks the caller didn't wire must not render dead
    // menu entries.
    const jobs = labels(ctxFor(kindOf("jobs", "Job")));
    expect(jobs).not.toContain("Re-run job");
    expect(jobs).not.toContain("Suspend job");

    const cron = labels(ctxFor(kindOf("cronjobs", "CronJob")));
    expect(cron).not.toContain("Run now");
  });

  /// A finished Job can't be suspended — the apiserver accepts the patch and
  /// the controller ignores it, so an enabled menu entry would look like it
  /// worked. The caller drops the callback; this pins that the menu follows.
  it("omits Suspend for a Job that already finished", () => {
    const kind = kindOf("jobs", "Job");
    for (const phase of ["Succeeded", "Failed"]) {
      const ctx = ctxFor(kind, { phase });
      ctx.rerun = vi.fn();
      // suspendTo intentionally unset — mirrors what buildRowActionContext does.
      const all = labels(ctx);
      expect(all).not.toContain("Suspend job");
      // Re-running a finished Job is exactly what you want, though.
      expect(all).toContain("Re-run job");
    }
  });

  it("disables every mutating batch action when readOnly", () => {
    const kind = kindOf("cronjobs", "CronJob");
    const ctx = ctxFor(kind);
    ctx.trigger = vi.fn();
    ctx.suspendTo = { target: true, run: vi.fn() };
    const items = actionsForRow(ctx, { readOnly: true });
    for (const label of ["Run now", "Suspend cron job"]) {
      const item = items.find((i) => i.kind === "item" && i.label === label);
      expect(item?.kind === "item" && item.disabled).toBe(true);
    }
    // …while navigation stays live.
    const details = items.find(
      (i) => i.kind === "item" && i.label === "View details",
    );
    expect(details?.kind === "item" && details.disabled).toBeFalsy();
  });
});

describe("actionsForSelection", () => {
  const bulk = [
    { icon: null, label: "Run now", onClick: vi.fn() },
    { icon: null, label: "Suspend", onClick: vi.fn() },
    { icon: null, label: "Copy names", onClick: vi.fn() },
    {
      icon: null,
      label: "Delete",
      onClick: vi.fn(),
      danger: true,
      separatorBefore: true,
      disabled: false,
    },
  ];

  /// The verbs must be the bulk builders' verbs verbatim — the whole point of
  /// sharing them with the BulkBar is that the two surfaces can't drift.
  it("renders the bulk actions in order, honouring separators", () => {
    const items = actionsForSelection({
      kind: kindOf("cronjobs", "CronJob"),
      count: 20,
      bulk,
    });
    expect(items.map((i) => (i.kind === "item" ? i.label : "—"))).toEqual([
      "View details (one row only)",
      "Run now",
      "Suspend",
      "Copy names",
      "—",
      "Delete",
    ]);
  });

  /// Dropping single-row entries outright reads as a broken menu; saying why
  /// they don't apply does not.
  it("keeps the single-row entry visible but disabled", () => {
    const items = actionsForSelection({
      kind: kindOf("jobs", "Job"),
      count: 3,
      bulk: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "item" && items[0].disabled).toBe(true);
  });

  it("carries danger through so destructive picks still trail in red", () => {
    const items = actionsForSelection({
      kind: kindOf("jobs", "Job"),
      count: 3,
      bulk,
    });
    const del = items.find((i) => i.kind === "item" && i.label === "Delete");
    expect(del?.kind === "item" && del.danger).toBe(true);
  });

  it("disables every bulk verb when the table is read-only", () => {
    const items = actionsForSelection({
      kind: kindOf("jobs", "Job"),
      count: 3,
      bulk,
      readOnly: true,
    });
    for (const item of items) {
      if (item.kind === "item") expect(item.disabled).toBe(true);
    }
  });

  it("fires the bulk action's own callback", () => {
    const onClick = vi.fn();
    const items = actionsForSelection({
      kind: kindOf("jobs", "Job"),
      count: 3,
      bulk: [{ icon: null, label: "Suspend", onClick }],
    });
    const item = items.find((i) => i.kind === "item" && i.label === "Suspend");
    if (item?.kind !== "item") throw new Error("Suspend not found");
    item.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("selectionMenuHeader", () => {
  it("pluralises off the kind's own plural, not an appended s", () => {
    expect(selectionMenuHeader(kindOf("cronjobs", "CronJob"), 20)).toBe(
      "20 cronjobs selected",
    );
    expect(selectionMenuHeader(kindOf("jobs", "Job"), 1)).toBe(
      "1 job selected",
    );
  });
});

describe("menuScopeFor", () => {
  const sel = (...sids: string[]) =>
    new Map(sids.map((s) => [s, {} as unknown]));

  it("acts on the selection when the click lands inside a multi-row one", () => {
    expect(menuScopeFor(sel("a", "b", "c"), "b")).toEqual({
      scope: "selection",
      clear: false,
    });
  });

  /// The case the whole change exists for: clicking a row outside the
  /// selection must not leave twenty rows highlighted while the menu acts on
  /// one — drop the selection so the two agree.
  it("drops the selection when the click lands outside it", () => {
    expect(menuScopeFor(sel("a", "b"), "z")).toEqual({
      scope: "row",
      clear: true,
    });
  });

  /// One selected row is not a bulk operation; relabelling every entry for it
  /// would be noise. It stays a row menu — and keeps its highlight, because
  /// selection and menu already name the same row.
  it("treats a single-row selection as a row menu and keeps it", () => {
    expect(menuScopeFor(sel("a"), "a")).toEqual({ scope: "row", clear: false });
  });

  it("needs no selection at all", () => {
    expect(menuScopeFor(sel(), "a")).toEqual({ scope: "row", clear: false });
  });
});
