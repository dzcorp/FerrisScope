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
  delete?: () => void;
  // Node-only operations. `cordon` is null when the node action makes no
  // sense (non-node row); when present, it carries the *target* state — i.e.
  // the menu shows "Cordon" when the node is currently schedulable and
  // "Uncordon" when it isn't, and the same callback flips it accordingly.
  cordonTo?: { target: boolean; run: () => void };
  drain?: () => void;
};

// Per HV2PodMenu, pod actions surface in this order with destructive items
// (Delete) trailing — R-04: never the default action of the group.
export function actionsForRow(ctx: RowActionContext): MenuItem[] {
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
  const name = String(row.name ?? "");
  const ns = typeof row.namespace === "string" ? row.namespace : null;
  const qualified = ns ? `${ns}/${name}` : name;
  const containers = Array.isArray(row.containers)
    ? (row.containers as unknown[])
    : [];

  const items: MenuItem[] = [];

  items.push({ kind: "item", label: "View details", onClick: openDetail });

  if (kind.id === "pods") {
    items.push({
      kind: "item",
      label: "View logs",
      onClick: openLogs,
      disabled: containers.length === 0,
    });
    if (openExec)
      items.push({
        kind: "item",
        label: "Exec shell",
        onClick: openExec,
        disabled: containers.length === 0,
      });
    if (openYamlEdit)
      items.push({ kind: "item", label: "Edit YAML", onClick: openYamlEdit });
    if (openPortForward)
      items.push({
        kind: "item",
        label: "Port forward",
        onClick: openPortForward,
      });
  } else if (kind.id === "deployments" || kind.id === "statefulsets") {
    if (openYamlEdit)
      items.push({ kind: "item", label: "Edit YAML", onClick: openYamlEdit });
  } else if (kind.id === "nodes") {
    if (openExec)
      items.push({ kind: "item", label: "Node shell (debug)", onClick: openExec });
    if (ctx.cordonTo)
      items.push({
        kind: "item",
        label: ctx.cordonTo.target ? "Cordon" : "Uncordon",
        onClick: ctx.cordonTo.run,
      });
    if (ctx.drain)
      items.push({ kind: "item", label: "Drain", onClick: ctx.drain });
    if (openYamlEdit)
      items.push({ kind: "item", label: "Edit YAML", onClick: openYamlEdit });
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

  if (kind.id === "pods" && (restart || ctx.delete)) {
    items.push({ kind: "separator" });
    if (restart)
      items.push({
        kind: "item",
        label: "Restart pod",
        onClick: restart,
      });
    if (ctx.delete)
      items.push({
        kind: "item",
        label: "Delete pod",
        onClick: ctx.delete,
        danger: true,
      });
  } else if (kind.id === "nodes" && ctx.delete) {
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: "Delete node",
      onClick: ctx.delete,
      danger: true,
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
    });
  }

  return items;
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}
