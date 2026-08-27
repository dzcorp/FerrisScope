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
const getClusterHealth = vi.fn();

vi.mock("../api", () => ({
  api: {
    connectContext: (...a: unknown[]) => connectContext(...a),
    cancelConnect: (...a: unknown[]) => cancelConnect(...a),
    reconnectCluster: (...a: unknown[]) => reconnectCluster(...a),
    getClusterHealth: (...a: unknown[]) => getClusterHealth(...a),
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
const HEALTHY: ClusterHealthEvent = { status: "healthy", reason: null };
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
    getClusterHealth.mockReset().mockResolvedValue(HEALTHY);
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

  it("recovers an unavailable that was emitted while nothing was listening", async () => {
    // Regression: the probe broadcasts `unavailable` exactly once and the
    // forwarder then exits, so a cluster that wedged while its tab sat in the
    // background had NO listener — coming back showed a green bar over a table
    // whose every subscribe failed, with no Reconnect button. The mount-time
    // pull is what closes that hole.
    getClusterHealth.mockResolvedValue(UNAVAIL);
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    expect(getClusterHealth).toHaveBeenCalledWith(CTX.id);
    expect(useAppStore.getState().clusterHealth[CTX.id]).toBe("unavailable");
    expect(useAppStore.getState().clusterHealthReason[CTX.id]).toBe("timeout");
    // …and it drives the same recovery a live event would.
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });
  });

  it("the health pull clears a stale unavailable left over from an earlier wedge", async () => {
    // `connect_context` evicts a wedged entry and rebuilds it, so a healthy
    // answer here is authoritative: without applying it the banner would stay
    // up over a cluster that is already serving again.
    useAppStore.setState({
      clusterHealth: { [CTX.id]: "unavailable" },
      clusterHealthReason: { [CTX.id]: "timeout" },
    });
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    expect(useAppStore.getState().clusterHealth[CTX.id]).toBe("healthy");
    expect(result.current.autoReconnect).toBeNull();
    expect(reconnectCluster).not.toHaveBeenCalled();
  });

  it("a refused command flipping health starts the same retry session as an event", async () => {
    // ResourceTable / the namespaces subscribe mark the cluster unavailable
    // when the backend refuses them ("unavailable — reconnect first"). That
    // write must drive recovery exactly like a live probe event would —
    // otherwise the wedge detected by the only signal that still arrives
    // would sit behind a manual button.
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();
    expect(result.current.autoReconnect).toBeNull();

    act(() => {
      useAppStore
        .getState()
        .applyClusterHealth(
          CTX.id,
          "unavailable",
          `cluster ${CTX.id} is unavailable — reconnect first`,
        );
    });
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });

    await flush(2000);
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
  });

  it("polls health while connected, so a lost event still surfaces the wedge", async () => {
    // Worst case for the push channel: the cluster wedges while the operator
    // sits on an already-loaded table. Nothing re-subscribes, the one-shot
    // event was missed — only the poll can notice, and it must arrive without
    // any interaction.
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();
    expect(getClusterHealth).toHaveBeenCalledTimes(1); // the mount pull

    getClusterHealth.mockResolvedValue(UNAVAIL);
    await flush(15_000);

    expect(getClusterHealth).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().clusterHealth[CTX.id]).toBe("unavailable");
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });
  });

  it("stops polling once the panel unmounts", async () => {
    const { unmount } = renderHook(() => useClusterConnection(CTX));
    await flush();
    const afterMount = getClusterHealth.mock.calls.length;
    unmount();
    await flush(60_000);
    expect(getClusterHealth).toHaveBeenCalledTimes(afterMount);
  });

  it("a failed health pull leaves the connection alone", async () => {
    // The pull is a diagnostic, not a gate — an IPC hiccup must not fabricate
    // an outage or blank the view.
    getClusterHealth.mockRejectedValue(new Error("ipc closed"));
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    expect(result.current.state.status).toBe("ok");
    expect(useAppStore.getState().clusterHealth[CTX.id]).toBeUndefined();
    expect(result.current.autoReconnect).toBeNull();
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

  it("successful reconnect clears the banner + grayed state immediately, not after the dwell", async () => {
    // Regression: the recovery dwell used to hold `clusterReconnecting` true (so
    // the pod table stayed grayed and the banner stayed up) for the full 60s
    // after data was already flowing, reading as "stuck reconnecting". A connect
    // success must drop the user-visible state at once.
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL);
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBe(true);

    await flush(2000); // attempt 1 fires, connect resolves ok
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
    // Banner gone + table un-grayed the moment the connection is confirmed —
    // no waiting on the dwell.
    expect(result.current.autoReconnect).toBeNull();
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBeUndefined();

    // The session is still open internally through the dwell; once it elapses
    // quietly the counter resets, so a fresh outage starts at attempt 1.
    await flush(60_000);
    fireHealth(UNAVAIL);
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });
  });

  it("re-flag inside the dwell resumes the retry counter instead of restarting at 1", async () => {
    // The dwell keeps the session (counter) alive even though the banner is
    // hidden: a wedged cluster that re-flags within 60s must continue the retry
    // sequence, not reset to attempt 1 and risk an unbounded flap loop.
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL);
    await flush(2000); // attempt 1 fires, connect ok -> banner cleared, session open
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
    expect(result.current.autoReconnect).toBeNull();

    // Re-flag before the 60s dwell elapses: the session is still alive, so this
    // arms attempt 2 (not a fresh attempt 1) and re-shows the banner.
    fireHealth(UNAVAIL);
    expect(result.current.autoReconnect).toEqual({ attempt: 2, max: MAX });
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBe(true);
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

// --- Permanent-failure gating ------------------------------------------
//
// Regression: an RBAC 403 used to start a full silent retry session — MAX
// attempts with exponential backoff, minutes long — even though the same
// credentials produce the same 403 every time. While that session ran the panel
// showed the busy "Reconnecting…" banner, which carries neither the Diagnose
// button nor the cloud-identity note. The one screen explaining "this context
// is authenticating as the wrong account" was hidden by a loop that could never
// succeed, and an operator reading it lost it mid-read.
describe("useClusterConnection permanent-failure gating", () => {
  const FORBIDDEN: ClusterHealthEvent = {
    status: "unavailable",
    reason:
      'ApiError: namespaces is forbidden: User "ops@example.net" cannot list ' +
      'resource "namespaces": Forbidden (Status { code: 403 })',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    healthHandler = null;
    connectContext.mockReset().mockResolvedValue({ server_version: "v1" });
    cancelConnect.mockClear();
    reconnectCluster.mockClear().mockResolvedValue(undefined);
    getClusterHealth.mockReset().mockResolvedValue(HEALTHY);
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

  it("starts no retry session when the cluster goes unavailable with a 403", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(FORBIDDEN);
    await flush(backoff(0) * 4);

    // No busy banner and no rebuilt client, so the terminal banner (Diagnose +
    // cloud-identity note) stays put for as long as the operator needs it.
    expect(result.current.autoReconnect).toBeNull();
    expect(reconnectCluster).not.toHaveBeenCalled();
    // The health flag still reflects reality — only the *retrying* flag is off,
    // which is what routes the UI to the terminal banner.
    expect(useAppStore.getState().clusterHealth[CTX.id]).toBe("unavailable");
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBeUndefined();
  });

  it("still retries a transient unavailable (the gate must stay narrow)", async () => {
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    fireHealth(UNAVAIL);
    // Armed immediately, exactly as before the gate existed.
    expect(result.current.autoReconnect).toEqual({ attempt: 1, max: MAX });
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBe(true);

    await flush(backoff(0));
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
  });

  it("ends an in-flight retry session as soon as an attempt comes back 403", async () => {
    // Happens in the field: the cluster is hard-down so a session is running,
    // then the operator switches cloud account and every attempt starts being
    // denied. The remaining attempts are pointless and must be abandoned.
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    connectContext.mockRejectedValue(new Error("connection refused"));
    fireHealth(UNAVAIL);
    await flush(backoff(0));
    expect(reconnectCluster).toHaveBeenCalledTimes(1);
    expect(result.current.autoReconnect).not.toBeNull();

    // Identity drifts: every subsequent connect is denied.
    connectContext.mockRejectedValue(new Error(FORBIDDEN.reason ?? ""));
    await flush(backoff(1));

    expect(reconnectCluster).toHaveBeenCalledTimes(2);
    expect(result.current.autoReconnect).toBeNull();
    expect(useAppStore.getState().clusterReconnecting[CTX.id]).toBeUndefined();

    // And it stays abandoned — no further attempts trickle in.
    await flush(backoff(2) + backoff(3) + 30_000);
    expect(reconnectCluster).toHaveBeenCalledTimes(2);
  });

  it("a failed first connect arms no retry session at all", async () => {
    // Not a test of the permanent-failure gate, despite the 403: a first
    // connect has no session, so `onConnectResolved` returns at the
    // `!sessionActiveRef` guard before the gate is ever consulted, and this
    // passes with the gate deleted. Kept because the *behaviour* is worth
    // pinning — retries are armed by the health probe, never by the initial
    // connect — but named so it can't be mistaken for gate coverage. The gate
    // itself is covered by the two tests above.
    connectContext.mockRejectedValue(
      new Error("namespaces is forbidden: Forbidden (code: 403)"),
    );
    const { result } = renderHook(() => useClusterConnection(CTX));
    await flush();

    expect(result.current.state.status).toBe("error");
    await flush(backoff(0) * 4);
    expect(result.current.autoReconnect).toBeNull();
    expect(reconnectCluster).not.toHaveBeenCalled();
  });
});
