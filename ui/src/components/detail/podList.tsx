// Live pod list for a detail panel. Shared by the Node panel ("pods scheduled
// here") and every selector-owning workload panel ("pods this controller
// owns"); the two differ only in how the initial list is fetched and how a
// delta is claimed.
//
// Hybrid by design: one server-filtered fetch for the authoritative set, plus
// a live subscription to the cluster's pod deltas so state changes land
// without a refetch. Rows use the row-shape projection the pod table consumes
// (same backend projection), so what's shown here matches the Pods table.

import { useEffect, useRef, useState } from "react";
import { api, onResourceDelta } from "../../api";
import { logErr } from "../../lib/log";
import { confirm, toast } from "../../lib/dialog";
import { selectClusterDegraded, useAppStore } from "../../store";
import {
  FF_MONO,
  type ThemeMode,
  type Tokens,
  R_SM,
  FS_SM,
  FS_XS,
} from "../../theme";
import { ErrorBlock, LoadingLine, Section, StatusPill } from "../ui";
import {
  DetailRow,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
  type LoadState,
} from ".";
import type { ResourceRow } from "../../types";

export type PodListSectionProps = {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  /// Authoritative initial set. Server-filtered — we never ship a namespace of
  /// pods just to drop most of them here.
  fetchPods: () => Promise<ResourceRow[]>;
  /// Whether a live delta belongs in this list. Receives the set of uids the
  /// last fetch vouched for, so a caller that cannot fully evaluate its own
  /// predicate can decline to admit unknown pods.
  acceptsDelta: (row: ResourceRow, known: ReadonlySet<string>) => boolean;
  /// Identity of the object being viewed (node name, or `kind/ns/name`).
  /// Changing it rebuilds the list from scratch. `fetchPods` / `acceptsDelta`
  /// are read through refs so a caller rebuilding them each render doesn't
  /// churn the subscription — which makes this the ONLY signal that the
  /// subject changed. Don't drop it and rely on the parent remounting.
  subjectKey: string;
  /// Bumped by the parent when its own detail refreshes; triggers a merge
  /// refetch WITHOUT tearing down the subscription.
  refetchKey: number;
  /// Show which node each pod landed on. Redundant on the Node panel.
  showNode?: boolean;
  emptyLabel: string;
  /// Node panel only — drains are driven from there.
  enableEvict?: boolean;
  onNavigate?: DetailNavigate;
};

