import { useEffect, useRef, useState } from "react";
import { api, onClusterInfoChanged } from "../api";
import { useAppStore } from "../store";
import type { ClusterInfo, ContextInfo } from "../types";
import { tokens, type ThemeMode } from "../theme";
import { ClusterBar } from "./ClusterBar";
import { ResourceTable } from "./ResourceTable";
import { Btn, EmptyState, Loading } from "./ui";

type ConnectState =
  | { status: "idle" }
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
  const t = tokens(mode);
  const [state, setState] = useState<ConnectState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const reqId = useRef(0);
  const selectedKind = useAppStore((s) =>
    s.kinds.find((k) => k.id === s.selectedKindId) ?? null,
  );

  useEffect(() => {
    const id = ++reqId.current;
    const connectId = newConnectId();
    setState({ status: "connecting", startedAt: Date.now(), connectId });
    let unlisten: (() => void) | null = null;
    let cancelled = false;

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
      api.cancelConnect(connectId).catch(() => {});
    };
  }, [context.id, attempt]);

  const onCancel = () => {
    if (state.status !== "connecting") return;
    api.cancelConnect(state.connectId).catch(() => {});
    setState({ status: "cancelled" });
  };

  const onRetry = () => {
    setAttempt((n) => n + 1);
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
          selectedKind ? (
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
          )
        ) : state.status === "error" ? (
          <EmptyState
            t={t}
            title="Could not connect to this cluster"
            hint={state.message}
            action={
              <Btn t={t} variant="primary" onClick={onRetry}>
                Retry
              </Btn>
            }
          />
        ) : state.status === "cancelled" ? (
          <EmptyState
            t={t}
            title="Connection cancelled"
            hint="Press Retry to try again."
            action={
              <Btn t={t} variant="primary" onClick={onRetry}>
                Retry
              </Btn>
            }
          />
        ) : state.status === "connecting" ? (
          <Loading
            t={t}
            label={<ConnectingLabel context={context} startedAt={state.startedAt} />}
            action={
              <Btn t={t} variant="secondary" size="sm" onClick={onCancel}>
                Cancel
              </Btn>
            }
          />
        ) : (
          <Loading t={t} label={`Connecting to ${context.name}…`} />
        )}
      </div>
    </div>
  );
}

// ClusterBar's `state` discriminator is { idle | connecting | ok | error };
// our extra `cancelled` state doesn't exist there, so present it as an error
// for the bar's purposes (red dot + message). The retry UI in the panel body
// is what the user actually interacts with.
function connectStateForBar(s: ConnectState):
  | { status: "idle" }
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
