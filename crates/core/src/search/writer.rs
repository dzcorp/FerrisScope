use crate::sync::LockExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::db::open_index;
use super::{IndexCommand, Result, SearchError, WriteOp};

/// Max writes coalesced into a single SQLite transaction.
const BATCH_MAX: usize = 500;
/// Max time the writer holds an open batch before flushing — puts a ceiling
/// on the lag between a row appearing in the table and showing up in
/// search.
const BATCH_WINDOW: Duration = Duration::from_millis(200);
/// An upsert whose indexed fields are unchanged only rewrites the row to
/// refresh `updated_at` (the stale-GC clock) once this much time has passed.
const TOUCH_INTERVAL_MS: i64 = 60 * 60 * 1000;

pub(super) async fn writer_loop(path: PathBuf, mut rx: mpsc::UnboundedReceiver<IndexCommand>) {
    let conn = match tokio::task::spawn_blocking(move || open_index(&path)).await {
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
                labels,
            } => {
                tx.prepare_cached(
                    "INSERT INTO rows (kind_id, uid, namespace, name, labels, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
                     ON CONFLICT(kind_id, uid) DO UPDATE SET
                        namespace = excluded.namespace,
                        name = excluded.name,
                        labels = excluded.labels,
                        updated_at = excluded.updated_at,
                        deleted_at = NULL
                     WHERE rows.deleted_at IS NOT NULL
                        OR rows.name <> excluded.name
                        OR rows.namespace IS NOT excluded.namespace
                        OR rows.labels <> excluded.labels
                        OR rows.updated_at < excluded.updated_at - ?7",
                )?
                .execute(rusqlite::params![
                    kind_id,
                    uid,
                    namespace,
                    name,
                    labels,
                    now,
                    TOUCH_INTERVAL_MS
                ])?;
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
        }
    }
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
            labels: String::new(),
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

    fn updated_at(conn: &Connection, uid: &str) -> i64 {
        conn.query_row("SELECT updated_at FROM rows WHERE uid = ?1", [uid], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn unchanged_upsert_skips_the_write_until_the_touch_interval() {
        let mut conn = open_in_memory_for_tests();
        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        conn.execute("UPDATE rows SET updated_at = updated_at - 1000", [])
            .unwrap();
        let before = updated_at(&conn, "u1");

        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        assert_eq!(
            updated_at(&conn, "u1"),
            before,
            "no-op upsert must not write"
        );

        conn.execute(
            "UPDATE rows SET updated_at = updated_at - ?1",
            [TOUCH_INTERVAL_MS],
        )
        .unwrap();
        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        assert!(
            updated_at(&conn, "u1") > before,
            "stale row gets re-stamped"
        );
    }

    #[test]
    fn label_change_is_written_and_searchable() {
        let mut conn = open_in_memory_for_tests();
        apply_writes(&mut conn, &[upsert("pods", "u1", "api-0")]).unwrap();
        let mut relabel = upsert("pods", "u1", "api-0");
        if let WriteOp::Upsert { labels, .. } = &mut relabel {
            *labels = "app=payments".to_owned();
        }
        apply_writes(&mut conn, &[relabel]).unwrap();
        let hits = crate::search::query::run(&conn, "app=payments", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }
}
