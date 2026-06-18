//! Hosts-file mutation: backup-once, then declarative apply / strip via the
//! pure logic in `ferrisscope_core::globalfwd::hostsfile`. All writes go through
//! `atomic_write` (temp file + rename) so a crash mid-write never leaves the
//! system without a hosts file.

use std::net::Ipv4Addr;
use std::path::Path;

use anyhow::{Context, Result};
use ferrisscope_core::atomic_write::atomic_write;
use ferrisscope_core::globalfwd::hostsfile::{self, Entry};
use ferrisscope_core::globalfwd::protocol::HostEntry;
use tokio::fs;

use crate::state::HelperState;

/// Read the hosts file, treating "not found" as empty content (a fresh box, or
/// a test temp path that doesn't exist yet).
async fn read(path: &Path) -> Result<String> {
    match fs::read_to_string(path).await {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Copy the original hosts file to the backup path exactly once. No-op if the
/// backup already exists (don't clobber the pristine copy with a managed one)
/// or if the hosts file doesn't exist yet.
async fn backup_once(hosts: &Path, backup: &Path) -> Result<()> {
    if fs::try_exists(backup).await.unwrap_or(false) {
        return Ok(());
    }
    let Ok(content) = fs::read(hosts).await else {
        return Ok(());
    };
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent).await.ok();
    }
    atomic_write(backup, &content)
        .await
        .with_context(|| format!("writing hosts backup {}", backup.display()))?;
    Ok(())
}

/// Replace the managed block with exactly `entries`. Inputs are assumed already
/// validated by the server (loopback IPs, valid hostnames).
pub(crate) async fn apply(state: &HelperState, entries: Vec<HostEntry>) -> Result<()> {
    backup_once(&state.hosts_path, &state.hosts_backup).await?;
    let current = read(&state.hosts_path).await?;
    let model: Vec<Entry> = entries
        .into_iter()
        .map(|e| Entry {
            ip: e.ip,
            hostnames: e.hostnames,
        })
        .collect();
    let next = hostsfile::upsert_block(&current, &model);
    atomic_write(&state.hosts_path, next.as_bytes())
        .await
        .with_context(|| format!("writing {}", state.hosts_path.display()))?;
    Ok(())
}

/// Strip our managed block, leaving foreign content untouched.
pub(crate) async fn remove(state: &HelperState) -> Result<()> {
    let current = read(&state.hosts_path).await?;
    if !hostsfile::has_block(&current) {
        return Ok(());
    }
    let next = hostsfile::strip_block(&current);
    atomic_write(&state.hosts_path, next.as_bytes())
        .await
        .with_context(|| format!("writing {}", state.hosts_path.display()))?;
    Ok(())
}

/// Crash recovery: return the loopback IPs our block referenced and strip it.
/// The caller drops the matching aliases.
pub(crate) async fn purge_stale(state: &HelperState) -> Result<Vec<Ipv4Addr>> {
    let current = read(&state.hosts_path).await?;
    let ips = hostsfile::block_ips(&current);
    if hostsfile::has_block(&current) {
        let next = hostsfile::strip_block(&current);
        atomic_write(&state.hosts_path, next.as_bytes())
            .await
            .with_context(|| format!("writing {}", state.hosts_path.display()))?;
    }
    Ok(ips)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrisscope_core::globalfwd::hostsfile;
    use std::net::Ipv4Addr;

    fn entry(ip: [u8; 4], names: &[&str]) -> HostEntry {
        HostEntry {
            ip: Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]),
            hostnames: names.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    async fn state_in(dir: &Path) -> HelperState {
        let hosts = dir.join("hosts");
        // Seed with foreign content so we can assert it's preserved.
        fs::write(&hosts, "127.0.0.1\tlocalhost\n10.0.0.5\tmy-box\n")
            .await
            .unwrap();
        HelperState::new("t".into(), hosts, dir.join("hosts.backup"))
    }

    #[tokio::test]
    async fn apply_then_remove_preserves_foreign_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path()).await;

        apply(&st, vec![entry([127, 1, 0, 1], &["api", "api.default"])])
            .await
            .unwrap();

        let after = fs::read_to_string(&st.hosts_path).await.unwrap();
        assert!(hostsfile::has_block(&after));
        assert!(after.contains("127.1.0.1\tapi api.default"));
        assert!(after.contains("127.0.0.1\tlocalhost"), "foreign preserved");
        // Backup captured the *original* (no managed block).
        let backup = fs::read_to_string(&st.hosts_backup).await.unwrap();
        assert!(!hostsfile::has_block(&backup));
        assert!(backup.contains("10.0.0.5\tmy-box"));

        remove(&st).await.unwrap();
        let cleaned = fs::read_to_string(&st.hosts_path).await.unwrap();
        assert!(!hostsfile::has_block(&cleaned));
        assert!(cleaned.contains("10.0.0.5\tmy-box"));
    }

    #[tokio::test]
    async fn backup_is_written_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path()).await;
        apply(&st, vec![entry([127, 1, 0, 1], &["api"])])
            .await
            .unwrap();
        let backup1 = fs::read_to_string(&st.hosts_backup).await.unwrap();
        // Second apply must NOT overwrite the backup with a now-managed file.
        apply(&st, vec![entry([127, 1, 0, 2], &["db"])])
            .await
            .unwrap();
        let backup2 = fs::read_to_string(&st.hosts_backup).await.unwrap();
        assert_eq!(backup1, backup2);
        assert!(!hostsfile::has_block(&backup2));
    }

    #[tokio::test]
    async fn purge_stale_reports_ips_and_strips() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path()).await;
        apply(
            &st,
            vec![
                entry([127, 1, 0, 1], &["api"]),
                entry([127, 1, 0, 2], &["db"]),
            ],
        )
        .await
        .unwrap();
        let ips = purge_stale(&st).await.unwrap();
        assert_eq!(
            ips,
            vec![Ipv4Addr::new(127, 1, 0, 1), Ipv4Addr::new(127, 1, 0, 2)]
        );
        let cleaned = fs::read_to_string(&st.hosts_path).await.unwrap();
        assert!(!hostsfile::has_block(&cleaned));
    }

    #[tokio::test]
    async fn remove_on_unmanaged_file_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path()).await;
        let before = fs::read_to_string(&st.hosts_path).await.unwrap();
        remove(&st).await.unwrap();
        let after = fs::read_to_string(&st.hosts_path).await.unwrap();
        assert_eq!(before, after);
    }
}
