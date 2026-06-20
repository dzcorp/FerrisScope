//! Pure manipulation of a hosts file's *managed block*.
//!
//! FerrisScope owns exactly one contiguous block in the system hosts file,
//! delimited by sentinel comment lines. Everything outside the block is foreign
//! content we must never alter. These functions take the current file content as
//! a string and return the new content — the privileged helper does the actual
//! disk read/backup/write (atomically, via `crate::atomic_write`).
//!
//! All operations are expressed in terms of [`strip_block`] (remove every
//! managed block) + a fresh append, so they're idempotent: re-applying the same
//! entries yields byte-identical output, and a crash that left a duplicate block
//! self-heals on the next apply.

use std::net::Ipv4Addr;

/// Opening sentinel. Must match exactly to be recognized.
pub const BEGIN: &str = "# >>> ferrisscope managed — removed automatically on disable >>>";
/// Closing sentinel.
pub const END: &str = "# <<< ferrisscope managed <<<";

/// One managed hosts line: an IP and the names that resolve to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub ip: Ipv4Addr,
    pub hostnames: Vec<String>,
}

/// Render the managed block (sentinels included) for `entries`, or the empty
/// string when there are none. Always ends with a newline when non-empty.
/// Entries with no hostnames are skipped.
#[must_use]
pub fn render_block(entries: &[Entry]) -> String {
    let rows: Vec<&Entry> = entries.iter().filter(|e| !e.hostnames.is_empty()).collect();
    if rows.is_empty() {
        return String::new();
    }
    let mut s = String::new();
    s.push_str(BEGIN);
    s.push('\n');
    for e in rows {
        s.push_str(&e.ip.to_string());
        s.push('\t');
        s.push_str(&e.hostnames.join(" "));
        s.push('\n');
    }
    s.push_str(END);
    s.push('\n');
    s
}

/// Remove **every** managed block from `existing`, preserving all foreign lines.
/// A block runs from a line equal to [`BEGIN`] through the next line equal to
/// [`END`] (both trimmed). An unterminated `BEGIN` (no matching `END`, e.g. a
/// truncated/corrupted file) drops the remainder — acceptable for our own
/// block; foreign content never appears after our marker in normal operation.
#[must_use]
pub fn strip_block(existing: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in existing.lines() {
        let t = line.trim();
        if !inside && t == BEGIN {
            inside = true;
            continue;
        }
        if inside {
            if t == END {
                inside = false;
            }
            continue;
        }
        out.push(line);
    }
    // Drop trailing blank lines so repeated strip/append cycles don't accumulate
    // separator blanks; keep a single trailing newline on non-empty content.
    while matches!(out.last(), Some(l) if l.trim().is_empty()) {
        out.pop();
    }
    if out.is_empty() {
        String::new()
    } else {
        let mut s = out.join("\n");
        s.push('\n');
        s
    }
}

/// Return `existing` with the managed block set to exactly `entries`: strip any
/// existing block(s), then (if `entries` is non-empty) append a fresh block
/// separated by one blank line. Idempotent.
#[must_use]
pub fn upsert_block(existing: &str, entries: &[Entry]) -> String {
    let base = strip_block(existing);
    let block = render_block(entries);
    if block.is_empty() {
        return base;
    }
    let mut s = base;
    if !s.is_empty() {
        // `base` already ends in '\n'; add one blank line as a separator.
        s.push('\n');
    }
    s.push_str(&block);
    s
}

/// `true` if `existing` currently contains a managed block.
#[must_use]
pub fn has_block(existing: &str) -> bool {
    existing.lines().any(|l| l.trim() == BEGIN)
}

