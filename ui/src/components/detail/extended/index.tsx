// Per-kind detail summaries for the second-tier kinds (HPA, PDB, PriorityClass,
// ReplicationController, Lease, Mutating/ValidatingWebhookConfiguration). Same
// shape as the existing family files: useDetail → fetch → compose primitives.

import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { ErrorBlock, LoadingLine, Section, StatusPill } from "../../ui";
import {
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { MetaSection } from "../workload/shared";
import type {
  AdmissionWebhook,
  HorizontalPodAutoscalerDetail,
  LeaseDetail,
  MutatingWebhookConfigurationDetail,
  PodDisruptionBudgetDetail,
  PriorityClassDetail,
  ReplicationControllerDetail,
  ValidatingWebhookConfigurationDetail,
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

function NamespaceGuard({
  t,
  ns,
  label,
  children,
}: {
  t: Tokens;
  ns: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!ns)
    return <ErrorBlock t={t} message={`${label} requires a namespace.`} />;
  return <>{children}</>;
}

// ── HorizontalPodAutoscaler ────────────────────────────────────────────────

export function HorizontalPodAutoscalerSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<HorizontalPodAutoscalerDetail>(
    () => api.getHorizontalPodAutoscalerDetail(props.clusterId, ns ?? "", props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  return (
    <NamespaceGuard t={t} ns={ns} label="HorizontalPodAutoscaler">
      {state.kind === "loading" ? (
        <Frame t={t}>
          <LoadingLine t={t} label="Loading hpa…"/>
        </Frame>
      ) : state.kind === "error" ? (
        <ErrorBlock t={t} message={state.message} kindLabel="hpa" />
      ) : (
        <Frame t={t}>
          <MetaSection
            t={t}
            meta={state.detail.meta}
            onNavigate={props.onNavigate}
            editTarget={{
              clusterId: props.clusterId,
              kindId: "horizontalpodautoscalers",
              namespace: ns,
              name: props.name,
            }}
            onSaved={() => setRefetch((r) => r + 1)}
          />
          <Section t={t} title="Scale Target" />
          <div style={{ marginBottom: 22 }}>
            {state.detail.scale_target_ref ? (
              <>
                <DetailRow t={t} label="Kind">
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                    {state.detail.scale_target_ref.kind}
                  </span>
                </DetailRow>
                <DetailRow t={t} label="Name">
                  <LinkValue
                    t={t}
                    onClick={() =>
                      props.onNavigate?.(
                        state.detail.scale_target_ref!.kind,
                        ns,
                        state.detail.scale_target_ref!.name,
                      )
                    }
                    copyText={state.detail.scale_target_ref.name}
                    enabled={!!props.onNavigate}
                  >
                    {state.detail.scale_target_ref.name}
                  </LinkValue>
                </DetailRow>
                {state.detail.scale_target_ref.api_version && (
                  <DetailRow t={t} label="API Version">
                    <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                      {state.detail.scale_target_ref.api_version}
                    </span>
                  </DetailRow>
                )}
              </>
            ) : (
              <Mute t={t}>—</Mute>
            )}
          </div>

          <Section t={t} title="Replicas" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Min">
              <span style={{ fontSize: 12 }}>
                {state.detail.min_replicas ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Max">
              <span style={{ fontSize: 12 }}>{state.detail.max_replicas}</span>
            </DetailRow>
            <DetailRow t={t} label="Current">
              <span style={{ fontSize: 12 }}>
                {state.detail.current_replicas ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Desired">
              <span style={{ fontSize: 12 }}>
                {state.detail.desired_replicas ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            {state.detail.last_scale_time && (
              <DetailRow t={t} label="Last Scaled">
                <Copyable text={state.detail.last_scale_time}>
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                    {ageFromIso(state.detail.last_scale_time)} ago
                  </span>
                </Copyable>
              </DetailRow>
            )}
          </div>

          {state.detail.metrics.length > 0 && (
            <>
              <Section
                t={t}
                title="Metrics"
                right={`${state.detail.metrics.length} total`}
              />
              <div style={{ marginBottom: 22 }}>
                {state.detail.metrics.map((m, i) => (
                  <DetailRow key={i} t={t} label={m.type}>
                    <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                      {m.name ?? m.metric_name ?? "—"}
                      {m.target?.average_utilization != null
                        ? ` @ ${m.target.average_utilization}%`
                        : m.target?.average_value
                          ? ` @ avg ${m.target.average_value}`
                          : m.target?.value
                            ? ` @ ${m.target.value}`
                            : ""}
                    </span>
                  </DetailRow>
                ))}
              </div>
            </>
          )}

          {state.detail.conditions.length > 0 && (
            <>
              <Section t={t} title="Conditions" />
              <div style={{ marginBottom: 22 }}>
                {state.detail.conditions.map((c, i) => (
                  <DetailRow key={i} t={t} label={c.type}>
                    <span style={{ fontSize: 12 }}>
                      {c.status}
                      {c.reason ? ` — ${c.reason}` : ""}
                    </span>
                  </DetailRow>
                ))}
              </div>
            </>
          )}
        </Frame>
      )}
    </NamespaceGuard>
  );
}

// ── PodDisruptionBudget ────────────────────────────────────────────────────

export function PodDisruptionBudgetSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<PodDisruptionBudgetDetail>(
    () => api.getPodDisruptionBudgetDetail(props.clusterId, ns ?? "", props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  return (
    <NamespaceGuard t={t} ns={ns} label="PodDisruptionBudget">
      {state.kind === "loading" ? (
        <Frame t={t}>
          <LoadingLine t={t} label="Loading pdb…"/>
        </Frame>
      ) : state.kind === "error" ? (
        <ErrorBlock t={t} message={state.message} kindLabel="pdb" />
      ) : (
        <Frame t={t}>
          <MetaSection
            t={t}
            meta={state.detail.meta}
            onNavigate={props.onNavigate}
            editTarget={{
              clusterId: props.clusterId,
              kindId: "poddisruptionbudgets",
              namespace: ns,
              name: props.name,
            }}
            onSaved={() => setRefetch((r) => r + 1)}
          />
          <Section t={t} title="Spec" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Min Available">
              <span style={{ fontSize: 12 }}>
                {state.detail.min_available ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Max Unavailable">
              <span style={{ fontSize: 12 }}>
                {state.detail.max_unavailable ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            {state.detail.unhealthy_pod_eviction_policy && (
              <DetailRow t={t} label="Eviction Policy">
                <span style={{ fontSize: 12 }}>
                  {state.detail.unhealthy_pod_eviction_policy}
                </span>
              </DetailRow>
            )}
            {state.detail.selector && (
              <DetailRow t={t} label="Selector">
                {state.detail.selector.match_labels.length > 0 ? (
                  <KeyValueChips t={t} pairs={state.detail.selector.match_labels} />
                ) : (
                  <Mute t={t}>—</Mute>
                )}
              </DetailRow>
            )}
          </div>

          <Section t={t} title="Status" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Current Healthy">
              <span style={{ fontSize: 12 }}>{state.detail.current_healthy}</span>
            </DetailRow>
            <DetailRow t={t} label="Desired Healthy">
              <span style={{ fontSize: 12 }}>{state.detail.desired_healthy}</span>
            </DetailRow>
            <DetailRow t={t} label="Expected Pods">
              <span style={{ fontSize: 12 }}>{state.detail.expected_pods}</span>
            </DetailRow>
            <DetailRow t={t} label="Disruptions Allowed">
              <span style={{ fontSize: 12 }}>{state.detail.disruptions_allowed}</span>
            </DetailRow>
          </div>

          {state.detail.conditions.length > 0 && (
            <>
              <Section t={t} title="Conditions" />
              <div style={{ marginBottom: 22 }}>
                {state.detail.conditions.map((c, i) => (
                  <DetailRow key={i} t={t} label={c.type}>
                    <span style={{ fontSize: 12 }}>
                      {c.status}
                      {c.reason ? ` — ${c.reason}` : ""}
                    </span>
                  </DetailRow>
                ))}
              </div>
            </>
          )}
        </Frame>
      )}
    </NamespaceGuard>
  );
}

// ── PriorityClass ──────────────────────────────────────────────────────────

export function PriorityClassSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<PriorityClassDetail>(
    () => api.getPriorityClassDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading priority class…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="priority class" />;

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
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            fontWeight: 600,
            color: t.text,
          }}
        >
          value {d.value}
        </span>
        {d.global_default && (
          <StatusPill status="Global Default" t={t} mode={props.mode} dense />
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "priorityclasses",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Value">
          <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>{d.value}</span>
        </DetailRow>
        <DetailRow t={t} label="Global Default">
          <span style={{ fontSize: 12 }}>{d.global_default ? "true" : "false"}</span>
        </DetailRow>
        <DetailRow t={t} label="Preemption">
          <span style={{ fontSize: 12 }}>
            {d.preemption_policy ?? <Mute t={t}>—</Mute>}
          </span>
        </DetailRow>
        {d.description && (
          <DetailRow t={t} label="Description">
            <Copyable text={d.description}>
              <span style={{ fontSize: 12, wordBreak: "break-word" }}>
                {d.description}
              </span>
            </Copyable>
          </DetailRow>
        )}
      </div>
    </Frame>
  );
}

// ── ReplicationController ──────────────────────────────────────────────────

export function ReplicationControllerSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<ReplicationControllerDetail>(
    () => api.getReplicationControllerDetail(props.clusterId, ns ?? "", props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  return (
    <NamespaceGuard t={t} ns={ns} label="ReplicationController">
      {state.kind === "loading" ? (
        <Frame t={t}>
          <LoadingLine t={t} label="Loading rc…"/>
        </Frame>
      ) : state.kind === "error" ? (
        <ErrorBlock t={t} message={state.message} kindLabel="replication controller" />
      ) : (
        <Frame t={t}>
          <MetaSection
            t={t}
            meta={state.detail.meta}
            onNavigate={props.onNavigate}
            editTarget={{
              clusterId: props.clusterId,
              kindId: "replicationcontrollers",
              namespace: ns,
              name: props.name,
            }}
            onSaved={() => setRefetch((r) => r + 1)}
          />
          <Section t={t} title="Spec" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Replicas">
              <span style={{ fontSize: 12 }}>
                {state.detail.replicas ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Min Ready">
              <span style={{ fontSize: 12 }}>
                {state.detail.min_ready_seconds ?? 0}s
              </span>
            </DetailRow>
            <DetailRow t={t} label="Selector">
              {state.detail.selector.length > 0 ? (
                <KeyValueChips t={t} pairs={state.detail.selector} />
              ) : (
                <Mute t={t}>—</Mute>
              )}
            </DetailRow>
          </div>

          <Section t={t} title="Status" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Current">
              <span style={{ fontSize: 12 }}>{state.detail.current}</span>
            </DetailRow>
            <DetailRow t={t} label="Ready">
              <span style={{ fontSize: 12 }}>
                {state.detail.ready ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Available">
              <span style={{ fontSize: 12 }}>
                {state.detail.available ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Fully Labeled">
              <span style={{ fontSize: 12 }}>
                {state.detail.fully_labeled ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Observed Generation">
              <span style={{ fontSize: 12 }}>
                {state.detail.observed_generation ?? <Mute t={t}>—</Mute>}
              </span>
            </DetailRow>
          </div>

          {state.detail.conditions.length > 0 && (
            <>
              <Section t={t} title="Conditions" />
              <div style={{ marginBottom: 22 }}>
                {state.detail.conditions.map((c, i) => (
                  <DetailRow key={i} t={t} label={c.type}>
                    <span style={{ fontSize: 12 }}>
                      {c.status}
                      {c.reason ? ` — ${c.reason}` : ""}
                    </span>
                  </DetailRow>
                ))}
              </div>
            </>
          )}
        </Frame>
      )}
    </NamespaceGuard>
  );
}

// ── Lease ──────────────────────────────────────────────────────────────────

export function LeaseSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<LeaseDetail>(
    () => api.getLeaseDetail(props.clusterId, ns ?? "", props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  return (
    <NamespaceGuard t={t} ns={ns} label="Lease">
      {state.kind === "loading" ? (
        <Frame t={t}>
          <LoadingLine t={t} label="Loading lease…"/>
        </Frame>
      ) : state.kind === "error" ? (
        <ErrorBlock t={t} message={state.message} kindLabel="lease" />
      ) : (
        <Frame t={t}>
          <MetaSection
            t={t}
            meta={state.detail.meta}
            onNavigate={props.onNavigate}
            editTarget={{
              clusterId: props.clusterId,
              kindId: "leases",
              namespace: ns,
              name: props.name,
            }}
            onSaved={() => setRefetch((r) => r + 1)}
          />
          <Section t={t} title="Spec" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Holder Identity">
              {state.detail.holder_identity ? (
                <Copyable text={state.detail.holder_identity}>
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO, wordBreak: "break-all" }}>
                    {state.detail.holder_identity}
                  </span>
                </Copyable>
              ) : (
                <Mute t={t}>—</Mute>
              )}
            </DetailRow>
            <DetailRow t={t} label="Duration">
              <span style={{ fontSize: 12 }}>
                {state.detail.lease_duration_seconds ?? <Mute t={t}>—</Mute>}
                {state.detail.lease_duration_seconds != null ? "s" : ""}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Transitions">
              <span style={{ fontSize: 12 }}>
                {state.detail.lease_transitions ?? 0}
              </span>
            </DetailRow>
            <DetailRow t={t} label="Acquired">
              {state.detail.acquire_time ? (
                <Copyable text={state.detail.acquire_time}>
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                    {ageFromIso(state.detail.acquire_time)} ago
                  </span>
                </Copyable>
              ) : (
                <Mute t={t}>—</Mute>
              )}
            </DetailRow>
            <DetailRow t={t} label="Renewed">
              {state.detail.renew_time ? (
                <Copyable text={state.detail.renew_time}>
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                    {ageFromIso(state.detail.renew_time)} ago
                  </span>
                </Copyable>
              ) : (
                <Mute t={t}>—</Mute>
              )}
            </DetailRow>
          </div>
        </Frame>
      )}
    </NamespaceGuard>
  );
}

// ── Mutating / Validating Webhook Configurations ───────────────────────────

function WebhookList({
  t,
  webhooks,
  mode,
  showReinvocation,
}: {
  t: Tokens;
  webhooks: AdmissionWebhook[];
  mode: ThemeMode;
  showReinvocation: boolean;
}) {
  return (
    <>
      <Section t={t} title="Webhooks" right={`${webhooks.length} total`} />
      {webhooks.length === 0 ? (
        <div style={{ marginBottom: 22 }}>
          <Mute t={t}>No webhooks defined.</Mute>
        </div>
      ) : (
        webhooks.map((w, i) => (
          <div key={i} style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Name">
              <Copyable text={w.name}>
                <span style={{ fontSize: 12, fontFamily: FONT_MONO, wordBreak: "break-all" }}>
                  {w.name}
                </span>
              </Copyable>
            </DetailRow>
            {w.client_config.service && (
              <DetailRow t={t} label="Service">
                <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                  {w.client_config.service.namespace}/{w.client_config.service.name}
                  {w.client_config.service.path ?? ""}
                  {w.client_config.service.port != null
                    ? `:${w.client_config.service.port}`
                    : ""}
                </span>
              </DetailRow>
            )}
            {w.client_config.url && (
              <DetailRow t={t} label="URL">
                <Copyable text={w.client_config.url}>
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO, wordBreak: "break-all" }}>
                    {w.client_config.url}
                  </span>
                </Copyable>
              </DetailRow>
            )}
            <DetailRow t={t} label="CA Bundle">
              <span style={{ fontSize: 12 }}>
                {w.client_config.ca_bundle_present ? "present" : "—"}
              </span>
            </DetailRow>
            {w.failure_policy && (
              <DetailRow t={t} label="Failure Policy">
                <StatusPill
                  status={w.failure_policy}
                  t={t}
                  mode={mode}
                  dense
                />
              </DetailRow>
            )}
            {w.match_policy && (
              <DetailRow t={t} label="Match Policy">
                <span style={{ fontSize: 12 }}>{w.match_policy}</span>
              </DetailRow>
            )}
            {w.side_effects && (
              <DetailRow t={t} label="Side Effects">
                <span style={{ fontSize: 12 }}>{w.side_effects}</span>
              </DetailRow>
            )}
            {w.timeout_seconds != null && (
              <DetailRow t={t} label="Timeout">
                <span style={{ fontSize: 12 }}>{w.timeout_seconds}s</span>
              </DetailRow>
            )}
            {showReinvocation && w.reinvocation_policy && (
              <DetailRow t={t} label="Reinvocation">
                <span style={{ fontSize: 12 }}>{w.reinvocation_policy}</span>
              </DetailRow>
            )}
            {w.admission_review_versions &&
              w.admission_review_versions.length > 0 && (
                <DetailRow t={t} label="Review Versions">
                  <span style={{ fontSize: 12, fontFamily: FONT_MONO }}>
                    {w.admission_review_versions.join(", ")}
                  </span>
                </DetailRow>
              )}
            {w.rules.length > 0 && (
              <DetailRow t={t} label="Rules">
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {w.rules.map((r, ri) => (
                    <span
                      key={ri}
                      style={{ fontSize: 11.5, fontFamily: FONT_MONO, wordBreak: "break-all" }}
                    >
                      {r.operations.join(",")} {r.api_groups.join(",") || "core"}/
                      {r.api_versions.join(",")} {r.resources.join(",")}
                      {r.scope ? ` [${r.scope}]` : ""}
                    </span>
                  ))}
                </div>
              </DetailRow>
            )}
          </div>
        ))
      )}
    </>
  );
}

export function MutatingWebhookConfigurationSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<MutatingWebhookConfigurationDetail>(
    () => api.getMutatingWebhookConfigurationDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading mutating webhook…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="mutating webhook configuration" />;

  return (
    <Frame t={t}>
      <MetaSection
        t={t}
        meta={state.detail.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "mutatingwebhookconfigurations",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />
      <WebhookList
        t={t}
        webhooks={state.detail.webhooks}
        mode={props.mode}
        showReinvocation
      />
    </Frame>
  );
}

export function ValidatingWebhookConfigurationSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<ValidatingWebhookConfigurationDetail>(
    () => api.getValidatingWebhookConfigurationDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading validating webhook…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="validating webhook configuration" />;

  return (
    <Frame t={t}>
      <MetaSection
        t={t}
        meta={state.detail.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "validatingwebhookconfigurations",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />
      <WebhookList
        t={t}
        webhooks={state.detail.webhooks}
        mode={props.mode}
        showReinvocation={false}
      />
    </Frame>
  );
}
