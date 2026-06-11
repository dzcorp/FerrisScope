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
import {
  type Tokens,
  FF_MONO,
  R_SM,
  FS_SM,
  hexWithAlpha,
  tintPair,
  tokensAreDark,
} from "../../theme";
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
  // Hover only drives the idle affordance's fill — it's a call-to-action, so
  // it brightens to accentSoft on hover to read as a clickable button.
  const [hover, setHover] = useState(false);

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
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={chipButton(t, null, busy, hover)}
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
  // The whole chip is tinted by the forward's status color so an active
  // tunnel reads at a glance: active → good (green), listening → info
  // (blue), reconnecting → warn (amber, pulsing), failed → bad (red).
  const tone = failed
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
        style={chipButton(t, tone, busy)}
      >
        <span
          aria-hidden
          className={reconnecting ? "fs-pulse-dot" : undefined}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: tone,
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

// `tone` is the status color for an existing forward (good/info/warn/bad),
// or `null` for the idle "start a forward" affordance. A live chip paints
// its border + text in the tone and floods the background with a 16% tint
// of the same color so the running tunnel stands out. The idle chip is a
// call-to-action: it wears the brand accent (border + text) so the operator
// can spot where to port-forward, and fills with accentSoft on hover.
function chipButton(t: Tokens, tone: string | null, busy: boolean, hover = false) {
  if (tone === null) {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      fontSize: FS_SM,
      padding: "1px 7px",
      borderRadius: R_SM,
      border: `1px solid ${hover ? t.accent : hexWithAlpha(t.accent, 0.45)}`,
      background: hover ? t.accentSoft : "transparent",
      color: t.accent,
      fontWeight: 600,
      cursor: busy ? "wait" : "pointer",
      fontFamily: "inherit",
      opacity: busy ? 0.6 : 1,
    } as const;
  }
  // Live chip: tinted fill + a foreground that statusFill's rule keeps legible
  // (raw tone in dark mode, darkened in light mode so amber/green don't wash
  // out on their own pale tint). The border keeps the full-saturation tone.
  const fill = tintPair(tone, tokensAreDark(t));
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: FS_SM,
    padding: "1px 7px",
    borderRadius: R_SM,
    border: `1px solid ${tone}`,
    background: fill.bg,
    color: fill.fg,
    fontWeight: 600,
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
