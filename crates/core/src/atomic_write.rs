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
//! `atomic_write` writes the payload to a sibling tempfile, `fsync`s it,
//! then renames it onto the final path and `fsync`s the parent directory.
//! `rename` is atomic on POSIX (and Windows under `ReplaceFileW`, which
//! `tokio::fs::rename` uses), so concurrent readers either see the previous
//! file or the new file in full — never a partially-overwritten head.
//!
//! The `fsync`s are what make the *crash* half of that claim true. Without
//! them the rename is a metadata operation that can reach disk ahead of the
//! data it points at, so a power loss inside the writeback window leaves a
//! zero-length file where the old one used to be. ext4's `auto_da_alloc`
//! usually papers over this; XFS, btrfs, and ext4 mounted `noauto_da_alloc`
//! do not.

use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt as _;

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
    let res = async {
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(bytes).await?;
        // Without this the rename is only atomic against concurrent *readers*.
        // A crash can still reorder the (metadata) rename ahead of the (data)
        // writeback and leave a zero-length file where the old one was.
        f.sync_all().await?;
        drop(f);
        tokio::fs::rename(&tmp, path).await?;
        Ok(())
    }
    .await;
    if res.is_err() {
        // Never leave the payload behind under a temp name: for the kubeconfig
        // path that payload is the operator's certs and tokens.
        let _ = tokio::fs::remove_file(&tmp).await;
    } else {
        sync_parent_dir(path);
    }
    res
}

/// Sync atomic replace. Use from std-only call sites (sync command
/// handlers, scratch-file writers, anywhere already on `std::fs`).
pub fn atomic_write_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    atomic_write_sync_mode(path, bytes, None)
}

/// [`atomic_write_sync`] that also pins the resulting file's unix mode.
///
/// The rename that makes this atomic **replaces the target's inode**, so the
/// final file carries the *tempfile's* permissions, not the ones the target had
/// before. For ordinary config that's fine (0644 either way). For a file the
/// user has deliberately locked down — a kubeconfig at 0600, holding client
/// certs and bearer tokens — silently rewriting it as 0644 would be a
/// credential leak caused purely by an unrelated edit.
///
/// Passing `Some(mode)` chmods the tempfile *before* the rename, so the target
/// is never observable with looser permissions than it started with. `None`
/// keeps the previous behaviour.
///
/// The mode is a no-op on Windows, where the inherited ACL governs access.
pub fn atomic_write_sync_mode(path: &Path, bytes: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = tmp_sibling(path);
    let res = write_tmp_then_rename(&tmp, path, bytes, mode);
    if res.is_err() {
        // Every error return below leaves a tempfile holding the full payload.
        // For the kubeconfig that payload is `client-key-data` and bearer
        // tokens, and the tempfile is a sibling in `~/.kube/`, which is 0755 on
        // a stock install. Orphaning one is a credential leak that outlives the
        // failure, so clean up on every path out.
        let _ = std::fs::remove_file(&tmp);
    } else {
        sync_parent_dir(path);
    }
    res
}

fn write_tmp_then_rename(
    tmp: &Path,
    path: &Path,
    bytes: &[u8],
    mode: Option<u32>,
) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // Create *already* restricted rather than chmod-after-write. The old
        // order (`fs::write` then `set_permissions`) published the full payload
        // at `0o666 & !umask` — 0644 on a stock box — for the duration of the
        // write, and left it there permanently if the chmod or the rename then
        // failed. `None` keeps the historical default for ordinary app config.
        opts.mode(mode.unwrap_or(0o666));
    }
    let mut f = opts.open(tmp)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        // `open`'s mode argument is masked by umask, so a restrictive umask
        // could land *tighter* than asked. Set the exact bits now, while the
        // file is still empty.
        use std::os::unix::fs::PermissionsExt as _;
        f.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    f.write_all(bytes)?;
    // See the async twin: rename alone is race-safe, not crash-safe.
    f.sync_all()?;
    drop(f);
    std::fs::rename(tmp, path)
}

