import { logErr } from "./log";
import { useEffect, useRef, useState } from "react";
import { api, onClusterHealth, onClusterInfoChanged } from "../api";
import { useAppStore } from "../store";
import type { ClusterInfo, ContextInfo } from "../types";

export type ConnectState =
  | { status: "connecting"; startedAt: number; connectId: string }
  | { status: "ok"; info: ClusterInfo }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/// Progress of an in-flight silent auto-reconnect session. `null` when no
/// session is retrying (cold, or exhausted into the manual banner).
export type AutoReconnect = { attempt: number; max: number };

// How many silent reconnect attempts we make after the cluster is declared
// unavailable before falling through to the manual ReconnectBanner. Each
// attempt is a full reconnect_cluster + connect_context, i.e. a *fresh client*
// — which is exactly the recovery the backend health probe documents as the
// only clean path out of a wedged HTTP/2 pool (crates/core/src/health.rs).
const MAX_AUTO = 10;
// Exponential backoff before each attempt, capped so the later retries in a
// long session settle into a steady poll instead of growing unbounded.
// Indexed by attempts-already-used: 2s, 4s, 8s, 16s, then 30s flat.
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30_000;
function backoffMs(attemptIdx: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attemptIdx, BACKOFF_CAP_MS);
}
// After an auto attempt connects, the cluster may still be wedged and re-flag
// ~30s later (the probe's unhealthy window). We only consider a session truly
// recovered once it's stayed connected this long with no new unavailable.
const RECOVERY_DWELL_MS = 60_000;

