use std::time::Duration;

use rusqlite::Connection;

use super::{GcStats, Result};

/// Purge tombstones older than `tombstone_age` (rows soft-deleted that
/// long ago are no longer interesting — the watcher would have re-upserted
/// any flapping pod by now), and rows last seen alive more than
/// `stale_age` ago (bounds disk for kinds the operator opened once and
/// never returned to). Both cutoffs are absolute relative to "now"; the
/// caller picks the policy.
pub(super) fn run(
    conn: &Connection,
    tombstone_age: Duration,
    stale_age: Duration,
) -> Result<GcStats> {
    let now = unix_ms();
    let tombstone_cutoff =
        now.saturating_sub(i64::try_from(tombstone_age.as_millis()).unwrap_or(0));
    let stale_cutoff = now.saturating_sub(i64::try_from(stale_age.as_millis()).unwrap_or(0));

    let tombstones_purged = conn.execute(
        "DELETE FROM rows WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        rusqlite::params![tombstone_cutoff],
    )?;
    let stale_purged = conn.execute(
        "DELETE FROM rows WHERE deleted_at IS NULL AND updated_at < ?1",
        rusqlite::params![stale_cutoff],
    )?;
    if tombstones_purged + stale_purged > 0 {
        // FTS5 only drops deleted postings when their segment is merged;
        // optimize folds everything into one segment, then the freed pages
        // go back to the filesystem.
        conn.execute("INSERT INTO rows_fts(rows_fts) VALUES('optimize')", [])?;
        // Frees one page per step.
        let mut vacuum = conn.prepare("PRAGMA incremental_vacuum")?;
        let mut steps = vacuum.query([])?;
        while steps.next()?.is_some() {}
    }
    Ok(GcStats {
        tombstones_purged,
        stale_purged,
    })
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

    fn seed(conn: &Connection, uid: &str, updated_at: i64, deleted_at: Option<i64>) {
        conn.execute(
            "INSERT INTO rows (kind_id, uid, namespace, name, labels, updated_at, deleted_at)
             VALUES ('pods', ?1, 'default', ?1, '', ?2, ?3)",
            rusqlite::params![uid, updated_at, deleted_at],
        )
        .unwrap();
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM rows", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn purges_old_tombstones_and_stale_live_rows_keeps_the_rest() {
        let conn = open_in_memory_for_tests();
        let now = unix_ms();
        let hour = 3_600_000i64;
        seed(&conn, "old-tombstone", now, Some(now - 48 * hour));
        seed(&conn, "fresh-tombstone", now, Some(now - hour));
        seed(&conn, "stale-live", now - 200 * hour, None);
        seed(&conn, "fresh-live", now, None);

        let stats = run(&conn, Duration::from_hours(24), Duration::from_hours(168)).unwrap();

        assert_eq!(stats.tombstones_purged, 1);
        assert_eq!(stats.stale_purged, 1);
        assert_eq!(count(&conn), 2);
    }

    #[test]
    fn purge_shrinks_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::search::db::open_and_init(&dir.path().join("idx.db")).unwrap();
        let pages =
            |c: &Connection| -> i64 { c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap() };
        let now = unix_ms();
        conn.execute_batch("BEGIN").unwrap();
        for i in 0..3000 {
            conn.execute(
                "INSERT INTO rows (kind_id, uid, namespace, name, labels, updated_at, deleted_at)
                 VALUES ('pods', ?1, 'default', ?2, 'app=payments-api tier=backend', ?3, ?4)",
                rusqlite::params![
                    format!("u{i}"),
                    format!("payments-api-{i:05}"),
                    now,
                    now - 48 * 3_600_000
                ],
            )
            .unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        let before = pages(&conn);

        let stats = run(&conn, Duration::from_hours(24), Duration::from_hours(168)).unwrap();
        assert_eq!(stats.tombstones_purged, 3000);
        let free: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert_eq!(free, 0, "freed pages returned");
        assert!(pages(&conn) < before / 2, "{} !< {before}/2", pages(&conn));
    }

    #[test]
    fn noop_on_an_empty_db() {
        let conn = open_in_memory_for_tests();
        let stats = run(&conn, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
        assert_eq!(stats.tombstones_purged, 0);
        assert_eq!(stats.stale_purged, 0);
    }
}
