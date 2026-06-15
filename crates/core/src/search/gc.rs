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
            "INSERT INTO rows (kind_id, uid, namespace, name, blob, updated_at, deleted_at)
             VALUES ('pods', ?1, 'default', ?1, '{}', ?2, ?3)",
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
    fn noop_on_an_empty_db() {
        let conn = open_in_memory_for_tests();
        let stats = run(&conn, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
        assert_eq!(stats.tombstones_purged, 0);
        assert_eq!(stats.stale_purged, 0);
    }
}
