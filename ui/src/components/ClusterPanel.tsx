import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, onClusterHealth, onClusterInfoChanged } from "../api";
import { useAppStore, useResolvedTheme } from "../store";
import type { ClusterInfo, ContextInfo } from "../types";
import { type ThemeMode, FS_MD } from "../theme";
import { ClusterBar } from "./ClusterBar";
import { ResourceTable } from "./ResourceTable";
import { Btn, EmptyState, ErrorBlock, LoadingLine } from "./ui";

type ConnectState =
  | { status: "connecting"; startedAt: number; connectId: string }
  | { status: "ok"; info: ClusterInfo }
  | { status: "cancelled" }
  | { status: "error"; message: string };

type Props = {
  mode: ThemeMode;
  context: ContextInfo;
};

// Generate a unique connect_id per attempt. crypto.randomUUID is available
// in Tauri's WebKit; fall back to a timestamp-based id if it ever isn't.
function newConnectId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Owns the cluster-scoped connection lifecycle. Keeps the cluster bar visible
// while connecting (P6) and renders the selected resource kind's table.
//
// Connection model:
//   - Each attempt gets a fresh connect_id; the backend stores a oneshot per
//     id so the UI can abort an in-flight connect (cancel button, or
//     unmount / context-switch).
//   - Switching contexts mid-connect cancels the old request before starting
//     a new one, so a slow first connect can't clobber a fast second one.
//   - The backend also enforces a 15s wall-clock timeout — a wedged auth
//     plugin or unreachable apiserver still resolves with an error.
export function ClusterPanel({ mode, context }: Props) {
  const t = useResolvedTheme().tokens;
  // Initialise straight to "connecting" so the first paint already renders
  // the Cancel-button-bearing layout. The placeholder connectId is replaced
  // by the useEffect below within the same commit, so cancelConnect always
  // sees the real id.
  const [state, setState] = useState<ConnectState>(() => ({
    status: "connecting",
    startedAt: Date.now(),
    connectId: "",
  }));
  const [attempt, setAttempt] = useState(0);
  const reqId = useRef(0);
  const selectedKind = useAppStore((s) =>
    s.kinds.find((k) => k.id === s.selectedKindId) ?? null,
  );
  const applyClusterHealth = useAppStore((s) => s.applyClusterHealth);
  const clearClusterHealth = useAppStore((s) => s.clearClusterHealth);
  const healthStatus = useAppStore(
    (s) => s.clusterHealth[context.id] ?? "healthy",
  );
  const healthReason = useAppStore(
    (s) => s.clusterHealthReason[context.id] ?? null,
  );

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
      setState((cur) =>
        cur.status === "ok" ? { status: "ok", info } : cur,
      );
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
      api.cancelConnect(connectId).catch(() => {});
    };
  }, [context.id, attempt, applyClusterHealth]);

  const onCancel = () => {
    if (state.status !== "connecting") return;
    api.cancelConnect(state.connectId).catch(() => {});
    setState({ status: "cancelled" });
  };

  // Drop the cached backend ClusterEntry, clear the health flag, and
  // bump `attempt` so the connect effect re-runs from a clean slate.
  // Used by every `ReconnectBanner` instance (initial connect failed,
  // operator-cancelled, heartbeat declared unavailable) — bare "bump
  // attempt" isn't enough because `state.insert_connected` returns
  // the existing entry if one was lazy-created (App's eager namespaces
  // subscribe runs before connect_context, and a wedged client built
  // then would otherwise get reused on every retry).
  const onReconnect = () => {
    const id = context.id;
    api
      .reconnectCluster(id)
      .catch(() => {})
      .finally(() => {
        clearClusterHealth(id);
        setAttempt((n) => n + 1);
      });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: t.bg,
      }}
    >
      <ClusterBar mode={mode} context={context} state={connectStateForBar(state)} />

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {state.status === "ok" ? (
          <UnavailableOverlay
            mode={mode}
            unavailable={healthStatus === "unavailable"}
            reason={healthReason}
            onReconnect={onReconnect}
          >
            {selectedKind ? (
              <ResourceTable
                mode={mode}
                clusterId={context.id}
                kind={selectedKind}
              />
            ) : (
              <EmptyState
                t={t}
                title="Pick a resource kind"
                hint="Hover the left rail to expand it, then choose a kind."
              />
            )}
          </UnavailableOverlay>
        ) : state.status === "error" ? (
          <ReconnectBanner
            mode={mode}
            title="Could not connect to this cluster"
            reason={state.message}
            onReconnect={onReconnect}
          />
        ) : state.status === "cancelled" ? (
          <ReconnectBanner
            mode={mode}
            title="Connection cancelled"
            reason={null}
            onReconnect={onReconnect}
          />
        ) : (
          <LoadingLine
            t={t}
            label={<ConnectingLabel context={context} startedAt={state.startedAt} />}
            action={
              <Btn t={t} variant="secondary" size="sm" onClick={onCancel}>
                Cancel
              </Btn>
            }
          />
        )}
      </div>
    </div>
  );
}