export function PodListSection(props: PodListSectionProps) {
  const { t, mode, showNode = false, enableEvict = false } = props;
  const [state, setState] = useState<LoadState<ResourceRow[]>>({
    kind: "loading",
  });

  // Per-effect map identity. Listener bails when it sees a different map,
  // mirroring the ResourceTable race fix — so a stale listener from a prior
  // panel can never bleed into the current one.
  const mapRef = useRef<Map<string, ResourceRow>>(new Map());
  // Uids the server-side fetch vouched for. `acceptsDelta` consults this to
  // decide whether an unknown pod may join the list.
  const knownRef = useRef<ReadonlySet<string>>(new Set());
  // Read through a ref so a caller that rebuilds the predicate each render
  // doesn't tear the subscription down.
  const acceptsRef = useRef(props.acceptsDelta);
  acceptsRef.current = props.acceptsDelta;
  const fetchRef = useRef(props.fetchPods);
  fetchRef.current = props.fetchPods;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const localMap = new Map<string, ResourceRow>();
    mapRef.current = localMap;
    // Intentionally do NOT setState({ loading }) on refetch — we keep showing
    // the previous rows until the new snapshot lands. Otherwise the section
    // briefly empties, the panel's content height collapses, and the
    // surrounding scroll container snaps back to the top on every bump.

    const publish = () => {
      if (cancelled || mapRef.current !== localMap) return;
      setState({ kind: "ready", detail: Array.from(localMap.values()) });
    };

    (async () => {
      try {
        // Live pod deltas across the whole cluster, filtered here. Without
        // this the list would only refresh on the parent's detail bumps,
        // which don't fire for pod state changes.
        const unl = await onResourceDelta(
          props.clusterId,
          "pods",
          null,
          (delta) => {
            if (cancelled || mapRef.current !== localMap) return;
            if (delta.kind === "upsert") {
              if (acceptsRef.current(delta.row, knownRef.current)) {
                localMap.set(delta.row.uid, delta.row);
                publish();
              } else if (localMap.has(delta.row.uid)) {
                // Stopped matching — moved node, or relabelled out of the
                // controller's selector. Drop it.
                localMap.delete(delta.row.uid);
                publish();
              }
            } else if (delta.kind === "delete") {
              if (localMap.has(delta.uid)) {
                localMap.delete(delta.uid);
                publish();
              }
            }
            // init_done — nothing to do; this view doesn't gate UI on it.
          },
        );
        if (cancelled) {
          unl();
          return;
        }
        unlisten = unl;

        // Start the cluster's pods watcher (ref-counted; cheap if already up
        // because the operator has Pods open elsewhere).
        const [, initial] = await Promise.all([
          api.subscribeResource(props.clusterId, "pods", null),
          fetchRef.current(),
        ]);
        if (cancelled) return;

        knownRef.current = new Set(initial.map((r) => r.uid));
        // Merge: initial fetch under any deltas already received (deltas win).
        const merged = new Map<string, ResourceRow>();
        for (const row of initial) merged.set(row.uid, row);
        for (const [uid, row] of localMap) merged.set(uid, row);
        localMap.clear();
        for (const [uid, row] of merged) localMap.set(uid, row);
        publish();
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      api
        .unsubscribeResource(props.clusterId, "pods")
        .catch(logErr("pod-list"));
    };
    // `refetchKey` is intentionally NOT a dep: the pod watcher's deltas keep
    // this list in sync, and re-running the effect on every parent bump would
    // tear down + re-subscribe the listener (and briefly drop every pod).
    // The separate effect below handles refetches.
  }, [props.clusterId, props.subjectKey]);

  // Merge-refetch on the parent's detail bump. Re-establishes the
  // authoritative set — the only way a pod excluded from the delta stream
  // (an unevaluable matchExpressions selector) can ever join the list.
  // Seeded from the value at mount, not 0: a panel can mount with a bump
  // count already well past zero (the object was watched before it was
  // opened), and firing on that would duplicate the initial fetch.
  const lastRefetchRef = useRef(props.refetchKey);
  useEffect(() => {
    if (props.refetchKey === lastRefetchRef.current) return;
    lastRefetchRef.current = props.refetchKey;
    let cancelled = false;
    const localMap = mapRef.current;
    (async () => {
      try {
        const fresh = await fetchRef.current();
        if (cancelled || mapRef.current !== localMap) return;
        knownRef.current = new Set(fresh.map((r) => r.uid));
        // The fetch is authoritative about membership, so rows it dropped
        // leave the list. Deltas still win on content for rows in both.
        const merged = new Map<string, ResourceRow>();
        for (const row of fresh) {
          merged.set(row.uid, localMap.get(row.uid) ?? row);
        }
        localMap.clear();
        for (const [uid, row] of merged) localMap.set(uid, row);
        setState({ kind: "ready", detail: Array.from(localMap.values()) });
      } catch {
        // A failed refetch keeps the delta-maintained list on screen — it is
        // still live and useful. Errors only surface from the initial load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.refetchKey]);

  const rows =
    state.kind === "ready"
      ? [...state.detail].sort((a, b) => {
          const an = `${a.namespace ?? ""}/${a.name ?? ""}`;
          const bn = `${b.namespace ?? ""}/${b.name ?? ""}`;
          return an.localeCompare(bn);
        })
      : [];

  return (
    <>
      <Section
        t={t}
        title="Pods"
        right={
          state.kind === "ready" ? (
            <span
              style={{
                fontSize: FS_XS,
                color: t.textMuted,
                fontFamily: FF_MONO,
              }}
            >
              {state.detail.length} total
            </span>
          ) : null
        }
      />
      <div style={{ marginBottom: 22 }}>
        {state.kind === "loading" && (
          <LoadingLine t={t} label="Loading pods…" inline />
        )}
        {state.kind === "error" && (
          <div style={{ padding: "6px 0" }}>
            <ErrorBlock t={t} message={state.message} kindLabel="pods" inline />
          </div>
        )}
        {state.kind === "ready" && rows.length === 0 && (
          <Mute t={t}>{props.emptyLabel}</Mute>
        )}
        {state.kind === "ready" &&
          rows.map((row) => (
            <PodRow
              key={row.uid}
              t={t}
              mode={mode}
              clusterId={props.clusterId}
              row={row}
              showNode={showNode}
              enableEvict={enableEvict}
              onNavigate={props.onNavigate}
            />
          ))}
      </div>
    </>
  );
}

function PodRow({
  t,
  mode,
  clusterId,
  row,
  showNode,
  enableEvict,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  row: ResourceRow;
  showNode: boolean;
  enableEvict: boolean;
  onNavigate?: DetailNavigate;
}) {
  const name = String(row.name ?? "");
  const ns = typeof row.namespace === "string" ? row.namespace : null;
  // Match the row menu / bulk bar: skip the prompt when the user has turned
  // off destructive confirmations globally, and disable the button while the
  // cluster is unavailable / mid auto-reconnect.
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);
  const degraded = useAppStore((s) => selectClusterDegraded(s, clusterId));
  const phase = typeof row.phase === "string" ? row.phase : "Unknown";
  const ready = typeof row.ready === "string" ? row.ready : "";
  const restarts =
    typeof row.restarts === "number" ? row.restarts : Number(row.restarts) || 0;
  const created =
    typeof row.creation_timestamp === "string" ? row.creation_timestamp : null;
  const node = typeof row.node === "string" && row.node ? row.node : null;

  // Graceful, PDB-aware eviction. The list is fed by live pod deltas, so a
  // successful evict removes the row on its own (Terminating → delete) — no
  // manual refetch here.
  const doEvict = () => {
    void (async () => {
      if (!ns) {
        toast.bad("Pod has no namespace — can't evict.");
        return;
      }
      if (confirmDestructive) {
        const ok = await confirm({
          title: `Evict pod ${ns}/${name}?`,
          body: "Graceful, PDB-aware eviction off this node. Blocked if it would breach a PodDisruptionBudget. A controller-owned pod is rescheduled elsewhere; a bare pod is gone.",
          confirmLabel: "Evict",
          tone: "danger",
        });
        if (!ok) return;
      }
      try {
        await api.evictPod(clusterId, ns, name);
        toast.ok(`Evicted pod ${ns}/${name}.`);
      } catch (e) {
        // 429 → the apiserver's disruption-budget message, surfaced verbatim.
        toast.bad(`Evict failed: ${String(e)}`);
      }
    })();
  };

  return (
    <DetailRow t={t} label={ns ?? "—"}>
      <LinkValue
        t={t}
        onClick={() => onNavigate?.("Pod", ns, name)}
        copyText={ns ? `${ns}/${name}` : name}
        enabled={!!onNavigate}
      >
        {name}
      </LinkValue>
      <StatusPill status={phase} t={t} mode={mode} dense />
      {ready && (
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            fontVariantNumeric: "tabular-nums",
            color: t.textDim,
          }}
        >
          {ready}
        </span>
      )}
      {restarts > 0 && (
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            color: restarts > 5 ? t.warn : t.textMuted,
          }}
        >
          ↻{restarts}
        </span>
      )}
      {showNode &&
        (node ? (
          <LinkValue
            t={t}
            onClick={() => onNavigate?.("Node", null, node)}
            copyText={node}
            enabled={!!onNavigate}
          >
            {node}
          </LinkValue>
        ) : (
          // Unscheduled (Pending) — a dead link would read as a real node.
          <Mute t={t}>—</Mute>
        ))}
      {created && (
        <span
          style={{
            fontSize: FS_SM,
            color: t.textMuted,
            fontFamily: FF_MONO,
            marginLeft: "auto",
          }}
        >
          {ageFromIso(created)}
        </span>
      )}
      {enableEvict && (
        <button
          type="button"
          disabled={degraded}
          onClick={(e) => {
            e.stopPropagation();
            if (degraded) return;
            doEvict();
          }}
          title={
            degraded
              ? "Cluster unavailable — can't evict right now"
              : "Evict pod (graceful, PDB-aware)"
          }
          style={{
            marginLeft: created ? 8 : "auto",
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: degraded ? t.textMuted : t.bad,
            background: "transparent",
            border: `1px solid ${t.border}`,
            borderRadius: R_SM,
            padding: "1px 8px",
            cursor: degraded ? "not-allowed" : "pointer",
            opacity: degraded ? 0.5 : 1,
            lineHeight: 1.6,
          }}
        >
          Evict
        </button>
      )}
    </DetailRow>
  );
}
