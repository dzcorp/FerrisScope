// Gateway API detail summaries. Same pattern as the other family files —
// each kind fetches via the generic well-known detail getter, then composes
// the standard primitives.

import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Loading, Section, StatusPill } from "../../ui";
import {
  Copyable,
  DetailRow,
  LinkValue,
  Mute,
  type DetailNavigate,
} from "..";
import { MetaSection } from "../workload/shared";
import type {
  GatewayClassDetail,
  GatewayDetail,
  GatewayCondition,
  ReferenceGrantDetail,
  RouteDetail,
} from "../../../types";

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
      }}
    >
      {message}
    </pre>
  );
}

function ConditionsBlock({
  t,
  conditions,
}: {
  t: Tokens;
  conditions: GatewayCondition[];
}) {
  if (conditions.length === 0) return null;
  return (
    <>
      <Section t={t} title="Conditions" />
      <div style={{ marginBottom: 22 }}>
        {conditions.map((c, i) => (
          <DetailRow key={i} t={t} label={c.type ?? "—"}>
            <span style={{ fontSize: 12 }}>
              {c.status ?? "—"}
              {c.reason ? ` — ${c.reason}` : ""}
              {c.message ? `: ${c.message}` : ""}
            </span>
          </DetailRow>
        ))}
      </div>
    </>
  );
}

// ── GatewayClass ───────────────────────────────────────────────────────────

