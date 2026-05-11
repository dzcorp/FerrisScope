// Shared sections used by every workload detail summary (Deployment,
// ReplicaSet, StatefulSet, DaemonSet, Job, CronJob). Each kind's summary
// composes these + its own kind-specific rows above; this keeps the
// metadata + selector + pod-template chrome consistent across the family.

import { useMemo, useState } from "react";
import { FF_MONO, type Tokens, R_LG, R_SM, FS_MD, FS_SM, FS_XS } from "../../../theme";
import { Btn, Checkbox, Chip, Section, Select } from "../../ui";
import { ForwardChip } from "../forwardChip";
import {
  KeyRefPicker,
  type KeyRefPickerKind,
  type KeyRefSelection,
} from "../keyRefPicker";
import {
  ChipStrip,
  ChipWrap,
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
  SubGrid,
  ageFromIso,
  formatQuantity,
  parseQuantity,
  useEditField,
  useEditSession,
  type DetailNavigate,
} from "..";
import {
  AddRowButton,
  EditModeChrome,
  EditableTextValue,
  KvEditor,
  ListEditor,
  RowDeleteButton,
  kvBufferDirty,
  kvBufferDuplicates,
  kvBufferFromPairs,
  kvBufferToMap,
  listBufferDirty,
  listBufferFrom,
  listBufferToArray,
  type ApplyTarget,
  type ListBuffer,
} from "../edit";
import type {
  ContainerEnv,
  ContainerEnvFrom,
  ContainerMount,
  ContainerPort,
  LabelSelectorSummary,
  PodTemplateSummary,
  PodVolume,
  WorkloadCondition,
  WorkloadContainerSummary,
  WorkloadMeta,
} from "../../../types";

