//! Log streaming.
//!
//! `LogStream` follows a single container's logs via `Api::log_stream` and
//! broadcasts each line over a [`broadcast`] channel. Receivers that lag are
//! signalled with [`LogEvent::Lagged`] (via the standard broadcast `Lagged`
//! semantics) — we never buffer unbounded.
//!
//! The reader task is resilient: it polls through a container's start-up
//! (`Waiting`), fails fast on stuck reasons (bad image, missing config),
//! and reconnects across mid-stream drops / container restarts without
//! re-emitting already-shown lines. Aborts the underlying task on drop.

use std::sync::Arc;
use std::time::Duration;

use futures::{AsyncBufRead, AsyncBufReadExt, StreamExt};
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
    /// The container isn't producing logs yet (still starting up, or
    /// between crash-restarts), or the stream dropped and we're
    /// reconnecting. Not an error: the stream is still live and will
    /// switch back to `Line`/`Batch` once output resumes. `reason` is a
    /// cleaned, human-readable message safe to show verbatim.
    Waiting {
        reason: String,
    },
    /// Stream finished for good (container terminated, fatal error, gave
    /// up reconnecting). No further events follow.
    Ended {
        reason: String,
    },
}

const LINE_BUFFER: usize = 512;
const TAIL_LINES: i64 = 200;
/// Poll cadence while a container is still starting.
const RETRY_INTERVAL: Duration = Duration::from_secs(2);
/// Cap on the start-up wait (~5 min at `RETRY_INTERVAL`). Past this we give
/// up rather than poll a stuck pod forever — the task is also aborted on
/// drop, so closing the panel stops the poll immediately regardless.
const MAX_WAIT_ATTEMPTS: u32 = 150;
/// Pause between a stream dropping and the reconnect attempt.
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
/// Cap on *consecutive unproductive* reconnects — a reconnect that
/// forwarded no lines before closing again. Reset to zero whenever a
/// session produces output, so a long-lived stream that legitimately
/// reconnects now and then never exhausts it; the cap only exists to stop
/// a tight close→reopen busy-loop when classification is wrong.
const MAX_DEAD_RECONNECTS: u32 = 10;

/// Outcome of a failed `log_stream` open.
enum OpenFailure {
    /// Container isn't running yet (PodInitializing / ContainerCreating) —
    /// worth polling, logs appear once it starts. Carries the cleaned
    /// apiserver message.
    Starting(String),
    /// Won't fix itself by waiting — a hard API error, or a stuck
    /// container reason (bad image, missing config, crash loop). Give up
    /// with the cleaned message so the operator sees *why*.
    Fatal(String),
}

/// How a live stream ended.
enum StreamEnd {
    /// Server closed the stream cleanly (container exited, EOF).
    Closed,
    /// Read error mid-stream (network blip, etc.).
    Error(String),
}

/// Whether a container could still produce more logs after its stream ended.
#[derive(Debug, PartialEq, Eq)]
enum ContainerLiveness {
    /// Running — reconnect to keep following (a network blip, most likely).
    Active,
    /// Still coming up, or between crash-restarts — reconnect into the
    /// start-up wait loop. Carries the container-status reason.
    Waiting(String),
    /// Terminated for good, or the pod is gone — nothing more to stream.
    Done,
    /// Couldn't tell — be conservative and stop.
    Unknown,
}

