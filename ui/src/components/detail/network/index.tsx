// Per-kind detail summaries for the network family (Service, Endpoints,
// EndpointSlice, Ingress, IngressClass, NetworkPolicy). Same shape as the
// workload + cluster summaries: fetch on mount + on detailVersion bumps,
// compose shared primitives, dispatch from DetailPanel.

import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Chip, ErrorBlock, LoadingLine, Section, StatusPill } from "../../ui";
import {
  ChipStrip,
  ChipWrap,
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import type {
  EndpointAddress,
  EndpointPort,
  EndpointSliceDetail,
  EndpointSliceEntry,
  EndpointSubset,
  EndpointTargetRef,
  EndpointsDetail,
  IngressBackend,
  IngressClassDetail,
  IngressDetail,
  IngressPath,
  IngressRule,
  LabelSelectorSummary,
  LoadBalancerIngress,
  NetworkPolicyDetail,
  NetworkPolicyPeer,
  NetworkPolicyPort,
  NetworkPolicyRule,
  ServiceDetail,
  ServicePort,
} from "../../../types";
import { ForwardChip } from "../forwardChip";
import { MetaSection } from "../workload/shared";
import {
  ConflictBanner,
  EditModeChrome,
  EditableTextValue,
  ListEditor,
  listBufferDirty,
  listBufferFrom,
  listBufferToArray,
  useApply,
  type ApplyTarget,
  type ListBuffer,
} from "../edit";
import { useMemo } from "react";

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
    // No `setState({ loading })` on refetch — keep the previous detail on
    // screen until the new fetch resolves so the panel doesn't collapse and
    // snap the scroll container back to the top after every action.
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

// Renders status.loadBalancer.ingress for Service / Ingress — shape is
// identical between the two (`{ ip, hostname, ports[] }`).
function LoadBalancerSection({
  t,
  ingress,
}: {
  t: Tokens;
  ingress: LoadBalancerIngress[];
}) {
  if (ingress.length === 0) return null;
  return (
    <>
      <Section
        t={t}
        title="Load Balancer"
        right={
          <span
            style={{
              fontSize: 10.5,
              color: t.textMuted,
              fontFamily: FONT_MONO,
            }}
          >
            {ingress.length} ingress
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        {ingress.map((i, idx) => {
          const addr = i.hostname ?? i.ip ?? "—";
          return (
            <DetailRow key={idx} t={t} label={i.hostname ? "Hostname" : "IP"}>
              {addr === "—" ? (
                <Mute t={t}>—</Mute>
              ) : (
                <Copyable text={addr}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    {addr}
                  </span>
                </Copyable>
              )}
              {i.ports.length > 0 && (
                <ChipWrap>
                  {i.ports.map((p, pi) => (
                    <Chip key={pi} t={t} mono>
                      {p.port}/{p.protocol ?? "TCP"}
                      {p.error ? ` ⚠ ${p.error}` : ""}
                    </Chip>
                  ))}
                </ChipWrap>
              )}
            </DetailRow>
          );
        })}
      </div>
    </>
  );
}

// Render a kubernetes-style label selector summary (matchLabels chips +
// matchExpressions count). Falls back to "(matches everything)" when both
// halves are empty — that's what an empty selector means in k8s.
function SelectorBlock({
  t,
  selector,
}: {
  t: Tokens;
  selector: LabelSelectorSummary | null;
}) {
  if (!selector) return <Mute t={t}>—</Mute>;
  const hasLabels = selector.match_labels.length > 0;
  const hasExpr = selector.match_expressions > 0;
  if (!hasLabels && !hasExpr)
    return <Mute t={t}>(matches everything)</Mute>;
  return (
    <>
      {hasLabels && <KeyValueChips t={t} pairs={selector.match_labels} />}
      {hasExpr && (
        <span style={{ fontSize: 11.5, color: t.textDim, marginLeft: 6 }}>
          + {selector.match_expressions} matchExpression
          {selector.match_expressions === 1 ? "" : "s"}
        </span>
      )}
    </>
  );
}

function TargetRefRow({
  t,
  label,
  ref,
  onNavigate,
}: {
  t: Tokens;
  label: string;
  ref: EndpointTargetRef | null;
  onNavigate?: DetailNavigate;
}) {
  if (!ref?.name || !ref.kind) return null;
  return (
    <DetailRow t={t} label={label}>
      <span style={{ fontSize: 12, color: t.textDim }}>{ref.kind}</span>
      <LinkValue
        t={t}
        onClick={() => onNavigate?.(ref.kind!, ref.namespace ?? null, ref.name!)}
        copyText={ref.name}
        enabled={!!onNavigate}
      >
        {ref.name}
      </LinkValue>
      {ref.namespace && (
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {ref.namespace}
        </span>
      )}
    </DetailRow>
  );
}

// ── Service ────────────────────────────────────────────────────────────────

export function ServiceSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<ServiceDetail>(
    () => api.getServiceDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <ErrorBlock t={t} message="Service requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading service…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="service" />;

  const d = state.detail;
  const isHeadless = d.cluster_ip === "None";
  const isExternalName = d.type === "ExternalName";

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
        {isHeadless && (
          <StatusPill status="Headless" t={t} mode={props.mode} dense />
        )}
        {d.meta.created_at && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            {ageFromIso(d.meta.created_at)} old
          </span>
        )}
        {d.ports.length > 0 && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            · {d.ports.length} port{d.ports.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "services",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Type">
          <span style={{ fontSize: 12 }}>{d.type}</span>
        </DetailRow>
        {isExternalName ? (
          d.external_name && (
            <DetailRow t={t} label="External Name">
              <Copyable text={d.external_name}>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    wordBreak: "break-all",
                  }}
                >
                  {d.external_name}
                </span>
              </Copyable>
            </DetailRow>
          )
        ) : (
          <>
            {d.cluster_ip && (
              <DetailRow t={t} label="Cluster IP">
                <Copyable text={d.cluster_ip}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    {d.cluster_ip}
                  </span>
                </Copyable>
              </DetailRow>
            )}
            {d.cluster_ips.length > 1 && (
              <DetailRow t={t} label="Cluster IPs">
                <ChipWrap>
                  {d.cluster_ips.map((ip) => (
                    <Copyable key={ip} text={ip}>
                      <Chip t={t} mono>
                        {ip}
                      </Chip>
                    </Copyable>
                  ))}
                </ChipWrap>
              </DetailRow>
            )}
            {d.external_ips.length > 0 && (
              <DetailRow t={t} label="External IPs">
                <ChipWrap>
                  {d.external_ips.map((ip) => (
                    <Copyable key={ip} text={ip}>
                      <Chip t={t} mono>
                        {ip}
                      </Chip>
                    </Copyable>
                  ))}
                </ChipWrap>
              </DetailRow>
            )}
          </>
        )}
        {d.session_affinity && d.session_affinity !== "None" && (
          <DetailRow t={t} label="Session Affinity">
            <span style={{ fontSize: 12 }}>{d.session_affinity}</span>
          </DetailRow>
        )}
        {d.internal_traffic_policy && (
          <DetailRow t={t} label="Internal Traffic Policy">
            <span style={{ fontSize: 12 }}>{d.internal_traffic_policy}</span>
          </DetailRow>
        )}
        {d.external_traffic_policy && (
          <DetailRow t={t} label="External Traffic Policy">
            <span style={{ fontSize: 12 }}>{d.external_traffic_policy}</span>
          </DetailRow>
        )}
        {d.ip_families.length > 0 && (
          <DetailRow t={t} label="IP Families">
            <ChipWrap>
              {d.ip_families.map((f) => (
                <Chip key={f} t={t} mono>
                  {f}
                </Chip>
              ))}
            </ChipWrap>
            {d.ip_family_policy && (
              <span style={{ fontSize: 11.5, color: t.textDim, marginLeft: 8 }}>
                {d.ip_family_policy}
              </span>
            )}
          </DetailRow>
        )}
        {d.load_balancer_class && (
          <DetailRow t={t} label="LB Class">
            <Copyable text={d.load_balancer_class}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>
                {d.load_balancer_class}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.load_balancer_source_ranges.length > 0 && (
          <DetailRow t={t} label="LB Source Ranges">
            <ChipWrap>
              {d.load_balancer_source_ranges.map((c) => (
                <Copyable key={c} text={c}>
                  <Chip t={t} mono>
                    {c}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {d.health_check_node_port != null && (
          <DetailRow t={t} label="Health Check NodePort">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.health_check_node_port}
            </span>
          </DetailRow>
        )}
        {d.publish_not_ready_addresses && (
          <DetailRow t={t} label="Publish Not Ready">
            <span style={{ fontSize: 12 }}>true</span>
          </DetailRow>
        )}
        {d.allocate_load_balancer_node_ports === false && (
          <DetailRow t={t} label="Allocate NodePorts">
            <span style={{ fontSize: 12 }}>false</span>
          </DetailRow>
        )}
        <DetailRow t={t} label="Selector">
          {d.selector.length > 0 ? (
            <KeyValueChips t={t} pairs={d.selector} />
          ) : isExternalName ? (
            <Mute t={t}>(external name — no selector)</Mute>
          ) : (
            <Mute t={t}>(no selector — endpoints managed externally)</Mute>
          )}
        </DetailRow>
      </div>

      <ServicePortsEditor
        t={t}
        ports={d.ports}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "services",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <LoadBalancerSection t={t} ingress={d.load_balancer_ingress} />
    </Frame>
  );
}

// ── Service ports editor ───────────────────────────────────────────────────
// Edits spec.ports as a unit — Service has no obvious "owned subset" the way
// container env does, so the buffer always serialises the full ports array.
// Strings on the inputs (parsed at save) so the operator can type freely;
// validation surfaces as red outlines + an inline message but doesn't block
// save (apiserver is final arbiter).

type ServicePortRowFields = {
  name: string;
  port: string;
  target_port: string;
  node_port: string;
  protocol: string;
  app_protocol: string;
};

function servicePortsBufferFrom(
  ports: ServicePort[],
): ListBuffer<ServicePortRowFields> {
  return listBufferFrom(
    ports.map((p) => ({
      name: p.name ?? "",
      port: String(p.port),
      target_port: p.target_port ?? "",
      node_port: p.node_port != null ? String(p.node_port) : "",
      protocol: p.protocol,
      app_protocol: p.app_protocol ?? "",
    })),
  );
}

function servicePortsDirtyCount(
  b: ListBuffer<ServicePortRowFields>,
): number {
  return listBufferDirty(b, (cur, orig) =>
    cur.name !== orig.name ||
    cur.port !== orig.port ||
    cur.target_port !== orig.target_port ||
    cur.node_port !== orig.node_port ||
    cur.protocol !== orig.protocol ||
    cur.app_protocol !== orig.app_protocol,
  );
}

function serializeServicePort(r: ServicePortRowFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.name !== "") out.name = r.name;
  const p = Number.parseInt(r.port, 10);
  if (!Number.isNaN(p)) out.port = p;
  if (r.target_port !== "") {
    // targetPort is intOrString — use a number when it parses, else string.
    const tp = Number.parseInt(r.target_port, 10);
    out.targetPort = !Number.isNaN(tp) && String(tp) === r.target_port ? tp : r.target_port;
  }
  if (r.node_port !== "") {
    const np = Number.parseInt(r.node_port, 10);
    if (!Number.isNaN(np)) out.nodePort = np;
  }
  if (r.protocol !== "") out.protocol = r.protocol;
  if (r.app_protocol !== "") out.appProtocol = r.app_protocol;
  return out;
}

function ServicePortsEditor({
  t,
  ports,
  editTarget,
  onSaved,
}: {
  t: Tokens;
  ports: ServicePort[];
  editTarget: ApplyTarget;
  onSaved: () => void;
}) {
  const edit = useApply<ListBuffer<ServicePortRowFields>>({
    target: editTarget,
    initial: () => servicePortsBufferFrom(ports),
    serialize: (b) => ({
      spec: {
        ports: listBufferToArray(b, serializeServicePort),
      },
    }),
    dirtyCount: servicePortsDirtyCount,
    onSaved,
  });

  const dupNames = useMemo(() => {
    if (!edit.editing) return new Set<string>();
    const counts = new Map<string, number>();
    for (const r of edit.buffer.rows) {
      if (r.deleted) continue;
      if (r.name === "") continue;
      counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    }
    const dup = new Set<string>();
    for (const [k, n] of counts) if (n > 1) dup.add(k);
    return dup;
  }, [edit.editing, edit.buffer]);

  return (
    <>
      <Section
        t={t}
        title="Ports"
        right={
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
            onSave={edit.save}
            rightExtra={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {ports.length} total
              </span>
            }
          />
        }
      />
      <div style={{ marginBottom: 22 }}>
        {edit.conflict && (
          <ConflictBanner
            t={t}
            conflict={edit.conflict}
            saving={edit.saving}
            onForce={edit.forceSave}
            onDismiss={edit.dismissConflict}
          />
        )}
        {edit.error && (
          <div
            style={{
              margin: "0 0 8px",
              padding: "6px 8px",
              background: "rgba(244,63,94,0.10)",
              border: "1px solid rgba(244,63,94,0.4)",
              borderRadius: 3,
            }}
          >
            <ErrorBlock
              t={t}
              message={edit.error}
              kindLabel="service"
              verb="save"
              inline
            />
          </div>
        )}
        {edit.editing && dupNames.size > 0 && (
          <div
            style={{
              margin: "0 0 6px",
              fontSize: 11,
              color: t.bad,
              fontFamily: FONT_MONO,
            }}
          >
            Duplicate port names: {[...dupNames].join(", ")}
          </div>
        )}
        {edit.editing ? (
          <ListEditor
            t={t}
            buffer={edit.buffer}
            onChange={edit.setBuffer}
            blank={{
              name: "",
              port: "",
              target_port: "",
              node_port: "",
              protocol: "TCP",
              app_protocol: "",
            }}
            addLabel="Add port"
            renderRow={(row, onRowChange) => {
              const portInvalid =
                row.port !== "" &&
                Number.isNaN(Number.parseInt(row.port, 10));
              const nameInvalid =
                row.name !== "" && dupNames.has(row.name);
              return (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.2fr 0.8fr 1fr 0.8fr 0.6fr",
                    gap: 6,
                  }}
                >
                  <EditableTextValue
                    t={t}
                    value={row.name}
                    onChange={(v) => onRowChange({ name: v })}
                    placeholder="name"
                    invalid={nameInvalid}
                  />
                  <EditableTextValue
                    t={t}
                    value={row.port}
                    onChange={(v) => onRowChange({ port: v })}
                    placeholder="port"
                    invalid={portInvalid}
                  />
                  <EditableTextValue
                    t={t}
                    value={row.target_port}
                    onChange={(v) => onRowChange({ target_port: v })}
                    placeholder="targetPort"
                  />
                  <EditableTextValue
                    t={t}
                    value={row.node_port}
                    onChange={(v) => onRowChange({ node_port: v })}
                    placeholder="nodePort"
                  />
                  <EditableTextValue
                    t={t}
                    value={row.protocol}
                    onChange={(v) => onRowChange({ protocol: v })}
                    placeholder="TCP"
                  />
                </div>
              );
            }}
            renderDeletedSummary={(row) => {
              const o = row.original ?? row;
              return `${o.name || "—"} ${o.port}/${o.protocol}`;
            }}
          />
        ) : ports.length === 0 ? (
          <DetailRow t={t} label="Ports">
            <Mute t={t}>—</Mute>
          </DetailRow>
        ) : (
          ports.map((p, i) => (
            <ServicePortRow
              key={i}
              t={t}
              port={p}
              clusterId={editTarget.clusterId}
              namespace={editTarget.namespace ?? ""}
              name={editTarget.name}
            />
          ))
        )}
      </div>
    </>
  );
}

function ServicePortRow({
  t,
  port,
  clusterId,
  namespace,
  name,
}: {
  t: Tokens;
  port: ServicePort;
  clusterId: string;
  namespace: string;
  name: string;
}) {
  const label = port.name ?? `${port.port}`;
  const target =
    port.target_port && port.target_port !== `${port.port}`
      ? ` → ${port.target_port}`
      : "";
  const nodePort = port.node_port != null ? ` · nodePort ${port.node_port}` : "";
  return (
    <DetailRow t={t} label={label}>
      <Copyable text={`${port.port}/${port.protocol}`}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {port.port}/{port.protocol}
          {target}
          {nodePort}
        </span>
      </Copyable>
      {port.app_protocol && (
        <Chip t={t} mono>
          {port.app_protocol}
        </Chip>
      )}
      {namespace && (
        <ForwardChip
          t={t}
          clusterId={clusterId}
          target={{ kind: "Service", namespace, name }}
          remotePort={port.port}
          protocol={port.protocol}
        />
      )}
    </DetailRow>
  );
}

// ── Endpoints ──────────────────────────────────────────────────────────────

export function EndpointsSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<EndpointsDetail>(
    () => api.getEndpointsDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="Endpoints requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading endpoints…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="endpoints" />;

  const d = state.detail;
  const totalReady = d.subsets.reduce((n, s) => n + s.addresses.length, 0);
  const totalNotReady = d.subsets.reduce(
    (n, s) => n + s.not_ready_addresses.length,
    0,
  );

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
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            fontWeight: 600,
            color: totalReady > 0 ? t.good : totalNotReady > 0 ? t.warn : t.bad,
          }}
        >
          {totalReady} ready
        </span>
        {totalNotReady > 0 && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: t.warn,
            }}
          >
            · {totalNotReady} not ready
          </span>
        )}
        {d.meta.created_at && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "endpoints",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      {d.meta.name && (
        <DetailRow t={t} label="Backing Service">
          <LinkValue
            t={t}
            onClick={() =>
              props.onNavigate?.("Service", d.meta.namespace, d.meta.name)
            }
            copyText={d.meta.name}
            enabled={!!props.onNavigate}
          >
            {d.meta.name}
          </LinkValue>
          <span style={{ fontSize: 11, color: t.textMuted, marginLeft: 6 }}>
            (Endpoints share the Service's name)
          </span>
        </DetailRow>
      )}

      {d.subsets.length === 0 ? (
        <>
          <Section t={t} title="Subsets" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Subsets">
              <Mute t={t}>(no backends — selector matches no ready pods)</Mute>
            </DetailRow>
          </div>
        </>
      ) : (
        d.subsets.map((subset, i) => (
          <SubsetBlock
            key={i}
            t={t}
            subset={subset}
            index={i}
            total={d.subsets.length}
            onNavigate={props.onNavigate}
          />
        ))
      )}
    </Frame>
  );
}

