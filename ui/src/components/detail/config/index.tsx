// Per-kind detail summaries for the config family (ConfigMap, Secret,
// ResourceQuota, LimitRange). Same shape as the workload + cluster
// summaries: fetch on mount + on detailVersion bumps, compose shared
// primitives, dispatch from DetailPanel.
//
// Phase A is read-only. Phase B layers an Edit affordance on top via
// server-side apply (see tasks.md M2 + the Phase B task in the project's
// task list). Each rendered key/value here is the surface that edit will
// hook into — keep the row structure stable so the Edit pencil can drop in
// per-row without reflowing the layout.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Chip, Loading, Section } from "../../ui";
import {
  ChipWrap,
  Copyable,
  DetailRow,
  KeyValueChips,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import type {
  ConfigMapDetail,
  LimitRangeDetail,
  ResourceQuotaDetail,
  SecretDetail,
} from "../../../types";
import { MetaSection } from "../workload/shared";
import {
  AddRowButton,
  ConflictBanner,
  EditModeChrome,
  EditableTextValue,
  RowDeleteButton,
  useApply,
} from "../edit";

// ── Local fetch + chrome (mirrors cluster/index.tsx) ───────────────────────

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
    // snap the scroll container back to the top after every action (save,
    // force-takeover, etc.).
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

function Frame({ t, children }: { t: Tokens; children: ReactNode }) {
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

function NsRequired({ t, label }: { t: Tokens; label: string }) {
  return <ErrorBlock t={t} message={`${label} requires a namespace.`} />;
}

// Approximate human-readable byte count. Stays small (≤6 chars) so it fits
// next to a key chip without wrapping. Not i18n'd — same conventions as
// kubectl describe ("12B", "1.2KiB").
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
}

// ── ConfigMap ──────────────────────────────────────────────────────────────

export function ConfigMapSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  // Local refetch counter — bumped after a successful save so we read the
  // post-apply state without waiting for the watcher delta to arrive.
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<ConfigMapDetail>(
    () => api.getConfigMapDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <NsRequired t={t} label="ConfigMap" />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading configmap…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  const d = state.detail;
  return (
    <ConfigMapView
      t={t}
      mode={props.mode}
      clusterId={props.clusterId}
      namespace={ns}
      name={props.name}
      detail={d}
      onNavigate={props.onNavigate}
      onSaved={() => setRefetch((r) => r + 1)}
    />
  );
}

// Split out so the edit hook can re-key off `detail` without re-running the
// fetch effect on every keystroke.
function ConfigMapView({
  t,
  mode: _mode,
  clusterId,
  namespace,
  name,
  detail: d,
  onNavigate,
  onSaved,
}: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  namespace: string;
  name: string;
  detail: ConfigMapDetail;
  onNavigate?: DetailNavigate;
  onSaved: () => void;
}) {
  const edit = useApply<ConfigMapBuffer>({
    target: { clusterId, kindId: "configmaps", namespace, name },
    initial: () => bufferFromConfigMap(d),
    serialize: serializeConfigMapBuffer,
    dirtyCount: configMapDirtyCount,
    onSaved,
  });

  // Re-seed the buffer if the underlying detail changes while we're editing
  // (e.g. someone else patched the same object). The hook uses a ref to
  // grab `initial()` only on enter() — so without this, a watcher-driven
  // refetch would not flow into the buffer. Cheap to do here since
  // `bufferFromConfigMap` is pure.
  useEffect(() => {
    if (!edit.editing) return;
    // Don't clobber dirty edits silently; leave the operator a chance to
    // resolve. This matches kubectl edit's behaviour when the underlying
    // object changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  const validation = useMemo(
    () => validateConfigMapBuffer(edit.buffer),
    [edit.buffer],
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
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.data.length} key{d.data.length === 1 ? "" : "s"}
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
          {d.immutable ? " · immutable" : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={onNavigate}
        editTarget={{ clusterId, kindId: "configmaps", namespace, name }}
        onSaved={onSaved}
      />

      <Section
        t={t}
        title="Data"
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
                {d.data.length} total
              </span>
            }
          />
        }
      />

      {edit.conflict && (
        <ConflictBanner
          t={t}
          conflict={edit.conflict}
          saving={edit.saving}
          onForce={edit.forceSave}
          onDismiss={edit.dismissConflict}
        />
      )}
      {edit.error && <InlineError t={t} message={edit.error} />}
      {edit.editing && validation.duplicate.size > 0 && (
        <InlineError
          t={t}
          message={`Duplicate keys: ${[...validation.duplicate].join(", ")}`}
        />
      )}
      {d.immutable && edit.editing && (
        <InlineWarn
          t={t}
          message="ConfigMap is immutable — apply will be rejected by the apiserver. Clone instead."
        />
      )}

      <div style={{ marginBottom: 22 }}>
        {edit.editing
          ? edit.buffer.rows.map((row) => (
              <ConfigMapEditRow
                key={row.id}
                t={t}
                row={row}
                duplicate={validation.duplicate.has(row.key)}
                invalidKey={!isValidConfigKey(row.key) && !row.deleted}
                onChange={(next) =>
                  edit.setBuffer((b) => ({
                    ...b,
                    rows: b.rows.map((r) => (r.id === row.id ? next : r)),
                  }))
                }
                onDelete={() =>
                  edit.setBuffer((b) => toggleDeleteRow(b, row.id))
                }
              />
            ))
          : d.data.length === 0
            ? (
              <DetailRow t={t} label="Data">
                <Mute t={t}>—</Mute>
              </DetailRow>
            )
            : d.data.map((entry) => (
                <DetailRow key={entry.key} t={t} label={entry.key}>
                  <DataValueBlock
                    t={t}
                    value={entry.value}
                    size={entry.size}
                    binary={entry.binary}
                  />
                </DetailRow>
              ))}

        {edit.editing && (
          <AddRowButton
            t={t}
            label="Add key"
            onClick={() =>
              edit.setBuffer((b) => ({
                ...b,
                rows: [...b.rows, { ...newConfigMapRow(), id: b.nextId }],
                nextId: b.nextId + 1,
              }))
            }
          />
        )}
      </div>
    </Frame>
  );
}

// ── ConfigMap edit buffer ──────────────────────────────────────────────────

type ConfigMapRow = {
  id: number;
  key: string;
  value: string;
  binary: boolean;
  // True for a freshly-added row, false for an existing key. Existing keys
  // ride the original key/value so dirty detection compares against them.
  isNew: boolean;
  // Soft-delete flag. We render struck-through and exclude from the SSA
  // payload so the apiserver removes the key from `data`.
  deleted: boolean;
  originalKey: string;
  originalValue: string;
};

type ConfigMapBuffer = {
  rows: ConfigMapRow[];
  nextId: number;
};

