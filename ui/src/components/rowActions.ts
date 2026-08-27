import { logErr } from "../lib/log";
import { execContainers, rowLogContainers } from "../lib/podContainers";
import type { ResourceKind, ResourceRow } from "../types";
import type { MenuItem } from "./ContextMenu";

export type RowActionContext = {
  kind: ResourceKind;
  row: ResourceRow;
  openDetail: () => void;
  openLogs: () => void;
  openExec?: () => void;
  openYamlEdit?: () => void;
  openPortForward?: () => void;
  restart?: () => void;
  // Graceful, PDB-aware single-pod eviction (pods only). Distinct from
  // `delete` (raw DELETE) — surfaces the disruption-budget block when present.
  evict?: () => void;
  delete?: () => void;
  // Node-only operations. `cordon` is null when the node action makes no
  // sense (non-node row); when present, it carries the *target* state — i.e.
  // the menu shows "Cordon" when the node is currently schedulable and
  // "Uncordon" when it isn't, and the same callback flips it accordingly.
  cordonTo?: { target: boolean; run: () => void };
  drain?: () => void;
  // Job / CronJob. Same shape as `cordonTo`: carries the *target* state, so
  // the menu label flips between Suspend and Resume off one callback.
  suspendTo?: { target: boolean; run: () => void };
  // CronJob: create a Job from the template now, out of schedule.
  trigger?: () => void;
  // Job: clone it under a new name. A Job spec is immutable, so there is no
  // in-place re-run.
  rerun?: () => void;
};

