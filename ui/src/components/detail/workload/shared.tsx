// Shared sections used by every workload detail summary (Deployment,
// ReplicaSet, StatefulSet, DaemonSet, Job, CronJob). Each kind's summary
// composes these + its own kind-specific rows above; this keeps the
// metadata + selector + pod-template chrome consistent across the family.

import { useMemo } from "react";
import { FONT_MONO, type Tokens } from "../../../theme";
import { Chip, Section, Select } from "../../ui";
import { ForwardChip } from "../forwardChip";
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
  type DetailNavigate,
} from "..";
import {
  AddRowButton,
  ConflictBanner,
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
  useApply,
  type ApplyTarget,
  type ListBuffer,
} from "../edit";
import type {
  ContainerEnv,
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
  // inline-edit affordance (pencil → key/value editor → SSA save). Pass
  // `undefined` to keep MetaSection read-only — what every kind that hasn't
  // opted in to editing yet does.
  editTarget,
  onSaved,
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
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
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
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{meta.name}</span>
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
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
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
            <span style={{ fontSize: 12 }}>{meta.controlled_by.kind}</span>{" "}
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
        <MetaPairsRow
          t={t}
          label="Labels"
          pairs={meta.labels}
          editTarget={editTarget}
          metadataKey="labels"
          onSaved={onSaved}
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
          onSaved={onSaved}
          keyValidate={(k) => /^([a-z0-9.-]+\/)?[A-Za-z0-9._-]+$/.test(k)}
          // Annotations are commonly long (last-applied-configuration,
          // controller state). Read-only mode collapses to a count; the
          // editor still lists every one.
          collapsedAsCount
        />
        {meta.generation != null && (
          <DetailRow t={t} label="Generation">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {meta.generation}
            </span>
          </DetailRow>
        )}
      </div>
    </>
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
  onSaved,
  keyValidate,
  collapsedAsCount = false,
}: {
  t: Tokens;
  label: string;
  pairs: [string, string][];
  editTarget?: ApplyTarget;
  metadataKey: "labels" | "annotations";
  onSaved?: () => void;
  keyValidate?: (k: string) => boolean;
  collapsedAsCount?: boolean;
}) {
  const editable = !!editTarget;
  const edit = useApply<{ buffer: ReturnType<typeof kvBufferFromPairs> }>({
    target: editTarget ?? {
      clusterId: "",
      kindId: "",
      namespace: null,
      name: "",
    },
    initial: () => ({ buffer: kvBufferFromPairs(pairs) }),
    serialize: (s) => ({ metadata: { [metadataKey]: kvBufferToMap(s.buffer) } }),
    dirtyCount: (s) => kvBufferDirty(s.buffer),
    onSaved: onSaved ?? (() => {}),
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
      onSave={edit.save}
    />
  ) : null;

  return (
    <>
      <DetailRow t={t} label={label}>
        <div style={{ width: "100%" }}>
          {edit.editing ? (
            <>
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
                    color: t.bad,
                    fontSize: 11,
                  }}
                >
                  {edit.error}
                </div>
              )}
              {dup.size > 0 && (
                <div
                  style={{
                    margin: "0 0 6px",
                    fontSize: 11,
                    color: t.bad,
                    fontFamily: FONT_MONO,
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
            <span style={{ fontSize: 12, color: t.textDim }}>
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
        <span style={{ fontSize: 11.5, color: t.textDim, marginLeft: 6 }}>
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
              fontSize: 10.5,
              color: t.textMuted,
              fontFamily: FONT_MONO,
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
              <span style={{ fontSize: 11.5, color: t.textDim }}>
                {c.reason}
              </span>
            )}
            {c.message && (
              <div
                style={{
                  fontSize: 11.5,
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
                  fontSize: 11,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
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
        borderRadius: 3,
        fontSize: 11,
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
  onSaved,
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
  editTarget?: ApplyTarget;
  onSaved?: () => void;
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
            <span style={{ fontSize: 12, color: t.textDim }}>
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
            <span style={{ fontSize: 12 }}>{template.restart_policy}</span>
          </DetailRow>
        )}
        {template.priority_class && (
          <DetailRow t={t} label="Priority Class">
            <Copyable text={template.priority_class}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
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
            <span style={{ fontSize: 12, color: t.textDim }}>
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
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
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
                onSaved={onSaved}
                templateKind={templateKind}
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
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
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
                onSaved={onSaved}
                templateKind={templateKind}
              />
            ))}
          </div>
        </>
      )}

      {editTarget && onSaved && (
        <VolumesEditor
          t={t}
          volumes={template.volumes}
          podNamespace={namespace}
          onNavigate={onNavigate}
          editTarget={editTarget}
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
          onSaved={onSaved}
        />
      )}
    </>
  );
}