// ClusterBar's `state` discriminator is { connecting | ok | error };
// our extra `cancelled` state doesn't exist there, so present it as an error
// for the bar's purposes (red dot + message). The retry UI in the panel body
// is what the user actually interacts with.
function connectStateForBar(s: ConnectState):
  | { status: "connecting" }
  | { status: "ok"; info: ClusterInfo }
  | { status: "error"; message: string } {
  if (s.status === "cancelled") {
    return { status: "error", message: "Connection cancelled" };
  }
  if (s.status === "connecting") {
    return { status: "connecting" };
  }
  return s;
}

// Live-updating label with elapsed seconds so a slow connect doesn't feel
// frozen. Re-renders once per second; cleans up on unmount or context change.
function ConnectingLabel({
  context,
  startedAt,
}: {
  context: ContextInfo;
  startedAt: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span>
      Connecting to {context.name}… <span style={{ opacity: 0.6 }}>({secs}s)</span>
    </span>
  );
}

// Single banner used for every "cluster needs reconnecting" state —
// initial connect failure, operator-cancelled connect, and the
// background heartbeat declaring the cluster unavailable. Same shape
// across all three so the operator sees a consistent affordance
// regardless of how the cluster got broken.
function ReconnectBanner({
  
  title,
  reason,
  onReconnect,
}: {
  mode: ThemeMode;
  title: string;
  reason: string | null;
  onReconnect: () => void;
}) {
  const t = useResolvedTheme().tokens;
  return (
    <div
      role="alert"
      style={{
        flexShrink: 0,
        background: t.surfaceAlt,
        borderBottom: `1px solid ${t.warn}`,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: t.warn,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: t.text, fontSize: FS_MD, fontWeight: 600 }}>
          {title}
        </div>
        {reason && (
          <div style={{ marginTop: 2 }} title={reason}>
            <ErrorBlock
              t={t}
              message={reason}
              kindLabel="cluster"
              inline
            />
          </div>
        )}
      </div>
      <Btn t={t} variant="primary" size="sm" onClick={onReconnect}>
        Reconnect
      </Btn>
    </div>
  );
}

// Renders the resource table with a `ReconnectBanner` on top when the
// cluster's heartbeat probe has flipped to unavailable. Last-known rows
// stay rendered (dimmed) so the operator's in-flight inspection isn't
// jarringly cleared — but data is stale and any new subscribe call
// returns an "unavailable" error from the backend until Reconnect lands.
function UnavailableOverlay({
  mode,
  unavailable,
  reason,
  onReconnect,
  children,
}: {
  mode: ThemeMode;
  unavailable: boolean;
  reason: string | null;
  onReconnect: () => void;
  children: ReactNode;
}) {
  if (!unavailable) return <>{children}</>;
  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <ReconnectBanner
        mode={mode}
        title="Cluster unavailable"
        reason={
          reason ??
          "No response from the apiserver for 30s. Watchers and metrics have been torn down."
        }
        onReconnect={onReconnect}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          opacity: 0.5,
          pointerEvents: "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
