// Flatten a parsed manifest into `path -> displayable value` pairs, so N
// objects can be compared row-by-row without any per-kind knowledge.

import type { Json } from "./yamlEdit";

/// Array keys Kubernetes itself merges by rather than by position — the
/// `x-kubernetes-patch-merge-key` values from the core API. Keying on these
/// makes two otherwise-identical objects compare equal when their list order
/// happens to differ, which positional indices would report as every element
/// differing.
const MERGE_KEYS = ["name", "containerPort", "port", "mountPath", "ip", "key"];

/// Dotted paths, array entries keyed by their Kubernetes merge key where they
/// have one and by index otherwise. Scalars are stringified; an empty object
/// or array is a LEAF (`{}` / `[]`) rather than contributing nothing —
/// otherwise "this field is absent" and "this field is empty" would render
/// identically, which is exactly the distinction a comparison exists to show.
export function flattenFields(doc: Json): Map<string, string> {
  const out = new Map<string, string>();
  walk(doc, "", out);
  return out;
}

function walk(node: Json, path: string, out: Map<string, string>): void {
  if (Array.isArray(node)) {
    if (node.length === 0) {
      if (path) out.set(path, "[]");
      return;
    }
    node.forEach((v, i) => walk(v, `${path}[${arrayKey(v, i)}]`, out));
    return;
  }
  if (node !== null && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.length === 0) {
      if (path) out.set(path, "{}");
      return;
    }
    for (const k of keys) {
      walk(node[k]!, path ? `${path}${segment(k)}` : segment(k, true), out);
    }
    return;
  }
  // A scalar at the root has no path to key on — `parseYaml` returns null for
  // an empty document, so this is reachable whenever a subject's manifest
  // fails to yield an object.
  if (!path) return;
  // A null leaf is meaningful in Kubernetes manifests (an explicitly cleared
  // field differs from an absent one), so it gets a row of its own.
  out.set(path, node === null ? "null" : String(node));
}

/// Identify an array entry by its merge key when it has one, so ordering
/// doesn't masquerade as a difference. Falls back to the index for scalar
/// entries and for lists whose order is the meaning (`command`, `args`).
function arrayKey(entry: Json, index: number): string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return String(index);
  }
  for (const k of MERGE_KEYS) {
    const v = entry[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return String(index);
}

/// Kubernetes keys routinely contain dots — `app.kubernetes.io/name`,
/// annotation keys, `data` entries like `nginx.conf`. Joining those with a
/// bare `.` makes `{a: {b: 1}}` and `{"a.b": 2}` collide onto one row, so one
/// of the two silently vanishes from the comparison. Bracket-quote any
/// segment that isn't a plain identifier.
function segment(key: string, root = false): string {
  const plain = /^[A-Za-z0-9_-]+$/.test(key);
  if (!plain) return `[${JSON.stringify(key)}]`;
  return root ? key : `.${key}`;
}

export type FieldRow = {
  path: string;
  /// One entry per subject, index-aligned with the subject list. `null` means
  /// the subject's document has no value at this path.
  values: (string | null)[];
  differs: boolean;
};

/// Union every subject's paths into comparison rows. A row differs when the
/// values are not all identical — an absent value counts as its own distinct
/// value, so "set here, missing there" is a difference, not a match.
export function buildFieldRows(maps: Map<string, string>[]): FieldRow[] {
  const paths = new Set<string>();
  for (const m of maps) for (const p of m.keys()) paths.add(p);

  return Array.from(paths)
    .sort(comparePaths)
    .map((path) => {
      const values = maps.map((m) => m.get(path) ?? null);
      const first = values[0];
      return { path, values, differs: values.some((v) => v !== first) };
    });
}

/// Sort so numeric array indices order naturally (`[2]` before `[10]`) instead
/// of lexically, which would scatter a long list's entries.
function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