function SubsetBlock({
  t,
  subset,
  index,
  total,
  onNavigate,
}: {
  t: Tokens;
  subset: EndpointSubset;
  index: number;
  total: number;
  onNavigate?: DetailNavigate;
}) {
  const title = total > 1 ? `Subset ${index + 1}` : "Subset";
  return (
    <>
      <Section
        t={t}
        title={title}
        right={
          <span
            style={{
              fontSize: 10.5,
              color: t.textMuted,
              fontFamily: FONT_MONO,
            }}
          >
            {subset.addresses.length} ready · {subset.not_ready_addresses.length} not ready ·{" "}
            {subset.ports.length} port{subset.ports.length === 1 ? "" : "s"}
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        {subset.ports.length > 0 && (
          <DetailRow t={t} label="Ports">
            <ChipWrap>
              {subset.ports.map((p, i) => (
                <Chip key={i} t={t} mono>
                  {p.name ? `${p.name}: ` : ""}
                  {p.port}/{p.protocol}
                </Chip>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {subset.addresses.map((a, i) => (
          <EndpointAddressRow
            key={`r-${i}`}
            t={t}
            label="Ready"
            address={a}
            onNavigate={onNavigate}
            tone="good"
          />
        ))}
        {subset.not_ready_addresses.map((a, i) => (
          <EndpointAddressRow
            key={`nr-${i}`}
            t={t}
            label="Not Ready"
            address={a}
            onNavigate={onNavigate}
            tone="warn"
          />
        ))}
      </div>
    </>
  );
}

function EndpointAddressRow({
  t,
  label,
  address,
  onNavigate,
  tone,
}: {
  t: Tokens;
  label: string;
  address: EndpointAddress;
  onNavigate?: DetailNavigate;
  tone: "good" | "warn";
}) {
  const color = tone === "good" ? t.good : t.warn;
  return (
    <DetailRow t={t} label={label}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "1px 7px",
          borderRadius: 3,
          fontSize: 11,
          fontWeight: 600,
          background:
            tone === "good"
              ? "rgba(16,185,129,0.16)"
              : "rgba(245,158,11,0.16)",
          color,
        }}
      >
        {label === "Ready" ? "READY" : "NOT READY"}
      </span>
      <Copyable text={address.ip}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {address.ip}
        </span>
      </Copyable>
      {address.hostname && (
        <span style={{ fontSize: 11.5, color: t.textDim }}>
          {address.hostname}
        </span>
      )}
      {address.node_name && (
        <LinkValue
          t={t}
          onClick={() => onNavigate?.("Node", null, address.node_name!)}
          copyText={address.node_name}
          enabled={!!onNavigate}
        >
          @{address.node_name}
        </LinkValue>
      )}
      {address.target_ref?.name && address.target_ref.kind && (
        <LinkValue
          t={t}
          onClick={() =>
            onNavigate?.(
              address.target_ref!.kind!,
              address.target_ref!.namespace ?? null,
              address.target_ref!.name!,
            )
          }
          copyText={address.target_ref.name}
          enabled={!!onNavigate}
        >
          {address.target_ref.kind}/{address.target_ref.name}
        </LinkValue>
      )}
    </DetailRow>
  );
}

// ── EndpointSlice ──────────────────────────────────────────────────────────

export function EndpointSliceSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<EndpointSliceDetail>(
    () => api.getEndpointSliceDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="EndpointSlice requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading endpoint slice…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="endpoint slice" />;

  const d = state.detail;
  const ready = d.endpoints.filter((e) => e.conditions?.ready === true).length;
  const total = d.endpoints.length;

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
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            fontWeight: 600,
            color: ready === total && total > 0 ? t.good : ready === 0 ? t.bad : t.warn,
          }}
        >
          {ready} / {total} ready
        </span>
        <Chip t={t} mono>
          {d.address_type}
        </Chip>
        {d.meta.created_at && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "endpointslices",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Address Type">
          <span style={{ fontSize: 12 }}>{d.address_type}</span>
        </DetailRow>
        {d.service_name && (
          <DetailRow t={t} label="Backing Service">
            <LinkValue
              t={t}
              onClick={() =>
                props.onNavigate?.("Service", d.meta.namespace, d.service_name!)
              }
              copyText={d.service_name}
              enabled={!!props.onNavigate}
            >
              {d.service_name}
            </LinkValue>
          </DetailRow>
        )}
        {d.ports.length > 0 && (
          <DetailRow t={t} label="Ports">
            <ChipWrap>
              {d.ports.map((p, i) => (
                <PortChip key={i} t={t} port={p} />
              ))}
            </ChipWrap>
          </DetailRow>
        )}
      </div>

      {d.endpoints.length > 0 && (
        <>
          <Section
            t={t}
            title="Endpoints"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.endpoints.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.endpoints.map((e, i) => (
              <EndpointSliceEntryRow
                key={i}
                t={t}
                entry={e}
                index={i}
                onNavigate={props.onNavigate}
              />
            ))}
          </div>
        </>
      )}
    </Frame>
  );
}

function PortChip({ t, port }: { t: Tokens; port: EndpointPort }) {
  const label = `${port.name ? `${port.name}: ` : ""}${port.port ?? "?"}/${port.protocol}`;
  return (
    <Copyable text={label}>
      <Chip t={t} mono>
        {label}
      </Chip>
    </Copyable>
  );
}

function EndpointSliceEntryRow({
  t,
  entry,
  index,
  onNavigate,
}: {
  t: Tokens;
  entry: EndpointSliceEntry;
  index: number;
  onNavigate?: DetailNavigate;
}) {
  const c = entry.conditions;
  const ready = c?.ready === true;
  const serving = c?.serving === true;
  const terminating = c?.terminating === true;

  const items: { label: string; tone?: "warn" | "bad" | "default" }[] = [];
  items.push({
    label: ready ? "ready" : "not ready",
    tone: ready ? "default" : "warn",
  });
  if (c?.serving != null)
    items.push({
      label: serving ? "serving" : "not serving",
      tone: serving ? "default" : "warn",
    });
  if (terminating) items.push({ label: "terminating", tone: "bad" });

  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 8,
        marginBottom: 10,
        background: t.surface,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          #{index + 1}
        </span>
        <ChipStrip t={t} items={items} />
      </div>
      <DetailRow t={t} label="Addresses">
        <ChipWrap>
          {entry.addresses.map((a) => (
            <Copyable key={a} text={a}>
              <Chip t={t} mono>
                {a}
              </Chip>
            </Copyable>
          ))}
        </ChipWrap>
      </DetailRow>
      {entry.hostname && (
        <DetailRow t={t} label="Hostname">
          <Copyable text={entry.hostname}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {entry.hostname}
            </span>
          </Copyable>
        </DetailRow>
      )}
      {entry.node_name && (
        <DetailRow t={t} label="Node">
          <LinkValue
            t={t}
            onClick={() => onNavigate?.("Node", null, entry.node_name!)}
            copyText={entry.node_name}
            enabled={!!onNavigate}
          >
            {entry.node_name}
          </LinkValue>
        </DetailRow>
      )}
      {entry.zone && (
        <DetailRow t={t} label="Zone">
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
            {entry.zone}
          </span>
        </DetailRow>
      )}
      <TargetRefRow
        t={t}
        label="Target"
        ref={entry.target_ref}
        onNavigate={onNavigate}
      />
    </div>
  );
}