function ContainerSummaryCard({
  t,
  c,
  editTarget,
  onSaved,
  templateKind = "workload",
}: {
  t: Tokens;
  c: WorkloadContainerSummary;
  editTarget?: ApplyTarget;
  onSaved?: () => void;
  templateKind?: "workload" | "cronjob";
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
        <Copyable text={c.name}>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12.5,
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
            fontSize: 9.5,
            fontWeight: 700,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontFamily: FONT_MONO,
          }}
        >
          {c.kind}
        </span>
      </div>
      <div style={{ padding: "4px 12px" }}>
        {c.image && (
          <DetailRow t={t} label="Image">
            <Copyable text={c.image}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
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
            <span style={{ fontSize: 12 }}>{c.image_pull_policy}</span>
          </DetailRow>
        )}
        {(c.ports.length > 0 ||
          c.env.length + c.env_from_count > 0 ||
          c.mounts_count > 0) && (
          <DetailRow t={t} label="Spec">
            <ChipWrap>
              {c.ports.length > 0 && (
                <Chip t={t} mono>
                  {c.ports.length} port{c.ports.length === 1 ? "" : "s"}
                </Chip>
              )}
              {c.env.length + c.env_from_count > 0 && (
                <Chip t={t} mono>
                  {c.env.length + c.env_from_count} env
                </Chip>
              )}
              {c.mounts_count > 0 && (
                <Chip t={t} mono>
                  {c.mounts_count} mount{c.mounts_count === 1 ? "" : "s"}
                </Chip>
              )}
            </ChipWrap>
          </DetailRow>
        )}
        {hasResources && (
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
                          value: v,
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
                          value: v,
                        })),
                      },
                    ]
                  : []),
              ]}
            />
          </DetailRow>
        )}
        {c.command && c.command.length > 0 && (
          <DetailRow t={t} label="Command">
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11.5,
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
                fontFamily: FONT_MONO,
                fontSize: 11.5,
                wordBreak: "break-all",
              }}
            >
              {c.args.join(" ")}
            </span>
          </DetailRow>
        )}
        {editTarget && onSaved && (
          <>
            <PortsEditor
              t={t}
              containerName={c.name}
              ports={c.ports}
              editTarget={editTarget}
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
              onSaved={onSaved}
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
              editTarget={editTarget}
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
              onSaved={onSaved}
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
        fontFamily: FONT_MONO,
        fontSize: 13,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: ok ? t.good : ready === 0 ? t.bad : t.warn,
      }}
    >
      {ready} / {desired}
    </span>
  );
}

// ── EnvEditor ──────────────────────────────────────────────────────────────
//
// Inline editor for a container's literal env entries (`name=value` pairs).
// Reference entries (`valueFrom: configMapKeyRef / secretKeyRef / fieldRef /
// resourceFieldRef`) render as read-only chips beneath the editable list —
// editing those would mean designing a per-source picker (out of scope for
// this pass) and SSA on the merged listMap leaves them owned by their
// original manager regardless.
//
// Caller owns *where* in the SSA payload the env array lives; the editor
// only knows the container name (the listMap merge key) and the new env
// list. Pod uses `spec.containers[*].env`; workload kinds use
// `spec.template.spec.containers[*].env`.

type EnvFields = { name: string; value: string };

function envBufferFrom(env: ContainerEnv[]): ListBuffer<EnvFields> {
  return listBufferFrom(
    env
      .filter((e) => e.from === null)
      .map((e) => ({ name: e.name, value: e.value ?? "" })),
  );
}

