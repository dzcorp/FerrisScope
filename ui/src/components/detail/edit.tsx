// Reusable inline-edit primitives for detail panels. Kind-agnostic — every
// edit affordance in ConfigMap / Secret / ResourceQuota / LimitRange / Meta
// labels routes through these so the UX is identical everywhere.
//
// Design contract (matches the Phase B agreement in the project tasks):
//
//   • A detail surface flips into edit mode when the user toggles the
//     section's pencil. Edits stay local until Save; Cancel discards them.
//   • Per-row × removes a key; the section's `+ Add` appends a new one.
//   • Save calls `api.applyResource` with a partial-object SSA payload;
//     conflicts surface as a `ConflictBanner` with a "force takeover"
//     button that re-invokes with `force: true`.
//   • The detail watcher on the parent panel bumps `detailVersion` after
//     a successful apply so the read-state refreshes.

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { api } from "../../api";
import { FONT_MONO, type Tokens } from "../../theme";
import { Icons } from "../ui";
import type { ApplyResult } from "../../types";

// ── EditMode header ────────────────────────────────────────────────────────
//
// Drop-in replacement for the `right` slot of <Section>. Renders either:
//   • An "Edit" pencil (when not editing)
//   • Save / Cancel chips + a dirty count (when editing)

export function EditModeChrome({
  t,
  editing,
  dirty,
  saving,
  onEnter,
  onCancel,
  onSave,
  rightExtra,
}: {
  t: Tokens;
  editing: boolean;
  // Number of pending changes — shown next to Save so the operator knows
  // the apply will write more than one row at a time.
  dirty: number;
  saving: boolean;
  onEnter: () => void;
  onCancel: () => void;
  onSave: () => void;
  // Optional content rendered before the edit controls (e.g. "5 total").
  rightExtra?: ReactNode;
}) {
  if (!editing) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {rightExtra}
        <button
          type="button"
          onClick={onEnter}
          title="Edit"
          style={{
            ...iconBtnStyle(t),
            color: t.textDim,
          }}
        >
          {Icons.pencil}
        </button>
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {rightExtra}
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        title="Cancel"
        style={{
          ...chipBtnStyle(t),
          background: t.chip,
          color: t.textDim,
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving || dirty === 0}
        title={dirty === 0 ? "No changes" : `Apply ${dirty} change${dirty === 1 ? "" : "s"}`}
        style={{
          ...chipBtnStyle(t),
          background: dirty === 0 ? t.chip : "rgba(16,185,129,0.16)",
          color: dirty === 0 ? t.textMuted : t.good,
          cursor: dirty === 0 ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "Saving…" : `Save${dirty > 0 ? ` (${dirty})` : ""}`}
      </button>
    </span>
  );
}

function iconBtnStyle(t: Tokens): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: 3,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    color: t.textDim,
    padding: 0,
  };
}

function chipBtnStyle(t: Tokens): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 22,
    padding: "0 8px",
    borderRadius: 3,
    border: "none",
    background: t.chip,
    color: t.textDim,
    fontFamily: FONT_MONO,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.4,
    cursor: "pointer",
    textTransform: "uppercase",
  };
}

// ── RowDeleteButton ────────────────────────────────────────────────────────
// Tiny × icon used inside an edited row's value-side. Marks the row for
// deletion on save (the UI typically also strikes through the value).

export function RowDeleteButton({
  t,
  onClick,
  title = "Remove",
}: {
  t: Tokens;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      style={{
        ...iconBtnStyle(t),
        color: t.textMuted,
        width: 18,
        height: 18,
      }}
    >
      {Icons.close}
    </button>
  );
}

// ── EditableTextValue ──────────────────────────────────────────────────────
// Single-line text input that fits inside a DetailRow value cell. Switches
// to a textarea when `multiline` is true (used for ConfigMap data values).