// ── Ingress ────────────────────────────────────────────────────────────────

export function IngressSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<IngressDetail>(
    () => api.getIngressDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <ErrorBlock t={t} message="Ingress requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading ingress…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="ingress" />;

  const d = state.detail;
  const totalPaths = d.rules.reduce((n, r) => n + r.paths.length, 0);

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
        {d.ingress_class_name && (
          <Chip t={t} mono>
            class={d.ingress_class_name}
          </Chip>
        )}
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.rules.length} rule{d.rules.length === 1 ? "" : "s"} · {totalPaths} path
          {totalPaths === 1 ? "" : "s"} · {d.tls.length} TLS
        </span>
        {d.meta.created_at && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "ingresses",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Class">
          {d.ingress_class_name ? (
            <LinkValue
              t={t}
              onClick={() =>
                props.onNavigate?.(
                  "IngressClass",
                  null,
                  d.ingress_class_name!,
                )
              }
              copyText={d.ingress_class_name}
              enabled={!!props.onNavigate}
            >
              {d.ingress_class_name}
            </LinkValue>
          ) : (
            <Mute t={t}>(default class)</Mute>
          )}
        </DetailRow>
        {d.default_backend && (
          <DetailRow t={t} label="Default Backend">
            <BackendValue
              t={t}
              backend={d.default_backend}
              namespace={d.meta.namespace}
              onNavigate={props.onNavigate}
            />
          </DetailRow>
        )}
      </div>

      {d.tls.length > 0 && (
        <>
          <Section
            t={t}
            title="TLS"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.tls.length} entries
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.tls.map((tls, i) => (
              <DetailRow
                key={i}
                t={t}
                label={tls.secret_name ?? `TLS #${i + 1}`}
              >
                {tls.secret_name && (
                  <LinkValue
                    t={t}
                    onClick={() =>
                      props.onNavigate?.(
                        "Secret",
                        d.meta.namespace,
                        tls.secret_name!,
                      )
                    }
                    copyText={tls.secret_name}
                    enabled={!!props.onNavigate}
                  >
                    {tls.secret_name}
                  </LinkValue>
                )}
                {tls.hosts.length > 0 ? (
                  <ChipWrap>
                    {tls.hosts.map((h) => (
                      <Copyable key={h} text={h}>
                        <Chip t={t} mono>
                          {h}
                        </Chip>
                      </Copyable>
                    ))}
                  </ChipWrap>
                ) : (
                  <Mute t={t}>(all hosts)</Mute>
                )}
              </DetailRow>
            ))}
          </div>
        </>
      )}

      {d.rules.length > 0 && (
        <>
          <Section
            t={t}
            title="Rules"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.rules.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.rules.map((r, i) => (
              <IngressRuleBlock
                key={i}
                t={t}
                rule={r}
                namespace={d.meta.namespace}
                onNavigate={props.onNavigate}
              />
            ))}
          </div>
        </>
      )}

      <LoadBalancerSection t={t} ingress={d.load_balancer_ingress} />
    </Frame>
  );
}