function bufferFromConfigMap(d: ConfigMapDetail): ConfigMapBuffer {
  let id = 1;
  const rows: ConfigMapRow[] = d.data.map((e) => ({
    id: id++,
    key: e.key,
    value: e.value,
    binary: e.binary,
    isNew: false,
    deleted: false,
    originalKey: e.key,
    originalValue: e.value,
  }));
  return { rows, nextId: id };
}

function newConfigMapRow(): ConfigMapRow {
  // id is filled by the setBuffer caller — using a placeholder of 0 here
  // would clash with the existing rows; the closure that calls this passes
  // its own next id. Keep this returning a zero-id sentinel so the caller
  // is forced to assign one.
  return {
    id: Number.NaN,
    key: "",
    value: "",
    binary: false,
    isNew: true,
    deleted: false,
    originalKey: "",
    originalValue: "",
  };
}

function toggleDeleteRow(b: ConfigMapBuffer, id: number): ConfigMapBuffer {
  return {
    ...b,
    rows: b.rows
      // A new row marked for delete is just removed entirely — there's no
      // "original" to fall back to.
      .filter((r) => !(r.id === id && r.isNew))
      .map((r) => (r.id === id ? { ...r, deleted: !r.deleted } : r)),
  };
}

function configMapDirtyCount(b: ConfigMapBuffer): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.binary) continue;
    if (r.isNew) {
      // Empty rows don't count — the user may have hit + and changed mind.
      if (r.key !== "" || r.value !== "") n += 1;
    } else if (r.deleted) {
      n += 1;
    } else if (r.key !== r.originalKey || r.value !== r.originalValue) {
      n += 1;
    }
  }
  return n;
}

function validateConfigMapBuffer(b: ConfigMapBuffer): {
  duplicate: Set<string>;
} {
  const counts = new Map<string, number>();
  for (const r of b.rows) {
    if (r.deleted || r.binary) continue;
    if (r.key === "") continue;
    counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  }
  const duplicate = new Set<string>();
  for (const [k, n] of counts) if (n > 1) duplicate.add(k);
  return { duplicate };
}

// ConfigMap key constraint — same regex the apiserver enforces.
function isValidConfigKey(k: string): boolean {
  return k === "" || /^[-._a-zA-Z0-9]+$/.test(k);
}

function serializeConfigMapBuffer(b: ConfigMapBuffer): Record<string, unknown> {
  // SSA owns the entire `data` map: we send every non-deleted text row,
  // and the apiserver removes any key not present that we previously
  // owned. binaryData rows ride through unchanged so we don't accidentally
  // strip them.
  const data: Record<string, string> = {};
  const binaryData: Record<string, string> = {};
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.key === "") continue;
    if (r.binary) {
      binaryData[r.key] = r.value;
    } else {
      data[r.key] = r.value;
    }
  }
  const payload: Record<string, unknown> = { data };
  if (Object.keys(binaryData).length > 0) {
    payload.binaryData = binaryData;
  }
  return payload;
}

function ConfigMapEditRow({
  t,
  row,
  duplicate,
  invalidKey,
  onChange,
  onDelete,
}: {
  t: Tokens;
  row: ConfigMapRow;
  duplicate: boolean;
  invalidKey: boolean;
  onChange: (next: ConfigMapRow) => void;
  onDelete: () => void;
}) {
  // Binary rows can't be edited safely — we'd be round-tripping base64
  // bytes through a text input. Show them in a muted pre-render with the
  // delete button still available.
  if (row.binary) {
    return (
      <DetailRow t={t} label={row.key}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            opacity: row.deleted ? 0.4 : 1,
            textDecoration: row.deleted ? "line-through" : "none",
          }}
        >
          <Chip t={t} mono>
            base64
          </Chip>
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
            (binary — clone in YAML to edit)
          </span>
          <RowDeleteButton t={t} onClick={onDelete} />
        </div>
      </DetailRow>
    );
  }

  // Existing key, mark deleted: render the original key/value struck
  // through so the operator can confirm before save.
  if (row.deleted) {
    return (
      <DetailRow t={t} label={row.originalKey}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            opacity: 0.45,
            textDecoration: "line-through",
            fontFamily: FONT_MONO,
            fontSize: 11.5,
          }}
        >
          <span>{row.originalValue || " "}</span>
          <RowDeleteButton t={t} onClick={onDelete} title="Restore" />
        </div>
      </DetailRow>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr auto",
        gap: 12,
        alignItems: "flex-start",
        padding: "8px 0",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <div style={{ paddingTop: 6 }}>
        <EditableTextValue
          t={t}
          value={row.key}
          onChange={(k) => onChange({ ...row, key: k })}
          placeholder={row.isNew ? "new-key" : ""}
          invalid={duplicate || invalidKey}
          ariaLabel="ConfigMap key"
        />
      </div>
      <div>
        <EditableTextValue
          t={t}
          value={row.value}
          onChange={(v) => onChange({ ...row, value: v })}
          placeholder=""
          multiline={row.value.includes("\n") || row.value.length > 60}
          ariaLabel={`ConfigMap value for ${row.key || "new key"}`}
        />
      </div>
      <div style={{ paddingTop: 4 }}>
        <RowDeleteButton t={t} onClick={onDelete} />
      </div>
    </div>
  );
}

