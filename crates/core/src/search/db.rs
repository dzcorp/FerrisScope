use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use super::{Result, SearchError};

// Indexes are per-session caches: the directory is cleared at startup and
// each index opens on an empty file that the connect-time bootstrap refills,
// so no schema ever needs migrating and nothing stale outlives a session.
const DIR: &str = "search";
const TRASH_PREFIX: &str = "search.trash-";

/// DDL applied on every `open_and_init`. `IF NOT EXISTS` everywhere so
/// reopening an existing DB is a no-op.
const SCHEMA_SQL: &str = r"
CREATE TABLE IF NOT EXISTS rows (
    kind_id     TEXT NOT NULL,
    uid         TEXT NOT NULL,
    namespace   TEXT,
    name        TEXT NOT NULL,
    labels      TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    PRIMARY KEY (kind_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_rows_updated  ON rows(updated_at);
CREATE INDEX IF NOT EXISTS idx_rows_deleted  ON rows(deleted_at);

-- Only identity + labels are indexed: they rarely change, so a pod's status
-- churn never rewrites its trigrams (indexing the full row grew one
-- cluster's index to 2.6 GB for 14k live rows).
CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(
    name, namespace, kind_id, labels,
    content='rows',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS rows_ai AFTER INSERT ON rows BEGIN
    INSERT INTO rows_fts(rowid, name, namespace, kind_id, labels)
    VALUES (new.rowid, new.name, new.namespace, new.kind_id, new.labels);
END;

-- Skip FTS churn when only `deleted_at` flipped (soft-delete / flapping-pod
-- fast path). The WHEN clause guards by FTS-relevant columns only; if the
-- shape didn't change, the FTS index already has the right tokens.
CREATE TRIGGER IF NOT EXISTS rows_au AFTER UPDATE ON rows
WHEN  old.name      <>     new.name
   OR old.namespace IS NOT new.namespace
   OR old.kind_id   <>     new.kind_id
   OR old.labels    <>     new.labels
BEGIN
    INSERT INTO rows_fts(rows_fts, rowid, name, namespace, kind_id, labels)
    VALUES('delete', old.rowid, old.name, old.namespace, old.kind_id, old.labels);
    INSERT INTO rows_fts(rowid, name, namespace, kind_id, labels)
    VALUES (new.rowid, new.name, new.namespace, new.kind_id, new.labels);
END;

CREATE TRIGGER IF NOT EXISTS rows_ad AFTER DELETE ON rows BEGIN
    INSERT INTO rows_fts(rows_fts, rowid, name, namespace, kind_id, labels)
    VALUES('delete', old.rowid, old.name, old.namespace, old.kind_id, old.labels);
END;
";

/// Resolve the on-disk path for a given cluster's index file. Cluster ids
/// can contain characters that aren't filesystem-safe (`:`, `/`, `@` for
/// SSH-tunnel sources) so we hash to a fixed 32-char hex name.
pub(super) fn path_for(cluster_id: &str) -> Result<PathBuf> {
    let mut p = config_dir()?;
    p.push(DIR);
    p.push(format!("{}.db", filename_for(cluster_id)));
    Ok(p)
}

fn config_dir() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .ok_or(SearchError::ConfigDirUnavailable)?;
    Ok(dirs.config_dir().to_path_buf())
}

fn filename_for(cluster_id: &str) -> String {
    let mut h = Sha256::new();
    h.update(cluster_id.as_bytes());
    let bytes = h.finalize();
    hex::encode(&bytes[..16])
}

/// Clear every index left by a previous session without blocking: the
/// directory is renamed aside (constant time) and deleted on a background
/// thread, along with trash from any earlier run that died mid-delete.
/// Failures are logged; indexes open fresh regardless.
pub(super) fn reset() -> Result<()> {
    reset_in(&config_dir()?);
    Ok(())
}

fn reset_in(config: &Path) -> Option<std::thread::JoinHandle<()>> {
    let dir = config.join(DIR);
    if dir.exists() {
        let trash = config.join(format!(
            "{TRASH_PREFIX}{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        if let Err(e) = std::fs::rename(&dir, &trash) {
            tracing::warn!(error = %e, "search index: could not clear previous indexes");
        }
    }
    let trash: Vec<PathBuf> = std::fs::read_dir(config)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(TRASH_PREFIX))
        .map(|e| e.path())
        .collect();
    if trash.is_empty() {
        return None;
    }
    std::thread::Builder::new()
        .name("search-cleanup".into())
        .spawn(move || {
            for t in trash {
                if let Err(e) = std::fs::remove_dir_all(&t) {
                    tracing::warn!(error = %e, path = %t.display(), "search index: cleanup failed");
                }
            }
        })
        .ok()
}

fn remove_db_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

/// Open an empty index at `path`, discarding whatever a previous connection
/// left there (a reconnect re-bootstraps into it).
pub(super) fn open_index(path: &Path) -> Result<Connection> {
    remove_db_files(path);
    open_and_init(path)
}

pub(super) fn open_and_init(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    // A just-aborted forwarder can still hold the previous handle while a
    // reconnect opens this one; without a busy timeout a write colliding
    // with a checkpoint returns SQLITE_BUSY immediately and the batch drops.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // Must precede `journal_mode` and the first table; lets GC hand freed
    // pages back with `incremental_vacuum`.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    // WAL gives reader / writer concurrency. NORMAL sync trades a tiny
    // crash-recovery window for ~10× write throughput; the index is a cache.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // Cap the page cache at 2 MiB (negative = KiB) instead of the ~8 MiB
    // default, per open cluster.
    conn.pragma_update(None, "cache_size", -2048)?;
    // mmap'd pages would count as process RSS.
    conn.pragma_update(None, "mmap_size", 0)?;
    // Keep a checkpointed WAL from lingering at its high-water size.
    conn.pragma_update(None, "journal_size_limit", 4 * 1024 * 1024)?;
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(conn)
}

/// In-memory connection with the production schema applied — for unit tests
/// of the query / gc / writer layers.
#[cfg(test)]
pub(super) fn open_in_memory_for_tests() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch(SCHEMA_SQL).expect("schema");
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM rows", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn open_index_always_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("idx.db");
        {
            let conn = open_index(&path).unwrap();
            conn.execute(
                "INSERT INTO rows VALUES ('pods', 'u1', 'ns', 'api-0', '', 1, NULL)",
                [],
            )
            .unwrap();
            assert_eq!(row_count(&conn), 1);
        }
        assert_eq!(row_count(&open_index(&path).unwrap()), 0);
    }

    #[test]
    fn open_index_replaces_a_garbage_or_foreign_file() {
        let dir = tempfile::tempdir().unwrap();
        let garbage = dir.path().join("garbage.db");
        std::fs::write(&garbage, vec![0xAB; 8192]).unwrap();
        assert_eq!(row_count(&open_index(&garbage).unwrap()), 0);

        // An old-layout index (different `rows` columns) is discarded too.
        let old = dir.path().join("old.db");
        Connection::open(&old)
            .unwrap()
            .execute_batch("CREATE TABLE rows (kind_id TEXT, blob TEXT)")
            .unwrap();
        assert_eq!(row_count(&open_index(&old).unwrap()), 0);
    }

    #[test]
    fn fresh_db_uses_incremental_auto_vacuum() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_index(&dir.path().join("idx.db")).unwrap();
        let mode: i32 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, 2, "2 = INCREMENTAL");
    }

    #[test]
    fn reset_moves_the_dir_aside_and_deletes_it_in_the_background() {
        let config = tempfile::tempdir().unwrap();
        let dir = config.path().join(DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.db"), b"old").unwrap();
        let stale_trash = config.path().join(format!("{TRASH_PREFIX}1"));
        std::fs::create_dir_all(&stale_trash).unwrap();
        let unrelated = config.path().join("prefs.json");
        std::fs::write(&unrelated, b"{}").unwrap();

        let cleaner = reset_in(config.path()).expect("cleanup thread");
        assert!(!dir.exists(), "moved aside before returning");
        cleaner.join().unwrap();

        let left: Vec<_> = std::fs::read_dir(config.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, vec!["prefs.json"]);
        assert!(reset_in(config.path()).is_none(), "nothing left to do");
    }
}