function IngressRuleBlock({
  t,
  rule,
  namespace,
  onNavigate,
}: {
  t: Tokens;
  rule: IngressRule;
  namespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 8,
        marginBottom: 10,
        background: t.surface,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: t.surfaceAlt,
          borderBottom: `1px solid ${t.borderSoft}`,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontFamily: FONT_MONO,
          }}
        >
          Host
        </span>
        {rule.host ? (
          <Copyable text={rule.host}>
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12.5,
                fontWeight: 600,
                wordBreak: "break-all",
              }}
            >
              {rule.host}
            </span>
          </Copyable>
        ) : (
          <Mute t={t}>(any host)</Mute>
        )}
      </div>
      <div style={{ padding: "4px 12px" }}>
        {rule.paths.map((p, i) => (
          <IngressPathRow
            key={i}
            t={t}
            path={p}
            namespace={namespace}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

function IngressPathRow({
  t,
  path,
  namespace,
  onNavigate,
}: {
  t: Tokens;
  path: IngressPath;
  namespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  const label = path.path ?? "/";
  return (
    <DetailRow t={t} label={label}>
      {path.path_type && (
        <Chip t={t} mono>
          {path.path_type}
        </Chip>
      )}
      <BackendValue
        t={t}
        backend={path.backend}
        namespace={namespace}
        onNavigate={onNavigate}
      />
    </DetailRow>
  );
}

function BackendValue({
  t,
  backend,
  namespace,
  onNavigate,
}: {
  t: Tokens;
  backend: IngressBackend;
  namespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  if (backend.service) {
    const port =
      backend.service.port_name ??
      (backend.service.port_number != null
        ? `${backend.service.port_number}`
        : null);
    return (
      <>
        <span style={{ fontSize: 11.5, color: t.textDim }}>Service</span>
        <LinkValue
          t={t}
          onClick={() =>
            onNavigate?.("Service", namespace, backend.service!.name)
          }
          copyText={backend.service.name}
          enabled={!!onNavigate}
        >
          {backend.service.name}
        </LinkValue>
        {port && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: t.textDim }}>
            :{port}
          </span>
        )}
      </>
    );
  }
  if (backend.resource) {
    return (
      <>
        <span style={{ fontSize: 11.5, color: t.textDim }}>
          {backend.resource.kind}
        </span>
        <Copyable text={backend.resource.name}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
            {backend.resource.name}
          </span>
        </Copyable>
        {backend.resource.api_group && (
          <span style={{ fontSize: 11, color: t.textMuted }}>
            ({backend.resource.api_group})
          </span>
        )}
      </>
    );
  }
  return <Mute t={t}>—</Mute>;
}

// ── IngressClass ───────────────────────────────────────────────────────────

export function IngressClassSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<IngressClassDetail>(
    () => api.getIngressClassDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading ingress class…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="ingress class" />;

  const d = state.detail;
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
        {d.controller && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 13,
              fontWeight: 600,
              color: t.text,
              wordBreak: "break-all",
            }}
          >
            {d.controller}
          </span>
        )}
        {d.is_default && (
          <StatusPill status="Default" t={t} mode={props.mode} dense />
        )}
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
          kindId: "ingressclasses",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Controller">
          {d.controller ? (
            <Copyable text={d.controller}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {d.controller}
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Default">
          <span style={{ fontSize: 12 }}>{d.is_default ? "true" : "false"}</span>
        </DetailRow>
      </div>

      {d.parameters && (
        <>
          <Section t={t} title="Parameters" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Kind">
              <span style={{ fontSize: 12 }}>{d.parameters.kind}</span>
            </DetailRow>
            <DetailRow t={t} label="Name">
              <LinkValue
                t={t}
                onClick={() =>
                  props.onNavigate?.(
                    d.parameters!.kind,
                    d.parameters!.namespace ?? null,
                    d.parameters!.name,
                  )
                }
                copyText={d.parameters.name}
                enabled={!!props.onNavigate}
              >
                {d.parameters.name}
              </LinkValue>
            </DetailRow>
            {d.parameters.namespace && (
              <DetailRow t={t} label="Namespace">
                <LinkValue
                  t={t}
                  onClick={() =>
                    props.onNavigate?.("Namespace", null, d.parameters!.namespace!)
                  }
                  copyText={d.parameters.namespace}
                  enabled={!!props.onNavigate}
                >
                  {d.parameters.namespace}
                </LinkValue>
              </DetailRow>
            )}
            {d.parameters.scope && (
              <DetailRow t={t} label="Scope">
                <span style={{ fontSize: 12 }}>{d.parameters.scope}</span>
              </DetailRow>
            )}
            {d.parameters.api_group && (
              <DetailRow t={t} label="API Group">
                <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>
                  {d.parameters.api_group}
                </span>
              </DetailRow>
            )}
          </div>
        </>
      )}
    </Frame>
  );
}

