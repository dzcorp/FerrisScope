import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ConnectHint } from "../types";
import type { Tokens } from "../theme";
import { FS_SM } from "../theme";
import { Btn, Chip, Select } from "./ui";
import { Copyable, Mono } from "./detail/primitives";

/// PTY frames arrive base64-encoded, same as the Dock's terminal. Decoded as
/// UTF-8 so gcloud's URL line survives; a frame that splits a multi-byte
/// sequence degrades to a replacement char rather than throwing.
function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Small amber note under a failed connect, shown when the backend recognises the
// cause as a cloud-credential problem. Two of them today:
//
//   * identity drift — a context whose exec entry pins no account/profile, so it
//     authenticates as whichever identity the cloud CLI last selected, and that
//     changes under the operator. Remedy: a pin.
//   * a lapsed session — the credential plugin could not mint a token at all
//     because the provider wants an identity challenge. Remedy: an interactive
//     login, which `hint.reauth` describes and the Log in button runs.
//
// The two are mutually exclusive, and which one arrives is the backend's call.
//
// Provider-neutral by construction. Every string that differs between GKE, EKS
// and AKS (the noun, the prose, what a pin would write) arrives in the hint;
// this file only knows how to lay it out. Notably `hint.pin` is null for Azure,
// because kubelogin has no per-context account flag — the note then explains the
// `az` command instead of offering a button that would write the wrong thing.
//
// All the judgement lives in Rust (`cloud_identity::hint_for_context`) — this
// renders whatever comes back and renders nothing when the answer is null, which
// is the case for every other kind of connect failure.
export function CloudIdentityNote({
  t,
  contextId,
  reason,
  onReconnect,
}: {
  t: Tokens;
  /// Composite context id (e.g. "default::prod") — the same value passed to
  /// connect. The backend extracts the context name from it.
  contextId: string;
  /// The connect error, verbatim. The backend parses the authenticated identity
  /// out of it, so it must not be pre-cleaned.
  reason: string;
  /// Called once the note has fixed the cause — a successful pin, or a login
  /// that renewed a lapsed session — so the caller can retry the connection.
  /// The same callback the enclosing banner's Reconnect button uses, which is
  /// why this note offers no retry of its own.
  onReconnect: () => void;
}) {
  const [hint, setHint] = useState<ConnectHint | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginLog, setLoginLog] = useState("");
  // Held so the operator can abandon a login that is going nowhere — gcloud can
  // sit on a question this surface has no way to answer, and the note offers no
  // input. Closing kills the PTY child.
  const loginSessionRef = useRef<string | null>(null);
  // The pin outlives the hint effect's own `live` flag: it can still be in
  // flight when the operator switches cluster and unmounts this note. Guard its
  // settle handlers with a mount flag so a resolved (or rejected) pin doesn't
  // write state into a torn-down component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setHint(null);
    setIdentity(null);
    setConfirming(false);
    setPinError(null);
    setLoggingIn(false);
    setLoginLog("");
    loginSessionRef.current = null;
    api
      .connectHint(contextId, reason)
      .then((h) => {
        if (!live) return;
        setHint(h);
        // Preselect the active identity — the most likely intent is "make this
        // context always use the one I'm on right now".
        //
        // Clamped to something the picker actually lists. For gcloud the two
        // fields come from different places: `identities` is the
        // `legacy_credentials/` directory listing, `active_identity` is
        // `[core] account` from the configuration file. `gcloud auth revoke`
        // removes the former and leaves the latter, so the active account can
        // name a credential that no longer exists. Unclamped, the <select>
        // would render blank (no matching option) while the enabled Pin button
        // wrote that invisible account into the kubeconfig — leaving the
        // context strictly worse off than the 403 it started with.
        const offered = h?.identities ?? [];
        const active = h?.active_identity;
        setIdentity(
          (active && offered.includes(active) ? active : offered[0]) ?? null,
        );
      })
      .catch(() => {
        // A failed hint lookup must never replace the real connect error.
        if (live) setHint(null);
      });
    return () => {
      live = false;
    };
  }, [contextId, reason]);

  if (!hint) return null;

  const pin = hint.pin;

  // Renew a lapsed session in one of our PTYs. gcloud opens a browser, writes a
  // line or two, and exits; on a clean exit we reconnect for the operator, which
  // is the only reason they were looking at this note.
  const doLogin = () => {
    const reauth = hint.reauth;
    if (!reauth || loggingIn) return;
    setLoggingIn(true);
    setLoginLog("");
    let opened: { sessionId: string; close: () => void } | null = null;
    api
      .cloudLoginOpen(
        contextId,
        reauth.account,
        (b64) => {
          if (!mountedRef.current) return;
          // Tail only: this is a progress surface, not a terminal, and gcloud's
          // browser-launch line is the part worth seeing.
          setLoginLog((prev) => (prev + decodeB64(b64)).slice(-2000));
        },
        (code) => {
          if (!mountedRef.current) return;
          setLoggingIn(false);
          const sessionId = loginSessionRef.current;
          loginSessionRef.current = null;
          opened?.close();
          // Detaching the channel is not enough: the backend keeps the session
          // in its registry until told otherwise, and while any entry remains
          // the terminal token slot is never reclaimed (and this gcloud child is
          // never reaped). The exit frame means the process is gone, so this is
          // bookkeeping, not a kill.
          if (sessionId) void api.terminalClose(sessionId).catch(() => {});
          if (code === 0) onReconnect();
          else
            setLoginLog(
              (prev) => `${prev}\n[gcloud exited with code ${code}]`.trim(),
            );
        },
      )
      .then((session) => {
        opened = session;
        loginSessionRef.current = session.sessionId;
        // The note can unmount mid-login (cluster switch, or a reconnect that
        // succeeded from another path). Close the session rather than only
        // detaching, so the registry doesn't keep an entry no one can reach.
        if (!mountedRef.current) {
          session.close();
          loginSessionRef.current = null;
          void api.terminalClose(session.sessionId).catch(() => {});
        }
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        setLoggingIn(false);
        loginSessionRef.current = null;
        setLoginLog(String(e));
      });
  };

  const cancelLogin = () => {
    const sessionId = loginSessionRef.current;
    setLoggingIn(false);
    loginSessionRef.current = null;
    if (!sessionId) return;
    // Fire and forget: the exit frame that follows is ignored because
    // `loggingIn` is already false, and a failed close leaves a PTY the backend
    // reaps with the cluster anyway.
    void api.terminalClose(sessionId).catch(() => {});
  };

  const doPin = () => {
    if (!identity) return;
    setPinning(true);
    setPinError(null);
    api
      .pinCloudIdentity(contextId, identity)
      .then(() => {
        if (!mountedRef.current) return;
        setConfirming(false);
        onReconnect();
      })
      .catch((e: unknown) => {
        if (mountedRef.current) setPinError(String(e));
      })
      .finally(() => {
        if (mountedRef.current) setPinning(false);
      });
  };

  return (
    <div
      role="note"
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: "var(--fs-radius-md, 6px)",
        background: t.warnSoft,
        border: `1px solid ${t.warn}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: FS_SM,
      }}
    >
      <div style={{ color: t.warn, fontWeight: 600 }}>{hint.title}</div>
      <div style={{ color: t.text }}>{hint.detail}</div>

      {hint.authenticated_as && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: t.textDim }}>apiserver saw</span>
          <Chip t={t} tone="warn" mono>
            {hint.authenticated_as}
          </Chip>
          {hint.active_identity && (
            <>
              <span style={{ color: t.textDim }}>· CLI active</span>
              <Chip t={t} mono>
                {hint.active_identity}
              </Chip>
            </>
          )}
        </div>
      )}

      {/* A lapsed cloud session, not identity drift: nothing for a pin to write.
          The button runs the login in one of our own PTYs, which is the whole
          reason the failure exists — gcloud will not perform an identity
          challenge without a terminal. The command stays copyable so an operator
          who would rather run it themselves (or whose browser can't be launched
          from here) has the exact string. Reconnect is deliberately absent — the
          enclosing banner already offers it. */}
      {hint.reauth && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Copyable text={hint.reauth.command}>
            <Mono>{hint.reauth.command}</Mono>
          </Copyable>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <Btn
              t={t}
              variant="primary"
              size="sm"
              disabled={loggingIn}
              onClick={doLogin}
            >
              {loggingIn ? "Waiting for browser…" : "Log in"}
            </Btn>
            {/* No retry button here: the banner this note sits inside already
                carries Reconnect, wired to the same callback. */}
            {loggingIn && (
              <Btn t={t} variant="secondary" size="sm" onClick={cancelLogin}>
                Cancel
              </Btn>
            )}
            <span style={{ color: t.textDim }}>
              {loggingIn
                ? "finish the sign-in in your browser"
                : "opens your browser, then reconnects on its own"}
            </span>
          </div>
          {/* gcloud's own output, verbatim. On success this is a line or two and
              the reconnect fires anyway; when it fails this is the only place
              the reason exists. */}
          {loginLog && (
            <pre
              style={{
                margin: 0,
                padding: "6px 8px",
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                borderRadius: "var(--fs-radius-sm, 4px)",
                background: t.bg,
                color: t.textDim,
                fontFamily: "var(--fs-font-mono, monospace)",
                fontSize: FS_SM,
              }}
            >
              {loginLog}
            </pre>
          )}
        </div>
      )}

      {pin && hint.identities.length > 0 && !confirming && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: t.textDim }}>Pin this context to</span>
          {/* The `Select` atom rather than a native <select>: the native
              popover list is drawn by the OS, so it ignores our tokens and
              renders a light list with OS scrollbars on a dark theme. It also
              avoids a hardcoded DOM id, which would collide if two banners
              ever mounted at once. */}
          <Select<string>
            t={t}
            value={identity ?? ""}
            onChange={setIdentity}
            options={hint.identities.map((a) => ({ value: a, label: a }))}
            fullWidth={false}
            style={{ minWidth: 220 }}
          />
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            disabled={!identity}
            onClick={() => setConfirming(true)}
          >
            Pin {pin.noun}
          </Btn>
        </div>
      )}

      {pin && confirming && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Every effect named up front — this rewrites a file the operator
              owns, and for gcloud also drops a cache other tools share. The
              list comes from the backend so the disclosure can't drift out of
              sync with what the pin actually does. */}
          <div style={{ color: t.text }}>
            Pin this context to <Mono>{identity}</Mono>? This will:
          </div>
          <ul style={{ margin: 0, paddingInlineStart: 18, color: t.text }}>
            {pin.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              t={t}
              variant="primary"
              size="sm"
              disabled={pinning}
              onClick={doPin}
            >
              {pinning ? "Pinning…" : `Pin ${identity}`}
            </Btn>
            <Btn
              t={t}
              variant="secondary"
              size="sm"
              disabled={pinning}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {pinError && <div style={{ color: t.bad }}>{pinError}</div>}
    </div>
  );
}
