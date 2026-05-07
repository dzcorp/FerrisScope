// Per-kind detail summaries for cluster-scoped + event kinds (Node, Namespace,
// Event). Same shape as the workload summaries: fetch on mount + on
// detailVersion bumps, compose shared primitives, dispatch from DetailPanel.

import { useEffect, useRef, useState } from "react";
import { api, onResourceDelta } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Chip, LoadingLine, Section, StatusPill } from "../../ui";
import {
  ChipWrap,
  Copyable,
  DetailRow,
  EditSessionProvider,
  GlobalSaveBar,
  LinkValue,
  Mute,
  ageFromIso,
  formatQuantity,
  type DetailNavigate,
} from "..";
import type {
  EventDetail,
  NamespaceDetail,
  NodeDetail,
  ResourceRow,
  WorkloadCondition,
} from "../../../types";
import { ConditionsSection, MetaSection } from "../workload/shared";

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; detail: T }
  | { kind: "error"; message: string };

function useDetail<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    // Don't flip back to "loading" on a refetch — keep the previous panel
    // contents on screen until the new fetch lands, then swap. Otherwise the
    // detail panel collapses to a one-line spinner during cordon/drain
    // refresh, the scroll container's content height drops to zero, and the
    // browser snaps back to scroll-top. R-01: no spinner on poll.
    fetcher()
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function Frame({ t, children }: { t: Tokens; children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "18px 22px 22px",
        background: t.bg,
        color: t.text,
      }}
    >
      {children}
    </div>
  );
}

function ErrorBlock({ t, message }: { t: Tokens; message: string }) {
  return (
    <pre
      style={{
        padding: 18,
        fontFamily: FONT_MONO,
        fontSize: 11.5,
        color: t.bad,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: 0,
      }}
    >
      {message}
    </pre>
  );
}

// ── Node ───────────────────────────────────────────────────────────────────
//
// Node conditions invert: True is *bad* for MemoryPressure / DiskPressure /
// PIDPressure / NetworkUnavailable. Reuse the workload `ConditionsSection`
// for Ready, then render the pressure conditions with their own coloured
// chip below — operators shouldn't have to remember which way is "bad".

const NODE_PRESSURE_CONDITIONS = new Set([
  "MemoryPressure",
  "DiskPressure",
  "PIDPressure",
  "NetworkUnavailable",
]);

