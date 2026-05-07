//! Per-cluster apiserver health probe.
//!
//! Watcher streams use kube-rs's `default_backoff()` and silently retry on
//! transient errors, so when the apiserver actually disappears the operator
//! sees stale rows with no signal that anything is wrong — only the metrics
//! polling loop fails visibly because it's the one place we explicitly poll
//! and expose `available: false`. This service fills the gap with a cheap
//! dedicated probe so the UI can flip the cluster into an unavailable state
//! instead of pretending the last cached snapshot is current.
//!
//! Probes [`PROBE_INTERVAL`] every tick. The first failure starts a timer;
//! [`UNHEALTHY_AFTER`] of consecutive failures flips status to `Unavailable`
//! and broadcasts the event exactly once. After that the probe goes dormant
//! — recovery is operator-driven (manual reconnect rebuilds the
//! `ClusterEntry` and spawns a fresh service against a fresh client).
//!
//! Why not auto-retry: a wedged kube `Client`'s HTTP/2 pool can keep failing
//! after the apiserver comes back. The clean recovery is to drop the entry
//! and reconnect — and once we're tearing down anyway, an in-flight retry
//! loop just races the teardown.
use std::sync::Arc;
use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{interval, MissedTickBehavior};

/// One canonical "is this cluster actually usable" check. Lists
/// Namespaces with `limit=1` — exercises the same code path the
/// resource watchers use (LIST → WATCH against a real apiserver
/// resource), so a probe success means the eager namespaces watcher
/// will succeed too.
///
/// Why not `/version` or `/api`: both are commonly served from cache
/// by an LB or by the apiserver itself even when etcd is dead or the
/// watch / LIST paths are wedged. The user's failure mode is
/// "apiserver answers /api in 50ms but pod LIST hangs forever";
/// `/version` and `/api` can't catch that. A real LIST does.
///
/// Note: requires `list namespaces` cluster-wide RBAC. Operators
/// without that permission will see this as a 403 — which is still a
/// signal the apiserver is responding (Api(_) error vs Service(_)),
/// but we treat all errors as failure for simplicity. If false-positive
/// 403s become a real complaint, switch to `Api(_) is alive,
/// Service(_) is dead`.
pub async fn liveness_probe(client: &Client) -> Result<(), kube::Error> {
    let api: Api<Namespace> = Api::all(client.clone());
    api.list(&ListParams::default().limit(1)).await?;
    Ok(())
}

/// How often to probe the apiserver. 5s gives us 6 attempts inside the
/// unhealthy window so a single timeout doesn't trip teardown.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(5);

/// Consecutive-failure window before declaring unavailable. Picked to cover
/// brief apiserver hiccups, kubelet restarts, and 30-second DNS TTLs without
/// false positives.
pub const UNHEALTHY_AFTER: Duration = Duration::from_secs(30);

const BROADCAST_CAP: usize = 8;

/// Per-tick probe budget. The default kube client timeout is generous; cap
/// the probe so a slow apiserver doesn't stall the loop and accidentally
/// extend the unhealthy window.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClusterHealthStatus {
    Healthy,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterHealthEvent {
    pub status: ClusterHealthStatus,
    /// Last error reason when `status == Unavailable`. `None` when healthy.
    pub reason: Option<String>,
}

pub struct ClusterHealth {
    tx: broadcast::Sender<ClusterHealthEvent>,
    last: Arc<Mutex<ClusterHealthEvent>>,
    task: JoinHandle<()>,
}

impl Drop for ClusterHealth {
    fn drop(&mut self) {
        // Aborts the probe loop the moment the entry is dropped (manual
        // reconnect path). A fresh `start()` against the rebuilt client
        // gets a clean task.
        self.task.abort();
    }
}

impl ClusterHealth {
    #[must_use]
    pub fn start(client: Client) -> Arc<Self> {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let last = Arc::new(Mutex::new(ClusterHealthEvent {
            status: ClusterHealthStatus::Healthy,
            reason: None,
        }));

        let task = tokio::spawn({
            let tx = tx.clone();
            let last = last.clone();
            async move {
                tracing::info!(
                    probe_interval_secs = PROBE_INTERVAL.as_secs(),
                    unhealthy_after_secs = UNHEALTHY_AFTER.as_secs(),
                    probe_timeout_secs = PROBE_TIMEOUT.as_secs(),
                    "cluster health probe: started"
                );
                let mut tick = interval(PROBE_INTERVAL);
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                // Skip the immediate first tick — connect_context just
                // ran a successful round trip building this client, so
                // declaring "healthy" 0ms after start adds no signal.
                tick.tick().await;

                let mut first_failure_at: Option<Instant> = None;
                let mut last_reason: Option<String> = None;
                let mut failure_streak: u32 = 0;
                loop {
                    tick.tick().await;
                    // Real LIST (limit=1) — same path the watchers use.
                    // `/api` and `/version` can both succeed against a
                    // wedged cluster while a real LIST hangs (etcd
                    // dead, watch broken, LB in front of dead replicas).
                    // See `liveness_probe` doc.
                    let probe = tokio::time::timeout(PROBE_TIMEOUT, liveness_probe(&client)).await;
                    match probe {
                        Ok(Ok(_info)) => {
                            // Recovery path: only emit if we'd previously
                            // observed a failure window. We don't currently
                            // surface "recovered" to the UI (manual
                            // reconnect re-spawns), but emitting keeps the
                            // broadcast channel honest for any future
                            // consumer.
                            if first_failure_at.is_some() {
                                tracing::info!(
                                    failures = failure_streak,
                                    "cluster health probe: recovered"
                                );
                                first_failure_at = None;
                                last_reason = None;
                                failure_streak = 0;
                                let evt = ClusterHealthEvent {
                                    status: ClusterHealthStatus::Healthy,
                                    reason: None,
                                };
                                *last.lock().await = evt.clone();
                                let _ = tx.send(evt);
                            }
                        }
                        Ok(Err(e)) => {
                            last_reason = Some(e.to_string());
                            failure_streak += 1;
                            tracing::warn!(
                                streak = failure_streak,
                                error = %e,
                                "cluster health probe: failed"
                            );
                        }
                        Err(_) => {
                            last_reason = Some(format!("probe timed out after {PROBE_TIMEOUT:?}"));
                            failure_streak += 1;
                            tracing::warn!(
                                streak = failure_streak,
                                "cluster health probe: timed out after {PROBE_TIMEOUT:?}"
                            );
                        }
                    }

                    if last_reason.is_some() {
                        let started = *first_failure_at.get_or_insert_with(Instant::now);
                        if started.elapsed() >= UNHEALTHY_AFTER {
                            let reason = last_reason.take();
                            let evt = ClusterHealthEvent {
                                status: ClusterHealthStatus::Unavailable,
                                reason: reason.clone(),
                            };
                            *last.lock().await = evt.clone();
                            let _ = tx.send(evt);
                            tracing::warn!(
                                reason = ?reason,
                                streak = failure_streak,
                                "cluster declared unavailable after {UNHEALTHY_AFTER:?} of failed probes — probe loop exiting; recovery requires manual reconnect"
                            );
                            return;
                        }
                    }
                }
            }
        });

        Arc::new(Self { tx, last, task })
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ClusterHealthEvent> {
        self.tx.subscribe()
    }

    pub async fn snapshot(&self) -> ClusterHealthEvent {
        self.last.lock().await.clone()
    }
}
