// Unit tests for the typed `api` wrapper. Verifies that each method maps
// to the right Tauri command name with the right argument shape — a wire
// break here is exactly the kind of regression that's hard to spot in a
// running app because the backend silently no-ops on unknown commands.

import { describe, it, expect, beforeEach } from "vitest";
import { setMockInvoke, resetMockInvoke } from "./test/tauri-mock";
import { api } from "./api";

type Captured = { cmd: string; args?: Record<string, unknown> };

function captureNext(retval: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    return retval;
  });
  return { calls };
}

beforeEach(() => {
  resetMockInvoke();
});

describe("ping / updater plumbing", () => {
  it("ping → 'ping' with no args", async () => {
    const cap = captureNext({ name: "ferrisscope" });
    await api.ping();
    expect(cap.calls[0]?.cmd).toBe("ping");
    expect(cap.calls[0]?.args).toBeUndefined();
  });

  it("checkForUpdate → 'check_for_update'", async () => {
    const cap = captureNext({ kind: "up_to_date" });
    await api.checkForUpdate();
    expect(cap.calls[0]?.cmd).toBe("check_for_update");
  });

  it("applyUpdate forwards the release object verbatim", async () => {
    const cap = captureNext(undefined);
    const release = {
      version: "0.2.0",
      htmlUrl: "https://example.invalid/r",
      assetName: "fs-linux-x64.AppImage",
      downloadUrl: "https://example.invalid/dl",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await api.applyUpdate(release as any);
    expect(cap.calls[0]?.cmd).toBe("apply_update");
    expect(cap.calls[0]?.args).toEqual({ release });
  });
});

describe("contexts + connect", () => {
  it("listContexts → 'list_contexts' with no args", async () => {
    const cap = captureNext([]);
    await api.listContexts();
    expect(cap.calls[0]?.cmd).toBe("list_contexts");
  });

  it("connectContext passes name + connectId in camelCase", async () => {
    const cap = captureNext({ serverVersion: "v1.31.4", nodeCount: 1 });
    await api.connectContext("default::ctx-a", "abc-123");
    expect(cap.calls[0]?.cmd).toBe("connect_context");
    expect(cap.calls[0]?.args).toEqual({
      name: "default::ctx-a",
      connectId: "abc-123",
    });
  });
});

describe("subscribeResource", () => {
  it("defaults namespaceFilter to null", async () => {
    const cap = captureNext({ ok: true });
    await api.subscribeResource("ctx", "pods");
    expect(cap.calls[0]?.cmd).toBe("subscribe_resource");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "pods",
      namespaceFilter: null,
    });
  });

  it("forwards explicit namespaceFilter", async () => {
    const cap = captureNext({ ok: true });
    await api.subscribeResource("ctx", "pods", "default");
    expect(cap.calls[0]?.args?.namespaceFilter).toBe("default");
  });
});

describe("applyResource (SSA)", () => {
  it("ships the partial-object payload + force flag", async () => {
    const cap = captureNext({ kind: "applied", resource_version: "42" });
    const fields = { data: { KEY: "B" } };
    await api.applyResource("ctx", "configmaps", "default", "cm", fields, false);
    expect(cap.calls[0]?.cmd).toBe("apply_resource_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "configmaps",
      namespace: "default",
      name: "cm",
      fields,
      force: false,
    });
  });

  it("force=true is the conflict-takeover path", async () => {
    const cap = captureNext({ kind: "applied" });
    await api.applyResource("ctx", "configmaps", "default", "cm", {}, true);
    expect(cap.calls[0]?.args?.force).toBe(true);
  });
});

describe("deleteResource", () => {
  it("force-delete sends gracePeriodSeconds: 0", async () => {
    const cap = captureNext(undefined);
    await api.deleteResource("ctx", "pods", "default", "stuck", 0);
    expect(cap.calls[0]?.cmd).toBe("delete_resource_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      kindId: "pods",
      namespace: "default",
      name: "stuck",
      gracePeriodSeconds: 0,
    });
  });

  it("default-grace sends gracePeriodSeconds: null", async () => {
    const cap = captureNext(undefined);
    await api.deleteResource("ctx", "pods", "default", "x", null);
    expect(cap.calls[0]?.args?.gracePeriodSeconds).toBeNull();
  });

  it("cluster-scoped resources pass namespace: null", async () => {
    const cap = captureNext(undefined);
    await api.deleteResource("ctx", "nodes", null, "worker-1", null);
    expect(cap.calls[0]?.args?.namespace).toBeNull();
  });
});

describe("cordonNode", () => {
  it("cordon=true and false both go through cordon_node_cmd", async () => {
    const cap = captureNext(undefined);
    await api.cordonNode("ctx", "worker-1", true);
    await api.cordonNode("ctx", "worker-1", false);
    expect(cap.calls).toHaveLength(2);
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      name: "worker-1",
      cordon: true,
    });
    expect(cap.calls[1]?.args?.cordon).toBe(false);
  });
});

describe("detail getters", () => {
  it("getPodDetail → get_pod_detail_cmd", async () => {
    const cap = captureNext({});
    await api.getPodDetail("ctx", "default", "p");
    expect(cap.calls[0]?.cmd).toBe("get_pod_detail_cmd");
    expect(cap.calls[0]?.args).toEqual({
      clusterId: "ctx",
      namespace: "default",
      name: "p",
    });
  });

  it("getNodeDetail (cluster-scoped) only takes clusterId + name", async () => {
    const cap = captureNext({});
    await api.getNodeDetail("ctx", "worker-1");
    expect(cap.calls[0]?.cmd).toBe("get_node_detail_cmd");
    expect(cap.calls[0]?.args).toEqual({ clusterId: "ctx", name: "worker-1" });
  });
});

describe("getResourceYaml", () => {
  it("namespace null is preserved (cluster-scoped read)", async () => {
    const cap = captureNext("apiVersion: v1\nkind: Node\n...");
    await api.getResourceYaml("ctx", "nodes", null, "worker-1");
    expect(cap.calls[0]?.cmd).toBe("get_resource_yaml_cmd");
    expect(cap.calls[0]?.args?.namespace).toBeNull();
  });
});