function envBufferDirtyCount(b: ListBuffer<EnvFields>): number {
  return listBufferDirty(b, (cur, orig) =>
    cur.name !== orig.name || cur.value !== orig.value,
  );
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function EnvEditor({
  t,
  containerName,
  env,
  editTarget,
  serializeFor,
  onSaved,
}: {
  t: Tokens;
  containerName: string;
  env: ContainerEnv[];
  editTarget: ApplyTarget;
  // Given the new literal env array, produce the SSA payload (without
  // apiVersion/kind/metadata). Caller knows whether the path is
  // `spec.containers[]` (Pod) or `spec.template.spec.containers[]` (workload).
  serializeFor: (
    container: { name: string; env: { name: string; value: string }[] },
  ) => Record<string, unknown>;
  onSaved: () => void;
}) {
  const refs = env.filter((e) => e.from !== null);
  const edit = useApply<ListBuffer<EnvFields>>({
    target: editTarget,
    initial: () => envBufferFrom(env),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        env: listBufferToArray(b, (r) => ({ name: r.name, value: r.value })),
      }),
    dirtyCount: envBufferDirtyCount,
    onSaved,
  });

  const literals = env.filter((e) => e.from === null);

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

  return (
    <DetailRow t={t} label="Env">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
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
                  margin: "0 0 6px",
                  padding: "6px 8px",
                  background: "rgba(244,63,94,0.10)",
                  border: "1px solid rgba(244,63,94,0.4)",
                  borderRadius: 3,
                  color: t.bad,
                  fontSize: 11,
                }}
              >
                {edit.error}
              </div>
            )}
            {dupNames.size > 0 && (
              <div
                style={{
                  margin: "0 0 6px",
                  fontSize: 11,
                  color: t.bad,
                  fontFamily: FONT_MONO,
                }}
              >
                Duplicate env names: {[...dupNames].join(", ")}
              </div>
            )}
            <ListEditor
              t={t}
              buffer={edit.buffer}
              onChange={edit.setBuffer}
              blank={{ name: "", value: "" }}
              addLabel="Add env"
              renderRow={(row, onRowChange) => {
                const invalidName =
                  row.name !== "" &&
                  (!ENV_NAME_RE.test(row.name) || dupNames.has(row.name));
                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 2fr",
                      gap: 6,
                    }}
                  >
                    <EditableTextValue
                      t={t}
                      value={row.name}
                      onChange={(v) => onRowChange({ name: v })}
                      placeholder="NAME"
                      invalid={invalidName}
                    />
                    <EditableTextValue
                      t={t}
                      value={row.value}
                      onChange={(v) => onRowChange({ value: v })}
                      placeholder="value"
                    />
                  </div>
                );
              }}
              renderDeletedSummary={(row) =>
                `${row.original?.name ?? row.name}=${row.original?.value ?? row.value}`
              }
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
              <Chip key={`ref:${e.name}`} t={t} mono>
                {e.name} <span style={{ opacity: 0.6 }}>({e.from})</span>
              </Chip>
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
            onSave={edit.save}
            rightExtra={
              refs.length > 0 ? (
                <span
                  style={{
                    fontSize: 10.5,
                    color: t.textMuted,
                    fontFamily: FONT_MONO,
                  }}
                >
                  +{refs.length} ref{refs.length === 1 ? "" : "s"}
                </span>
              ) : undefined
            }
          />
        </div>
      </div>
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
  editTarget,
  serializeFor,
  onSaved,
  forwardTarget,
}: {
  t: Tokens;
  containerName: string;
  ports: ContainerPort[];
  editTarget: ApplyTarget;
  serializeFor: (
    container: { name: string; ports: Record<string, unknown>[] },
  ) => Record<string, unknown>;
  onSaved: () => void;
  // When set, every read-only port chip gets a "forward" affordance bound to
  // this target. Omitted on detail surfaces where no useful forward target
  // exists (e.g. inside a pod template editor where the pod doesn't exist
  // yet).
  forwardTarget?: import("../../../types").ForwardTarget;
}) {
  const edit = useApply<ListBuffer<PortRowFields>>({
    target: editTarget,
    initial: () => portsBufferFrom(ports),
    serialize: (b) =>
      serializeFor({
        name: containerName,
        ports: listBufferToArray(b, serializeContainerPort),
      }),
    dirtyCount: portsDirtyCount,
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
    <DetailRow t={t} label="Ports">
      <div style={{ width: "100%" }}>
        {edit.editing ? (
          <>
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
                  margin: "0 0 6px",
                  padding: "6px 8px",
                  background: "rgba(244,63,94,0.10)",
                  border: "1px solid rgba(244,63,94,0.4)",
                  borderRadius: 3,
                  color: t.bad,
                  fontSize: 11,
                }}
              >
                {edit.error}
              </div>
            )}
            {dupNames.size > 0 && (
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
                    clusterId={editTarget.clusterId}
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
            onSave={edit.save}
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
// Existing volumes round-trip via their opaque `raw` blob (the editor never
// tries to interpret unsupported source variants). New volumes are restricted
// to four common shapes — emptyDir, configMap, secret, persistentVolumeClaim —
// picked from a dropdown. Renaming an existing volume is out of scope (would
// also need to rewrite every container's volumeMounts that reference it).

type NewVolumeKind =
  | "emptyDir"
  | "configMap"
  | "secret"
  | "persistentVolumeClaim";

type VolumeEditRowState =
  | {
      id: number;
      kind: "existing";
      name: string;
      original: PodVolume;
      deleted: boolean;
    }
  | {
      id: number;
      kind: "new";
      name: string;
      sourceKind: NewVolumeKind;
      sourceName: string;
      deleted: boolean;
    };

type VolumesBuffer = { rows: VolumeEditRowState[]; nextId: number };

function volumesBufferFrom(volumes: PodVolume[]): VolumesBuffer {
  let id = 1;
  return {
    rows: volumes.map((v) => ({
      id: id++,
      kind: "existing" as const,
      name: v.name,
      original: v,
      deleted: false,
    })),
    nextId: id,
  };
}

function volumesDirtyCount(b: VolumesBuffer): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.kind === "new") n += 1;
    else if (r.deleted) n += 1;
  }
  return n;
}

