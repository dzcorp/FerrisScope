// Transport for the Job / CronJob row actions.
//
// Regression: suspend used to go through `apply_resource` (SSA). An SSA apply
// carries the *whole* declared intent of its field manager, so applying only
// `{spec:{suspend}}` under `ferrisscope` dropped every other spec field that
// manager already owned. On an object created through this app's own YAML
// apply — same manager — that stripped `spec.schedule` and the pod template,
// and the apiserver answered 422 "Required value". Merge patch touches
// exactly the one field, which is what `kubectl patch` does.

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRowActionContext } from "./ResourceTable";
import { resetMockInvoke, setMockInvoke } from "../test/tauri-mock";
import type { ResourceKind, ResourceRow } from "../types";

afterEach(() => {
  resetMockInvoke();
  vi.restoreAllMocks();
});

function kindOf(id: string, kind: string): ResourceKind {
  return {
    id,
    group: "batch",
    version: "v1",
    kind,
    plural: id,
    namespaced: true,
    category: "Workloads" as ResourceKind["category"],
    columns: [],
  };
}

function contextFor(kind: ResourceKind, row: Partial<ResourceRow>) {
  return buildRowActionContext(
    kind,
    { uid: "u1", name: "demo-cronjob", namespace: "demo", ...row },
    "ctx",
    "ctx-label",
    // confirmDestructive off so the callbacks run without a modal.
    false,
    () => {},
    { openDetail: () => {}, openLogs: () => {} },
  );
}

function stubInvoke(replies: Record<string, unknown>) {
  const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (!(cmd in replies)) throw new Error(`unexpected command: ${cmd}`);
    return replies[cmd];
  });
  return calls;
}

describe("buildRowActionContext — suspend", () => {
  it("suspends a CronJob over merge patch, not SSA", async () => {
    const calls = stubInvoke({
      merge_patch_resource_cmd: { kind: "applied", resource_version: "9" },
    });
    // The CronJob row projects `suspend` as a string — it backs a text column.
    const ctx = contextFor(kindOf("cronjobs", "CronJob"), { suspend: "false" });

    expect(ctx.suspendTo?.target).toBe(true);
    ctx.suspendTo!.run();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]?.cmd).toBe("merge_patch_resource_cmd");
    expect(calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "cronjobs",
      namespace: "demo",
      name: "demo-cronjob",
      patch: { spec: { suspend: true } },
      // Null on purpose: a blind toggle, not an edit of a version the
      // operator was looking at, so there is nothing to be stale against.
      resourceVersion: null,
    });
  });

  it("resumes by sending suspend: false", async () => {
    const calls = stubInvoke({
      merge_patch_resource_cmd: { kind: "applied", resource_version: "9" },
    });
    const ctx = contextFor(kindOf("cronjobs", "CronJob"), { suspend: "true" });

    expect(ctx.suspendTo?.target).toBe(false);
    ctx.suspendTo!.run();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args?.patch).toEqual({ spec: { suspend: false } });
  });

  /// The Job row projects a bool rather than a string; both have to normalise
  /// to the same toggle or the button label inverts.
  it("reads the Job row's boolean suspend flag", () => {
    const running = contextFor(kindOf("jobs", "Job"), {
      suspend: false,
      phase: "Running",
    });
    expect(running.suspendTo?.target).toBe(true);

    const paused = contextFor(kindOf("jobs", "Job"), {
      suspend: true,
      phase: "Suspended",
    });
    expect(paused.suspendTo?.target).toBe(false);
  });

  /// Suspending a finished Job is accepted by the apiserver and ignored by the
  /// controller, so offering it would be a button that silently does nothing.
  it("offers no suspend for a Job that already finished", () => {
    for (const phase of ["Succeeded", "Failed"]) {
      const ctx = contextFor(kindOf("jobs", "Job"), { suspend: false, phase });
      expect(ctx.suspendTo).toBeUndefined();
      // Re-running one, on the other hand, is exactly what you want.
      expect(ctx.rerun).toBeTypeOf("function");
    }
  });
});

describe("buildRowActionContext — trigger and re-run", () => {
  it("triggers a CronJob through trigger_cron_job_cmd", async () => {
    const calls = stubInvoke({
      trigger_cron_job_cmd: "demo-cronjob-manual-1",
    });
    const ctx = contextFor(kindOf("cronjobs", "CronJob"), { suspend: "false" });

    expect(ctx.rerun).toBeUndefined();
    ctx.trigger!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      cmd: "trigger_cron_job_cmd",
      args: { clusterId: "ctx", namespace: "demo", name: "demo-cronjob" },
    });
  });

  it("re-runs a Job through rerun_job_cmd", async () => {
    const calls = stubInvoke({ rerun_job_cmd: "migrate-rerun-1" });
    const ctx = contextFor(kindOf("jobs", "Job"), {
      name: "migrate",
      suspend: false,
      phase: "Failed",
    });

    expect(ctx.trigger).toBeUndefined();
    ctx.rerun!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      cmd: "rerun_job_cmd",
      args: { clusterId: "ctx", namespace: "demo", name: "migrate" },
    });
  });

  /// Deleting a batch workload must not fall through to the apiserver's
  /// per-resource default, which for batch/v1 orphans the pods.
  it("deletes with an explicit cascade slot the backend defaults to background", async () => {
    const calls = stubInvoke({ delete_resource_cmd: undefined });
    const ctx = contextFor(kindOf("jobs", "Job"), {
      name: "migrate",
      suspend: false,
      phase: "Failed",
    });

    ctx.delete!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.cmd).toBe("delete_resource_cmd");
    expect(calls[0]?.args).toHaveProperty("cascade", null);
  });
});
