//! Per-cluster SQLite-backed search index.
//!
//! Single FTS5+trigram index per connected cluster, fed by the same delta
//! stream the resource table consumes. The header palette ("Cmd+K") queries
//! this across whatever kinds the operator has touched (or that the
//! connect-time bootstrap pre-loaded).
//!
//! Lazy by design — see `CLAUDE.md` "Hard architectural rules". Reflectors
//! aren't started just to populate the index; everything that's already
//! flowing for the UI is also fed here. The bootstrap LIST on connect is a
//! one-shot, watcher-free fan-in for a fixed allowlist (pods, deployments,
//! nodes, services, namespaces, configmaps, secrets, ingresses) so the
//! search bar isn't empty on a fresh cluster.
//!
//! Storage layout: one `<sha-of-cluster-id>.db` per cluster under
//! `<config_dir>/search/`. SQLite owns the file; we never let two
//! `SearchIndex` handles open the same file (`AppState` enforces the
//! one-per-cluster invariant).

mod db;
mod gc;
mod query;
mod writer;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Error)]
pub enum SearchError {
    #[error("config dir unavailable")]
    ConfigDirUnavailable,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// The writer task ended (e.g. DB open failed at startup, or the index
    /// was closed). All API calls return this so callers can fall back
    /// gracefully instead of hanging on the oneshot.
    #[error("search writer is gone")]
    WriterGone,
}

pub type Result<T> = std::result::Result<T, SearchError>;

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub kind_id: String,
    pub uid: String,
    pub namespace: Option<String>,
    pub name: String,
    /// FTS5 bm25 score. Lower is more relevant (FTS5's sign convention).
    pub score: f64,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct GcStats {
    pub tombstones_purged: usize,
    pub stale_purged: usize,
}

pub(crate) enum WriteOp {
    Upsert {
        kind_id: String,
        uid: String,
        namespace: Option<String>,
        name: String,
        blob: String,
    },
    Delete {
        kind_id: String,
        uid: String,
    },
    /// Tombstone every live row of `kind_id` whose uid is NOT in `keep_uids`.
    /// Emitted after a complete bootstrap LIST so objects deleted while no
    /// watcher was running stop matching searches.
    Retain {
        kind_id: String,
        keep_uids: Vec<String>,
    },
}

pub(crate) enum IndexCommand {
    Write(WriteOp),
    Search {
        query: String,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<SearchHit>>>,
    },
    Gc {
        tombstone_age: Duration,
        stale_age: Duration,
        reply: oneshot::Sender<Result<GcStats>>,
    },
    NewestUpdatedAt {
        reply: oneshot::Sender<Result<Option<i64>>>,
    },
}

/// Handle to a per-cluster search index. Cheap to clone via `Arc`.
///
/// All public methods are `&self` and never block — writes are fire-and-
/// forget into the writer task's channel, queries return a future that
/// resolves when the writer has run the query off the runtime via
/// `spawn_blocking`. Dropping the last `Arc` closes the channel; the
/// writer flushes any pending batch and exits.
pub struct SearchIndex {
    tx: mpsc::UnboundedSender<IndexCommand>,
}

impl SearchIndex {
    /// Open (or create) the index for `cluster_id`. Spawns the writer task
    /// on the current Tokio runtime.
    pub fn open(cluster_id: &str) -> Result<Arc<Self>> {
        let path = db::path_for(cluster_id)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(writer::writer_loop(path, rx));
        Ok(Arc::new(Self { tx }))
    }

