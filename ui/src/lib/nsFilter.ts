/// Namespace filter after dropping entries that no longer exist in any active
/// cluster, or `null` when nothing changes. Returns `null` until every member
/// finished its initial namespace LIST: a partial `live` set (fresh watcher,
/// forbidden LIST) would otherwise wipe a restored filter to "all namespaces".
export function prunedNamespaceFilter(
  selected: ReadonlySet<string>,
  live: ReadonlySet<string>,
  syncedMembers: number,
  totalMembers: number,
): Set<string> | null {
  if (selected.size === 0 || syncedMembers < totalMembers) return null;
  const next = new Set<string>();
  for (const name of selected) if (live.has(name)) next.add(name);
  return next.size === selected.size ? null : next;
}
