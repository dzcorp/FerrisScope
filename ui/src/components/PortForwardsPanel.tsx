import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAppStore, useResolvedTheme } from "../store";
import { FF_MONO, FONT_SANS, type ThemeMode, type Tokens, FS_MD, FS_SM, FS_XS } from "../theme";
import type {
  ForwardEntry,
  ForwardStatus,
  GlobalForwardSession,
  HelperStatus,
} from "../types";
import {
  EmptyState,
  ErrorBlock,
  Eyebrow,
  IconBtn,
  Icons,
  Tooltip,
} from "./ui";
import { Btn } from "./ui/Btn";
import { NewForwardForm } from "./forwards/NewForwardForm";
import { toast } from "../lib/dialog";

type Props = { mode: ThemeMode };

// Right-side slide-over listing every active port-forward, grouped by cluster.
// Same chrome as NotificationsPanel: scrim + slide-from-right + Esc to close.
// Each row offers stop, copy URL, and pin/unpin (autostart toggle).
export function PortForwardsPanel({ mode }: Props) {
  const t = useResolvedTheme().tokens;
  const open = useAppStore((s) => s.forwardsOpen);
  const close = useAppStore((s) => s.closeForwardsPanel);
  const forwards = useAppStore((s) => s.forwards);
  const removeForward = useAppStore((s) => s.removeForward);
  const upsertForward = useAppStore((s) => s.upsertForward);
  const contexts = useAppStore((s) => s.contexts);
  const globalForwards = useAppStore((s) => s.globalForwards);
  const helperStatus = useAppStore((s) => s.helperStatus);
  const hydrateGlobalForwards = useAppStore((s) => s.hydrateGlobalForwards);
  const removeGlobalForward = useAppStore((s) => s.removeGlobalForward);
  const setHelperStatus = useAppStore((s) => s.setHelperStatus);
  // Ids of global sessions with an in-flight disable, for a busy/disabled row.
  const [disabling, setDisabling] = useState<Record<string, boolean>>({});
  // Whether the manual "new forward" form is expanded.
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Reconcile global state from the backend each time the panel opens — the
  // helper may have changed status (running / failed) since last seen.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Best-effort reconcile: a failed refresh leaves the existing in-memory
    // state in place rather than blanking the panel, but we surface the error to
    // the console instead of swallowing it silently so a persistently broken
    // backend is diagnosable.
    api
      .gfList()
      .then((sessions) => {
        if (!cancelled) hydrateGlobalForwards(sessions);
      })
      .catch((e) => console.warn("gf_list refresh failed", e));
    api
      .gfHelperStatus()
      .then((s) => {
        if (!cancelled) setHelperStatus(s);
      })
      .catch((e) => console.warn("gf_helper_status refresh failed", e));
    return () => {
      cancelled = true;
    };
  }, [open, hydrateGlobalForwards, setHelperStatus]);

  // Display name for a cluster id — fall back to the raw id if the context
  // has been removed since the forward was started (orphaned listener path
  // handled by backend cleanup, but we still want to show the in-memory
  // entry until the status event arrives).
  const clusterLabel = useMemo(() => {
    const map = new Map(contexts.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? id;
  }, [contexts]);

  // Global-mode listeners also live in the shared registry (so pf_list returns
  // them), but they're rendered in their own section — keep the simple list
  // to true localhost forwards only.
  const entries = useMemo(
    () => Object.values(forwards).filter((e) => e.spec.mode !== "global"),
    [forwards],
  );
  const globalSessions = useMemo(
    () => Object.values(globalForwards).sort((a, b) => a.id.localeCompare(b.id)),
    [globalForwards],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, ForwardEntry[]>();
    for (const e of entries) {
      const k = e.spec.cluster_id;
      const cur = groups.get(k);
      if (cur) cur.push(e);
      else groups.set(k, [e]);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.spec.id.localeCompare(b.spec.id));
    }
    return [...groups.entries()].sort(([a], [b]) =>
      clusterLabel(a).localeCompare(clusterLabel(b)),
    );
  }, [entries, clusterLabel]);

  if (!open) return null;

  const onStop = async (id: string) => {
    try {
      await api.pfStop(id);
      // Backend emits Stopped over the channel; remove eagerly so the UI
      // doesn't render a half-dead row in the meantime.
      removeForward(id);
    } catch (e) {
      toast.bad(`Stop failed: ${String(e)}`);
    }
  };

  const onPinToggle = async (e: ForwardEntry) => {
    const next = !e.spec.autostart;
    try {
      await api.pfSetAutostart(e.spec.id, next);
      upsertForward({ ...e, spec: { ...e.spec, autostart: next } });
    } catch (err) {
      toast.bad(`Pin toggle failed: ${String(err)}`);
    }
  };

  const onCopy = (entry: ForwardEntry) => {
    const url = `127.0.0.1:${entry.actual_local_port}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.ok(`Copied ${url}`))
      .catch(() => toast.bad("Couldn't copy to clipboard"));
  };

  // Hand http://127.0.0.1:<port> to the OS opener. We always use http://;
  // the operator can reach https services but we'd need a TLS hint we don't
  // currently have to default to https without breaking the common case.
  const onOpen = (entry: ForwardEntry) => {
    const url = `http://127.0.0.1:${entry.actual_local_port}`;
    api.openExternal(url).catch((e) => toast.bad(`Open failed: ${String(e)}`));
  };

  const onCopyText = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.ok(`Copied ${text}`))
      .catch(() => toast.bad("Couldn't copy to clipboard"));
  };

  // Open a forwarded hostname in the browser. Same http:// rationale as `onOpen`
  // — a global forward binds the service port on the loopback IP the hostname
  // resolves to, so `http://<hostname>:<port>` reaches it.
  const onOpenHost = (hostname: string, port: number) => {
    const url = `http://${hostname}:${port}`;
    api.openExternal(url).catch((e) => toast.bad(`Open failed: ${String(e)}`));
  };

  const onDisableGlobal = async (id: string) => {
    setDisabling((d) => ({ ...d, [id]: true }));
    try {
      await api.gfDisable(id);
      removeGlobalForward(id);
    } catch (e) {
      toast.bad(`Disable failed: ${String(e)}`);
    } finally {
      setDisabling((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
    }
  };

  const showEmpty =
    entries.length === 0 &&
    globalSessions.length === 0 &&
    helperStatus.state !== "failed";

  return (
    <>
      <div
        onClick={close}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 30,
          animation: "fs-fade-in .18s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: 460,
          maxWidth: "92vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 31,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
          fontFamily: FONT_SANS,
        }}
      >
        <header
          style={{
            padding: "16px 18px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Eyebrow t={t}>Port forwards</Eyebrow>
            <div
              style={{
                marginTop: 2,
                fontSize: FS_MD,
                fontWeight: 600,
                color: t.text,
              }}
            >
              {entries.length} active
              {globalSessions.length > 0 && (
                <span style={{ color: t.textDim, fontWeight: 400 }}>
                  {" · "}
                  {globalSessions.length} global
                </span>
              )}
            </div>
          </div>
          {helperStatus.state !== "not_started" && (
            <HelperBadge t={t} status={helperStatus} />
          )}
          <Btn
            t={t}
            variant={showNew ? "primary" : "secondary"}
            size="sm"
            onClick={() => setShowNew((v) => !v)}
          >
            {showNew ? "Close" : "+ New"}
          </Btn>
          <IconBtn t={t} title="Close (Esc)" onClick={close}>
            {Icons.close}
          </IconBtn>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {showNew && <NewForwardForm t={t} onDone={() => setShowNew(false)} />}
          {showEmpty && !showNew ? (
            <EmptyState
              t={t}
              title="No active port-forwards"
              hint="Open a Service / Pod / Deployment detail panel and click the forward chip on a port to start one — or use + New above."
            />
          ) : (
            <>
              {grouped.map(([clusterId, items]) => (
                <ClusterGroup
                  key={clusterId}
                  t={t}
                  title={clusterLabel(clusterId)}
                  entries={items}
                  onStop={onStop}
                  onPinToggle={onPinToggle}
                  onCopy={onCopy}
                  onOpen={onOpen}
                />
              ))}
              {(globalSessions.length > 0 || helperStatus.state === "failed") && (
                <GlobalSection
                  t={t}
                  sessions={globalSessions}
                  helperStatus={helperStatus}
                  disabling={disabling}
                  onDisable={onDisableGlobal}
                  onCopyText={onCopyText}
                  onOpenHost={onOpenHost}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function ClusterGroup({
  t,
  title,
  entries,
  onStop,
  onPinToggle,
  onCopy,
  onOpen,
}: {
  t: Tokens;
  title: string;
  entries: ForwardEntry[];
  onStop: (id: string) => void;
  onPinToggle: (e: ForwardEntry) => void;
  onCopy: (e: ForwardEntry) => void;
  onOpen: (e: ForwardEntry) => void;
}) {
  return (
    <div>
      <div
        style={{
          padding: "10px 18px 6px",
          background: t.surfaceAlt,
          borderTop: `1px solid ${t.borderSoft}`,
          borderBottom: `1px solid ${t.borderSoft}`,
          fontSize: FS_XS,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: t.textMuted,
          fontFamily: FF_MONO,
        }}
      >
        {title}
      </div>
      {entries.map((e) => (
        <Row
          key={e.spec.id}
          t={t}
          entry={e}
          onStop={() => onStop(e.spec.id)}
          onPinToggle={() => onPinToggle(e)}
          onCopy={() => onCopy(e)}
          onOpen={() => onOpen(e)}
        />
      ))}
    </div>
  );
}

function Row({
  t,
  entry,
  onStop,
  onPinToggle,
  onCopy,
  onOpen,
}: {
  t: Tokens;
  entry: ForwardEntry;
  onStop: () => void;
  onPinToggle: () => void;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const live =
    entry.status.kind === "listening" || entry.status.kind === "active";
  const { dot, label, reason } = statusDisplay(t, entry.status);
  const tgt = entry.spec.target;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 18px",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <Tooltip label={label}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dot,
            marginTop: 6,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: FS_MD,
            fontFamily: FF_MONO,
            color: t.text,
            wordBreak: "break-all",
          }}
        >
          <span style={{ color: t.textDim }}>{tgt.kind}</span>{" "}
          {tgt.namespace}/{tgt.name}{" "}
          <span style={{ color: t.textMuted }}>:{entry.spec.remote_port}</span>
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: FS_SM,
            fontFamily: FF_MONO,
            color: t.textDim,
          }}
        >
          → 127.0.0.1:{entry.actual_local_port}
          {entry.spec.autostart && (
            <span style={{ marginLeft: 8, color: t.accent }}>· pinned</span>
          )}
        </div>
        {reason && (
          <div style={{ marginTop: 4 }}>
            <ErrorBlock
              t={t}
              message={reason}
              kindLabel="port forward"
              verb="stream"
              inline
            />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <IconBtn
          t={t}
          title={
            live
              ? `Open http://127.0.0.1:${entry.actual_local_port} in browser`
              : "Forward not active"
          }
          onClick={live ? onOpen : () => {}}
        >
          {Icons.external}
        </IconBtn>
        <IconBtn t={t} title="Copy local address" onClick={onCopy}>
          {Icons.copy}
        </IconBtn>
        <IconBtn
          t={t}
          title={entry.spec.autostart ? "Unpin (drop on next launch)" : "Pin (auto-start on launch)"}
          onClick={onPinToggle}
        >
          {Icons.pin}
        </IconBtn>
        <IconBtn t={t} title="Stop forward" onClick={onStop}>
          {Icons.close}
        </IconBtn>
      </div>
    </div>
  );
}

function statusDisplay(
  t: Tokens,
  s: ForwardStatus,
): { dot: string; label: string; reason: string | null } {
  switch (s.kind) {
    case "listening":
      return { dot: t.info, label: "Listening", reason: null };
    case "active":
      return { dot: t.good, label: "Active", reason: null };
    case "reconnecting":
      return { dot: t.warn, label: "Reconnecting", reason: s.reason };
    case "failed":
      return { dot: t.bad, label: "Failed", reason: s.reason };
    case "stopped":
      return { dot: t.textMuted, label: "Stopped", reason: null };
  }
}

// ── Global (DNS) forwards ───────────────────────────────────────────────────

function HelperBadge({ t, status }: { t: Tokens; status: HelperStatus }) {
  const failed = status.state === "failed";
  const color = failed ? t.bad : t.good;
  const label = failed ? "helper failed" : "helper running";
  const tip = failed
    ? status.message
    : "Privileged helper is running (loopback aliases + /etc/hosts).";
  return (
    <Tooltip label={tip}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: FS_XS,
          fontFamily: FF_MONO,
          color,
          border: `1px solid ${color}`,
          borderRadius: 999,
          padding: "2px 8px",
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: "50%", background: color }}
        />
        {label}
      </span>
    </Tooltip>
  );
}

function GlobalSection({
  t,
  sessions,
  helperStatus,
  disabling,
  onDisable,
  onCopyText,
  onOpenHost,
}: {
  t: Tokens;
  sessions: GlobalForwardSession[];
  helperStatus: HelperStatus;
  disabling: Record<string, boolean>;
  onDisable: (id: string) => void;
  onCopyText: (text: string) => void;
  onOpenHost: (hostname: string, port: number) => void;
}) {
  return (
    <div data-testid="global-forwards-section">
      <div
        style={{
          padding: "10px 18px 6px",
          background: t.surfaceAlt,
          borderTop: `1px solid ${t.borderSoft}`,
          borderBottom: `1px solid ${t.borderSoft}`,
          fontSize: FS_XS,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: t.textMuted,
          fontFamily: FF_MONO,
        }}
      >
        Global · DNS forwards
      </div>
      {helperStatus.state === "failed" && (
        <div style={{ padding: "10px 18px" }}>
          <ErrorBlock
            t={t}
            message={helperStatus.message}
            kindLabel="privileged helper"
            inline
          />
        </div>
      )}
      {sessions.map((s) => (
        <GlobalSessionCard
          key={s.id}
          t={t}
          session={s}
          busy={!!disabling[s.id]}
          onDisable={() => onDisable(s.id)}
          onCopyText={onCopyText}
          onOpenHost={onOpenHost}
        />
      ))}
    </div>
  );
}

function GlobalSessionCard({
  t,
  session,
  busy,
  onDisable,
  onCopyText,
  onOpenHost,
}: {
  t: Tokens;
  session: GlobalForwardSession;
  busy: boolean;
  onDisable: () => void;
  onCopyText: (text: string) => void;
  onOpenHost: (hostname: string, port: number) => void;
}) {
  return (
    <div style={{ borderBottom: `1px solid ${t.borderSoft}` }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "10px 18px 4px",
        }}
      >
        <div style={{ fontSize: FS_SM, fontFamily: FF_MONO, color: t.text }}>
          ns/<b>{session.namespace}</b>{" "}
          <span style={{ color: t.textMuted }}>· {session.services.length} svc</span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onDisable}
          style={{
            fontSize: FS_XS,
            fontFamily: FF_MONO,
            color: busy ? t.textMuted : t.bad,
            background: "transparent",
            border: `1px solid ${busy ? t.borderSoft : t.bad}`,
            borderRadius: 6,
            padding: "2px 8px",
            cursor: busy ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {busy ? "Disabling…" : "Disable"}
        </button>
      </div>
      {session.services.map((svc) => (
        <div key={svc.name} style={{ padding: "4px 18px 10px" }}>
          <div style={{ fontSize: FS_SM, fontFamily: FF_MONO, color: t.text }}>
            {svc.name}{" "}
            <span style={{ color: t.textMuted }}>
              {svc.local_ip}:{svc.ports.join(",")}
            </span>
          </div>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}
          >
            {svc.hostnames.map((h) => (
              <HostnameChip
                key={h}
                t={t}
                hostname={h}
                openPort={svc.ports[0] ?? null}
                onCopy={onCopyText}
                onOpen={onOpenHost}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One forwarded in-cluster hostname, rendered as a split chip: the name itself
 * (click → copy) plus, when the service exposes a port, an open-in-browser
 * segment (↗ → `http://<hostname>:<port>`) — mirroring the classic forward
 * row's Copy + Open actions. `openPort` is the service's first port; multi-port
 * services open that one (the operator can copy the name to reach the others).
 */
function HostnameChip({
  t,
  hostname,
  openPort,
  onCopy,
  onOpen,
}: {
  t: Tokens;
  hostname: string;
  openPort: number | null;
  onCopy: (hostname: string) => void;
  onOpen: (hostname: string, port: number) => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        overflow: "hidden",
        background: t.surfaceAlt,
      }}
    >
      <button
        type="button"
        title="Copy hostname"
        onClick={() => onCopy(hostname)}
        style={{
          fontSize: FS_XS,
          fontFamily: FF_MONO,
          color: t.textDim,
          background: "transparent",
          border: "none",
          padding: "1px 6px",
          cursor: "pointer",
        }}
      >
        {hostname}
      </button>
      {openPort != null && (
        <button
          type="button"
          title={`Open http://${hostname}:${openPort} in browser`}
          aria-label={`Open ${hostname} in browser`}
          onClick={() => onOpen(hostname, openPort)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: t.textMuted,
            background: "transparent",
            border: "none",
            borderLeft: `1px solid ${t.borderSoft}`,
            padding: "0 5px",
            cursor: "pointer",
          }}
        >
          {Icons.external}
        </button>
      )}
    </span>
  );
}
