//! Safe wrappers around mimalloc's extended API entry points.
//!
//! The high-level `mimalloc` crate only exposes a `GlobalAlloc` impl;
//! anything beyond `alloc` / `dealloc` requires going through
//! `libmimalloc-sys`, which is `unsafe`. That conflicts with the
//! workspace-wide `forbid(unsafe_code)` lint, so this crate exists as
//! a single-purpose shim that takes the lint relaxation locally and
//! exposes a tiny safe API back to the rest of the workspace.
//!
//! Today the only entry point is [`collect`]. Add more here if and
//! when we find another mimalloc extension we genuinely need —
//! `mi_stats_print`, `mi_stats_reset`, `mi_heap_collect`, etc.

/// mimalloc's own view of the process. Read with [`process_info`].
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessInfo {
    pub current_rss: usize,
    pub peak_rss: usize,
    pub current_commit: usize,
    pub peak_commit: usize,
    pub page_faults: usize,
}

/// Query mimalloc for its accounting of the process's memory use.
///
/// `current_rss` / `peak_rss` are precise on Windows / macOS, estimated
/// on Linux from `current_commit`. `current_commit` is the read/write
/// memory mimalloc has reserved — closer to the working set than RSS
/// because it excludes pages the kernel has paged out. The delta
/// between `current_commit` and what the OS reports as RSS is the
/// allocator's "ready to reuse" inventory.
pub fn process_info() -> ProcessInfo {
    let mut info = ProcessInfo::default();
    // SAFETY: `mi_process_info` writes to seven `usize` out-params we
    // own. No preconditions beyond mimalloc being active.
    unsafe {
        let mut elapsed = 0usize;
        let mut user = 0usize;
        let mut sys = 0usize;
        libmimalloc_sys::mi_process_info(
            &mut elapsed,
            &mut user,
            &mut sys,
            &mut info.current_rss,
            &mut info.peak_rss,
            &mut info.current_commit,
            &mut info.peak_commit,
            &mut info.page_faults,
        );
    }
    info
}

/// Switch mimalloc's free-page policy from `MADV_FREE` (Linux default,
/// lazy reclaim) to `MADV_DONTNEED` (immediate RSS decrement). Set the
/// purge delay to 0 so memory is returned the moment a span goes
/// fully free, not after the default 10s grace window.
///
/// **Why this exists.** On Linux, mimalloc's default purge uses
/// `madvise(addr, len, MADV_FREE)`. The kernel marks those pages
/// reclaimable but leaves them in the process's `RssAnon` count until
/// memory pressure forces eviction — which, on a developer's
/// workstation with plenty of free RAM, never happens. The operator
/// sees `top` / `htop` show 500 MB RSS for FerrisScope after a brief
/// excursion into a large cluster even though the Rust heap genuinely
/// shrank. Switching to `MADV_DONTNEED` zeros the pages immediately
/// and removes them from the resident set on the next stats read.
///
/// **Trade-off.** `MADV_DONTNEED` is slower than `MADV_FREE` because
/// the kernel must zero pages on the next fault. For us this is
/// nothing — we don't have a hot path that re-touches just-freed
/// pages. The visible-RSS win is worth the microsecond difference.
///
/// **Call site.** Use [`init_purge_policy`] from `main` *before* any
/// substantial allocation. We also set the matching env vars (which
/// mimalloc reads on its first allocation) so the policy takes effect
/// from the very first arena, not just from new arenas after the
/// `mi_option_set` call.
///
/// Numeric IDs are pinned to mimalloc v3 (the version
/// `libmimalloc-sys` 0.1.47 bundles by default). The named constants
/// in `libmimalloc_sys::*` map to v2 IDs and are wrong for v3 — do
/// not use them. If `libmimalloc-sys` is upgraded, re-verify against
/// `c_src/mimalloc/v3/include/mimalloc.h` (search for
/// `mi_option_purge_decommits` and count its enum position).
const MI_OPTION_PURGE_DECOMMITS_V3: i32 = 5;
const MI_OPTION_PURGE_DELAY_V3: i32 = 15;

pub fn init_purge_policy() {
    // Env vars: read by mimalloc on its first allocation; the safest
    // belt because `mi_option_set` only affects allocations made
    // after the call, and Rust's runtime is free to allocate before
    // `main` runs.
    //
    // SAFETY: `set_var` is `unsafe` in Edition 2024+ because
    // concurrent reads can be unsound; here we are single-threaded
    // at process startup (called as the first line of `main`).
    // SAFETY: pre-main, single-threaded.
    unsafe {
        std::env::set_var("MIMALLOC_PURGE_DECOMMITS", "1");
        std::env::set_var("MIMALLOC_PURGE_DELAY", "0");
    }

    // Runtime option_set: suspenders in case mimalloc already
    // initialised before we got here (e.g. Rust runtime allocations
    // during argv parsing). New allocations honour the updated
    // option immediately.
    //
    // SAFETY: `mi_option_set` is thread-safe per mimalloc docs;
    // option IDs are version-specific (see the doc comment on
    // `MI_OPTION_*_V3` above).
    unsafe {
        libmimalloc_sys::mi_option_set(MI_OPTION_PURGE_DECOMMITS_V3, 1);
        libmimalloc_sys::mi_option_set(MI_OPTION_PURGE_DELAY_V3, 0);
    }
}

/// Force mimalloc to return retained arena pages to the OS.
///
/// mimalloc keeps freed pages in per-thread arenas for fast re-use; on
/// long-running processes those arenas can sit at the high-water mark
/// of a past burst (typically the kube watcher's initial sync — typed
/// `Pod` deserialisation + intermediate JSON projection + IPC
/// serialisation all churn lots of small allocations). Calling this
/// after a burst is the difference between RSS settling near the
/// steady-state working set vs. plateauing at the burst peak.
///
/// `force = true` is "scan everything, return what you can"; `false`
/// is a cheaper opportunistic pass. Use `true` from a dev / manual
/// trigger, `false` from automatic post-burst hooks where the small
/// extra cost of a forced scan isn't justified.
///
/// Thread-safe; brief allocator lock-out while pages are scanned.
pub fn collect(force: bool) {
    // SAFETY: `mi_collect` has no preconditions beyond mimalloc being
    // the active allocator (enforced by `#[global_allocator]` in
    // `ferrisscope` binary's `main.rs`). It is documented thread-safe
    // and never returns errors.
    unsafe { libmimalloc_sys::mi_collect(force) }
}
