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
export function useClusterConnection(context: ContextInfo): {
  state: ConnectState;
  /// Abort an in-flight connect. No-op outside `connecting`.
  cancel: () => void;
  /// Drop the cached backend ClusterEntry, clear the health flag, and re-run
  /// the connect from a clean slate. Used by every ReconnectBanner.
  reconnect: () => void;
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
  const reqId = useRef(0);
  const applyClusterHealth = useAppStore((s) => s.applyClusterHealth);
  const clearClusterHealth = useAppStore((s) => s.clearClusterHealth);

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
    // banner.
    onClusterHealth(context.id, (evt) => {
      if (cancelled) return;
      applyClusterHealth(context.id, evt.status, evt.reason);
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
        if (reqId.current === id) setState({ status: "ok", info });
      })
      .catch((e: unknown) => {
        if (reqId.current !== id) return;
        const message = String(e);
        if (message.toLowerCase().includes("cancelled")) {
          setState({ status: "cancelled" });
        } else {
          setState({ status: "error", message });
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
  // hence reconnect_cluster first, then a fresh attempt.
  const reconnect = () => {
    const id = context.id;
    api
      .reconnectCluster(id)
      .catch(logErr("cluster-connect"))
      .finally(() => {
        clearClusterHealth(id);
        setAttempt((n) => n + 1);
      });
  };

  return { state, cancel, reconnect };
}