export function NodeSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<NodeDetail>(
    () => api.getNodeDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading node…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  const ready = d.conditions.find((c) => c.type === "Ready");
  const pressures = d.conditions.filter((c) =>
    NODE_PRESSURE_CONDITIONS.has(c.type),
  );
  const otherConds = d.conditions.filter(
    (c) => c.type !== "Ready" && !NODE_PRESSURE_CONDITIONS.has(c.type),
  );

  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "nodes",
        namespace: null,
        name: props.name,
      }}
      onSaved={() => setRefetch((r) => r + 1)}
    >
      <Frame t={t}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
          }}
        >
          <StatusPill status={d.phase} t={t} mode={props.mode} />
          {d.roles.length > 0 && (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                color: t.text,
              }}
            >
              {d.roles.join(", ")}
            </span>
          )}
          {d.node_info?.kubelet_version && (
            <span style={{ fontSize: 11.5, color: t.textMuted }}>
              kubelet {d.node_info.kubelet_version}
            </span>
          )}
          {d.meta.created_at && (
            <span style={{ fontSize: 11.5, color: t.textMuted }}>
              · {ageFromIso(d.meta.created_at)} old
            </span>
          )}
          {d.unschedulable && (
            <StatusPill status="Cordoned" t={t} mode={props.mode} dense />
          )}
        </div>

        <MetaSection
          t={t}
          meta={d.meta}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "nodes",
            namespace: null,
            name: props.name,
          }}
        />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        {d.roles.length > 0 && (
          <DetailRow t={t} label="Roles">
            <ChipWrap>
              {d.roles.map((r) => (
                <Copyable key={r} text={r}>
                  <Chip t={t} mono>
                    {r}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        <DetailRow t={t} label="Schedulable">
          <span style={{ fontSize: 12 }}>
            {d.unschedulable ? "false (cordoned)" : "true"}
          </span>
        </DetailRow>
        {d.provider_id && (
          <DetailRow t={t} label="Provider ID">
            <Copyable text={d.provider_id}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  wordBreak: "break-all",
                }}
              >
                {d.provider_id}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.pod_cidrs.length > 0 && (
          <DetailRow t={t} label="Pod CIDRs">
            <ChipWrap>
              {d.pod_cidrs.map((c) => (
                <Copyable key={c} text={c}>
                  <Chip t={t} mono>
                    {c}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
      </div>

      {d.addresses.length > 0 && (
        <>
          <Section t={t} title="Addresses" />
          <div style={{ marginBottom: 22 }}>
            {d.addresses.map((a, i) => (
              <DetailRow key={`${a.type}-${i}`} t={t} label={a.type}>
                <Copyable text={a.address}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    {a.address}
                  </span>
                </Copyable>
              </DetailRow>
            ))}
          </div>
        </>
      )}

      {(Object.keys(d.capacity).length > 0 ||
        Object.keys(d.allocatable).length > 0) && (
        <>
          <Section t={t} title="Resources" />
          <div style={{ marginBottom: 22 }}>
            <ResourceMatrix
              t={t}
              capacity={d.capacity}
              allocatable={d.allocatable}
            />
          </div>
        </>
      )}

      {d.node_info && (
        <>
          <Section t={t} title="System" />
          <div style={{ marginBottom: 22 }}>
            <NodeInfoRow t={t} label="OS Image" value={d.node_info.os_image} />
            <NodeInfoRow
              t={t}
              label="Kernel"
              value={d.node_info.kernel_version}
            />
            <NodeInfoRow
              t={t}
              label="Container Runtime"
              value={d.node_info.container_runtime_version}
            />
            <NodeInfoRow
              t={t}
              label="Kube Proxy"
              value={d.node_info.kube_proxy_version}
            />
            <NodeInfoRow
              t={t}
              label="Architecture"
              value={d.node_info.architecture}
            />
            <NodeInfoRow
              t={t}
              label="Operating System"
              value={d.node_info.operating_system}
            />
            <NodeInfoRow t={t} label="Boot ID" value={d.node_info.boot_id} dim />
            <NodeInfoRow
              t={t}
              label="Machine ID"
              value={d.node_info.machine_id}
              dim
            />
            <NodeInfoRow
              t={t}
              label="System UUID"
              value={d.node_info.system_uuid}
              dim
            />
          </div>
        </>
      )}

      {d.taints.length > 0 && (
        <>
          <Section
            t={t}
            title="Taints"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.taints.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.taints.map((t2, i) => {
              // Canonical kubectl form for copy: `key[=value][:Effect]`.
              // Lets the operator paste straight into `kubectl taint nodes`.
              const canonical = `${t2.key}${t2.value ? `=${t2.value}` : ""}${
                t2.effect ? `:${t2.effect}` : ""
              }`;
              return (
                <DetailRow key={`${i}-${t2.key}`} t={t} label="Taint">
                  {/* key=value rendered in the value column with break-all
                      wrap so cilium / cluster-api / cloud-provider keys
                      (`node.cilium.io/agent-not-ready` and similar 30–50ch
                      strings) flow inside the column instead of overflowing
                      the fixed 180px label slot the way `label={t2.key}`
                      used to. Wrapped in Copyable so a single click yields
                      the kubectl-pasteable form. */}
                  <Copyable text={canonical}>
                    <span
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                        wordBreak: "break-all",
                        color: t.text,
                      }}
                    >
                      {t2.key}
                      {t2.value ? `=${t2.value}` : ""}
                    </span>
                  </Copyable>
                  {t2.effect && (
                    <Chip t={t} mono tone="accent">
                      {t2.effect}
                    </Chip>
                  )}
                </DetailRow>
              );
            })}
          </div>
        </>
      )}

      <PodsOnNodeSection
        t={t}
        mode={props.mode}
        clusterId={props.clusterId}
        node={props.name}
        detailVersion={props.detailVersion}
        onNavigate={props.onNavigate}
      />

      {ready && (
        <>
          <Section t={t} title="Ready Condition" />
          <div style={{ marginBottom: 22 }}>
            <NodeConditionRow t={t} cond={ready} invert={false} />
          </div>
        </>
      )}

      {pressures.length > 0 && (
        <>
          <Section
            t={t}
            title="Pressure"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {pressures.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {pressures.map((c) => (
              <NodeConditionRow key={c.type} t={t} cond={c} invert />
            ))}
          </div>
        </>
      )}

      {otherConds.length > 0 && (
        <ConditionsSection t={t} conditions={otherConds} />
      )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}

function NodeInfoRow({
  t,
  label,
  value,
  dim,
}: {
  t: Tokens;
  label: string;
  value: string;
  dim?: boolean;
}) {
  if (!value) return null;
  return (
    <DetailRow t={t} label={label}>
      <Copyable text={value}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: dim ? 11 : 12,
            color: dim ? t.textDim : t.text,
            wordBreak: "break-all",
          }}
        >
          {value}
        </span>
      </Copyable>
    </DetailRow>
  );
}

// Capacity vs allocatable, side-by-side per resource. Operators reading this
// want to know "how much does this node have" + "how much can workloads
// actually claim" together, since the gap is the reserved system overhead.
function ResourceMatrix({
  t,
  capacity,
  allocatable,
}: {
  t: Tokens;
  capacity: Record<string, string>;
  allocatable: Record<string, string>;
}) {
  const keys = Array.from(
    new Set([...Object.keys(capacity), ...Object.keys(allocatable)]),
  ).sort();
  return (
    <>
      {keys.map((k) => {
        const cap = capacity[k] ?? null;
        const alloc = allocatable[k] ?? null;
        return (
          <DetailRow key={k} t={t} label={k}>
            <Copyable text={cap ?? ""}>
              <span
                title={cap ?? undefined}
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatQuantity(k, cap)}
              </span>
            </Copyable>
            <span
              title={alloc ?? undefined}
              style={{
                fontSize: 11,
                color: t.textMuted,
                marginLeft: 8,
              }}
            >
              allocatable {formatQuantity(k, alloc)}
            </span>
          </DetailRow>
        );
      })}
    </>
  );
}

// Pressure conditions invert — True is bad. Plain Ready uses the workload
// section. Reason / message render the same as workload conditions.
function NodeConditionRow({
  t,
  cond,
  invert,
}: {
  t: Tokens;
  cond: WorkloadCondition;
  invert: boolean;
}) {
  const isTrue = cond.status === "True";
  const ok = invert ? !isTrue : isTrue;
  const bg = ok ? "rgba(16,185,129,0.16)" : "rgba(244,63,94,0.16)";
  const fg = ok ? t.good : t.bad;
  return (
    <DetailRow t={t} label={cond.type}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "1px 7px",
          borderRadius: 3,
          fontSize: 11,
          fontWeight: 600,
          background: bg,
          color: fg,
        }}
      >
        {cond.status}
      </span>
      {cond.reason && (
        <span style={{ fontSize: 11.5, color: t.textDim }}>{cond.reason}</span>
      )}
      {cond.message && (
        <div
          style={{
            fontSize: 11.5,
            color: t.textMuted,
            width: "100%",
            marginTop: 2,
            wordBreak: "break-word",
          }}
        >
          {cond.message}
        </div>
      )}
      {cond.last_transition_time && (
        <span
          style={{
            fontSize: 11,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            marginLeft: "auto",
          }}
        >
          {ageFromIso(cond.last_transition_time)} ago
        </span>
      )}
    </DetailRow>
  );
}

// Pods scheduled on the node. Fetched on mount + on `detailVersion` bumps so
// the watcher's pod-table deltas (Ready / Restarts changes) refresh this list
// alongside the node's own detail. Click → navigate to the pod detail.
//
// Reuses the row-shape projection the pod table consumes (same projection
// function on the backend) so the columns shown here match what's in Pods.
function PodsOnNodeSection(props: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  node: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const { t, mode } = props;
  const [state, setState] = useState<LoadState<ResourceRow[]>>({
    kind: "loading",
  });
  // Per-effect map identity. Listener bails when it sees a different map,
  // mirroring the ResourceTable race fix — so a stale listener from a prior
  // node panel can never bleed into the current one.
  const mapRef = useRef<Map<string, ResourceRow>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const localMap = new Map<string, ResourceRow>();
    mapRef.current = localMap;
    // Intentionally do NOT setState({ loading }) here — on a refetch we keep
    // showing the previous pod rows until the new snapshot lands. Otherwise
    // the section briefly empties (collapsing the panel's content height)
    // and the surrounding scroll container snaps back to the top during
    // every cordon/drain bump.

    const publish = () => {
      if (cancelled || mapRef.current !== localMap) return;
      setState({ kind: "ready", detail: Array.from(localMap.values()) });
    };

    (async () => {
      try {
        // Live pod deltas across the whole cluster, filtered to this node.
        // We need real-time updates so a drain visibly drains — without this
        // the panel only refreshed on the node watcher's bumps, which don't
        // fire for pod state changes.
        const unl = await onResourceDelta(props.clusterId, "pods", (delta) => {
          if (cancelled || mapRef.current !== localMap) return;
          if (delta.kind === "upsert") {
            const node =
              typeof delta.row.node === "string" ? delta.row.node : null;
            if (node === props.node) {
              localMap.set(delta.row.uid, delta.row);
              publish();
            } else if (localMap.has(delta.row.uid)) {
              // The pod moved off this node (rare for normal pods, but a
              // controller could re-create one elsewhere). Drop it.
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
        });
        if (cancelled) {
          unl();
          return;
        }
        unlisten = unl;

        // Start the cluster's pods watcher (ref-counted; cheap if already up
        // because the operator has Pods open elsewhere). The snapshot path
        // would also work but `listPodsOnNode` is server-filtered and avoids
        // shipping every pod in the cluster just to drop most of them here.
        const [, initial] = await Promise.all([
          api.subscribeResource(props.clusterId, "pods", null),
          api.listPodsOnNode(props.clusterId, props.node),
        ]);
        if (cancelled) return;

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
      api.unsubscribeResource(props.clusterId, "pods").catch(() => {});
    };
    // `detailVersion` is intentionally NOT a dep: the pod watcher's deltas
    // already keep this list in sync, and re-running the effect on every
    // node-detail bump would tear down + re-subscribe the listener (and
    // briefly drop pods) on each cordon/drain refresh.
  }, [props.clusterId, props.node]);

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
                fontSize: 10.5,
                color: t.textMuted,
                fontFamily: FONT_MONO,
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
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11.5,
              color: t.bad,
              padding: "6px 0",
            }}
          >
            {state.message}
          </div>
        )}
        {state.kind === "ready" && rows.length === 0 && (
          <Mute t={t}>No pods scheduled on this node.</Mute>
        )}
        {state.kind === "ready" &&
          rows.map((row) => (
            <PodOnNodeRow
              key={row.uid}
              t={t}
              mode={mode}
              row={row}
              onNavigate={props.onNavigate}
            />
          ))}
      </div>
    </>
  );
}

