// Pure layout + rollup helpers for the multi-cluster bar's member strip. No
// React, no DOM — the bar measures its own width with a ResizeObserver and
// hands the number here, so the fit decision is deterministic and testable.
//
// Why estimate widths instead of measuring each chip: measuring means
// rendering every chip, reading its box, then hiding the overflow — a
// render → measure → re-render loop that flickers on every resize and fights
// the ResizeObserver that triggered it. The chips are a fixed shape (dot +
// mono label + status dot), so a character-count estimate is accurate to a
// few pixels and costs nothing. Same trade-off `cardBasisPx` makes on the
// fleet landing.

/// Coarse connection state of one member, collapsed to the three buckets the
/// rollup counts. `connecting` also covers "no state yet".
export type MemberHealth = "ok" | "connecting" | "bad";

export type StripMember = {
  id: string;
  /// The text the chip renders (already shortened by `lib/clusterName`).
  label: string;
  health: MemberHealth;
  /// Ad-hoc scope additions carry a removal ×, which makes the chip wider.
  removable: boolean;
};

// Chip geometry, in px. Mirrors the styles in `VirtualClusterPanel`'s chip:
// 8px horizontal padding either side, an 8px accent dot, a 6px status dot,
// two 6px gaps, and a 1px border either side.
const CHIP_CHROME = 8 * 2 + 8 + 6 + 6 * 2 + 2;
// Mono at FS_XS — measured against the shipped mono stack at the default UI
// scale. Slightly generous so a rounding error hides a chip rather than
// clipping one.
const CHIP_CHAR_PX = 6.6;
// The × on an ad-hoc chip: glyph plus its gap.
const REMOVE_PX = 14;
/// Width the "+N" overflow pill needs. Grows a little with the digit count.
export const overflowPillPx = (hidden: number): number =>
  34 + String(hidden).length * 7;
/// Width the health rollup needs for `n` populated buckets (dot + count each).
export const rollupPx = (buckets: number): number => buckets * 30;
/// Never collapse below this — a strip with no names at all is useless, so
/// the first chip is always rendered even if it has to ellipsis.
const MIN_VISIBLE = 1;

export function chipWidthPx(m: StripMember): number {
  return (
    CHIP_CHROME +
    m.label.length * CHIP_CHAR_PX +
    (m.removable ? REMOVE_PX : 0)
  );
}

export type StripFit = {
  visible: StripMember[];
  hidden: StripMember[];
};

/// Decide how many member chips fit in `availablePx`.
///
/// `pinnedId` (the focused member) is always placed first and always visible:
/// a focus you can't see, and therefore can't click again to clear, is a trap
/// — the table looks broken and nothing on screen explains why.
///
/// Reserves room for the overflow pill whenever anything would be hidden, and
/// for the rollup when `rollupBuckets > 0`, so the trailing controls never
/// push the last chip off-screen after the fact.
export function fitStrip(
  members: readonly StripMember[],
  availablePx: number,
  opts: { pinnedId?: string | null; rollupBuckets?: number } = {},
): StripFit {
  const ordered = orderPinnedFirst(members, opts.pinnedId ?? null);
  if (ordered.length === 0) return { visible: [], hidden: [] };

  const gap = 6;
  const reserved = rollupPx(opts.rollupBuckets ?? 0);

  // First pass: does everything fit with no overflow pill at all?
  const totalPx =
    ordered.reduce((sum, m) => sum + chipWidthPx(m), 0) +
    gap * Math.max(0, ordered.length - 1) +
    reserved;
  if (totalPx <= availablePx) return { visible: [...ordered], hidden: [] };

  // Second pass: fit as many as possible, leaving room for the pill. The
  // pill's width depends on how many are hidden, which depends on how many
  // fit — so budget for the worst case (every remaining member hidden) and
  // let the real pill come out no wider.
  let used = reserved;
  let count = 0;
  for (let i = 0; i < ordered.length; i++) {
    const next = used + (i > 0 ? gap : 0) + chipWidthPx(ordered[i]!);
    const stillHidden = ordered.length - (i + 1);
    const pill = stillHidden > 0 ? gap + overflowPillPx(stillHidden) : 0;
    if (next + pill > availablePx) break;
    used = next;
    count = i + 1;
  }
  const visibleCount = Math.max(MIN_VISIBLE, count);
  return {
    visible: ordered.slice(0, visibleCount),
    hidden: ordered.slice(visibleCount),
  };
}

function orderPinnedFirst(
  members: readonly StripMember[],
  pinnedId: string | null,
): StripMember[] {
  if (!pinnedId) return [...members];
  const pinned = members.find((m) => m.id === pinnedId);
  if (!pinned) return [...members];
  return [pinned, ...members.filter((m) => m.id !== pinnedId)];
}

export type HealthCounts = { ok: number; connecting: number; bad: number };

export function healthCounts(members: readonly StripMember[]): HealthCounts {
  const out: HealthCounts = { ok: 0, connecting: 0, bad: 0 };
  for (const m of members) out[m.health] += 1;
  return out;
}

/// How many rollup buckets actually have members — drives both the reserved
/// width and whether the rollup is worth rendering at all.
export function populatedBuckets(counts: HealthCounts): number {
  return (
    (counts.ok > 0 ? 1 : 0) +
    (counts.connecting > 0 ? 1 : 0) +
    (counts.bad > 0 ? 1 : 0)
  );
}

/// Whether to render the rollup. Two healthy clusters need no summary — the
/// chips already say everything. It earns its space once members are hidden
/// (the counts describe what you can't see) or once something is wrong.
export function shouldShowRollup(
  counts: HealthCounts,
  hiddenCount: number,
): boolean {
  return hiddenCount > 0 || counts.connecting > 0 || counts.bad > 0;
}

/// Screen-reader / tooltip sentence for the rollup, e.g.
/// "15 connected · 2 reconnecting · 1 unreachable".
export function rollupSummary(counts: HealthCounts): string {
  const bits: string[] = [];
  if (counts.ok > 0) bits.push(`${counts.ok} connected`);
  if (counts.connecting > 0) bits.push(`${counts.connecting} connecting`);
  if (counts.bad > 0) bits.push(`${counts.bad} unreachable`);
  return bits.join(" · ");
}
