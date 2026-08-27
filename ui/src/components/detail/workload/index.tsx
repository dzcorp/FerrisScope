// Per-kind detail summary components for the workload family. Each one
// fetches its typed projection on mount + on detailVersion bumps, and
// composes the shared workload primitives (`MetaSection`, `SelectorRow`,
// `ConditionsSection`, `PodTemplateSection`) plus a kind-specific block.

import { useState } from "react";
import { useResolvedTheme } from "../../../store";
import { api } from "../../../api";
import { FF_MONO, type ThemeMode, type Tokens, FS_MD, FS_SM, FS_XS } from "../../../theme";
import {  } from "../../../theme";
import { Chip, ErrorBlock, Section, StatusPill, LoadingLine } from "../../ui";
import {
  ChipWrap,
  Mono,
  Copyable,
  DetailRow,
  EditSessionProvider,
  GlobalSaveBar,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
  useDetail,
} from "..";
import type {
  CronJobDetail,
  CronJobRun,
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
  ReplicasEditor,
  SelectorRow,
} from "./shared";
import { PodListSection } from "../podList";
import { acceptsPodDelta } from "../../../lib/podSelector";

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
      <span style={{ fontSize: FS_MD }}>{strategy.type}</span>
      {strategy.max_surge != null && (
        <span style={{ fontSize: FS_SM, color: t.textDim, marginLeft: 8 }}>
          maxSurge={strategy.max_surge}
        </span>
      )}
      {strategy.max_unavailable != null && (
        <span style={{ fontSize: FS_SM, color: t.textDim, marginLeft: 8 }}>
          maxUnavailable={strategy.max_unavailable}
        </span>
      )}
      {strategy.partition != null && (
        <span style={{ fontSize: FS_SM, color: t.textDim, marginLeft: 8 }}>
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
  const t = useResolvedTheme().tokens;
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
        <LoadingLine t={t} label="Loading deployment…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="deployment" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "deployments",
        namespace: ns,
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
          <ReplicasEditor
            t={t}
            ready={d.replicas.ready}
            desired={d.replicas.desired}
          />
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
              <Mono>
                {d.min_ready_seconds}s
              </Mono>
            </DetailRow>
          )}
          {d.progress_deadline_seconds != null && (
            <DetailRow t={t} label="Progress Deadline">
              <Mono>
                {d.progress_deadline_seconds}s
              </Mono>
            </DetailRow>
          )}
          {d.revision_history_limit != null && (
            <DetailRow t={t} label="Revision History">
              <Mono>
                {d.revision_history_limit}
              </Mono>
            </DetailRow>
          )}
          {d.observed_generation != null && (
            <DetailRow t={t} label="Observed Generation">
              <Mono>
                {d.observed_generation}
              </Mono>
            </DetailRow>
          )}
        </div>

        <ConditionsSection t={t} conditions={d.conditions} />

        <PodListSection
          t={t}
          mode={props.mode}
          clusterId={props.clusterId}
          fetchPods={() =>
            api.listPodsForWorkload(props.clusterId, "deployments", ns, props.name)
          }
          acceptsDelta={(row, known) =>
            acceptsPodDelta(row, ns, d.selector, known)
          }
          subjectKey={`deployments/${ns}/${props.name}`}
          refetchKey={props.detailVersion}
          emptyLabel="No pods match this Deployment's selector."
          showNode
          onNavigate={props.onNavigate}
        />
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
          />
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
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
  const t = useResolvedTheme().tokens;
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
        <LoadingLine t={t} label="Loading replica set…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="replica set" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "replicasets",
        namespace: ns,
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
          <ReplicasEditor
            t={t}
            ready={d.replicas.ready}
            desired={d.replicas.desired}
          />
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
              <Mono>
                {d.min_ready_seconds}s
              </Mono>
            </DetailRow>
          )}
          {d.observed_generation != null && (
            <DetailRow t={t} label="Observed Generation">
              <Mono>
                {d.observed_generation}
              </Mono>
            </DetailRow>
          )}
        </div>

        <ConditionsSection t={t} conditions={d.conditions} />

        <PodListSection
          t={t}
          mode={props.mode}
          clusterId={props.clusterId}
          fetchPods={() =>
            api.listPodsForWorkload(props.clusterId, "replicasets", ns, props.name)
          }
          acceptsDelta={(row, known) =>
            acceptsPodDelta(row, ns, d.selector, known)
          }
          subjectKey={`replicasets/${ns}/${props.name}`}
          refetchKey={props.detailVersion}
          emptyLabel="No pods match this ReplicaSet's selector."
          showNode
          onNavigate={props.onNavigate}
        />
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
          />
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
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
  const t = useResolvedTheme().tokens;
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
        <LoadingLine t={t} label="Loading stateful set…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="stateful set" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "statefulsets",
        namespace: ns,
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
          <ReplicasEditor
            t={t}
            ready={d.replicas.ready}
            desired={d.replicas.desired}
          />
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
                <Mono>
                  {d.service_name}
                </Mono>
              </Copyable>
            </DetailRow>
          )}
          {d.pod_management_policy && (
            <DetailRow t={t} label="Pod Management">
              <span style={{ fontSize: FS_MD }}>{d.pod_management_policy}</span>
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
                <span style={{ fontFamily: FF_MONO, fontSize: FS_SM }}>
                  {d.current_revision}
                </span>
              </Copyable>
            </DetailRow>
          )}
          {d.update_revision &&
            d.update_revision !== d.current_revision && (
              <DetailRow t={t} label="Update Revision">
                <Copyable text={d.update_revision}>
                  <span style={{ fontFamily: FF_MONO, fontSize: FS_SM }}>
                    {d.update_revision}
                  </span>
                </Copyable>
              </DetailRow>
            )}
          {d.observed_generation != null && (
            <DetailRow t={t} label="Observed Generation">
              <Mono>
                {d.observed_generation}
              </Mono>
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
                    fontSize: FS_XS,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
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
                    <Mono>
                      {vct.storage}
                    </Mono>
                  )}
                  {vct.access_modes.length > 0 && (
                    <span style={{ fontSize: FS_SM, color: t.textDim }}>
                      {vct.access_modes.join(", ")}
                    </span>
                  )}
                  {vct.storage_class && (
                    <span
                      style={{
                        fontSize: FS_SM,
                        color: t.textMuted,
                        fontFamily: FF_MONO,
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

        <PodListSection
          t={t}
          mode={props.mode}
          clusterId={props.clusterId}
          fetchPods={() =>
            api.listPodsForWorkload(props.clusterId, "statefulsets", ns, props.name)
          }
          acceptsDelta={(row, known) =>
            acceptsPodDelta(row, ns, d.selector, known)
          }
          subjectKey={`statefulsets/${ns}/${props.name}`}
          refetchKey={props.detailVersion}
          emptyLabel="No pods match this StatefulSet's selector."
          showNode
          onNavigate={props.onNavigate}
        />
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
          />
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
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
  const t = useResolvedTheme().tokens;
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
        <LoadingLine t={t} label="Loading daemon set…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="daemon set" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "daemonsets",
        namespace: ns,
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
          <ReplicaCounts
            t={t}
            ready={d.replicas.ready}
            desired={d.replicas.desired_scheduled}
          />
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
              <Mono>
                {d.min_ready_seconds}s
              </Mono>
            </DetailRow>
          )}
          {d.revision_history_limit != null && (
            <DetailRow t={t} label="Revision History">
              <Mono>
                {d.revision_history_limit}
              </Mono>
            </DetailRow>
          )}
          {d.observed_generation != null && (
            <DetailRow t={t} label="Observed Generation">
              <Mono>
                {d.observed_generation}
              </Mono>
            </DetailRow>
          )}
        </div>

        <ConditionsSection t={t} conditions={d.conditions} />

        <PodListSection
          t={t}
          mode={props.mode}
          clusterId={props.clusterId}
          fetchPods={() =>
            api.listPodsForWorkload(props.clusterId, "daemonsets", ns, props.name)
          }
          acceptsDelta={(row, known) =>
            acceptsPodDelta(row, ns, d.selector, known)
          }
          subjectKey={`daemonsets/${ns}/${props.name}`}
          refetchKey={props.detailVersion}
          emptyLabel="No pods match this DaemonSet's selector."
          showNode
          onNavigate={props.onNavigate}
        />
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
          />
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
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
  const t = useResolvedTheme().tokens;
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
        <LoadingLine t={t} label="Loading job…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="job" />;

  const d = state.detail;
  const duration = computeDuration(d.start_time, d.completion_time);
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "jobs",
        namespace: ns,
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
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            {d.status.succeeded}/{d.completions_desired ?? 1} completed ·{" "}
            {d.status.active} active · {d.status.failed} failed
            {duration ? ` · ${duration}` : ""}
          </span>
          {d.suspend && (
            <StatusPill status="Suspended" t={t} mode={props.mode} dense />
          )}
          {/* Parallelism is the one knob a running Job takes live — the rest
              of its spec is immutable, so this is the whole in-place edit
              surface. `0` is legal and pauses the Job without suspending it. */}
          <ReplicasEditor
            t={t}
            desired={d.parallelism ?? 1}
            field="parallelism"
            label="parallel"
          />
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
        />

        <Section t={t} title="Spec" />
        <div style={{ marginBottom: 22 }}>
          <DetailRow t={t} label="Completions">
            <Mono>
              {d.status.succeeded} / {d.completions_desired ?? 1}
              {d.completion_mode ? ` · ${d.completion_mode}` : ""}
            </Mono>
          </DetailRow>
          {d.backoff_limit != null && (
            <DetailRow t={t} label="Backoff Limit">
              <Mono>
                {d.backoff_limit}
              </Mono>
            </DetailRow>
          )}
          {d.backoff_limit_per_index != null && (
            <DetailRow t={t} label="Backoff Limit / Index">
              <Mono>
                {d.backoff_limit_per_index}
              </Mono>
            </DetailRow>
          )}
          {d.max_failed_indexes != null && (
            <DetailRow t={t} label="Max Failed Indexes">
              <Mono>
                {d.max_failed_indexes}
              </Mono>
            </DetailRow>
          )}
          {d.pod_replacement_policy && (
            <DetailRow t={t} label="Pod Replacement">
              <span style={{ fontSize: FS_MD }}>{d.pod_replacement_policy}</span>
            </DetailRow>
          )}
          {d.managed_by && (
            <DetailRow t={t} label="Managed By">
              {/* An external controller (Kueue, a queueing system) owns this
                  Job's lifecycle — edits from here will fight it. */}
              <Copyable text={d.managed_by}>
                <Mono>{d.managed_by}</Mono>
              </Copyable>
            </DetailRow>
          )}
          {d.active_deadline_seconds != null && (
            <DetailRow t={t} label="Active Deadline">
              <Mono>
                {d.active_deadline_seconds}s
              </Mono>
            </DetailRow>
          )}
          {d.ttl_seconds_after_finished != null && (
            <DetailRow t={t} label="TTL After Finished">
              <Mono>
                {d.ttl_seconds_after_finished}s
              </Mono>
            </DetailRow>
          )}
          <DetailRow t={t} label="Status">
            <Mono>
              active={d.status.active} succeeded={d.status.succeeded} failed=
              {d.status.failed}
              {d.status.ready != null ? ` ready=${d.status.ready}` : ""}
              {d.status.terminating != null
                ? ` terminating=${d.status.terminating}`
                : ""}
            </Mono>
          </DetailRow>
          {/* Indexed jobs: `3/5 completed` says nothing about which shards
              are stuck. These ranges are the only place that shows. */}
          {d.status.completed_indexes && (
            <DetailRow t={t} label="Completed Indexes">
              <Copyable text={d.status.completed_indexes}>
                <Mono>{d.status.completed_indexes}</Mono>
              </Copyable>
            </DetailRow>
          )}
          {d.status.failed_indexes && (
            <DetailRow t={t} label="Failed Indexes">
              <Copyable text={d.status.failed_indexes}>
                <span
                  style={{
                    fontFamily: FF_MONO,
                    fontSize: FS_MD,
                    color: t.bad,
                  }}
                >
                  {d.status.failed_indexes}
                </span>
              </Copyable>
            </DetailRow>
          )}
          {d.start_time && (
            <DetailRow t={t} label="Started">
              <Copyable text={d.start_time}>
                <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
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
                <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
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

        <JobPolicySections t={t} detail={d} />

        <ConditionsSection t={t} conditions={d.conditions} />

        <PodListSection
          t={t}
          mode={props.mode}
          clusterId={props.clusterId}
          fetchPods={() =>
            api.listPodsForWorkload(props.clusterId, "jobs", ns, props.name)
          }
          acceptsDelta={(row, known) =>
            acceptsPodDelta(row, ns, d.selector, known)
          }
          subjectKey={`jobs/${ns}/${props.name}`}
          refetchKey={props.detailVersion}
          emptyLabel="No pods match this Job's selector."
          showNode
          onNavigate={props.onNavigate}
        />
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
          />
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}

/// Pod-failure and success policies. Both are rule lists that change when a
/// Job gives up or declares victory, so an operator debugging a Job that
/// "failed for no reason" needs them visible — but they are rare enough that
/// the section is absent entirely when unset.
function JobPolicySections({ t, detail }: { t: Tokens; detail: JobDetail }) {
  const failure = detail.pod_failure_policy?.rules ?? [];
  const success = detail.success_policy?.rules ?? [];
  if (failure.length === 0 && success.length === 0) return null;

  return (
    <>
      {failure.length > 0 && (
        <>
          <Section
            t={t}
            title="Pod Failure Policy"
            right={
              <span
                style={{ fontSize: FS_XS, color: t.textMuted, fontFamily: FF_MONO }}
              >
                {failure.length} rule{failure.length === 1 ? "" : "s"}
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {failure.map((rule, i) => (
              <DetailRow key={i} t={t} label={rule.action}>
                <ChipWrap>
                  {rule.on_exit_codes && (
                    <Copyable
                      text={`${rule.on_exit_codes.container_name ?? "*"} exit ${rule.on_exit_codes.operator} [${rule.on_exit_codes.values.join(", ")}]`}
                    >
                      <Chip t={t}>
                        {rule.on_exit_codes.container_name ?? "any container"} ·
                        exit {rule.on_exit_codes.operator}{" "}
                        {rule.on_exit_codes.values.join(", ")}
                      </Chip>
                    </Copyable>
                  )}
                  {(rule.on_pod_conditions ?? []).map((c, j) => (
                    <Copyable key={j} text={`${c.type}=${c.status}`}>
                      <Chip t={t}>
                        {c.type}={c.status}
                      </Chip>
                    </Copyable>
                  ))}
                  {!rule.on_exit_codes &&
                    (rule.on_pod_conditions ?? []).length === 0 && (
                      <Mute t={t}>—</Mute>
                    )}
                </ChipWrap>
              </DetailRow>
            ))}
          </div>
        </>
      )}
      {success.length > 0 && (
        <>
          <Section t={t} title="Success Policy" />
          <div style={{ marginBottom: 22 }}>
            {success.map((rule, i) => (
              <DetailRow key={i} t={t} label={`Rule ${i + 1}`}>
                <Mono>
                  {[
                    rule.succeeded_count != null
                      ? `succeededCount=${rule.succeeded_count}`
                      : null,
                    rule.succeeded_indexes
                      ? `succeededIndexes=${rule.succeeded_indexes}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </Mono>
              </DetailRow>
            ))}
          </div>
        </>
      )}
    </>
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
  const t = useResolvedTheme().tokens;
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
        <LoadingLine t={t} label="Loading cron job…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="cron job" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "cronjobs",
        namespace: ns,
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
          <span
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              fontWeight: 600,
              color: t.text,
            }}
          >
            {d.schedule ?? "—"}
          </span>
          {d.suspend && (
            <StatusPill status="Suspended" t={t} mode={props.mode} dense />
          )}
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            {d.active.length} active
            {d.last_schedule_time
              ? ` · last ran ${ageFromIso(d.last_schedule_time)} ago`
              : ""}
            {d.last_successful_time
              ? ` · last success ${ageFromIso(d.last_successful_time)} ago`
              : ""}
            {d.next_run && !d.suspend
              ? ` · next in ${untilIso(d.next_run)}`
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
        />

      <Section t={t} title="Schedule" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Cron Expression">
          {d.schedule ? (
            <Copyable text={d.schedule}>
              <Mono>
                {d.schedule}
              </Mono>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {d.time_zone && (
          <DetailRow t={t} label="Time Zone">
            <Mono>
              {d.time_zone}
            </Mono>
          </DetailRow>
        )}
        <DetailRow t={t} label="Next Run">
          {d.next_run ? (
            <Copyable text={d.next_run}>
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
                in {untilIso(d.next_run)}
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.next_run})
                </span>
                {/* The controller keeps evaluating the schedule while
                    suspended; it just doesn't act on it. Showing the time
                    with this caveat is more useful than hiding it. */}
                {d.suspend && (
                  <span style={{ color: t.warn, marginLeft: 8 }}>
                    suspended — will not fire
                  </span>
                )}
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>— (schedule or time zone not evaluable)</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Suspend">
          <span style={{ fontSize: FS_MD }}>{d.suspend ? "true" : "false"}</span>
        </DetailRow>
        {d.concurrency_policy && (
          <DetailRow t={t} label="Concurrency Policy">
            <span style={{ fontSize: FS_MD }}>{d.concurrency_policy}</span>
          </DetailRow>
        )}
        {d.starting_deadline_seconds != null && (
          <DetailRow t={t} label="Starting Deadline">
            <Mono>
              {d.starting_deadline_seconds}s
            </Mono>
          </DetailRow>
        )}
        {d.successful_jobs_history_limit != null && (
          <DetailRow t={t} label="History (succeeded)">
            <Mono>
              {d.successful_jobs_history_limit}
            </Mono>
          </DetailRow>
        )}
        {d.failed_jobs_history_limit != null && (
          <DetailRow t={t} label="History (failed)">
            <Mono>
              {d.failed_jobs_history_limit}
            </Mono>
          </DetailRow>
        )}
        {d.last_schedule_time && (
          <DetailRow t={t} label="Last Schedule">
            <Copyable text={d.last_schedule_time}>
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
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
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
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
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                }}
              >
                {d.active.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.active.map((ref, i) => {
              // Bound out of the JSX: narrowing on a property access is lost
              // inside the onClick closure.
              const jobName = ref.name;
              const jobNs = ref.namespace ?? ns;
              return (
                <DetailRow key={i} t={t} label={ref.kind ?? "Job"}>
                  {/* A CronJob has no pod selector of its own — its pods hang
                      off these Jobs, so linking through is how the operator
                      reaches them. LinkValue, not a bare Copyable. */}
                  {jobName ? (
                    <LinkValue
                      t={t}
                      onClick={() => props.onNavigate?.("Job", jobNs, jobName)}
                      copyText={jobName}
                      enabled={!!props.onNavigate}
                    >
                      {jobName}
                    </LinkValue>
                  ) : (
                    <Mute t={t}>—</Mute>
                  )}
                  {ref.namespace && (
                    <span style={{ fontSize: FS_SM, color: t.textMuted }}>
                      {ref.namespace}
                    </span>
                  )}
                </DetailRow>
              );
            })}
          </div>
        </>
      )}

      <CronJobHistorySection
        t={t}
        mode={props.mode}
        clusterId={props.clusterId}
        namespace={ns}
        name={props.name}
        refetchKey={props.detailVersion + refetch}
        onNavigate={props.onNavigate}
      />

      {d.job_template && (
        <>
          <Section t={t} title="Job Template" />
          <div style={{ marginBottom: 22 }}>
            {d.job_template.completions != null && (
              <DetailRow t={t} label="Completions">
                <Mono>
                  {d.job_template.completions}
                </Mono>
              </DetailRow>
            )}
            {d.job_template.parallelism != null && (
              <DetailRow t={t} label="Parallelism">
                <Mono>
                  {d.job_template.parallelism}
                </Mono>
              </DetailRow>
            )}
            {d.job_template.backoff_limit != null && (
              <DetailRow t={t} label="Backoff Limit">
                <Mono>
                  {d.job_template.backoff_limit}
                </Mono>
              </DetailRow>
            )}
            {d.job_template.active_deadline_seconds != null && (
              <DetailRow t={t} label="Active Deadline">
                <Mono>
                  {d.job_template.active_deadline_seconds}s
                </Mono>
              </DetailRow>
            )}
            {d.job_template.ttl_seconds_after_finished != null && (
              <DetailRow t={t} label="TTL After Finished">
                <Mono>
                  {d.job_template.ttl_seconds_after_finished}s
                </Mono>
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
          templateKind="cronjob"
        />
      )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}

/// A CronJob's run history — the Jobs it owns, newest first.
///
/// This is the screen an operator opens after a nightly job failed, and the
/// most important thing it can say is that the run they are looking for is
/// *gone*: the CronJob's own `successfulJobsHistoryLimit` /
/// `failedJobsHistoryLimit` reap old Jobs, so an empty or short list is a
/// retention fact, not an error. The empty state says so rather than implying
/// the CronJob never ran.
function CronJobHistorySection({
  t,
  mode,
  clusterId,
  namespace,
  name,
  refetchKey,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  namespace: string;
  name: string;
  refetchKey: number;
  onNavigate?: DetailNavigate;
}) {
  const state = useDetail<CronJobRun[]>(
    () => api.listJobsForCronJob(clusterId, namespace, name),
    [clusterId, namespace, name, refetchKey],
  );

  return (
    <>
      <Section
        t={t}
        title="Run History"
        right={
          state.kind === "ready" ? (
            <span
              style={{ fontSize: FS_XS, color: t.textMuted, fontFamily: FF_MONO }}
            >
              {state.detail.length} kept
            </span>
          ) : undefined
        }
      />
      <div style={{ marginBottom: 22 }}>
        {state.kind === "loading" && (
          <LoadingLine t={t} label="Loading run history…" />
        )}
        {state.kind === "error" && (
          <Mute t={t}>Couldn't load run history: {state.message}</Mute>
        )}
        {state.kind === "ready" && state.detail.length === 0 && (
          <Mute t={t}>
            No Jobs owned by this CronJob. Runs older than its history limits
            are deleted from the cluster — check Events for what happened to
            them.
          </Mute>
        )}
        {state.kind === "ready" &&
          state.detail.map((run) => (
            <DetailRow key={run.uid ?? run.name} t={t} label={run.phase}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <StatusPill status={run.phase} t={t} mode={mode} dense />
                <LinkValue
                  t={t}
                  onClick={() => onNavigate?.("Job", run.namespace, run.name)}
                  copyText={run.name}
                  enabled={!!onNavigate}
                >
                  {run.name}
                </LinkValue>
                {run.manual && <Chip t={t}>manual</Chip>}
                <span style={{ fontSize: FS_SM, color: t.textMuted }}>
                  {run.succeeded}/{run.completions_desired ?? 1} succeeded
                  {run.failed > 0 ? ` · ${run.failed} failed` : ""}
                  {run.active > 0 ? ` · ${run.active} active` : ""}
                  {run.duration_seconds != null
                    ? ` · took ${formatSeconds(run.duration_seconds)}`
                    : ""}
                  {run.start_time
                    ? ` · started ${ageFromIso(run.start_time)} ago`
                    : ""}
                </span>
              </div>
            </DetailRow>
          ))}
      </div>
    </>
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
        fontFamily: FF_MONO,
        fontSize: FS_SM,
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
  return formatSeconds((e - s) / 1000);
}

/// "in 4h 12m" for a future ISO instant. Returns "—" on a parse failure and
/// "now" once the instant is in the past — a next-run readout that has gone
/// stale should say so rather than render a negative duration.
export function untilIso(iso: string): string {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "—";
  const secs = Math.floor((target - Date.now()) / 1000);
  if (secs <= 0) return "now";
  return formatSeconds(secs);
}

/// Coarse duration: the two largest non-zero units, biggest first.
export function formatSeconds(total: number): string {
  let secs = Math.max(0, Math.floor(total));
  const d = Math.floor(secs / 86400);
  secs -= d * 86400;
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${secs}s`;
  return `${secs}s`;
}
