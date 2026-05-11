// useMetricsSubscription wires Tauri's metrics:// channel + the
// subscribe_metrics command into the global store. The exact contract:
//   • clusterId === null → no subscription, no IPC fires
//   • clusterId set → subscribe + listen, initial snapshot lands in store
//   • events flowing on the channel land in setMetrics
//   • unmount → unsubscribe + unlisten

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useMetricsSubscription } from "./useMetricsSubscription";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import {
  emitMock,
  listenerCount,
  resetEventMock,
} from "../test/tauri-event-mock";
import { useAppStore } from "../store";

const initial = useAppStore.getState();

beforeEach(() => {
  resetMockInvoke();
  resetEventMock();
  useAppStore.setState({ ...initial, metrics: null });
});

function Harness({ clusterId }: { clusterId: string | null }) {
  useMetricsSubscription(clusterId);
  return null;
}

describe("useMetricsSubscription", () => {
  it("null clusterId is a no-op — no command, no listener", () => {
    const fn = vi.fn(() => null);
    setMockInvoke(fn);
    render(<Harness clusterId={null} />);
    expect(fn).not.toHaveBeenCalled();
    expect(listenerCount("metrics://anything")).toBe(0);
  });

  it("active clusterId calls subscribe_metrics + listens on metrics://<id>", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      return { pods: {}, available: true };
    });
    await act(async () => {
      render(<Harness clusterId="ctx" />);
    });
    expect(calls.find((c) => c.cmd === "subscribe_metrics")?.args).toEqual({
      clusterId: "ctx",
    });
    expect(listenerCount("metrics://ctx")).toBe(1);
  });

  it("initial snapshot from subscribe_metrics lands in the store", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_metrics") {
        return { pods: { p1: { cpu_milli: 100, mem_mib: 32 } }, available: true };
      }
      return undefined;
    });
    await act(async () => {
      render(<Harness clusterId="ctx" />);
    });
    expect(useAppStore.getState().metrics).toEqual({
      pods: { p1: { cpu_milli: 100, mem_mib: 32 } },
      available: true,
    });
  });

  it("null initial snapshot leaves store metrics at null", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_metrics") return null;
      return undefined;
    });
    await act(async () => {
      render(<Harness clusterId="ctx" />);
    });
    expect(useAppStore.getState().metrics).toBeNull();
  });

  it("metrics:// events flow into the store via setMetrics", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_metrics") return null;
      return undefined;
    });
    await act(async () => {
      render(<Harness clusterId="ctx" />);
    });
    act(() => {
      emitMock("metrics://ctx", { pods: { p2: { cpu_milli: 50, mem_mib: 16 } }, available: true });
    });
    expect(useAppStore.getState().metrics).toEqual({
      pods: { p2: { cpu_milli: 50, mem_mib: 16 } },
      available: true,
    });
  });

  it("unmount drops the listener and fires unsubscribe_metrics", async () => {
    const seen: string[] = [];
    setMockInvoke((cmd) => {
      seen.push(cmd);
      if (cmd === "subscribe_metrics") return null;
      return undefined;
    });
    let utils: ReturnType<typeof render> | null = null;
    await act(async () => {
      utils = render(<Harness clusterId="ctx" />);
    });
    expect(listenerCount("metrics://ctx")).toBe(1);
    await act(async () => {
      utils!.unmount();
    });
    expect(listenerCount("metrics://ctx")).toBe(0);
    expect(seen).toContain("unsubscribe_metrics");
  });

  it("subscribe failure is swallowed (best-effort metrics-server)", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_metrics") {
        throw new Error("metrics-server not installed");
      }
      return undefined;
    });
    // Should not throw — useMetricsSubscription absorbs the error.
    await act(async () => {
      render(<Harness clusterId="ctx" />);
    });
    expect(useAppStore.getState().metrics).toBeNull();
  });

  it("switching clusterId tears down the previous subscription", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_metrics") return null;
      return undefined;
    });
    let utils: ReturnType<typeof render> | null = null;
    await act(async () => {
      utils = render(<Harness clusterId="ctx-a" />);
    });
    expect(listenerCount("metrics://ctx-a")).toBe(1);
    await act(async () => {
      utils!.rerender(<Harness clusterId="ctx-b" />);
    });
    expect(listenerCount("metrics://ctx-a")).toBe(0);
    expect(listenerCount("metrics://ctx-b")).toBe(1);
  });
});