/// `fsync` the directory holding `path`, so the rename itself survives a crash.
///
/// Best-effort and deliberately infallible: the bytes are already durable at
/// this point, and on Windows a directory can't be opened as a file at all.
/// Failing the whole write because the parent couldn't be synced would turn a
/// weaker durability guarantee into a hard error.
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// The unix mode of an existing file, for round-tripping through
/// [`atomic_write_sync_mode`]. `None` on Windows or when the file is gone.
#[must_use]
pub fn file_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::metadata(path)
            .ok()
            .map(|m| m.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
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

    #[cfg(unix)]
    #[test]
    fn mode_variant_pins_permissions_through_the_rename() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.yaml");
        std::fs::write(&path, b"before").unwrap();

        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;

        // The plain variant renames a default-mode tempfile over the target, so
        // the target's own mode is lost. This is the trap the mode variant
        // exists to close — asserted so a future refactor of
        // `atomic_write_sync` can't silently make the two behave alike.
        //
        // The probe mode is 0o700 rather than the realistic 0o600 on purpose.
        // A tempfile's default is `0o666 & !umask`, which can never carry an
        // execute bit — so this assertion holds under any umask. Probing with
        // 0o600 would pass only because the ambient umask happens to be 022:
        // under `umask 077` the default *is* 0o600, and the test would fail
        // against entirely correct code.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        atomic_write_sync(&path, b"loosened").unwrap();
        assert_ne!(mode(&path), 0o700);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        atomic_write_sync_mode(&path, b"kept", Some(0o600)).unwrap();
        assert_eq!(mode(&path), 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"kept");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_leaves_no_tempfile_behind() {
        // The tempfile holds the *whole* payload — for the kubeconfig, certs
        // and bearer tokens — and lands beside the target in a directory that
        // is 0755 on a stock install. An orphan is a credential leak that
        // outlives the failure, so no error path may leave one.
        //
        // A directory as the target makes `rename` fail after the bytes are
        // already written, which is the exact shape being guarded.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("adir");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("occupant"), b"x").unwrap();

        let err = atomic_write_sync_mode(&target, b"secret-bearer-token", Some(0o600))
            .expect_err("rename onto a non-empty directory must fail");
        assert!(
            err.kind() != std::io::ErrorKind::NotFound,
            "expected the rename to fail, not the open: {err}"
        );

        let strays: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            // `.fs.` is the distinctive marker `tmp_sibling` stamps in, so this
            // can't be fooled by an unrelated `.tmp` the test didn't create.
            .filter(|n| n.contains(".fs."))
            .collect();
        assert!(
            strays.is_empty(),
            "tempfile orphaned after failure: {strays:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_tempfile_is_never_observable_with_loose_permissions() {
        use std::os::unix::fs::PermissionsExt as _;

        // Regression for the create-then-chmod ordering: `fs::write` published
        // the payload at `0o666 & !umask` and only tightened it afterwards, so
        // the credentials were world-readable for the length of the write and
        // stayed that way if the chmod or rename then failed. Creating the file
        // already-restricted closes both windows at once.
        //
        // Observed via the orphan a failed rename would have left, since the
        // in-flight window itself isn't addressable from a test.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("adir");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("occupant"), b"x").unwrap();

        // Same failure, but with cleanup suppressed by making the temp
        // undeletable is not portable — instead assert the mode the helper
        // opens with, directly.
        let tmp = dir.path().join("probe.tmp");
        write_tmp_then_rename(&tmp, &target, b"secret", Some(0o600))
            .expect_err("rename onto a non-empty directory must fail");
        let mode = std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "payload was observable at {mode:o} before the rename"
        );
        assert_eq!(std::fs::read(&tmp).unwrap(), b"secret");
    }

    #[cfg(unix)]
    #[test]
    fn file_mode_reads_back_what_was_set() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, b"x").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(file_mode(&path), Some(0o640));
        assert_eq!(file_mode(&dir.path().join("missing")), None);
    }
}
