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

    let mut stmt = conn.prepare_cached(
        "SELECT r.kind_id, r.uid, r.namespace, r.name, r.blob, bm25(rows_fts) AS score
         FROM rows_fts
         JOIN rows r ON r.rowid = rows_fts.rowid
         WHERE rows_fts MATCH ?1
           AND r.deleted_at IS NULL
         ORDER BY score
         LIMIT ?2",
    )?;
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
fn like_fallback(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    let pattern = format!("%{}%", escape_like(query));
    let mut stmt = conn.prepare_cached(
        "SELECT kind_id, uid, namespace, name, blob, 0.0 AS score
         FROM rows
         WHERE deleted_at IS NULL
           AND (name LIKE ?1 ESCAPE '\\' OR namespace LIKE ?1 ESCAPE '\\')
         ORDER BY updated_at DESC
         LIMIT ?2",
    )?;
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
