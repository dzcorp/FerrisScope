// Pure helpers for the About panel's "What's new" view. No React, no IO — the
// backend (`updater::fetch_release_notes`) owns fetching + caching; this module
// only shapes the bundle for display. Unit-tested in `releaseNotes.test.ts`.

import type { ChangeItem, ReleaseNote } from "../types";

export type ChangeGroupKey = "features" | "fixes" | "other";

/// A change item annotated with the release it came from, so the merged view
/// can still show "which version" in the per-version breakdown.
export type GroupedChange = ChangeItem & { version: string };

export type ChangeGroup = {
  key: ChangeGroupKey;
  label: string;
  items: GroupedChange[];
};

// Conventional-commit kind → display bucket. Anything not listed (perf,
// refactor, docs, chore, test, build, ci, style, revert, other) folds into
// "Other" so the panel stays at three predictable sections.
const GROUP_OF: Record<string, ChangeGroupKey> = {
  feat: "features",
  fix: "fixes",
};

const GROUP_ORDER: { key: ChangeGroupKey; label: string }[] = [
  { key: "features", label: "Features" },
  { key: "fixes", label: "Fixes" },
  { key: "other", label: "Other" },
];

export function groupKeyForKind(kind: string): ChangeGroupKey {
  return GROUP_OF[kind] ?? "other";
}

/// Merge every pending release's changes into Features / Fixes / Other,
/// tagging each item with its source version. Empty groups are dropped and
/// in-group order follows the input (newest release first).
export function groupChanges(releases: ReleaseNote[]): ChangeGroup[] {
  const buckets: Record<ChangeGroupKey, GroupedChange[]> = {
    features: [],
    fixes: [],
    other: [],
  };
  for (const rel of releases) {
    for (const change of rel.changes) {
      buckets[groupKeyForKind(change.kind)].push({
        ...change,
        version: rel.version,
      });
    }
  }
  return GROUP_ORDER.map((g) => ({ ...g, items: buckets[g.key] })).filter(
    (g) => g.items.length > 0,
  );
}

/// Title label that collapses skipped versions into a range:
/// one pending release → "v1.0.27"; many → "v1.0.1 – v1.0.27".
/// `releases` is newest-first (as the backend returns it).
export function versionRangeLabel(releases: ReleaseNote[]): string {
  const first = releases[0];
  const last = releases[releases.length - 1];
  if (!first || !last) return "";
  const newest = first.version;
  const oldest = last.version;
  return newest === oldest ? `v${newest}` : `v${oldest} – v${newest}`;
}

/// Total parsed change count across every pending release.
export function totalChangeCount(releases: ReleaseNote[]): number {
  return releases.reduce((sum, r) => sum + r.changes.length, 0);
}

/// One-line summary for an item: "<scope>: <text>" when a scope is present,
/// else just the text. Keeps scope info even though the type prefix is dropped.
export function changeSummary(change: ChangeItem): string {
  return change.scope ? `${change.scope}: ${change.text}` : change.text;
}
