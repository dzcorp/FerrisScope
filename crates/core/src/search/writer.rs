use crate::sync::LockExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::db::open_and_init;
use super::{IndexCommand, Result, SearchError, WriteOp};

/// Max writes coalesced into a single SQLite transaction.
const BATCH_MAX: usize = 500;
/// Max time the writer holds an open batch before flushing — puts a ceiling
/// on the lag between a row appearing in the table and showing up in
/// search.
const BATCH_WINDOW: Duration = Duration::from_millis(200);

pub(super) async fn writer_loop(path: PathBuf, mut rx: mpsc::UnboundedReceiver<IndexCommand>) {
    let conn = match tokio::task::spawn_blocking(move || open_and_init(&path)).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            tracing::error!(error = %e, "search index: failed to open DB; writer exiting");
            // Drain incoming commands so callers don't see a closed channel
            // for the wrong reason; their reply channels still resolve to
            // WriterGone via the `_ = reply.send(...)` path below.
            drain_with_writer_gone(&mut rx).await;
            return;
        }
        Err(e) => {
            tracing::error!(error = %e, "search index: writer init join failed");
            drain_with_writer_gone(&mut rx).await;
            return;
        }
    };
    // `Arc<Mutex<Connection>>` lets us hand the connection into
    // `spawn_blocking` for queries / GC without giving up ownership. The
    // mutex is uncontended (only this task holds the Arc) but it's the
    // cheapest way to satisfy the move requirement.
    let conn = Arc::new(Mutex::new(conn));

    let mut buffer: Vec<WriteOp> = Vec::with_capacity(BATCH_MAX);
    let mut window_start: Option<Instant> = None;

    loop {
        let cmd = if buffer.is_empty() {
            rx.recv().await
        } else {
            let started = window_start.expect("non-empty buffer must have window_start");
            match tokio::time::timeout_at(started + BATCH_WINDOW, rx.recv()).await {
                Ok(c) => c,
                Err(_) => {
                    flush(&conn, &mut buffer).await;
                    window_start = None;
                    continue;
                }
            }
        };
        match cmd {
            None => break,
            Some(IndexCommand::Write(op)) => {
                if buffer.is_empty() {
                    window_start = Some(Instant::now());
                }
                buffer.push(op);
                if buffer.len() >= BATCH_MAX {
                    flush(&conn, &mut buffer).await;
                    window_start = None;
                }
            }
            Some(IndexCommand::Search {
                query,
                limit,
                reply,
            }) => {
                if !buffer.is_empty() {
                    flush(&conn, &mut buffer).await;
                    window_start = None;
                }
                let conn_c = conn.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let c = conn_c.lock_recover();
                    super::query::run(&c, &query, limit)
                })
                .await
                .unwrap_or_else(|e| Err(SearchError::Io(std::io::Error::other(e.to_string()))));
                let _ = reply.send(result);
            }
            Some(IndexCommand::Gc {
                tombstone_age,
                stale_age,
                reply,
            }) => {
                if !buffer.is_empty() {
                    flush(&conn, &mut buffer).await;
                    window_start = None;
                }
                let conn_c = conn.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let c = conn_c.lock_recover();
                    super::gc::run(&c, tombstone_age, stale_age)
                })
                .await
                .unwrap_or_else(|e| Err(SearchError::Io(std::io::Error::other(e.to_string()))));
                let _ = reply.send(result);
            }
            Some(IndexCommand::NewestUpdatedAt { reply }) => {
                if !buffer.is_empty() {
                    flush(&conn, &mut buffer).await;
                    window_start = None;
                }
                let conn_c = conn.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let c = conn_c.lock_recover();
                    newest_updated_at(&c)
                })
                .await
                .unwrap_or_else(|e| Err(SearchError::Io(std::io::Error::other(e.to_string()))));
                let _ = reply.send(result);
            }
        }
    }

    if !buffer.is_empty() {
        flush(&conn, &mut buffer).await;
    }
    tracing::debug!("search index: writer loop exiting");
}

async fn flush(conn: &Arc<Mutex<Connection>>, buffer: &mut Vec<WriteOp>) {
    if buffer.is_empty() {
        return;
    }
    let to_flush = std::mem::take(buffer);
    let n = to_flush.len();
    let conn = conn.clone();
    let started = std::time::Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        let mut c = conn.lock_recover();
        apply_writes(&mut c, &to_flush)
    })
    .await;
    match result {
        Ok(Ok(())) => {
            tracing::trace!(
                n,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "search index: flushed batch"
            );
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, n, "search index: flush failed");
        }
        Err(e) => {
            tracing::warn!(error = %e, n, "search index: flush join failed");
        }
    }
}

