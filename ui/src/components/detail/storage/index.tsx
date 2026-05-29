// Per-kind detail summaries for the storage family — PersistentVolumeClaim,
// PersistentVolume, StorageClass. Same shape as the workload + network
// summaries: useDetail() fetches on mount + on detailVersion bumps; primitives
// from `..` compose the body; MetaSection carries the editTarget so labels +
// annotations are editable without each kind reimplementing the pencil.

import { useState } from "react";
import { useResolvedTheme } from "../../../store";
import { api } from "../../../api";
import {
  FF_MONO,
  type ThemeMode,
  type Tokens,
  FS_MD,
  FS_SM,
  FS_XS,
} from "../../../theme";
import { Chip, ErrorBlock, LoadingLine, Section, StatusPill } from "../../ui";
import {
  EditModeChrome,
  EditableTextValue,
} from "../edit";
import {
  Mono,
  ChipWrap,
  Copyable,
  DetailRow,
  EditSessionProvider,
  GlobalSaveBar,
  KeyValueChips,
  LinkValue,
  Mute,
  ageFromIso,
  parseQuantity,
  useEditField,
  type DetailNavigate,
  useDetail,
} from "..";
import { ConditionsSection, MetaSection } from "../workload/shared";
import type {
  PersistentVolumeClaimDetail,
  PersistentVolumeDetail,
  StorageClassDetail,
} from "../../../types";

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

