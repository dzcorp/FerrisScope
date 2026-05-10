//! Crash- and race-safe file replacement.
//!
//! All persistent JSON config writes go through this module. Naive
//! `fs::write` truncates on open but does NOT block other writers: two
//! concurrent saves each hold their own handle at offset 0, the shorter
//! write doesn't shrink the file, and the longer write's tail is left
//! behind as trailing JSON the next reader chokes on
//! (`decode: trailing characters at line N column M`). The same hazard
//! exists on a crash mid-write — the file is left half-overwritten.
//!
//! `atomic_write` writes the payload to a sibling tempfile, then renames
//! it onto the final path. `rename` is atomic on POSIX (and Windows under
//! `ReplaceFileW`, which `tokio::fs::rename` uses), so concurrent readers
//! either see the previous file or the new file in full — never a
//! partially-overwritten head.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic counter so concurrent writers to the same final path each
/// land their bytes in a distinct tempfile. Without this, two in-flight
/// writes would race on the same `.<name>.fs.tmp` path: the rename of
/// one could remove the tempfile out from under the other's pending
/// rename, leaving an `ENOENT` error or — worse — a torn rename.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Async atomic replace. Use from tokio call sites.
///
/// Creates the parent directory if missing. The tempfile name is derived
/// from the final filename + a process-unique counter so it lives on the
/// same filesystem as the target — required for the rename to be atomic.
pub async fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = tmp_sibling(path);
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}

/// Sync atomic replace. Use from std-only call sites (sync command
/// handlers, scratch-file writers, anywhere already on `std::fs`).
pub fn atomic_write_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = tmp_sibling(path);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn tmp_sibling(path: &Path) -> std::path::PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    // Leading dot keeps the temp hidden from casual `ls`. PID + a
    // monotonic counter make the name unique across concurrent writers
    // within this process, and across separate processes hammering the
    // same config (uncommon, but the user-prefs case at app startup can
    // hit it). The `.fs.tmp` suffix is distinctive enough that orphans
    // from a crash between write and rename are obvious; the next
    // successful write replaces the final path, and orphans are
    // harmless until the next maintenance sweep.
    let pid = std::process::id();
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{stem}.fs.{pid}.{seq}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Barrier;

    #[tokio::test]
    async fn race_does_not_corrupt() {
        // Hammer the same path with concurrent writes of different sizes
        // and verify the final file always equals one of the inputs in
        // full — never a mix.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let long = b"{\n  \"sessions\": [ \"a\", \"b\", \"c\", \"d\", \"e\", \"f\" ]\n}".to_vec();
        let short = b"{\n  \"sessions\": []\n}".to_vec();
        let barrier = Arc::new(Barrier::new(2));
        let (b1, b2) = (barrier.clone(), barrier);
        let (p1, p2) = (path.clone(), path.clone());
        let (long_c, short_c) = (long.clone(), short.clone());
        let h1 = tokio::spawn(async move {
            b1.wait().await;
            atomic_write(&p1, &long_c).await.unwrap();
        });
        let h2 = tokio::spawn(async move {
            b2.wait().await;
            atomic_write(&p2, &short_c).await.unwrap();
        });
        h1.await.unwrap();
        h2.await.unwrap();
        let got = tokio::fs::read(&path).await.unwrap();
        assert!(
            got == long || got == short,
            "file landed in a torn state: {got:?}",
        );
    }

    #[test]
    fn sync_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/c/data.json");
        atomic_write_sync(&path, b"{\"k\":1}").unwrap();
        let got = std::fs::read(&path).unwrap();
        assert_eq!(got, b"{\"k\":1}");
    }
}
