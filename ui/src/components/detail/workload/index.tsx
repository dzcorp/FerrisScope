// Per-kind detail summary components for the workload family. Each one
// fetches its typed projection on mount + on detailVersion bumps, and
// composes the shared workload primitives (`MetaSection`, `SelectorRow`,
// `ConditionsSection`, `PodTemplateSection`) plus a kind-specific block.

import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Section, StatusPill, LoadingLine } from "../../ui";
import {
  Copyable,
  DetailRow,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import type {
  CronJobDetail,
  DaemonSetDetail,
  DeploymentDetail,
  JobDetail,
  ReplicaSetDetail,
  RollingUpdateSummary,
  StatefulSetDetail,
} from "../../../types";
import {
  ConditionsSection,
  MetaSection,
  PodTemplateSection,
  ReplicaCounts,
  SelectorRow,
} from "./shared";

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
    // snap the scroll container back to the top after every action (cordon,
    // restart, save…). R-01: no spinner on poll.
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

function Frame({
  t,
  children,
}: {
  t: Tokens;
  children: React.ReactNode;
}) {
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

function StrategyChips({
  t,
  strategy,
  label = "Strategy",
}: {
  t: Tokens;
  strategy: RollingUpdateSummary | null;
  label?: string;
}) {
  if (!strategy) return null;
  return (
    <DetailRow t={t} label={label}>
      <span style={{ fontSize: 12 }}>{strategy.type}</span>
      {strategy.max_surge != null && (
        <span style={{ fontSize: 11.5, color: t.textDim, marginLeft: 8 }}>
          maxSurge={strategy.max_surge}
        </span>
      )}
      {strategy.max_unavailable != null && (
        <span style={{ fontSize: 11.5, color: t.textDim, marginLeft: 8 }}>
          maxUnavailable={strategy.max_unavailable}
        </span>
      )}
      {strategy.partition != null && (
        <span style={{ fontSize: 11.5, color: t.textDim, marginLeft: 8 }}>
          partition={strategy.partition}
        </span>
      )}
    </DetailRow>
  );
}

// ── Deployment ─────────────────────────────────────────────────────────────

export function DeploymentSummary(props: {
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
  const state = useDetail<DeploymentDetail>(
    () => api.getDeploymentDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="Deployment requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading deployment…" inline />
      </Frame>
    );
  if (state.kind === "error") return <ErrorBlock t={t} message={state.message} />;

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
        <ReplicaCounts
          t={t}
          ready={d.replicas.ready}
          desired={d.replicas.desired}
        />
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.replicas.updated} up-to-date · {d.replicas.available} available
          {d.replicas.unavailable > 0
            ? ` · ${d.replicas.unavailable} unavailable`
            : ""}
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
        </span>
        {d.paused && (
          <StatusPill status="Paused" t={t} mode={props.mode} dense />
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "deployments",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Replicas">
          <SubGridReplicas
            t={t}
            entries={[
              ["desired", d.replicas.desired],
              ["current", d.replicas.current],
              ["ready", d.replicas.ready],
              ["available", d.replicas.available],
              ["updated", d.replicas.updated],
              ["unavailable", d.replicas.unavailable],
            ]}
          />
        </DetailRow>
        <SelectorRow t={t} selector={d.selector} />
        <StrategyChips t={t} strategy={d.strategy} />
        {d.min_ready_seconds != null && d.min_ready_seconds > 0 && (
          <DetailRow t={t} label="Min Ready">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.min_ready_seconds}s
            </span>
          </DetailRow>
        )}
        {d.progress_deadline_seconds != null && (
          <DetailRow t={t} label="Progress Deadline">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.progress_deadline_seconds}s
            </span>
          </DetailRow>
        )}
        {d.revision_history_limit != null && (
          <DetailRow t={t} label="Revision History">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.revision_history_limit}
            </span>
          </DetailRow>
        )}
        {d.observed_generation != null && (
          <DetailRow t={t} label="Observed Generation">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.observed_generation}
            </span>
          </DetailRow>
        )}
      </div>

      <ConditionsSection t={t} conditions={d.conditions} />
      {d.pod_template && (
        <PodTemplateSection
          t={t}
          template={d.pod_template}
          namespace={d.meta.namespace}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "deployments",
            namespace: ns,
            name: props.name,
          }}
          onSaved={() => setRefetch((r) => r + 1)}
        />
      )}
    </Frame>
  );
}

