/// Scrollback buffer for the log view. Pure — no React, no DOM.
///
/// A single global ring was the obvious shape while every view streamed one
/// pod. It stops working the moment a view aggregates: with a 5,000-line ring
/// shared by 24 streams, one chatty pod evicts every other pod's scrollback
/// within seconds, and the aggregated view — the whole point of which is
/// comparing pods — ends up showing one pod.
///
/// So the buffer is partitioned per source. Each source gets its own quota and
/// evicts only against itself; `toArray` merges the partitions back into
/// arrival order for rendering. A pod that says nothing keeps its history no
/// matter how loud its neighbours are.

/// Floor on each source's quota. Without it a 24-source view at the default
/// 5,000-line cap would hand each pod ~200 lines, which is less scrollback than
/// a single `kubectl logs --tail` — the aggregated view would technically hold
/// 5,000 lines and still be useless. The floor trades a bounded amount of extra
/// memory (24 sources × 500 lines × ~200 B ≈ 2.4 MB over the nominal cap) for a
/// window that can actually be read.
export const MIN_LINES_PER_SOURCE = 500;

/// The minimum an entry must carry for the buffer to place and order it.
/// `id` is a globally monotonic sequence number assigned at push time, so
/// merging partitions restores the exact order lines arrived in.
export type RingEntry = {
  id: number;
  src: string;
};

/// Per-source quota for a given total cap and source count. With one source
/// this is just the total cap, so a single-pod view behaves exactly as it did
/// before partitioning.
export function perSourceCap(totalCap: number, sourceCount: number): number {
  if (sourceCount <= 1) return totalCap;
  return Math.max(MIN_LINES_PER_SOURCE, Math.floor(totalCap / sourceCount));
}

/// One source's slice of the buffer: a fixed-capacity ring over an array.
/// Append is O(1) and overwrites the oldest slot once full.
class SourceRing<T extends RingEntry> {
  private buf: (T | undefined)[];
  private start = 0;
  private len = 0;
  constructor(private cap: number) {
    this.buf = new Array(cap);
  }
  push(entry: T) {
    if (this.len < this.cap) {
      this.buf[(this.start + this.len) % this.cap] = entry;
      this.len += 1;
    } else {
      this.buf[this.start] = entry;
      this.start = (this.start + 1) % this.cap;
    }
  }
  get size(): number {
    return this.len;
  }
  at(i: number): T {
    return this.buf[(this.start + i) % this.cap]!;
  }
  /// Re-cap in place, keeping the newest `cap` entries. Shrinking drops the
  /// oldest overflow — the same semantics as normal rollover.
  recap(cap: number) {
    if (cap === this.cap) return;
    const keep = Math.min(this.len, cap);
    const next: (T | undefined)[] = new Array(cap);
    for (let i = 0; i < keep; i++) next[i] = this.at(this.len - keep + i);
    this.buf = next;
    this.cap = cap;
    this.start = 0;
    this.len = keep;
  }
}

export class LogRing<T extends RingEntry> {
  private parts = new Map<string, SourceRing<T>>();
  /// Sources the view currently wants. Held separately from `parts` so the
  /// quota reflects the *configured* fan-out rather than however many sources
  /// have happened to emit a line so far — otherwise the first pod to speak
  /// would be handed the whole buffer and immediately have it taken away.
  private sourceCount = 1;
  private merged: T[] | null = null;

  constructor(private totalCap: number) {}

  /// Lines currently held across every source.
  size(): number {
    let n = 0;
    for (const p of this.parts.values()) n += p.size;
    return n;
  }

  push(entry: T) {
    let part = this.parts.get(entry.src);
    if (!part) {
      part = new SourceRing<T>(this.quota());
      this.parts.set(entry.src, part);
    }
    part.push(entry);
    this.merged = null;
  }

  clear() {
    this.parts.clear();
    this.merged = null;
  }

  /// Tell the buffer how many sources the view is running, so quotas can be
  /// resized. Call on every source reconcile. Idempotent.
  setSourceCount(n: number) {
    const next = Math.max(1, n);
    if (next === this.sourceCount) return;
    this.sourceCount = next;
    this.recapParts();
  }

  /// Total capacity (the footer's ring-size picker). Redistributes across the
  /// existing sources, keeping each one's newest lines.
  setTotalCap(cap: number) {
    if (cap === this.totalCap) return;
    this.totalCap = cap;
    this.recapParts();
  }

  /// Every buffered line in arrival order. Memoised between pushes, because the
  /// view asks for it once per animation frame and the merge is the expensive
  /// part of a flush.
  toArray(): T[] {
    if (this.merged) return this.merged;
    const parts = [...this.parts.values()].filter((p) => p.size > 0);
    // Overwhelmingly the common case (single-pod view, or an aggregated view
    // where only one pod is talking) — skip the merge machinery entirely.
    if (parts.length === 0) return (this.merged = []);
    if (parts.length === 1) {
      const only = parts[0]!;
      const out: T[] = new Array(only.size);
      for (let i = 0; i < only.size; i++) out[i] = only.at(i);
      return (this.merged = out);
    }
    // k-way merge on the monotonic `id`. Each partition is already ascending,
    // so a linear scan over the k heads is enough; k is bounded by
    // MAX_LOG_SOURCES (24), which keeps the constant well under a heap's.
    let total = 0;
    for (const p of parts) total += p.size;
    const out: T[] = new Array(total);
    const head = new Array<number>(parts.length).fill(0);
    for (let w = 0; w < total; w++) {
      let pick = -1;
      let pickId = Infinity;
      for (let k = 0; k < parts.length; k++) {
        const h = head[k]!;
        const part = parts[k]!;
        if (h >= part.size) continue;
        const id = part.at(h).id;
        if (id < pickId) {
          pickId = id;
          pick = k;
        }
      }
      // Defensive: `total` is derived from the same sizes the heads walk, so a
      // miss is impossible unless the buffer mutated mid-merge.
      if (pick < 0) return (this.merged = out.slice(0, w));
      out[w] = parts[pick]!.at(head[pick]!);
      head[pick] = head[pick]! + 1;
    }
    return (this.merged = out);
  }

  private quota(): number {
    return perSourceCap(this.totalCap, this.sourceCount);
  }

  private recapParts() {
    const q = this.quota();
    for (const p of this.parts.values()) p.recap(q);
    this.merged = null;
  }
}