// ── MetaSection ────────────────────────────────────────────────────────────
// Name / namespace / uid / created / labels / controlled_by row block. Every
// workload detail starts with this — keep the order stable so operators can
// find the same field in the same place across kinds.
export function MetaSection({
  t,
  meta,
  onNavigate,
  // Optional: when provided, Labels and Annotations rows render with an
  // inline-edit affordance (pencil → key/value editor). Pass `undefined`
  // to keep MetaSection read-only — what every kind that hasn't opted in
  // to editing yet does. The actual SSA save flows through the panel-
  // scoped EditSession provided higher up.
  editTarget,
  // Accepted for backwards compatibility with kinds that still pass it
  // (config / customresources / extended / network / rbac / storage / …).
  // Save now flows through the EditSession; the caller's onSaved is no
  // longer needed here. Drop in a follow-up pass once those panels are
  // wrapped in EditSessionProvider.
  onSaved: _onSaved,
}: {
  t: Tokens;
  meta: WorkloadMeta;
  onNavigate?: DetailNavigate;
  editTarget?: ApplyTarget;
  onSaved?: () => void;
}) {
  return (
    <>
      <Section t={t} title="Details" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Created">
          {meta.created_at ? (
            <Copyable text={meta.created_at}>
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
                {ageFromIso(meta.created_at)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({meta.created_at})
                </span>
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Name">
          <Copyable text={meta.name}>
            <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>{meta.name}</span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Namespace">
          {meta.namespace ? (
            <LinkValue
              t={t}
              onClick={() => onNavigate?.("Namespace", null, meta.namespace!)}
              copyText={meta.namespace}
              enabled={!!onNavigate}
            >
              {meta.namespace}
            </LinkValue>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {meta.uid && (
          <DetailRow t={t} label="UID">
            <Copyable text={meta.uid}>
              <span
                style={{
                  fontFamily: FF_MONO,
                  fontSize: FS_SM,
                  color: t.textDim,
                  wordBreak: "break-all",
                }}
              >
                {meta.uid}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {meta.controlled_by && (
          <DetailRow t={t} label="Controlled By">
            <span style={{ fontSize: FS_MD }}>{meta.controlled_by.kind}</span>{" "}
            <LinkValue
              t={t}
              onClick={() =>
                onNavigate?.(
                  meta.controlled_by!.kind,
                  meta.namespace,
                  meta.controlled_by!.name,
                )
              }
              copyText={meta.controlled_by.name}
              enabled={!!onNavigate}
            >
              {meta.controlled_by.name}
            </LinkValue>
          </DetailRow>
        )}
        <ManagedByRow t={t} managers={meta.managers ?? []} />

        <MetaPairsRow
          t={t}
          label="Labels"
          pairs={meta.labels}
          editTarget={editTarget}
          metadataKey="labels"
          // Labels constraint: keys are the same as Kubernetes object
          // names, possibly prefixed with `prefix/`. We use a generous
          // regex — the apiserver does the strict validation.
          keyValidate={(k) => /^([a-z0-9.-]+\/)?[A-Za-z0-9._-]+$/.test(k)}
        />
        <MetaPairsRow
          t={t}
          label="Annotations"
          pairs={meta.annotations}
          editTarget={editTarget}
          metadataKey="annotations"
          keyValidate={(k) => /^([a-z0-9.-]+\/)?[A-Za-z0-9._-]+$/.test(k)}
          // Annotations are commonly long (last-applied-configuration,
          // controller state). Read-only mode collapses to a count; the
          // editor still lists every one.
          collapsedAsCount
        />
        {meta.generation != null && (
          <DetailRow t={t} label="Generation">
            <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
              {meta.generation}
            </span>
          </DetailRow>
        )}
      </div>
    </>
  );
}

// "Managed By" row — collapses metadata.managedFields to one chip per
// unique manager (excluding our own field manager). When the resource is
// being reconciled by a tool like Flux's kustomize-controller, ArgoCD, or
// Helm, edits to fields that manager owns will return SSA 409 conflicts
// and the global save bar will offer "Force takeover" — but the
// reconciler will likely revert the change on its next pass, so the
// operator should know up front. Reconciler-style managers render as
// amber chips; one-shot managers (kubectl-edit, helm one-off install,
// system controllers) render in muted default tone.
//
// Hidden when there's nothing interesting to show.
function ManagedByRow({
  t,
  managers,
}: {
  t: Tokens;
  managers: { manager: string; operation: string; time: string | null }[];
}) {
  // Hide our own manager, anything K8s reports as the "unknown" sentinel
  // (apiserver writes that for fields a client touched without a
  // User-Agent), and noisy K8s-internal controllers (status writers, the
  // scheduler) — operators don't read those as ownership signals. Match
  // case-insensitively so vendor-prefixed variants are caught too.
  const SELF = "ferrisscope";
  const NOISE = new Set([
    "kube-controller-manager",
    "kube-scheduler",
    "kubelet",
    "node-controller",
    "endpoint-controller",
    "endpointslice-controller",
    "deployment-controller",
    "replicaset-controller",
    "statefulset-controller",
    "daemonset-controller",
    "cronjob-controller",
    "job-controller",
    "horizontal-pod-autoscaler",
    "k3s",
    "k3s-controller",
    "rke2",
    "unknown",
  ]);
  const visible = managers
    .filter((m) => {
      const name = m.manager.trim().toLowerCase();
      return name !== "" && name !== SELF && !NOISE.has(name);
    })
    // Most recent touch first. ISO-8601 strings sort lexicographically
    // = chronologically, so a plain string compare is enough. Entries
    // without a time fall to the end.
    .slice()
    .sort((a, b) => {
      if (a.time && b.time) return b.time.localeCompare(a.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return a.manager.localeCompare(b.manager);
    });
  if (visible.length === 0) return null;
  return (
    <DetailRow t={t} label="Managed By">
      <ChipWrap>
        {visible.map((m, i) => {
          const reconciler = isReconciler(m.manager);
          const tone: "warn" | "neutral" = reconciler ? "warn" : "neutral";
          // Operation/time go into the tooltip — chip text stays compact.
          // K8s sometimes reports `operation: ""` or `Unknown`, neither of
          // which is useful inline.
          const opLabel =
            m.operation && m.operation.toLowerCase() !== "unknown"
              ? m.operation
              : null;
          const tooltipBits: string[] = [];
          if (opLabel) tooltipBits.push(`operation: ${opLabel}`);
          if (m.time) tooltipBits.push(`last touched: ${m.time}`);
          if (reconciler) {
            tooltipBits.push(
              "reconciles this resource — your edits to its fields may be reverted on the next sync.",
            );
          }
          return (
            <Copyable
              key={`${m.manager}:${m.operation}:${i}`}
              text={m.manager}
              label={
                tooltipBits.length > 0 ? (
                  <span>
                    {tooltipBits.map((b, j) => (
                      <span key={j} style={{ display: "block" }}>
                        {b}
                      </span>
                    ))}
                  </span>
                ) : undefined
              }
            >
              <Chip
                t={t}
                tone={tone}
                mono
                style={{ whiteSpace: "nowrap" }}
              >
                {m.manager}
              </Chip>
            </Copyable>
          );
        })}
      </ChipWrap>
    </DetailRow>
  );
}

// True for managers that continuously reconcile their managed fields back
// to a source-of-truth (Git, Helm chart, …). These are the ones whose
// "Force takeover" wins are short-lived. Match by substring so vendor-
// prefixed names (like `helm-controller-foo`) still resolve.
function isReconciler(manager: string): boolean {
  const m = manager.toLowerCase();
  return (
    m.includes("kustomize-controller") ||
    m.includes("helm-controller") ||
    m.includes("argocd") ||
    m.includes("argo-cd") ||
    m.includes("kapp-controller") ||
    m.includes("flux") ||
    m === "helm" ||
    m.startsWith("helm/") ||
    m.includes("gitops") ||
    m.includes("rancher")
  );
}

// One key-value row inside MetaSection. Read-only when no editTarget; edit
// affordance + KvEditor when editTarget is present. Encapsulated here so
// the labels and annotations rows share the same shape. Exported so the
// Pod summary (which keeps its own bespoke Details block) can drop in just
// the editable label / annotation rows without adopting the full MetaSection.
export function MetaPairsRow({
  t,
  label,
  pairs,
  editTarget,
  metadataKey,
  keyValidate,
  collapsedAsCount = false,
}: {
  t: Tokens;
  label: string;
  pairs: [string, string][];
  editTarget?: ApplyTarget;
  metadataKey: "labels" | "annotations";
  keyValidate?: (k: string) => boolean;
  collapsedAsCount?: boolean;
}) {
  // Editable only when a panel-scoped EditSession is in scope AND the
  // parent passed an editTarget gate. Without a session the global save
  // bar can't fire, so the pencil would be a dead end — hide it.
  const session = useEditSession();
  const editable = !!editTarget && !!session;
  const edit = useEditField<{ buffer: ReturnType<typeof kvBufferFromPairs> }>({
    id: `meta:${metadataKey}`,
    initial: () => ({ buffer: kvBufferFromPairs(pairs) }),
    serialize: (s) => ({ metadata: { [metadataKey]: kvBufferToMap(s.buffer) } }),
    dirtyCount: (s) => kvBufferDirty(s.buffer),
  });

  const dup = useMemo(
    () => (edit.editing ? kvBufferDuplicates(edit.buffer.buffer) : new Set<string>()),
    [edit.editing, edit.buffer],
  );

  // When not editable AND nothing to show, render nothing — matches the
  // pre-existing behaviour where empty labels/annotations rows were elided.
  if (!editable && pairs.length === 0) return null;

  const right = editable ? (
    <EditModeChrome
      t={t}
      editing={edit.editing}
      dirty={edit.dirty}
      saving={edit.saving}
      onEnter={edit.enter}
      onCancel={edit.cancel}
    />
  ) : null;

  return (
    <>
      <DetailRow t={t} label={label}>
        <div style={{ width: "100%" }}>
          {edit.editing ? (
            <>
              {dup.size > 0 && (
                <div
                  style={{
                    margin: "0 0 6px",
                    fontSize: FS_SM,
                    color: t.bad,
                    fontFamily: FF_MONO,
                  }}
                >
                  Duplicate keys: {[...dup].join(", ")}
                </div>
              )}
              <KvEditor
                t={t}
                buffer={edit.buffer.buffer}
                onChange={(b) => edit.setBuffer({ buffer: b })}
                duplicates={dup}
                validateKey={keyValidate}
                keyPlaceholder={metadataKey === "labels" ? "label.key" : "annotation.key"}
                valuePlaceholder="value"
              />
            </>
          ) : pairs.length === 0 ? (
            <Mute t={t}>—</Mute>
          ) : collapsedAsCount && pairs.length > 4 ? (
            <span style={{ fontSize: FS_MD, color: t.textDim }}>
              {pairs.length} total
            </span>
          ) : (
            <KeyValueChips t={t} pairs={pairs} />
          )}
          {/* Place the edit chrome under the value cell so the row label
              column stays fixed-width; right-aligned via flex. */}
          {right && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: edit.editing ? 6 : 4,
              }}
            >
              {right}
            </div>
          )}
        </div>
      </DetailRow>
    </>
  );
}

// ── SelectorRow ────────────────────────────────────────────────────────────
// Renders a workload's label selector as chips + a match-expressions count.
// Used inside the kind-specific section, not as its own block.
export function SelectorRow({
  t,
  selector,
}: {
  t: Tokens;
  selector: LabelSelectorSummary | null;
}) {
  if (!selector) return null;
  const hasLabels = selector.match_labels.length > 0;
  const hasExpr = selector.match_expressions > 0;
  if (!hasLabels && !hasExpr) return null;
  return (
    <DetailRow t={t} label="Selector">
      {hasLabels && <KeyValueChips t={t} pairs={selector.match_labels} />}
      {hasExpr && (
        <span style={{ fontSize: FS_SM, color: t.textDim, marginLeft: 6 }}>
          + {selector.match_expressions} matchExpression
          {selector.match_expressions === 1 ? "" : "s"}
        </span>
      )}
    </DetailRow>
  );
}

// ── ConditionsSection ──────────────────────────────────────────────────────
// Renders workload conditions as label/value rows. Unlike Pod conditions
// (which are a chip strip), workload conditions carry meaningful messages —
// "ProgressDeadlineExceeded", "MinimumReplicasUnavailable" — that operators
// need to read fully.
export function ConditionsSection({
  t,
  conditions,
}: {
  t: Tokens;
  conditions: WorkloadCondition[];
}) {
  if (conditions.length === 0) return null;
  return (
    <>
      <Section
        t={t}
        title="Conditions"
        right={
          <span
            style={{
              fontSize: FS_XS,
              color: t.textMuted,
              fontFamily: FF_MONO,
            }}
          >
            {conditions.length} total
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        {conditions.map((c) => (
          <DetailRow key={c.type} t={t} label={c.type}>
            <ConditionStatusChip t={t} status={c.status} />
            {c.reason && (
              <span style={{ fontSize: FS_SM, color: t.textDim }}>
                {c.reason}
              </span>
            )}
            {c.message && (
              <div
                style={{
                  fontSize: FS_SM,
                  color: t.textMuted,
                  width: "100%",
                  marginTop: 2,
                  wordBreak: "break-word",
                }}
              >
                {c.message}
              </div>
            )}
            {c.last_transition_time && (
              <span
                style={{
                  fontSize: FS_SM,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                  marginLeft: "auto",
                }}
              >
                {ageFromIso(c.last_transition_time)} ago
              </span>
            )}
          </DetailRow>
        ))}
      </div>
    </>
  );
}

function ConditionStatusChip({ t, status }: { t: Tokens; status: string }) {
  const ok = status === "True";
  const bg = ok ? "rgba(16,185,129,0.16)" : "rgba(244,63,94,0.16)";
  const fg = ok ? t.good : t.bad;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: R_SM,
        fontSize: FS_SM,
        fontWeight: 600,
        background: bg,
        color: fg,
      }}
    >
      {status}
    </span>
  );
}

// ── PodTemplateSection ─────────────────────────────────────────────────────
// One block summarising the workload's PodTemplateSpec — pod-level fields
// (service account, node selector, restart policy, host* flags) followed by
// container cards. Operators read this to answer "what does each pod look
// like" without opening a real Pod.
export function PodTemplateSection({
  t,
  template,
  namespace,
  onNavigate,
  editTarget,
  templateKind = "workload",
}: {
  t: Tokens;
  template: PodTemplateSummary;
  namespace: string | null;
  onNavigate?: DetailNavigate;
  // When provided, container cards expose inline env / ports editors and a
  // VolumesEditor below the section. SSA paths depend on `templateKind`:
  //   workload: spec.template.spec.…
  //   cronjob:  spec.jobTemplate.spec.template.spec.…
  // The actual SSA save flows through the panel-scoped EditSession.
  editTarget?: ApplyTarget;
  templateKind?: "workload" | "cronjob";
}) {
  const initContainers = template.containers.filter((c) => c.kind === "init");
  const mainContainers = template.containers.filter((c) => c.kind !== "init");
  const hostFlags: { label: string; tone: "bad" }[] = [];
  if (template.host_network) hostFlags.push({ label: "hostNetwork", tone: "bad" });
  if (template.host_pid) hostFlags.push({ label: "hostPID", tone: "bad" });
  if (template.host_ipc) hostFlags.push({ label: "hostIPC", tone: "bad" });

  return (
    <>
      <Section t={t} title="Pod Template" />
      <div style={{ marginBottom: 22 }}>
        {template.labels.length > 0 && (
          <DetailRow t={t} label="Pod Labels">
            <KeyValueChips t={t} pairs={template.labels} />
          </DetailRow>
        )}
        {template.annotations_count > 0 && (
          <DetailRow t={t} label="Pod Annotations">
            <span style={{ fontSize: FS_MD, color: t.textDim }}>
              {template.annotations_count} total
            </span>
          </DetailRow>
        )}
        {template.service_account && (
          <DetailRow t={t} label="Service Account">
            <LinkValue
              t={t}
              onClick={() =>
                onNavigate?.(
                  "ServiceAccount",
                  namespace,
                  template.service_account!,
                )
              }
              copyText={template.service_account}
              enabled={!!onNavigate}
            >
              {template.service_account}
            </LinkValue>
          </DetailRow>
        )}
        {template.restart_policy && template.restart_policy !== "Always" && (
          <DetailRow t={t} label="Restart Policy">
            <span style={{ fontSize: FS_MD }}>{template.restart_policy}</span>
          </DetailRow>
        )}
        {template.priority_class && (
          <DetailRow t={t} label="Priority Class">
            <Copyable text={template.priority_class}>
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
                {template.priority_class}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {template.node_selector.length > 0 && (
          <DetailRow t={t} label="Node Selector">
            <KeyValueChips t={t} pairs={template.node_selector} />
          </DetailRow>
        )}
        {template.tolerations_count > 0 && (
          <DetailRow t={t} label="Tolerations">
            <span style={{ fontSize: FS_MD, color: t.textDim }}>
              {template.tolerations_count} total
            </span>
          </DetailRow>
        )}
        {template.image_pull_secrets.length > 0 && (
          <DetailRow t={t} label="Image Pull Secrets">
            <ChipWrap>
              {template.image_pull_secrets.map((name) => (
                <LinkValue
                  key={name}
                  t={t}
                  onClick={() => onNavigate?.("Secret", namespace, name)}
                  copyText={name}
                  enabled={!!onNavigate}
                >
                  {name}
                </LinkValue>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {hostFlags.length > 0 && (
          <DetailRow t={t} label="Host Namespaces">
            <ChipStrip t={t} items={hostFlags} />
          </DetailRow>
        )}
      </div>

      {initContainers.length > 0 && (
        <>
          <Section
            t={t}
            title="Init Containers"
            right={
              <span
                style={{
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                }}
              >
                {initContainers.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {initContainers.map((c) => (
              <ContainerSummaryCard
                key={c.name}
                t={t}
                c={c}
                editTarget={editTarget}
                templateKind={templateKind}
                onNavigate={onNavigate}
                podNamespace={namespace}
                siblingContainerNames={template.containers.map((x) => x.name)}
                siblingVolumeNames={template.volumes.map((v) => v.name)}
              />
            ))}
          </div>
        </>
      )}

      {mainContainers.length > 0 && (
        <>
          <Section
            t={t}
            title="Containers"
            right={
              <span
                style={{
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                }}
              >
                {mainContainers.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {mainContainers.map((c) => (
              <ContainerSummaryCard
                key={c.name}
                t={t}
                c={c}
                editTarget={editTarget}
                templateKind={templateKind}
                onNavigate={onNavigate}
                podNamespace={namespace}
                siblingContainerNames={template.containers.map((x) => x.name)}
                siblingVolumeNames={template.volumes.map((v) => v.name)}
              />
            ))}
          </div>
        </>
      )}

      {editTarget && (
        <VolumesEditor
          t={t}
          volumes={template.volumes}
          podNamespace={namespace}
          onNavigate={onNavigate}
          serializeFor={(vols) =>
            templateKind === "cronjob"
              ? {
                  spec: {
                    jobTemplate: {
                      spec: {
                        template: { spec: { volumes: vols } },
                      },
                    },
                  },
                }
              : {
                  spec: { template: { spec: { volumes: vols } } },
                }
          }
        />
      )}
    </>
  );
}

function ContainerSummaryCard({
  t,
  c,
  editTarget,
  templateKind = "workload",
  onNavigate,
  podNamespace,
  siblingContainerNames,
  siblingVolumeNames,
}: {
  t: Tokens;
  c: WorkloadContainerSummary;
  editTarget?: ApplyTarget;
  templateKind?: "workload" | "cronjob";
  onNavigate?: DetailNavigate;
  podNamespace?: string | null;
  siblingContainerNames?: string[];
  // Volume names declared on the enclosing pod template — used by the
  // MountsEditor's volume-name Select so the operator can only mount
  // volumes that actually exist.
  siblingVolumeNames?: string[];
}) {
  const wrapTemplate = (inner: Record<string, unknown>) =>
    templateKind === "cronjob"
      ? { spec: { jobTemplate: { spec: { template: { spec: inner } } } } }
      : { spec: { template: { spec: inner } } };
  const hasResources =
    (c.requests && Object.keys(c.requests).length > 0) ||
    (c.limits && Object.keys(c.limits).length > 0);
  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: R_LG,
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
        <Copyable text={c.name}>
          <span
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              fontWeight: 600,
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {c.name}
          </span>
        </Copyable>
        <span
          style={{
            fontSize: FS_XS,
            fontWeight: 700,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontFamily: FF_MONO,
          }}
        >
          {c.kind}
        </span>
      </div>
      <div style={{ padding: "4px 12px" }}>
        {editTarget ? (
          <ImageEditor
            t={t}
            containerName={c.name}
            containerKind={c.kind}
            image={c.image}
            imagePullPolicy={c.image_pull_policy}
            serializeFor={(co) =>
              wrapTemplate(
                co.isInit
                  ? {
                      initContainers: [
                        {
                          name: co.name,
                          ...(co.image !== undefined ? { image: co.image } : {}),
                          ...(co.imagePullPolicy !== undefined
                            ? { imagePullPolicy: co.imagePullPolicy }
                            : {}),
                        },
                      ],
                    }
                  : {
                      containers: [
                        {
                          name: co.name,
                          ...(co.image !== undefined ? { image: co.image } : {}),
                          ...(co.imagePullPolicy !== undefined
                            ? { imagePullPolicy: co.imagePullPolicy }
                            : {}),
                        },
                      ],
                    },
              )
            }
          />
        ) : (
          <>
            {c.image && (
              <DetailRow t={t} label="Image">
                <Copyable text={c.image}>
                  <span
                    style={{
                      fontFamily: FF_MONO,
                      fontSize: FS_SM,
                      wordBreak: "break-all",
                    }}
                  >
                    {c.image}
                  </span>
                </Copyable>
              </DetailRow>
            )}
            {c.image_pull_policy && (
              <DetailRow t={t} label="ImagePullPolicy">
                <span style={{ fontSize: FS_MD }}>{c.image_pull_policy}</span>
              </DetailRow>
            )}
          </>
        )}
        {c.ports.length > 0 && (
          <DetailRow t={t} label="Ports">
            <ChipWrap>
              {c.ports.map((p) => (
                <Copyable
                  key={`${p.name ?? ""}:${p.container_port}`}
                  text={String(p.container_port)}
                >
                  <Chip t={t} mono>
                    {p.name ? `${p.name}:` : ""}
                    {p.container_port}
                    {p.protocol && p.protocol !== "TCP" ? `/${p.protocol}` : ""}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {editTarget ? (
          <ResourcesEditor
            t={t}
            containerName={c.name}
            containerKind={c.kind}
            requests={c.requests}
            limits={c.limits}
            serializeFor={(co) =>
              wrapTemplate(
                co.isInit
                  ? {
                      initContainers: [
                        { name: co.name, resources: co.resources },
                      ],
                    }
                  : {
                      containers: [
                        { name: co.name, resources: co.resources },
                      ],
                    },
              )
            }
          />
        ) : (
          hasResources && (
            <DetailRow t={t} label="Resources">
              <SubGrid
                t={t}
                groups={[
                  ...(c.requests && Object.keys(c.requests).length > 0
                    ? [
                        {
                          label: "Requests",
                          entries: Object.entries(c.requests).map(([k, v]) => ({
                            key: k,
                            value: formatQuantity(k, v),
                          })),
                        },
                      ]
                    : []),
                  ...(c.limits && Object.keys(c.limits).length > 0
                    ? [
                        {
                          label: "Limits",
                          entries: Object.entries(c.limits).map(([k, v]) => ({
                            key: k,
                            value: formatQuantity(k, v),
                          })),
                        },
                      ]
                    : []),
                ]}
              />
            </DetailRow>
          )
        )}
        {c.command && c.command.length > 0 && (
          <DetailRow t={t} label="Command">
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_SM,
                wordBreak: "break-all",
              }}
            >
              {c.command.join(" ")}
            </span>
          </DetailRow>
        )}
        {c.args && c.args.length > 0 && (
          <DetailRow t={t} label="Args">
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_SM,
                wordBreak: "break-all",
              }}
            >
              {c.args.join(" ")}
            </span>
          </DetailRow>
        )}
        {editTarget && (
          <>
            <PortsEditor
              t={t}
              containerName={c.name}
              ports={c.ports}
              serializeFor={(co) =>
                wrapTemplate(
                  c.kind === "init" || c.kind === "sidecar"
                    ? {
                        initContainers: [
                          { name: co.name, ports: co.ports },
                        ],
                      }
                    : {
                        containers: [{ name: co.name, ports: co.ports }],
                      },
                )
              }
              forwardTarget={
                editTarget.namespace
                  ? {
                      kind: kindIdToKind(editTarget.kindId),
                      namespace: editTarget.namespace,
                      name: editTarget.name,
                    }
                  : undefined
              }
            />
            <EnvEditor
              t={t}
              containerName={c.name}
              env={c.env}
              serializeFor={(co) =>
                wrapTemplate(
                  c.kind === "init" || c.kind === "sidecar"
                    ? {
                        initContainers: [{ name: co.name, env: co.env }],
                      }
                    : {
                        containers: [{ name: co.name, env: co.env }],
                      },
                )
              }
              onNavigate={onNavigate}
              podNamespace={podNamespace ?? null}
              siblingContainerNames={siblingContainerNames?.filter(
                (n) => n !== c.name,
              )}
            />
            <EnvFromEditor
              t={t}
              containerName={c.name}
              entries={c.env_from}
              serializeFor={(co) =>
                wrapTemplate(
                  c.kind === "init" || c.kind === "sidecar"
                    ? {
                        initContainers: [
                          { name: co.name, envFrom: co.envFrom },
                        ],
                      }
                    : {
                        containers: [{ name: co.name, envFrom: co.envFrom }],
                      },
                )
              }
              onNavigate={onNavigate}
              podNamespace={podNamespace ?? null}
            />
            <MountsEditor
              t={t}
              containerName={c.name}
              mounts={c.mounts}
              serializeFor={(co) =>
                wrapTemplate(
                  c.kind === "init" || c.kind === "sidecar"
                    ? {
                        initContainers: [
                          { name: co.name, volumeMounts: co.volumeMounts },
                        ],
                      }
                    : {
                        containers: [
                          { name: co.name, volumeMounts: co.volumeMounts },
                        ],
                      },
                )
              }
              volumeNames={siblingVolumeNames ?? []}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── ReplicaCountsRow ───────────────────────────────────────────────────────
// Tiny helper for "N / M" replica counts. Keeps colouring consistent across
// kinds — green when ready == desired, amber otherwise.
export function ReplicaCounts({
  t,
  ready,
  desired,
}: {
  t: Tokens;
  ready: number;
  desired: number;
}) {
  const ok = ready === desired && desired > 0;
  return (
    <span
      style={{
        fontFamily: FF_MONO,
        fontSize: FS_MD,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: ok ? t.good : ready === 0 ? t.bad : t.warn,
      }}
    >
      {ready} / {desired}
    </span>
  );
}

// ── ReplicasEditor ─────────────────────────────────────────────────────────
//
// Click-to-edit pencil + small numeric input that rolls out a new desired
// replica count via SSA on `spec.replicas`. We don't go through the
// dedicated `/scale` subresource — that's a separate Tauri command we
// haven't wired (RBAC distinction is rarely meaningful in operator UIs;
// anyone with edit perms on the parent has scale perms too in practice).
//
// Render is a tiny pill — same `EditModeChrome` chrome as everywhere else.
// Use it next to `ReplicaCounts` in each kind's header row.
export function ReplicasEditor({
  t,
  desired,
}: {
  t: Tokens;
  desired: number;
}) {
  const edit = useEditField<{ value: string }>({
    id: "replicas",
    initial: () => ({ value: String(desired) }),
    serialize: (b) => {
      const n = Number.parseInt(b.value, 10);
      return { spec: { replicas: Number.isFinite(n) && n >= 0 ? n : desired } };
    },
    dirtyCount: (b) => (b.value !== String(desired) ? 1 : 0),
    validate: (b) => {
      const n = Number.parseInt(b.value, 10);
      return b.value === "" ||
        !Number.isFinite(n) ||
        n < 0 ||
        String(n) !== b.value.trim()
        ? "replicas must be a non-negative integer"
        : null;
    },
  });
  const parsed = Number.parseInt(edit.buffer.value, 10);
  const invalid =
    edit.editing &&
    (edit.buffer.value === "" ||
      !Number.isFinite(parsed) ||
      parsed < 0 ||
      String(parsed) !== edit.buffer.value.trim());

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {edit.editing && (
        <input
          type="number"
          min={0}
          value={edit.buffer.value}
          onChange={(e) => edit.setBuffer({ value: e.target.value })}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              edit.cancel();
            }
          }}
          style={{
            width: 56,
            padding: "3px 6px",
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            background: t.bg,
            color: t.text,
            border: `1px solid ${invalid ? t.bad : t.borderSoft}`,
            borderRadius: R_SM,
            outline: "none",
          }}
        />
      )}
      <EditModeChrome
        t={t}
        editing={edit.editing}
        dirty={edit.dirty}
        saving={edit.saving}
        onEnter={edit.enter}
        onCancel={edit.cancel}
      />
    </span>
  );
}

// ── EnvEditor ──────────────────────────────────────────────────────────────
//
// Inline editor for a container's env entries — both literal `name=value`
// pairs and `valueFrom` refs (configMapKeyRef / secretKeyRef / fieldRef /
// resourceFieldRef). Each row carries a discriminating `kind` so the buffer
// can express any K8s envvar shape; serializer reconstructs the SSA payload
// per row.
//
// Caller owns *where* in the SSA payload the env array lives; the editor
// only knows the container name (the listMap merge key) and the new env
// list. Pod uses `spec.containers[*].env`; workload kinds use
// `spec.template.spec.containers[*].env`. We always emit the *complete*
// buffer on save — listMap merge by `name` lets the apiserver diff against
// the previously-owned set, removing entries we previously owned but no
// longer include and preserving entries owned by other managers.

type EnvRow =
  | { kind: "literal"; name: string; value: string }
  | {
      kind: "configMapKeyRef" | "secretKeyRef";
      name: string;
      ref_name: string;
      ref_key: string;
      optional: boolean;
    }
  | {
      kind: "fieldRef";
      name: string;
      field_path: string;
      api_version: string | null;
    }
  | {
      kind: "resourceFieldRef";
      name: string;
      resource: string;
      ref_container: string | null;
      divisor: string | null;
    };

function envRowFromContainer(e: ContainerEnv): EnvRow {
  if (!e.from) {
    return { kind: "literal", name: e.name, value: e.value ?? "" };
  }
  if (e.from.kind === "configMapKeyRef" || e.from.kind === "secretKeyRef") {
    return {
      kind: e.from.kind,
      name: e.name,
      ref_name: e.from.name ?? "",
      ref_key: e.from.key,
      optional: e.from.optional,
    };
  }
  if (e.from.kind === "fieldRef") {
    return {
      kind: "fieldRef",
      name: e.name,
      field_path: e.from.field_path,
      api_version: e.from.api_version,
    };
  }
  return {
    kind: "resourceFieldRef",
    name: e.name,
    resource: e.from.resource,
    ref_container: e.from.container_name,
    divisor: e.from.divisor,
  };
}

function envBufferFrom(env: ContainerEnv[]): ListBuffer<EnvRow> {
  return listBufferFrom(env.map(envRowFromContainer));
}

function envRowsEqual(a: EnvRow, b: EnvRow): boolean {
  if (a.kind !== b.kind) return false;
  if (a.name !== b.name) return false;
  switch (a.kind) {
    case "literal":
      return a.value === (b as { value: string }).value;
    case "configMapKeyRef":
    case "secretKeyRef": {
      const r = b as Extract<EnvRow, { kind: "configMapKeyRef" | "secretKeyRef" }>;
      return (
        a.ref_name === r.ref_name &&
        a.ref_key === r.ref_key &&
        a.optional === r.optional
      );
    }
    case "fieldRef": {
      const r = b as Extract<EnvRow, { kind: "fieldRef" }>;
      return a.field_path === r.field_path && a.api_version === r.api_version;
    }
    case "resourceFieldRef": {
      const r = b as Extract<EnvRow, { kind: "resourceFieldRef" }>;
      return (
        a.resource === r.resource &&
        a.ref_container === r.ref_container &&
        a.divisor === r.divisor
      );
    }
  }
}

function envBufferDirtyCount(b: ListBuffer<EnvRow>): number {
  return listBufferDirty(b, (cur, orig) => !envRowsEqual(cur, orig));
}

// Convert a single buffer row to the SSA env entry shape the apiserver
// expects. Defaults are dropped where Kubernetes already has a server-side
// default — keeps our SSA ownership minimal.
function envRowToSsa(r: EnvRow): Record<string, unknown> {
  switch (r.kind) {
    case "literal":
      return { name: r.name, value: r.value };
    case "configMapKeyRef":
    case "secretKeyRef": {
      const refKey = r.kind === "configMapKeyRef" ? "configMapKeyRef" : "secretKeyRef";
      const inner: Record<string, unknown> = {
        name: r.ref_name,
        key: r.ref_key,
      };
      if (r.optional) inner.optional = true;
      return { name: r.name, valueFrom: { [refKey]: inner } };
    }
    case "fieldRef": {
      const inner: Record<string, unknown> = { fieldPath: r.field_path };
      if (r.api_version) inner.apiVersion = r.api_version;
      return { name: r.name, valueFrom: { fieldRef: inner } };
    }
    case "resourceFieldRef": {
      const inner: Record<string, unknown> = { resource: r.resource };
      if (r.ref_container) inner.containerName = r.ref_container;
      if (r.divisor) inner.divisor = r.divisor;
      return { name: r.name, valueFrom: { resourceFieldRef: inner } };
    }
  }
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function EnvEditor({
  t,
  containerName,
  env,
  serializeFor,
  onNavigate,
  podNamespace,
  siblingContainerNames,
}: {
  t: Tokens;
  containerName: string;
  env: ContainerEnv[];
  // Given the new env array (in SSA shape — `{ name, value? }` for literals
  // and `{ name, valueFrom: ... }` for refs), produce the SSA payload
  // (without apiVersion/kind/metadata). Caller knows whether the path is
  // `spec.containers[]` (Pod) or `spec.template.spec.containers[]` (workload).
  serializeFor: (container: {
    name: string;
    env: Record<string, unknown>[];
  }) => Record<string, unknown>;
  // For making `valueFrom` ref chips clickable into the source ConfigMap /
  // Secret detail panel. Optional — falls back to plain copy when absent.
  onNavigate?: DetailNavigate;
  // Namespace of the pod template — refs always resolve in the workload's
  // own namespace, but the EnvEditor itself doesn't carry it (only the SSA
  // target's namespace, which for workloads is the same).
  podNamespace?: string | null;
  // Other container names in the same pod template — used to populate the
  // `resourceFieldRef.containerName` dropdown so the operator can reference
  // a sibling's resources without typing the name. The current container is
  // always the implied default when omitted.
  siblingContainerNames?: string[];
}) {
  const session = useEditSession();
  const edit = useEditField<ListBuffer<EnvRow>>({
    id: `env:${containerName}`,
    initial: () => envBufferFrom(env),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        env: listBufferToArray(b, envRowToSsa),
      }),
    dirtyCount: envBufferDirtyCount,
  });

  // Picker overlay state: which row is currently picking, and which kind
  // of source. Cleared on confirm or cancel.
  const [picker, setPicker] = useState<{
    rowId: number;
    kind: "ConfigMap" | "Secret";
  } | null>(null);

  // Validation: surface invalid names / duplicates / blank names so save can
  // still be attempted (apiserver is final arbiter) but the operator sees
  // the issue first.
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

  const literals = env.filter((e) => e.from === null);
  const refs = env.filter((e) => e.from !== null);

  function applyPicker(sel: KeyRefSelection) {
    if (!picker) return;
    const rowId = picker.rowId;
    const refKind = picker.kind === "ConfigMap" ? "configMapKeyRef" : "secretKeyRef";
    edit.setBuffer({
      ...edit.buffer,
      rows: edit.buffer.rows.map((r) =>
        r.id !== rowId
          ? r
          : {
              ...r,
              kind: refKind,
              ref_name: sel.name,
              ref_key: sel.key,
              optional: sel.optional,
            } as typeof r,
      ),
    });
    setPicker(null);
  }

  return (
    <DetailRow t={t} label="Env">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
            {dupNames.size > 0 && (
              <div
                style={{
                  margin: "0 0 6px",
                  fontSize: FS_SM,
                  color: t.bad,
                  fontFamily: FF_MONO,
                }}
              >
                Duplicate env names: {[...dupNames].join(", ")}
              </div>
            )}
            <ListEditor
              t={t}
              buffer={edit.buffer}
              onChange={edit.setBuffer}
              blank={{ kind: "literal", name: "", value: "" } as EnvRow}
              addLabel="Add env"
              rowGap={4}
              renderRow={(row, onRowChange) => (
                <EnvRowEditor
                  t={t}
                  row={row}
                  onChange={onRowChange}
                  invalidName={
                    row.name !== "" &&
                    (!ENV_NAME_RE.test(row.name) || dupNames.has(row.name))
                  }
                  onPickRef={(kind) =>
                    podNamespace
                      ? setPicker({ rowId: row.id, kind })
                      : null
                  }
                  pickerAvailable={!!podNamespace}
                  siblingContainerNames={siblingContainerNames ?? []}
                />
              )}
              renderDeletedSummary={(row) => envRowSummary(row.original ?? row)}
            />
          </>
        ) : literals.length === 0 && refs.length === 0 ? (
          <Mute t={t}>—</Mute>
        ) : (
          <ChipWrap>
            {literals.map((e) => (
              <Copyable key={`lit:${e.name}`} text={`${e.name}=${e.value ?? ""}`}>
                <Chip t={t} mono>
                  {e.name}={e.value ?? ""}
                </Chip>
              </Copyable>
            ))}
            {refs.map((e) => (
              <EnvRefChip
                key={`ref:${e.name}`}
                t={t}
                e={e}
                onNavigate={onNavigate}
                podNamespace={podNamespace ?? null}
              />
            ))}
          </ChipWrap>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: edit.editing ? 6 : 4,
          }}
        >
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
          />
        </div>
      </div>
      {picker && podNamespace && (
        <KeyRefPicker
          t={t}
          clusterId={session?.target.clusterId ?? ""}
          namespace={podNamespace}
          kind={picker.kind}
          initial={(() => {
            const r = edit.buffer.rows.find((x) => x.id === picker.rowId);
            const k: "configMapKeyRef" | "secretKeyRef" =
              picker.kind === "ConfigMap" ? "configMapKeyRef" : "secretKeyRef";
            return r && r.kind === k
              ? { name: r.ref_name, key: r.ref_key, optional: r.optional }
              : undefined;
          })()}
          onCancel={() => setPicker(null)}
          onConfirm={applyPicker}
        />
      )}
    </DetailRow>
  );
}

// One-line summary for a deleted row in the strike-through list.
function envRowSummary(row: EnvRow): string {
  const n = row.name || "?";
  switch (row.kind) {
    case "literal":
      return `${n}=${row.value}`;
    case "configMapKeyRef":
      return `${n}=cm:${row.ref_name}.${row.ref_key}`;
    case "secretKeyRef":
      return `${n}=sec:${row.ref_name}.${row.ref_key}`;
    case "fieldRef":
      return `${n}=field:${row.field_path}`;
    case "resourceFieldRef":
      return `${n}=resource:${row.ref_container ? row.ref_container + ":" : ""}${row.resource}`;
  }
}

// Per-row editor — dispatches on `kind` so each variant can render the
// controls it needs without leaking that logic into the buffer plumbing.
function EnvRowEditor({
  t,
  row,
  onChange,
  invalidName,
  onPickRef,
  pickerAvailable,
  siblingContainerNames,
}: {
  t: Tokens;
  row: EnvRow;
  onChange: (next: Partial<EnvRow>) => void;
  invalidName: boolean;
  onPickRef: (kind: "ConfigMap" | "Secret") => void;
  pickerAvailable: boolean;
  siblingContainerNames: string[];
}) {
  function changeKind(nextKind: EnvRow["kind"]) {
    if (nextKind === row.kind) return;
    // Carry the env var `name` across; reset variant-specific fields to
    // sane defaults so the row never lands in an invalid intermediate.
    const base = { name: row.name };
    let next: EnvRow;
    switch (nextKind) {
      case "literal":
        next = { kind: "literal", ...base, value: "" };
        break;
      case "configMapKeyRef":
      case "secretKeyRef":
        next = {
          kind: nextKind,
          ...base,
          ref_name: "",
          ref_key: "",
          optional: false,
        };
        break;
      case "fieldRef":
        next = {
          kind: "fieldRef",
          ...base,
          field_path: "metadata.name",
          api_version: null,
        };
        break;
      case "resourceFieldRef":
        next = {
          kind: "resourceFieldRef",
          ...base,
          resource: "limits.cpu",
          ref_container: null,
          divisor: null,
        };
        break;
    }
    onChange(next as unknown as Partial<EnvRow>);
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 120px 2fr",
        gap: 6,
        alignItems: "center",
      }}
    >
      <EditableTextValue
        t={t}
        value={row.name}
        onChange={(v) => onChange({ name: v })}
        placeholder="NAME"
        invalid={invalidName}
      />
      <Select<EnvRow["kind"]>
        t={t}
        value={row.kind}
        onChange={(v) => changeKind(v)}
        options={[
          { value: "literal", label: "literal" },
          { value: "configMapKeyRef", label: "cm ref" },
          { value: "secretKeyRef", label: "secret ref" },
          { value: "fieldRef", label: "field ref" },
          { value: "resourceFieldRef", label: "resource ref" },
        ]}
      />
      <EnvRowVariantControls
        t={t}
        row={row}
        onChange={onChange}
        onPickRef={onPickRef}
        pickerAvailable={pickerAvailable}
        siblingContainerNames={siblingContainerNames}
      />
    </div>
  );
}

function EnvRowVariantControls({
  t,
  row,
  onChange,
  onPickRef,
  pickerAvailable,
  siblingContainerNames,
}: {
  t: Tokens;
  row: EnvRow;
  onChange: (next: Partial<EnvRow>) => void;
  onPickRef: (kind: "ConfigMap" | "Secret") => void;
  pickerAvailable: boolean;
  siblingContainerNames: string[];
}) {
  switch (row.kind) {
    case "literal":
      return (
        <EditableTextValue
          t={t}
          value={row.value}
          onChange={(v) => onChange({ value: v } as Partial<EnvRow>)}
          placeholder="value"
        />
      );
    case "configMapKeyRef":
    case "secretKeyRef": {
      const targetKind = row.kind === "configMapKeyRef" ? "ConfigMap" : "Secret";
      const filled = row.ref_name !== "" && row.ref_key !== "";
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            fullWidth
            disabled={!pickerAvailable}
            title={
              pickerAvailable
                ? `Pick ${targetKind} key`
                : "Picker requires a namespace"
            }
            onClick={() => onPickRef(targetKind)}
            style={{
              justifyContent: "flex-start",
              fontFamily: FF_MONO,
              color: filled ? t.text : t.textMuted,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {filled
              ? `${targetKind === "ConfigMap" ? "cm" : "sec"}:${row.ref_name}.${row.ref_key}`
              : `Pick ${targetKind.toLowerCase()}…`}
          </Btn>
          <label
            style={{
              fontSize: FS_SM,
              color: t.textDim,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: FF_MONO,
              cursor: "pointer",
            }}
            title="Don't fail if key is missing"
          >
            <Checkbox
              t={t}
              checked={row.optional}
              onChange={(v) =>
                onChange({ optional: v } as Partial<EnvRow>)
              }
              size={13}
            />
            opt
          </label>
        </div>
      );
    }
    case "fieldRef":
      return (
        <EditableTextValue
          t={t}
          value={row.field_path}
          onChange={(v) =>
            onChange({ field_path: v } as Partial<EnvRow>)
          }
          placeholder="metadata.name"
          ariaLabel="fieldRef path"
        />
      );
    case "resourceFieldRef":
      return (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            minWidth: 0,
          }}
        >
          <EditableTextValue
            t={t}
            value={row.resource}
            onChange={(v) =>
              onChange({ resource: v } as Partial<EnvRow>)
            }
            placeholder="limits.cpu"
            ariaLabel="resourceFieldRef resource"
          />
          <Select<string>
            t={t}
            value={row.ref_container ?? ""}
            onChange={(v) =>
              onChange({
                ref_container: v === "" ? null : v,
              } as Partial<EnvRow>)
            }
            options={[
              { value: "", label: "(this container)" },
              ...siblingContainerNames.map((n) => ({ value: n, label: n })),
            ]}
          />
        </div>
      );
  }
}

// Read-only chip for a single `valueFrom` env entry. Kind-aware so the
// operator can see at a glance which source backs an env var, plus a
// LinkValue into the source object when it's a ConfigMap or Secret.
function EnvRefChip({
  t,
  e,
  onNavigate,
  podNamespace,
}: {
  t: Tokens;
  e: ContainerEnv;
  onNavigate?: DetailNavigate;
  podNamespace: string | null;
}) {
  const from = e.from;
  if (!from) return null;
  if (from.kind === "configMapKeyRef" || from.kind === "secretKeyRef") {
    const targetKind = from.kind === "configMapKeyRef" ? "ConfigMap" : "Secret";
    const refName = from.name ?? "";
    const copyText = `${e.name}=$(${targetKind}:${refName}.${from.key})`;
    return (
      <Chip t={t} mono>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span>{e.name}</span>
          <span style={{ opacity: 0.55 }}>=</span>
          <LinkValue
            t={t}
            onClick={() =>
              refName && onNavigate?.(targetKind, podNamespace, refName)
            }
            copyText={copyText}
            enabled={!!onNavigate && refName !== ""}
          >
            <span style={{ fontFamily: FF_MONO }}>
              {targetKind === "ConfigMap" ? "cm" : "sec"}:{refName || "?"}.
              {from.key}
            </span>
          </LinkValue>
          {from.optional && (
            <span style={{ opacity: 0.55 }} title="optional">
              ?
            </span>
          )}
        </span>
      </Chip>
    );
  }
  if (from.kind === "fieldRef") {
    return (
      <Copyable text={`${e.name}=$(field:${from.field_path})`}>
        <Chip t={t} mono>
          <span>{e.name}</span>
          <span style={{ opacity: 0.55 }}>=</span>
          <span style={{ opacity: 0.85 }}>field:{from.field_path}</span>
        </Chip>
      </Copyable>
    );
  }
  // resourceFieldRef
  const container = from.container_name ? `${from.container_name}:` : "";
  const divisor = from.divisor ? ` /${from.divisor}` : "";
  return (
    <Copyable text={`${e.name}=$(resource:${container}${from.resource}${divisor})`}>
      <Chip t={t} mono>
        <span>{e.name}</span>
        <span style={{ opacity: 0.55 }}>=</span>
        <span style={{ opacity: 0.85 }}>
          resource:{container}
          {from.resource}
          {divisor}
        </span>
      </Chip>
    </Copyable>
  );
}

// ── ResourcesEditor ────────────────────────────────────────────────────────
//
// Inline edit for `containers[*].resources.requests` and `…resources.limits`.
// Each side is a key→quantity map (cpu, memory, ephemeral-storage,
// hugepages-*) — we render two ListEditors so the operator can add/remove
// rows independently. Validation parses each value as a Kubernetes Quantity
// and surfaces unparseable rows in red — apiserver remains the final
// arbiter, but the operator sees the issue before save.
//
// SSA payload: `containers[].resources.{requests,limits}`. We always emit
// both maps (possibly empty) when either side has any rows, so removing a
// row actually removes it (otherwise SSA would only diff added/changed
// fields and keep the previously-owned key).

type ResourceFieldRow = { key: string; value: string };
type ResourcesBuffer = {
  requests: ListBuffer<ResourceFieldRow>;
  limits: ListBuffer<ResourceFieldRow>;
};

const RESOURCE_KEY_SUGGESTIONS = [
  "cpu",
  "memory",
  "ephemeral-storage",
  "hugepages-1Gi",
  "hugepages-2Mi",
] as const;

function resourcesBufferFrom(
  requests: Record<string, string> | null,
  limits: Record<string, string> | null,
): ResourcesBuffer {
  const toRows = (m: Record<string, string> | null): ResourceFieldRow[] =>
    Object.entries(m ?? {}).map(([k, v]) => ({ key: k, value: v }));
  return {
    requests: listBufferFrom(toRows(requests)),
    limits: listBufferFrom(toRows(limits)),
  };
}

function resourcesDirtyCount(b: ResourcesBuffer): number {
  const cmp = (cur: ResourceFieldRow, orig: ResourceFieldRow) =>
    cur.key !== orig.key || cur.value !== orig.value;
  return listBufferDirty(b.requests, cmp) + listBufferDirty(b.limits, cmp);
}

function resourceRowsToMap(
  buffer: ListBuffer<ResourceFieldRow>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of listBufferToArray(buffer, (x) => x)) {
    if (r.key === "") continue;
    out[r.key] = r.value;
  }
  return out;
}

export function ResourcesEditor({
  t,
  containerName,
  containerKind,
  requests,
  limits,
  serializeFor,
}: {
  t: Tokens;
  containerName: string;
  containerKind: "init" | "main" | "sidecar";
  requests: Record<string, string> | null;
  limits: Record<string, string> | null;
  serializeFor: (container: {
    name: string;
    resources: {
      requests: Record<string, string>;
      limits: Record<string, string>;
    };
    isInit: boolean;
  }) => Record<string, unknown>;
}) {
  const edit = useEditField<ResourcesBuffer>({
    id: `resources:${containerName}`,
    initial: () => resourcesBufferFrom(requests, limits),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        isInit: containerKind === "init" || containerKind === "sidecar",
        resources: {
          requests: resourceRowsToMap(b.requests),
          limits: resourceRowsToMap(b.limits),
        },
      }),
    dirtyCount: resourcesDirtyCount,
  });

  // Validation: per-side duplicate keys + invalid quantity values. Render
  // markers above each list.
  const dupReq = useMemo(
    () => duplicateKeysIn(edit.editing ? edit.buffer.requests : null),
    [edit.editing, edit.buffer],
  );
  const dupLim = useMemo(
    () => duplicateKeysIn(edit.editing ? edit.buffer.limits : null),
    [edit.editing, edit.buffer],
  );

  const hasAny =
    (requests && Object.keys(requests).length > 0) ||
    (limits && Object.keys(limits).length > 0);

  return (
    <DetailRow t={t} label="Resources">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
            <ResourcesSide
              t={t}
              label="Requests"
              buffer={edit.buffer.requests}
              dupKeys={dupReq}
              onChange={(next) =>
                edit.setBuffer({ ...edit.buffer, requests: next })
              }
            />
            <div style={{ height: 6 }} />
            <ResourcesSide
              t={t}
              label="Limits"
              buffer={edit.buffer.limits}
              dupKeys={dupLim}
              onChange={(next) =>
                edit.setBuffer({ ...edit.buffer, limits: next })
              }
            />
          </>
        ) : !hasAny ? (
          <Mute t={t}>—</Mute>
        ) : (
          <SubGrid
            t={t}
            groups={[
              ...(requests && Object.keys(requests).length > 0
                ? [
                    {
                      label: "Requests",
                      entries: Object.entries(requests).map(([k, v]) => ({
                        key: k,
                        value: formatQuantity(k, v),
                      })),
                    },
                  ]
                : []),
              ...(limits && Object.keys(limits).length > 0
                ? [
                    {
                      label: "Limits",
                      entries: Object.entries(limits).map(([k, v]) => ({
                        key: k,
                        value: formatQuantity(k, v),
                      })),
                    },
                  ]
                : []),
            ]}
          />
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: edit.editing ? 6 : 4,
          }}
        >
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
          />
        </div>
      </div>
    </DetailRow>
  );
}

function duplicateKeysIn(
  b: ListBuffer<ResourceFieldRow> | null,
): Set<string> {
  if (!b) return new Set();
  const counts = new Map<string, number>();
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.key === "") continue;
    counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  }
  const dup = new Set<string>();
  for (const [k, n] of counts) if (n > 1) dup.add(k);
  return dup;
}

function ResourcesSide({
  t,
  label,
  buffer,
  dupKeys,
  onChange,
}: {
  t: Tokens;
  label: string;
  buffer: ListBuffer<ResourceFieldRow>;
  dupKeys: Set<string>;
  onChange: (next: ListBuffer<ResourceFieldRow>) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: FS_XS,
          fontFamily: FF_MONO,
          color: t.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          margin: "2px 0 4px",
        }}
      >
        {label}
      </div>
      <ListEditor
        t={t}
        buffer={buffer}
        onChange={onChange}
        blank={{ key: "cpu", value: "" } as ResourceFieldRow}
        addLabel={`Add ${label.toLowerCase().slice(0, -1)}`}
        renderRow={(row, onRowChange) => {
          const invalidValue =
            row.value !== "" && parseQuantity(row.value) == null;
          const invalidKey = row.key !== "" && dupKeys.has(row.key);
          // Allow free-text entry plus a quick-pick from common keys via a
          // trailing Select. Free-text covers exotic resources (CRD-defined
          // device plugins, hugepages-* variants).
          return (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px 1fr",
                gap: 6,
                alignItems: "center",
              }}
            >
              <EditableTextValue
                t={t}
                value={row.key}
                onChange={(v) => onRowChange({ key: v })}
                placeholder="cpu"
                invalid={invalidKey}
              />
              <Select<string>
                t={t}
                fullWidth={false}
                value={
                  RESOURCE_KEY_SUGGESTIONS.includes(
                    row.key as (typeof RESOURCE_KEY_SUGGESTIONS)[number],
                  )
                    ? row.key
                    : ""
                }
                onChange={(v) => v && onRowChange({ key: v })}
                options={[
                  { value: "", label: "preset…" },
                  ...RESOURCE_KEY_SUGGESTIONS.map((k) => ({
                    value: k,
                    label: k,
                  })),
                ]}
                style={{
                  fontFamily: FF_MONO,
                  fontSize: FS_MD,
                  height: 28,
                  padding: "4px 28px 4px 8px",
                }}
              />
              <EditableTextValue
                t={t}
                value={row.value}
                onChange={(v) => onRowChange({ value: v })}
                placeholder="100m / 1Gi"
                invalid={invalidValue}
              />
            </div>
          );
        }}
        renderDeletedSummary={(row) =>
          `${row.original?.key ?? row.key}=${row.original?.value ?? row.value}`
        }
      />
    </div>
  );
}