    /// Insert / update a row. Cheap and non-blocking. Drops silently if the
    /// row's name is missing — without a name we have nothing useful to
    /// index, and the projected row is a contract with the watcher (every
    /// k8s object has a name; if we're missing one the watcher dropped it).
    pub fn upsert(&self, kind_id: &str, uid: &str, row: &Value) {
        let (namespace, name) = extract_ns_name(row);
        let Some(name) = name else { return };
        let blob = match serde_json::to_string(row) {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!(error = %e, "search index: skipping unserialisable row");
                return;
            }
        };
        let _ = self.tx.send(IndexCommand::Write(WriteOp::Upsert {
            kind_id: kind_id.to_owned(),
            uid: uid.to_owned(),
            namespace,
            name,
            blob,
        }));
    }

    /// Soft-delete a row by uid. Sets `deleted_at`; the row is excluded from
    /// future queries until the GC pass purges it (or until a re-upsert
    /// flips `deleted_at` back to NULL — that's the flapping-pod fast path).
    pub fn delete(&self, kind_id: &str, uid: &str) {
        let _ = self.tx.send(IndexCommand::Write(WriteOp::Delete {
            kind_id: kind_id.to_owned(),
            uid: uid.to_owned(),
        }));
    }

    /// Reconcile a kind against a complete listing: soft-delete every live
    /// row of `kind_id` whose uid is not in `keep_uids`. Only call with the
    /// uid set of a *complete* LIST — a truncated listing would tombstone
    /// rows that still exist. Cheap and non-blocking like `upsert`.
    pub fn retain(&self, kind_id: &str, keep_uids: Vec<String>) {
        let _ = self.tx.send(IndexCommand::Write(WriteOp::Retain {
            kind_id: kind_id.to_owned(),
            keep_uids,
        }));
    }

    /// Run a search. Returns up to `limit` hits, sorted by FTS5 bm25 score
    /// (lower = more relevant). Queries shorter than 2 chars return empty
    /// without round-tripping to the writer.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(IndexCommand::Search {
                query: query.to_owned(),
                limit,
                reply,
            })
            .map_err(|_| SearchError::WriterGone)?;
        rx.await.map_err(|_| SearchError::WriterGone)?
    }

    /// Most recent `updated_at` across the live (non-tombstoned) rows in
    /// milliseconds since the Unix epoch, or `None` if the index is empty.
    /// Used by the connect-time bootstrap to skip a refresh LIST when the
    /// existing data is recent enough — e.g. the operator briefly flipped
    /// to the fleet view and came back within minutes.
    pub async fn newest_updated_at(&self) -> Result<Option<i64>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(IndexCommand::NewestUpdatedAt { reply })
            .map_err(|_| SearchError::WriterGone)?;
        rx.await.map_err(|_| SearchError::WriterGone)?
    }

    /// Run garbage collection. Hard-deletes tombstones older than
    /// `tombstone_age` and rows last seen alive more than `stale_age` ago.
    /// Safe to call concurrently with writes — serialised through the same
    /// writer task.
    pub async fn gc(&self, tombstone_age: Duration, stale_age: Duration) -> Result<GcStats> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(IndexCommand::Gc {
                tombstone_age,
                stale_age,
                reply,
            })
            .map_err(|_| SearchError::WriterGone)?;
        rx.await.map_err(|_| SearchError::WriterGone)?
    }

    /// Best-effort cleanup of the on-disk DB files for a cluster (rows, WAL,
    /// shared-memory). Called by `drop_cluster_watchers` after the
    /// `SearchIndex` itself has been dropped, so SQLite has released its
    /// locks.
    pub fn drop_files(cluster_id: &str) -> Result<()> {
        let path: PathBuf = db::path_for(cluster_id)?;
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        Ok(())
    }
}

fn extract_ns_name(row: &Value) -> (Option<String>, Option<String>) {
    let ns = row
        .get("namespace")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    (ns, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_ns_name_reads_both_fields() {
        let (ns, name) = extract_ns_name(&json!({ "namespace": "default", "name": "api-0" }));
        assert_eq!(ns.as_deref(), Some("default"));
        assert_eq!(name.as_deref(), Some("api-0"));
    }

    #[test]
    fn extract_ns_name_treats_empty_and_missing_as_none() {
        let (ns, name) = extract_ns_name(&json!({ "namespace": "", "name": "node-1" }));
        assert_eq!(ns, None);
        assert_eq!(name.as_deref(), Some("node-1"));
        let (ns, name) = extract_ns_name(&json!({ "namespace": 7, "name": null }));
        assert_eq!(ns, None);
        assert_eq!(name, None);
    }
}
