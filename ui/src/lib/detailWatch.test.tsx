import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { emitMock, resetEventMock } from "../test/tauri-event-mock";
import { findDetailRow, useDetailRow } from "./detailWatch";
import type { ResourceKind } from "../types";

const pods = { id: "pods", namespaced: true } as ResourceKind;
const nodes = { id: "nodes", namespaced: false } as ResourceKind;
const CHANNEL = "resource://c1/pods/ns:web";

type Call = { cmd: string; args?: Record<string, unknown> };
function backend(snap: { rows: unknown[]; init_done: boolean }) {
  const calls: Call[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    return cmd === "subscribe_resource" ? snap : undefined;
  });
  return calls;
}
const subs = (calls: Call[]) =>
  calls.filter((c) => c.cmd === "subscribe_resource").length -
  calls.filter((c) => c.cmd === "unsubscribe_resource").length;

afterEach(() => {
  resetMockInvoke();
  resetEventMock();
});

describe("findDetailRow", () => {
  it("finds the object in the snapshot and releases the watch", async () => {
    const calls = backend({ rows: [{ uid: "u1", name: "api", namespace: "web" }], init_done: true });
    const row = await findDetailRow("c1", pods, "web", "api");
    expect(row?.uid).toBe("u1");
    expect(calls[0]).toEqual({ cmd: "subscribe_resource", args: { clusterId: "c1", kindId: "pods", namespaces: ["web"] } });
    await waitFor(() => expect(subs(calls)).toBe(0));
  });

  it("is null when the synced watcher doesn't have it", async () => {
    backend({ rows: [], init_done: true });
    expect(await findDetailRow("c1", pods, "web", "ghost")).toBeNull();
  });

  it("waits for a still-listing watcher: the row streams in, or init_done means missing", async () => {
    backend({ rows: [], init_done: false });
    const found = findDetailRow("c1", pods, "web", "api");
    await act(async () => {});
    emitMock(CHANNEL, [{ kind: "upsert", row: { uid: "u9", name: "api", namespace: "web" } }]);
    expect((await found)?.uid).toBe("u9");

    const missing = findDetailRow("c1", pods, "web", "nope");
    await act(async () => {});
    emitMock(CHANNEL, [{ kind: "init_done" }]);
    expect(await missing).toBeNull();
  });

  it("cluster-scoped kinds watch All", async () => {
    const calls = backend({ rows: [{ uid: "n1", name: "node-1" }], init_done: true });
    expect((await findDetailRow("c1", nodes, "ignored", "node-1"))?.uid).toBe("n1");
    expect(calls[0]?.args?.["namespaces"]).toBeNull();
  });
});

describe("useDetailRow", () => {
  it("watches the object while mounted and releases it after", async () => {
    const calls = backend({ rows: [{ uid: "u1", name: "api", namespace: "web" }], init_done: true });
    const h = renderHook(() => useDetailRow("c1", pods, "web", "u1"));
    await waitFor(() => expect(h.result.current?.uid).toBe("u1"));
    expect(subs(calls)).toBe(1);
    h.unmount();
    await waitFor(() => expect(subs(calls)).toBe(0));
  });
});