// ── ImageEditor ────────────────────────────────────────────────────────────
//
// Inline edit for `containers[*].image` + `imagePullPolicy`. Image is the
// most-edited container field on a workload (rolling out a new tag); pull
// policy is bundled because the two read together. Pod's apiserver allows
// image mutation on running Pods (the kubelet picks it up on the next
// restart); other containers fields stay immutable on Pod.
//
// The two fields render in one DetailRow each in read mode (preserving the
// existing layout) and share a single edit-mode chrome so the operator
// commits both in one save.

type ImageFields = { image: string; image_pull_policy: string };

const PULL_POLICY_OPTIONS = [
  { value: "", label: "(default)" },
  { value: "Always", label: "Always" },
  { value: "IfNotPresent", label: "IfNotPresent" },
  { value: "Never", label: "Never" },
] as const;

function imageBufferFrom(c: {
  image: string | null;
  image_pull_policy: string | null;
}): ImageFields {
  return {
    image: c.image ?? "",
    image_pull_policy: c.image_pull_policy ?? "",
  };
}

function imageDirtyCount(b: ImageFields, orig: ImageFields): number {
  let n = 0;
  if (b.image !== orig.image) n += 1;
  if (b.image_pull_policy !== orig.image_pull_policy) n += 1;
  return n;
}