// Per HV2PodMenu, pod actions surface in this order with destructive items
// (Delete) trailing — R-04: never the default action of the group.
export function actionsForRow(
  ctx: RowActionContext,
  opts?: { readOnly?: boolean },
): MenuItem[] {
  const {
    kind,
    row,
    openDetail,
    openLogs,
    openExec,
    openYamlEdit,
    openPortForward,
    restart,
  } = ctx;
  // Cluster degraded (unavailable / mid auto-reconnect): every mutating item
  // disables, but View details / View logs / Copy stay live.
  const readOnly = opts?.readOnly ?? false;
  const name = String(row.name ?? "");
  const ns = typeof row.namespace === "string" ? row.namespace : null;
  const qualified = ns ? `${ns}/${name}` : name;
  // Two different sets: the log endpoint serves init containers, `exec` can't
  // attach to one. A pod that has only ever run init containers therefore gets
  // "View logs" enabled and "Exec shell" disabled.
  const logContainers = rowLogContainers(row);
  const shellContainers = execContainers(logContainers);

  const items: MenuItem[] = [];

  items.push({ kind: "item", label: "View details", onClick: openDetail });

  if (kind.id === "pods") {
    items.push({
      kind: "item",
      label: "View logs",
      onClick: openLogs,
      disabled: logContainers.length === 0,
    });
    if (openExec)
      items.push({
        kind: "item",
        label: "Exec shell",
        onClick: openExec,
        disabled: shellContainers.length === 0 || readOnly,
      });
    if (openYamlEdit)
      items.push({
        kind: "item",
        label: "Edit YAML",
        onClick: openYamlEdit,
        disabled: readOnly,
      });
    if (openPortForward)
      items.push({
        kind: "item",
        label: "Port forward",
        onClick: openPortForward,
        disabled: readOnly,
      });
  } else if (kind.id === "deployments" || kind.id === "statefulsets") {
    // Aggregated logs over the workload's pods (resolved via its selector).
    items.push({ kind: "item", label: "View logs", onClick: openLogs });
    if (openYamlEdit)
      items.push({
        kind: "item",
        label: "Edit YAML",
        onClick: openYamlEdit,
        disabled: readOnly,
      });
  } else if (
    kind.id === "daemonsets" ||
    kind.id === "replicasets" ||
    kind.id === "jobs"
  ) {
    items.push({ kind: "item", label: "View logs", onClick: openLogs });
    if (kind.id === "jobs" && ctx.rerun)
      items.push({
        kind: "item",
        label: "Re-run job",
        onClick: ctx.rerun,
        disabled: readOnly,
      });
    if (kind.id === "jobs" && ctx.suspendTo)
      items.push({
        kind: "item",
        label: ctx.suspendTo.target ? "Suspend job" : "Resume job",
        onClick: ctx.suspendTo.run,
        disabled: readOnly,
      });
  } else if (kind.id === "cronjobs") {
    // "Run now" leads: it is the reason an operator opens this menu, and it
    // is the only non-destructive way to exercise a CronJob.
    if (ctx.trigger)
      items.push({
        kind: "item",
        label: "Run now",
        onClick: ctx.trigger,
        disabled: readOnly,
      });
    if (ctx.suspendTo)
      items.push({
        kind: "item",
        label: ctx.suspendTo.target ? "Suspend cron job" : "Resume cron job",
        onClick: ctx.suspendTo.run,
        disabled: readOnly,
      });
    if (openYamlEdit)
      items.push({
        kind: "item",
        label: "Edit YAML",
        onClick: openYamlEdit,
        disabled: readOnly,
      });
  } else if (kind.id === "nodes") {
    if (openExec)
      items.push({
        kind: "item",
        label: "Node shell (debug)",
        onClick: openExec,
        disabled: readOnly,
      });
    if (ctx.cordonTo)
      items.push({
        kind: "item",
        label: ctx.cordonTo.target ? "Cordon" : "Uncordon",
        onClick: ctx.cordonTo.run,
        disabled: readOnly,
      });
    if (ctx.drain)
      items.push({
        kind: "item",
        label: "Drain",
        onClick: ctx.drain,
        disabled: readOnly,
      });
    if (openYamlEdit)
      items.push({
        kind: "item",
        label: "Edit YAML",
        onClick: openYamlEdit,
        disabled: readOnly,
      });
  }

  items.push({ kind: "separator" });

  items.push({
    kind: "item",
    label: ns ? "Copy namespace/name" : "Copy name",
    onClick: () => copy(qualified),
  });
  if (ns) {
    items.push({
      kind: "item",
      label: "Copy name",
      onClick: () => copy(name),
    });
  }
  items.push({
    kind: "item",
    label: "Copy UID",
    onClick: () => copy(row.uid),
  });

  if (kind.id === "pods" && (restart || ctx.evict || ctx.delete)) {
    items.push({ kind: "separator" });
    if (restart)
      items.push({
        kind: "item",
        label: "Restart pod",
        onClick: restart,
        disabled: readOnly,
      });
    // Evict = graceful, PDB-aware. Sits above Delete (raw DELETE) so the
    // budget-respecting path is the first destructive option operators reach.
    if (ctx.evict)
      items.push({
        kind: "item",
        label: "Evict pod",
        onClick: ctx.evict,
        danger: true,
        disabled: readOnly,
      });
    if (ctx.delete)
      items.push({
        kind: "item",
        label: "Delete pod",
        onClick: ctx.delete,
        danger: true,
        disabled: readOnly,
      });
  } else if (kind.id === "nodes" && ctx.delete) {
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: "Delete node",
      onClick: ctx.delete,
      danger: true,
      disabled: readOnly,
    });
  } else if (kind.id === "helm_charts") {
    // Helm chart rows are synthetic catalog entries — there's no single
    // object to delete. To remove a chart from the catalog the operator
    // uninstalls the underlying releases.
  } else if (kind.id === "helm_releases" && ctx.delete) {
    // Helm releases are synthetic too, but they DO have a backing
    // helm-uninstall verb. Backend's delete_resource_cmd routes
    // helm_releases through `helm uninstall` so the rendered workloads
    // are cleaned up, not just the release secret. Label clearly so
    // operators understand it's `helm uninstall`, not a raw delete.
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: "Uninstall release",
      onClick: ctx.delete,
      danger: true,
      disabled: readOnly,
    });
  } else if (kind.id !== "pods" && kind.id !== "nodes" && ctx.delete) {
    // Generic Delete for every other kind. The dynamic API in
    // `api.deleteResource` handles the verb generically — no per-kind backend
    // work needed. Nodes and pods get their own branches above so labels read
    // naturally ("Delete pod" / "Delete node").
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: `Delete ${kind.kind.toLowerCase()}`,
      onClick: ctx.delete,
      danger: true,
      disabled: readOnly,
    });
  }

  return items;
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(logErr("row-actions"));
}