export function EditableTextValue({
  t,
  value,
  onChange,
  placeholder,
  monospace = true,
  multiline = false,
  invalid = false,
  ariaLabel,
}: {
  t: Tokens;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  monospace?: boolean;
  multiline?: boolean;
  // Renders a red outline so the operator knows a parse / validation error
  // will block save. The owning component is responsible for the validation
  // logic itself.
  invalid?: boolean;
  ariaLabel?: string;
}) {
  const baseStyle: CSSProperties = {
    width: "100%",
    background: t.bg,
    color: t.text,
    fontFamily: monospace ? FONT_MONO : "inherit",
    fontSize: 12,
    border: `1px solid ${invalid ? t.bad : t.borderSoft}`,
    borderRadius: 3,
    padding: "4px 6px",
    outline: "none",
    boxSizing: "border-box",
  };
  if (multiline) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={Math.min(Math.max(2, value.split("\n").length), 12)}
        style={{
          ...baseStyle,
          resize: "vertical",
          minHeight: 56,
          lineHeight: 1.45,
          whiteSpace: "pre",
        }}
      />
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      style={baseStyle}
    />
  );
}

// ── AddRowButton ───────────────────────────────────────────────────────────
// "+ Add key" affordance under a section in edit mode. Renders as a muted
// button that turns into the section's accent on hover.

export function AddRowButton({
  t,
  label,
  onClick,
}: {
  t: Tokens;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginTop: 8,
        padding: "4px 10px",
        background: t.chip,
        color: t.textDim,
        border: `1px dashed ${t.borderSoft}`,
        borderRadius: 3,
        fontFamily: FONT_MONO,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {Icons.plus}
      <span>{label}</span>
    </button>
  );
}

// ── ConflictBanner ─────────────────────────────────────────────────────────
// Renders the SSA conflict response. Operator either takes ownership
// (re-applies with force=true) or cancels and edits manually.

export function ConflictBanner({
  t,
  conflict,
  saving,
  onForce,
  onDismiss,
}: {
  t: Tokens;
  conflict: { managers: string[]; fields: string[]; message: string };
  saving: boolean;
  onForce: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        margin: "0 0 12px",
        padding: "10px 12px",
        background: "rgba(245,158,11,0.12)",
        border: `1px solid rgba(245,158,11,0.4)`,
        borderRadius: 3,
        color: t.text,
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ color: t.warn, fontWeight: 700 }}>Conflict</span>
        <span style={{ color: t.textDim }}>
          {conflict.managers.length > 0
            ? `with ${conflict.managers.join(", ")}`
            : "with another field manager"}
        </span>
      </div>
      {conflict.fields.length > 0 && (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: t.textDim,
            wordBreak: "break-all",
          }}
        >
          {conflict.fields.join(" · ")}
        </div>
      )}
      <div
        style={{
          fontSize: 11.5,
          color: t.textMuted,
          whiteSpace: "pre-wrap",
        }}
      >
        {conflict.message}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={onDismiss}
          disabled={saving}
          style={{
            ...chipBtnStyle(t),
            background: t.chip,
            color: t.textDim,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onForce}
          disabled={saving}
          style={{
            ...chipBtnStyle(t),
            background: "rgba(244,63,94,0.16)",
            color: t.bad,
          }}
        >
          {saving ? "Forcing…" : "Force takeover"}
        </button>
      </div>
    </div>
  );
}

// ── KeyValueEditor ─────────────────────────────────────────────────────────
//
// Generic editor for a flat key→value map (labels, annotations, ConfigMap
// data, Secret data — when the value isn't structured). Owners pass the
// initial pairs + a save handler that knows where to drop them in the SSA
// payload (`metadata.labels`, `metadata.annotations`, etc.).
//
// Identical to the per-kind editors above in spirit, but small enough to
// inline next to MetaSection without forcing each call site to write its
// own buffer + reducer.

export type KvRow = {
  id: number;
  key: string;
  value: string;
  isNew: boolean;
  deleted: boolean;
  originalKey: string;
  originalValue: string;
};

export type KvBuffer = { rows: KvRow[]; nextId: number };

export function kvBufferFromPairs(pairs: [string, string][]): KvBuffer {
  let id = 1;
  return {
    rows: pairs.map(([k, v]) => ({
      id: id++,
      key: k,
      value: v,
      isNew: false,
      deleted: false,
      originalKey: k,
      originalValue: v,
    })),
    nextId: id,
  };
}

