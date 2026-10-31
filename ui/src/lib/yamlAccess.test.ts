import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ResourceKind } from "../types";
import { resetMockInvoke, setMockInvoke } from "../test/tauri-mock";
import { resetAccessCache } from "./access";
import { YAML_ACCESS_MAX_CHARS, useYamlApplyAccess, yamlDocTargets } from "./yamlAccess";

const k = (id: string, group: string, kind: string, namespaced: boolean) =>
  ({ id, group, kind, namespaced, version: "v1", plural: id }) as ResourceKind;

const KINDS = [
  k("deployments", "apps", "Deployment", true),
  k("configmaps", "", "ConfigMap", true),
  k("namespaces", "", "Namespace", false),
  k("helm_releases", "", "HelmRelease", true),
];

describe("yamlDocTargets", () => {
  it("resolves each document to a kind id and scope", () => {
    const yaml = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: prod }
---
apiVersion: v1
kind: Namespace
metadata: { name: prod, namespace: ignored }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg }
`;
    // The namespaced ConfigMap without a namespace is left to Apply's own error.
    expect(yamlDocTargets(yaml, KINDS)).toEqual([
      { kindId: "deployments", namespace: "prod", name: "web" },
      { kindId: "namespaces", namespace: null, name: "prod" },
    ]);
  });

  it("skips unknown kinds, synthetic helm views, junk and broken YAML", () => {
    expect(
      yamlDocTargets("apiVersion: v1\nkind: HelmRelease\n---\napiVersion: x.io/v1\nkind: Widget\n---\n42\n", KINDS),
    ).toEqual([]);
    expect(yamlDocTargets("kind: [unclosed", KINDS)).toEqual([]);
  });

  it("skips buffers too big to parse per edit", () => {
    const doc = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: cfg, namespace: a }\n";
    const big = doc + `# ${"x".repeat(YAML_ACCESS_MAX_CHARS)}\n`;
    expect(yamlDocTargets(doc, KINDS)).toHaveLength(1);
    expect(yamlDocTargets(big, KINDS)).toEqual([]);
  });
});

describe("useYamlApplyAccess", () => {
  afterEach(() => {
    resetMockInvoke();
    resetAccessCache();
  });

  const two = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: prod }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg, namespace: prod }
`;

  function answer(deny: (r: { kindId: string; name: string | null }) => boolean) {
    const asked: { kindId: string; name: string | null }[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd !== "access_check_cmd") return undefined;
      const rs = args?.requests as { kindId: string; name: string | null }[];
      asked.push(...rs);
      return rs.map((r) => (deny(r) ? { state: "denied", reason: `cannot patch ${r.kindId}` } : { state: "allowed" }));
    });
    return asked;
  }

  it("asks per document with its name, and only blocks when every document is denied", async () => {
    const asked = answer((r) => r.kindId === "deployments");
    const { result, rerender } = renderHook(({ c }) => useYamlApplyAccess("ctx", c, KINDS), {
      initialProps: { c: two },
    });
    await waitFor(() => expect(result.current.denied).toHaveLength(1));
    expect(result.current.allDenied).toBe(false);
    expect(asked.map((r) => r.name).sort()).toEqual(["cfg", "web"]);
    rerender({ c: two.split("---")[0]! });
    await waitFor(() => expect(result.current.allDenied).toBe(true));
  });

  it("asks nothing without a target cluster", async () => {
    const asked = answer(() => true);
    const { result } = renderHook(() => useYamlApplyAccess(null, two, KINDS));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(asked).toEqual([]);
    expect(result.current.allDenied).toBe(false);
  });
});