/// The loopback IPs currently registered inside the managed block — used by the
/// helper's stale-purge to know which loopback aliases to tear down after a
/// crash left a block behind.
#[must_use]
pub fn block_ips(existing: &str) -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    let mut inside = false;
    for line in existing.lines() {
        let t = line.trim();
        if !inside {
            if t == BEGIN {
                inside = true;
            }
            continue;
        }
        if t == END {
            break;
        }
        if let Some(tok) = t.split_whitespace().next() {
            if let Ok(ip) = tok.parse::<Ipv4Addr>() {
                ips.push(ip);
            }
        }
    }
    ips
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn entry(ip: [u8; 4], names: &[&str]) -> Entry {
        Entry {
            ip: Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]),
            hostnames: names.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    const FOREIGN: &str = "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1\tlocalhost\n10.0.0.5\tmy-laptop.local\n";

    #[test]
    fn upsert_into_empty_file() {
        let out = upsert_block("", &[entry([127, 1, 0, 1], &["api", "api.default"])]);
        assert!(out.starts_with(BEGIN));
        assert!(out.contains("127.1.0.1\tapi api.default"));
        assert!(out.trim_end().ends_with(END));
    }

    #[test]
    fn upsert_preserves_foreign_lines() {
        let out = upsert_block(FOREIGN, &[entry([127, 1, 0, 1], &["api"])]);
        // Every foreign line survives verbatim.
        for line in FOREIGN.lines() {
            assert!(out.contains(line), "lost foreign line {line:?}");
        }
        assert!(has_block(&out));
    }

    #[test]
    fn strip_restores_foreign_content() {
        let with_block = upsert_block(FOREIGN, &[entry([127, 1, 0, 1], &["api"])]);
        let stripped = strip_block(&with_block);
        assert_eq!(stripped, FOREIGN, "strip must round-trip back to foreign");
        assert!(!has_block(&stripped));
    }

    #[test]
    fn upsert_is_idempotent() {
        let entries = [
            entry([127, 1, 0, 1], &["api", "api.default"]),
            entry([127, 1, 0, 2], &["db", "db.default"]),
        ];
        let once = upsert_block(FOREIGN, &entries);
        let twice = upsert_block(&once, &entries);
        assert_eq!(once, twice, "re-applying same entries must be byte-stable");
    }

    #[test]
    fn upsert_replaces_old_block() {
        let v1 = upsert_block(FOREIGN, &[entry([127, 1, 0, 1], &["api"])]);
        let v2 = upsert_block(&v1, &[entry([127, 1, 0, 9], &["other"])]);
        assert!(v2.contains("127.1.0.9\tother"));
        assert!(!v2.contains("127.1.0.1\tapi"), "old block must be gone");
        // exactly one block
        assert_eq!(v2.matches(BEGIN).count(), 1);
    }

    #[test]
    fn upsert_empty_entries_removes_block() {
        let v1 = upsert_block(FOREIGN, &[entry([127, 1, 0, 1], &["api"])]);
        let v2 = upsert_block(&v1, &[]);
        assert_eq!(v2, FOREIGN);
    }

    #[test]
    fn strip_removes_duplicate_blocks() {
        // Simulate a crash that left two blocks back-to-back.
        let dup = format!(
            "{FOREIGN}\n{}\n{}",
            render_block(&[entry([127, 1, 0, 1], &["api"])]),
            render_block(&[entry([127, 1, 0, 2], &["db"])]),
        );
        let stripped = strip_block(&dup);
        assert_eq!(stripped, FOREIGN);
    }

    #[test]
    fn block_ips_lists_registered_addresses() {
        let out = upsert_block(
            FOREIGN,
            &[
                entry([127, 1, 0, 1], &["api"]),
                entry([127, 1, 0, 2], &["db"]),
            ],
        );
        assert_eq!(
            block_ips(&out),
            vec![Ipv4Addr::new(127, 1, 0, 1), Ipv4Addr::new(127, 1, 0, 2)]
        );
        // No false positives from foreign 127.0.0.1 / 10.0.0.5 lines.
        assert!(!block_ips(&out).contains(&Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn entries_without_hostnames_skipped() {
        let out = render_block(&[entry([127, 1, 0, 1], &[]), entry([127, 1, 0, 2], &["db"])]);
        assert!(!out.contains("127.1.0.1"));
        assert!(out.contains("127.1.0.2\tdb"));
    }

    #[test]
    fn all_empty_entries_render_nothing() {
        assert_eq!(render_block(&[entry([127, 1, 0, 1], &[])]), "");
        assert_eq!(render_block(&[]), "");
    }
}