// Inline scalar — copyable monospace value, "—" when null.
function Scalar({
  t,
  value,
  mono = true,
}: {
  t: Tokens;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  if (value == null || value === "") return <Mute t={t}>—</Mute>;
  const s = String(value);
  return (
    <Copyable text={s}>
      <span
        style={{
          fontFamily: mono ? FF_MONO : "inherit",
          fontSize: FS_MD,
          wordBreak: "break-all",
        }}
      >
        {s}
      </span>
    </Copyable>
  );
}

function StringChips({ t, items }: { t: Tokens; items: string[] }) {
  if (items.length === 0) return <Mute t={t}>—</Mute>;
  return (
    <ChipWrap>
      {items.map((m) => (
        <Copyable key={m} text={m}>
          <Chip t={t} mono>
            {m}
          </Chip>
        </Copyable>
      ))}
    </ChipWrap>
  );
}

// Same shape as MetaSection's labels/annotations editor — read-mode value
// + an EditModeChrome pencil below, right-aligned. Edit-mode swaps to an
// EditableTextValue. No bespoke pill / hover state; the global save bar
// commits the change like every other field on the panel.
export function PvcRequestedStorageEditor({
  t,
  requestedStorage,
}: {
  t: Tokens;
  requestedStorage: string | null;
}) {
  // K8s ResourceQuantity. `parseQuantity` is the same parser the rest of
  // the kit uses (ResourceQuota, LimitRange) — keeping a single source of
  // truth so "what's a valid storage size" answers the same everywhere.
  const validateQuantity = (val: string): string | null => {
    const v = val.trim();
    if (v === "") return "storage quantity cannot be empty";
    return parseQuantity(v) === null
      ? "invalid storage quantity format (e.g. 10Gi, 500Mi)"
      : null;
  };

  const edit = useEditField<{ value: string }>({
    id: "pvc:requested_storage",
    initial: () => ({ value: requestedStorage ?? "" }),
    serialize: (b) => ({
      spec: {
        resources: {
          requests: {
            storage: b.value.trim(),
          },
        },
      },
    }),
    dirtyCount: (b) => (b.value.trim() !== (requestedStorage ?? "") ? 1 : 0),
    validate: (b) => validateQuantity(b.value),
  });

  const isDirty = edit.dirty > 0;
  const invalid = edit.editing && validateQuantity(edit.buffer.value) !== null;

  return (
    <div style={{ width: "100%" }}>
      {edit.editing ? (
        <EditableTextValue
          t={t}
          value={edit.buffer.value}
          onChange={(v) => edit.setBuffer({ value: v })}
          invalid={invalid}
          placeholder="e.g. 10Gi"
          ariaLabel="Requested storage"
        />
      ) : requestedStorage ? (
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            color: isDirty ? t.warn : t.text,
          }}
        >
          {isDirty ? edit.buffer.value : requestedStorage}
        </span>
      ) : (
        <Mute t={t}>—</Mute>
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
  );
}

// ── PersistentVolumeClaim ──────────────────────────────────────────────────

export function PersistentVolumeClaimSummary(props: {
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
  const state = useDetail<PersistentVolumeClaimDetail>(
    () => api.getPersistentVolumeClaimDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return (
      <ErrorBlock t={t} message="PersistentVolumeClaim requires a namespace." />
    );
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading persistent volume claim…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="persistent volume claim" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "persistentvolumeclaims",
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
          {d.capacity && (
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_MD,
                fontWeight: 600,
                color: t.text,
              }}
            >
              {d.capacity}
            </span>
          )}
          {d.requested_storage && d.requested_storage !== d.capacity && (
            <span style={{ fontSize: FS_SM, color: t.textMuted }}>
              requested {d.requested_storage}
            </span>
          )}
          {d.meta.created_at && (
            <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
            kindId: "persistentvolumeclaims",
            namespace: ns,
            name: props.name,
          }}
        />

        <Section t={t} title="Spec" />
        <div style={{ marginBottom: 22 }}>
          <DetailRow t={t} label="Storage Class">
            {d.storage_class ? (
              <LinkValue
                t={t}
                onClick={() =>
                  props.onNavigate?.("StorageClass", null, d.storage_class!)
                }
                copyText={d.storage_class}
                enabled={!!props.onNavigate}
              >
                {d.storage_class}
              </LinkValue>
            ) : (
              <Mute t={t}>(default)</Mute>
            )}
          </DetailRow>
          <DetailRow t={t} label="Volume">
            {d.volume_name ? (
              <LinkValue
                t={t}
                onClick={() =>
                  props.onNavigate?.("PersistentVolume", null, d.volume_name!)
                }
                copyText={d.volume_name}
                enabled={!!props.onNavigate}
              >
                {d.volume_name}
              </LinkValue>
            ) : (
              <Mute t={t}>(unbound)</Mute>
            )}
          </DetailRow>
          <DetailRow t={t} label="Access Modes">
            <StringChips t={t} items={d.access_modes} />
          </DetailRow>
          {d.volume_mode && (
            <DetailRow t={t} label="Volume Mode">
              <Scalar t={t} value={d.volume_mode} />
            </DetailRow>
          )}
          <DetailRow t={t} label="Requested">
            <PvcRequestedStorageEditor
              t={t}
              requestedStorage={d.requested_storage}
            />
          </DetailRow>
          <DetailRow t={t} label="Capacity">
            <Scalar t={t} value={d.capacity} />
          </DetailRow>
          {d.allocated_resources.length > 0 && (
            <DetailRow t={t} label="Allocated">
              <KeyValueChips t={t} pairs={d.allocated_resources} />
            </DetailRow>
          )}
          {(d.selector.match_labels.length > 0 ||
            d.selector.match_expressions > 0) && (
            <DetailRow t={t} label="Selector">
              {d.selector.match_labels.length > 0 && (
                <KeyValueChips t={t} pairs={d.selector.match_labels} />
              )}
              {d.selector.match_expressions > 0 && (
                <span style={{ fontSize: FS_SM, color: t.textDim, marginLeft: 6 }}>
                  + {d.selector.match_expressions} matchExpression
                  {d.selector.match_expressions === 1 ? "" : "s"}
                </span>
              )}
            </DetailRow>
          )}
        </div>

        {(d.data_source || d.data_source_ref) && (
          <>
            <Section t={t} title="Data Source" />
            <div style={{ marginBottom: 22 }}>
              {d.data_source && d.data_source.kind && d.data_source.name && (
                <DetailRow t={t} label="From">
                  <span style={{ fontSize: FS_MD, color: t.textDim }}>
                    {d.data_source.kind}
                  </span>
                  <LinkValue
                    t={t}
                    onClick={() =>
                      props.onNavigate?.(
                        d.data_source!.kind!,
                        ns,
                        d.data_source!.name!,
                      )
                    }
                    copyText={d.data_source.name}
                    enabled={!!props.onNavigate}
                  >
                    {d.data_source.name}
                  </LinkValue>
                  {d.data_source.api_group && (
                    <span style={{ fontSize: FS_SM, color: t.textMuted }}>
                      {d.data_source.api_group}
                    </span>
                  )}
                </DetailRow>
              )}
              {d.data_source_ref && d.data_source_ref.kind &&
                d.data_source_ref.name && (
                  <DetailRow t={t} label="From Ref">
                    <span style={{ fontSize: FS_MD, color: t.textDim }}>
                      {d.data_source_ref.kind}
                    </span>
                    <LinkValue
                      t={t}
                      onClick={() =>
                        props.onNavigate?.(
                          d.data_source_ref!.kind!,
                          d.data_source_ref!.namespace ?? ns,
                          d.data_source_ref!.name!,
                        )
                      }
                      copyText={d.data_source_ref.name}
                      enabled={!!props.onNavigate}
                    >
                      {d.data_source_ref.name}
                    </LinkValue>
                    {d.data_source_ref.namespace && (
                      <span style={{ fontSize: FS_SM, color: t.textMuted }}>
                        ns {d.data_source_ref.namespace}
                      </span>
                    )}
                  </DetailRow>
                )}
            </div>
          </>
        )}

        <ConditionsSection t={t} conditions={d.conditions} />
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}

// ── PersistentVolume ───────────────────────────────────────────────────────

export function PersistentVolumeSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<PersistentVolumeDetail>(
    () => api.getPersistentVolumeDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading persistent volume…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="persistent volume" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "persistentvolumes",
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
          {d.capacity && (
            <span
              style={{
                fontFamily: FF_MONO,
                fontSize: FS_MD,
                fontWeight: 600,
                color: t.text,
              }}
            >
              {d.capacity}
            </span>
          )}
          {d.source_type && (
            <StatusPill
              status={d.source_type}
              t={t}
              mode={props.mode}
              dense
            />
          )}
          {d.meta.created_at && (
            <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
            kindId: "persistentvolumes",
            namespace: null,
            name: props.name,
          }}
        />

        <Section t={t} title="Spec" />
        <div style={{ marginBottom: 22 }}>
          <DetailRow t={t} label="Capacity">
            <Scalar t={t} value={d.capacity} />
          </DetailRow>
          <DetailRow t={t} label="Access Modes">
            <StringChips t={t} items={d.access_modes} />
          </DetailRow>
          <DetailRow t={t} label="Reclaim Policy">
            <Scalar t={t} value={d.reclaim_policy} mono={false} />
          </DetailRow>
          <DetailRow t={t} label="Storage Class">
            {d.storage_class ? (
              <LinkValue
                t={t}
                onClick={() =>
                  props.onNavigate?.("StorageClass", null, d.storage_class!)
                }
                copyText={d.storage_class}
                enabled={!!props.onNavigate}
              >
                {d.storage_class}
              </LinkValue>
            ) : (
              <Mute t={t}>—</Mute>
            )}
          </DetailRow>
          {d.volume_mode && (
            <DetailRow t={t} label="Volume Mode">
              <Scalar t={t} value={d.volume_mode} />
            </DetailRow>
          )}
          {d.mount_options.length > 0 && (
            <DetailRow t={t} label="Mount Options">
              <StringChips t={t} items={d.mount_options} />
            </DetailRow>
          )}
        </div>

        <Section t={t} title="Source" />
        <div style={{ marginBottom: 22 }}>
          <DetailRow t={t} label="Type">
            <Scalar t={t} value={d.source_type} mono={false} />
          </DetailRow>
          <DetailRow t={t} label="Summary">
            <Scalar t={t} value={d.source_summary} />
          </DetailRow>
        </div>

        {d.claim_ref && (d.claim_ref.name || d.claim_ref.namespace) && (
          <>
            <Section t={t} title="Claim" />
            <div style={{ marginBottom: 22 }}>
              <DetailRow t={t} label="Bound To">
                {d.claim_ref.name ? (
                  <LinkValue
                    t={t}
                    onClick={() =>
                      props.onNavigate?.(
                        d.claim_ref!.kind ?? "PersistentVolumeClaim",
                        d.claim_ref!.namespace ?? null,
                        d.claim_ref!.name!,
                      )
                    }
                    copyText={d.claim_ref.name}
                    enabled={!!props.onNavigate}
                  >
                    {d.claim_ref.name}
                  </LinkValue>
                ) : (
                  <Mute t={t}>—</Mute>
                )}
                {d.claim_ref.namespace && (
                  <LinkValue
                    t={t}
                    onClick={() =>
                      props.onNavigate?.("Namespace", null, d.claim_ref!.namespace!)
                    }
                    copyText={d.claim_ref.namespace}
                    enabled={!!props.onNavigate}
                  >
                    {d.claim_ref.namespace}
                  </LinkValue>
                )}
              </DetailRow>
              {d.claim_ref.uid && (
                <DetailRow t={t} label="Claim UID">
                  <Copyable text={d.claim_ref.uid}>
                    <span
                      style={{
                        fontFamily: FF_MONO,
                        fontSize: FS_SM,
                        color: t.textDim,
                        wordBreak: "break-all",
                      }}
                    >
                      {d.claim_ref.uid}
                    </span>
                  </Copyable>
                </DetailRow>
              )}
            </div>
          </>
        )}

        {d.node_affinity.term_count > 0 && (
          <>
            <Section t={t} title="Node Affinity" />
            <div style={{ marginBottom: 22 }}>
              <DetailRow t={t} label="Required Terms">
                <Mono>
                  {d.node_affinity.term_count}
                </Mono>
              </DetailRow>
              {d.node_affinity.keys.length > 0 && (
                <DetailRow t={t} label="Keys">
                  <StringChips t={t} items={d.node_affinity.keys} />
                </DetailRow>
              )}
            </div>
          </>
        )}

        {(d.phase_message || d.phase_reason) && (
          <>
            <Section t={t} title="Status" />
            <div style={{ marginBottom: 22 }}>
              {d.phase_reason && (
                <DetailRow t={t} label="Reason">
                  <Scalar t={t} value={d.phase_reason} mono={false} />
                </DetailRow>
              )}
              {d.phase_message && (
                <DetailRow t={t} label="Message">
                  <span
                    style={{
                      fontSize: FS_SM,
                      color: t.textMuted,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {d.phase_message}
                  </span>
                </DetailRow>
              )}
            </div>
          </>
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}

// ── StorageClass ───────────────────────────────────────────────────────────

export function StorageClassSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<StorageClassDetail>(
    () => api.getStorageClassDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading storage class…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="storage class" />;

  const d = state.detail;
  return (
    <EditSessionProvider
      target={{
        clusterId: props.clusterId,
        kindId: "storageclasses",
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
          <span
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              fontWeight: 600,
              color: t.text,
              wordBreak: "break-all",
            }}
          >
            {d.provisioner}
          </span>
          {d.is_default && (
            <StatusPill status="Default" t={t} mode={props.mode} dense />
          )}
          {d.allow_volume_expansion && (
            <StatusPill status="Expandable" t={t} mode={props.mode} dense />
          )}
          {d.meta.created_at && (
            <span style={{ fontSize: FS_SM, color: t.textMuted }}>
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
            kindId: "storageclasses",
            namespace: null,
            name: props.name,
          }}
        />

        <Section t={t} title="Spec" />
        <div style={{ marginBottom: 22 }}>
          <DetailRow t={t} label="Provisioner">
            <Scalar t={t} value={d.provisioner} />
          </DetailRow>
          <DetailRow t={t} label="Reclaim Policy">
            <Scalar t={t} value={d.reclaim_policy} mono={false} />
          </DetailRow>
          <DetailRow t={t} label="Binding Mode">
            <Scalar t={t} value={d.binding_mode} mono={false} />
          </DetailRow>
          <DetailRow t={t} label="Allow Expansion">
            <span style={{ fontSize: FS_MD }}>
              {d.allow_volume_expansion === true
                ? "true"
                : d.allow_volume_expansion === false
                  ? "false"
                  : "—"}
            </span>
          </DetailRow>
          <DetailRow t={t} label="Default">
            <span style={{ fontSize: FS_MD }}>{d.is_default ? "true" : "false"}</span>
          </DetailRow>
        </div>

        {d.parameters.length > 0 && (
          <>
            <Section
              t={t}
              title="Parameters"
              right={
                <span
                  style={{
                    fontSize: FS_XS,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  {d.parameters.length} total
                </span>
              }
            />
            <div style={{ marginBottom: 22 }}>
              <DetailRow t={t} label="Parameters">
                <KeyValueChips t={t} pairs={d.parameters} />
              </DetailRow>
            </div>
          </>
        )}

        {d.mount_options.length > 0 && (
          <>
            <Section t={t} title="Mount Options" />
            <div style={{ marginBottom: 22 }}>
              <DetailRow t={t} label="Options">
                <StringChips t={t} items={d.mount_options} />
              </DetailRow>
            </div>
          </>
        )}

        {d.allowed_topologies.term_count > 0 && (
          <>
            <Section t={t} title="Allowed Topologies" />
            <div style={{ marginBottom: 22 }}>
              <DetailRow t={t} label="Terms">
                <Mono>
                  {d.allowed_topologies.term_count}
                </Mono>
              </DetailRow>
              {d.allowed_topologies.keys.length > 0 && (
                <DetailRow t={t} label="Keys">
                  <StringChips t={t} items={d.allowed_topologies.keys} />
                </DetailRow>
              )}
            </div>
          </>
        )}
        <GlobalSaveBar t={t} />
      </Frame>
    </EditSessionProvider>
  );
}