export function kvBufferAdd(b: KvBuffer): KvBuffer {
  return {
    rows: [
      ...b.rows,
      {
        id: b.nextId,
        key: "",
        value: "",
        isNew: true,
        deleted: false,
        originalKey: "",
        originalValue: "",
      },
    ],
    nextId: b.nextId + 1,
  };
}

export function kvBufferReplace(
  b: KvBuffer,
  id: number,
  next: Partial<KvRow>,
): KvBuffer {
  return {
    ...b,
    rows: b.rows.map((r) => (r.id === id ? { ...r, ...next } : r)),
  };
}

export function kvBufferToggleDelete(b: KvBuffer, id: number): KvBuffer {
  return {
    ...b,
    rows: b.rows
      .filter((r) => !(r.id === id && r.isNew))
      .map((r) => (r.id === id ? { ...r, deleted: !r.deleted } : r)),
  };
}

export function kvBufferDirty(b: KvBuffer): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.isNew) {
      if (r.key !== "" || r.value !== "") n += 1;
    } else if (r.deleted) {
      n += 1;
    } else if (r.key !== r.originalKey || r.value !== r.originalValue) {
      n += 1;
    }
  }
  return n;
}

export function kvBufferToMap(b: KvBuffer): Record<string, string> {
  // Net result of all live edits — what we actually send to SSA.
  const out: Record<string, string> = {};
  for (const r of b.rows) {
    if (r.deleted) continue;
    if (r.key === "") continue;
    out[r.key] = r.value;
  }
  return out;
}

export function kvBufferDuplicates(b: KvBuffer): Set<string> {
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

// Visual editor for a key-value buffer. Renders one row per pair with
// inline inputs, a × per row, and a + at the bottom. Caller owns the
// buffer state — same shape as the per-kind editors, just named so it can
// be reused at the call site.
export function KvEditor({
  t,
  buffer,
  onChange,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
  duplicates,
  validateKey,
}: {
  t: Tokens;
  buffer: KvBuffer;
  onChange: (next: KvBuffer) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  duplicates?: Set<string>;
  // Optional per-key validator. Returns true when valid.
  validateKey?: (k: string) => boolean;
}) {
  const dup = duplicates ?? kvBufferDuplicates(buffer);
  return (
    <div style={{ width: "100%" }}>
      {buffer.rows.map((row) => {
        if (row.deleted) {
          return (
            <div
              key={row.id}
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
              <span style={{ color: t.textDim }}>
                {row.originalKey}={row.originalValue}
              </span>
              <RowDeleteButton
                t={t}
                onClick={() => onChange(kvBufferToggleDelete(buffer, row.id))}
                title="Restore"
              />
            </div>
          );
        }
        const invalidKey =
          row.key !== "" && validateKey != null && !validateKey(row.key);
        return (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto",
              gap: 6,
              alignItems: "center",
              padding: "2px 0",
            }}
          >
            <EditableTextValue
              t={t}
              value={row.key}
              onChange={(k) => onChange(kvBufferReplace(buffer, row.id, { key: k }))}
              placeholder={keyPlaceholder}
              invalid={dup.has(row.key) || invalidKey}
            />
            <EditableTextValue
              t={t}
              value={row.value}
              onChange={(v) => onChange(kvBufferReplace(buffer, row.id, { value: v }))}
              placeholder={valuePlaceholder}
            />
            <RowDeleteButton
              t={t}
              onClick={() => onChange(kvBufferToggleDelete(buffer, row.id))}
            />
          </div>
        );
      })}
      <AddRowButton
        t={t}
        label="Add"
        onClick={() => onChange(kvBufferAdd(buffer))}
      />
    </div>
  );
}

// ── useApply hook ──────────────────────────────────────────────────────────
//
// One-stop edit lifecycle: holds the buffer, dirty count, save state, and
// conflict surface. Owners pass a `serialize` that turns the current buffer
// into the SSA payload; the hook handles the apply call + conflict
// branching + force re-apply.

export type ApplyTarget = {
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "conflict"; managers: string[]; fields: string[]; message: string }
  | { kind: "error"; message: string };

