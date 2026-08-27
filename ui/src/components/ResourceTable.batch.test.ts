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
import { buildRowActionContext, selectionMetaOf } from "./ResourceTable";
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
      finished: false,
    });
    expect(running.suspendTo?.target).toBe(true);

    const paused = contextFor(kindOf("jobs", "Job"), {
      suspend: true,
      finished: false,
    });
    expect(paused.suspendTo?.target).toBe(false);
  });

  /// Suspending a finished Job is accepted by the apiserver and ignored by the
  /// controller, so offering it would be a button that silently does nothing.
  it("offers no suspend for a Job that already finished", () => {
    const ctx = contextFor(kindOf("jobs", "Job"), {
      suspend: false,
      finished: true,
    });
    expect(ctx.suspendTo).toBeUndefined();
    // Re-running one, on the other hand, is exactly what you want.
    expect(ctx.rerun).toBeTypeOf("function");
  });

  /// `phase` reads "Failed" for a Job still working through its backoff
  /// retries. Gating on it would take Suspend away from a Job that is very
  /// much still running, which is why the gate is the row's own `finished`.
  it("keeps suspend for a Job whose phase reads Failed but is still retrying", () => {
    const ctx = contextFor(kindOf("jobs", "Job"), {
      suspend: false,
      finished: false,
      phase: "Failed",
    });
    expect(ctx.suspendTo?.target).toBe(true);
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
      finished: true,
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
      finished: true,
    });

    ctx.delete!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.cmd).toBe("delete_resource_cmd");
    expect(calls[0]?.args).toHaveProperty("cascade", null);
  });
});

describe("buildRowActionContext — unknown suspend state", () => {
  /// `undefined` is a third state, not a synonym for false. The row is briefly
  /// absent or unprojected right after a cross-kind navigation, and offering
  /// "Suspend" for an already-suspended object points the operator at a verb
  /// that will do nothing.
  it("offers no suspend toggle when the row never projected one", () => {
    const ctx = contextFor(kindOf("jobs", "Job"), { finished: false });
    expect(ctx.suspendTo).toBeUndefined();
    // The verbs that don't depend on suspend state stay available.
    expect(ctx.rerun).toBeTypeOf("function");
    expect(ctx.delete).toBeTypeOf("function");
  });
});

describe("selectionMetaOf", () => {
  /// CronJob rows project `suspend` as a string because it backs a text
  /// column; Job rows project a bool. Normalising here is what lets every
  /// consumer branch on one type.
  it("normalises the CronJob row's string suspend flag", () => {
    const row = {
      __sid: "ctx::u",
      __clusterId: "ctx",
      uid: "u",
      name: "nightly",
      namespace: "demo",
      suspend: "true",
      finished: false,
    } as unknown as Parameters<typeof selectionMetaOf>[0];
    expect(selectionMetaOf(row)).toEqual({
      clusterId: "ctx",
      namespace: "demo",
      name: "nightly",
      suspend: true,
      finished: false,
    });
  });

  it("normalises the Job row's boolean suspend flag", () => {
    const row = {
      __sid: "ctx::u",
      __clusterId: "ctx",
      uid: "u",
      name: "migrate",
      namespace: "demo",
      suspend: false,
      finished: false,
    } as unknown as Parameters<typeof selectionMetaOf>[0];
    expect(selectionMetaOf(row)).toMatchObject({ suspend: false });
  });

  /// Omitted rather than defaulted: a bulk action has to be able to tell
  /// "not suspended" from "we don't know".
  it("omits suspend and phase entirely when the row has neither", () => {
    const row = {
      __sid: "ctx::u",
      __clusterId: "ctx",
      uid: "u",
      name: "cm",
      namespace: "demo",
    } as unknown as Parameters<typeof selectionMetaOf>[0];
    const meta = selectionMetaOf(row);
    expect("suspend" in meta).toBe(false);
    expect("phase" in meta).toBe(false);
  });

  /// A cluster-scoped row has no namespace; null, not the string "undefined".
  it("carries a null namespace for cluster-scoped rows", () => {
    const row = {
      __sid: "ctx::u",
      __clusterId: "ctx",
      uid: "u",
      name: "worker-1",
    } as unknown as Parameters<typeof selectionMetaOf>[0];
    expect(selectionMetaOf(row).namespace).toBeNull();
  });
});
