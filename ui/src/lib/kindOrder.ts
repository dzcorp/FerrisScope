import type { Category, ResourceKind } from "../types";

/// Rail group order. The tray and anything else listing kinds follows it.
export const CATEGORY_ORDER: Category[] = [
  "Workloads",
  "Cluster",
  "Network",
  "Config",
  "Storage",
  "Access",
  "Apps",
  "CustomResources",
];

/// Kinds grouped exactly as the rail shows them: registry order within a
/// category, with discovered CRD kinds alphabetical after the built-in
/// CustomResources rows.
export function groupKinds(kinds: ResourceKind[]): Map<Category, ResourceKind[]> {
  const map = new Map<Category, ResourceKind[]>();
  for (const k of kinds) {
    const arr = map.get(k.category) ?? [];
    arr.push(k);
    map.set(k.category, arr);
  }
  const cr = map.get("CustomResources");
  if (cr && cr.length > 1) {
    const builtin = cr.filter((k) => !k.id.startsWith("crd:"));
    const dynamic = cr
      .filter((k) => k.id.startsWith("crd:"))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    map.set("CustomResources", [...builtin, ...dynamic]);
  }
  return map;
}

/// Position of every kind id in the rail, top to bottom.
export function railRank(kinds: ResourceKind[]): Map<string, number> {
  const grouped = groupKinds(kinds);
  const rank = new Map<string, number>();
  for (const cat of CATEGORY_ORDER) {
    for (const k of grouped.get(cat) ?? []) rank.set(k.id, rank.size);
  }
  return rank;
}
