//! Per-session JSONL transcript store + index.
//!
//! Layout:
//! ```text
//! <root>/
//!   index.json
//!   <cluster_sanitised>/
//!     <session_id>.jsonl
//! ```
//!
//! Every assistant turn / approval / tool result is one append to the JSONL
//! file. Recovery from a partial write is trivial — the last incomplete line
//! is dropped on load.

use crate::types::{ChatMessage, ToolCall};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("decode: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    NotFound(String),
}

/// Sanitises a cluster id into a filesystem-safe path segment. Same character
/// class the Tauri event sanitiser uses on the app side so on-disk paths and
/// event keys stay symmetrical.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn legacy_provider_kind() -> crate::config::ProviderKind {
    crate::config::ProviderKind::OpenRouter
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub cluster_id: String,
    pub title: String,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    /// Which provider backend the chat is bound to. Defaulted on read so
    /// pre-multi-provider sessions deserialise to the OpenRouter they were
    /// created against, independent of today's global default.
    #[serde(default = "legacy_provider_kind")]
    pub provider_kind: crate::config::ProviderKind,
    pub model: String,
    pub approval_mode: crate::config::ApprovalMode,
    /// Per-session sampling overrides. `None` falls back to provider defaults.
    /// Defaulted on read so older sessions deserialise unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Free-form provider-specific knobs (Anthropic `thinking`, OpenAI
    /// `reasoning`, OpenRouter routing, ...). Mirrors
    /// `CompletionRequest::provider_options`; merged verbatim into each
    /// request body. Persisted with the session so a re-opened chat
    /// keeps its tuning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<serde_json::Value>,
    /// Most recent provider-reported token total. Updated on every
    /// `SessionEvent::Usage` append so a chat reopen reads the
    /// running count straight from the index without scanning the
    /// JSONL or waiting for the next round's Usage event.
    /// Defaulted on read so older sessions (pre-Usage-tracking)
    /// deserialise unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_total_tokens: Option<u32>,
    /// The cluster id the agent was last targeting via
    /// `fs_configuration_use_context`. `None` (the default) means the
    /// agent never switched contexts — `cluster_id` (origin) is still
    /// the active target. When set, chat-open restores `active = this`
    /// so the agent's prior switches survive an app restart. The
    /// `cluster_id` field above is still authoritative for "where this
    /// chat lives on disk" and never changes after creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_cluster_id: Option<String>,
}

/// Streamed event records written to the JSONL transcript. The discriminator
/// is on `kind` so it can be `serde_json::from_str`'d a line at a time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    Message {
        message: ChatMessage,
        ts: i64,
    },
    Approval {
        tool_call_id: String,
        decision: ApprovalDecision,
        ts: i64,
    },
    /// Sparse — emitted only on rename / model-change / approval-mode-change
    /// so the latest metadata reads back deterministically by tail-scanning.
    SessionUpdate {
        update: SessionUpdate,
        ts: i64,
    },
    /// Raw record of a tool call we executed and its result. Kept separate
    /// from `Message` for readability — operators reading the transcript
    /// see distinct line types for "model said this" vs "tool ran".
    ToolResult {
        call: ToolCall,
        /// JSON-stringified tool output. Empty on error.
        result: String,
        /// Set only when the call failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        ts: i64,
    },
    /// Latest provider-reported token usage for the session. Written
    /// alongside every assistant message so chat_open can rehydrate
    /// the running total (drives the compaction trigger and the
    /// chat-header usage chip without waiting for the next round's
    /// stream).
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
        ts: i64,
    },
    /// Auto-compaction marker. Records that the message stream up to
    /// this point was summarised into `summary` to free context. On
    /// reload, every `Message` event before this index is replaced by
    /// a single synthetic assistant "context checkpoint" message
    /// carrying `summary`. Original lines stay in the JSONL for audit.
    Compaction {
        /// Number of `Message` events preceding this entry that have
        /// been folded into the summary. Reload uses this to know how
        /// many to skip.
        head_message_count: u32,
        /// Token count at the time compaction fired. Useful for
        /// debugging the trigger heuristic.
        tokens_before: u32,
        /// LLM-generated structured summary. Replaces the head on
        /// replay.
        summary: String,
        /// The messages kept verbatim after the summary. They were logged
        /// before this marker, so replay needs them here to restore the
        /// transcript the live chat continued with. Empty on markers written
        /// before this field existed (replay then drops them, as it did).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tail: Vec<ChatMessage>,
        ts: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    Denied,
    /// Approved AND remember this tool's name for the rest of the chat.
    ApprovedAlways,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<crate::config::ApprovalMode>,
    /// Sentinel: `Some(Some(v))` sets the value, `Some(None)` clears it,
    /// `None` leaves it untouched. Same shape for max_tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<Option<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<Option<u32>>,
    /// Same sentinel shape: `Some(Some(...))` writes, `Some(None)` clears,
    /// `None` leaves alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<Option<serde_json::Value>>,
    /// Mirrors the same sentinel shape: `Some(Some(id))` records that the
    /// agent switched the active cluster to `id`, `Some(None)` clears the
    /// override (revert to origin), `None` leaves it alone. Persisted by
    /// `fs_configuration_use_context` so a chat reopen rehydrates the
    /// agent's last target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_cluster_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub meta: SessionMeta,
    pub events: Vec<SessionEvent>,
}

