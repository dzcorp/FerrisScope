// Periodic-refresh gate for the open detail panel.
//
// Why this exists: the detail Summary / YAML / Related tabs are PULL-based —
// they call `get_*_detail` and only refetch when the panel's `detailVersion`
// bumps. `detailVersion` bumps on an Upsert delta for the open object's uid,
// but the watcher emits a row delta ONLY when the projected ROW changes
// byte-for-byte (no-op suppression in `crates/kube-ext/src/watcher.rs`). The
// projected row carries table columns only (name / namespace / phase / age /
// …) — labels, annotations and most spec fields live in `project_detail()`,
// off the row. So an edit that only touches metadata produces an identical
// row, is suppressed, never bumps `detailVersion`, and the Summary goes stale
// until the panel is reopened.
//
// The fix is a low-frequency refetch while the panel is open. The live row
// path still keeps status/phase fresh for free; this only closes the gap for
// everything off the row.
export const DETAIL_POLL_MS = 10_000;

// Tabs whose content is pull-based and keyed on `detailVersion`. Events / logs
// / metrics maintain their own live streams, so a periodic detail bump does
// nothing useful for them — don't burn a `get_*_detail` round-trip on their
// behalf.
const POLL_TABS: ReadonlySet<string> = new Set(["summary", "yaml", "related"]);

// Pure decision for "should the periodic refetch fire this tick". Kept pure +
// separate from DetailPanel so it can be unit-tested without dragging the
// whole panel module into the test.
//
//   • `hidden`      — `document.hidden`; pause while the window is backgrounded
//                     so we don't issue apiserver GETs no one is looking at.
//   • `yamlEditing` — a YAML draft is in flight (`yamlBuffer != null`); a
//                     refetch would refresh the read view under the operator's
//                     edit and churn the editor. (Structured per-field editors
//                     are clobber-safe — their buffer is independent local
//                     state re-seeded only on enter/cancel/save — so they need
//                     no guard here.)
//   • `tab`         — only poll on a tab that consumes `detailVersion`.
export function shouldPollDetail(opts: {
  hidden: boolean;
  yamlEditing: boolean;
  tab: string;
}): boolean {
  if (opts.hidden) return false;
  if (opts.yamlEditing) return false;
  return POLL_TABS.has(opts.tab);
}
