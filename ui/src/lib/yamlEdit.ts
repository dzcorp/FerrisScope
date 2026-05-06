// Helpers for the manifest-editor YAML tab.
//
// Two responsibilities:
//   • `stripServerFields` — remove fields the apiserver writes back so the
//     operator sees source-like YAML (no managedFields noise, no status).
//   • `diffPartial` — compute the minimal partial-object subtree the user
//     actually changed, so SSA only takes ownership of touched fields.
//
// SSA caveat: dropping a key from the edited document does NOT request
// deletion — it just declines ownership. Adds and modifications work as
// expected; explicit removal is out of scope for v1 of this editor and
// surfaced via `diffHasOnlyDeletions` so the UI can warn.

import jsYaml from "js-yaml";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

const META_STRIP_KEYS = new Set([
  "managedFields",
  "resourceVersion",
  "uid",
  "generation",
  "creationTimestamp",
  "deletionTimestamp",
  "deletionGracePeriodSeconds",
  "selfLink",
]);

// Annotations the apiserver / kubectl write back that aren't useful for
// the operator to read or edit. `last-applied-configuration` is the big
// one — it's a JSON dump of the last `kubectl apply` payload, sometimes
// kilobytes long, and editing it has no effect (kubectl rewrites it on
// the next apply). Strip it so the YAML tab stays focused on real spec.
const ANNOTATION_STRIP_KEYS = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
]);

export function stripServerFields(doc: Json): Json {
  if (!isObject(doc)) return doc;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "status") continue;
    if (k === "metadata" && isObject(v)) {
      const meta: Record<string, Json> = {};
      for (const [mk, mv] of Object.entries(v)) {
        if (META_STRIP_KEYS.has(mk)) continue;
        if (mk === "annotations" && isObject(mv)) {
          const ann: Record<string, Json> = {};
          for (const [ak, av] of Object.entries(mv)) {
            if (ANNOTATION_STRIP_KEYS.has(ak)) continue;
            ann[ak] = av;
          }
          // Drop the annotations key entirely if everything was filtered
          // out — leaving an empty `{}` would be noise in the YAML.
          if (Object.keys(ann).length > 0) meta[mk] = ann;
          continue;
        }
        meta[mk] = mv;
      }
      out[k] = meta;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function parseYaml(text: string): Json {
  const v = jsYaml.load(text);
  return (v ?? null) as Json;
}

export function dumpYaml(value: Json): string {
  return jsYaml.dump(value, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

export function stripYaml(text: string): string {
  return dumpYaml(stripServerFields(parseYaml(text)));
}

// Result of diffing original vs edited stripped JSON.
export type DiffResult = {
  // Minimal partial-object subtree containing only modified or added paths.
  // Suitable as `fields` for apply_resource_cmd. Empty object if nothing
  // changed.
  partial: Record<string, Json>;
  // True if the diff is a no-op (semantically equal documents).
  empty: boolean;
  // True if the operator's only changes are key removals — none of which
  // can be expressed via this SSA partial-tree approach. The UI surfaces a
  // warning so the operator isn't confused when Save appears to do nothing.
  onlyDeletions: boolean;
  // Number of touched paths — drives the "Save (N)" chip.
  count: number;
};

// Strip identity fields the backend re-attaches itself — we don't want to
// claim ownership of `apiVersion`, `kind`, `metadata.name`,
// `metadata.namespace` even if Monaco round-trips them unchanged.
const IDENTITY_KEYS = new Set(["apiVersion", "kind"]);
const META_IDENTITY_KEYS = new Set(["name", "namespace"]);

function stripIdentity(doc: Json): Json {
  if (!isObject(doc)) return doc;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (IDENTITY_KEYS.has(k)) continue;
    if (k === "metadata" && isObject(v)) {
      const meta: Record<string, Json> = {};
      for (const [mk, mv] of Object.entries(v)) {
        if (META_IDENTITY_KEYS.has(mk)) continue;
        meta[mk] = mv;
      }
      if (Object.keys(meta).length > 0) out[k] = meta;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function diffPartial(originalRaw: Json, editedRaw: Json): DiffResult {
  const original = stripIdentity(originalRaw);
  const edited = stripIdentity(editedRaw);

  const stats = { changed: 0, deletions: 0 };
  const partial = walkDiff(original, edited, stats);
  const obj: Record<string, Json> =
    partial !== UNCHANGED && isObject(partial) ? partial : {};
  const empty = stats.changed === 0 && stats.deletions === 0;
  const onlyDeletions = stats.changed === 0 && stats.deletions > 0;
  return {
    partial: obj,
    empty,
    onlyDeletions,
    count: stats.changed,
  };
}

// Walk both trees together. Returns the minimal subtree of `edited` that
// represents adds + modifications relative to `original`. Returns the
// sentinel `UNCHANGED` when nothing changed in this subtree.
const UNCHANGED: unique symbol = Symbol("unchanged");
type WalkResult = Json | typeof UNCHANGED;

function walkDiff(
  original: Json,
  edited: Json,
  stats: { changed: number; deletions: number },
): WalkResult {
  if (deepEqual(original, edited)) return UNCHANGED;

  // Object × object → per-key diff.
  if (isObject(original) && isObject(edited)) {
    const out: Record<string, Json> = {};
    let touched = 0;
    for (const [k, v] of Object.entries(edited)) {
      if (!(k in original)) {
        // New key.
        out[k] = v;
        stats.changed += 1;
        touched += 1;
        continue;
      }
      const sub = walkDiff(original[k]!, v, stats);
      if (sub !== UNCHANGED) {
        out[k] = sub;
        touched += 1;
      }
    }
    // Track removed keys for the "only deletions" warning. They don't go
    // into `out` — SSA partial trees can't express deletion this way.
    for (const k of Object.keys(original)) {
      if (!(k in edited)) stats.deletions += 1;
    }
    return touched === 0 ? UNCHANGED : out;
  }

  // Anything else (scalar change, array change, type change): the leaf is
  // the new value as-is. Arrays are replaced wholesale because we don't
  // know each list's `listType` (map / set / atomic) without the schema.
  stats.changed += 1;
  return edited;
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i]!, b[i]!)) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in b)) return false;
      if (!deepEqual(a[k]!, b[k]!)) return false;
    }
    return true;
  }
  return false;
}

function isObject(v: Json): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
