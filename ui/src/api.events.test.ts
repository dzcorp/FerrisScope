// Tests for the event-subscription helpers in api.ts (onResourceDelta,
// onMetrics, onClusterHealth, onClusterInfoChanged, onFleetProbe,
// onPortForwardStatus, onPrometheusChanged, onKubeconfigChanged).
//
// The Tauri side uses sanitized event names ([A-Za-z0-9_/:-] only); kind
// ids and cluster ids commonly include `.`, `@`, `+`. We pin both the
// sanitization (the helper must compute the same string the Rust emitter
// produces) and the array-vs-single delta payload routing.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  onClusterHealth,
  onClusterInfoChanged,
  onFleetProbe,
  onKubeconfigChanged,
  onMetrics,
  onPortForwardStatus,
  onPrometheusChanged,
  onResourceDelta,
} from "./api";
import {
  emitMock,
  listenerCount,
  resetEventMock,
} from "./test/tauri-event-mock";

beforeEach(() => {
  resetEventMock();
});

describe("onResourceDelta — name sanitization + payload routing", () => {
  it("sanitizes ids: '.', '@', '+' become '_'", async () => {
    const handler = vi.fn();
    await onResourceDelta("default::ctx-prod.io", "pods", handler);
    // The Rust emitter applies the same map. Listener must be registered
    // under the sanitised name or events never fire.
    expect(listenerCount("resource://default::ctx-prod_io/pods")).toBe(1);
  });

  it("alphanumerics + the / : - _ allowlist pass through", async () => {
    const handler = vi.fn();
    await onResourceDelta("a-z/0:9_+", "pods", handler);
    // `+` is not in the allowlist → underscore. Others pass through.
    expect(listenerCount("resource://a-z/0:9__/pods")).toBe(1);
  });

  it("single-delta payload routes through unwrapped", async () => {
    const handler = vi.fn();
    await onResourceDelta("ctx", "pods", handler);
    emitMock("resource://ctx/pods", { kind: "Added", row: { id: "p1" } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ kind: "Added", row: { id: "p1" } });
  });

  it("batched array payload fans out one call per delta in order", async () => {
    const handler = vi.fn();
    await onResourceDelta("ctx", "pods", handler);
    emitMock("resource://ctx/pods", [
      { kind: "Added", row: { id: "p1" } },
      { kind: "Modified", row: { id: "p1" } },
      { kind: "Deleted", row: { id: "p1" } },
    ]);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0]).toEqual({ kind: "Added", row: { id: "p1" } });
    expect(handler.mock.calls[2]![0]).toEqual({ kind: "Deleted", row: { id: "p1" } });
  });

  it("returned unlisten drops the handler so later emits are no-ops", async () => {
    const handler = vi.fn();
    const unlisten = await onResourceDelta("ctx", "pods", handler);
    unlisten();
    emitMock("resource://ctx/pods", { kind: "Added", row: { id: "p1" } });
    expect(handler).not.toHaveBeenCalled();
    expect(listenerCount("resource://ctx/pods")).toBe(0);
  });
});

describe("other event subscriptions wire up correct event names", () => {
  it("onMetrics(clusterId) listens on metrics://<sanitized>", async () => {
    const handler = vi.fn();
    await onMetrics("ctx.prod", handler);
    expect(listenerCount("metrics://ctx_prod")).toBe(1);
    emitMock("metrics://ctx_prod", { pods: {}, available: false });
    expect(handler).toHaveBeenCalledWith({ pods: {}, available: false });
  });

  it("onClusterHealth listens on cluster-health://<sanitized>", async () => {
    const handler = vi.fn();
    await onClusterHealth("ctx@prod", handler);
    expect(listenerCount("cluster-health://ctx_prod")).toBe(1);
    emitMock("cluster-health://ctx_prod", {
      kind: "unavailable",
      reason: "timeout",
    });
    expect(handler).toHaveBeenCalled();
  });

  it("onClusterInfoChanged listens on cluster_info://changed/<sanitized>", async () => {
    const handler = vi.fn();
    await onClusterInfoChanged("ctx", handler);
    expect(listenerCount("cluster_info://changed/ctx")).toBe(1);
    emitMock("cluster_info://changed/ctx", {
      serverVersion: "v1.31.4",
      nodeCount: 3,
    });
    expect(handler).toHaveBeenCalled();
  });

  it("onFleetProbe is a single global channel", async () => {
    const handler = vi.fn();
    await onFleetProbe(handler);
    expect(listenerCount("fleet://probe")).toBe(1);
    emitMock("fleet://probe", { contextId: "a", status: "ok" });
    expect(handler).toHaveBeenCalled();
  });

  it("onPortForwardStatus is a single global channel", async () => {
    const handler = vi.fn();
    await onPortForwardStatus(handler);
    expect(listenerCount("portforward://status")).toBe(1);
    emitMock("portforward://status", {
      id: "pf-1",
      status: { kind: "active" },
    });
    expect(handler).toHaveBeenCalled();
  });

  it("onPrometheusChanged is a single global channel", async () => {
    const handler = vi.fn();
    await onPrometheusChanged(handler);
    expect(listenerCount("prometheus://changed")).toBe(1);
    emitMock("prometheus://changed", { clusterId: "ctx", target: null });
    expect(handler).toHaveBeenCalled();
  });

  it("onKubeconfigChanged ignores the payload (just a tick)", async () => {
    const handler = vi.fn();
    await onKubeconfigChanged(handler);
    emitMock("kubeconfig://changed", undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    // Handler signature is `() => void` — payload not forwarded.
    expect(handler).toHaveBeenCalledWith();
  });
});

describe("multiple listeners on the same channel", () => {
  it("each registered handler receives the emit", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    await onFleetProbe(h1);
    await onFleetProbe(h2);
    expect(listenerCount("fleet://probe")).toBe(2);
    emitMock("fleet://probe", { contextId: "a", status: "ok" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });
});