export function ImageEditor({
  t,
  containerName,
  containerKind,
  image,
  imagePullPolicy,
  serializeFor,
}: {
  t: Tokens;
  containerName: string;
  containerKind: "init" | "main" | "sidecar";
  image: string | null;
  imagePullPolicy: string | null;
  serializeFor: (container: {
    name: string;
    image?: string;
    imagePullPolicy?: string;
    isInit: boolean;
  }) => Record<string, unknown>;
}) {
  const original = useMemo<ImageFields>(
    () => imageBufferFrom({ image, image_pull_policy: imagePullPolicy }),
    [image, imagePullPolicy],
  );
  const edit = useEditField<ImageFields>({
    id: `image:${containerName}`,
    initial: () => original,
    serialize: (b) => {
      const co: {
        name: string;
        image?: string;
        imagePullPolicy?: string;
        isInit: boolean;
      } = { name: containerName, isInit: containerKind === "init" || containerKind === "sidecar" };
      // Only include fields the operator actually changed — keeps SSA
      // ownership minimal.
      if (b.image !== original.image) co.image = b.image;
      if (b.image_pull_policy !== original.image_pull_policy) {
        if (b.image_pull_policy !== "") co.imagePullPolicy = b.image_pull_policy;
      }
      return serializeFor(co);
    },
    dirtyCount: (b) => imageDirtyCount(b, original),
  });

  return (
    <>
      <DetailRow t={t} label="Image">
        {edit.editing ? (
          <div style={{ width: "100%" }}>
            <EditableTextValue
              t={t}
              value={edit.buffer.image}
              onChange={(v) => edit.setBuffer({ ...edit.buffer, image: v })}
              placeholder="repo/image:tag"
            />
          </div>
        ) : image ? (
          <Copyable text={image}>
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_SM,
                wordBreak: "break-all",
              }}
            >
              {image}
            </span>
          </Copyable>
        ) : (
          <Mute t={t}>—</Mute>
        )}
      </DetailRow>
      <DetailRow t={t} label="ImagePullPolicy">
        {edit.editing ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              width: "100%",
            }}
          >
            <Select<string>
              t={t}
              fullWidth={false}
              value={edit.buffer.image_pull_policy}
              onChange={(v) =>
                edit.setBuffer({ ...edit.buffer, image_pull_policy: v })
              }
              options={PULL_POLICY_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_MD,
                height: 28,
                padding: "4px 28px 4px 8px",
              }}
            />
            <EditModeChrome
              t={t}
              editing={edit.editing}
              dirty={edit.dirty}
              saving={edit.saving}
              onEnter={edit.enter}
              onCancel={edit.cancel}
              />
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              width: "100%",
            }}
          >
            <span style={{ fontSize: FS_MD }}>
              {imagePullPolicy ?? <Mute t={t}>(default)</Mute>}
            </span>
            <EditModeChrome
              t={t}
              editing={edit.editing}
              dirty={edit.dirty}
              saving={edit.saving}
              onEnter={edit.enter}
              onCancel={edit.cancel}
              />
          </div>
        )}
      </DetailRow>
    </>
  );
}

