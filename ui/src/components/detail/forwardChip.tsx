// Per-port "start a forward" affordance. Used inside Service / Pod /
// Deployment / StatefulSet / DaemonSet detail panels next to every port the
// operator might want to tunnel locally.
//
// Three visible states:
//   - idle  → hollow chip with the forward icon. Click → start an ephemeral
//             forward (autostart=false). Backend dedupes by (cluster, target,
//             remote_port) so a duplicate click against an already-running
//             forward just returns the same entry.
//   - busy  → request in-flight; chip is disabled.
//   - live  → solid chip with the bound local port; click → stop. The pin
//             icon next to it toggles persistence.
//
// Reads from the global forwards map so two detail panels showing the same
// port stay in lockstep without prop-drilling.

import { useState } from "react";
import { api } from "../../api";
import { useAppStore } from "../../store";
import { type Tokens, FF_MONO, R_SM, FS_SM } from "../../theme";
import type { ForwardTarget } from "../../types";
import { toast } from "../../lib/dialog";
import { Icons, Tooltip } from "../ui";

type Props = {
  t: Tokens;
  clusterId: string;
  target: ForwardTarget;
  remotePort: number;
  // UDP and SCTP are not portforward-able — call sites should hide the chip
  // for those, but we double-check here so a misconfigured caller can't
  // wedge the backend.
  protocol?: string | null;
};

export function ForwardChip({ t, clusterId, target, remotePort, protocol }: Props) {
  const id = forwardId(clusterId, target, remotePort);
  const entry = useAppStore((s) => s.forwards[id]);
  const upsertForward = useAppStore((s) => s.upsertForward);
  const removeForward = useAppStore((s) => s.removeForward);
  const [busy, setBusy] = useState(false);

  if (protocol && protocol.toUpperCase() !== "TCP") {
    return null;
  }

  const onStart = async () => {
    setBusy(true);
    try {
      const ent = await api.pfStart(clusterId, target, remotePort, null, false);
      upsertForward(ent);
      toast.ok(`Forwarding ${target.kind} ${target.name}:${remotePort} → 127.0.0.1:${ent.actual_local_port}`);
    } catch (e) {
      toast.bad(`Forward failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      await api.pfStop(id);
      removeForward(id);
    } catch (e) {
      toast.bad(`Stop failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onTogglePin = async () => {
    if (!entry) return;
    setBusy(true);
    const next = !entry.spec.autostart;
    try {
      await api.pfSetAutostart(id, next);
      upsertForward({ ...entry, spec: { ...entry.spec, autostart: next } });
    } catch (e) {
      toast.bad(`Pin toggle failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!entry) {
    return (
      <Tooltip
        label={`Forward ${target.kind} ${target.name}:${remotePort} to a local port`}
      >
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          style={chipButton(t, false, busy)}
        >
          <span style={{ display: "inline-flex" }}>{Icons.forward}</span>
          <span style={{ fontFamily: FF_MONO }}>forward</span>
        </button>
      </Tooltip>
    );
  }

  const live = entry.status.kind === "listening" || entry.status.kind === "active";
  const reconnecting = entry.status.kind === "reconnecting";
  const failed = entry.status.kind === "failed";
  const dot = failed
    ? t.bad
    : reconnecting
      ? t.warn
      : entry.status.kind === "active"
        ? t.good
        : t.info;

  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <Tooltip
        label={
          failed
            ? `Failed: ${entry.status.kind === "failed" ? entry.status.reason : ""}`
            : `Listening on 127.0.0.1:${entry.actual_local_port} — click to stop`
        }
      >
      <button
        type="button"
        onClick={onStop}
        disabled={busy || !live}
        style={chipButton(t, true, busy)}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dot,
            display: "inline-block",
          }}
        />
        <span style={{ fontFamily: FF_MONO }}>
          :{entry.actual_local_port}
        </span>
      </button>
      </Tooltip>
      {live && (
        <Tooltip label={`Open http://127.0.0.1:${entry.actual_local_port} in browser`}>
        <button
          type="button"
          onClick={() =>
            api
              .openExternal(`http://127.0.0.1:${entry.actual_local_port}`)
              .catch((e) => toast.bad(`Open failed: ${String(e)}`))
          }
          disabled={busy}
          style={iconButton(t, busy)}
        >
          {Icons.external}
        </button>
        </Tooltip>
      )}
      <Tooltip
        label={entry.spec.autostart ? "Pinned — click to unpin" : "Pin (auto-start on launch)"}
      >
      <button
        type="button"
        onClick={onTogglePin}
        disabled={busy}
        style={{
          border: `1px solid ${t.borderSoft}`,
          background: entry.spec.autostart ? t.accentSoft : "transparent",
          color: entry.spec.autostart ? t.accent : t.textMuted,
          borderRadius: R_SM,
          padding: "1px 4px",
          cursor: busy ? "not-allowed" : "pointer",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        {Icons.pin}
      </button>
      </Tooltip>
    </span>
  );
}

function iconButton(t: Tokens, busy: boolean) {
  return {
    border: `1px solid ${t.borderSoft}`,
    background: "transparent",
    color: t.textMuted,
    borderRadius: R_SM,
    padding: "1px 4px",
    cursor: busy ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
  } as const;
}

function chipButton(t: Tokens, live: boolean, busy: boolean) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: FS_SM,
    padding: "1px 7px",
    borderRadius: R_SM,
    border: `1px solid ${live ? t.accent : t.borderSoft}`,
    background: live ? t.accentSoft : "transparent",
    color: live ? t.accent : t.textDim,
    fontWeight: 500,
    cursor: busy ? "wait" : "pointer",
    fontFamily: "inherit",
    opacity: busy ? 0.6 : 1,
  } as const;
}

// Mirror of `portforwards::make_id` on the backend so the UI can look up an
// entry without round-tripping. Keep these two in lockstep.
export function forwardId(clusterId: string, target: ForwardTarget, remotePort: number): string {
  return `${clusterId}::${target.kind}/${target.namespace}/${target.name}:${remotePort}`;
}
