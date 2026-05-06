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
