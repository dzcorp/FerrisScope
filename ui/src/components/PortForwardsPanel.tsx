import { useEffect, useMemo } from "react";
import { api } from "../api";
import { useAppStore } from "../store";
import { tokens, FONT_MONO, FONT_SANS, type ThemeMode, type Tokens } from "../theme";
import type { ForwardEntry, ForwardStatus } from "../types";
import { Eyebrow, IconBtn, Icons, EmptyState, Tooltip } from "./ui";
import { toast } from "../lib/dialog";

type Props = { mode: ThemeMode };

// Right-side slide-over listing every active port-forward, grouped by cluster.
// Same chrome as NotificationsPanel: scrim + slide-from-right + Esc to close.
// Each row offers stop, copy URL, and pin/unpin (autostart toggle).
export function PortForwardsPanel({ mode }: Props) {
  const t = tokens(mode);
  const open = useAppStore((s) => s.forwardsOpen);
  const close = useAppStore((s) => s.closeForwardsPanel);
  const forwards = useAppStore((s) => s.forwards);
  const removeForward = useAppStore((s) => s.removeForward);
  const upsertForward = useAppStore((s) => s.upsertForward);
  const contexts = useAppStore((s) => s.contexts);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Display name for a cluster id — fall back to the raw id if the context
  // has been removed since the forward was started (orphaned listener path
  // handled by backend cleanup, but we still want to show the in-memory
  // entry until the status event arrives).
  const clusterLabel = useMemo(() => {
    const map = new Map(contexts.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? id;
  }, [contexts]);

  const entries = useMemo(() => Object.values(forwards), [forwards]);
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
                fontSize: 13.5,
                fontWeight: 600,
                color: t.text,
              }}
            >
              {entries.length} active
            </div>
          </div>
          <IconBtn t={t} title="Close (Esc)" onClick={close}>
            {Icons.close}
          </IconBtn>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {entries.length === 0 ? (
            <EmptyState
              t={t}
              title="No active port-forwards"
              hint="Open a Service / Pod / Deployment detail panel and click the forward chip on a port to start one."
            />
          ) : (
            grouped.map(([clusterId, items]) => (
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
            ))
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
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: t.textMuted,
          fontFamily: FONT_MONO,
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
            fontSize: 12.5,
            fontFamily: FONT_MONO,
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
            fontSize: 11,
            fontFamily: FONT_MONO,
            color: t.textDim,
          }}
        >
          → 127.0.0.1:{entry.actual_local_port}
          {entry.spec.autostart && (
            <span style={{ marginLeft: 8, color: t.accent }}>· pinned</span>
          )}
        </div>
        {reason && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: t.bad,
              fontFamily: FONT_MONO,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {reason}
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
