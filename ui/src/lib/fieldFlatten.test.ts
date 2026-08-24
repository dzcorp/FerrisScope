import { describe, expect, it } from "vitest";
import { buildFieldRows, flattenFields } from "./fieldFlatten";

describe("flattenFields", () => {
  it("joins nested object keys with dots", () => {
    const m = flattenFields({ spec: { replicas: 3, paused: false } });
    expect(m.get("spec.replicas")).toBe("3");
    expect(m.get("spec.paused")).toBe("false");
  });

  // Kubernetes merges these lists by `name`, not position, so two identical
  // objects whose containers happen to be ordered differently must compare
  // equal rather than reporting every element as changed.
  it("keys array entries by their Kubernetes merge key", () => {
    const m = flattenFields({
      spec: { containers: [{ name: "api" }, { name: "sidecar" }] },
    });
    expect(m.get("spec.containers[api].name")).toBe("api");
    expect(m.get("spec.containers[sidecar].name")).toBe("sidecar");
  });

  it("falls back to the index for entries with no merge key", () => {
    const m = flattenFields({ spec: { args: ["--a", "--b"] } });
    expect(m.get("spec.args[0]")).toBe("--a");
    expect(m.get("spec.args[1]")).toBe("--b");
  });

  // `{a: {b: 1}}` and `{"a.b": 2}` both wanted the path `a.b`; one silently
  // won and the other vanished from the comparison entirely.
  it("quotes keys containing dots so they cannot collide with nesting", () => {
    const m = flattenFields({ a: { b: 1 }, "a.b": 2 });
    expect(m.get("a.b")).toBe("1");
    expect(m.get('["a.b"]')).toBe("2");
    expect(m.size).toBe(2);
  });

  it("quotes real Kubernetes label keys", () => {
    const m = flattenFields({
      metadata: { labels: { "app.kubernetes.io/name": "web" } },
    });
    expect(m.get('metadata.labels["app.kubernetes.io/name"]')).toBe("web");
  });

  // "absent" and "empty" are different facts, and telling them apart is
  // most of what a comparison is for.
  it("keeps an empty object or array as a leaf", () => {
    const m = flattenFields({ metadata: { labels: {} }, spec: { args: [] } });
    expect(m.get("metadata.labels")).toBe("{}");
    expect(m.get("spec.args")).toBe("[]");
  });

  it("keeps an explicit null as its own leaf", () => {
    expect(flattenFields({ spec: { nodeName: null } }).get("spec.nodeName")).toBe(
      "null",
    );
  });

  it("stringifies scalars of every type", () => {
    const m = flattenFields({ a: 1, b: "x", c: true, d: 1.5 });
    expect([m.get("a"), m.get("b"), m.get("c"), m.get("d")]).toEqual([
      "1",
      "x",
      "true",
      "1.5",
    ]);
  });

  it("returns nothing for an empty or scalar root", () => {
    expect(flattenFields({}).size).toBe(0);
    expect(flattenFields(null).size).toBe(0);
  });
});

describe("buildFieldRows", () => {
  const a = flattenFields({ spec: { replicas: 3, image: "v1" } });
  const b = flattenFields({ spec: { replicas: 3, image: "v2" } });

  it("marks matching values as equal and differing ones as differing", () => {
    const rows = buildFieldRows([a, b]);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get("spec.replicas")?.differs).toBe(false);
    expect(byPath.get("spec.image")?.differs).toBe(true);
    expect(byPath.get("spec.image")?.values).toEqual(["v1", "v2"]);
  });

  it("treats a missing value as null and as a difference", () => {
    const c = flattenFields({ spec: { replicas: 3 } });
    const rows = buildFieldRows([a, c]);
    const image = rows.find((r) => r.path === "spec.image");
    expect(image?.values).toEqual(["v1", null]);
    expect(image?.differs).toBe(true);
  });

  it("unions paths across every subject", () => {
    const rows = buildFieldRows([
      flattenFields({ only: { a: 1 } }),
      flattenFields({ only: { b: 2 } }),
    ]);
    expect(rows.map((r) => r.path)).toEqual(["only.a", "only.b"]);
  });

  // Lexical sort would put [10] before [2] and scatter a long list.
  it("orders array indices numerically", () => {
    const doc = flattenFields({
      xs: Array.from({ length: 11 }, (_, i) => `v${i}`),
    });
    const paths = buildFieldRows([doc]).map((r) => r.path);
    expect(paths[2]).toBe("xs[2]");
    expect(paths[10]).toBe("xs[10]");
  });

  it("reports no difference when merge-keyed lists are reordered", () => {
    const a = flattenFields({
      spec: { containers: [{ name: "api", image: "v1" }, { name: "log", image: "v2" }] },
    });
    const b = flattenFields({
      spec: { containers: [{ name: "log", image: "v2" }, { name: "api", image: "v1" }] },
    });
    expect(buildFieldRows([a, b]).some((r) => r.differs)).toBe(false);
  });

  // Order IS the meaning for args/command, so a reorder must still show up.
  it("still reports a difference when an order-significant list is reordered", () => {
    const a = flattenFields({ spec: { args: ["--a", "--b"] } });
    const b = flattenFields({ spec: { args: ["--b", "--a"] } });
    expect(buildFieldRows([a, b]).some((r) => r.differs)).toBe(true);
  });

  it("handles a single subject — every row matches itself", () => {
    expect(buildFieldRows([a]).every((r) => !r.differs)).toBe(true);
  });
});
