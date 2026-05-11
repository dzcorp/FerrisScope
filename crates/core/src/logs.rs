//! Log streaming.
//!
//! `LogStream` follows a single container's logs via `Api::log_stream` and
//! broadcasts each line over a [`broadcast`] channel. Receivers that lag are
//! signalled with [`LogLine::Lagged`] (via the standard broadcast `Lagged`
//! semantics) — we never buffer unbounded.
//!
//! Aborts the underlying reader task on drop.

use std::sync::Arc;

use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{Api, LogParams},
    Client,
};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::Result;

/// Frontend payload — kept tagged so we can later add e.g. `Restart` markers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LogEvent {
    Line {
        text: String,
    },
    /// Multiple consecutive log lines coalesced into a single IPC frame.
    /// Emitted by the forwarder when the broadcast queue has backlog —
    /// keeps the JS main thread from drowning in per-line JSON-parse
    /// overhead during the initial tail burst or noisy pods.
    Batch {
        lines: Vec<String>,
    },
    /// Backend signalling that N lines were dropped because the consumer lagged.
    Lagged {
        dropped: u64,
    },
    /// Stream finished (pod terminated, network closed, etc.).
    Ended {
        reason: String,
    },
}

const LINE_BUFFER: usize = 512;
const TAIL_LINES: i64 = 200;

pub struct LogStream {
    tx: broadcast::Sender<LogEvent>,
    task: JoinHandle<()>,
}

impl LogStream {
    /// Start following logs for `pod` (in `namespace`), targeting `container`.
    /// Returns immediately; the reader task fills the broadcast channel in the
    /// background.
    pub fn start(
        client: Client,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
    ) -> Result<Arc<Self>> {
        let api: Api<Pod> = Api::namespaced(client, namespace);
        let pod = pod.to_owned();
        let params = LogParams {
            follow: true,
            tail_lines: Some(TAIL_LINES),
            container: container.map(ToOwned::to_owned),
            // Apiserver prepends an RFC3339Nano timestamp per line; the
            // frontend parses + reformats it for the gutter. Cheap (~30
            // bytes per line) and avoids a second per-line round trip.
            timestamps: true,
            ..Default::default()
        };

        let (tx, _rx) = broadcast::channel(LINE_BUFFER);
        let tx_task = tx.clone();

        let task = tokio::spawn(async move {
            let stream = match api.log_stream(&pod, &params).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx_task.send(LogEvent::Ended {
                        reason: format!("open failed: {e}"),
                    });
                    return;
                }
            };
            let mut lines = stream.lines();
            loop {
                match lines.next().await {
                    Some(Ok(line)) => {
                        // send returns Err when no receivers; that's fine.
                        let _ = tx_task.send(LogEvent::Line { text: line });
                    }
                    Some(Err(e)) => {
                        let _ = tx_task.send(LogEvent::Ended {
                            reason: format!("read error: {e}"),
                        });
                        return;
                    }
                    None => {
                        let _ = tx_task.send(LogEvent::Ended {
                            reason: "stream closed".to_owned(),
                        });
                        return;
                    }
                }
            }
        });

        Ok(Arc::new(Self { tx, task }))
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<LogEvent> {
        self.tx.subscribe()
    }
}

impl Drop for LogStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
