import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../api";
import type { GitOpsResource, ObjectStatus, ObjectStatusRef } from "../../../types";
import { resourceKey } from "./SyncDialog";

export type LiveStatus = Pick<ObjectStatus, "found" | "status" | "ready" | "error">;

/// Minimum spacing between refreshes of an unchanged resource set; the detail
/// refetches every few seconds on a busy app.
export const LIVE_STATUS_MIN_INTERVAL_MS = 30_000;

/// Live status of local managed resources, keyed by `resourceKey`. Reads
/// running reflectors first; the backend never starts a watch for this.
export function useLiveStatus(
  clusterId: string,
  resources: GitOpsResource[],
): Map<string, LiveStatus> {
  const [live, setLive] = useState<Map<string, LiveStatus>>(new Map());
  const req = useRef(0);
  const last = useRef<{ signature: string; at: number } | null>(null);
  const refs = useMemo<ObjectStatusRef[]>(
    () =>
      resources
        .filter((r) => r.local)
        .map((r) => ({ group: r.group, kind: r.kind, namespace: r.namespace, name: r.name })),
    [resources],
  );
  const signature = useMemo(
    () => `${clusterId}\n${refs.map(resourceKey).join("\n")}`,
    [clusterId, refs],
  );
  useEffect(() => {
    const now = Date.now();
    const prev = last.current;
    if (prev && prev.signature === signature && now - prev.at < LIVE_STATUS_MIN_INTERVAL_MS) return;
    last.current = { signature, at: now };
    const id = ++req.current;
    if (refs.length === 0) {
      setLive(new Map());
      return;
    }
    api
      .resolveObjectStatuses(clusterId, refs)
      .then((res) => {
        if (req.current !== id) return;
        setLive(
          new Map(
            res.items.map((s) => [
              resourceKey(s),
              { found: s.found, status: s.status, ready: s.ready, error: s.error },
            ]),
          ),
        );
      })
      // Live status is an enrichment; the controller-reported list stands on its own.
      .catch(() => {
        if (req.current === id) setLive(new Map());
      });
    // `refs` identity changes on every detail refetch; `signature` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, resources]);
  return live;
}
