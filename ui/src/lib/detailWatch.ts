import { useEffect, useState } from "react";
import { api, onResourceDelta } from "../api";
import type { ResourceKind, ResourceRow } from "../types";
import { logErr } from "./log";

// A detail drawer is independent of the table's current kind, so it watches
// its own object's kind. Subscriptions are refcounted per (cluster, kind,
// namespace scope) on the backend, so this shares the reflector with any
// table already showing that kind.

export function detailScope(kind: ResourceKind, namespace: string | null): string[] | null {
  return kind.namespaced && namespace ? [namespace] : null;
}

const RESOLVE_TIMEOUT_MS = 8000;

/// Find an object's projected row by name — how a link inside a detail
/// learns the target's uid. Null when the watcher's initial sync finishes
/// (or the timeout passes) without it: the object doesn't exist.
export async function findDetailRow(
  clusterId: string,
  kind: ResourceKind,
  namespace: string | null,
  name: string,
): Promise<ResourceRow | null> {
  const scope = detailScope(kind, namespace);
  const matches = (r: ResourceRow) =>
    String(r.name ?? "") === name &&
    (!kind.namespaced || namespace == null || String(r.namespace ?? "") === namespace);
  let settle: (r: ResourceRow | null) => void = () => {};
  const streamed = new Promise<ResourceRow | null>((resolve) => {
    settle = resolve;
  });
  // Listen before subscribing so a row arriving mid-subscribe isn't missed.
  const unlisten = await onResourceDelta(clusterId, kind.id, scope, (d) => {
    if (d.kind === "upsert" && matches(d.row)) settle(d.row);
    else if (d.kind === "init_done") settle(null);
  });
  let subscribed = false;
  try {
    const snap = await api.subscribeResource(clusterId, kind.id, scope);
    subscribed = true;
    const hit = snap.rows.find(matches);
    if (hit) return hit;
    if (snap.init_done) return null;
    return await Promise.race([
      streamed,
      new Promise<null>((r) => setTimeout(() => r(null), RESOLVE_TIMEOUT_MS)),
    ]);
  } finally {
    unlisten();
    if (subscribed) void api.unsubscribeResource(clusterId, kind.id, scope).catch(logErr("detail"));
  }
}

/// Keep the drawer's object watched while it's mounted and return its row
/// from the subscribe snapshot. Later changes arrive through DetailPanel's
/// own delta listener on the same channel.
export function useDetailRow(
  clusterId: string,
  kind: ResourceKind | null,
  namespace: string | null,
  uid: string,
): ResourceRow | null {
  const [row, setRow] = useState<ResourceRow | null>(null);
  const kindId = kind?.id ?? null;
  const scopeKey = kind ? (detailScope(kind, namespace)?.join(",") ?? "*") : "";
  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    const scope = detailScope(kind, namespace);
    setRow(null);
    const sub = api.subscribeResource(clusterId, kind.id, scope);
    sub
      .then((snap) => {
        if (!cancelled) setRow(snap.rows.find((r) => r.uid === uid) ?? null);
      })
      .catch(logErr("detail"));
    return () => {
      cancelled = true;
      // Only release what was actually taken.
      sub
        .then(() => api.unsubscribeResource(clusterId, kind.id, scope))
        .catch(logErr("detail"));
    };
    // `kind` and `namespace` are covered by kindId / scopeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, kindId, scopeKey, uid]);
  return row;
}