// ── MountsEditor ───────────────────────────────────────────────────────────
//
// Inline editor for a container's `volumeMounts`. Read mode renders one
// DetailRow per mount with a SubGrid (mountPath, source volume name as a
// LinkValue navigating to the volume's row, subPath, readOnly chip). Edit
// mode swaps to a ListEditor with: Select for the volume name (sourced
// from the pod template's volumes via `volumeNames`), text inputs for
// mountPath and subPath, Checkbox for readOnly.
//
// Caller owns `serializeFor` and decides where in the SSA payload the
// `volumeMounts` array sits — Pod uses `spec.containers[*].volumeMounts`,
// workloads use `spec.template.spec.containers[*].volumeMounts`,
// CronJob nests one level deeper. ListMap merge key is `mountPath`.

type MountFields = {
  name: string;
  mount_path: string;
  sub_path: string;
  read_only: boolean;
};

function mountsBufferFrom(
  mounts: ContainerMount[],
): ListBuffer<MountFields> {
  return listBufferFrom(
    mounts.map((m) => ({
      name: m.name,
      mount_path: m.mount_path,
      sub_path: m.sub_path ?? "",
      read_only: m.read_only,
    })),
  );
}

function mountsDirtyCount(b: ListBuffer<MountFields>): number {
  return listBufferDirty(
    b,
    (cur, orig) =>
      cur.name !== orig.name ||
      cur.mount_path !== orig.mount_path ||
      cur.sub_path !== orig.sub_path ||
      cur.read_only !== orig.read_only,
  );
}