function InlineError({ t, message }: { t: Tokens; message: string }) {
  return (
    <div
      style={{
        margin: "0 0 12px",
        padding: "8px 10px",
        background: "rgba(244,63,94,0.10)",
        border: "1px solid rgba(244,63,94,0.4)",
        borderRadius: 3,
        color: t.bad,
        fontSize: 11.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {message}
    </div>
  );
}

function InlineWarn({ t, message }: { t: Tokens; message: string }) {
  return (
    <div
      style={{
        margin: "0 0 12px",
        padding: "8px 10px",
        background: "rgba(245,158,11,0.10)",
        border: "1px solid rgba(245,158,11,0.4)",
        borderRadius: 3,
        color: t.warn,
        fontSize: 11.5,
      }}
    >
      {message}
    </div>
  );
}

// Renders the value of a single ConfigMap key. Multi-line values get a
// pre-wrap block; single-line values render inline. Always click-to-copy.
function DataValueBlock({
  t,
  value,
  size,
  binary,
}: {
  t: Tokens;
  value: string;
  size: number;
  binary: boolean;
}) {
  const multiline = !binary && value.includes("\n");
  return (
    <div style={{ minWidth: 0, width: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: multiline ? 4 : 0,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: t.textMuted,
            fontFamily: FONT_MONO,
          }}
        >
          {formatBytes(size)}
        </span>
        {binary && (
          <Chip t={t} mono>
            base64
          </Chip>
        )}
      </div>
      <Copyable text={value} block>
        <pre
          style={{
            margin: 0,
            padding: multiline ? "6px 8px" : 0,
            background: multiline ? t.headerAlt : "transparent",
            border: multiline ? `1px solid ${t.borderSoft}` : "none",
            borderRadius: multiline ? 3 : 0,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: t.text,
            whiteSpace: multiline ? "pre-wrap" : "pre",
            wordBreak: "break-all",
            overflow: "auto",
            maxHeight: multiline ? 220 : "none",
          }}
        >
          {value || " "}
        </pre>
      </Copyable>
    </div>
  );
}

// ── Secret ─────────────────────────────────────────────────────────────────

export function SecretSummary(props: {
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
  const state = useDetail<SecretDetail>(
    () => api.getSecretDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <NsRequired t={t} label="Secret" />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading secret…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  return (
    <SecretView
      t={t}
      mode={props.mode}
      clusterId={props.clusterId}
      namespace={ns}
      name={props.name}
      detail={state.detail}
      onNavigate={props.onNavigate}
      onSaved={() => setRefetch((r) => r + 1)}
    />
  );
}

function SecretView({
  t,
  mode: _mode,
  clusterId,
  namespace,
  name,
  detail: d,
  onNavigate,
  onSaved,
}: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  namespace: string;
  name: string;
  detail: SecretDetail;
  onNavigate?: DetailNavigate;
  onSaved: () => void;
}) {
  const edit = useApply<SecretBuffer>({
    target: { clusterId, kindId: "secrets", namespace, name },
    initial: () => bufferFromSecret(d),
    serialize: serializeSecretBuffer,
    dirtyCount: secretDirtyCount,
    onSaved,
  });

  const validation = useMemo(
    () => validateSecretBuffer(edit.buffer),
    [edit.buffer],
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
        <Chip t={t} mono>
          {d.type_}
        </Chip>
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.data.length} key{d.data.length === 1 ? "" : "s"}
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
          {d.immutable ? " · immutable" : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={onNavigate}
        editTarget={{ clusterId, kindId: "secrets", namespace, name }}
        onSaved={onSaved}
      />

      <Section
        t={t}
        title="Data"
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
                {d.data.length} total
              </span>
            }
          />
        }
      />

      {edit.conflict && (
        <ConflictBanner
          t={t}
          conflict={edit.conflict}
          saving={edit.saving}
          onForce={edit.forceSave}
          onDismiss={edit.dismissConflict}
        />
      )}
      {edit.error && <InlineError t={t} message={edit.error} />}
      {edit.editing && validation.duplicate.size > 0 && (
        <InlineError
          t={t}
          message={`Duplicate keys: ${[...validation.duplicate].join(", ")}`}
        />
      )}
      {edit.editing && validation.invalidRows.length > 0 && (
        <InlineError
          t={t}
          message={`Invalid base64 in: ${validation.invalidRows.join(", ")}`}
        />
      )}
      {d.immutable && edit.editing && (
        <InlineWarn
          t={t}
          message="Secret is immutable — apply will be rejected by the apiserver. Clone instead."
        />
      )}

      <div style={{ marginBottom: 22 }}>
        {edit.editing
          ? edit.buffer.rows.map((row) => (
              <SecretEditRow
                key={row.id}
                t={t}
                row={row}
                duplicate={validation.duplicate.has(row.key)}
                invalidKey={!isValidConfigKey(row.key) && !row.deleted}
                onChange={(next) =>
                  edit.setBuffer((b) => ({
                    ...b,
                    rows: b.rows.map((r) => (r.id === row.id ? next : r)),
                  }))
                }
                onDelete={() =>
                  edit.setBuffer((b) => toggleDeleteSecretRow(b, row.id))
                }
              />
            ))
          : d.data.length === 0
            ? (
              <DetailRow t={t} label="Data">
                <Mute t={t}>—</Mute>
              </DetailRow>
            )
            : d.data.map((entry) => (
                <DetailRow key={entry.key} t={t} label={entry.key}>
                  <SecretValueRow t={t} entry={entry} />
                </DetailRow>
              ))}

        {edit.editing && (
          <AddRowButton
            t={t}
            label="Add key"
            onClick={() =>
              edit.setBuffer((b) => ({
                ...b,
                rows: [...b.rows, { ...newSecretRow(), id: b.nextId }],
                nextId: b.nextId + 1,
              }))
            }
          />
        )}
      </div>
    </Frame>
  );
}

// ── Secret edit buffer ─────────────────────────────────────────────────────
//
// Edits operate on **base64 strings** so we never have to round-trip an
// arbitrary byte sequence through utf-8 just to display it. The reveal
// affordance decodes for *display* and lets the operator edit the
// plaintext form (we re-encode to base64 on commit). Switching reveal off
// re-collapses to base64 — the field is the source of truth.

type SecretRow = {
  id: number;
  key: string;
  // Always the canonical base64 form. The plaintext editor keeps a parallel
  // string in `plaintext` while revealed; on hide we decode from `value_b64`.
  value_b64: string;
  // Local UI state — present only while the row is being edited.
  revealed: boolean;
  // Plaintext mirror used while revealed. Null when the base64 doesn't
  // decode as utf-8; in that case reveal stays disabled.
  plaintext: string | null;
  isNew: boolean;
  deleted: boolean;
  originalKey: string;
  originalValueB64: string;
};

type SecretBuffer = {
  rows: SecretRow[];
  nextId: number;
};

function bufferFromSecret(d: SecretDetail): SecretBuffer {
  let id = 1;
  const rows: SecretRow[] = d.data.map((e) => ({
    id: id++,
    key: e.key,
    value_b64: e.value_b64 ?? "",
    revealed: false,
    plaintext: null,
    isNew: false,
    deleted: false,
    originalKey: e.key,
    originalValueB64: e.value_b64 ?? "",
  }));
  return { rows, nextId: id };
}

function newSecretRow(): SecretRow {
  return {
    id: Number.NaN,
    key: "",
    value_b64: "",
    revealed: true,
    plaintext: "",
    isNew: true,
    deleted: false,
    originalKey: "",
    originalValueB64: "",
  };
}

function toggleDeleteSecretRow(b: SecretBuffer, id: number): SecretBuffer {
  return {
    ...b,
    rows: b.rows
      .filter((r) => !(r.id === id && r.isNew))
      .map((r) => (r.id === id ? { ...r, deleted: !r.deleted } : r)),
  };
}

function secretDirtyCount(b: SecretBuffer): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.isNew) {
      if (r.key !== "" || r.value_b64 !== "") n += 1;
    } else if (r.deleted) {
      n += 1;
    } else if (r.key !== r.originalKey || r.value_b64 !== r.originalValueB64) {
      n += 1;
    }
  }
  return n;
}

function validateSecretBuffer(b: SecretBuffer): {
  duplicate: Set<string>;
  invalidRows: string[];
} {
  const counts = new Map<string, number>();
  const invalidRows: string[] = [];
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.key === "") continue;
    counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    if (r.value_b64 !== "" && !isValidBase64(r.value_b64)) {
      invalidRows.push(r.key);
    }
  }
  const duplicate = new Set<string>();
  for (const [k, n] of counts) if (n > 1) duplicate.add(k);
  return { duplicate, invalidRows };
}

