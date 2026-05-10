//! Crash- and race-safe file replacement for the agent crate's persistent
//! state (`agent/index.json`, `agent/models_dev.json`, …).
//!
//! Mirrors `ferrisscope_core::atomic_write` but lives here so the agent
//! crate stays self-contained — `agent` deliberately doesn't depend on
//! `core` (they're peers under a future TUI / CLI). Keep the two
//! implementations identical; if you change one, change the other.
//!
//! Why atomic: naive `fs::write` truncates on open but does NOT block
//! other writers. Two concurrent saves each hold their own handle at
//! offset 0 — the shorter write doesn't shrink the file, and the longer
//! write's tail is left as trailing JSON (`decode: trailing characters
//! at line N column M`). Crashes mid-write have the same hazard.
//!
//! Mechanism: write to a sibling tempfile, then rename onto the final
//! path. Rename is atomic on POSIX (and Windows under `ReplaceFileW`).
//! Readers see either the old file or the new file in full.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub async fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = tmp_sibling(path);
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}

fn tmp_sibling(path: &Path) -> std::path::PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    // PID + monotonic counter so concurrent writers each land in a
    // distinct tempfile, avoiding a rename-vs-write race.
    let pid = std::process::id();
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{stem}.fs.{pid}.{seq}.tmp"))
}