// ── ReplicaSet ─────────────────────────────────────────────────────────────

export function ReplicaSetSummary(props: {
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
  const state = useDetail<ReplicaSetDetail>(
    () => api.getReplicaSetDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="ReplicaSet requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading replica set…" inline />
      </Frame>
    );
  if (state.kind === "error") return <ErrorBlock t={t} message={state.message} />;

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
        <ReplicaCounts
          t={t}
          ready={d.replicas.ready}
          desired={d.replicas.desired}
        />
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.replicas.current} current · {d.replicas.available} available
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "replicasets",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Replicas">
          <SubGridReplicas
            t={t}
            entries={[
              ["desired", d.replicas.desired],
              ["current", d.replicas.current],
              ["ready", d.replicas.ready],
              ["available", d.replicas.available],
              ["fully labeled", d.replicas.fully_labeled],
            ]}
          />
        </DetailRow>
        <SelectorRow t={t} selector={d.selector} />
        {d.min_ready_seconds != null && d.min_ready_seconds > 0 && (
          <DetailRow t={t} label="Min Ready">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.min_ready_seconds}s
            </span>
          </DetailRow>
        )}
        {d.observed_generation != null && (
          <DetailRow t={t} label="Observed Generation">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.observed_generation}
            </span>
          </DetailRow>
        )}
      </div>

      <ConditionsSection t={t} conditions={d.conditions} />
      {d.pod_template && (
        <PodTemplateSection
          t={t}
          template={d.pod_template}
          namespace={d.meta.namespace}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "replicasets",
            namespace: ns,
            name: props.name,
          }}
          onSaved={() => setRefetch((r) => r + 1)}
        />
      )}
    </Frame>
  );
}

// ── StatefulSet ────────────────────────────────────────────────────────────

export function StatefulSetSummary(props: {
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
  const state = useDetail<StatefulSetDetail>(
    () => api.getStatefulSetDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="StatefulSet requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading stateful set…" inline />
      </Frame>
    );
  if (state.kind === "error") return <ErrorBlock t={t} message={state.message} />;

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
        <ReplicaCounts
          t={t}
          ready={d.replicas.ready}
          desired={d.replicas.desired}
        />
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.replicas.current} current · {d.replicas.updated} updated ·{" "}
          {d.replicas.available} available
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "statefulsets",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Replicas">
          <SubGridReplicas
            t={t}
            entries={[
              ["desired", d.replicas.desired],
              ["current", d.replicas.current],
              ["ready", d.replicas.ready],
              ["available", d.replicas.available],
              ["updated", d.replicas.updated],
            ]}
          />
        </DetailRow>
        <SelectorRow t={t} selector={d.selector} />
        {d.service_name && (
          <DetailRow t={t} label="Service">
            <Copyable text={d.service_name}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {d.service_name}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.pod_management_policy && (
          <DetailRow t={t} label="Pod Management">
            <span style={{ fontSize: 12 }}>{d.pod_management_policy}</span>
          </DetailRow>
        )}
        <StrategyChips
          t={t}
          strategy={d.update_strategy}
          label="Update Strategy"
        />
        {d.current_revision && (
          <DetailRow t={t} label="Current Revision">
            <Copyable text={d.current_revision}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>
                {d.current_revision}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.update_revision &&
          d.update_revision !== d.current_revision && (
            <DetailRow t={t} label="Update Revision">
              <Copyable text={d.update_revision}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>
                  {d.update_revision}
                </span>
              </Copyable>
            </DetailRow>
          )}
        {d.observed_generation != null && (
          <DetailRow t={t} label="Observed Generation">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.observed_generation}
            </span>
          </DetailRow>
        )}
      </div>

      {d.volume_claim_templates.length > 0 && (
        <>
          <Section
            t={t}
            title="Volume Claim Templates"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.volume_claim_templates.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.volume_claim_templates.map((vct) => (
              <DetailRow key={vct.name} t={t} label={vct.name}>
                {vct.storage && (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    {vct.storage}
                  </span>
                )}
                {vct.access_modes.length > 0 && (
                  <span style={{ fontSize: 11.5, color: t.textDim }}>
                    {vct.access_modes.join(", ")}
                  </span>
                )}
                {vct.storage_class && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: t.textMuted,
                      fontFamily: FONT_MONO,
                    }}
                  >
                    sc={vct.storage_class}
                  </span>
                )}
              </DetailRow>
            ))}
          </div>
        </>
      )}

      <ConditionsSection t={t} conditions={d.conditions} />
      {d.pod_template && (
        <PodTemplateSection
          t={t}
          template={d.pod_template}
          namespace={d.meta.namespace}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "statefulsets",
            namespace: ns,
            name: props.name,
          }}
          onSaved={() => setRefetch((r) => r + 1)}
        />
      )}
    </Frame>
  );
}