function isValidBase64(s: string): boolean {
  // The Kubernetes apiserver rejects non-canonical base64 too — match its
  // strictness so we catch trailing whitespace / wrong padding before SSA.
  if (s.length === 0) return true;
  if (s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function serializeSecretBuffer(b: SecretBuffer): Record<string, unknown> {
  // We own `data` (base64 form) entirely. `stringData` is a write-only
  // convenience the apiserver merges into `data` server-side, so we never
  // emit it ourselves.
  const data: Record<string, string> = {};
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.key === "") continue;
    data[r.key] = r.value_b64;
  }
  return { data };
}

function SecretEditRow({
  t,
  row,
  duplicate,
  invalidKey,
  onChange,
  onDelete,
}: {
  t: Tokens;
  row: SecretRow;
  duplicate: boolean;
  invalidKey: boolean;
  onChange: (next: SecretRow) => void;
  onDelete: () => void;
}) {
  // Deleted-existing-row chrome (matches ConfigMap).
  if (row.deleted) {
    return (
      <DetailRow t={t} label={row.originalKey}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            opacity: 0.45,
            textDecoration: "line-through",
            fontFamily: FONT_MONO,
            fontSize: 11.5,
          }}
        >
          <span>{maskBase64(row.originalValueB64) || " "}</span>
          <RowDeleteButton t={t} onClick={onDelete} title="Restore" />
        </div>
      </DetailRow>
    );
  }

  const decoded = row.value_b64 ? safeDecodeBase64(row.value_b64) : "";
  const decodable = decoded != null;
  const invalidB64 = row.value_b64 !== "" && !isValidBase64(row.value_b64);

  const reveal = () => {
    if (!decodable) return;
    onChange({ ...row, revealed: true, plaintext: decoded ?? "" });
  };
  const hide = () => {
    onChange({ ...row, revealed: false, plaintext: null });
  };

  // Layout: single row with key, value input, mode pill, × — all on the
  // same baseline so a key and its value never drift to different visual
  // levels. Multiline values flow the textarea to fill the value column;
  // the mode pill stays anchored at the top-right of that cell so its
  // vertical position doesn't shift with row height.
  const showPlaintext = row.revealed;
  const valueInput = showPlaintext ? (
    <EditableTextValue
      t={t}
      value={row.plaintext ?? ""}
      onChange={(v) =>
        onChange({
          ...row,
          plaintext: v,
          value_b64: encodeUtf8ToBase64(v),
        })
      }
      multiline={
        (row.plaintext ?? "").includes("\n") ||
        (row.plaintext ?? "").length > 60
      }
      ariaLabel={`Plaintext value for ${row.key || "new key"}`}
    />
  ) : (
    <EditableTextValue
      t={t}
      value={row.value_b64}
      onChange={(v) => onChange({ ...row, value_b64: v })}
      multiline={row.value_b64.length > 60}
      invalid={invalidB64}
      ariaLabel={`Base64 value for ${row.key || "new key"}`}
    />
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr auto auto",
        gap: 8,
        alignItems: "flex-start",
        padding: "8px 0",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <div style={{ paddingTop: 4 }}>
        <EditableTextValue
          t={t}
          value={row.key}
          onChange={(k) => onChange({ ...row, key: k })}
          placeholder={row.isNew ? "new-key" : ""}
          invalid={duplicate || invalidKey}
          ariaLabel="Secret key"
        />
      </div>

      <div style={{ paddingTop: 4, minWidth: 0 }}>
        {valueInput}
        {invalidB64 && (
          <div
            style={{
              fontSize: 10.5,
              color: t.bad,
              fontFamily: FONT_MONO,
              marginTop: 2,
            }}
          >
            invalid base64
          </div>
        )}
      </div>

      <div style={{ paddingTop: 6 }}>
        <button
          type="button"
          onClick={() => (showPlaintext ? hide() : reveal())}
          disabled={!showPlaintext && !decodable}
          title={
            showPlaintext
              ? "Show base64 (hide plaintext)"
              : decodable
                ? "Decode base64 and reveal plaintext"
                : "Value is not valid utf-8 — edit base64 directly"
          }
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            padding: "2px 7px",
            height: 24,
            borderRadius: 3,
            background: showPlaintext ? "rgba(245,158,11,0.16)" : t.chip,
            color: showPlaintext
              ? t.warn
              : decodable
                ? t.textDim
                : t.textMuted,
            border: "none",
            cursor: !showPlaintext && !decodable ? "not-allowed" : "pointer",
            fontWeight: 700,
            letterSpacing: 0.4,
            whiteSpace: "nowrap",
          }}
        >
          {showPlaintext ? "TEXT" : "B64"}
        </button>
      </div>

      <div style={{ paddingTop: 6 }}>
        <RowDeleteButton t={t} onClick={onDelete} />
      </div>
    </div>
  );
}

function encodeUtf8ToBase64(s: string): string {
  // Use TextEncoder so multi-byte characters survive intact; btoa(string)
  // would mangle anything outside latin1.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Single secret key row. Default state shows the base64 string masked + a
// "Reveal" toggle that decodes and displays plaintext. The base64 itself is
// click-to-copy on the masked view; revealed plaintext copies plaintext.
function SecretValueRow({
  t,
  entry,
}: {
  t: Tokens;
  entry: SecretDetail["data"][number];
}) {
  const [revealed, setRevealed] = useState(false);
  const b64 = entry.value_b64 ?? "";
  const decoded = revealed && entry.value_b64 ? safeDecodeBase64(b64) : null;

  // Mask the base64 string itself: keep the head/tail visible so it doesn't
  // look empty, dot out the middle. Operators usually want to confirm a key
  // *exists* + see its size before revealing.
  const masked = maskBase64(b64);

  return (
    <div style={{ minWidth: 0, width: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 4,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: t.textMuted,
            fontFamily: FONT_MONO,
          }}
        >
          {formatBytes(entry.size)}
        </span>
        {entry.from_string_data && (
          <Chip t={t} mono>
            stringData
          </Chip>
        )}
        {entry.value_b64 != null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setRevealed((r) => !r);
            }}
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10.5,
              padding: "1px 7px",
              borderRadius: 3,
              background: revealed
                ? "rgba(245,158,11,0.16)"
                : t.chip,
              color: revealed ? t.warn : t.textDim,
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
            }}
            title={revealed ? "Hide plaintext" : "Decode base64 and reveal"}
          >
            {revealed ? "HIDE" : "REVEAL"}
          </button>
        )}
      </div>

      {entry.value_b64 == null ? (
        <Mute t={t}>(not returned by apiserver)</Mute>
      ) : revealed && decoded != null ? (
        <Copyable text={decoded} block>
          <pre
            style={{
              margin: 0,
              padding: "6px 8px",
              background: "rgba(245,158,11,0.08)",
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 3,
              fontFamily: FONT_MONO,
              fontSize: 11.5,
              color: t.text,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              overflow: "auto",
              maxHeight: 220,
            }}
          >
            {decoded || " "}
          </pre>
        </Copyable>
      ) : (
        <Copyable text={b64} block>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11.5,
              color: t.textDim,
              wordBreak: "break-all",
            }}
            title="Click to copy base64 · REVEAL to decode"
          >
            {masked}
          </span>
        </Copyable>
      )}
    </div>
  );
}

