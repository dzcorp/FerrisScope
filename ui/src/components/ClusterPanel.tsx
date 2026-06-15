import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppStore, useResolvedTheme } from "../store";
import type { ClusterInfo, ContextInfo } from "../types";
import { type ThemeMode, FS_MD } from "../theme";
import {
  useClusterConnection,
  type ConnectState,
} from "../lib/useClusterConnection";
import { ClusterBar } from "./ClusterBar";
import { ResourceTable } from "./ResourceTable";
import { ConnectionDiagnosticsModal } from "./ConnectionDiagnosticsModal";
import { Btn, EmptyState, ErrorBlock, LoadingLine } from "./ui";

type Props = {
  mode: ThemeMode;
  context: ContextInfo;
};

// Owns the cluster-scoped connection lifecycle. Keeps the cluster bar visible
// while connecting (P6) and renders the selected resource kind's table.
// The connect state machine itself lives in `useClusterConnection` (shared
// with VirtualClusterPanel, which runs one per member).
export function ClusterPanel({ mode, context }: Props) {
  const t = useResolvedTheme().tokens;
  const { state, cancel, reconnect } = useClusterConnection(context);
  const selectedKind = useAppStore((s) =>
    s.kinds.find((k) => k.id === s.selectedKindId) ?? null,
  );
  const healthStatus = useAppStore(
    (s) => s.clusterHealth[context.id] ?? "healthy",
  );
  const healthReason = useAppStore(
    (s) => s.clusterHealthReason[context.id] ?? null,
  );

  // Stable single-entry cluster list for the table — ResourceTable keys its
  // subscription fan-out on this array's contents.
  const clusters = useMemo(
    () => [{ id: context.id, name: context.name, colorIdx: 0 }],
    [context.id, context.name],
  );

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
            onReconnect={reconnect}
          >
            {selectedKind ? (
              <ResourceTable
                mode={mode}
                clusters={clusters}
                viewScopeId={context.id}
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
            onReconnect={reconnect}
            diagnoseContext={context}
          />
        ) : state.status === "cancelled" ? (
          <ReconnectBanner
            mode={mode}
            title="Connection cancelled"
            reason={null}
            onReconnect={reconnect}
          />
        ) : (
          <LoadingLine
            t={t}
            label={<ConnectingLabel context={context} startedAt={state.startedAt} />}
            action={
              <Btn t={t} variant="secondary" size="sm" onClick={cancel}>
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
// regardless of how the cluster got broken. Exported for the
// per-member failure strips in VirtualClusterPanel.
export function ReconnectBanner({
  title,
  reason,
  onReconnect,
  diagnoseContext,
}: {
  mode: ThemeMode;
  title: string;
  reason: string | null;
  onReconnect: () => void;
  /// When set, renders a "Diagnose" button that opens passive connection
  /// diagnostics for this context. Omitted where diagnosis makes no sense
  /// (a healthy cluster gone temporarily unavailable, a cancelled connect).
  diagnoseContext?: ContextInfo;
}) {
  const t = useResolvedTheme().tokens;
  const [showDiag, setShowDiag] = useState(false);
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
      {diagnoseContext && (
        <Btn
          t={t}
          variant="secondary"
          size="sm"
          onClick={() => setShowDiag(true)}
        >
          Diagnose
        </Btn>
      )}
      <Btn t={t} variant="primary" size="sm" onClick={onReconnect}>
        Reconnect
      </Btn>
      {diagnoseContext && showDiag && (
        <ConnectionDiagnosticsModal
          t={t}
          contextId={diagnoseContext.id}
          contextName={diagnoseContext.name}
          onClose={() => setShowDiag(false)}
        />
      )}
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