function mountFieldsToSsa(r: MountFields): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: r.name,
    mountPath: r.mount_path,
  };
  if (r.sub_path !== "") out.subPath = r.sub_path;
  if (r.read_only) out.readOnly = true;
  return out;
}

export function MountsEditor({
  t,
  containerName,
  mounts,
  serializeFor,
  volumeNames,
}: {
  t: Tokens;
  containerName: string;
  mounts: ContainerMount[];
  serializeFor: (container: {
    name: string;
    volumeMounts: Record<string, unknown>[];
  }) => Record<string, unknown>;
  volumeNames: string[];
}) {
  const edit = useEditField<ListBuffer<MountFields>>({
    id: `mounts:${containerName}`,
    initial: () => mountsBufferFrom(mounts),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        volumeMounts: listBufferToArray(b, mountFieldsToSsa),
      }),
    dirtyCount: mountsDirtyCount,
  });

  // Validation: mount paths must be unique within a container, must be
  // absolute (start with `/`), and must be non-empty.
  const dupPaths = useMemo(() => {
    if (!edit.editing) return new Set<string>();
    const counts = new Map<string, number>();
    for (const r of edit.buffer.rows) {
      if (r.deleted) continue;
      if (r.mount_path === "") continue;
      counts.set(r.mount_path, (counts.get(r.mount_path) ?? 0) + 1);
    }
    const dup = new Set<string>();
    for (const [k, n] of counts) if (n > 1) dup.add(k);
    return dup;
  }, [edit.editing, edit.buffer]);

  return (
    <DetailRow t={t} label="Mounts">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
            {dupPaths.size > 0 && (
              <div
                style={{
                  margin: "0 0 6px",
                  fontSize: FS_SM,
                  color: t.bad,
                  fontFamily: FF_MONO,
                }}
              >
                Duplicate mount paths: {[...dupPaths].join(", ")}
              </div>
            )}
            <ListEditor
              t={t}
              buffer={edit.buffer}
              onChange={edit.setBuffer}
              blank={
                {
                  name: volumeNames[0] ?? "",
                  mount_path: "",
                  sub_path: "",
                  read_only: false,
                } as MountFields
              }
              addLabel="Add mount"
              renderRow={(row, onRowChange) => {
                const invalidPath =
                  row.mount_path !== "" &&
                  (!row.mount_path.startsWith("/") ||
                    dupPaths.has(row.mount_path));
                // Volume might no longer exist (renamed/removed). Show it
                // anyway via an extra option so the operator can see + fix.
                const opts = volumeNames.includes(row.name) || row.name === ""
                  ? volumeNames.map((n) => ({ value: n, label: n }))
                  : [
                      { value: row.name, label: `${row.name} (missing)` },
                      ...volumeNames.map((n) => ({ value: n, label: n })),
                    ];
                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1.2fr 1.5fr 1fr auto",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <Select<string>
                      t={t}
                      value={row.name}
                      onChange={(v) => onRowChange({ name: v })}
                      options={
                        opts.length > 0
                          ? opts
                          : [{ value: "", label: "(no volumes)" }]
                      }
                    />
                    <EditableTextValue
                      t={t}
                      value={row.mount_path}
                      onChange={(v) => onRowChange({ mount_path: v })}
                      placeholder="/var/run/foo"
                      invalid={invalidPath}
                    />
                    <EditableTextValue
                      t={t}
                      value={row.sub_path}
                      onChange={(v) => onRowChange({ sub_path: v })}
                      placeholder="subPath (optional)"
                    />
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: FS_XS,
                        color: t.textDim,
                        fontFamily: FF_MONO,
                        cursor: "pointer",
                      }}
                      title="Mount as read-only"
                    >
                      <Checkbox
                        t={t}
                        checked={row.read_only}
                        onChange={(v) => onRowChange({ read_only: v })}
                        size={13}
                      />
                      ro
                    </label>
                  </div>
                );
              }}
              renderDeletedSummary={(row) =>
                `${row.original?.name ?? row.name} → ${row.original?.mount_path ?? row.mount_path}`
              }
            />
          </>
        ) : mounts.length === 0 ? (
          <Mute t={t}>—</Mute>
        ) : (
          <SubGrid
            t={t}
            entries={mounts.map((m) => ({
              key: m.mount_path,
              value: m.name + (m.sub_path ? `:${m.sub_path}` : ""),
              hint: m.read_only ? "ro" : undefined,
            }))}
          />
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: edit.editing ? 6 : 4,
          }}
        >
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
          />
        </div>
      </div>
    </DetailRow>
  );
}

// ── EnvFromEditor ──────────────────────────────────────────────────────────
//
// Inline editor for a container's `envFrom` — i.e. importing every key
// from a ConfigMap or Secret as env vars (with an optional `prefix`).
// Read mode shows one chip per source; edit mode lists rows with a Select
// for the kind, a "Pick…" button opening the name-only KeyRefPicker, an
// optional prefix text input, and an `optional` Checkbox.
//
// SSA shape: same listMap merge as env (key=name on env), but envFrom is
// a regular list (no merge keys) — we always emit the complete buffer.

type EnvFromRow = {
  kind: "configMapRef" | "secretRef";
  name: string;
  prefix: string;
  optional: boolean;
};

function envFromBufferFrom(
  entries: ContainerEnvFrom[],
): ListBuffer<EnvFromRow> {
  return listBufferFrom(
    entries.map((e) => ({
      kind: e.kind,
      name: e.name,
      prefix: e.prefix ?? "",
      optional: e.optional,
    })),
  );
}

function envFromDirtyCount(b: ListBuffer<EnvFromRow>): number {
  return listBufferDirty(
    b,
    (cur, orig) =>
      cur.kind !== orig.kind ||
      cur.name !== orig.name ||
      cur.prefix !== orig.prefix ||
      cur.optional !== orig.optional,
  );
}

function envFromRowToSsa(r: EnvFromRow): Record<string, unknown> {
  const innerKey = r.kind; // "configMapRef" | "secretRef"
  const inner: Record<string, unknown> = { name: r.name };
  if (r.optional) inner.optional = true;
  const out: Record<string, unknown> = { [innerKey]: inner };
  if (r.prefix !== "") out.prefix = r.prefix;
  return out;
}

export function EnvFromEditor({
  t,
  containerName,
  entries,
  serializeFor,
  onNavigate,
  podNamespace,
}: {
  t: Tokens;
  containerName: string;
  entries: ContainerEnvFrom[];
  serializeFor: (container: {
    name: string;
    envFrom: Record<string, unknown>[];
  }) => Record<string, unknown>;
  onNavigate?: DetailNavigate;
  podNamespace?: string | null;
}) {
  const session = useEditSession();
  const edit = useEditField<ListBuffer<EnvFromRow>>({
    id: `envFrom:${containerName}`,
    initial: () => envFromBufferFrom(entries),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        envFrom: listBufferToArray(b, envFromRowToSsa),
      }),
    dirtyCount: envFromDirtyCount,
  });

  const [picker, setPicker] = useState<{
    rowId: number;
    kind: "ConfigMap" | "Secret";
  } | null>(null);

  function applyPicker(sel: { name: string; optional: boolean }) {
    if (!picker) return;
    const rowId = picker.rowId;
    const refKind: EnvFromRow["kind"] =
      picker.kind === "ConfigMap" ? "configMapRef" : "secretRef";
    edit.setBuffer({
      ...edit.buffer,
      rows: edit.buffer.rows.map((r) =>
        r.id !== rowId
          ? r
          : ({
              ...r,
              kind: refKind,
              name: sel.name,
              optional: sel.optional,
            } as typeof r),
      ),
    });
    setPicker(null);
  }

  return (
    <DetailRow t={t} label="EnvFrom">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
            <ListEditor
              t={t}
              buffer={edit.buffer}
              onChange={edit.setBuffer}
              blank={
                {
                  kind: "configMapRef",
                  name: "",
                  prefix: "",
                  optional: false,
                } as EnvFromRow
              }
              addLabel="Add envFrom"
              renderRow={(row, onRowChange) => {
                const targetKind =
                  row.kind === "configMapRef" ? "ConfigMap" : "Secret";
                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "120px 1.5fr 1fr auto",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <Select<EnvFromRow["kind"]>
                      t={t}
                      value={row.kind}
                      onChange={(v) =>
                        onRowChange({ kind: v, name: "" } as Partial<EnvFromRow>)
                      }
                      options={[
                        { value: "configMapRef", label: "cm ref" },
                        { value: "secretRef", label: "secret ref" },
                      ]}
                    />
                    <Btn
                      t={t}
                      variant="secondary"
                      size="sm"
                      fullWidth
                      disabled={!podNamespace}
                      onClick={() =>
                        podNamespace
                          ? setPicker({ rowId: row.id, kind: targetKind })
                          : undefined
                      }
                      style={{
                        justifyContent: "flex-start",
                        fontFamily: FF_MONO,
                        color: row.name !== "" ? t.text : t.textMuted,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.name !== ""
                        ? `${targetKind === "ConfigMap" ? "cm" : "sec"}:${row.name}`
                        : `Pick ${targetKind.toLowerCase()}…`}
                    </Btn>
                    <EditableTextValue
                      t={t}
                      value={row.prefix}
                      onChange={(v) =>
                        onRowChange({ prefix: v } as Partial<EnvFromRow>)
                      }
                      placeholder="prefix (optional)"
                    />
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: FS_XS,
                        color: t.textDim,
                        fontFamily: FF_MONO,
                        cursor: "pointer",
                      }}
                      title="Don't fail if source missing"
                    >
                      <Checkbox
                        t={t}
                        checked={row.optional}
                        onChange={(v) =>
                          onRowChange({ optional: v } as Partial<EnvFromRow>)
                        }
                        size={13}
                      />
                      opt
                    </label>
                  </div>
                );
              }}
              renderDeletedSummary={(row) => {
                const k =
                  row.original?.kind ?? row.kind === "configMapRef"
                    ? "cm"
                    : "sec";
                return `${k}:${row.original?.name ?? row.name}`;
              }}
            />
          </>
        ) : entries.length === 0 ? (
          <Mute t={t}>—</Mute>
        ) : (
          <ChipWrap>
            {entries.map((e, i) => {
              const targetKind =
                e.kind === "configMapRef" ? "ConfigMap" : "Secret";
              const tag = targetKind === "ConfigMap" ? "cm" : "sec";
              const copyText = `${tag}:${e.name}${e.prefix ? `[prefix=${e.prefix}]` : ""}`;
              return (
                <Chip key={`${e.kind}:${e.name}:${i}`} t={t} mono>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <LinkValue
                      t={t}
                      onClick={() =>
                        e.name &&
                        onNavigate?.(targetKind, podNamespace ?? null, e.name)
                      }
                      copyText={copyText}
                      enabled={!!onNavigate && e.name !== ""}
                    >
                      <span style={{ fontFamily: FF_MONO }}>
                        {tag}:{e.name || "?"}
                      </span>
                    </LinkValue>
                    {e.prefix && (
                      <span style={{ opacity: 0.6 }}>+{e.prefix}</span>
                    )}
                    {e.optional && (
                      <span style={{ opacity: 0.55 }} title="optional">
                        ?
                      </span>
                    )}
                  </span>
                </Chip>
              );
            })}
          </ChipWrap>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: edit.editing ? 6 : 4,
          }}
        >
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
          />
        </div>
      </div>
      {picker && podNamespace && (
        <KeyRefPicker
          t={t}
          clusterId={session?.target.clusterId ?? ""}
          namespace={podNamespace}
          kind={picker.kind}
          keyMode="none"
          initial={(() => {
            const r = edit.buffer.rows.find((x) => x.id === picker.rowId);
            return r ? { name: r.name, optional: r.optional } : undefined;
          })()}
          onCancel={() => setPicker(null)}
          onConfirm={(sel) =>
            applyPicker({ name: sel.name, optional: sel.optional })
          }
        />
      )}
    </DetailRow>
  );
}