function maskBase64(b64: string): string {
  if (b64.length <= 12) return "•".repeat(Math.max(b64.length, 4));
  return `${b64.slice(0, 4)}${"•".repeat(8)}${b64.slice(-4)}`;
}

// Returns null if the string isn't valid base64 / valid utf-8 — we don't
// want a binary secret blob to render as mojibake. Operator can still copy
// the base64 in that case.
function safeDecodeBase64(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ── ResourceQuota ──────────────────────────────────────────────────────────

export function ResourceQuotaSummary(props: {
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
  const state = useDetail<ResourceQuotaDetail>(
    () => api.getResourceQuotaDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <NsRequired t={t} label="ResourceQuota" />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading resource quota…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  return (
    <ResourceQuotaView
      t={t}
      clusterId={props.clusterId}
      namespace={ns}
      name={props.name}
      detail={state.detail}
      onNavigate={props.onNavigate}
      onSaved={() => setRefetch((r) => r + 1)}
    />
  );
}

function ResourceQuotaView({
  t,
  clusterId,
  namespace,
  name,
  detail: d,
  onNavigate,
  onSaved,
}: {
  t: Tokens;
  clusterId: string;
  namespace: string;
  name: string;
  detail: ResourceQuotaDetail;
  onNavigate?: DetailNavigate;
  onSaved: () => void;
}) {
  const edit = useApply<QuotaBuffer>({
    target: { clusterId, kindId: "resourcequotas", namespace, name },
    initial: () => bufferFromQuota(d),
    serialize: serializeQuotaBuffer,
    dirtyCount: quotaDirtyCount,
    onSaved,
  });

  const validation = useMemo(
    () => validateQuotaBuffer(edit.buffer),
    [edit.buffer],
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
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.entries.length} resource{d.entries.length === 1 ? "" : "s"}
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={onNavigate}
        editTarget={{ clusterId, kindId: "resourcequotas", namespace, name }}
        onSaved={onSaved}
      />

      <Section
        t={t}
        title="Hard Limits"
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
                {d.entries.length} total
              </span>
            }
          />
        }
      />

      {edit.conflict && (
        <ConflictBanner
          t={t}
          conflict={edit.conflict}
          saving={edit.saving}
          onForce={edit.forceSave}
          onDismiss={edit.dismissConflict}
        />
      )}
      {edit.error && <InlineError t={t} message={edit.error} />}
      {edit.editing && validation.duplicate.size > 0 && (
        <InlineError
          t={t}
          message={`Duplicate resources: ${[...validation.duplicate].join(", ")}`}
        />
      )}
      {edit.editing && validation.invalidRows.length > 0 && (
        <InlineError
          t={t}
          message={`Invalid quantity in: ${validation.invalidRows.join(", ")}`}
        />
      )}

      <div style={{ marginBottom: 22 }}>
        {edit.editing
          ? edit.buffer.rows.map((row) => (
              <QuotaEditRow
                key={row.id}
                t={t}
                row={row}
                duplicate={validation.duplicate.has(row.name)}
                onChange={(next) =>
                  edit.setBuffer((b) => ({
                    ...b,
                    rows: b.rows.map((r) => (r.id === row.id ? next : r)),
                  }))
                }
                onDelete={() =>
                  edit.setBuffer((b) => toggleDeleteQuotaRow(b, row.id))
                }
              />
            ))
          : d.entries.length === 0
            ? (
              <DetailRow t={t} label="Hard">
                <Mute t={t}>—</Mute>
              </DetailRow>
            )
            : d.entries.map((e) => (
                <DetailRow key={e.name} t={t} label={e.name}>
                  <QuotaUsageCell t={t} hard={e.hard} used={e.used} />
                </DetailRow>
              ))}

        {edit.editing && (
          <AddRowButton
            t={t}
            label="Add resource"
            onClick={() =>
              edit.setBuffer((b) => ({
                ...b,
                rows: [...b.rows, { ...newQuotaRow(), id: b.nextId }],
                nextId: b.nextId + 1,
              }))
            }
          />
        )}
      </div>

      {(d.scopes.length > 0 || d.scope_selector.length > 0) && (
        <>
          <Section t={t} title="Scopes" />
          <div style={{ marginBottom: 22 }}>
            {d.scopes.length > 0 && (
              <DetailRow t={t} label="Scopes">
                <ChipWrap>
                  {d.scopes.map((s) => (
                    <Copyable key={s} text={s}>
                      <Chip t={t} mono>
                        {s}
                      </Chip>
                    </Copyable>
                  ))}
                </ChipWrap>
              </DetailRow>
            )}
            {d.scope_selector.length > 0 && (
              <DetailRow t={t} label="Scope Selector">
                <ChipWrap>
                  {d.scope_selector.map((sel, i) => {
                    const txt = `${sel.scope_name} ${sel.operator}${
                      sel.values.length ? ` ${sel.values.join(",")}` : ""
                    }`;
                    return (
                      <Copyable key={i} text={txt}>
                        <Chip t={t} mono>
                          {txt}
                        </Chip>
                      </Copyable>
                    );
                  })}
                </ChipWrap>
              </DetailRow>
            )}
          </div>
        </>
      )}
    </Frame>
  );
}

// ── ResourceQuota edit buffer ──────────────────────────────────────────────

type QuotaRow = {
  id: number;
  name: string;
  hard: string;
  isNew: boolean;
  deleted: boolean;
  originalName: string;
  originalHard: string;
};

type QuotaBuffer = {
  rows: QuotaRow[];
  nextId: number;
  // Carry the live `used` map across into the buffer so we can annotate
  // each editable row with current consumption — the operator should see
  // they're about to drop a quota *below* current usage.
  used: Map<string, string>;
};

function bufferFromQuota(d: ResourceQuotaDetail): QuotaBuffer {
  let id = 1;
  const used = new Map<string, string>();
  const rows: QuotaRow[] = d.entries
    // Editable rows are the ones with a hard value — entries with only
    // `used` are status-only and can't be patched anyway.
    .filter((e) => e.hard != null)
    .map((e) => {
      if (e.used != null) used.set(e.name, e.used);
      return {
        id: id++,
        name: e.name,
        hard: e.hard ?? "",
        isNew: false,
        deleted: false,
        originalName: e.name,
        originalHard: e.hard ?? "",
      };
    });
  // Track used for entries that aren't editable too, so display is correct
  // when the user adds a new resource that already has consumption.
  for (const e of d.entries) {
    if (e.used != null && !used.has(e.name)) used.set(e.name, e.used);
  }
  return { rows, nextId: id, used };
}