export function GatewayClassSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<GatewayClassDetail>(
    () =>
      api.getWellKnownDetail<GatewayClassDetail>(
        props.clusterId,
        props.kindId,
        null,
        props.name,
      ),
    [props.clusterId, props.kindId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading gateway class…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  return (
    <Frame t={t}>
      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: props.kindId,
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
                  fontSize: 12,
                  fontFamily: FONT_MONO,
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
        {d.description && (
          <DetailRow t={t} label="Description">
            <span style={{ fontSize: 12, wordBreak: "break-word" }}>
              {d.description}
            </span>
          </DetailRow>
        )}
      </div>
      <ConditionsBlock t={t} conditions={d.conditions} />
    </Frame>
  );
}

// ── Gateway ────────────────────────────────────────────────────────────────

export function GatewaySummary(props: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<GatewayDetail>(
    () =>
      api.getWellKnownDetail<GatewayDetail>(
        props.clusterId,
        props.kindId,
        ns,
        props.name,
      ),
    [props.clusterId, props.kindId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="Gateway requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading gateway…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  return (
    <Frame t={t}>
      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: props.kindId,
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />
      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Class">
          {d.gateway_class_name ? (
            <LinkValue
              t={t}
              onClick={() =>
                props.onNavigate?.("GatewayClass", null, d.gateway_class_name!)
              }
              copyText={d.gateway_class_name}
              enabled={!!props.onNavigate}
            >
              {d.gateway_class_name}
            </LinkValue>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
      </div>

      <Section t={t} title="Listeners" right={`${d.listeners.length} total`} />
      <div style={{ marginBottom: 22 }}>
        {d.listeners.length === 0 ? (
          <Mute t={t}>No listeners.</Mute>
        ) : (
          d.listeners.map((l, i) => {
            const status = d.listener_status.find((s) => s.name === l.name);
            return (
              <DetailRow key={i} t={t} label={l.name ?? `listener-${i}`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                    {l.protocol ?? "—"}:{l.port ?? "—"}
                    {l.hostname ? ` host=${l.hostname}` : ""}
                    {l.tls_mode ? ` tls=${l.tls_mode}` : ""}
                  </span>
                  {status?.attached_routes != null && (
                    <span style={{ fontSize: 11, color: t.textMuted }}>
                      {status.attached_routes} attached route
                      {status.attached_routes === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </DetailRow>
            );
          })
        )}
      </div>

      {d.addresses.length > 0 && (
        <>
          <Section t={t} title="Addresses" />
          <div style={{ marginBottom: 22 }}>
            {d.addresses.map((a, i) => (
              <DetailRow key={i} t={t} label={a.type ?? "Address"}>
                {a.value ? (
                  <Copyable text={a.value}>
                    <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                      {a.value}
                    </span>
                  </Copyable>
                ) : (
                  <Mute t={t}>—</Mute>
                )}
              </DetailRow>
            ))}
          </div>
        </>
      )}

      <ConditionsBlock t={t} conditions={d.conditions} />
    </Frame>
  );
}

// ── HTTPRoute / GRPCRoute (shared shape) ───────────────────────────────────

export function RouteSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
  label: string;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<RouteDetail>(
    () =>
      api.getWellKnownDetail<RouteDetail>(
        props.clusterId,
        props.kindId,
        ns,
        props.name,
      ),
    [props.clusterId, props.kindId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return (
      <ErrorBlock t={t} message={`${props.label} requires a namespace.`} />
    );
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label={`Loading ${props.label.toLowerCase()}…`} inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  return (
    <Frame t={t}>
      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: props.kindId,
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      {d.hostnames.length > 0 && (
        <>
          <Section t={t} title="Hostnames" right={`${d.hostnames.length} total`} />
          <div style={{ marginBottom: 22 }}>
            {d.hostnames.map((h, i) => (
              <DetailRow key={i} t={t} label="">
                <Copyable text={h}>
                  <span
                    style={{
                      fontSize: 12,
                      fontFamily: FONT_MONO,
                      wordBreak: "break-all",
                    }}
                  >
                    {h}
                  </span>
                </Copyable>
              </DetailRow>
            ))}
          </div>
        </>
      )}

      <Section t={t} title="Parents" right={`${d.parent_refs.length} total`} />
      <div style={{ marginBottom: 22 }}>
        {d.parent_refs.length === 0 ? (
          <Mute t={t}>No parent refs.</Mute>
        ) : (
          d.parent_refs.map((p, i) => (
            <DetailRow key={i} t={t} label={p.kind ?? "Gateway"}>
              {p.name ? (
                <LinkValue
                  t={t}
                  onClick={() =>
                    props.onNavigate?.(p.kind ?? "Gateway", p.namespace ?? ns, p.name!)
                  }
                  copyText={p.name}
                  enabled={!!props.onNavigate}
                >
                  {p.namespace ? `${p.namespace}/${p.name}` : p.name}
                  {p.section_name ? `:${p.section_name}` : ""}
                  {p.port != null ? ` :${p.port}` : ""}
                </LinkValue>
              ) : (
                <Mute t={t}>—</Mute>
              )}
            </DetailRow>
          ))
        )}
      </div>

      <Section t={t} title="Rules" right={`${d.rules.length} total`} />
      <div style={{ marginBottom: 22 }}>
        {d.rules.length === 0 ? (
          <Mute t={t}>No rules.</Mute>
        ) : (
          d.rules.map((r, i) => (
            <DetailRow key={i} t={t} label={`rule ${i + 1}`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12 }}>
                  {r.matches} match{r.matches === 1 ? "" : "es"} · {r.filters} filter
                  {r.filters === 1 ? "" : "s"}
                </span>
                {r.backends.map((b, bi) => (
                  <span
                    key={bi}
                    style={{
                      fontSize: 11.5,
                      fontFamily: FONT_MONO,
                      color: t.textMuted,
                    }}
                  >
                    → {b.namespace ? `${b.namespace}/` : ""}
                    {b.name}
                    {b.port != null ? `:${b.port}` : ""}
                    {b.weight != null ? ` w=${b.weight}` : ""}
                  </span>
                ))}
              </div>
            </DetailRow>
          ))
        )}
      </div>

      {d.parent_status.length > 0 && (
        <>
          <Section
            t={t}
            title="Parent Status"
            right={`${d.parent_status.length} total`}
          />
          <div style={{ marginBottom: 22 }}>
            {d.parent_status.map((ps, i) => {
              const accepted = ps.conditions.find((c) => c.type === "Accepted");
              const refsResolved = ps.conditions.find(
                (c) => c.type === "ResolvedRefs",
              );
              return (
                <DetailRow
                  key={i}
                  t={t}
                  label={ps.parent?.name ?? `parent-${i}`}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    {accepted && (
                      <StatusPill
                        status={`Accepted=${accepted.status}`}
                        t={t}
                        mode={props.mode}
                        dense
                      />
                    )}
                    {refsResolved && (
                      <StatusPill
                        status={`ResolvedRefs=${refsResolved.status}`}
                        t={t}
                        mode={props.mode}
                        dense
                      />
                    )}
                    {ps.controller && (
                      <span
                        style={{
                          fontSize: 11,
                          color: t.textMuted,
                          fontFamily: FONT_MONO,
                        }}
                      >
                        by {ps.controller}
                      </span>
                    )}
                  </div>
                </DetailRow>
              );
            })}
          </div>
        </>
      )}
    </Frame>
  );
}

// ── ReferenceGrant ─────────────────────────────────────────────────────────

export function ReferenceGrantSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<ReferenceGrantDetail>(
    () =>
      api.getWellKnownDetail<ReferenceGrantDetail>(
        props.clusterId,
        props.kindId,
        ns,
        props.name,
      ),
    [props.clusterId, props.kindId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="ReferenceGrant requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading reference grant…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  return (
    <Frame t={t}>
      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: props.kindId,
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="From" right={`${d.from.length} total`} />
      <div style={{ marginBottom: 22 }}>
        {d.from.length === 0 ? (
          <Mute t={t}>—</Mute>
        ) : (
          d.from.map((f, i) => (
            <DetailRow key={i} t={t} label={f.kind ?? "—"}>
              <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                {f.namespace ?? "—"}
                {f.group ? ` (${f.group})` : ""}
              </span>
            </DetailRow>
          ))
        )}
      </div>

      <Section t={t} title="To" right={`${d.to.length} total`} />
      <div style={{ marginBottom: 22 }}>
        {d.to.length === 0 ? (
          <Mute t={t}>—</Mute>
        ) : (
          d.to.map((to, i) => (
            <DetailRow key={i} t={t} label={to.kind ?? "—"}>
              <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                {to.name ?? "*"}
                {to.group ? ` (${to.group})` : ""}
              </span>
            </DetailRow>
          ))
        )}
      </div>
    </Frame>
  );
}
