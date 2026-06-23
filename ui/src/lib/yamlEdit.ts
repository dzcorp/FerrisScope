// Helpers for the manifest-editor YAML tab.
//
// Two responsibilities:
//   • `stripServerFields` — remove fields the apiserver writes back so the
//     operator sees source-like YAML (no managedFields noise, no status).
//   • `mergePatch` — compute an RFC 7386 JSON merge patch from the original
//     vs the edited document, so a single PATCH expresses adds, edits *and*
//     removals. The YAML tab follows the `kubectl edit` model rather than
//     Server-Side Apply (which the structured per-field editors use).
//
// Merge-patch semantics the operator gets from this:
//   • changed scalar / array → new value replaces the old wholesale.
//   • added key → set.
//   • removed key → emitted as `null`, which deletes the field server-side.
//   • blanked value (`key:` → YAML null) → also `null` → deletes the field.
//     Use `key: ""` for an explicit empty string (preserved as-is).
// This is the deliberate divergence from the SSA path: SSA partial trees
// can't express deletion by omission, which is why removals and empties
// silently no-op'd under the old `diffPartial`.

// js-yaml 5 dropped the default export in favour of flat named exports, so a
// `import jsYaml from "js-yaml"` resolves to "Missing export" under Vite. Use a
// namespace import to keep the `jsYaml.load` / `jsYaml.dump` call sites intact.
import * as jsYaml from "js-yaml";

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
  // js-yaml 5 throws `YAMLException: expected a document, but the input is
  // empty` for documentless input (empty / whitespace-only / comment-only)
  // where v4 returned `undefined`. Preserve the v4 contract — a source with no
  // document node parses to null — so the YAML editor tolerates a cleared
  // buffer instead of surfacing a spurious parse error.
  if (!hasYamlDocument(text)) return null;
  const v = jsYaml.load(text);
  return (v ?? null) as Json;
}

/** True if `text` contains at least one non-comment, non-blank line. */
function hasYamlDocument(text: string): boolean {
  return text
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
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
export type MergePatch = {
  // RFC 7386 merge patch: object fields are merged recursively, `null`
  // values delete the field, everything else replaces. Ready to hand to
  // `merge_patch_resource_cmd`. Empty object when nothing changed.
  patch: Record<string, Json>;
  // True if the patch is a no-op (semantically equal documents).
  empty: boolean;
  // Number of touched leaf paths (adds + edits + removals) — drives the
  // "Save (N)" chip. Unlike the old partial-diff, removals count here
  // because they actually apply.
  count: number;
};

// Strip identity fields the backend re-attaches itself — we never want to
// patch `apiVersion`, `kind`, `metadata.name`, `metadata.namespace`. A merge
// patch that nulled `metadata.name` (operator deleted the line) would be a
// rename attempt the apiserver rejects; dropping them keeps edits focused on
// spec / data / labels.
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

export function mergePatch(originalRaw: Json, editedRaw: Json): MergePatch {
  const original = stripIdentity(originalRaw);
  const edited = stripIdentity(editedRaw);

  const stats = { count: 0 };
  const patch = walkMerge(original, edited, stats, true);
  const obj: Record<string, Json> =
    patch !== UNCHANGED && isObject(patch) ? patch : {};
  return { patch: obj, empty: stats.count === 0, count: stats.count };
}

// Walk both trees together, producing the RFC 7386 merge patch from
// `original` → `edited`. Returns the sentinel `UNCHANGED` when nothing
// changed in this subtree so unchanged branches drop out of the patch.
const UNCHANGED: unique symbol = Symbol("unchanged");
type WalkResult = Json | typeof UNCHANGED;

function walkMerge(
  original: Json,
  edited: Json,
  stats: { count: number },
  topLevel: boolean,
): WalkResult {
  if (deepEqual(original, edited)) return UNCHANGED;

  // Object × object → per-key merge.
  if (isObject(original) && isObject(edited)) {
    const out: Record<string, Json> = {};
    let touched = 0;
    for (const [k, v] of Object.entries(edited)) {
      if (!(k in original)) {
        // New key — set it.
        out[k] = v;
        stats.count += 1;
        touched += 1;
        continue;
      }
      const sub = walkMerge(original[k]!, v, stats, false);
      if (sub !== UNCHANGED) {
        out[k] = sub;
        touched += 1;
      }
    }
    // Removed keys → explicit `null` so merge-patch deletes them. We refuse
    // to null the top-level `metadata` block: it carries identity + the
    // resourceVersion the backend injects, so deleting it wholesale is never
    // what the operator means (and the apiserver would reject it). Removing
    // individual metadata children (labels, annotations, a finalizer) still
    // works because that recurses one level deeper.
    for (const k of Object.keys(original)) {
      if (k in edited) continue;
      if (topLevel && k === "metadata") continue;
      out[k] = null;
      stats.count += 1;
      touched += 1;
    }
    return touched === 0 ? UNCHANGED : out;
  }

  // Anything else (scalar change, array change, type change): the leaf
  // replaces wholesale. Arrays are replaced rather than element-merged —
  // merge-patch has no concept of list keys, matching the operator's mental
  // model of "what I typed is what gets stored".
  stats.count += 1;
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