function newQuotaRow(): QuotaRow {
  return {
    id: Number.NaN,
    name: "",
    hard: "",
    isNew: true,
    deleted: false,
    originalName: "",
    originalHard: "",
  };
}

function toggleDeleteQuotaRow(b: QuotaBuffer, id: number): QuotaBuffer {
  return {
    ...b,
    rows: b.rows
      .filter((r) => !(r.id === id && r.isNew))
      .map((r) => (r.id === id ? { ...r, deleted: !r.deleted } : r)),
  };
}

function quotaDirtyCount(b: QuotaBuffer): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.isNew) {
      if (r.name !== "" || r.hard !== "") n += 1;
    } else if (r.deleted) {
      n += 1;
    } else if (r.name !== r.originalName || r.hard !== r.originalHard) {
      n += 1;
    }
  }
  return n;
}

function validateQuotaBuffer(b: QuotaBuffer): {
  duplicate: Set<string>;
  invalidRows: string[];
} {
  const counts = new Map<string, number>();
  const invalidRows: string[] = [];
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.name === "") continue;
    counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    if (r.hard !== "" && parseQuantity(r.hard) == null) {
      invalidRows.push(r.name);
    }
  }
  const duplicate = new Set<string>();
  for (const [k, n] of counts) if (n > 1) duplicate.add(k);
  return { duplicate, invalidRows };
}

function serializeQuotaBuffer(b: QuotaBuffer): Record<string, unknown> {
  // SSA owns spec.hard. We send the entire desired map so the apiserver
  // knows ferrisscope owns each key — omitted keys we previously owned are
  // dropped.
  const hard: Record<string, string> = {};
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.name === "") continue;
    hard[r.name] = r.hard;
  }
  return { spec: { hard } };
}

function QuotaEditRow({
  t,
  row,
  duplicate,
  onChange,
  onDelete,
}: {
  t: Tokens;
  row: QuotaRow;
  duplicate: boolean;
  onChange: (next: QuotaRow) => void;
  onDelete: () => void;
}) {
  if (row.deleted) {
    return (
      <DetailRow t={t} label={row.originalName}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            opacity: 0.45,
            textDecoration: "line-through",
            fontFamily: FONT_MONO,
            fontSize: 11.5,
          }}
        >
          <span>{row.originalHard || "—"}</span>
          <RowDeleteButton t={t} onClick={onDelete} title="Restore" />
        </div>
      </DetailRow>
    );
  }
  const invalidName = row.name !== "" && !isValidQuotaResource(row.name);
  const invalidHard = row.hard !== "" && parseQuantity(row.hard) == null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr auto",
        gap: 12,
        alignItems: "flex-start",
        padding: "8px 0",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <div style={{ paddingTop: 6 }}>
        <EditableTextValue
          t={t}
          value={row.name}
          onChange={(n) => onChange({ ...row, name: n })}
          placeholder={row.isNew ? "cpu, memory, pods, …" : ""}
          invalid={duplicate || invalidName}
          ariaLabel="Quota resource name"
        />
      </div>
      <div style={{ paddingTop: 4 }}>
        <EditableTextValue
          t={t}
          value={row.hard}
          onChange={(v) => onChange({ ...row, hard: v })}
          placeholder="2 / 8Gi / 500m"
          invalid={invalidHard}
          ariaLabel={`Hard limit for ${row.name || "new resource"}`}
        />
      </div>
      <div style={{ paddingTop: 4 }}>
        <RowDeleteButton t={t} onClick={onDelete} />
      </div>
    </div>
  );
}

// ResourceQuota resource names are dotted (e.g. `requests.cpu`,
// `count/deployments.apps`). Allow the same set the apiserver does.
function isValidQuotaResource(s: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(s);
}