function PodOnNodeRow({
  t,
  mode,
  row,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  row: ResourceRow;
  onNavigate?: DetailNavigate;
}) {
  const name = String(row.name ?? "");
  const ns = typeof row.namespace === "string" ? row.namespace : null;
  const phase = typeof row.phase === "string" ? row.phase : "Unknown";
  const ready = typeof row.ready === "string" ? row.ready : "";
  const restarts =
    typeof row.restarts === "number"
      ? row.restarts
      : Number(row.restarts) || 0;
  const created =
    typeof row.creation_timestamp === "string" ? row.creation_timestamp : null;

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
            fontFamily: FONT_MONO,
            fontSize: 11.5,
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
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: restarts > 5 ? t.warn : t.textMuted,
          }}
        >
          ↻{restarts}
        </span>
      )}
      {created && (
        <span
          style={{
            fontSize: 11,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            marginLeft: "auto",
          }}
        >
          {ageFromIso(created)}
        </span>
      )}
    </DetailRow>
  );
}

// ── Namespace ──────────────────────────────────────────────────────────────

export function NamespaceSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<NamespaceDetail>(
    () => api.getNamespaceDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading namespace…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "namespaces",
        namespace: null,
        name: props.name,
      }}
      onSaved={() => setRefetch((r) => r + 1)}
    >
      <Frame t={t}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
          }}
        >
          <StatusPill status={d.phase} t={t} mode={props.mode} />
          {d.meta.created_at && (
            <span style={{ fontSize: 11.5, color: t.textMuted }}>
              {ageFromIso(d.meta.created_at)} old
            </span>
          )}
        </div>

        <MetaSection
          t={t}
          meta={d.meta}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "namespaces",
            namespace: null,
            name: props.name,
          }}
        />

      {d.finalizers.length > 0 && (
        <>
          <Section
            t={t}
            title="Finalizers"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.finalizers.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Finalizers">
              <ChipWrap>
                {d.finalizers.map((f) => (
                  <Copyable key={f} text={f}>
                    <Chip t={t} mono>
                      {f}
                    </Chip>
                  </Copyable>
                ))}
              </ChipWrap>
            </DetailRow>
          </div>
        </>
      )}

      <ConditionsSection t={t} conditions={d.conditions} />
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}