/// Replay helper: walks the raw event stream and folds compaction
/// markers into a single synthetic assistant message followed by the
/// post-compaction tail. The original `Message` events that were
/// summarised stay in the JSONL for audit but are not surfaced to the
/// caller. Multiple compactions over the lifetime of a session apply
/// in sequence; only the most recent summary survives on the
/// next-replay path (the older summaries are themselves part of the
/// older head, so they fold into the newest summary when it fires).
pub(crate) fn apply_compaction(events: Vec<SessionEvent>) -> Vec<SessionEvent> {
    // Find the LAST compaction marker. Everything before it that's a
    // `Message` (or `ToolResult`) is shed; the marker becomes a
    // synthetic checkpoint message; tail after the marker is kept.
    let last_compact = events
        .iter()
        .rposition(|e| matches!(e, SessionEvent::Compaction { .. }));
    let Some(idx) = last_compact else {
        return events;
    };
    let SessionEvent::Compaction {
        summary,
        ts,
        tail: kept,
        ..
    } = &events[idx]
    else {
        return events;
    };
    let summary = summary.clone();
    let ts = *ts;
    let kept: Vec<SessionEvent> = kept
        .iter()
        .map(|message| SessionEvent::Message {
            message: message.clone(),
            ts,
        })
        .collect();
    let tail: Vec<SessionEvent> = events.into_iter().skip(idx + 1).collect();
    let mut out = Vec::with_capacity(tail.len() + kept.len() + 1);
    out.push(SessionEvent::Message {
        message: ChatMessage {
            role: crate::types::MessageRole::Assistant,
            content: format!("[context checkpoint]\n{summary}"),
            tool_calls: vec![],
            tool_call_id: None,
            // Marker so other code can recognise checkpoint messages.
            // Provider impls don't read it; the agent loop uses it.
            name: Some("context_checkpoint".to_string()),
            reasoning_content: None,
            thinking_blocks: vec![],
            images: vec![],
        },
        ts,
    });
    out.extend(kept);
    out.extend(tail);
    out
}

/// Wrapping struct serialised to `index.json`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct IndexFile {
    #[serde(default)]
    sessions: Vec<SessionMeta>,
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
    /// Serialises the read-modify-write cycle on `index.json`.
    /// Why: `tokio::fs::write` truncates on open but does not block other
    /// writers — two concurrent index updates (e.g. `create` racing
    /// `append`'s bump) each hold their own handle at offset 0. The
    /// shorter write doesn't shrink the file, leaving the longer write's
    /// tail intact as "trailing characters" the next reader chokes on.
    index_lock: Arc<Mutex<()>>,
}

