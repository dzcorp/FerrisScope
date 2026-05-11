use rusqlite::Connection;
use serde_json::Value;

use super::{Result, SearchHit};

/// Below this length the trigram tokenizer can't produce useful tokens;
/// the API short-circuits and returns no hits rather than round-tripping a
/// guaranteed-empty query.
const MIN_QUERY_LEN: usize = 2;
/// FTS5 trigram requires 3 chars to produce a tokenized phrase. Tokens
/// shorter than this are dropped from the FTS query; if every token in
/// the user's input is short, fall back to LIKE so 2-char prefixes still
/// turn up something.
const TRIGRAM_MIN: usize = 3;
/// Hard cap on returned rows independent of the caller's `limit` — keeps
/// the IPC payload bounded if the frontend asks for too many.
const MAX_RESULTS: i64 = 200;

/// FTS5 column weights, in the order columns appear in the `rows_fts`
/// schema: `name`, `namespace`, `kind_id`, `blob`. A name match should
/// dominate a blob mention, otherwise a Pod literally called `mysql-0`
/// can lose to a ConfigMap that merely references mysql in an env var.
/// Kind weight is mild but non-zero so typing `pod` still surfaces Pods.
const BM25_WEIGHTS: &str = "10.0, 3.0, 2.0, 1.0";

/// Per-kind score multiplier. FTS5 `bm25()` returns negative numbers (more
/// negative = more relevant), so multiplying by `> 1.0` strengthens a hit
/// and `< 1.0` weakens it. Workload + canonical-destination kinds get a
/// small boost; noisy / derived / internal kinds (Events, ReplicaSets,
/// Endpoints, EndpointSlices, Leases) are pushed down so a real workload
/// match isn't drowned by hundreds of Events that happen to mention the
/// same string.
///
/// Unlisted kinds (CRDs, RBAC, storage, etc.) take the neutral `1.0`
/// branch — we don't punish them, we just don't boost them.
const KIND_BIAS_CASE: &str = "CASE r.kind_id
        WHEN 'pods'                   THEN 1.5
        WHEN 'deployments'            THEN 1.4
        WHEN 'services'               THEN 1.4
        WHEN 'statefulsets'           THEN 1.3
        WHEN 'daemonsets'             THEN 1.3
        WHEN 'configmaps'             THEN 1.2
        WHEN 'secrets'                THEN 1.2
        WHEN 'ingresses'              THEN 1.2
        WHEN 'nodes'                  THEN 1.2
        WHEN 'namespaces'             THEN 1.2
        WHEN 'cronjobs'               THEN 1.2
        WHEN 'helm_releases'          THEN 1.2
        WHEN 'jobs'                   THEN 1.1
        WHEN 'persistentvolumeclaims' THEN 1.1
        WHEN 'events'                 THEN 0.2
        WHEN 'endpoints'              THEN 0.3
        WHEN 'endpointslices'         THEN 0.3
        WHEN 'leases'                 THEN 0.3
        WHEN 'replicasets'            THEN 0.4
        ELSE 1.0
    END";

pub(super) fn run(conn: &Connection, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let trimmed = query.trim();
    if trimmed.chars().count() < MIN_QUERY_LEN {
        return Ok(Vec::new());
    }
    let limit = i64::try_from(limit)
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);

    let fts_tokens: Vec<String> = trimmed
        .split_whitespace()
        .filter(|t| t.chars().count() >= TRIGRAM_MIN)
        .map(escape_fts_phrase)
        .collect();

    if fts_tokens.is_empty() {
        return like_fallback(conn, trimmed, limit);
    }
    let match_query = fts_tokens.join(" ");

    let sql = format!(
        "SELECT r.kind_id, r.uid, r.namespace, r.name, r.blob,
                bm25(rows_fts, {BM25_WEIGHTS}) * ({KIND_BIAS_CASE}) AS score
         FROM rows_fts
         JOIN rows r ON r.rowid = rows_fts.rowid
         WHERE rows_fts MATCH ?1
           AND r.deleted_at IS NULL
         ORDER BY score
         LIMIT ?2"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(rusqlite::params![match_query, limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(parse_hit(row)?);
    }
    Ok(out)
}

/// FTS5 phrase quoting: wrap the token in double quotes and escape any
/// embedded double quote by doubling it. This neutralises every FTS5
/// query-syntax meta character (`*`, `(`, `)`, `+`, `-`, `^`, `:`) so a
/// user who pastes a label selector like `app:foo` doesn't blow up the
/// parser.
fn escape_fts_phrase(token: &str) -> String {
    let inner = token.replace('"', "\"\"");
    format!("\"{inner}\"")
}

/// LIKE fallback for very short queries (every token < 3 chars). Slow on
/// large indices but bounded by `LIMIT`, and only fires when FTS can't.
/// Bias by kind first (Events / ReplicaSets / Endpoints last), then by
/// recency — without BM25 we have no real relevance signal, so the kind
/// bias is doing all the work of demoting noisy rows for 2-char queries.
fn like_fallback(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    let pattern = format!("%{}%", escape_like(query));
    let sql = format!(
        "SELECT r.kind_id, r.uid, r.namespace, r.name, r.blob, 0.0 AS score
         FROM rows r
         WHERE r.deleted_at IS NULL
           AND (r.name LIKE ?1 ESCAPE '\\' OR r.namespace LIKE ?1 ESCAPE '\\')
         ORDER BY ({KIND_BIAS_CASE}) DESC, r.updated_at DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(rusqlite::params![pattern, limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(parse_hit(row)?);
    }
    Ok(out)
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn parse_hit(row: &rusqlite::Row<'_>) -> Result<SearchHit> {
    let kind_id: String = row.get(0)?;
    let uid: String = row.get(1)?;
    let namespace: Option<String> = row.get(2)?;
    let name: String = row.get(3)?;
    let blob_str: String = row.get(4)?;
    let score: f64 = row.get(5)?;
    let blob: Value = serde_json::from_str(&blob_str)?;
    Ok(SearchHit {
        kind_id,
        uid,
        namespace,
        name,
        blob,
        score,
    })
}