function serializeVolumes(b: VolumesBuffer): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.kind === "existing") {
      const raw = (r.original.raw ?? {}) as Record<string, unknown>;
      out.push({ name: r.name, ...raw });
    } else {
      const src: Record<string, unknown> = {};
      switch (r.sourceKind) {
        case "emptyDir":
          src.emptyDir = {};
          break;
        case "configMap":
          src.configMap = { name: r.sourceName };
          break;
        case "secret":
          src.secret = { secretName: r.sourceName };
          break;
        case "persistentVolumeClaim":
          src.persistentVolumeClaim = { claimName: r.sourceName };
          break;
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
  editTarget,
  serializeFor,
  onSaved,
}: {
  t: Tokens;
  volumes: PodVolume[];
  podNamespace: string | null;
  onNavigate?: DetailNavigate;
  editTarget: ApplyTarget;
  // Given the new volumes array, build the SSA payload. Pod uses
  // `{spec:{volumes:…}}`; workloads use
  // `{spec:{template:{spec:{volumes:…}}}}`; CronJob uses
  // `{spec:{jobTemplate:{spec:{template:{spec:{volumes:…}}}}}}`.
  serializeFor: (volumes: Record<string, unknown>[]) => Record<string, unknown>;
  onSaved: () => void;
}) {
  const edit = useApply<VolumesBuffer>({
    target: editTarget,
    initial: () => volumesBufferFrom(volumes),
    serialize: (b) => serializeFor(serializeVolumes(b)),
    dirtyCount: volumesDirtyCount,
    onSaved,
  });

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
            onSave={edit.save}
            rightExtra={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {volumes.length} total
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
              color: t.bad,
              fontSize: 11,
            }}
          >
            {edit.error}
          </div>
        )}
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
      <span style={{ fontSize: 12 }}>{v.kind}</span>
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
                fontFamily: FONT_MONO,
                fontSize: 12,
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
}: {
  t: Tokens;
  row: VolumeEditRowState;
  onChange: (next: VolumeEditRowState | null) => void;
}) {
  if (row.kind === "existing") {
    if (row.deleted) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: 0.45,
            textDecoration: "line-through",
            fontFamily: FONT_MONO,
            fontSize: 11.5,
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
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: t.text,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.original.name}{" "}
          <span style={{ color: t.textMuted }}>
            ({row.original.kind}
            {row.original.source_name ? ` · ${row.original.source_name}` : ""})
          </span>
        </span>
        <RowDeleteButton
          t={t}
          onClick={() => onChange({ ...row, deleted: true })}
        />
      </div>
    );
  }
  const needsSource =
    row.sourceKind === "configMap" ||
    row.sourceKind === "secret" ||
    row.sourceKind === "persistentVolumeClaim";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 0.9fr 1fr auto",
        gap: 6,
        padding: "4px 0",
        alignItems: "center",
      }}
    >
      <EditableTextValue
        t={t}
        value={row.name}
        onChange={(v) => onChange({ ...row, name: v })}
        placeholder="volume.name"
      />
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
          fontFamily: FONT_MONO,
          fontSize: 12,
          height: 28,
          padding: "4px 28px 4px 8px",
        }}
      />
      {needsSource ? (
        <EditableTextValue
          t={t}
          value={row.sourceName}
          onChange={(v) => onChange({ ...row, sourceName: v })}
          placeholder={
            row.sourceKind === "secret"
              ? "secretName"
              : row.sourceKind === "persistentVolumeClaim"
                ? "claimName"
                : "name"
          }
        />
      ) : (
        <span />
      )}
      <RowDeleteButton t={t} onClick={() => onChange(null)} />
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