// ── NetworkPolicy ──────────────────────────────────────────────────────────

export function NetworkPolicySummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<NetworkPolicyDetail>(
    () => api.getNetworkPolicyDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="NetworkPolicy requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading network policy…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="network policy" />;

  const d = state.detail;
  // Empty rule arrays under a declared policy_type mean "deny all in that
  // direction" — surface this explicitly so the operator doesn't have to
  // remember the convention.
  const ingressActive = d.policy_types.includes("Ingress");
  const egressActive = d.policy_types.includes("Egress");

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
        {d.policy_types.map((p) => (
          <Chip key={p} t={t} mono>
            {p}
          </Chip>
        ))}
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.ingress.length} ingress · {d.egress.length} egress
        </span>
        {d.meta.created_at && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "networkpolicies",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Pod Selector">
          <SelectorBlock t={t} selector={d.pod_selector} />
        </DetailRow>
        <DetailRow t={t} label="Policy Types">
          {d.policy_types.length > 0 ? (
            <ChipWrap>
              {d.policy_types.map((p) => (
                <Chip key={p} t={t} mono>
                  {p}
                </Chip>
              ))}
            </ChipWrap>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
      </div>

      {ingressActive && (
        <>
          <Section
            t={t}
            title="Ingress"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.ingress.length === 0
                  ? "deny all"
                  : `${d.ingress.length} rule${d.ingress.length === 1 ? "" : "s"}`}
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.ingress.length === 0 ? (
              <DetailRow t={t} label="—">
                <span style={{ fontSize: 12, color: t.bad }}>
                  Empty ingress list — all inbound traffic is denied.
                </span>
              </DetailRow>
            ) : (
              d.ingress.map((r, i) => (
                <NetPolicyRuleBlock
                  key={i}
                  t={t}
                  rule={r}
                  index={i}
                  direction="from"
                  onNavigate={props.onNavigate}
                />
              ))
            )}
          </div>
        </>
      )}

      {egressActive && (
        <>
          <Section
            t={t}
            title="Egress"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.egress.length === 0
                  ? "deny all"
                  : `${d.egress.length} rule${d.egress.length === 1 ? "" : "s"}`}
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.egress.length === 0 ? (
              <DetailRow t={t} label="—">
                <span style={{ fontSize: 12, color: t.bad }}>
                  Empty egress list — all outbound traffic is denied.
                </span>
              </DetailRow>
            ) : (
              d.egress.map((r, i) => (
                <NetPolicyRuleBlock
                  key={i}
                  t={t}
                  rule={r}
                  index={i}
                  direction="to"
                  onNavigate={props.onNavigate}
                />
              ))
            )}
          </div>
        </>
      )}
    </Frame>
  );
}

