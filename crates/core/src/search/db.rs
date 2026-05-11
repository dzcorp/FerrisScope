use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use super::{Result, SearchError};

/// DDL applied on every `open_and_init`. `IF NOT EXISTS` everywhere so
/// reopening an existing DB is a no-op. Schema changes will land as a
/// migration table later; pre-alpha we don't carry any version yet.
const SCHEMA_SQL: &str = r"
CREATE TABLE IF NOT EXISTS rows (
    kind_id     TEXT NOT NULL,
    uid         TEXT NOT NULL,
    namespace   TEXT,
    name        TEXT NOT NULL,
    blob        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    PRIMARY KEY (kind_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_rows_updated  ON rows(updated_at);
CREATE INDEX IF NOT EXISTS idx_rows_deleted  ON rows(deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(
    name, namespace, kind_id, blob,
    content='rows',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS rows_ai AFTER INSERT ON rows BEGIN
    INSERT INTO rows_fts(rowid, name, namespace, kind_id, blob)
    VALUES (new.rowid, new.name, new.namespace, new.kind_id, new.blob);
END;

-- Skip FTS churn when only `deleted_at` flipped (soft-delete / flapping-pod
-- fast path). The WHEN clause guards by FTS-relevant columns only; if the
-- shape didn't change, the FTS index already has the right tokens.
CREATE TRIGGER IF NOT EXISTS rows_au AFTER UPDATE ON rows
WHEN  old.name      <>     new.name
   OR old.namespace IS NOT new.namespace
   OR old.kind_id   <>     new.kind_id
   OR old.blob      <>     new.blob
BEGIN
    INSERT INTO rows_fts(rows_fts, rowid, name, namespace, kind_id, blob)
    VALUES('delete', old.rowid, old.name, old.namespace, old.kind_id, old.blob);
    INSERT INTO rows_fts(rowid, name, namespace, kind_id, blob)
    VALUES (new.rowid, new.name, new.namespace, new.kind_id, new.blob);
END;

CREATE TRIGGER IF NOT EXISTS rows_ad AFTER DELETE ON rows BEGIN
    INSERT INTO rows_fts(rows_fts, rowid, name, namespace, kind_id, blob)
    VALUES('delete', old.rowid, old.name, old.namespace, old.kind_id, old.blob);
END;
";

/// Resolve the on-disk path for a given cluster's index file. Cluster ids
/// can contain characters that aren't filesystem-safe (`:`, `/`, `@` for
/// SSH-tunnel sources) so we hash to a fixed 32-char hex name. Collisions
/// are astronomically unlikely with SHA-256 truncated to 128 bits, and the
/// human-readable cluster name is already in the operator's UI — they
/// never see this filename.
pub(super) fn path_for(cluster_id: &str) -> Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .ok_or(SearchError::ConfigDirUnavailable)?;
    let mut p = dirs.config_dir().to_path_buf();
    p.push("search");
    p.push(format!("{}.db", filename_for(cluster_id)));
    Ok(p)
}

fn filename_for(cluster_id: &str) -> String {
    let mut h = Sha256::new();
    h.update(cluster_id.as_bytes());
    let bytes = h.finalize();
    hex::encode(&bytes[..16])
}

pub(super) fn open_and_init(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    // WAL gives us reader / writer concurrency; without it, even a single
    // bg query blocks all upserts. NORMAL sync trades a tiny crash-recovery
    // window for ~10× write throughput vs FULL — and the search index is
    // not durable state (we can re-bootstrap on next connect), so a worst-
    // case lost batch is harmless.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // Bound SQLite's page cache. Default is 2000 pages × 4 KiB = ~8 MiB
    // per connection; with one connection per cluster this becomes
    // 8 MiB × N open clusters of pure cache, on top of the FTS5 index's
    // own working set. Negative values are interpreted as KiB by
    // SQLite, so `-2048` caps the cache at 2 MiB — plenty for the
    // single-writer access pattern we have (one writer task per
    // index, queries via `spawn_blocking` that don't hold long
    // transactions). Visible RSS win on the operator's machine
    // proportional to the number of clusters they've connected to.
    conn.pragma_update(None, "cache_size", -2048)?;
    // Disable mmap. The default mmap_size on rusqlite is 0 on most
    // platforms but be explicit — mmap'd page cache counts against
    // the process's anonymous mappings on Linux and inflates RSS
    // beyond what we'd see with the page cache alone.
    conn.pragma_update(None, "mmap_size", 0)?;
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(conn)
}
