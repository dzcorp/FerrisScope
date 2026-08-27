// Title-bar action menu composition. The cascade entries are the point:
// deleting a Job with no propagation policy leaves its pods running with the
// owner reference stripped, so "keep dependents" has to be a deliberate,
// clearly labelled choice rather than the silent default.

import { describe, expect, it, vi } from "vitest";
import { buildActionMenuItems } from "./DetailPanel";

function labels(items: ReturnType<typeof buildActionMenuItems>): string[] {
  return items.filter((i) => i.kind === "item").map((i) =>
    i.kind === "item" ? i.label : "",
  );
}

describe("buildActionMenuItems — delete", () => {
  it("offers cascade choices for kinds that own dependents", () => {
    const runDelete = vi.fn();
    const items = buildActionMenuItems(
      "delete",
      "Job",
      "jobs",
      "migrate",
      [],
      undefined,
      runDelete,
    );
    expect(labels(items)).toEqual([
      "Delete job migrate",
      "Force delete (no grace period)",
      "Delete, keep dependents (orphan)",
      "Delete, wait for dependents (foreground)",
    ]);
  });

  it("passes the chosen policy through, and no policy for the plain delete", () => {
    const runDelete = vi.fn();
    const items = buildActionMenuItems(
      "delete",
      "CronJob",
      "cronjobs",
      "nightly",
      [],
      undefined,
      runDelete,
    );
    const click = (label: string) => {
      const item = items.find((i) => i.kind === "item" && i.label === label);
      if (item?.kind !== "item") throw new Error(`${label} not found`);
      item.onClick();
    };

    click("Delete cronjob nightly");
    // Undefined, not "background": the backend owns the default so a single
    // place decides it.
    expect(runDelete).toHaveBeenLastCalledWith(false);

    click("Delete, keep dependents (orphan)");
    expect(runDelete).toHaveBeenLastCalledWith(false, "orphan");

    click("Delete, wait for dependents (foreground)");
    expect(runDelete).toHaveBeenLastCalledWith(false, "foreground");
  });

  it("omits cascade for kinds with nothing to cascade to", () => {
    const items = buildActionMenuItems(
      "delete",
      "ConfigMap",
      "configmaps",
      "app-config",
      [],
      undefined,
      vi.fn(),
    );
    expect(labels(items)).toEqual([
      "Delete configmap app-config",
      "Force delete (no grace period)",
    ]);
  });

  /// Helm releases tear down through `helm uninstall`, which has its own
  /// teardown semantics — grace period and cascade both mean nothing there.
  it("keeps the helm release menu to a single uninstall entry", () => {
    const items = buildActionMenuItems(
      "delete",
      "HelmRelease",
      "helm_releases",
      "ingress-nginx",
      [],
      undefined,
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Uninstall release ingress-nginx"]);
  });

  it("every delete entry is marked danger", () => {
    const items = buildActionMenuItems(
      "delete",
      "Job",
      "jobs",
      "migrate",
      [],
      undefined,
      vi.fn(),
    );
    for (const item of items) {
      if (item.kind === "item") expect(item.danger).toBe(true);
    }
  });
});