impl SessionStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            index_lock: Arc::new(Mutex::new(())),
        }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn session_dir(&self, cluster_id: &str) -> PathBuf {
        self.root.join(sanitize(cluster_id))
    }

    fn session_path(&self, cluster_id: &str, session_id: &str) -> PathBuf {
        self.session_dir(cluster_id)
            .join(format!("{session_id}.jsonl"))
    }

    async fn ensure_dirs(&self, cluster_id: &str) -> Result<(), SessionError> {
        tokio::fs::create_dir_all(self.session_dir(cluster_id)).await?;
        Ok(())
    }

    /// Only a missing or empty index means "no sessions yet". Any other read
    /// failure must surface: every writer rewrites the whole index from what
    /// this returns, so treating an unreadable file as empty would wipe the
    /// list of sessions on the next append.
    async fn read_index(&self) -> Result<IndexFile, SessionError> {
        match tokio::fs::read(self.index_path()).await {
            Ok(bytes) if !bytes.is_empty() => Ok(serde_json::from_slice(&bytes)?),
            Ok(_) => Ok(IndexFile::default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(IndexFile::default()),
            Err(e) => Err(SessionError::Io(e)),
        }
    }

    async fn write_index(&self, idx: &IndexFile) -> Result<(), SessionError> {
        let bytes = serde_json::to_vec_pretty(idx)?;
        crate::atomic_write::atomic_write(&self.index_path(), &bytes).await?;
        Ok(())
    }

    pub async fn list(
        &self,
        cluster_filter: Option<&str>,
    ) -> Result<Vec<SessionMeta>, SessionError> {
        let _guard = self.index_lock.lock().await;
        let idx = self.read_index().await?;
        Ok(idx
            .sessions
            .into_iter()
            .filter(|s| match cluster_filter {
                Some(c) => s.cluster_id == c,
                None => true,
            })
            .collect())
    }

    pub async fn create(&self, meta: SessionMeta) -> Result<(), SessionError> {
        self.ensure_dirs(&meta.cluster_id).await?;
        // Touch the JSONL file so a crash before the first message still
        // leaves a loadable (empty) transcript.
        let path = self.session_path(&meta.cluster_id, &meta.id);
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        let _guard = self.index_lock.lock().await;
        let mut idx = self.read_index().await?;
        idx.sessions.retain(|s| s.id != meta.id);
        idx.sessions.push(meta);
        self.write_index(&idx).await?;
        Ok(())
    }

    pub async fn append(
        &self,
        cluster_id: &str,
        session_id: &str,
        event: SessionEvent,
    ) -> Result<(), SessionError> {
        self.ensure_dirs(cluster_id).await?;
        let path = self.session_path(cluster_id, session_id);
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        let mut line = serde_json::to_string(&event)?;
        line.push('\n');
        file.write_all(line.as_bytes()).await?;
        // Tool results and approval decisions are always logged next to a
        // message that already bumps the index; rewriting the whole index for
        // each of them would double the writes of every tool round.
        if matches!(
            event,
            SessionEvent::ToolResult { .. } | SessionEvent::Approval { .. }
        ) {
            return Ok(());
        }
        // Bump updated_at on the index as a best-effort breadcrumb.
        let _guard = self.index_lock.lock().await;
        let mut idx = self.read_index().await?;
        if let Some(meta) = idx.sessions.iter_mut().find(|s| s.id == session_id) {
            meta.updated_at_unix_ms = chrono::Utc::now().timestamp_millis();
            // Apply session-update events into the index so reading metadata
            // doesn't require a tail-scan.
            if let SessionEvent::SessionUpdate { update, .. } = &event {
                if let Some(t) = &update.title {
                    meta.title.clone_from(t);
                }
                if let Some(m) = &update.model {
                    meta.model.clone_from(m);
                }
                if let Some(am) = update.approval_mode {
                    meta.approval_mode = am;
                }
                if let Some(t) = update.temperature {
                    meta.temperature = t;
                }
                if let Some(m) = update.max_tokens {
                    meta.max_tokens = m;
                }
                if let Some(po) = &update.provider_options {
                    meta.provider_options.clone_from(po);
                }
                if let Some(ac) = &update.active_cluster_id {
                    meta.active_cluster_id.clone_from(ac);
                }
            }
            // Mirror the latest token total into the index so chat
            // reopen reads the running count from `meta.last_total_tokens`
            // without scanning the JSONL. Compaction zeroes it.
            if let SessionEvent::Usage { total_tokens, .. } = &event {
                meta.last_total_tokens = Some(*total_tokens);
            }
            if let SessionEvent::Compaction { .. } = &event {
                meta.last_total_tokens = Some(0);
            }
        }
        self.write_index(&idx).await?;
        Ok(())
    }

    pub async fn load(&self, session_id: &str) -> Result<SessionData, SessionError> {
        let _guard = self.index_lock.lock().await;
        let idx = self.read_index().await?;
        let Some(meta) = idx.sessions.iter().find(|s| s.id == session_id).cloned() else {
            return Err(SessionError::NotFound(session_id.to_string()));
        };
        let path = self.session_path(&meta.cluster_id, session_id);
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(SessionError::Io(e)),
        };
        let mut events = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<SessionEvent>(line) {
                Ok(ev) => events.push(ev),
                Err(e) => {
                    // Last line during a crashed write may be partial — skip
                    // and continue rather than refusing to load the session.
                    tracing::warn!(error = %e, "session: skipping malformed event line");
                }
            }
        }
        Ok(SessionData {
            meta,
            events: apply_compaction(events),
        })
    }

    pub async fn rename(&self, session_id: &str, title: String) -> Result<(), SessionError> {
        let now = chrono::Utc::now().timestamp_millis();
        let cluster_id = {
            let _guard = self.index_lock.lock().await;
            let idx = self.read_index().await?;
            idx.sessions
                .iter()
                .find(|s| s.id == session_id)
                .map(|s| s.cluster_id.clone())
                .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?
        };
        self.append(
            &cluster_id,
            session_id,
            SessionEvent::SessionUpdate {
                update: SessionUpdate {
                    title: Some(title),
                    ..Default::default()
                },
                ts: now,
            },
        )
        .await
    }

    pub async fn delete(&self, session_id: &str) -> Result<(), SessionError> {
        let _guard = self.index_lock.lock().await;
        let mut idx = self.read_index().await?;
        let removed = idx
            .sessions
            .iter()
            .position(|s| s.id == session_id)
            .map(|i| idx.sessions.remove(i));
        let Some(meta) = removed else {
            return Err(SessionError::NotFound(session_id.to_string()));
        };
        self.write_index(&idx).await?;
        let path = self.session_path(&meta.cluster_id, session_id);
        if let Err(e) = tokio::fs::remove_file(&path).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(SessionError::Io(e));
            }
        }
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProviderKind;

    fn meta_json(provider: Option<&str>) -> String {
        let provider = provider
            .map(|p| format!(r#""provider_kind": "{p}","#))
            .unwrap_or_default();
        format!(
            r#"{{
                "id": "s1", "cluster_id": "c", "title": "t",
                "created_at_unix_ms": 1, "updated_at_unix_ms": 2,
                {provider}
                "model": "m", "approval_mode": "approve_per_write"
            }}"#
        )
    }

    #[test]
    fn session_without_provider_kind_loads_as_openrouter() {
        let meta: SessionMeta = serde_json::from_str(&meta_json(None)).unwrap();
        assert_eq!(meta.provider_kind, ProviderKind::OpenRouter);
        assert_ne!(meta.provider_kind, ProviderKind::default());
    }

    #[test]
    fn explicit_provider_kind_is_kept() {
        let meta: SessionMeta = serde_json::from_str(&meta_json(Some("opencode_zen"))).unwrap();
        assert_eq!(meta.provider_kind, ProviderKind::OpencodeZen);
    }

    fn store_meta(id: &str) -> SessionMeta {
        serde_json::from_str(&meta_json(None).replace("\"s1\"", &format!("\"{id}\""))).unwrap()
    }

    #[tokio::test]
    async fn a_missing_index_lists_no_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        assert!(store.list(None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_index_is_an_error_not_an_empty_list() {
        // A directory where index.json should be: reading it fails with
        // something other than NotFound.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("index.json")).unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        assert!(store.list(None).await.is_err());
        assert!(store.create(store_meta("s1")).await.is_err());
    }

    #[tokio::test]
    async fn appending_keeps_every_session_in_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        store.create(store_meta("s1")).await.unwrap();
        store.create(store_meta("s2")).await.unwrap();
        store
            .append(
                "c",
                "s1",
                SessionEvent::Message {
                    message: ChatMessage::default(),
                    ts: 1,
                },
            )
            .await
            .unwrap();
        let mut ids: Vec<String> = store
            .list(None)
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        ids.sort();
        assert_eq!(ids, ["s1", "s2"]);
    }

    #[tokio::test]
    async fn tool_results_and_approvals_dont_rewrite_the_index_but_messages_do() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        let mut meta = store_meta("s1");
        meta.updated_at_unix_ms = 2;
        store.create(meta).await.unwrap();
        let updated = || async { store.list(None).await.unwrap()[0].updated_at_unix_ms };

        let call = ToolCall {
            id: "a".into(),
            name: "t".into(),
            arguments: "{}".into(),
            thought_signature: None,
        };
        store
            .append(
                "c",
                "s1",
                SessionEvent::ToolResult {
                    call,
                    result: "ok".into(),
                    error: None,
                    ts: 9,
                },
            )
            .await
            .unwrap();
        store
            .append(
                "c",
                "s1",
                SessionEvent::Approval {
                    tool_call_id: "a".into(),
                    decision: ApprovalDecision::Approved,
                    ts: 9,
                },
            )
            .await
            .unwrap();
        assert_eq!(updated().await, 2);

        store
            .append(
                "c",
                "s1",
                SessionEvent::Message {
                    message: ChatMessage::default(),
                    ts: 9,
                },
            )
            .await
            .unwrap();
        assert!(updated().await > 2);
        // Both skipped events are still in the transcript.
        let events = store.load("s1").await.unwrap().events;
        assert_eq!(events.len(), 3);
    }

    fn msg(role: crate::types::MessageRole, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.into(),
            ..ChatMessage::default()
        }
    }

    fn message_event(role: crate::types::MessageRole, content: &str) -> SessionEvent {
        SessionEvent::Message {
            message: msg(role, content),
            ts: 1,
        }
    }

    fn contents(events: &[SessionEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::Message { message, .. } => Some(message.content.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn replay_keeps_the_messages_a_compaction_kept_verbatim() {
        use crate::types::MessageRole::{Assistant, User};
        let events = vec![
            message_event(User, "old question"),
            message_event(Assistant, "old answer"),
            message_event(User, "latest question"),
            SessionEvent::Compaction {
                head_message_count: 2,
                tokens_before: 900,
                summary: "S".into(),
                tail: vec![msg(User, "latest question")],
                ts: 5,
            },
            message_event(Assistant, "answer after"),
        ];
        assert_eq!(
            contents(&apply_compaction(events)),
            ["[context checkpoint]\nS", "latest question", "answer after"]
        );
    }

    #[test]
    fn replay_of_a_compaction_without_a_tail_still_drops_the_head() {
        use crate::types::MessageRole::{Assistant, User};
        let legacy = r#"{"kind":"compaction","head_message_count":2,"tokens_before":9,"summary":"S","ts":5}"#;
        let marker: SessionEvent = serde_json::from_str(legacy).unwrap();
        let events = vec![
            message_event(User, "q"),
            message_event(Assistant, "a"),
            marker,
            message_event(User, "next"),
        ];
        assert_eq!(
            contents(&apply_compaction(events)),
            ["[context checkpoint]\nS", "next"]
        );
    }

    #[test]
    fn only_the_latest_compaction_applies_with_its_own_tail() {
        use crate::types::MessageRole::User;
        let marker = |summary: &str, kept: &str| SessionEvent::Compaction {
            head_message_count: 1,
            tokens_before: 1,
            summary: summary.into(),
            tail: vec![msg(User, kept)],
            ts: 1,
        };
        let events = vec![
            message_event(User, "a"),
            marker("first", "k1"),
            message_event(User, "b"),
            marker("second", "k2"),
        ];
        assert_eq!(
            contents(&apply_compaction(events)),
            ["[context checkpoint]\nsecond", "k2"]
        );
    }
}
