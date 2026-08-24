import { describe, expect, it } from "vitest";
import { buildFieldRows, flattenFields } from "./fieldFlatten";

describe("flattenFields", () => {
  it("joins nested object keys with dots", () => {
    const m = flattenFields({ spec: { replicas: 3, paused: false } });
    expect(m.get("spec.replicas")).toBe("3");
    expect(m.get("spec.paused")).toBe("false");
  });

  it("indexes array entries", () => {
    const m = flattenFields({
      spec: { containers: [{ name: "api" }, { name: "sidecar" }] },
    });
    expect(m.get("spec.containers[0].name")).toBe("api");
    expect(m.get("spec.containers[1].name")).toBe("sidecar");
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

  it("handles a single subject — every row matches itself", () => {
    expect(buildFieldRows([a]).every((r) => !r.differs)).toBe(true);
  });
});