// ── DaemonSet ──────────────────────────────────────────────────────────────

export function DaemonSetSummary(props: {
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
  const state = useDetail<DaemonSetDetail>(
    () => api.getDaemonSetDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="DaemonSet requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading daemon set…" inline />
      </Frame>
    );
  if (state.kind === "error") return <ErrorBlock t={t} message={state.message} />;

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
        <ReplicaCounts
          t={t}
          ready={d.replicas.ready}
          desired={d.replicas.desired_scheduled}
        />
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.replicas.up_to_date} up-to-date · {d.replicas.available} available
          {d.replicas.misscheduled > 0
            ? ` · ${d.replicas.misscheduled} misscheduled`
            : ""}
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "daemonsets",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Scheduled">
          <SubGridReplicas
            t={t}
            entries={[
              ["desired", d.replicas.desired_scheduled],
              ["current", d.replicas.current_scheduled],
              ["ready", d.replicas.ready],
              ["available", d.replicas.available],
              ["unavailable", d.replicas.unavailable],
              ["up-to-date", d.replicas.up_to_date],
              ["misscheduled", d.replicas.misscheduled],
            ]}
          />
        </DetailRow>
        <SelectorRow t={t} selector={d.selector} />
        <StrategyChips
          t={t}
          strategy={d.update_strategy}
          label="Update Strategy"
        />
        {d.min_ready_seconds != null && d.min_ready_seconds > 0 && (
          <DetailRow t={t} label="Min Ready">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.min_ready_seconds}s
            </span>
          </DetailRow>
        )}
        {d.revision_history_limit != null && (
          <DetailRow t={t} label="Revision History">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.revision_history_limit}
            </span>
          </DetailRow>
        )}
        {d.observed_generation != null && (
          <DetailRow t={t} label="Observed Generation">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.observed_generation}
            </span>
          </DetailRow>
        )}
      </div>

      <ConditionsSection t={t} conditions={d.conditions} />
      {d.pod_template && (
        <PodTemplateSection
          t={t}
          template={d.pod_template}
          namespace={d.meta.namespace}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "daemonsets",
            namespace: ns,
            name: props.name,
          }}
          onSaved={() => setRefetch((r) => r + 1)}
        />
      )}
    </Frame>
  );
}

// ── Job ────────────────────────────────────────────────────────────────────

