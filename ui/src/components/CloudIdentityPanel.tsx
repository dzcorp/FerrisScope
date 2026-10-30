import { useEffect, useState } from "react";
import { api } from "../api";
import type { IdentityStatus } from "../types";
import type { Tokens } from "../theme";
import { FS_SM } from "../theme";
import { Btn, Chip } from "./ui";
import { Dialog } from "./ui/Dialog";
import { Mute } from "./detail/primitives";
import { IdentityPicker } from "./IdentityPicker";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: IdentityStatus | null };

// A context's cloud identity as it stands, with the repin. Needs no failed
// connect, so it is the way out of a wrong pin and of a connect that works as
// the wrong identity. All prose and gating come from `IdentityStatus`.
export function CloudIdentityPanel({
  t,
  contextId,
  onPinned,
}: {
  t: Tokens;
  contextId: string;
  /// Fired after a pin was written — the caller reconnects whatever view shows
  /// this cluster, since a live client keeps the identity it was built with.
  onPinned: () => void;
}) {
  const [s, setS] = useState<LoadState>({ status: "loading" });
  const [refetch, setRefetch] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .cloudIdentityStatus(contextId)
      .then((data) => {
        if (live) setS({ status: "loaded", data });
      })
      .catch((e: unknown) => {
        if (live) setS({ status: "error", message: String(e) });
      });
    return () => {
      live = false;
    };
  }, [contextId, refetch]);

  if (s.status === "loading") return <Mute t={t}>Reading kubeconfig…</Mute>;
  if (s.status === "error")
    return <div style={{ color: t.bad, fontSize: FS_SM }}>{s.message}</div>;
  const st = s.data;
  if (!st)
    return (
      <Mute t={t}>
        No cloud identity to change here: this context authenticates without a
        recognised cloud exec plugin, lives in another kubeconfig file, or comes
        over SSH.
      </Mute>
    );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontSize: FS_SM,
      }}
    >
      <div style={{ color: t.text }}>{st.detail}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {st.pinned_identity ? (
          <>
            <span style={{ color: t.textDim }}>pinned to</span>
            <Chip t={t} tone="accent" mono>
              {st.pinned_identity}
            </Chip>
          </>
        ) : (
          <span style={{ color: t.textDim }}>not pinned</span>
        )}
        {st.active_identity && (
          <>
            <span style={{ color: t.textDim }}>· CLI active</span>
            <Chip t={t} mono>
              {st.active_identity}
            </Chip>
          </>
        )}
      </div>
      {st.pin &&
        (st.pin_blocked ? (
          <div style={{ color: t.warn }}>{st.pin_blocked}</div>
        ) : st.identities.length === 0 ? (
          <Mute t={t}>
            {`No ${st.pin.noun} is configured on this machine to pin.`}
          </Mute>
        ) : (
          <IdentityPicker
            key={st.pinned_identity ?? ""}
            t={t}
            contextId={contextId}
            identities={st.identities}
            pinned={st.pinned_identity}
            suggested={st.suggested_identity}
            offer={st.pin}
            onPinned={() => {
              setRefetch((n) => n + 1);
              onPinned();
            }}
          />
        ))}
    </div>
  );
}

// `CloudIdentityPanel` in the shared form-dialog chrome, for entry points that
// have no surface of their own to host it (fleet card menu, cluster bar).
export function CloudIdentityModal({
  t,
  contextId,
  contextName,
  onPinned,
  onClose,
}: {
  t: Tokens;
  contextId: string;
  contextName: string;
  onPinned: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      t={t}
      title="Cloud identity"
      subtitle={contextName}
      onClose={onClose}
      footer={
        <Btn t={t} variant="secondary" size="sm" onClick={onClose}>
          Close
        </Btn>
      }
    >
      <CloudIdentityPanel t={t} contextId={contextId} onPinned={onPinned} />
    </Dialog>
  );
}
