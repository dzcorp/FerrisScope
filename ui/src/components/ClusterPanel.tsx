import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppStore, useClusterLabels, useResolvedTheme } from "../store";
import type { ClusterInfo, ContextInfo } from "../types";
import { type ThemeMode, FS_MD } from "../theme";
import {
  useClusterConnection,
  type ConnectState,
} from "../lib/useClusterConnection";
import { ClusterBar } from "./ClusterBar";
import { ResourceTable } from "./ResourceTable";
import { ConnectionDiagnosticsModal } from "./ConnectionDiagnosticsModal";
import { CloudIdentityNote } from "./CloudIdentityNote";
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
  const { state, cancel, reconnect, autoReconnect } =
    useClusterConnection(context);
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
            autoReconnect={autoReconnect}
            diagnoseContext={context}
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
          autoReconnect ? (
            // Hard-down mid auto-reconnect: the connect itself is failing, so
            // there's no table to keep alive — show the silent-retry progress
            // instead of the terminal "could not connect" banner.
            <ReconnectBanner
              mode={mode}
              title="Reconnecting…"
              reason={state.message}
              onReconnect={reconnect}
              busy
              progress={autoReconnect}
            />
          ) : (
            <ReconnectBanner
              mode={mode}
              title="Could not connect to this cluster"
              reason={state.message}
              onReconnect={reconnect}
              diagnoseContext={context}
            />
          )
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
  const shortName = useClusterLabels()[context.id]?.short ?? context.name;
  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span title={context.name}>
      Connecting to {shortName}… <span style={{ opacity: 0.6 }}>({secs}s)</span>
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
  hintReason,
  onReconnect,
  diagnoseContext,
  busy = false,
  progress,
}: {
  mode: ThemeMode;
  title: string;
  reason: string | null;
  /// The connect error *verbatim*, for `CloudIdentityNote` to parse. Kept
  /// separate from `reason` because callers substitute app-authored prose
  /// there when the backend gave them nothing ("No response from the apiserver
  /// for 30s…"), and the backend extracts the authenticated identity out of
  /// this string — feeding it our own sentence would be a lie it has to parse.
  /// Defaults to `reason` where the two genuinely are the same value.
  hintReason?: string | null;
  onReconnect: () => void;
  /// When set, renders a "Diagnose" button that opens passive connection
  /// diagnostics for this context. Omitted where diagnosis makes no sense
  /// (a healthy cluster gone temporarily unavailable, a cancelled connect).
  diagnoseContext?: ContextInfo;
  /// True while a silent auto-reconnect session is mid-retry. Switches the
  /// dot to a pulsing animation and relabels the primary button to
  /// "Reconnect now" (force an immediate attempt without waiting out the
  /// backoff). The same banner shape is reused — not forked.
  busy?: boolean;
  /// `{attempt, max}` of the active auto-reconnect session, rendered as a
  /// "(2/3)" suffix next to the title when `busy`.
  progress?: { attempt: number; max: number };
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
        className={busy ? "fs-pulse-dot" : undefined}
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
          {busy && progress && (
            <span style={{ marginLeft: 6, color: t.textDim, fontWeight: 400 }}>
              ({progress.attempt}/{progress.max})
            </span>
          )}
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
        {/* Gated on the same prop as the Diagnose button, so the note only
            appears on the terminal "could not connect" banner — not mid
            auto-reconnect, and not on a cancelled connect. Renders nothing
            unless the backend recognises cloud identity drift. */}
        {diagnoseContext && (hintReason ?? reason) && (
          <CloudIdentityNote
            t={t}
            contextId={diagnoseContext.id}
            reason={(hintReason ?? reason) as string}
            onReconnect={onReconnect}
          />
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
        {busy ? "Reconnect now" : "Reconnect"}
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
// cluster's heartbeat probe has flipped to unavailable (or while we're
// silently auto-reconnecting). Last-known rows stay rendered (dimmed) so the
// operator's in-flight inspection isn't jarringly cleared — data is stale, but
// the table stays *interactive* on purpose: clicking a row opens its detail
// (cached row + a best-effort live fetch) and cross-kind navigation still
// works. Write affordances self-gate to read-only via `selectClusterDegraded`
// (see store.ts) — so we deliberately do NOT kill pointer events here.
export function UnavailableOverlay({
  mode,
  unavailable,
  reason,
  onReconnect,
  autoReconnect,
  diagnoseContext,
  children,
}: {
  mode: ThemeMode;
  unavailable: boolean;
  reason: string | null;
  onReconnect: () => void;
  /// Non-null while a silent auto-reconnect session is retrying — swaps the
  /// terminal "Cluster unavailable" banner for the busy progress variant.
  autoReconnect: { attempt: number; max: number } | null;
  /// Enables Diagnose + the cloud-identity note on the *terminal* banner. A
  /// cluster can go unavailable because the operator's cloud identity drifted
  /// mid-session (the heartbeat starts getting 403s), which is the same problem
  /// the connect-failure banner explains — so it gets the same affordances.
  /// Omitted while retrying: nothing to act on until the session gives up.
  diagnoseContext?: ContextInfo;
  children: ReactNode;
}) {
  // Show the overlay through the whole session: a wedged cluster's retry may
  // momentarily reconnect (health reads healthy) between attempts, but we keep
  // the dim + busy banner until the session ends so the UI doesn't flicker.
  if (!unavailable && !autoReconnect) return <>{children}</>;
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
      {autoReconnect ? (
        <ReconnectBanner
          mode={mode}
          title="Reconnecting…"
          reason={
            reason ??
            "Lost contact with the apiserver. Retrying with a fresh connection."
          }
          onReconnect={onReconnect}
          busy
          progress={autoReconnect}
        />
      ) : (
        <ReconnectBanner
          mode={mode}
          title="Cluster unavailable"
          reason={
            reason ??
            "No response from the apiserver for 30s. Watchers and metrics have been torn down."
          }
          hintReason={reason}
          onReconnect={onReconnect}
          diagnoseContext={diagnoseContext}
        />
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          opacity: 0.5,
        }}
      >
        {children}
      </div>
    </div>
  );
}
