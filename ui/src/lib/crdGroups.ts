// Sorting Kubernetes API group names by domain hierarchy (root-first).
//
// CRD group names are reverse-DNS domains ("gke.io", "auto.gke.io",
// "cert-manager.io"). A plain lexicographic sort interleaves unrelated
// vendors between a shared family — e.g. "cert-manager.io" sorts between
// "auto.gke.io" and "gke.io" — scattering related CRDs across the rail so
// an operator can't scan a vendor's kinds in one place.
//
// Comparing by dot-segments in reverse (TLD first, then org, then
// sub-group) keeps every group under a shared parent contiguous:
//   gke.io, auto.gke.io, node.gke.io  →  grouped together under io › gke.
// A shorter prefix sorts before its children ("gke.io" before
// "auto.gke.io"), so the parent group heads its own family.

/**
 * Compare two API group names by domain hierarchy, root-first.
 * Suitable as an `Array.prototype.sort` comparator.
 */
export function compareApiGroups(a: string, b: string): number {
  if (a === b) return 0;
  const ra = a.split(".").reverse();
  const rb = b.split(".").reverse();
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const c = ra[i]!.localeCompare(rb[i]!);
    if (c !== 0) return c;
  }
  // Shared prefix: the shorter (more general) group heads its family.
  return ra.length - rb.length;
}

/** Return a new array of API group names ordered by domain hierarchy. */
export function sortApiGroups(groups: readonly string[]): string[] {
  return [...groups].sort(compareApiGroups);
}
