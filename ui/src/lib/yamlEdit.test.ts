// `stripServerFields` and `diffPartial` are the engine behind the YAML
// editor's "save only what changed" behavior. Both have shape-sensitive
// branches (metadata pruning, identity stripping, the
// "only-deletions" warning path) — exactly the kind of thing that drifts
// silently when someone tweaks the implementation.

import { describe, it, expect } from "vitest";
import {
  diffPartial,
  dumpYaml,
  parseYaml,
  stripServerFields,
  stripYaml,
  type Json,
} from "./yamlEdit";

const NOW = "2024-01-01T00:00:00Z";

function cm(over: Partial<Record<string, Json>> = {}): Json {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "hello",
      namespace: "default",
      uid: "abc-uid",
      resourceVersion: "42",
      creationTimestamp: NOW,
      generation: 1,
      managedFields: [{ manager: "ferrisscope" }],
      labels: { app: "hello" },
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": "{\"big\":\"blob\"}",
        "other.io/keep": "yes",
      },
    },
    data: { KEY: "A" },
    status: { phase: "Active" },
    ...over,
  };
}

describe("stripServerFields", () => {
  it("drops status, server-written metadata, and last-applied-configuration", () => {
    const out = stripServerFields(cm()) as Record<string, Json>;
    expect(out.status).toBeUndefined();
    const meta = out.metadata as Record<string, Json>;
    expect(meta.uid).toBeUndefined();
    expect(meta.resourceVersion).toBeUndefined();
    expect(meta.creationTimestamp).toBeUndefined();
    expect(meta.generation).toBeUndefined();
    expect(meta.managedFields).toBeUndefined();
    expect(meta.name).toBe("hello"); // identity survives strip
    const ann = meta.annotations as Record<string, Json>;
    expect(ann["kubectl.kubernetes.io/last-applied-configuration"]).toBeUndefined();
    expect(ann["other.io/keep"]).toBe("yes");
  });

  it("drops annotations entirely when every key is a server annotation", () => {
    const out = stripServerFields(
      cm({
        metadata: {
          name: "hello",
          namespace: "default",
          annotations: {
            "kubectl.kubernetes.io/last-applied-configuration": "{}",
          },
        },
      }),
    ) as Record<string, Json>;
    const meta = out.metadata as Record<string, Json>;
    expect("annotations" in meta).toBe(false);
  });

  it("non-object input passes through unchanged", () => {
    expect(stripServerFields(null)).toBeNull();
    expect(stripServerFields(42 as unknown as Json)).toBe(42);
    expect(stripServerFields("hello" as unknown as Json)).toBe("hello");
  });
});

describe("parseYaml / dumpYaml / stripYaml", () => {
  it("roundtrips a simple manifest preserving key order", () => {
    const yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: hi\n";
    const dumped = dumpYaml(parseYaml(yaml));
    // First two keys must be apiVersion and kind in that order — js-yaml
    // with sortKeys:false honours object insertion order.
    expect(dumped.startsWith("apiVersion: v1\nkind: ConfigMap\n")).toBe(true);
  });

  it("stripYaml end-to-end removes status from a real-looking blob", () => {
    const yaml =
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n  uid: deadbeef\ndata:\n  K: V\nstatus:\n  phase: Active\n";
    const out = stripYaml(yaml);
    expect(out).not.toContain("uid:");
    expect(out).not.toContain("status:");
    expect(out).toContain("data:");
  });

  it("empty document parses to null", () => {
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("# only a comment\n")).toBeNull();
  });
});

describe("diffPartial — modifications", () => {
  it("empty diff for identical inputs", () => {
    const a = cm();
    const r = diffPartial(a, a);
    expect(r.empty).toBe(true);
    expect(r.onlyDeletions).toBe(false);
    expect(r.count).toBe(0);
    expect(r.partial).toEqual({});
  });

  it("changing a single nested scalar emits only the touched subtree", () => {
    const a = cm();
    const b = cm({ data: { KEY: "B" } });
    const r = diffPartial(a, b);
    expect(r.empty).toBe(false);
    expect(r.onlyDeletions).toBe(false);
    expect(r.count).toBe(1);
    expect(r.partial).toEqual({ data: { KEY: "B" } });
  });

  it("adding a new key under an existing object yields that key alone", () => {
    const a: Json = { spec: { replicas: 3 } };
    const b: Json = { spec: { replicas: 3, paused: true } };
    const r = diffPartial(a, b);
    expect(r.partial).toEqual({ spec: { paused: true } });
    expect(r.count).toBe(1);
  });

  it("array changes are replaced wholesale (we don't know the listType)", () => {
    const a: Json = { spec: { containers: [{ name: "c1" }] } };
    const b: Json = {
      spec: { containers: [{ name: "c1" }, { name: "c2" }] },
    };
    const r = diffPartial(a, b);
    // Whole containers array must appear in the partial — we can't express
    // a per-element listType:map merge in this codepath.
    expect(r.partial).toEqual({
      spec: { containers: [{ name: "c1" }, { name: "c2" }] },
    });
    expect(r.count).toBe(1);
  });

  it("type change (object → scalar) counts as a single change", () => {
    const a: Json = { spec: { replicas: 3 } };
    const b: Json = { spec: 3 };
    const r = diffPartial(a, b);
    expect(r.partial).toEqual({ spec: 3 });
    expect(r.count).toBe(1);
  });
});

describe("diffPartial — identity stripping", () => {
  it("apiVersion / kind / metadata.name / metadata.namespace are never claimed", () => {
    // Build inputs that differ ONLY in identity fields — anything else and
    // the rest of the diff would show up.
    const a: Json = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "hello", namespace: "default" },
      data: { K: "V" },
    };
    const b: Json = {
      apiVersion: "v1beta1",
      kind: "ConfigMapX",
      metadata: { name: "hello-renamed", namespace: "other" },
      data: { K: "V" },
    };
    const r = diffPartial(a, b);
    // None of the four identity fields appear in the partial.
    expect("apiVersion" in r.partial).toBe(false);
    expect("kind" in r.partial).toBe(false);
    expect(r.partial.metadata).toBeUndefined();
    // No spec changes → diff is empty (we don't claim identity).
    expect(r.empty).toBe(true);
  });

  it("identity-only delta plus a real change still emits the real change", () => {
    const a: Json = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "x", labels: { app: "a" } },
      data: { K: "V" },
    };
    const b: Json = {
      apiVersion: "v1beta1",
      kind: "ConfigMap",
      metadata: { name: "x", labels: { app: "b" } },
      data: { K: "V" },
    };
    const r = diffPartial(a, b);
    expect(r.partial).toEqual({ metadata: { labels: { app: "b" } } });
    expect(r.count).toBe(1);
  });
});

describe("diffPartial — deletions", () => {
  it("only-deletions case is flagged but produces an empty partial", () => {
    const a: Json = { data: { KEEP: "yes", DROP: "drop-me" } };
    const b: Json = { data: { KEEP: "yes" } };
    const r = diffPartial(a, b);
    expect(r.empty).toBe(false);
    expect(r.onlyDeletions).toBe(true);
    expect(r.count).toBe(0);
    expect(r.partial).toEqual({});
  });

  it("mixed add + remove still emits the add and is NOT flagged as only-deletions", () => {
    const a: Json = { data: { KEEP: "yes", DROP: "old" } };
    const b: Json = { data: { KEEP: "yes", ADDED: "new" } };
    const r = diffPartial(a, b);
    expect(r.onlyDeletions).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.partial).toEqual({ data: { ADDED: "new" } });
    expect(r.count).toBe(1);
  });
});
