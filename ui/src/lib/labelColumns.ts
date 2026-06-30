// Custom table columns derived from a resource's `metadata.labels`.
//
// Labels already ride on every row as `row.__labels` (watcher-injected). A
// "label column" is a synthetic, frontend-only `ColumnDef` that reads its
// value from that map instead of a top-level projected field. The chosen
// keys persist per (scope, kind) inside `TableView.label_columns`.
//
// These helpers are pure so the table wiring and the column-picker menu can
// share them and they can be unit-tested without rendering.

import type { ColumnDef, ResourceRow } from "../types";

// Prefix that namespaces a label column's stable `id` so it can never
// collide with a backend-projected column id (which are plain field names
// like `name` / `namespace` / `cpu`).
export const LABEL_COL_PREFIX = "label:";

/** Stable column id for a label key. */
export function labelColumnId(key: string): string {
  return `${LABEL_COL_PREFIX}${key}`;
}

/** Whether a column id refers to a synthetic label column. */
export function isLabelColumnId(id: string): boolean {
  return id.startsWith(LABEL_COL_PREFIX);
}

/**
 * Header text for a label column. Kubernetes label keys are usually
 * `prefix/name` (`topology.kubernetes.io/zone`); the segment after the last
 * `/` is the human-meaningful part, so we show that and fall back to the
 * whole key when there's no prefix or the tail is empty.
 */
export function labelColumnHeader(key: string): string {
  const slash = key.lastIndexOf("/");
  const tail = slash >= 0 ? key.slice(slash + 1) : key;
  return tail || key;
}

/** Build the synthetic `ColumnDef` for a label key. */
export function labelColumnDef(key: string): ColumnDef {
  return {
    id: labelColumnId(key),
    header: labelColumnHeader(key),
    kind: "text",
    labelKey: key,
  };
}

/**
 * All distinct label keys present across `rows`, sorted ascending. Sampled
 * to bound cost on large tables — within a single kind the set of label keys
 * is near-uniform across objects, so a sample surfaces the real universe.
 */
export function labelKeyUniverse(rows: ResourceRow[], sampleLimit = 500): string[] {
  const seen = new Set<string>();
  const n = Math.min(rows.length, sampleLimit);
  for (let i = 0; i < n; i++) {
    const labels = rows[i]?.__labels;
    if (labels) {
      for (const k of Object.keys(labels)) seen.add(k);
    }
  }
  return [...seen].sort();
}

/**
 * Splice custom label columns in just before the trailing Age column so Age
 * stays the rightmost column. Anchors on the *last* `age`-kind column (some
 * kinds carry an earlier age-kind field, e.g. a Lease's "Renewed" — that one
 * keeps its place; only the final "Age" gets the label columns ahead of it).
 * Falls back to appending when the kind has no age column at all.
 */
export function placeLabelColumns(
  cols: ColumnDef[],
  labelCols: ColumnDef[],
): ColumnDef[] {
  if (labelCols.length === 0) return cols;
  let ageIdx = -1;
  for (let i = 0; i < cols.length; i++) {
    if (cols[i]?.kind === "age") ageIdx = i;
  }
  if (ageIdx < 0) return [...cols, ...labelCols];
  return [...cols.slice(0, ageIdx), ...labelCols, ...cols.slice(ageIdx)];
}

/**
 * Header-width floor for auto-fit. Custom label columns return 0 so the
 * column sizes to its values only (the often-longer label-derived header
 * ellipsises); built-in columns return the measured header width so the title
 * stays fully readable.
 */
export function headerWidthFloor(c: ColumnDef, headerWidth: number): number {
  return c.labelKey != null ? 0 : headerWidth;
}

/**
 * Raw cell value for a column: label columns read from `__labels`,
 * everything else from the row's top-level projected field. Single source of
 * truth so sort accessor, cell renderer, and natural-width measurement stay
 * in agreement.
 */
export function cellRaw(c: ColumnDef, row: ResourceRow): unknown {
  if (c.labelKey != null) return row.__labels?.[c.labelKey];
  return row[c.id];
}
