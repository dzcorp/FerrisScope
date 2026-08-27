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

/// Selection with explicit per-row state, which is what the direction split
/// branches on.
function selectionWith(
  ...rows: (Partial<SelectionMeta> & { name: string })[]
): Map<string, SelectionMeta> {
  return new Map(
    rows.map((r) => [
      `ctx/demo/${r.name}`,
      { clusterId: "ctx", namespace: "demo", ...r },
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

describe("buildGenericBulkActions — suspend direction", () => {
  /// Offering both directions is what the operator complained about: half the
  /// buttons are guaranteed no-ops, and picking the wrong one looks like a
  /// failure rather than a mismatch.
  it("offers only Suspend when every selected row is running", () => {
    const labels = build(
      JOBS,
      selectionWith(
        { name: "a", suspend: false, phase: "Running" },
        { name: "b", suspend: false, phase: "Running" },
      ),
    ).map((a) => a.label);
    expect(labels).toContain("Suspend");
    expect(labels).not.toContain("Resume");
  });

  it("offers only Resume when every selected row is suspended", () => {
    const labels = build(
      CRONJOBS,
      selectionWith(
        { name: "a", suspend: true },
        { name: "b", suspend: true },
      ),
    ).map((a) => a.label);
    expect(labels).toContain("Resume");
    expect(labels).not.toContain("Suspend");
  });

  /// A mixed selection needs both, and each button has to name its own subset
  /// so it never implies it covers rows it will skip.
  it("names the subset when a direction covers only part of the selection", () => {
    const labels = build(
      JOBS,
      selectionWith(
        { name: "a", suspend: false, phase: "Running" },
        { name: "b", suspend: true, phase: "Suspended" },
        { name: "c", suspend: true, phase: "Suspended" },
      ),
    ).map((a) => a.label);
    expect(labels).toContain("Suspend (1)");
    expect(labels).toContain("Resume (2)");
  });

  it("acts on only the matching subset", async () => {
    const calls = stubInvoke(() => ({ kind: "applied", resource_version: "2" }));
    const selection = selectionWith(
      { name: "running", suspend: false, phase: "Running" },
      { name: "paused", suspend: true, phase: "Suspended" },
    );
    click(JOBS, selection, "Suspend (1)");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args?.name).toBe("running");
    expect(calls[0]?.args?.patch).toEqual({ spec: { suspend: true } });
  });

  /// A finished Job can neither be suspended nor resumed — the apiserver takes
  /// the patch and the controller ignores it, so the button would look like it
  /// worked. CronJobs have no terminal state and must not be narrowed.
  it("drops both directions when every selected Job has finished", () => {
    const labels = build(
      JOBS,
      selectionWith(
        { name: "a", suspend: false, phase: "Succeeded" },
        { name: "b", suspend: false, phase: "Failed" },
      ),
    ).map((a) => a.label);
    expect(labels).not.toContain("Suspend");
    expect(labels).not.toContain("Resume");
    // Re-run is still exactly what you want for a finished Job.
    expect(labels).toContain("Re-run");
  });

  it("keeps suspend available for CronJobs regardless of phase", () => {
    const labels = build(
      CRONJOBS,
      selectionWith({ name: "a", suspend: false, phase: "Succeeded" }),
    ).map((a) => a.label);
    expect(labels).toContain("Suspend");
  });

  /// Unknown state lands in both lists on purpose: the patch is an explicit
  /// request either way, and guessing a default is what puts the wrong verb in
  /// front of the operator.
  it("offers both directions for a row whose state was never captured", () => {
    const labels = build(JOBS, selectionOf("a")).map((a) => a.label);
    expect(labels).toContain("Suspend");
    expect(labels).toContain("Resume");
  });

  it("skips rows the verb cannot affect without skipping the rest", async () => {
    const calls = stubInvoke(() => ({ kind: "applied", resource_version: "2" }));
    click(
      JOBS,
      selectionWith(
        { name: "live", suspend: false, phase: "Running" },
        { name: "done", suspend: false, phase: "Succeeded" },
      ),
      "Suspend (1)",
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args?.name).toBe("live");
  });
});
