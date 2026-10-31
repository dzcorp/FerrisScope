import { useMemo } from "react";
import * as jsYaml from "js-yaml";
import type { ResourceKind } from "../types";
import { useAccessChecks, type Gate } from "./access";
import { useDebounced } from "./useDebounced";

export type YamlDocTarget = { kindId: string; namespace: string | null; name: string | null };

/// Past this, parsing on every edit costs more than the hint is worth.
export const YAML_ACCESS_MAX_CHARS = 256 * 1024;

/// The objects a multi-doc manifest would apply, resolved to registry kind
/// ids so each can be RBAC-checked. Unparseable or oversized YAML and
/// unknown kinds yield nothing — the apiserver still has the last word on
/// Apply.
export function yamlDocTargets(content: string, kinds: readonly ResourceKind[]): YamlDocTarget[] {
  if (content.length > YAML_ACCESS_MAX_CHARS) return [];
  let docs: unknown[];
  try {
    docs = jsYaml.loadAll(content);
  } catch {
    return [];
  }
  const out: YamlDocTarget[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const d = doc as { apiVersion?: unknown; kind?: unknown; metadata?: unknown };
    if (typeof d.apiVersion !== "string" || typeof d.kind !== "string") continue;
    const slash = d.apiVersion.lastIndexOf("/");
    const group = slash < 0 ? "" : d.apiVersion.slice(0, slash);
    const kind = kinds.find(
      (k) =>
        k.group === group &&
        k.kind === d.kind &&
        k.id !== "helm_releases" &&
        k.id !== "helm_charts",
    );
    if (!kind) continue;
    const meta = (d.metadata ?? {}) as { namespace?: unknown; name?: unknown };
    const namespace = typeof meta.namespace === "string" && meta.namespace ? meta.namespace : null;
    // Apply refuses a namespaced doc without a namespace; that error says
    // more than a cluster-wide denial would.
    if (kind.namespaced && namespace == null) continue;
    out.push({
      kindId: kind.id,
      namespace: kind.namespaced ? namespace : null,
      name: typeof meta.name === "string" ? meta.name : null,
    });
  }
  return out;
}

/// RBAC per document of a manifest about to be applied (SSA → `patch`, with
/// the name: a grant may be scoped to one object), parsed once typing pauses.
export function useYamlApplyAccess(
  clusterId: string | null,
  content: string,
  kinds: readonly ResourceKind[],
): { gates: Gate[]; denied: Gate[]; allDenied: boolean } {
  const settled = useDebounced(content, 400);
  const targets = useMemo(() => yamlDocTargets(settled, kinds), [settled, kinds]);
  const gates = useAccessChecks(
    useMemo(
      () =>
        clusterId
          ? targets.map((d) => ({
              clusterId,
              kindId: d.kindId,
              action: "patch" as const,
              namespace: d.namespace,
              name: d.name,
            }))
          : [],
      [clusterId, targets],
    ),
  );
  const denied = gates.filter((g) => !g.allowed);
  return { gates, denied, allDenied: gates.length > 0 && denied.length === gates.length };
}
