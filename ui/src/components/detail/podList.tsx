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
  /// Show each pod's namespace. Worth a column only where it varies — on a
  /// workload every pod shares the controller's namespace.
  showNamespace?: boolean;
  /// Which controller a pod belongs to, when the list unions several. Renders
  /// a leading chip; omit for a single-owner list where it would be constant.
  ownerOf?: (row: ResourceRow) => string | null;
  emptyLabel: string;
  /// Node panel only — drains are driven from there.
  enableEvict?: boolean;
  /// Left-hand label for the pane toolbar (a cluster name when the Inspect
  /// tab groups by cluster). Ignored in `section` variant.
  paneLabel?: string;
  /// `section` (default) is a titled block among other sections in a detail
  /// panel: "Pods" header, count on the right, compact inline loader.
  /// `pane` is the whole surface — no header (the tab already says "Pods")
  /// and a centred full-height loader, matching the other Inspect tabs.
  variant?: "section" | "pane";
  onNavigate?: DetailNavigate;
};

export function PodListSection(props: PodListSectionProps) {
  const {
    t,
    mode,
    showNode = false,
    showNamespace = false,
    enableEvict = false,
    variant = "section",
  } = props;
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
  // Monotonic across BOTH effects: they share `localMap`, so the identity
  // guard can't tell them apart. Only the newest-issued fetch may write.
  const fetchSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  // Uids the delta stream admitted since the in-flight fetch was issued.
  const admittedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    // Only unsubscribe if we actually subscribed. `unsubscribe_resource`
    // decrements a SHARED refcount, so a spurious decrement — unmount while
    // `onResourceDelta`'s listen() is still pending, or a rejected subscribe —
    // steals the Pods table's subscription and its watcher dies after the
    // linger window. StrictMode makes that deterministic in dev.
    let subscribed = false;
    const localMap = new Map<string, ResourceRow>();
    mapRef.current = localMap;
    // A new subject means the previous subject's vouched-for uids are
    // meaningless. Left stale, `acceptsPodDelta`'s `known.has(uid)`
    // short-circuit would admit the OLD subject's pods into the new list and
    // the initial merge would then make them permanent.
    knownRef.current = new Set();
    admittedRef.current = new Set();
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
                // Remember it so an in-flight fetch, whose snapshot predates
                // this pod, doesn't drop it when it lands.
                admittedRef.current.add(delta.row.uid);
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
        // Counts against the same in-flight guard as a refetch — otherwise a
        // bump arriving during mount would fire a second concurrent LIST.
        const mySeq = ++fetchSeqRef.current;
        inFlightRef.current = true;
        const [, initial] = await Promise.all([
          api.subscribeResource(props.clusterId, "pods", null).then((r) => {
            subscribed = true;
            return r;
          }),
          fetchRef.current(),
        ]).finally(() => {
          inFlightRef.current = false;
        });
        if (cancelled) return;
        // A refetch issued after us may already have landed; it is newer and
        // authoritative, so don't roll `known` back to this older snapshot.
        if (fetchSeqRef.current !== mySeq) return;

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
      if (subscribed) {
        api
          .unsubscribeResource(props.clusterId, "pods")
          .catch(logErr("pod-list"));
      }
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
    // `detailVersion` bumps once per debounced watcher delta for the viewed
    // object, so a churning rollout would otherwise fire several LISTs a
    // second at the apiserver. One in flight at a time is enough — the delta
    // stream carries the interim state anyway.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let cancelled = false;
    const localMap = mapRef.current;
    const mySeq = ++fetchSeqRef.current;
    // Anything the delta stream admits from here on postdates this snapshot,
    // so it must survive the merge rather than being treated as stale.
    admittedRef.current = new Set();
    (async () => {
      try {
        const fresh = await fetchRef.current();
        if (cancelled || mapRef.current !== localMap) return;
        if (fetchSeqRef.current !== mySeq) return;
        const admitted = admittedRef.current;
        knownRef.current = new Set([
          ...fresh.map((r) => r.uid),
          ...admitted,
        ]);
        // The fetch is authoritative about membership, so rows it dropped
        // leave the list — except pods the stream admitted after the fetch was
        // issued, which it simply couldn't have seen. Deltas still win on
        // content for rows in both.
        const merged = new Map<string, ResourceRow>();
        for (const row of fresh) {
          merged.set(row.uid, localMap.get(row.uid) ?? row);
        }
        for (const uid of admitted) {
          const row = localMap.get(uid);
          if (row) merged.set(uid, row);
        }
        localMap.clear();
        for (const [uid, row] of merged) localMap.set(uid, row);
        setState({ kind: "ready", detail: Array.from(localMap.values()) });
      } catch {
        // A failed refetch keeps the delta-maintained list on screen — it is
        // still live and useful. Errors only surface from the initial load.
      } finally {
        inFlightRef.current = false;
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

  const body = (
    <>
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
              showNamespace={showNamespace}
              owner={props.ownerOf?.(row) ?? null}
              enableEvict={enableEvict}
              onNavigate={props.onNavigate}
          />
        ))}
    </>
  );

  // As the whole pane: the tab label already says "Pods", so a section header
  // would repeat it, and the centred loader matches the sibling tabs.
  if (variant === "pane") {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 22px",
            borderBottom: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
            fontSize: FS_XS,
            color: t.textMuted,
            fontFamily: FF_MONO,
          }}
        >
          {props.paneLabel ?? "Pods"}
          {state.kind === "ready" && <span>{state.detail.length} total</span>}
        </div>
        {state.kind === "loading" ? (
          <LoadingLine t={t} label="Loading pods…" />
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 22px" }}>
            {body}
          </div>
        )}
      </div>
    );
  }

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
        {body}
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
  showNamespace,
  owner,
  enableEvict,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  row: ResourceRow;
  showNode: boolean;
  showNamespace: boolean;
  owner: string | null;
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
    // Label only where the namespace actually varies (the Node panel). On a
    // workload every pod shares the controller's namespace, so the column
    // would be the same word repeated down the whole list.
    <DetailRow t={t} label={showNamespace ? (ns ?? "—") : null}>
      {/* Which controller this pod came from, when the list unions several.
          Muted and unclickable — the owner is already in the selection, so
          this is orientation, not a destination. */}
      {owner && (
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.textMuted,
            background: t.chip,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_SM,
            padding: "0 6px",
            flexShrink: 0,
            maxWidth: 160,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={owner}
        >
          {owner}
        </span>
      )}
      {/* Identity first and genuinely unshrinkable — a pod name cut mid-hash
          is unreadable, so the node beside it gives up width instead. The
          row wraps before this shrinks, which is why there's no `truncate`
          here: it could never fire. */}
      <span style={{ flex: "0 0 auto", minWidth: 0 }}>
        <LinkValue
          t={t}
          onClick={() => onNavigate?.("Pod", ns, name)}
          copyText={ns ? `${ns}/${name}` : name}
          enabled={!!onNavigate}
        >
          {name}
        </LinkValue>
      </span>
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
          // Muted: a secondary reference that shouldn't compete with the pod
          // name. Takes the slack in the row and ellipsizes first — the full
          // name is in the tooltip and on copy.
          <span
            style={{ flex: "1 1 0", minWidth: 60, marginLeft: "auto" }}
            title={node}
          >
            <LinkValue
              t={t}
              onClick={() => onNavigate?.("Node", null, node)}
              copyText={node}
              enabled={!!onNavigate}
              tone="muted"
              truncate
            >
              {node}
            </LinkValue>
          </span>
        ) : (
          // Unscheduled (Pending) — a dead link would read as a real node.
          <span style={{ flex: "1 1 0", marginLeft: "auto" }}>
            <Mute t={t}>—</Mute>
          </span>
        ))}
      {created && (
        <span
          style={{
            fontSize: FS_SM,
            color: t.textMuted,
            fontFamily: FF_MONO,
            fontVariantNumeric: "tabular-nums",
            flex: "0 0 auto",
            marginLeft: showNode ? 0 : "auto",
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