export function useApply<B>(opts: {
  target: ApplyTarget;
  initial: () => B;
  // Pure function. Returns a partial-object SSA payload (without
  // apiVersion/kind/metadata.name — the backend attaches those). The hook
  // wraps it as the `fields` arg of `apply_resource_cmd`.
  serialize: (buffer: B) => Record<string, unknown>;
  // Count of dirty changes, used for the Save button's "(N)" suffix. Keeps
  // the hook independent of the buffer's internal shape.
  dirtyCount: (buffer: B) => number;
  // Called after a successful (non-conflict) apply. Typically the parent
  // bumps `detailVersion` here to refetch.
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState<B>(opts.initial);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  // Re-seed the buffer on every Edit click so a stale buffer from a prior
  // edit doesn't carry over after the underlying detail changed.
  const initialRef = useRef(opts.initial);
  initialRef.current = opts.initial;

  const enter = useCallback(() => {
    setBuffer(initialRef.current());
    setSave({ kind: "idle" });
    setEditing(true);
  }, []);
  const cancel = useCallback(() => {
    setEditing(false);
    setSave({ kind: "idle" });
  }, []);

  const apply = useCallback(
    async (force: boolean) => {
      setSave({ kind: "saving" });
      try {
        const result: ApplyResult = await api.applyResource(
          opts.target.clusterId,
          opts.target.kindId,
          opts.target.namespace,
          opts.target.name,
          opts.serialize(buffer),
          force,
        );
        if (result.kind === "applied") {
          setEditing(false);
          setSave({ kind: "idle" });
          opts.onSaved();
        } else {
          setSave({
            kind: "conflict",
            managers: result.managers,
            fields: result.fields,
            message: result.message,
          });
        }
      } catch (e) {
        setSave({ kind: "error", message: String(e) });
      }
    },
    // serialize / target / onSaved are read fresh each invocation — buffer
    // is the only value we capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffer, opts.target.clusterId, opts.target.kindId, opts.target.namespace, opts.target.name],
  );

  const dirty = useMemo(() => opts.dirtyCount(buffer), [buffer, opts]);

  return {
    editing,
    buffer,
    setBuffer,
    enter,
    cancel,
    save: () => apply(false),
    forceSave: () => apply(true),
    dirty,
    saving: save.kind === "saving",
    conflict: save.kind === "conflict" ? save : null,
    error: save.kind === "error" ? save.message : null,
    dismissConflict: () => setSave({ kind: "idle" }),
  };
}

// ── ListBuffer / ListEditor ────────────────────────────────────────────────
//
// Generic ordered-list editor for arrays of structured rows (env, ports,
// volumes — anything where the value is a small struct, not a flat key/value).
// Mirrors KvBuffer's lifecycle (id, isNew, deleted, original snapshot for
// dirty detection) but lets the caller define the row shape.
//
// Caller responsibilities:
//   • Provide an `original` snapshot of every existing row so dirty detection
//     can compare against it. New rows have `isNew: true` and no original.
//   • Provide the `renderRow` render-prop — the per-row UI is kind-specific
//     (env's name+value vs port's number+protocol+name vs volume's source
//     selector), so the primitive only owns the chrome (delete button, soft
//     delete, restore, dashed + Add).
//   • Decide what counts as "dirty" for a given row in `isRowDirty` — the
//     primitive can't know which fields matter (e.g. env should ignore the
//     `from` field which is read-only).

export type ListRow<F> = F & {
  id: number;
  isNew: boolean;
  deleted: boolean;
  // Snapshot of the row at buffer init. Null for newly-added rows.
  original: F | null;
};

export type ListBuffer<F> = { rows: ListRow<F>[]; nextId: number };

export function listBufferFrom<F>(items: F[]): ListBuffer<F> {
  let id = 1;
  return {
    rows: items.map((item) => ({
      ...item,
      id: id++,
      isNew: false,
      deleted: false,
      original: { ...item },
    })),
    nextId: id,
  };
}

export function listBufferAdd<F>(b: ListBuffer<F>, blank: F): ListBuffer<F> {
  return {
    rows: [
      ...b.rows,
      {
        ...blank,
        id: b.nextId,
        isNew: true,
        deleted: false,
        original: null,
      },
    ],
    nextId: b.nextId + 1,
  };
}

export function listBufferReplace<F>(
  b: ListBuffer<F>,
  id: number,
  next: Partial<F>,
): ListBuffer<F> {
  return {
    ...b,
    rows: b.rows.map((r) => (r.id === id ? { ...r, ...next } : r)),
  };
}

export function listBufferToggleDelete<F>(
  b: ListBuffer<F>,
  id: number,
): ListBuffer<F> {
  return {
    ...b,
    rows: b.rows
      .filter((r) => !(r.id === id && r.isNew))
      .map((r) => (r.id === id ? { ...r, deleted: !r.deleted } : r)),
  };
}

export function listBufferDirty<F>(
  b: ListBuffer<F>,
  isRowDirty: (current: F, original: F) => boolean,
): number {
  let n = 0;
  for (const r of b.rows) {
    if (r.isNew) {
      // A blank-but-not-yet-filled new row doesn't count as dirty.
      // Each kind decides what "blank" means via isRowDirty against its own
      // identity element — but the simplest rule (and the one we use) is:
      // a new row is dirty if it survives `isRowDirty(current, current)` is
      // false, which is never. So count every isNew that hasn't been
      // soft-deleted as one change.
      n += 1;
    } else if (r.deleted) {
      n += 1;
    } else if (r.original && isRowDirty(r as unknown as F, r.original)) {
      n += 1;
    }
  }
  return n;
}

// Strip the bookkeeping fields and return the live, non-deleted rows in order.
// What you'd write into the SSA payload — the caller's `pickFields` decides
// the output shape (often a renamed / camelCased projection of `F`).
export function listBufferToArray<F, O = F>(
  b: ListBuffer<F>,
  pickFields: (row: ListRow<F>) => O,
): O[] {
  const out: O[] = [];
  for (const r of b.rows) {
    if (r.deleted) continue;
    out.push(pickFields(r));
  }
  return out;
}

// Renders a list of rows with a + Add button at the bottom. Each row is
// drawn via the caller's render-prop, plus the soft-delete × button. Soft-
// deleted rows (existing rows the operator chose to drop) render struck-
// through with a Restore tooltip; new rows are removed entirely.
export function ListEditor<F>({
  t,
  buffer,
  onChange,
  renderRow,
  renderDeletedSummary,
  blank,
  addLabel,
  rowGap = 4,
}: {
  t: Tokens;
  buffer: ListBuffer<F>;
  onChange: (next: ListBuffer<F>) => void;
  // The kind-specific row body (excluding the soft-delete × — the primitive
  // appends that). Must be self-contained: caller wires its own onChange via
  // `listBufferReplace`.
  renderRow: (row: ListRow<F>, onRowChange: (next: Partial<F>) => void) => ReactNode;
  // Tiny one-line render of a deleted row's identity (e.g. "FOO=bar" for env)
  // so the strike-through line still tells the operator what's gone.
  renderDeletedSummary: (row: ListRow<F>) => ReactNode;
  // Identity element for newly-added rows.
  blank: F;
  addLabel: string;
  rowGap?: number;
}) {
  return (
    <div style={{ width: "100%" }}>
      {buffer.rows.map((row) => {
        if (row.deleted) {
          return (
            <div
              key={row.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: 0.45,
                textDecoration: "line-through",
                fontFamily: FONT_MONO,
                fontSize: 11.5,
                padding: `${rowGap}px 0`,
              }}
            >
              <span style={{ color: t.textDim, flex: 1, minWidth: 0 }}>
                {renderDeletedSummary(row)}
              </span>
              <RowDeleteButton
                t={t}
                onClick={() => onChange(listBufferToggleDelete(buffer, row.id))}
                title="Restore"
              />
            </div>
          );
        }
        return (
          <div
            key={row.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: `${rowGap}px 0`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {renderRow(row, (next) =>
                onChange(listBufferReplace(buffer, row.id, next)),
              )}
            </div>
            <RowDeleteButton
              t={t}
              onClick={() => onChange(listBufferToggleDelete(buffer, row.id))}
            />
          </div>
        );
      })}
      <AddRowButton
        t={t}
        label={addLabel}
        onClick={() => onChange(listBufferAdd(buffer, blank))}
      />
    </div>
  );
}
