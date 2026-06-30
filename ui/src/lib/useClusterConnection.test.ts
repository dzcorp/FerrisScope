import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ClusterHealthEvent, ContextInfo } from "../types";

// Capture the wrapped handlers the hook installs so a test can fire fake
// backend events at them. Reassigned on every connect-effect re-run, so they
// always point at the latest (live) closure.
let healthHandler: ((evt: ClusterHealthEvent) => void) | null = null;

const connectContext = vi.fn();
const cancelConnect = vi.fn().mockResolvedValue(undefined);
const reconnectCluster = vi.fn().mockResolvedValue(undefined);

vi.mock("../api", () => ({
  api: {
    connectContext: (...a: unknown[]) => connectContext(...a),
    cancelConnect: (...a: unknown[]) => cancelConnect(...a),
    reconnectCluster: (...a: unknown[]) => reconnectCluster(...a),
  },
  onClusterHealth: vi.fn((_id: string, h: (e: ClusterHealthEvent) => void) => {
    healthHandler = h;
    return Promise.resolve(() => {});
  }),
  onClusterInfoChanged: vi.fn((_id: string, _h: (i: unknown) => void) =>
    Promise.resolve(() => {}),
  ),
}));

import { useClusterConnection } from "./useClusterConnection";
import { useAppStore } from "../store";

const CTX: ContextInfo = {
  id: "src::test-cluster",
  name: "test-cluster",
  cluster: "test-cluster",
  user: "u",
  namespace: null,
  is_current: true,
  group: "g",
  source_id: "src",
  source_path: null,
};

const initial = useAppStore.getState();

// Flush both pending microtasks (promise .then/.finally chains) and any timers
// up to `ms`. `advanceTimersByTimeAsync` yields to the microtask queue between
// timer callbacks, which is exactly what our reconnect→setAttempt→connect
// chain needs to settle.
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function fireHealth(evt: ClusterHealthEvent) {
  act(() => {
    healthHandler?.(evt);
  });
}

const UNAVAIL: ClusterHealthEvent = { status: "unavailable", reason: "timeout" };
const MAX = 10;
// Mirror of the hook's capped exponential backoff: 2,4,8,16,30,30,…
const backoff = (idx: number) => Math.min(2000 * 2 ** idx, 30_000);

describe("useClusterConnection auto-reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    healthHandler = null;
    connectContext.mockReset().mockResolvedValue({ server_version: "v1" });
    cancelConnect.mockClear();
    reconnectCluster.mockClear().mockResolvedValue(undefined);
    useAppStore.setState({
      ...initial,
      clusterHealth: {},
      clusterHealthReason: {},
      clusterReconnecting: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects on mount with no auto-reconnect session", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();
    expect(connectContext).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("ok");
    expect(result.current.autoReconnect).toBeNull();
    expect(reconnectCluster).not.toHaveBeenCalled();
  });

  it("on unavailable, schedules the first retry at exactly 2000ms", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL);
    // Store reflects reality immediately; session is armed but not yet firing.
    expect(useAppStore.getState().clusterHealth[CTX.id]).toBe("unavailable");
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBe(true);
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });

    await flush(1999);
    expect(reconnectCluster).not.toHaveBeenCalled();
    await flush(1);
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
    // The reconnect bumps the attempt, which re-runs the connect effect.
    expect(connectContext).toHaveBeenCalledTimes(2);
  });

  it("wedged cluster: retries MAX times with capped backoff, then manual banner", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    // connectContext keeps resolving ok (wedged: reconnect appears to succeed
    // but the probe re-flags shortly after each one). Each unavailable arms the
    // next attempt; advancing its backoff fires it.
    for (let k = 1; k <= MAX; k++) {
      fireHealth(UNAVAIL);
      expect(result.current.autoReconnect).toEqual({ attempt: k, max: MAX });
      await flush(backoff(k - 1));
      expect(reconnectCluster).toHaveBeenCalledTimes(k);
    }

    // Budget exhausted: the next unavailable ends the session and hands off to
    // the manual banner. Health stays unavailable in the store.
    fireHealth(UNAVAIL);
    expect(result.current.autoReconnect).toBeNull();
    expect(reconnectCluster).toHaveBeenCalledTimes(MAX);
    expect(useAppStore.getState().clusterHealth[CTX.id]).toBe("unavailable");
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBeUndefined();
  });

  it("hard-down cluster: connect-error auto-advances the retry loop to exhaustion", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    // From here every connect fails — the apiserver is gone. Each failed
    // connect schedules the next attempt on its own (no unavailable events
    // arrive once there's no live probe). Step through one backoff at a time so
    // each reconnect→error→reschedule cycle settles before the next fires.
    connectContext.mockRejectedValue(new Error("connection refused"));

    fireHealth(UNAVAIL);
    for (let k = 1; k <= MAX; k++) {
      await flush(backoff(k - 1));
      expect(reconnectCluster).toHaveBeenCalledTimes(k);
    }

    // 11th cycle would exceed the budget — session ends into the error banner.
    await flush(backoff(MAX));
    expect(reconnectCluster).toHaveBeenCalledTimes(MAX);
    expect(result.current.state.status).toBe("error");
    expect(result.current.autoReconnect).toBeNull();
  });

  it("manual reconnect cancels a pending auto retry and resets the counter", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL);
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });

    act(() => result.current.reconnect());
    expect(result.current.autoReconnect).toBeNull();
    // The manual reconnect itself calls reconnectCluster once.
    expect(reconnectCluster).toHaveBeenCalledTimes(1);

    // The pending 2s auto timer must have been cleared — no further calls.
    await flush(8000);
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
  });

  it("recovery dwell: a sustained reconnect ends the session and re-arms fresh", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL);
    await flush(2000); // attempt 1 fires, connect resolves ok
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });

    // 60s with no further unavailable -> declared recovered.
    await flush(60_000);
    expect(result.current.autoReconnect).toBeNull();
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBeUndefined();

    // A fresh outage starts a brand-new session at attempt 1 (counter reset).
    fireHealth(UNAVAIL);
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });
  });

  it("unmount mid-backoff fires no further reconnects", async () => {
    const { unmount } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL); // arms the 2s timer
    unmount();
    await flush(8000);
    expect(reconnectCluster).not.toHaveBeenCalled();
    // Cleanup also clears the per-cluster reconnecting flag.
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBeUndefined();
  });
});