/// Pull a clean, human-readable string out of a kube error. For API errors
/// that's the apiserver's own `message` field; anything else falls back to
/// `Display`. Avoids surfacing the full `ApiError: … BadRequest (Status {
/// … })` debug dump in the UI.
fn clean_kube_message(err: &kube::Error) -> String {
    if let kube::Error::Api(resp) = err {
        let trimmed = resp.message.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    err.to_string()
}

/// Container-status reasons that won't fix themselves by waiting — a bad
/// image ref, a missing ConfigMap/Secret, a crash loop. Polling these for
/// minutes just hides the real problem; fail fast with the reason instead.
fn is_stuck_reason(lower: &str) -> bool {
    const STUCK: &[&str] = &[
        "imagepullbackoff",
        "errimagepull",
        "errimageneverpull",
        "invalidimagename",
        "imageinspecterror",
        "registryunavailable",
        "createcontainerconfigerror",
        "createcontainererror",
        "runcontainererror",
        "crashloopbackoff",
    ];
    STUCK.iter().any(|r| lower.contains(r))
}

/// Classify a `log_stream` open error. A container that's still coming up
/// (PodInitializing / ContainerCreating) reports a 400 `BadRequest` that
/// reads like a hard API error but is really just "not ready yet" — those
/// are retryable. Stuck reasons report the same way but won't recover, so
/// they're checked first and treated as fatal. Everything else is fatal.
fn classify_open_error(err: &kube::Error) -> OpenFailure {
    let msg = clean_kube_message(err);
    if matches!(err, kube::Error::Api(_)) {
        let lower = msg.to_lowercase();
        // Stuck reasons also read as "is waiting to start: <reason>", so
        // they must be matched *before* the generic waiting branch.
        if is_stuck_reason(&lower) {
            return OpenFailure::Fatal(msg);
        }
        if lower.contains("waiting to start")
            || lower.contains("podinitializing")
            || lower.contains("containercreating")
        {
            return OpenFailure::Starting(msg);
        }
    }
    OpenFailure::Fatal(msg)
}

/// Extract the RFC3339(Nano) timestamp the apiserver prepends to each line
/// (we request `timestamps: true`). Returns `None` if the line isn't
/// prefixed as expected — used to skip lines we already forwarded when a
/// stream reconnects with an overlapping `tail_lines` window.
fn line_timestamp(line: &str) -> Option<&str> {
    let (head, _) = line.split_once(' ')?;
    // Loose RFC3339 shape check (`YYYY-MM-DDTHH:MM:SS…Z`) — enough to not
    // mistake a normal, un-prefixed log line for a timestamp.
    let starts_digit = head.bytes().next().is_some_and(|b| b.is_ascii_digit());
    if head.len() >= 20 && starts_digit && head.contains('T') && head.ends_with('Z') {
        Some(head)
    } else {
        None
    }
}

/// Decide whether a container could still produce logs once its stream has
/// ended — i.e. whether reconnecting is worthwhile. Pure (no I/O) so it can
/// be unit-tested against hand-built `Pod` objects.
fn classify_container_liveness(pod: &Pod, container: Option<&str>) -> ContainerLiveness {
    // Pod is being torn down — don't chase it.
    if pod.metadata.deletion_timestamp.is_some() {
        return ContainerLiveness::Done;
    }
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or_default();
    let cs = match container {
        Some(name) => statuses.iter().find(|c| c.name == name),
        None => statuses.first(),
    };
    let Some(cs) = cs else {
        // No status row yet — pod is very early in its lifecycle.
        return ContainerLiveness::Waiting("pod initializing".to_owned());
    };
    let Some(state) = cs.state.as_ref() else {
        return ContainerLiveness::Unknown;
    };
    if state.running.is_some() {
        return ContainerLiveness::Active;
    }
    if let Some(waiting) = &state.waiting {
        let reason = waiting
            .reason
            .clone()
            .unwrap_or_else(|| "waiting".to_owned());
        return ContainerLiveness::Waiting(reason);
    }
    if let Some(term) = &state.terminated {
        let policy = pod
            .spec
            .as_ref()
            .and_then(|s| s.restart_policy.as_deref())
            .unwrap_or("Always");
        let restarts = match policy {
            "Never" => false,
            "OnFailure" => term.exit_code != 0,
            // "Always" (the default) — and anything unrecognised.
            _ => true,
        };
        return if restarts {
            ContainerLiveness::Waiting(
                term.reason
                    .clone()
                    .unwrap_or_else(|| "restarting".to_owned()),
            )
        } else {
            ContainerLiveness::Done
        };
    }
    ContainerLiveness::Unknown
}

/// Fetch the pod and classify whether reconnecting could yield more logs.
async fn probe_container(api: &Api<Pod>, pod: &str, container: Option<&str>) -> ContainerLiveness {
    match api.get_opt(pod).await {
        Ok(Some(p)) => classify_container_liveness(&p, container),
        Ok(None) => ContainerLiveness::Done,
        Err(_) => ContainerLiveness::Unknown,
    }
}

/// Open the log stream, polling through a container's start-up. Emits
/// `Waiting` while it waits and `Ended` if it gives up (returning `None` in
/// that case so the caller just stops).
async fn open_stream(
    api: &Api<Pod>,
    pod: &str,
    params: &LogParams,
    tx: &broadcast::Sender<LogEvent>,
) -> Option<impl AsyncBufRead + Unpin> {
    let mut attempts: u32 = 0;
    let mut last_waiting: Option<String> = None;
    loop {
        match api.log_stream(pod, params).await {
            Ok(s) => return Some(s),
            Err(e) => match classify_open_error(&e) {
                OpenFailure::Starting(reason) if attempts < MAX_WAIT_ATTEMPTS => {
                    attempts += 1;
                    // De-dupe: only re-signal when the reason actually
                    // changes (PodInitializing → ContainerCreating, etc.).
                    if last_waiting.as_deref() != Some(reason.as_str()) {
                        let _ = tx.send(LogEvent::Waiting {
                            reason: reason.clone(),
                        });
                        last_waiting = Some(reason);
                    }
                    tokio::time::sleep(RETRY_INTERVAL).await;
                }
                OpenFailure::Starting(reason) => {
                    let _ = tx.send(LogEvent::Ended {
                        reason: format!("gave up waiting for container: {reason}"),
                    });
                    return None;
                }
                OpenFailure::Fatal(reason) => {
                    let _ = tx.send(LogEvent::Ended {
                        reason: format!("open failed: {reason}"),
                    });
                    return None;
                }
            },
        }
    }
}

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
        let container: Option<String> = container.map(ToOwned::to_owned);

        let (tx, _rx) = broadcast::channel(LINE_BUFFER);
        let tx_task = tx.clone();

        let task = tokio::spawn(async move {
            // Timestamp of the last line we forwarded. On reconnect the
            // apiserver re-sends an overlapping `tail_lines` window; we
            // skip anything at or before this so reconnects don't
            // duplicate already-shown output.
            let mut last_ts: Option<String> = None;
            let mut dead_reconnects: u32 = 0;

            loop {
                let params = LogParams {
                    follow: true,
                    tail_lines: Some(TAIL_LINES),
                    container: container.clone(),
                    // Apiserver prepends an RFC3339Nano timestamp per line;
                    // the frontend parses + reformats it for the gutter,
                    // and we use it for reconnect de-duplication. Cheap
                    // (~30 bytes/line) and avoids a second round trip.
                    timestamps: true,
                    ..Default::default()
                };

                // ---- open (polls through container start-up) ----
                let stream = match open_stream(&api, &pod, &params, &tx_task).await {
                    Some(s) => s,
                    None => return, // `open_stream` already sent `Ended`
                };

                // ---- pump lines ----
                let mut reader = stream.lines();
                // Lines at/<= this timestamp were already forwarded before
                // a reconnect — skip until we cross the boundary.
                let mut skip_through = last_ts.clone();
                let mut produced = false;
                let end = loop {
                    match reader.next().await {
                        Some(Ok(line)) => {
                            if let Some(skip) = skip_through.as_deref() {
                                match line_timestamp(&line) {
                                    Some(ts) if ts <= skip => continue,
                                    // Crossed the boundary (or an
                                    // un-timestamped line) — stop skipping.
                                    _ => skip_through = None,
                                }
                            }
                            if let Some(ts) = line_timestamp(&line) {
                                last_ts = Some(ts.to_owned());
                            }
                            produced = true;
                            // send returns Err when no receivers; that's fine.
                            let _ = tx_task.send(LogEvent::Line { text: line });
                        }
                        Some(Err(e)) => break StreamEnd::Error(e.to_string()),
                        None => break StreamEnd::Closed,
                    }
                };

                // ---- reconnect, or finish for good ----
                if produced {
                    dead_reconnects = 0;
                }
                let liveness = probe_container(&api, &pod, container.as_deref()).await;
                match liveness {
                    ContainerLiveness::Active | ContainerLiveness::Waiting(_)
                        if dead_reconnects < MAX_DEAD_RECONNECTS =>
                    {
                        if !produced {
                            dead_reconnects += 1;
                        }
                        let detail = match &liveness {
                            ContainerLiveness::Waiting(r) => r.clone(),
                            _ => match &end {
                                StreamEnd::Error(e) => e.clone(),
                                StreamEnd::Closed => "stream closed".to_owned(),
                            },
                        };
                        let _ = tx_task.send(LogEvent::Waiting {
                            reason: format!("reconnecting — {detail}"),
                        });
                        tokio::time::sleep(RECONNECT_DELAY).await;
                        // loop back round to re-open
                    }
                    ContainerLiveness::Active | ContainerLiveness::Waiting(_) => {
                        // Hit the dead-reconnect cap — stop churning.
                        let _ = tx_task.send(LogEvent::Ended {
                            reason: format!(
                                "stopped after {MAX_DEAD_RECONNECTS} reconnect \
                                 attempts with no output"
                            ),
                        });
                        return;
                    }
                    ContainerLiveness::Done | ContainerLiveness::Unknown => {
                        let _ = tx_task.send(LogEvent::Ended {
                            reason: match end {
                                StreamEnd::Closed => "stream closed".to_owned(),
                                StreamEnd::Error(e) => format!("read error: {e}"),
                            },
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

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        ContainerState, ContainerStateRunning, ContainerStateTerminated, ContainerStateWaiting,
        ContainerStatus, PodSpec, PodStatus,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use kube::core::Status;

    fn api_err(message: &str, code: u16) -> kube::Error {
        kube::Error::Api(Box::new(Status {
            message: message.to_owned(),
            reason: "BadRequest".to_owned(),
            code,
            ..Default::default()
        }))
    }

    #[test]
    fn pod_initializing_is_retryable() {
        let err = api_err(
            "container \"bq-gate-migration\" in pod \"bq-gate-schema-migration-x\" \
             is waiting to start: PodInitializing",
            400,
        );
        match classify_open_error(&err) {
            OpenFailure::Starting(msg) => {
                assert!(msg.contains("is waiting to start: PodInitializing"));
                // Cleaned message — no `ApiError:` / `Status { … }` debug noise.
                assert!(!msg.contains("Status {"));
            }
            OpenFailure::Fatal(_) => panic!("PodInitializing should be retryable"),
        }
    }

    #[test]
    fn container_creating_is_retryable() {
        let err = api_err(
            "container \"app\" in pod \"p\" is waiting to start: ContainerCreating",
            400,
        );
        assert!(matches!(
            classify_open_error(&err),
            OpenFailure::Starting(_)
        ));
    }

    #[test]
    fn stuck_reasons_fail_fast_instead_of_polling() {
        // All of these report as "is waiting to start: <reason>" but won't
        // recover by waiting — they must be Fatal, not Starting.
        for reason in [
            "ImagePullBackOff",
            "ErrImagePull",
            "InvalidImageName",
            "CreateContainerConfigError",
            "RunContainerError",
            "CrashLoopBackOff",
        ] {
            let err = api_err(
                &format!("container \"c\" in pod \"p\" is waiting to start: {reason}"),
                400,
            );
            match classify_open_error(&err) {
                OpenFailure::Fatal(msg) => assert!(
                    msg.contains(reason),
                    "{reason}: message should carry the reason"
                ),
                OpenFailure::Starting(_) => {
                    panic!("{reason} should fail fast, not poll")
                }
            }
        }
    }

    #[test]
    fn missing_pod_is_fatal() {
        let err = api_err("pods \"ghost\" not found", 404);
        assert!(matches!(classify_open_error(&err), OpenFailure::Fatal(_)));
    }

    #[test]
    fn forbidden_is_fatal() {
        let err = api_err("logs is forbidden: cannot get resource", 403);
        match classify_open_error(&err) {
            OpenFailure::Fatal(msg) => assert!(msg.contains("forbidden")),
            OpenFailure::Starting(_) => panic!("403 should be fatal"),
        }
    }

    #[test]
    fn non_api_error_is_fatal() {
        let err = kube::Error::LinesCodecMaxLineLengthExceeded;
        assert!(matches!(classify_open_error(&err), OpenFailure::Fatal(_)));
    }

    #[test]
    fn line_timestamp_extracts_rfc3339_prefix() {
        let ts = line_timestamp("2026-05-14T10:30:00.123456789Z hello world");
        assert_eq!(ts, Some("2026-05-14T10:30:00.123456789Z"));
    }

    #[test]
    fn line_timestamp_rejects_un_prefixed_lines() {
        assert_eq!(line_timestamp("just a plain log line"), None);
        assert_eq!(line_timestamp("ERROR something broke"), None);
        assert_eq!(line_timestamp(""), None);
    }

    fn pod_with(spec: Option<PodSpec>, status: Option<PodStatus>) -> Pod {
        Pod {
            spec,
            status,
            ..Default::default()
        }
    }

    fn container_status(name: &str, state: ContainerState) -> ContainerStatus {
        ContainerStatus {
            name: name.to_owned(),
            state: Some(state),
            ..Default::default()
        }
    }

    #[test]
    fn running_container_is_active() {
        let pod = pod_with(
            None,
            Some(PodStatus {
                container_statuses: Some(vec![container_status(
                    "app",
                    ContainerState {
                        running: Some(ContainerStateRunning::default()),
                        ..Default::default()
                    },
                )]),
                ..Default::default()
            }),
        );
        assert_eq!(
            classify_container_liveness(&pod, Some("app")),
            ContainerLiveness::Active
        );
    }

    #[test]
    fn waiting_container_carries_its_reason() {
        let pod = pod_with(
            None,
            Some(PodStatus {
                container_statuses: Some(vec![container_status(
                    "app",
                    ContainerState {
                        waiting: Some(ContainerStateWaiting {
                            reason: Some("CrashLoopBackOff".to_owned()),
                            message: None,
                        }),
                        ..Default::default()
                    },
                )]),
                ..Default::default()
            }),
        );
        assert_eq!(
            classify_container_liveness(&pod, Some("app")),
            ContainerLiveness::Waiting("CrashLoopBackOff".to_owned())
        );
    }

    fn terminated_pod(restart_policy: &str, exit_code: i32) -> Pod {
        pod_with(
            Some(PodSpec {
                restart_policy: Some(restart_policy.to_owned()),
                ..Default::default()
            }),
            Some(PodStatus {
                container_statuses: Some(vec![container_status(
                    "app",
                    ContainerState {
                        terminated: Some(ContainerStateTerminated {
                            exit_code,
                            reason: Some("Completed".to_owned()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )]),
                ..Default::default()
            }),
        )
    }

    #[test]
    fn terminated_job_pod_is_done() {
        // restartPolicy: Never — a finished Job pod, won't run again.
        assert_eq!(
            classify_container_liveness(&terminated_pod("Never", 0), Some("app")),
            ContainerLiveness::Done
        );
        // OnFailure + clean exit — also done.
        assert_eq!(
            classify_container_liveness(&terminated_pod("OnFailure", 0), Some("app")),
            ContainerLiveness::Done
        );
    }

    #[test]
    fn terminated_container_that_will_restart_waits() {
        // restartPolicy: Always — kubelet will spin it back up.
        assert!(matches!(
            classify_container_liveness(&terminated_pod("Always", 1), Some("app")),
            ContainerLiveness::Waiting(_)
        ));
        // OnFailure + non-zero exit — will be retried.
        assert!(matches!(
            classify_container_liveness(&terminated_pod("OnFailure", 1), Some("app")),
            ContainerLiveness::Waiting(_)
        ));
    }

    #[test]
    fn pod_being_deleted_is_done() {
        let mut pod = terminated_pod("Always", 1);
        pod.metadata.deletion_timestamp = Some(Time(k8s_openapi::jiff::Timestamp::now()));
        // Even though the container would restart, a pod under deletion is
        // going away — don't chase it.
        assert_eq!(
            classify_container_liveness(&pod, Some("app")),
            ContainerLiveness::Done
        );
    }

    #[test]
    fn missing_container_status_treated_as_starting() {
        let pod = pod_with(None, Some(PodStatus::default()));
        assert!(matches!(
            classify_container_liveness(&pod, Some("app")),
            ContainerLiveness::Waiting(_)
        ));
    }
}
