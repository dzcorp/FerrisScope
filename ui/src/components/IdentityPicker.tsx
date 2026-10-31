import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAppStore } from "../store";
import { toast } from "../lib/dialog";
import type { PinOffer } from "../types";
import type { Tokens } from "../theme";
import { Btn, Select } from "./ui";
import { Mono } from "./detail/primitives";

// Pick → confirm → pin, shared by the failed-connect note and the "change
// account" surfaces. Every effect comes from the backend's `PinOffer`, so the
// disclosure can't drift from what the pin does.
export function IdentityPicker({
  t,
  contextId,
  identities,
  pinned,
  suggested,
  offer,
  onPinned,
}: {
  t: Tokens;
  contextId: string;
  identities: string[];
  /// What the context pins today; listed as "(current)" and never re-pinnable.
  pinned: string | null;
  /// Backend-chosen preselection — never `pinned`, never unlisted.
  suggested: string | null;
  offer: PinOffer;
  onPinned: () => void;
}) {
  const [identity, setIdentity] = useState<string | null>(suggested);
  const [confirming, setConfirming] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pin can still be in flight when the surface unmounts (cluster switch).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (identities.length === 0) return null;

  const doPin = () => {
    if (!identity || pinning) return;
    setPinning(true);
    setError(null);
    api
      .pinCloudIdentity(contextId, identity)
      .then((warning) => {
        if (warning) toast.warn(warning);
        // The fleet refreshes on the kubeconfig watcher only while mounted;
        // the cluster bar's identity chip reads the same list.
        void api
          .listContexts()
          .then((cs) => useAppStore.getState().setContexts(cs))
          .catch(() => {});
        // Even when the surface closed mid-pin: the backend already dropped
        // the cluster's client, so whatever shows it must reconnect.
        onPinned();
        if (mountedRef.current) setConfirming(false);
      })
      .catch((e: unknown) => {
        if (mountedRef.current) setError(String(e));
      })
      .finally(() => {
        if (mountedRef.current) setPinning(false);
      });
  };

  return (
    <>
      {!confirming ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: t.textDim }}>Pin this context to</span>
          {/* The `Select` atom rather than a native <select>: the OS-drawn
              popover ignores our tokens. */}
          <Select<string>
            t={t}
            value={identity ?? ""}
            onChange={setIdentity}
            options={identities.map((a) => ({
              value: a,
              label: a === pinned ? `${a} (current)` : a,
            }))}
            fullWidth={false}
            style={{ minWidth: 220 }}
          />
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            disabled={!identity || identity === pinned}
            onClick={() => setConfirming(true)}
          >
            Pin {offer.noun}
          </Btn>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ color: t.text }}>
            Pin this context to <Mono>{identity}</Mono>? This will:
          </div>
          <ul style={{ margin: 0, paddingInlineStart: 18, color: t.text }}>
            {offer.effects.map((e) => (
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
            {/* Disabled mid-write: backing out then would leave the operator
                unsure whether the file was rewritten. */}
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
      {error && <div style={{ color: t.bad }}>{error}</div>}
    </>
  );
}