function NetPolicyRuleBlock({
  t,
  rule,
  index,
  direction,
  onNavigate,
}: {
  t: Tokens;
  rule: NetworkPolicyRule;
  index: number;
  direction: "from" | "to";
  onNavigate?: DetailNavigate;
}) {
  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 8,
        marginBottom: 10,
        background: t.surface,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: t.textMuted,
          fontFamily: FONT_MONO,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Rule #{index + 1}
      </div>
      <DetailRow t={t} label="Ports">
        {rule.ports.length === 0 ? (
          <Mute t={t}>(all ports)</Mute>
        ) : (
          <ChipWrap>
            {rule.ports.map((p, i) => (
              <NetPolicyPortChip key={i} t={t} port={p} />
            ))}
          </ChipWrap>
        )}
      </DetailRow>
      <DetailRow t={t} label={direction === "from" ? "From" : "To"}>
        {rule.peers.length === 0 ? (
          <Mute t={t}>(any source)</Mute>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              width: "100%",
            }}
          >
            {rule.peers.map((p, i) => (
              <NetPolicyPeerRow
                key={i}
                t={t}
                peer={p}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </DetailRow>
    </div>
  );
}

function NetPolicyPortChip({ t, port }: { t: Tokens; port: NetworkPolicyPort }) {
  const portStr = port.port ?? "all";
  const range = port.end_port != null ? `-${port.end_port}` : "";
  const label = `${port.protocol}: ${portStr}${range}`;
  return (
    <Copyable text={label}>
      <Chip t={t} mono>
        {label}
      </Chip>
    </Copyable>
  );
}

function NetPolicyPeerRow({
  t,
  peer,
  onNavigate: _onNavigate,
}: {
  t: Tokens;
  peer: NetworkPolicyPeer;
  onNavigate?: DetailNavigate;
}) {
  const parts: React.ReactNode[] = [];
  if (peer.ip_block) {
    parts.push(
      <span key="ip" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11.5, color: t.textDim }}>ipBlock</span>
        <Copyable text={peer.ip_block.cidr}>
          <Chip t={t} mono>
            {peer.ip_block.cidr}
          </Chip>
        </Copyable>
        {peer.ip_block.except.length > 0 && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            except {peer.ip_block.except.join(", ")}
          </span>
        )}
      </span>,
    );
  }
  if (peer.namespace_selector) {
    parts.push(
      <span key="ns" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11.5, color: t.textDim }}>namespaces</span>
        <SelectorBlock t={t} selector={peer.namespace_selector} />
      </span>,
    );
  }
  if (peer.pod_selector) {
    parts.push(
      <span key="pod" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11.5, color: t.textDim }}>pods</span>
        <SelectorBlock t={t} selector={peer.pod_selector} />
      </span>,
    );
  }
  if (parts.length === 0) parts.push(<Mute key="empty" t={t}>—</Mute>);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        alignItems: "center",
      }}
    >
      {parts}
    </div>
  );
}