fn apply_writes(conn: &mut Connection, ops: &[WriteOp]) -> Result<()> {
    let now = unix_ms();
    let tx = conn.transaction()?;
    for op in ops {
        match op {
            WriteOp::Upsert {
                kind_id,
                uid,
                namespace,
                name,
                blob,
            } => {
                tx.execute(
                    "INSERT INTO rows (kind_id, uid, namespace, name, blob, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
                     ON CONFLICT(kind_id, uid) DO UPDATE SET
                        namespace = excluded.namespace,
                        name = excluded.name,
                        blob = excluded.blob,
                        updated_at = excluded.updated_at,
                        deleted_at = NULL",
                    rusqlite::params![kind_id, uid, namespace, name, blob, now],
                )?;
            }
            WriteOp::Delete { kind_id, uid } => {
                // Soft delete only — leaves the FTS row in place but the
                // SELECT filter on `deleted_at IS NULL` excludes it. GC
                // sweeps tombstones older than the configured age.
                tx.execute(
                    "UPDATE rows SET deleted_at = ?1 WHERE kind_id = ?2 AND uid = ?3
                     AND deleted_at IS NULL",
                    rusqlite::params![now, kind_id, uid],
                )?;
            }
            WriteOp::Retain { kind_id, keep_uids } => {
                // Stage the keep-set in a temp table so the reconcile is one
                // indexed UPDATE regardless of listing size, instead of an
                // unboundedly long `NOT IN (?, ?, …)` parameter list.
                tx.execute_batch(
                    "CREATE TEMP TABLE IF NOT EXISTS retain_keep (uid TEXT PRIMARY KEY);
                     DELETE FROM retain_keep;",
                )?;
                {
                    let mut ins =
                        tx.prepare_cached("INSERT OR IGNORE INTO retain_keep (uid) VALUES (?1)")?;
                    for uid in keep_uids {
                        ins.execute(rusqlite::params![uid])?;
                    }
                }
                // Soft delete, same as `Delete` — a re-upsert (object came
                // back / listing raced a create) flips `deleted_at` to NULL.
                tx.execute(
                    "UPDATE rows SET deleted_at = ?1
                     WHERE kind_id = ?2 AND deleted_at IS NULL
                       AND uid NOT IN (SELECT uid FROM retain_keep)",
                    rusqlite::params![now, kind_id],
                )?;
                tx.execute("DELETE FROM retain_keep", [])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

async fn drain_with_writer_gone(rx: &mut mpsc::UnboundedReceiver<IndexCommand>) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            IndexCommand::Write(_) => {}
            IndexCommand::Search { reply, .. } => {
                let _ = reply.send(Err(SearchError::WriterGone));
            }
            IndexCommand::Gc { reply, .. } => {
                let _ = reply.send(Err(SearchError::WriterGone));
            }
            IndexCommand::NewestUpdatedAt { reply } => {
                let _ = reply.send(Err(SearchError::WriterGone));
            }
        }
    }
}

fn newest_updated_at(conn: &Connection) -> Result<Option<i64>> {
    // Live rows only — a tombstone-only DB shouldn't read as "fresh" to
    // the bootstrap freshness gate.
    let mut stmt =
        conn.prepare_cached("SELECT MAX(updated_at) FROM rows WHERE deleted_at IS NULL")?;
    let value: Option<i64> = stmt
        .query_row([], |row| row.get::<_, Option<i64>>(0))
        .unwrap_or(None);
    Ok(value)
}

fn unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::db::open_in_memory_for_tests;

    fn upsert(kind: &str, uid: &str, name: &str) -> WriteOp {
        WriteOp::Upsert {
            kind_id: kind.to_owned(),
            uid: uid.to_owned(),
            namespace: Some("default".to_owned()),
            name: name.to_owned(),
            blob: format!("{{\"name\":\"{name}\"}}"),
        }
    }

    fn live_names(conn: &Connection, kind: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM rows WHERE kind_id = ?1 AND deleted_at IS NULL ORDER BY name",
            )
            .unwrap();
        stmt.query_map([kind], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn upsert_then_delete_then_reupsert_revives_the_row() {
        let mut conn = open_in_memory_for_tests();
        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        assert_eq!(live_names(&conn, "pods"), vec!["api-0"]);

        apply_writes(
            &mut conn,
            &[WriteOp::Delete {
                kind_id: "pods".into(),
                uid: "u1".into(),
            }],
        )
        .unwrap();
        assert!(live_names(&conn, "pods").is_empty());

        // Flapping-pod fast path: a re-upsert flips deleted_at back to NULL.
        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        assert_eq!(live_names(&conn, "pods"), vec!["api-0"]);
    }

    #[test]
    fn retain_tombstones_unlisted_rows_of_that_kind_only() {
        let mut conn = open_in_memory_for_tests();
        apply_writes(
            &mut conn,
            &[
                upsert("pods", "u1", "api-0"),
                upsert("pods", "u2", "gone-0"),
                upsert("deployments", "u3", "api"),
            ],
        )
        .unwrap();

        apply_writes(
            &mut conn,
            &[WriteOp::Retain {
                kind_id: "pods".into(),
                keep_uids: vec!["u1".into()],
            }],
        )
        .unwrap();

        // gone-0 tombstoned, api-0 kept, the other kind untouched.
        assert_eq!(live_names(&conn, "pods"), vec!["api-0"]);
        assert_eq!(live_names(&conn, "deployments"), vec!["api"]);
    }

    #[test]
    fn retain_with_empty_keep_set_tombstones_the_whole_kind() {
        let mut conn = open_in_memory_for_tests();
        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        apply_writes(
            &mut conn,
            &[WriteOp::Retain {
                kind_id: "pods".into(),
                keep_uids: vec![],
            }],
        )
        .unwrap();
        assert!(live_names(&conn, "pods").is_empty());
    }

    #[test]
    fn consecutive_retains_in_one_batch_use_their_own_keep_sets() {
        let mut conn = open_in_memory_for_tests();
        apply_writes(
            &mut conn,
            &[upsert("pods", "u1", "api-0"), upsert("pods", "u2", "api-1")],
        )
        .unwrap();
        // Same transaction — the temp keep-table must be cleared between
        // ops, or the first op's u1 would leak into the second's keep set
        // and api-0 would wrongly survive.
        apply_writes(
            &mut conn,
            &[
                WriteOp::Retain {
                    kind_id: "pods".into(),
                    keep_uids: vec!["u1".into(), "u2".into()],
                },
                WriteOp::Retain {
                    kind_id: "pods".into(),
                    keep_uids: vec!["u2".into()],
                },
            ],
        )
        .unwrap();
        assert_eq!(live_names(&conn, "pods"), vec!["api-1"]);
    }
}
