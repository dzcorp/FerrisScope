import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ConnectHint } from "../types";
import type { Tokens } from "../theme";
import { FS_SM } from "../theme";
import { Btn, Chip, Select } from "./ui";
import { Copyable, Mono } from "./detail/primitives";

// Small amber note under a failed connect, shown only when the backend
// recognises cloud identity drift: a context whose exec entry pins no
// account/profile, so it authenticates as whichever identity the cloud CLI last
// selected — and that changes under the operator.
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
  /// Called after a successful pin so the caller can retry the connection.
  onReconnect: () => void;
}) {
  const [hint, setHint] = useState<ConnectHint | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
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

      {/* A lapsed cloud session, not identity drift: there is nothing to write,
          so the note hands over the command and a way back. The command is
          copyable rather than a button that runs it — gcloud needs a real
          terminal (and usually a browser) for the challenge, and the app has no
          terminal surface before a cluster is connected. */}
      {hint.reauth && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Copyable text={hint.reauth.command}>
            <Mono>{hint.reauth.command}</Mono>
          </Copyable>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn t={t} variant="primary" size="sm" onClick={onReconnect}>
              Retry connect
            </Btn>
            <span style={{ color: t.textDim }}>
              after the login completes in your terminal
            </span>
          </div>
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
