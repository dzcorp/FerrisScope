// Header toggle for "forward every service in this namespace over DNS".
// Lives in the Namespace detail-panel header next to Delete/Close. One click
// enables a global (DNS) forward for every service in the namespace via the
// privileged helper; the session then stays live (a backend Service watch picks
// up services created/deleted afterwards). Once a session exists the button
// reads as active and a click stops it. The rich live state (per-service IPs +
// hostnames) lives in the forwards panel, which opens on enable.

import { useMemo, useState } from "react";
import { api } from "../../api";
import { useAppStore } from "../../store";
import type { Tokens } from "../../theme";
import { IconBtn } from "../ui/Btn";
import { Icons } from "../ui/icons";
import { toast } from "../../lib/dialog";

export function NamespaceForwardButton({
  t,
  clusterId,
  namespace,
  disabled = false,
}: {
  t: Tokens;
  clusterId: string;
  namespace: string;
  // True when the cluster is degraded — blocks *starting* a new forward (a
  // doomed connect). Stopping an existing session stays allowed so the
  // operator can still tear down a now-dead forward.
  disabled?: boolean;
}) {
  const globalForwards = useAppStore((s) => s.globalForwards);
  const upsertGlobalForward = useAppStore((s) => s.upsertGlobalForward);
  const removeGlobalForward = useAppStore((s) => s.removeGlobalForward);
  const openForwardsPanel = useAppStore((s) => s.openForwardsPanel);
  const [busy, setBusy] = useState(false);

  // The namespace session is the one whose label matches this namespace.
  const session = useMemo(
    () =>
      Object.values(globalForwards).find(
        (s) => s.cluster_id === clusterId && s.namespace === namespace,
      ),
    [globalForwards, clusterId, namespace],
  );

  const count = session?.services.length ?? 0;
  const plural = count === 1 ? "" : "s";

  const toggle = async () => {
    setBusy(true);
    try {
      if (session) {
        await api.gfDisable(session.id);
        removeGlobalForward(session.id);
        toast.ok(`Stopped forwarding ${namespace}`);
      } else {
        const s = await api.gfEnableNamespace(clusterId, namespace);
        upsertGlobalForward(s);
        openForwardsPanel();
        toast.ok(
          `Forwarding ${s.services.length} service${s.services.length === 1 ? "" : "s"} in ${namespace}`,
        );
      }
    } catch (e) {
      toast.bad(`${session ? "Disable" : "Forward"} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const title = busy
    ? "Working…"
    : session
      ? `Forwarding · ${count} service${plural} · click to stop`
      : "Forward all services (DNS)";

  return (
    <IconBtn
      t={t}
      size="lg"
      title={title}
      active={!!session}
      disabled={busy || (disabled && !session)}
      onClick={toggle}
    >
      {Icons.forward}
    </IconBtn>
  );
}