// ── Event ──────────────────────────────────────────────────────────────────

export function EventSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  const state = useDetail<EventDetail>(
    () => api.getEventDetail(props.clusterId, ns ?? "", props.name),
    [props.clusterId, ns, props.name, props.detailVersion],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading event…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  const isWarning = d.type === "Warning";
  const headerTs = d.last_timestamp ?? d.event_time ?? d.first_timestamp;

  return (
    <Frame t={t}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <StatusPill status={d.type} t={t} mode={props.mode} />
        {d.reason && (
          <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
            {d.reason}
          </span>
        )}
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.count > 1 ? `×${d.count}` : "×1"}
          {headerTs ? ` · last seen ${ageFromIso(headerTs)} ago` : ""}
        </span>
        {isWarning && (
          <StatusPill status="Warning" t={t} mode={props.mode} dense />
        )}
      </div>

      {d.message && (
        <div
          style={{
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 8,
            background: t.surface,
            padding: "10px 12px",
            marginBottom: 22,
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: t.text,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          <Copyable text={d.message}>{d.message}</Copyable>
        </div>
      )}

      <MetaSection t={t} meta={d.meta} onNavigate={props.onNavigate} />

      <Section t={t} title="Involved Object" />
      <div style={{ marginBottom: 22 }}>
        {d.involved_object.kind && (
          <DetailRow t={t} label="Kind">
            <span style={{ fontSize: 12 }}>{d.involved_object.kind}</span>
          </DetailRow>
        )}
        {d.involved_object.name && (
          <DetailRow t={t} label="Name">
            <LinkValue
              t={t}
              onClick={() =>
                props.onNavigate?.(
                  d.involved_object.kind ?? "",
                  d.involved_object.namespace ?? null,
                  d.involved_object.name!,
                )
              }
              copyText={d.involved_object.name}
              enabled={!!props.onNavigate && !!d.involved_object.kind}
            >
              {d.involved_object.name}
            </LinkValue>
          </DetailRow>
        )}
        {d.involved_object.namespace && (
          <DetailRow t={t} label="Namespace">
            <LinkValue
              t={t}
              onClick={() =>
                props.onNavigate?.(
                  "Namespace",
                  null,
                  d.involved_object.namespace!,
                )
              }
              copyText={d.involved_object.namespace}
              enabled={!!props.onNavigate}
            >
              {d.involved_object.namespace}
            </LinkValue>
          </DetailRow>
        )}
        {d.involved_object.api_version && (
          <DetailRow t={t} label="API Version">
            <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>
              {d.involved_object.api_version}
            </span>
          </DetailRow>
        )}
        {d.involved_object.field_path && (
          <DetailRow t={t} label="Field Path">
            <Copyable text={d.involved_object.field_path}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  wordBreak: "break-all",
                }}
              >
                {d.involved_object.field_path}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.involved_object.uid && (
          <DetailRow t={t} label="UID">
            <Copyable text={d.involved_object.uid}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.textDim,
                  wordBreak: "break-all",
                }}
              >
                {d.involved_object.uid}
              </span>
            </Copyable>
          </DetailRow>
        )}
      </div>

      <Section t={t} title="Timing" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Count">
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.count}</span>
        </DetailRow>
        {d.first_timestamp && (
          <DetailRow t={t} label="First Seen">
            <Copyable text={d.first_timestamp}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.first_timestamp)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.first_timestamp})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.last_timestamp && (
          <DetailRow t={t} label="Last Seen">
            <Copyable text={d.last_timestamp}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.last_timestamp)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.last_timestamp})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.event_time && (
          <DetailRow t={t} label="Event Time">
            <Copyable text={d.event_time}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.event_time)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.event_time})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.series && (
          <DetailRow t={t} label="Series">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.series.count ?? 0} observations
              {d.series.last_observed_time
                ? ` · last ${ageFromIso(d.series.last_observed_time)} ago`
                : ""}
            </span>
          </DetailRow>
        )}
      </div>

      <Section t={t} title="Source" />
      <div style={{ marginBottom: 22 }}>
        {d.source?.component && (
          <DetailRow t={t} label="Component">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.source.component}
            </span>
          </DetailRow>
        )}
        {d.source?.host && (
          <DetailRow t={t} label="Host">
            <LinkValue
              t={t}
              onClick={() => props.onNavigate?.("Node", null, d.source!.host!)}
              copyText={d.source.host}
              enabled={!!props.onNavigate}
            >
              {d.source.host}
            </LinkValue>
          </DetailRow>
        )}
        {d.action && (
          <DetailRow t={t} label="Action">
            <span style={{ fontSize: 12 }}>{d.action}</span>
          </DetailRow>
        )}
        {d.reporting_controller && (
          <DetailRow t={t} label="Reporting Controller">
            <Copyable text={d.reporting_controller}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  wordBreak: "break-all",
                }}
              >
                {d.reporting_controller}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.reporting_instance && (
          <DetailRow t={t} label="Reporting Instance">
            <Copyable text={d.reporting_instance}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  wordBreak: "break-all",
                }}
              >
                {d.reporting_instance}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {!d.source?.component && !d.source?.host && !d.reporting_controller && (
          <DetailRow t={t} label="Source">
            <Mute t={t}>—</Mute>
          </DetailRow>
        )}
      </div>

      {d.related && (
        <>
          <Section t={t} title="Related Object" />
          <div style={{ marginBottom: 22 }}>
            {d.related.kind && (
              <DetailRow t={t} label="Kind">
                <span style={{ fontSize: 12 }}>{d.related.kind}</span>
              </DetailRow>
            )}
            {d.related.name && (
              <DetailRow t={t} label="Name">
                <LinkValue
                  t={t}
                  onClick={() =>
                    props.onNavigate?.(
                      d.related!.kind ?? "",
                      d.related!.namespace ?? null,
                      d.related!.name!,
                    )
                  }
                  copyText={d.related.name}
                  enabled={!!props.onNavigate && !!d.related.kind}
                >
                  {d.related.name}
                </LinkValue>
              </DetailRow>
            )}
            {d.related.namespace && (
              <DetailRow t={t} label="Namespace">
                <LinkValue
                  t={t}
                  onClick={() =>
                    props.onNavigate?.("Namespace", null, d.related!.namespace!)
                  }
                  copyText={d.related.namespace}
                  enabled={!!props.onNavigate}
                >
                  {d.related.namespace}
                </LinkValue>
              </DetailRow>
            )}
          </div>
        </>
      )}

    </Frame>
  );
}