// Generate a unique connect_id per attempt. crypto.randomUUID is available
// in Tauri's WebKit; fall back to a timestamp-based id if it ever isn't.
function newConnectId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Owns one cluster's connection lifecycle — extracted verbatim from
// ClusterPanel so a virtual context can run N of these (one per member,
// each inside its own headless component to keep React hook order fixed).
//
// Connection model:
//   - Each attempt gets a fresh connect_id; the backend stores a oneshot per
//     id so the UI can abort an in-flight connect (cancel button, or
//     unmount / context-switch).
//   - Switching contexts mid-connect cancels the old request before starting
//     a new one, so a slow first connect can't clobber a fast second one.
//   - The backend also enforces a 15s wall-clock timeout — a wedged auth
//     plugin or unreachable apiserver still resolves with an error.
//
// Auto-reconnect: when the background health probe declares the cluster
// unavailable (or an auto attempt's connect fails outright), we silently retry
// up to MAX_AUTO times with exponential backoff before surfacing the manual
// banner. The retry IS a programmatic press of the same Reconnect button, so
// it rebuilds a fresh client each time — honoring the backend's "recovery
// requires a rebuilt client" contract without any backend change. All session
// state lives in refs (not state) so our own `setAttempt` bumps — which re-run
// the connect effect — can't reset the counter mid-session.
export function useClusterConnection(context: ContextInfo): {
  state: ConnectState;
  /// Abort an in-flight connect. No-op outside `connecting`.
  cancel: () => void;
  /// Drop the cached backend ClusterEntry, clear the health flag, and re-run
  /// the connect from a clean slate. Used by every ReconnectBanner. Cancels
  /// any active auto-reconnect session and resets its counter.
  reconnect: () => void;
  /// Non-null while a silent auto-reconnect session is actively retrying.
  autoReconnect: AutoReconnect | null;
} {
  // Initialise straight to "connecting" so the first paint already renders
  // the Cancel-button-bearing layout. The placeholder connectId is replaced
  // by the useEffect below within the same commit, so cancel always sees
  // the real id.
  const [state, setState] = useState<ConnectState>(() => ({
    status: "connecting",
    startedAt: Date.now(),
    connectId: "",
  }));
  const [attempt, setAttempt] = useState(0);
  const [autoReconnect, setAutoReconnect] = useState<AutoReconnect | null>(null);
  const reqId = useRef(0);
  const applyClusterHealth = useAppStore((s) => s.applyClusterHealth);
  const clearClusterHealth = useAppStore((s) => s.clearClusterHealth);
  const setClusterReconnecting = useAppStore((s) => s.setClusterReconnecting);

  // Mutable auto-reconnect session state. Refs, not state, so re-running the
  // connect effect (via setAttempt) never clobbers them.
  const attemptsUsedRef = useRef(0); // auto attempts consumed this session (0..MAX_AUTO)
  const sessionActiveRef = useRef(false);
  const attemptInFlightRef = useRef(false); // an auto attempt's connect is mid-flight
  const backoffTimerRef = useRef<number | null>(null);
  const dwellTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Current context id, readable from controller methods that outlive a render.
  const cidRef = useRef(context.id);
  cidRef.current = context.id;

  // Build the auto-reconnect controller once. It closes over the stable refs +
  // setters above (React state setters and zustand actions are referentially
  // stable), and reads the *current* context id through cidRef.
  const ctlRef = useRef<{
    onUnavailable: () => void;
    onConnectResolved: (result: "ok" | "error") => void;
    reset: (resetCounter: boolean) => void;
  } | null>(null);
  if (ctlRef.current === null) {
    const clearTimers = () => {
      if (backoffTimerRef.current != null) {
        window.clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
      if (dwellTimerRef.current != null) {
        window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
    };

    const endSession = (resetCounter: boolean) => {
      clearTimers();
      sessionActiveRef.current = false;
      attemptInFlightRef.current = false;
      if (resetCounter) attemptsUsedRef.current = 0;
      setClusterReconnecting(cidRef.current, false);
      if (mountedRef.current) setAutoReconnect(null);
    };

    // Fire the reconnect mechanics for one auto attempt. NOT the public
    // reconnect() — that resets the counter, which would loop forever.
    const runAttempt = () => {
      backoffTimerRef.current = null;
      attemptsUsedRef.current += 1;
      attemptInFlightRef.current = true;
      // Pin the cluster id for the whole async chain. If the context switches
      // while reconnectCluster is in flight, cidRef advances to the new id —
      // the .finally must still clear health for the cluster we reconnected,
      // not the one we just switched to. (Mirrors manual reconnect().)
      const contextId = cidRef.current;
      api
        .reconnectCluster(contextId)
        .catch(logErr("cluster-connect"))
        .finally(() => {
          clearClusterHealth(contextId);
          setAttempt((n) => n + 1); // re-runs the connect effect with a fresh client
        });
    };

    const scheduleNext = () => {
      // Dedupe: one pending backoff or in-flight attempt at a time.
      if (backoffTimerRef.current != null || attemptInFlightRef.current) return;
      if (attemptsUsedRef.current >= MAX_AUTO) {
        // Out of budget — drop the session and leave health/connect state as-is
        // so the existing manual banner takes over.
        endSession(false);
        return;
      }
      sessionActiveRef.current = true;
      setClusterReconnecting(cidRef.current, true);
      const idx = attemptsUsedRef.current; // backoff index + display attempt n
      if (mountedRef.current) setAutoReconnect({ attempt: idx + 1, max: MAX_AUTO });
      backoffTimerRef.current = window.setTimeout(runAttempt, backoffMs(idx));
    };

    ctlRef.current = {
      onUnavailable() {
        // A wedged cluster re-flagging cancels any pending recovery dwell.
        if (dwellTimerRef.current != null) {
          window.clearTimeout(dwellTimerRef.current);
          dwellTimerRef.current = null;
        }
        scheduleNext(); // starts the session on the first unavailable; advances it after
      },
      onConnectResolved(result) {
        attemptInFlightRef.current = false;
        if (!sessionActiveRef.current) return; // no active session → normal behaviour
        if (result === "error") {
          // Hard-down: the connect itself failed, so drive the next attempt now
          // (no unavailable event will arrive — there's no live probe).
          scheduleNext();
          return;
        }
        // Connected: optimistically recovered, but a wedged cluster may re-flag
        // ~30s later. Hold the session open through a dwell; if no unavailable
        // arrives, declare recovery and reset.
        if (dwellTimerRef.current != null) window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = window.setTimeout(
          () => endSession(true),
          RECOVERY_DWELL_MS,
        );
      },
      reset(resetCounter) {
        endSession(resetCounter);
      },
    };
  }

  // Mount-only flag, so the [context.id] effect below can reset per-context
  // state without falsely tripping the unmount guard on a context switch.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Per-context auto-reconnect lifecycle. Keyed on context.id ONLY (not the
  // attempt counter) so our own setAttempt bumps don't wipe the session. On
  // enter: clean slate. On leave (context switch or unmount): clear timers and
  // the reconnecting flag for the OLD id (captured in the closure — cidRef has
  // already advanced to the new id by the time cleanup runs).
  useEffect(() => {
    const cid = context.id;
    attemptsUsedRef.current = 0;
    sessionActiveRef.current = false;
    attemptInFlightRef.current = false;
    if (backoffTimerRef.current != null) {
      window.clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
    if (dwellTimerRef.current != null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    setAutoReconnect(null);
    return () => {
      if (backoffTimerRef.current != null) {
        window.clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
      if (dwellTimerRef.current != null) {
        window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
      sessionActiveRef.current = false;
      attemptInFlightRef.current = false;
      attemptsUsedRef.current = 0;
      setClusterReconnecting(cid, false);
    };
  }, [context.id, setClusterReconnecting]);

  useEffect(() => {
    const id = ++reqId.current;
    const connectId = newConnectId();
    setState({ status: "connecting", startedAt: Date.now(), connectId });
    let unlisten: (() => void) | null = null;
    let unlistenHealth: (() => void) | null = null;
    let cancelled = false;

    // Subscribe to the per-cluster health probe before firing connect so
    // we don't miss the unavailable transition if it lands during the
    // initial connect window. The backend emits exactly one unavailable
    // event per cluster lifetime; it's the data plane's "this is dead"
    // signal that the resource table uses to dim its rows + show the
    // banner — and our trigger to start silently auto-reconnecting.
    onClusterHealth(context.id, (evt) => {
      if (cancelled) return;
      applyClusterHealth(context.id, evt.status, evt.reason);
      if (evt.status === "unavailable") ctlRef.current?.onUnavailable();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenHealth = fn;
    });

    // Listen for the deferred cluster.info result before firing the connect
    // call so we don't miss the event if it arrives between connect_context
    // resolving and this listener being installed (the backend probe runs
    // in parallel with our await on the tauri command).
    onClusterInfoChanged(context.id, (info) => {
      if (cancelled || reqId.current !== id) return;
      // Merge into whatever state we're currently in — info can land before
      // *or* after `status: "ok"` because of the race above. If we're not
      // in "ok" yet, defer; otherwise overwrite the placeholder fields.
      setState((cur) => (cur.status === "ok" ? { status: "ok", info } : cur));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    api
      .connectContext(context.id, connectId)
      .then((info) => {
        if (reqId.current === id) {
          setState({ status: "ok", info });
          ctlRef.current?.onConnectResolved("ok");
        }
      })
      .catch((e: unknown) => {
        if (reqId.current !== id) return;
        const message = String(e);
        if (message.toLowerCase().includes("cancelled")) {
          setState({ status: "cancelled" });
        } else {
          setState({ status: "error", message });
          ctlRef.current?.onConnectResolved("error");
        }
      });
    // Effect cleanup runs on context change *and* unmount. Either way the
    // pending request becomes stale (reqId bumped above on the next mount,
    // or no longer needed on unmount); fire-and-forget cancel so the
    // backend drops its in-flight future.
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (unlistenHealth) unlistenHealth();
      api.cancelConnect(connectId).catch(logErr("cluster-connect"));
    };
  }, [context.id, attempt, applyClusterHealth]);

  const cancel = () => {
    setState((cur) => {
      if (cur.status !== "connecting") return cur;
      api.cancelConnect(cur.connectId).catch(logErr("cluster-connect"));
      return { status: "cancelled" };
    });
  };

  // `insert_connected` returns the existing entry if one was lazy-created
  // (App's eager namespaces subscribe runs before connect_context, and a
  // wedged client built then would otherwise get reused on every retry) —
  // hence reconnect_cluster first, then a fresh attempt. Cancels any active
  // auto-reconnect session first so a manual press wins cleanly.
  const reconnect = () => {
    const id = context.id;
    ctlRef.current?.reset(true);
    api
      .reconnectCluster(id)
      .catch(logErr("cluster-connect"))
      .finally(() => {
        clearClusterHealth(id);
        setAttempt((n) => n + 1);
      });
  };

  return { state, cancel, reconnect, autoReconnect };
}
