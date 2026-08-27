// Bulk-bar actions for the batch workloads.
//
// Two things are worth pinning here. Suspend/Resume must ride merge patch,
// not SSA — a partial SSA apply under this app's field manager drops every
// other spec field that manager owns and the apiserver 422s. And a bulk
// action must report per-row failures: the operator clears the selection
// expecting all of it to have happened, so a silent subset is the worst
// possible outcome.

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGenericBulkActions } from "./bulkActions";
import { resetMockInvoke, setMockInvoke } from "../test/tauri-mock";
import type { SelectionMeta } from "../store";
import type { ResourceKind } from "../types";

afterEach(() => {
  resetMockInvoke();
  vi.restoreAllMocks();
});

function kindOf(id: string, kind: string, plural: string): ResourceKind {
  return {
    id,
    group: "batch",
    version: "v1",
    kind,
    plural,
    namespaced: true,
    category: "Workloads" as ResourceKind["category"],
    columns: [],
  };
}

function selectionOf(...names: string[]): Map<string, SelectionMeta> {
  return new Map(
    names.map((name) => [
      `ctx/demo/${name}`,
      { clusterId: "ctx", namespace: "demo", name },
    ]),
  );
}

function stubInvoke(handler: (cmd: string) => unknown) {
  const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    return handler(cmd);
  });
  return calls;
}

function build(kind: ResourceKind, selection: Map<string, SelectionMeta>) {
  return buildGenericBulkActions(
    kind,
    selection,
    // confirmDestructive off so callbacks run without a modal.
    false,
    () => {},
    () => "",
    false,
  );
}

function labelsOf(kind: ResourceKind): string[] {
  return build(kind, selectionOf("a")).map((a) => a.label);
}

function click(kind: ResourceKind, selection: Map<string, SelectionMeta>, label: string) {
  const action = build(kind, selection).find((a) => a.label === label);
  if (!action) throw new Error(`bulk action ${label} not found`);
  action.onClick();
}

const CRONJOBS = kindOf("cronjobs", "CronJob", "cronjobs");
const JOBS = kindOf("jobs", "Job", "jobs");
const CONFIGMAPS = kindOf("configmaps", "ConfigMap", "configmaps");

describe("buildGenericBulkActions — batch kinds", () => {
  it("offers Run now / Suspend / Resume for CronJobs", () => {
    expect(labelsOf(CRONJOBS)).toEqual([
      "Run now",
      "Suspend",
      "Resume",
      "Copy names",
      "Delete",
    ]);
  });

  it("offers Re-run instead of Run now for Jobs", () => {
    expect(labelsOf(JOBS)).toEqual([
      "Re-run",
      "Suspend",
      "Resume",
      "Copy names",
      "Delete",
    ]);
  });

  /// Every other kind keeps the pre-existing bar — batch verbs must not leak.
  it("leaves non-batch kinds alone", () => {
    expect(labelsOf(CONFIGMAPS)).toEqual(["Copy names", "Delete"]);
  });

  /// Suspend and Resume are separate actions, not one toggle: the selection
  /// carries only cluster/namespace/name, so there is no per-row state to
  /// flip against. Sending the wrong direction to half a selection would be
  /// worse than making the operator pick.
  it("suspends over merge patch, one call per selected row", async () => {
    const calls = stubInvoke(() => ({ kind: "applied", resource_version: "2" }));
    click(CRONJOBS, selectionOf("a", "b"), "Suspend");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    for (const call of calls) {
      expect(call.cmd).toBe("merge_patch_resource_cmd");
      expect(call.args?.patch).toEqual({ spec: { suspend: true } });
      expect(call.args).toHaveProperty("resourceVersion", null);
    }
    expect(calls.map((c) => c.args?.name).sort()).toEqual(["a", "b"]);
  });

  it("resumes by sending suspend: false", async () => {
    const calls = stubInvoke(() => ({ kind: "applied", resource_version: "2" }));
    click(JOBS, selectionOf("a"), "Resume");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args?.patch).toEqual({ spec: { suspend: false } });
  });

  it("triggers each selected CronJob", async () => {
    const calls = stubInvoke(() => "a-manual-1");
    click(CRONJOBS, selectionOf("a", "b"), "Run now");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.every((c) => c.cmd === "trigger_cron_job_cmd")).toBe(true);
  });

  it("re-runs each selected Job", async () => {
    const calls = stubInvoke(() => "a-rerun-1");
    click(JOBS, selectionOf("a", "b"), "Re-run");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.every((c) => c.cmd === "rerun_job_cmd")).toBe(true);
  });

  /// One row failing must not abort the rest, and must not be swallowed —
  /// the selection is cleared either way, so an unreported failure is
  /// invisible.
  it("keeps going past a failing row and reports it", async () => {
    const calls: { cmd: string; args: Record<string, unknown> | undefined }[] =
      [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      if (args?.["name"] === "b") throw new Error("forbidden");
      return { kind: "applied", resource_version: "2" };
    });
    const { toast } = await import("../lib/dialog");
    const bad = vi.spyOn(toast, "bad").mockImplementation(() => "t1");

    click(CRONJOBS, selectionOf("a", "b", "c"), "Suspend");
    await vi.waitFor(() => expect(bad).toHaveBeenCalled());

    // All three were attempted, not just the ones before the failure.
    expect(calls).toHaveLength(3);
    const message = String(bad.mock.calls[0]?.[0]);
    expect(message).toContain("1 of 3");
    expect(message).toContain("demo/b");
    expect(message).toContain("forbidden");
  });
});