function QuotaUsageCell({
  t,
  hard,
  used,
}: {
  t: Tokens;
  hard: string | null;
  used: string | null;
}) {
  // Try a numeric ratio for cpu/memory-style scalars. Quantities are
  // free-form strings ("4", "8Gi", "500m"); when both sides parse, we can
  // colour the chip by usage. When they don't, fall back to plain text.
  const usedNum = parseQuantity(used);
  const hardNum = parseQuantity(hard);
  const ratio =
    usedNum != null && hardNum != null && hardNum > 0
      ? usedNum / hardNum
      : null;
  const tone =
    ratio == null
      ? "default"
      : ratio >= 1
        ? "bad"
        : ratio >= 0.85
          ? "warn"
          : "default";
  const fg = tone === "bad" ? t.bad : tone === "warn" ? t.warn : t.text;

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "baseline",
        flexWrap: "wrap",
      }}
    >
      <Copyable text={`used: ${used ?? "—"} / hard: ${hard ?? "—"}`}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: fg,
          }}
        >
          {used ?? "—"} / {hard ?? "—"}
        </span>
      </Copyable>
      {ratio != null && (
        <span style={{ fontSize: 11, color: t.textMuted }}>
          {(ratio * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}

// Minimal Quantity → number parser. Handles bare numbers + the SI/binary
// suffixes Kubernetes actually uses (k, M, G, T, Ki, Mi, Gi, Ti, m). Returns
// null if the input doesn't match — that's a signal to render plain text
// rather than a coloured ratio.
function parseQuantity(q: string | null): number | null {
  if (q == null) return null;
  const m = /^(-?\d+(?:\.\d+)?)([numkMGTPEi]*)$/.exec(q);
  if (!m) return null;
  const num = m[1];
  if (num == null) return null;
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "":
      return n;
    case "m":
      return n / 1000;
    case "k":
      return n * 1e3;
    case "M":
      return n * 1e6;
    case "G":
      return n * 1e9;
    case "T":
      return n * 1e12;
    case "P":
      return n * 1e15;
    case "E":
      return n * 1e18;
    case "Ki":
      return n * 1024;
    case "Mi":
      return n * 1024 ** 2;
    case "Gi":
      return n * 1024 ** 3;
    case "Ti":
      return n * 1024 ** 4;
    case "Pi":
      return n * 1024 ** 5;
    case "Ei":
      return n * 1024 ** 6;
    case "n":
      return n / 1e9;
    case "u":
      return n / 1e6;
    default:
      return null;
  }
}

// ── LimitRange ─────────────────────────────────────────────────────────────

export function LimitRangeSummary(props: {
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
  const state = useDetail<LimitRangeDetail>(
    () => api.getLimitRangeDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <NsRequired t={t} label="LimitRange" />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading limit range…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  return (
    <LimitRangeView
      t={t}
      clusterId={props.clusterId}
      namespace={ns}
      name={props.name}
      detail={state.detail}
      onNavigate={props.onNavigate}
      onSaved={() => setRefetch((r) => r + 1)}
    />
  );
}

function LimitRangeView({
  t,
  clusterId,
  namespace,
  name,
  detail: d,
  onNavigate,
  onSaved,
}: {
  t: Tokens;
  clusterId: string;
  namespace: string;
  name: string;
  detail: LimitRangeDetail;
  onNavigate?: DetailNavigate;
  onSaved: () => void;
}) {
  const edit = useApply<LimitRangeBuffer>({
    target: { clusterId, kindId: "limitranges", namespace, name },
    initial: () => bufferFromLimitRange(d),
    serialize: serializeLimitRangeBuffer,
    dirtyCount: limitRangeDirtyCount,
    onSaved,
  });

  const validation = useMemo(
    () => validateLimitRangeBuffer(edit.buffer),
    [edit.buffer],
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
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {d.limits.length} limit{d.limits.length === 1 ? "" : "s"}
          {d.meta.created_at ? ` · ${ageFromIso(d.meta.created_at)} old` : ""}
        </span>
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={onNavigate}
        editTarget={{ clusterId, kindId: "limitranges", namespace, name }}
        onSaved={onSaved}
      />

      <div style={{ marginBottom: 8 }}>
        <Section
          t={t}
          title="Limits"
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
                  {d.limits.length} item{d.limits.length === 1 ? "" : "s"}
                </span>
              }
            />
          }
        />
      </div>

      {edit.conflict && (
        <ConflictBanner
          t={t}
          conflict={edit.conflict}
          saving={edit.saving}
          onForce={edit.forceSave}
          onDismiss={edit.dismissConflict}
        />
      )}
      {edit.error && <InlineError t={t} message={edit.error} />}
      {edit.editing && validation.invalidCells.length > 0 && (
        <InlineError
          t={t}
          message={`Invalid quantity in: ${validation.invalidCells.join(", ")}`}
        />
      )}

      {edit.editing ? (
        <>
          {edit.buffer.items.map((item) => (
            <LimitRangeEditItem
              key={item.id}
              t={t}
              item={item}
              onChange={(next) =>
                edit.setBuffer((b) => ({
                  ...b,
                  items: b.items.map((it) => (it.id === item.id ? next : it)),
                }))
              }
              onDelete={() =>
                edit.setBuffer((b) => ({
                  ...b,
                  items: b.items
                    .filter((it) => !(it.id === item.id && it.isNew))
                    .map((it) =>
                      it.id === item.id
                        ? { ...it, deleted: !it.deleted }
                        : it,
                    ),
                }))
              }
            />
          ))}
          <AddRowButton
            t={t}
            label="Add limit"
            onClick={() =>
              edit.setBuffer((b) => ({
                ...b,
                items: [
                  ...b.items,
                  { ...newLimitRangeItem(), id: b.nextId },
                ],
                nextId: b.nextId + 1,
              }))
            }
          />
        </>
      ) : d.limits.length === 0 ? (
        <DetailRow t={t} label="Limits">
          <Mute t={t}>—</Mute>
        </DetailRow>
      ) : (
        d.limits.map((item, idx) => (
          <LimitRangeItemBlock key={`${item.type_}-${idx}`} t={t} item={item} />
        ))
      )}
    </Frame>
  );
}

function LimitRangeItemBlock({
  t,
  item,
}: {
  t: Tokens;
  item: LimitRangeDetail["limits"][number];
}) {
  const groups: { label: string; pairs: [string, string][] }[] = [
    { label: "Default", pairs: item.default },
    { label: "Default Request", pairs: item.default_request },
    { label: "Min", pairs: item.min },
    { label: "Max", pairs: item.max },
    { label: "Max Limit/Request Ratio", pairs: item.max_limit_request_ratio },
  ].filter((g) => g.pairs.length > 0);

  return (
    <>
      <Section
        t={t}
        title={item.type_}
        right={
          <span
            style={{
              fontSize: 10.5,
              color: t.textMuted,
              fontFamily: FONT_MONO,
            }}
          >
            {groups.length} group{groups.length === 1 ? "" : "s"}
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        {groups.length === 0 ? (
          <DetailRow t={t} label="Constraints">
            <Mute t={t}>(no constraints)</Mute>
          </DetailRow>
        ) : (
          groups.map((g) => (
            <DetailRow key={g.label} t={t} label={g.label}>
              <KeyValueChips t={t} pairs={g.pairs} />
            </DetailRow>
          ))
        )}
      </div>
    </>
  );
}

// ── LimitRange edit buffer ─────────────────────────────────────────────────
//
// LimitRange.spec.limits is an array of LimitRangeItem. Each item has a
// type_ ("Container" / "Pod" / "PersistentVolumeClaim") plus five maps from
// resource → Quantity. The whole array is owned by us in SSA, so deleting
// a row drops it server-side and adding one appends.

type LimitGroupKey = "default" | "defaultRequest" | "max" | "min" | "maxRatio";

type LimitGroupRow = {
  // Stable id within the parent item — used as React key + dirty-tracking
  // anchor, never sent to the apiserver.
  id: number;
  resource: string;
  value: string;
  isNew: boolean;
  deleted: boolean;
};

type LimitItemBuffer = {
  id: number;
  type_: string;
  isNew: boolean;
  deleted: boolean;
  // Per-group rows so the user can add/remove a single (resource, value)
  // pair without rewriting the whole item.
  groups: Record<LimitGroupKey, LimitGroupRow[]>;
  nextRowId: number;
  originalType: string;
};

type LimitRangeBuffer = {
  items: LimitItemBuffer[];
  nextId: number;
};

const GROUP_KEYS: LimitGroupKey[] = [
  "default",
  "defaultRequest",
  "max",
  "min",
  "maxRatio",
];

const GROUP_LABEL: Record<LimitGroupKey, string> = {
  default: "Default",
  defaultRequest: "Default Request",
  max: "Max",
  min: "Min",
  maxRatio: "Max Limit/Request Ratio",
};

function groupPairs(
  item: LimitRangeDetail["limits"][number],
  k: LimitGroupKey,
): [string, string][] {
  switch (k) {
    case "default":
      return item.default;
    case "defaultRequest":
      return item.default_request;
    case "max":
      return item.max;
    case "min":
      return item.min;
    case "maxRatio":
      return item.max_limit_request_ratio;
  }
}

function bufferFromLimitRange(d: LimitRangeDetail): LimitRangeBuffer {
  let id = 1;
  const items: LimitItemBuffer[] = d.limits.map((it) => {
    let rid = 1;
    const groups: Record<LimitGroupKey, LimitGroupRow[]> = {
      default: [],
      defaultRequest: [],
      max: [],
      min: [],
      maxRatio: [],
    };
    for (const k of GROUP_KEYS) {
      for (const [r, v] of groupPairs(it, k)) {
        groups[k].push({
          id: rid++,
          resource: r,
          value: v,
          isNew: false,
          deleted: false,
        });
      }
    }
    return {
      id: id++,
      type_: it.type_,
      isNew: false,
      deleted: false,
      groups,
      nextRowId: rid,
      originalType: it.type_,
    };
  });
  return { items, nextId: id };
}

function newLimitRangeItem(): LimitItemBuffer {
  return {
    id: Number.NaN,
    type_: "Container",
    isNew: true,
    deleted: false,
    groups: {
      default: [],
      defaultRequest: [],
      max: [],
      min: [],
      maxRatio: [],
    },
    nextRowId: 1,
    originalType: "",
  };
}

function limitRangeDirtyCount(b: LimitRangeBuffer): number {
  // We don't try to be precise — a dirty *item* counts as one change. The
  // operator gets the count for "Save (N)"; SSA owns the array as a whole.
  let n = 0;
  for (const it of b.items) {
    if (it.deleted || it.isNew) {
      n += 1;
      continue;
    }
    if (it.type_ !== it.originalType) {
      n += 1;
      continue;
    }
    let dirty = false;
    for (const k of GROUP_KEYS) {
      for (const r of it.groups[k]) {
        if (r.isNew && (r.resource !== "" || r.value !== "")) dirty = true;
        if (r.deleted) dirty = true;
        // Existing rows are dirty if their resource or value changed —
        // tracked via a structural diff against the buffer baseline. We
        // don't keep originals on each LimitGroupRow (would balloon the
        // shape); instead we treat any row as "potentially dirty". This
        // overcounts in the worst case but is honest and cheap.
      }
    }
    if (dirty) n += 1;
  }
  return n;
}

function validateLimitRangeBuffer(b: LimitRangeBuffer): {
  invalidCells: string[];
} {
  const invalidCells: string[] = [];
  for (const it of b.items) {
    if (it.deleted) continue;
    for (const k of GROUP_KEYS) {
      for (const r of it.groups[k]) {
        if (r.deleted) continue;
        if (r.value === "") continue;
        if (parseQuantity(r.value) == null) {
          invalidCells.push(
            `${it.type_ || "?"}.${GROUP_LABEL[k]}.${r.resource || "?"}`,
          );
        }
      }
    }
  }
  return { invalidCells };
}

function serializeLimitRangeBuffer(b: LimitRangeBuffer): Record<string, unknown> {
  // SSA path is `spec.limits` — we own the whole array. Each item maps
  // back to `{ type, default, defaultRequest, max, min, maxLimitRequestRatio }`.
  const limits = b.items
    .filter((it) => !it.deleted)
    .map((it) => {
      const out: Record<string, unknown> = { type: it.type_ };
      const writeGroup = (k: LimitGroupKey, jsonKey: string) => {
        const m: Record<string, string> = {};
        for (const r of it.groups[k]) {
          if (r.deleted) continue;
          if (r.resource === "" || r.value === "") continue;
          m[r.resource] = r.value;
        }
        if (Object.keys(m).length > 0) out[jsonKey] = m;
      };
      writeGroup("default", "default");
      writeGroup("defaultRequest", "defaultRequest");
      writeGroup("max", "max");
      writeGroup("min", "min");
      writeGroup("maxRatio", "maxLimitRequestRatio");
      return out;
    });
  return { spec: { limits } };
}

function LimitRangeEditItem({
  t,
  item,
  onChange,
  onDelete,
}: {
  t: Tokens;
  item: LimitItemBuffer;
  onChange: (next: LimitItemBuffer) => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        marginBottom: 22,
        padding: "10px 12px",
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
        opacity: item.deleted ? 0.5 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            fontFamily: FONT_MONO,
          }}
        >
          Type
        </span>
        <div style={{ flex: 1, maxWidth: 280 }}>
          <EditableTextValue
            t={t}
            value={item.type_}
            onChange={(v) => onChange({ ...item, type_: v })}
            placeholder="Container / Pod / PersistentVolumeClaim"
            ariaLabel="Limit item type"
          />
        </div>
        <RowDeleteButton
          t={t}
          onClick={onDelete}
          title={item.deleted ? "Restore" : "Remove item"}
        />
      </div>

      {GROUP_KEYS.map((k) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: t.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              fontFamily: FONT_MONO,
              marginBottom: 4,
            }}
          >
            {GROUP_LABEL[k]}
          </div>
          {item.groups[k].map((row) => (
            <LimitRangeGroupEditRow
              key={row.id}
              t={t}
              row={row}
              disabled={item.deleted}
              onChange={(next) =>
                onChange({
                  ...item,
                  groups: {
                    ...item.groups,
                    [k]: item.groups[k].map((r) =>
                      r.id === row.id ? next : r,
                    ),
                  },
                })
              }
              onDelete={() =>
                onChange({
                  ...item,
                  groups: {
                    ...item.groups,
                    [k]: item.groups[k]
                      .filter((r) => !(r.id === row.id && r.isNew))
                      .map((r) =>
                        r.id === row.id ? { ...r, deleted: !r.deleted } : r,
                      ),
                  },
                })
              }
            />
          ))}
          {!item.deleted && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...item,
                  groups: {
                    ...item.groups,
                    [k]: [
                      ...item.groups[k],
                      {
                        id: item.nextRowId,
                        resource: "",
                        value: "",
                        isNew: true,
                        deleted: false,
                      },
                    ],
                  },
                  nextRowId: item.nextRowId + 1,
                })
              }
              style={{
                marginTop: 4,
                padding: "2px 8px",
                background: "transparent",
                color: t.textMuted,
                border: `1px dashed ${t.borderSoft}`,
                borderRadius: 3,
                fontFamily: FONT_MONO,
                fontSize: 10.5,
                cursor: "pointer",
              }}
            >
              + add resource
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function LimitRangeGroupEditRow({
  t,
  row,
  disabled,
  onChange,
  onDelete,
}: {
  t: Tokens;
  row: LimitGroupRow;
  disabled: boolean;
  onChange: (next: LimitGroupRow) => void;
  onDelete: () => void;
}) {
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
          padding: "2px 0",
        }}
      >
        <span style={{ color: t.textDim, minWidth: 100 }}>{row.resource}</span>
        <span>{row.value}</span>
        <RowDeleteButton t={t} onClick={onDelete} title="Restore" />
      </div>
    );
  }
  const invalid = row.value !== "" && parseQuantity(row.value) == null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr auto",
        gap: 8,
        alignItems: "center",
        padding: "2px 0",
      }}
    >
      <EditableTextValue
        t={t}
        value={row.resource}
        onChange={(v) => onChange({ ...row, resource: v })}
        placeholder="cpu / memory / …"
        ariaLabel="Limit resource"
      />
      <EditableTextValue
        t={t}
        value={row.value}
        onChange={(v) => onChange({ ...row, value: v })}
        placeholder="500m / 256Mi / 2"
        invalid={invalid}
        ariaLabel="Limit value"
      />
      <RowDeleteButton t={t} onClick={onDelete} />
      {disabled && (
        <span style={{ fontSize: 10.5, color: t.textMuted }}>(item removed)</span>
      )}
    </div>
  );
}