export function JobSummary(props: {
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
  const state = useDetail<JobDetail>(
    () => api.getJobDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <ErrorBlock t={t} message="Job requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading job…" inline />
      </Frame>
    );
  if (state.kind === "error") return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  const duration = computeDuration(d.start_time, d.completion_time);
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
        <StatusPill status={d.phase} t={t} mode={props.mode} />
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.status.succeeded}/{d.completions_desired ?? 1} completed ·{" "}
          {d.status.active} active · {d.status.failed} failed
          {duration ? ` · ${duration}` : ""}
        </span>
        {d.suspend && (
          <StatusPill status="Suspended" t={t} mode={props.mode} dense />
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "jobs",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Completions">
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
            {d.status.succeeded} / {d.completions_desired ?? 1}
            {d.completion_mode ? ` · ${d.completion_mode}` : ""}
          </span>
        </DetailRow>
        {d.parallelism != null && (
          <DetailRow t={t} label="Parallelism">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.parallelism}
            </span>
          </DetailRow>
        )}
        {d.backoff_limit != null && (
          <DetailRow t={t} label="Backoff Limit">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.backoff_limit}
            </span>
          </DetailRow>
        )}
        {d.active_deadline_seconds != null && (
          <DetailRow t={t} label="Active Deadline">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.active_deadline_seconds}s
            </span>
          </DetailRow>
        )}
        {d.ttl_seconds_after_finished != null && (
          <DetailRow t={t} label="TTL After Finished">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.ttl_seconds_after_finished}s
            </span>
          </DetailRow>
        )}
        <DetailRow t={t} label="Status">
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
            active={d.status.active} succeeded={d.status.succeeded} failed=
            {d.status.failed}
            {d.status.ready != null ? ` ready=${d.status.ready}` : ""}
            {d.status.terminating != null
              ? ` terminating=${d.status.terminating}`
              : ""}
          </span>
        </DetailRow>
        {d.start_time && (
          <DetailRow t={t} label="Started">
            <Copyable text={d.start_time}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.start_time)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.start_time})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.completion_time && (
          <DetailRow t={t} label="Completed">
            <Copyable text={d.completion_time}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.completion_time)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.completion_time})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
        <SelectorRow t={t} selector={d.selector} />
      </div>

      <ConditionsSection t={t} conditions={d.conditions} />
      {d.pod_template && (
        <PodTemplateSection
          t={t}
          template={d.pod_template}
          namespace={d.meta.namespace}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "jobs",
            namespace: ns,
            name: props.name,
          }}
          onSaved={() => setRefetch((r) => r + 1)}
        />
      )}
    </Frame>
  );
}

// ── CronJob ────────────────────────────────────────────────────────────────