// ── PortsEditor ────────────────────────────────────────────────────────────
//
// Inline editor for a container's ports (name + containerPort + protocol).
// Same shape on Pod (`spec.containers[*].ports`) and workload pod templates
// (`spec.template.spec.containers[*].ports`); the caller hands in
// `serializeFor` so the path is local to each kind.

type PortRowFields = {
  name: string;
  container_port: string;
  protocol: string;
};

function portsBufferFrom(
  ports: ContainerPort[],
): ListBuffer<PortRowFields> {
  return listBufferFrom(
    ports.map((p) => ({
      name: p.name ?? "",
      container_port: String(p.container_port),
      protocol: p.protocol ?? "TCP",
    })),
  );
}

function portsDirtyCount(b: ListBuffer<PortRowFields>): number {
  return listBufferDirty(b, (cur, orig) =>
    cur.name !== orig.name ||
    cur.container_port !== orig.container_port ||
    cur.protocol !== orig.protocol,
  );
}

function serializeContainerPort(r: PortRowFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.name !== "") out.name = r.name;
  const p = Number.parseInt(r.container_port, 10);
  if (!Number.isNaN(p)) out.containerPort = p;
  if (r.protocol !== "") out.protocol = r.protocol;
  return out;
}

const PORT_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function PortsEditor({
  t,
  containerName,
  ports,
  serializeFor,
  forwardTarget,
}: {
  t: Tokens;
  containerName: string;
  ports: ContainerPort[];
  serializeFor: (
    container: { name: string; ports: Record<string, unknown>[] },
  ) => Record<string, unknown>;
  // When set, every read-only port chip gets a "forward" affordance bound to
  // this target. Omitted on detail surfaces where no useful forward target
  // exists (e.g. inside a pod template editor where the pod doesn't exist
  // yet).
  forwardTarget?: import("../../../types").ForwardTarget;
}) {
  const session = useEditSession();
  const edit = useEditField<ListBuffer<PortRowFields>>({
    id: `ports:${containerName}`,
    initial: () => portsBufferFrom(ports),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        ports: listBufferToArray(b, serializeContainerPort),
      }),
    dirtyCount: portsDirtyCount,
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
    <DetailRow t={t} label="Ports">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
            {dupNames.size > 0 && (
              <div
                style={{
                  margin: "0 0 6px",
                  fontSize: FS_SM,
                  color: t.bad,
                  fontFamily: FF_MONO,
                }}
              >
                Duplicate port names: {[...dupNames].join(", ")}
              </div>
            )}
            <ListEditor
              t={t}
              buffer={edit.buffer}
              onChange={edit.setBuffer}
              blank={{ name: "", container_port: "", protocol: "TCP" }}
              addLabel="Add port"
              renderRow={(row, onRowChange) => {
                const portInvalid =
                  row.container_port !== "" &&
                  Number.isNaN(Number.parseInt(row.container_port, 10));
                const nameInvalid =
                  row.name !== "" &&
                  (!PORT_NAME_RE.test(row.name) || dupNames.has(row.name));
                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1.2fr 0.8fr 0.6fr",
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
                      value={row.container_port}
                      onChange={(v) => onRowChange({ container_port: v })}
                      placeholder="port"
                      invalid={portInvalid}
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
                return `${o.name || "—"} ${o.container_port}/${o.protocol}`;
              }}
            />
          </>
        ) : ports.length === 0 ? (
          <Mute t={t}>—</Mute>
        ) : (
          <ChipWrap>
            {ports.map((p, i) => (
              <span
                key={`${p.name ?? "p"}-${i}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <Copyable text={`${p.container_port}/${p.protocol ?? "TCP"}`}>
                  <Chip t={t} mono>
                    {p.name ? `${p.name}: ` : ""}
                    {p.container_port}
                    {p.protocol ? `/${p.protocol}` : ""}
                  </Chip>
                </Copyable>
                {forwardTarget && (
                  <ForwardChip
                    t={t}
                    clusterId={session?.target.clusterId ?? ""}
                    target={forwardTarget}
                    remotePort={p.container_port}
                    protocol={p.protocol}
                  />
                )}
              </span>
            ))}
          </ChipWrap>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: edit.editing ? 6 : 4,
          }}
        >
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
          />
        </div>
      </div>
    </DetailRow>
  );
}

// ── VolumesEditor ──────────────────────────────────────────────────────────
//
// Edit a pod's `spec.volumes` (Pod) or a workload's
// `spec.template.spec.volumes` / CronJob's
// `spec.jobTemplate.spec.template.spec.volumes`. The caller hands in the
// `serializeFor` callback so the component never has to know which kind it
// belongs to.
//
// Existing volumes whose source kind is one of the four editable shapes
// (configMap / secret / persistentVolumeClaim / emptyDir) are field-edited
// in place — source name, PVC.readOnly, emptyDir.medium / sizeLimit. All
// other fields on the source object (configMap.items, configMap.defaultMode,
// projected.sources, …) round-trip through the opaque `raw` blob, so we
// don't accidentally drop unsupported config. Volumes whose source kind
// isn't editable here (projected, downwardAPI, hostPath, csi, nfs, ephemeral)
// stay round-trip-only — operator can delete + add to replace, but can't
// surgically edit. Renaming an existing volume is out of scope (mounts
// reference the name).

type NewVolumeKind =
  | "emptyDir"
  | "configMap"
  | "secret"
  | "persistentVolumeClaim";

// Editable source-level state. Which fields apply depends on the source
// kind (see `applyFieldsToRaw`). For new rows, sourceKind is the `kind`
// field on the new variant; for existing rows, it comes from
// `original.kind`.
type VolumeFields = {
  sourceName: string;
  readOnly: boolean;
  emptyDirMedium: string;
  emptyDirSizeLimit: string;
};

type VolumeEditRowState =
  | {
      id: number;
      kind: "existing";
      name: string;
      original: PodVolume;
      // Snapshot of fields at buffer init — for dirty detection. Never
      // mutated after init.
      originalFields: VolumeFields;
      // Current edit state. Renders identical to `new` rows.
      fields: VolumeFields;
      deleted: boolean;
    }
  | {
      id: number;
      kind: "new";
      name: string;
      sourceKind: NewVolumeKind;
      sourceName: string;
      // emptyDir-only extras for new rows. PVC readOnly stays inline below.
      emptyDirMedium: string;
      emptyDirSizeLimit: string;
      readOnly: boolean;
      deleted: boolean;
    };

type VolumesBuffer = { rows: VolumeEditRowState[]; nextId: number };

// True for source kinds whose fields we know how to edit. Others stay
// round-trip-only. Keep this list aligned with `applyFieldsToRaw`.
function isEditableSourceKind(k: string): boolean {
  return (
    k === "configMap" ||
    k === "secret" ||
    k === "persistentVolumeClaim" ||
    k === "emptyDir"
  );
}

function fieldsFromVolume(v: PodVolume): VolumeFields {
  const raw = (v.raw ?? {}) as Record<string, unknown>;
  const sourceName = v.source_name ?? "";
  let readOnly = false;
  let emptyDirMedium = "";
  let emptyDirSizeLimit = "";
  if (v.kind === "persistentVolumeClaim") {
    const pvc = raw.persistentVolumeClaim as Record<string, unknown> | undefined;
    if (pvc?.readOnly === true) readOnly = true;
  } else if (v.kind === "emptyDir") {
    const ed = raw.emptyDir as Record<string, unknown> | undefined;
    if (typeof ed?.medium === "string") emptyDirMedium = ed.medium;
    if (typeof ed?.sizeLimit === "string") emptyDirSizeLimit = ed.sizeLimit;
  }
  return { sourceName, readOnly, emptyDirMedium, emptyDirSizeLimit };
}

function fieldsEqual(a: VolumeFields, b: VolumeFields): boolean {
  return (
    a.sourceName === b.sourceName &&
    a.readOnly === b.readOnly &&
    a.emptyDirMedium === b.emptyDirMedium &&
    a.emptyDirSizeLimit === b.emptyDirSizeLimit
  );
}

// Apply `fields` to a deep-cloned `raw` so the returned object replaces
// the raw blob in serialization without mutating the original. Unknown
// source variants pass through unchanged.
function applyFieldsToRaw(
  v: PodVolume,
  fields: VolumeFields,
): Record<string, unknown> {
  const raw = JSON.parse(
    JSON.stringify(v.raw ?? {}),
  ) as Record<string, unknown>;
  switch (v.kind) {
    case "configMap": {
      const cm = (raw.configMap ??= {}) as Record<string, unknown>;
      cm.name = fields.sourceName;
      break;
    }
    case "secret": {
      const s = (raw.secret ??= {}) as Record<string, unknown>;
      s.secretName = fields.sourceName;
      break;
    }
    case "persistentVolumeClaim": {
      const pvc = (raw.persistentVolumeClaim ??= {}) as Record<string, unknown>;
      pvc.claimName = fields.sourceName;
      if (fields.readOnly) pvc.readOnly = true;
      else delete pvc.readOnly;
      break;
    }
    case "emptyDir": {
      const ed = (raw.emptyDir ??= {}) as Record<string, unknown>;
      if (fields.emptyDirMedium !== "") ed.medium = fields.emptyDirMedium;
      else delete ed.medium;
      if (fields.emptyDirSizeLimit !== "") ed.sizeLimit = fields.emptyDirSizeLimit;
      else delete ed.sizeLimit;
      break;
    }
    default:
      // Unknown / unsupported variant — keep raw untouched.
      break;
  }
  return raw;
}

function volumesBufferFrom(volumes: PodVolume[]): VolumesBuffer {
  let id = 1;
  return {
    rows: volumes.map((v) => {
      const fields = fieldsFromVolume(v);
      return {
        id: id++,
        kind: "existing" as const,
        name: v.name,
        original: v,
        originalFields: fields,
        fields,
        deleted: false,
      };
    }),
    nextId: id,
  };
}

function volumesDirtyCount(b: VolumesBuffer): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.kind === "new") n += 1;
    else if (r.deleted) n += 1;
    else if (!fieldsEqual(r.fields, r.originalFields)) n += 1;
  }
  return n;
}

function serializeVolumes(b: VolumesBuffer): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.kind === "existing") {
      // For editable kinds, splice fields back into the raw; for unknown
      // kinds, raw round-trips unchanged.
      const raw = isEditableSourceKind(r.original.kind)
        ? applyFieldsToRaw(r.original, r.fields)
        : ((r.original.raw ?? {}) as Record<string, unknown>);
      out.push({ name: r.name, ...raw });
    } else {
      const src: Record<string, unknown> = {};
      switch (r.sourceKind) {
        case "emptyDir": {
          const ed: Record<string, unknown> = {};
          if (r.emptyDirMedium !== "") ed.medium = r.emptyDirMedium;
          if (r.emptyDirSizeLimit !== "") ed.sizeLimit = r.emptyDirSizeLimit;
          src.emptyDir = ed;
          break;
        }
        case "configMap":
          src.configMap = { name: r.sourceName };
          break;
        case "secret":
          src.secret = { secretName: r.sourceName };
          break;
        case "persistentVolumeClaim": {
          const pvc: Record<string, unknown> = { claimName: r.sourceName };
          if (r.readOnly) pvc.readOnly = true;
          src.persistentVolumeClaim = pvc;
          break;
        }
      }
      out.push({ name: r.name, ...src });
    }
  }
  return out;
}

export function VolumesEditor({
  t,
  volumes,
  podNamespace,
  onNavigate,
  serializeFor,
}: {
  t: Tokens;
  volumes: PodVolume[];
  podNamespace: string | null;
  onNavigate?: DetailNavigate;
  // Given the new volumes array, build the SSA payload. Pod uses
  // `{spec:{volumes:…}}`; workloads use
  // `{spec:{template:{spec:{volumes:…}}}}`; CronJob uses
  // `{spec:{jobTemplate:{spec:{template:{spec:{volumes:…}}}}}}`.
  serializeFor: (volumes: Record<string, unknown>[]) => Record<string, unknown>;
}) {
  const session = useEditSession();
  const edit = useEditField<VolumesBuffer>({
    id: "volumes",
    initial: () => volumesBufferFrom(volumes),
    serialize: (b) => serializeFor(serializeVolumes(b)),
    dirtyCount: volumesDirtyCount,
  });

  // Picker state for the new-volume rows. Same shape as env's picker —
  // {rowId, kind} where kind is what we're picking.
  const [picker, setPicker] = useState<{
    rowId: number;
    kind: KeyRefPickerKind;
  } | null>(null);

  function applyPicker(sel: { name: string }) {
    if (!picker) return;
    const rowId = picker.rowId;
    edit.setBuffer((b) => ({
      ...b,
      rows: b.rows.map((r) => {
        if (r.id !== rowId) return r;
        if (r.kind === "new") return { ...r, sourceName: sel.name };
        return { ...r, fields: { ...r.fields, sourceName: sel.name } };
      }),
    }));
    setPicker(null);
  }

  return (
    <>
      <Section
        t={t}
        title="Volumes"
        right={
          <EditModeChrome
            t={t}
            editing={edit.editing}
            dirty={edit.dirty}
            saving={edit.saving}
            onEnter={edit.enter}
            onCancel={edit.cancel}
            rightExtra={
              <span
                style={{
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                }}
              >
                {volumes.length} total
              </span>
            }
          />
        }
      />
      <div style={{ marginBottom: 22 }}>
        {edit.editing ? (
          <>
            {edit.buffer.rows.map((row) => (
              <VolumesEditRow
                key={row.id}
                t={t}
                row={row}
                onChange={(next) =>
                  edit.setBuffer((b) => ({
                    ...b,
                    rows: b.rows
                      .filter((r) => !(r.id === row.id && next === null))
                      .map((r) => (r.id === row.id && next !== null ? next : r)),
                  }))
                }
                onPickRef={(kind) =>
                  podNamespace ? setPicker({ rowId: row.id, kind }) : undefined
                }
                pickerAvailable={!!podNamespace}
              />
            ))}
            <AddRowButton
              t={t}
              label="Add volume"
              onClick={() =>
                edit.setBuffer((b) => ({
                  ...b,
                  rows: [
                    ...b.rows,
                    {
                      id: b.nextId,
                      kind: "new",
                      name: "",
                      sourceKind: "emptyDir",
                      sourceName: "",
                      emptyDirMedium: "",
                      emptyDirSizeLimit: "",
                      readOnly: false,
                      deleted: false,
                    },
                  ],
                  nextId: b.nextId + 1,
                }))
              }
            />
          </>
        ) : volumes.length === 0 ? (
          <DetailRow t={t} label="Volumes">
            <Mute t={t}>—</Mute>
          </DetailRow>
        ) : (
          volumes.map((v) => (
            <VolumeReadRow
              key={v.name}
              t={t}
              v={v}
              podNamespace={podNamespace}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
      {picker && podNamespace && (
        <KeyRefPicker
          t={t}
          clusterId={session?.target.clusterId ?? ""}
          namespace={podNamespace}
          kind={picker.kind}
          keyMode="none"
          initial={(() => {
            const r = edit.buffer.rows.find((x) => x.id === picker.rowId);
            if (!r) return undefined;
            return r.kind === "new"
              ? { name: r.sourceName }
              : { name: r.fields.sourceName };
          })()}
          onCancel={() => setPicker(null)}
          onConfirm={(sel) => applyPicker({ name: sel.name })}
        />
      )}
    </>
  );
}

// Read-only chip summary for a volume — used inside VolumesEditor when not
// in edit mode.
function VolumeReadRow({
  t,
  v,
  podNamespace,
  onNavigate,
}: {
  t: Tokens;
  v: PodVolume;
  podNamespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  const navigable = !!(v.target_kind && v.source_name && onNavigate);
  return (
    <DetailRow t={t} label={v.name}>
      <span style={{ fontSize: FS_MD }}>{v.kind}</span>
      {v.source_name &&
        (navigable ? (
          <LinkValue
            t={t}
            onClick={() =>
              onNavigate!(v.target_kind!, podNamespace, v.source_name!)
            }
            copyText={v.source_name}
            enabled={true}
          >
            {v.source_name}
          </LinkValue>
        ) : (
          <Copyable text={v.source_name}>
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_MD,
                color: t.textDim,
                wordBreak: "break-all",
                marginLeft: 8,
              }}
            >
              {v.source_name}
            </span>
          </Copyable>
        ))}
    </DetailRow>
  );
}

function VolumesEditRow({
  t,
  row,
  onChange,
  onPickRef,
  pickerAvailable,
}: {
  t: Tokens;
  row: VolumeEditRowState;
  onChange: (next: VolumeEditRowState | null) => void;
  onPickRef?: (kind: KeyRefPickerKind) => void;
  pickerAvailable: boolean;
}) {
  if (row.kind === "existing" && row.deleted) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          opacity: 0.45,
          textDecoration: "line-through",
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          padding: "4px 0",
        }}
      >
        <span style={{ color: t.textDim, flex: 1 }}>
          {row.original.name} ({row.original.kind}
          {row.original.source_name ? ` · ${row.original.source_name}` : ""})
        </span>
        <RowDeleteButton
          t={t}
          onClick={() => onChange({ ...row, deleted: false })}
          title="Restore"
        />
      </div>
    );
  }

  // Resolve common per-row state regardless of new/existing.
  const sourceKind: NewVolumeKind | string =
    row.kind === "new" ? row.sourceKind : row.original.kind;
  const editable = isEditableSourceKind(sourceKind);
  const isExisting = row.kind === "existing";
  const sourceName = row.kind === "new" ? row.sourceName : row.fields.sourceName;
  const readOnly = row.kind === "new" ? row.readOnly : row.fields.readOnly;
  const emptyDirMedium =
    row.kind === "new" ? row.emptyDirMedium : row.fields.emptyDirMedium;
  const emptyDirSizeLimit =
    row.kind === "new" ? row.emptyDirSizeLimit : row.fields.emptyDirSizeLimit;

  function patchFields(p: Partial<VolumeFields>) {
    if (row.kind === "new") {
      onChange({
        ...row,
        sourceName: p.sourceName ?? row.sourceName,
        readOnly: p.readOnly ?? row.readOnly,
        emptyDirMedium: p.emptyDirMedium ?? row.emptyDirMedium,
        emptyDirSizeLimit: p.emptyDirSizeLimit ?? row.emptyDirSizeLimit,
      });
    } else {
      onChange({ ...row, fields: { ...row.fields, ...p } });
    }
  }

  // Existing rows whose source kind we can't edit fall back to a one-line
  // read-only summary with just a delete button.
  if (isExisting && !editable) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 0",
        }}
      >
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            color: t.text,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.kind === "existing" ? row.original.name : ""}{" "}
          <span style={{ color: t.textMuted }}>
            ({sourceKind}
            {sourceName ? ` · ${sourceName}` : ""})
          </span>
        </span>
        <span
          style={{
            fontSize: FS_XS,
            color: t.textMuted,
            fontFamily: FF_MONO,
          }}
        >
          can't edit · delete + add
        </span>
        <RowDeleteButton
          t={t}
          onClick={() =>
            row.kind === "existing"
              ? onChange({ ...row, deleted: true })
              : onChange(null)
          }
        />
      </div>
    );
  }

  const needsSource =
    sourceKind === "configMap" ||
    sourceKind === "secret" ||
    sourceKind === "persistentVolumeClaim";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 0.9fr 1.2fr auto",
        gap: 6,
        padding: "4px 0",
        alignItems: "center",
      }}
    >
      {row.kind === "new" ? (
        <EditableTextValue
          t={t}
          value={row.name}
          onChange={(v) => onChange({ ...row, name: v })}
          placeholder="volume.name"
        />
      ) : (
        // Existing volume names are immutable — renaming would orphan every
        // mount that references the old name.
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            color: t.text,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title="Volume name is immutable (mounts reference it)"
        >
          {row.original.name}
        </span>
      )}
      {row.kind === "new" ? (
        <Select<NewVolumeKind>
          t={t}
          fullWidth={false}
          value={row.sourceKind}
          onChange={(v) => onChange({ ...row, sourceKind: v })}
          options={[
            { value: "emptyDir", label: "emptyDir" },
            { value: "configMap", label: "configMap" },
            { value: "secret", label: "secret" },
            { value: "persistentVolumeClaim", label: "persistentVolumeClaim" },
          ]}
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            height: 28,
            padding: "4px 28px 4px 8px",
          }}
        />
      ) : (
        // Existing rows can't change source kind — that's effectively a
        // different volume. Show as a label.
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            color: t.textMuted,
            paddingLeft: 4,
          }}
        >
          {sourceKind}
        </span>
      )}
      {needsSource ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            fullWidth
            disabled={!pickerAvailable}
            title={
              pickerAvailable ? "Pick source" : "Picker requires a namespace"
            }
            onClick={() => {
              if (!onPickRef) return;
              const k: KeyRefPickerKind =
                sourceKind === "configMap"
                  ? "ConfigMap"
                  : sourceKind === "secret"
                    ? "Secret"
                    : "PersistentVolumeClaim";
              onPickRef(k);
            }}
            style={{
              justifyContent: "flex-start",
              fontFamily: FF_MONO,
              color: sourceName !== "" ? t.text : t.textMuted,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sourceName !== ""
              ? sourceName
              : sourceKind === "secret"
                ? "Pick secret…"
                : sourceKind === "persistentVolumeClaim"
                  ? "Pick PVC…"
                  : "Pick configMap…"}
          </Btn>
          {sourceKind === "persistentVolumeClaim" && (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: FS_XS,
                color: t.textDim,
                fontFamily: FF_MONO,
                cursor: "pointer",
              }}
              title="Mount as read-only"
            >
              <Checkbox
                t={t}
                checked={readOnly}
                onChange={(v) => patchFields({ readOnly: v })}
                size={13}
              />
              ro
            </label>
          )}
        </div>
      ) : sourceKind === "emptyDir" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            minWidth: 0,
          }}
        >
          <Select<string>
            t={t}
            fullWidth={false}
            value={emptyDirMedium}
            onChange={(v) => patchFields({ emptyDirMedium: v })}
            options={[
              { value: "", label: "(disk)" },
              { value: "Memory", label: "Memory" },
            ]}
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              height: 28,
              padding: "4px 28px 4px 8px",
            }}
          />
          <EditableTextValue
            t={t}
            value={emptyDirSizeLimit}
            onChange={(v) => patchFields({ emptyDirSizeLimit: v })}
            placeholder="sizeLimit (e.g. 1Gi)"
          />
        </div>
      ) : (
        <span />
      )}
      <RowDeleteButton
        t={t}
        onClick={() =>
          row.kind === "existing"
            ? onChange({ ...row, deleted: true })
            : onChange(null)
        }
      />
    </div>
  );
}

// Map a registry kind id (the snake-plural string used in URLs / commands)
// to the apiserver's Kind name. Kept inline here because the only consumer
// today is the forward chip; a more general mapping can move into a shared
// module if other surfaces need it.
function kindIdToKind(id: string): string {
  switch (id) {
    case "pods":
      return "Pod";
    case "deployments":
      return "Deployment";
    case "statefulsets":
      return "StatefulSet";
    case "daemonsets":
      return "DaemonSet";
    case "replicasets":
      return "ReplicaSet";
    case "jobs":
      return "Job";
    case "cronjobs":
      return "CronJob";
    case "services":
      return "Service";
    default:
      return id;
  }
}
