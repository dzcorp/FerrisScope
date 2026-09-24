// Per-port "start a forward" affordance. Used inside Service / Pod /
// Deployment / StatefulSet / DaemonSet detail panels next to every port the
// operator might want to tunnel locally.
//
// Visible states:
//   - idle  → hollow chip with the forward icon. Click → start an ephemeral
//             forward on an OS-picked local port (autostart=false). Backend
//             dedupes by (cluster, target, remote_port) so a duplicate click
//             against an already-running forward just returns the same entry.
//             The caret beside it opens `pick`.
//   - pick  → inline local-port input. Enter / ✓ starts on that port (empty =
//             auto); Esc / × returns to idle. The typed port is pre-checked
//             (`pfCheckLocalPort`); a clash says why and offers a free port.
//   - busy  → request in-flight; chip is disabled.
//   - live  → solid chip with the bound local port; click → stop. The pin
//             icon next to it toggles persistence.
//
// Reads from the global forwards map so two detail panels showing the same
// port stay in lockstep without prop-drilling.

import { useEffect, useState, type KeyboardEvent } from "react";
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
import type { ForwardEntry, ForwardTarget, LocalPortCheck } from "../../types";
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
  // Per-segment hover: the hovered half fills with accentSoft, the group border brightens.
  const [hover, setHover] = useState<"main" | "pick" | "ok" | "cancel" | "suggest" | null>(null);
  const [picking, setPicking] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [check, setCheck] = useState<LocalPortCheck | null>(null);
  const heldBy = useAppStore((s) => (check?.held_by ? s.forwards[check.held_by] : undefined));
  const hasEntry = entry != null;
  useEffect(() => {
    if (hasEntry) setPicking(false);
  }, [hasEntry]);

  const draftPort = picking ? parseLocalPort(portDraft) : null;
  useEffect(() => {
    if (typeof draftPort !== "number") return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .pfCheckLocalPort(draftPort)
        .then((c) => current && setCheck(c))
        .catch(() => undefined);
    }, CHECK_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draftPort]);

  if (protocol && protocol.toUpperCase() !== "TCP") {
    return null;
  }

  const onStart = async (localPort: number | null = null) => {
    setBusy(true);
    try {
      const ent = await api.pfStart(clusterId, target, remotePort, localPort, false);
      upsertForward(ent);
      setPicking(false);
      toast.ok(`Forwarding ${target.kind} ${target.name}:${remotePort} → 127.0.0.1:${ent.actual_local_port}`);
    } catch (e) {
      // Lost a race for the port since the pre-check: show why inline instead.
      const recheck =
        localPort === null ? null : await api.pfCheckLocalPort(localPort).catch(() => null);
      if (recheck && recheck.probe.kind !== "free") setCheck(recheck);
      else toast.bad(`Forward failed: ${String(e)}`);
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

  if (!entry && picking) {
    const localPort = draftPort;
    const invalid = localPort === undefined;
    const issue: PortIssue | null = invalid
      ? { tone: "bad", blocking: true, title: "Enter a port from 1 to 65535" }
      : check && check.port === localPort
        ? portIssue(check, heldBy)
        : null;
    const blocked = invalid || issue?.blocking === true;
    const suggestion = issue && !invalid ? check?.suggestion ?? null : null;
    const submit = () => {
      if (!blocked && !busy) void onStart(localPort);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        // Swallow before the drawer's Esc layer so only the picker closes.
        e.preventDefault();
        setPicking(false);
      }
    };
    const toneColor = issue ? (issue.tone === "bad" ? t.bad : t.warn) : undefined;
    return (
      <span
        style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}
      >
        <span style={splitGroup(t, true, toneColor)}>
          <label style={{ ...segment(t, false, false), cursor: "text" }}>
            <input
              type="text"
              inputMode="numeric"
              aria-label="Local port"
              aria-invalid={blocked}
              placeholder="auto"
              autoFocus
              value={portDraft}
              disabled={busy}
              onChange={(e) => setPortDraft(e.target.value.trim())}
              onFocus={(e) => e.target.select()}
              onKeyDown={onKeyDown}
              style={portInput(t, toneColor)}
            />
          </label>
          <Tooltip
            label={localPort == null ? "Start on an automatic port" : `Start on local port ${localPort}`}
          >
            <button
              type="button"
              aria-label="Start forward"
              onClick={submit}
              disabled={busy || blocked}
              onMouseEnter={() => setHover("ok")}
              onMouseLeave={() => setHover(null)}
              style={segment(t, hover === "ok" && !blocked, true, busy || blocked)}
            >
              {Icons.check}
            </button>
          </Tooltip>
          <Tooltip label="Cancel">
            <button
              type="button"
              aria-label="Cancel"
              onClick={() => setPicking(false)}
              disabled={busy}
              onMouseEnter={() => setHover("cancel")}
              onMouseLeave={() => setHover(null)}
              style={{ ...segment(t, hover === "cancel", true, busy), color: t.textMuted }}
            >
              {Icons.close}
            </button>
          </Tooltip>
        </span>
        {/* Always mounted so screen readers announce the text when it appears. */}
        <span role="status" aria-live="polite" style={{ display: "contents" }}>
          {issue && toneColor && (
            <span style={callout(t, toneColor)}>
              <span aria-hidden style={{ display: "inline-flex", flexShrink: 0, marginTop: 1 }}>
                {issue.tone === "bad" ? Icons.error : Icons.warn}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{issue.title}</span>
                {issue.detail && <span style={{ color: t.textMuted }}>{issue.detail}</span>}
              </span>
              {suggestion !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setPortDraft(String(suggestion));
                    void onStart(suggestion);
                  }}
                  disabled={busy}
                  onMouseEnter={() => setHover("suggest")}
                  onMouseLeave={() => setHover(null)}
                  style={{
                    ...segment(t, hover === "suggest", false, busy),
                    ...splitGroup(t, hover === "suggest"),
                    // segment's borderLeft would otherwise strip the pill's left edge.
                    borderLeft: splitGroup(t, hover === "suggest").border,
                    alignItems: "center",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  Use {suggestion}
                </button>
              )}
            </span>
          )}
        </span>
      </span>
    );
  }

  if (!entry) {
    return (
      <span style={splitGroup(t, hover !== null)}>
        <Tooltip
          label={`Forward ${target.kind} ${target.name}:${remotePort} to an automatic local port`}
        >
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={busy}
            onMouseEnter={() => setHover("main")}
            onMouseLeave={() => setHover(null)}
            style={segment(t, hover === "main", false, busy)}
          >
            <span style={{ display: "inline-flex" }}>{Icons.forward}</span>
            <span>forward</span>
          </button>
        </Tooltip>
        <Tooltip label="Forward to a chosen local port">
          <button
            type="button"
            aria-label="Pick local port"
            onClick={() => {
              setPortDraft(String(remotePort));
              setCheck(null);
              setPicking(true);
              setHover(null);
            }}
            disabled={busy}
            onMouseEnter={() => setHover("pick")}
            onMouseLeave={() => setHover(null)}
            style={{ ...segment(t, hover === "pick", true, busy), padding: "0 5px" }}
          >
            {Icons.chevD}
          </button>
        </Tooltip>
      </span>
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

const CHECK_DEBOUNCE_MS = 150;

export type PortIssue = {
  tone: "warn" | "bad";
  // Blocking issues disable start; a shadowed port only warns.
  blocking: boolean;
  title: string;
  detail?: string;
};

// What's wrong with a checked port, or null when it's free.
export function portIssue(check: LocalPortCheck, other?: ForwardEntry): PortIssue | null {
  const port = check.port;
  if (check.held_by) {
    return {
      tone: "warn",
      blocking: true,
      title: `Port ${port} is already forwarded`,
      detail: other
        ? `${other.spec.target.kind} ${other.spec.target.name}:${other.spec.remote_port} is using it.`
        : "Another FerrisScope forward is using it.",
    };
  }
  switch (check.probe.kind) {
    case "free":
      return null;
    case "in_use":
      return {
        tone: "warn",
        blocking: true,
        title: `Port ${port} is in use`,
        detail: "Another app on this machine is listening on it.",
      };
    case "shadowed":
      return {
        tone: "warn",
        blocking: false,
        title: `Port ${port} is shared`,
        detail: `Another app listens on ${check.probe.addr}; localhost:${port} may reach it instead.`,
      };
    case "permission_denied":
      return {
        tone: "bad",
        blocking: true,
        title: port < 1024 ? `Port ${port} needs admin rights` : `Port ${port} is reserved by the system`,
        detail: port < 1024 ? "Ports below 1024 are privileged." : undefined,
      };
    case "error":
      return { tone: "bad", blocking: true, title: `Can't use port ${port}`, detail: check.probe.message };
  }
}

function callout(t: Tokens, tone: string) {
  const fill = tintPair(tone, tokensAreDark(t));
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    maxWidth: 340,
    padding: "4px 6px 4px 7px",
    background: fill.bg,
    border: `1px solid ${hexWithAlpha(tone, 0.4)}`,
    borderRadius: R_SM,
    color: fill.fg,
    fontSize: FS_SM,
    lineHeight: 1.35,
  } as const;
}

// "" → null (auto); a TCP port → number; anything else → undefined (invalid).
export function parseLocalPort(raw: string): number | null | undefined {
  if (raw === "") return null;
  if (!/^\d{1,5}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : undefined;
}

// Idle / picker affordance: one accent-bordered pill split into segments.
function splitGroup(t: Tokens, hot: boolean, tone?: string) {
  const edge = tone ?? (hot ? t.accent : hexWithAlpha(t.accent, 0.45));
  return {
    display: "inline-flex",
    alignItems: "stretch",
    border: `1px solid ${edge}`,
    borderRadius: R_SM,
    overflow: "hidden",
    fontSize: FS_SM,
    fontFamily: FF_MONO,
  } as const;
}

function segment(t: Tokens, hover: boolean, divided: boolean, busy = false) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "1px 7px",
    border: "none",
    borderLeft: divided ? `1px solid ${hexWithAlpha(t.accent, 0.45)}` : "none",
    background: hover ? t.accentSoft : "transparent",
    color: t.accent,
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: 600,
    cursor: busy ? "not-allowed" : "pointer",
    opacity: busy ? 0.6 : 1,
  } as const;
}

function portInput(t: Tokens, tone?: string) {
  return {
    width: "6ch",
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: 600,
    background: "transparent",
    color: tone ?? t.text,
    border: "none",
    padding: 0,
    outline: "none",
  } as const;
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

// `tone` is the status color of an existing forward (good/info/warn/bad).
function chipButton(t: Tokens, tone: string, busy: boolean) {
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