export function CronJobSummary(props: {
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
  const state = useDetail<CronJobDetail>(
    () => api.getCronJobDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <ErrorBlock t={t} message="CronJob requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading cron job…" inline />
      </Frame>
    );
  if (state.kind === "error") return <ErrorBlock t={t} message={state.message} />;

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
          {d.schedule ?? "—"}
        </span>
        {d.suspend && (
          <StatusPill status="Suspended" t={t} mode={props.mode} dense />
        )}
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.active.length} active
          {d.last_schedule_time
            ? ` · last ran ${ageFromIso(d.last_schedule_time)} ago`
            : ""}
          {d.last_successful_time
            ? ` · last success ${ageFromIso(d.last_successful_time)} ago`
            : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "cronjobs",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((r) => r + 1)}
      />

      <Section t={t} title="Schedule" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Cron Expression">
          {d.schedule ? (
            <Copyable text={d.schedule}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {d.schedule}
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {d.time_zone && (
          <DetailRow t={t} label="Time Zone">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.time_zone}
            </span>
          </DetailRow>
        )}
        <DetailRow t={t} label="Suspend">
          <span style={{ fontSize: 12 }}>{d.suspend ? "true" : "false"}</span>
        </DetailRow>
        {d.concurrency_policy && (
          <DetailRow t={t} label="Concurrency Policy">
            <span style={{ fontSize: 12 }}>{d.concurrency_policy}</span>
          </DetailRow>
        )}
        {d.starting_deadline_seconds != null && (
          <DetailRow t={t} label="Starting Deadline">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.starting_deadline_seconds}s
            </span>
          </DetailRow>
        )}
        {d.successful_jobs_history_limit != null && (
          <DetailRow t={t} label="History (succeeded)">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.successful_jobs_history_limit}
            </span>
          </DetailRow>
        )}
        {d.failed_jobs_history_limit != null && (
          <DetailRow t={t} label="History (failed)">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {d.failed_jobs_history_limit}
            </span>
          </DetailRow>
        )}
        {d.last_schedule_time && (
          <DetailRow t={t} label="Last Schedule">
            <Copyable text={d.last_schedule_time}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.last_schedule_time)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.last_schedule_time})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.last_successful_time && (
          <DetailRow t={t} label="Last Success">
            <Copyable text={d.last_successful_time}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.last_successful_time)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.last_successful_time})
                </span>
              </span>
            </Copyable>
          </DetailRow>
        )}
      </div>

      {d.active.length > 0 && (
        <>
          <Section
            t={t}
            title="Active Jobs"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {d.active.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.active.map((ref, i) => (
              <DetailRow key={i} t={t} label={ref.kind ?? "Job"}>
                {ref.name ? (
                  <Copyable text={ref.name}>
                    <span
                      style={{ fontFamily: FONT_MONO, fontSize: 12 }}
                    >
                      {ref.name}
                    </span>
                  </Copyable>
                ) : (
                  <Mute t={t}>—</Mute>
                )}
                {ref.namespace && (
                  <span style={{ fontSize: 11.5, color: t.textMuted }}>
                    {ref.namespace}
                  </span>
                )}
              </DetailRow>
            ))}
          </div>
        </>
      )}

      {d.job_template && (
        <>
          <Section t={t} title="Job Template" />
          <div style={{ marginBottom: 22 }}>
            {d.job_template.completions != null && (
              <DetailRow t={t} label="Completions">
                <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                  {d.job_template.completions}
                </span>
              </DetailRow>
            )}
            {d.job_template.parallelism != null && (
              <DetailRow t={t} label="Parallelism">
                <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                  {d.job_template.parallelism}
                </span>
              </DetailRow>
            )}
            {d.job_template.backoff_limit != null && (
              <DetailRow t={t} label="Backoff Limit">
                <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                  {d.job_template.backoff_limit}
                </span>
              </DetailRow>
            )}
            {d.job_template.active_deadline_seconds != null && (
              <DetailRow t={t} label="Active Deadline">
                <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                  {d.job_template.active_deadline_seconds}s
                </span>
              </DetailRow>
            )}
            {d.job_template.ttl_seconds_after_finished != null && (
              <DetailRow t={t} label="TTL After Finished">
                <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                  {d.job_template.ttl_seconds_after_finished}s
                </span>
              </DetailRow>
            )}
          </div>
        </>
      )}

      {d.pod_template && (
        <PodTemplateSection
          t={t}
          template={d.pod_template}
          namespace={d.meta.namespace}
          onNavigate={props.onNavigate}
          editTarget={{
            clusterId: props.clusterId,
            kindId: "cronjobs",
            namespace: ns,
            name: props.name,
          }}
          onSaved={() => setRefetch((r) => r + 1)}
          templateKind="cronjob"
        />
      )}
    </Frame>
  );
}

// ── Local helpers ──────────────────────────────────────────────────────────

// Single-purpose grid for the "replicas at-a-glance" rows. Each entry is
// "label = value" (number) and renders as one indented sub-row.
function SubGridReplicas({
  t,
  entries,
}: {
  t: Tokens;
  entries: [string, number][];
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "2px 16px",
        fontFamily: FONT_MONO,
        fontSize: 11.5,
        color: t.text,
      }}
    >
      {entries.map(([k, v]) => (
        <span key={k}>
          <span style={{ color: t.textMuted }}>{k}=</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
        </span>
      ))}
    </div>
  );
}

function computeDuration(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const s = Date.parse(start);
  if (Number.isNaN(s)) return null;
  const e = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(e)) return null;
  let secs = Math.max(0, Math.floor((e - s) / 1000));
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${secs}s`;
  return `${secs}s`;
}
