import type { ResourceKind } from "../types";

export function resourceKindLabel(
  kind: Pick<ResourceKind, "kind" | "group">,
): string {
  if (kind.group.endsWith(".toolkit.fluxcd.io")) return `Flux ${kind.kind}`;
  if (
    kind.group === "argoproj.io" &&
    ["Application", "ApplicationSet", "AppProject"].includes(kind.kind)
  ) {
    return `Argo CD ${kind.kind}`;
  }
  return kind.kind;
}

/// CRD-derived kinds (`crd:` generic, `wkcrd:` well-known overrides) are
/// cluster-local and appear only after per-cluster discovery.
export function isDynamicKindId(id: string): boolean {
  return id.startsWith("crd:") || id.startsWith("wkcrd:");
}

export function resolveResourceKind(
  kinds: ResourceKind[],
  kindClusters: Record<string, string[]>,
  kindName: string,
  clusterId: string,
  group?: string,
): ResourceKind | undefined {
  const matches = kinds.filter(
    (k) =>
      k.kind === kindName &&
      (group === undefined || k.group === group) &&
      (!isDynamicKindId(k.id) ||
        kindClusters[k.id]?.includes(clusterId)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
