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
//! Probes [`PROBE_INTERVAL`] every tick, skipping the request when a watch
//! delivered events since the last tick ([`AliveBeacon`]) — that traffic
//! already proves the apiserver answers. The first failure starts a timer;
//! [`UNHEALTHY_AFTER`] of consecutive failures flips status to `Unavailable`
//! and broadcasts the event exactly once. After that the probe goes dormant
//! — recovery is operator-driven (manual reconnect rebuilds the
//! `ClusterEntry` and spawns a fresh service against a fresh client).
//!
//! Why not auto-retry: a wedged kube `Client`'s HTTP/2 pool can keep failing
//! after the apiserver comes back. The clean recovery is to drop the entry
//! and reconnect — and once we're tearing down anyway, an in-flight retry
//! loop just races the teardown.
use std::sync::atomic::{AtomicU64, Ordering};
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
/// resource), so `Alive` means the eager namespaces watcher will succeed
/// too; `Restricted` only that the apiserver is up.
///
/// Why not `/version` or `/api`: both are commonly served from cache
/// by an LB or by the apiserver itself even when etcd is dead or the
/// watch / LIST paths are wedged. The user's failure mode is
/// "apiserver answers /api in 50ms but pod LIST hangs forever";
/// `/version` and `/api` can't catch that. A real LIST does.
///
/// A 403 still proves the apiserver answered and authenticated us: it is
/// the normal answer for a namespace-scoped identity, so it counts as alive.
pub async fn liveness_probe(client: &Client) -> Result<Liveness, kube::Error> {
    let api: Api<Namespace> = Api::all(client.clone());
    match api.list(&ListParams::default().limit(1)).await {
        Ok(_) => Ok(Liveness::Alive),
        // A kubeconfig without usable credentials, on a cluster that allows
        // anonymous requests, is refused as `system:anonymous`: an auth
        // failure, not a restricted identity.
        Err(e) if is_forbidden(&e) && !is_anonymous(&e) => {
            ready_probe(client).await?;
            Ok(Liveness::Restricted(e.to_string()))
        }
        Err(e) => Err(e),
    }
}

fn is_anonymous(e: &kube::Error) -> bool {
    matches!(e, kube::Error::Api(s) if s.message.contains("\"system:anonymous\""))
}

/// The probe for an identity that can't list namespaces. `/readyz` includes
/// the etcd check and every authenticated identity may read it
/// (`system:public-info-viewer`); where a hardened cluster hides it, its 403
/// still proves the apiserver answered.
pub async fn ready_probe(client: &Client) -> Result<(), kube::Error> {
    let req = http::Request::get("/readyz")
        .body(Vec::new())
        .map_err(kube::Error::HttpError)?;
    match client.request_text(req).await {
        Ok(_) => Ok(()),
        Err(e) if is_forbidden(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    /// Alive, but this identity can't list namespaces cluster-wide. Carries
    /// the apiserver's 403 verbatim (cloud-identity hints parse its `User`).
    Restricted(String),
}

/// An apiserver authorization denial. A proxy or WAF answering 403 with an
/// HTML page parses without the apiserver's `Forbidden` reason.
fn is_forbidden(e: &kube::Error) -> bool {
    matches!(e, kube::Error::Api(s) if s.code == 403 && s.reason == "Forbidden")
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
    beacon: AliveBeacon,
    task: JoinHandle<()>,
}

/// Marked by anything that just heard from the apiserver (watch events).
#[derive(Clone, Debug)]
pub struct AliveBeacon {
    epoch: Instant,
    /// Milliseconds after `epoch` of the last mark; 0 = never.
    at_ms: Arc<AtomicU64>,
}

impl AliveBeacon {
    fn new() -> Self {
        Self {
            epoch: Instant::now(),
            at_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn mark(&self) {
        let ms = u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.at_ms.store(ms.max(1), Ordering::Relaxed);
    }

    fn seen_within(&self, window: Duration) -> bool {
        let at = self.at_ms.load(Ordering::Relaxed);
        at != 0 && u128::from(at) + window.as_millis() >= self.epoch.elapsed().as_millis()
    }
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

        let beacon = AliveBeacon::new();
        let task = tokio::spawn({
            let tx = tx.clone();
            let last = last.clone();
            let beacon = beacon.clone();
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

                let mut first_failure_at: Option<tokio::time::Instant> = None;
                let mut last_reason: Option<String> = None;
                let mut failure_streak: u32 = 0;
                let mut restricted = false;
                loop {
                    tick.tick().await;
                    // Real LIST (limit=1), or `/readyz` once restricted.
                    // See `liveness_probe` doc.
                    let probe = if beacon.seen_within(PROBE_INTERVAL) {
                        Ok(Ok(Liveness::Alive))
                    } else if restricted {
                        // Skip the LIST we know is refused: it only fills
                        // the audit log.
                        tokio::time::timeout(PROBE_TIMEOUT, ready_probe(&client))
                            .await
                            .map(|r| r.map(|()| Liveness::Restricted(String::new())))
                    } else {
                        tokio::time::timeout(PROBE_TIMEOUT, liveness_probe(&client)).await
                    };
                    if let Ok(Ok(Liveness::Restricted(_))) = &probe {
                        restricted = true;
                    }
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
                        let started =
                            *first_failure_at.get_or_insert_with(tokio::time::Instant::now);
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

        Arc::new(Self {
            tx,
            last,
            beacon,
            task,
        })
    }

    /// Handle for reporting apiserver traffic; holds no reference to the
    /// probe itself.
    #[must_use]
    pub fn beacon(&self) -> AliveBeacon {
        self.beacon.clone()
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ClusterHealthEvent> {
        self.tx.subscribe()
    }

    pub async fn snapshot(&self) -> ClusterHealthEvent {
        self.last.lock().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORBIDDEN: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"namespaces is forbidden: User \"dev@x.io\" cannot list resource \"namespaces\"","reason":"Forbidden","code":403}"#;

    /// A fake apiserver: `namespaces` answers the LIST, `/readyz` its code.
    fn mock(namespaces: (u16, &'static str), readyz: u16) -> Client {
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| async move {
            let (code, body) = if req.uri().path() == "/readyz" {
                (readyz, if readyz == 403 { FORBIDDEN } else { "ok" })
            } else {
                namespaces
            };
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(code)
                    .body(kube::client::Body::from(body.as_bytes().to_vec()))
                    .unwrap(),
            )
        });
        Client::new(svc, "default")
    }

    #[tokio::test]
    async fn forbidden_probe_is_alive_but_restricted() {
        match liveness_probe(&mock((403, FORBIDDEN), 200)).await {
            Ok(Liveness::Restricted(m)) => assert!(m.contains("dev@x.io"), "{m}"),
            other => panic!("expected restricted, got {other:?}"),
        }
        // /readyz hidden on a hardened cluster: the 403 still proves life.
        let hidden = mock((403, FORBIDDEN), 403);
        assert!(matches!(
            liveness_probe(&hidden).await,
            Ok(Liveness::Restricted(_))
        ));
    }

    #[tokio::test]
    async fn restricted_probe_still_sees_a_dead_backend() {
        assert!(liveness_probe(&mock((403, FORBIDDEN), 500)).await.is_err());
        assert!(ready_probe(&mock((403, FORBIDDEN), 503)).await.is_err());
    }

    #[tokio::test]
    async fn an_anonymous_403_is_an_auth_failure() {
        const ANON: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"namespaces is forbidden: User \"system:anonymous\" cannot list resource \"namespaces\"","reason":"Forbidden","code":403}"#;
        assert!(liveness_probe(&mock((403, ANON), 200)).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn restricted_heartbeat_probes_readyz_and_still_sees_a_dead_backend() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        let lists = Arc::new(AtomicUsize::new(0));
        let readyz = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(AtomicBool::new(true));
        let (l, r, up) = (lists.clone(), readyz.clone(), ready.clone());
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let (l, r, up) = (l.clone(), r.clone(), up.clone());
            async move {
                let (code, body) = if req.uri().path() == "/readyz" {
                    r.fetch_add(1, Ordering::SeqCst);
                    if up.load(Ordering::SeqCst) {
                        (200, "ok")
                    } else {
                        (500, "[-]etcd failed")
                    }
                } else {
                    l.fetch_add(1, Ordering::SeqCst);
                    (403, FORBIDDEN)
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(code)
                        .body(kube::client::Body::from(body.as_bytes().to_vec()))
                        .unwrap(),
                )
            }
        });
        let health = ClusterHealth::start(Client::new(svc, "default"));
        let mut rx = health.subscribe();
        tokio::time::sleep(PROBE_INTERVAL * 4 + Duration::from_millis(100)).await;
        assert_eq!(
            lists.load(Ordering::SeqCst),
            1,
            "the refused LIST is asked once"
        );
        assert!(readyz.load(Ordering::SeqCst) >= 3);

        ready.store(false, Ordering::SeqCst);
        let down = tokio::time::timeout(UNHEALTHY_AFTER * 3, async {
            loop {
                let e = rx.recv().await.unwrap();
                if e.status == ClusterHealthStatus::Unavailable {
                    return e;
                }
            }
        })
        .await
        .expect("a dead backend is noticed");
        assert!(down.reason.is_some());
        assert_eq!(lists.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_proxy_403_is_not_the_apiserver() {
        let html = mock((403, "<html>Access denied by proxy</html>"), 200);
        assert!(liveness_probe(&html).await.is_err());
        assert!(liveness_probe(&mock((401, "Unauthorized"), 200))
            .await
            .is_err());
    }

    #[test]
    fn beacon_counts_only_recent_marks() {
        let beacon = AliveBeacon::new();
        assert!(!beacon.seen_within(PROBE_INTERVAL), "never marked");
        beacon.clone().mark();
        assert!(beacon.seen_within(PROBE_INTERVAL), "clones share the mark");

        let stale = AliveBeacon {
            epoch: Instant::now().checked_sub(Duration::from_mins(1)).unwrap(),
            at_ms: Arc::new(AtomicU64::new(1)),
        };
        assert!(!stale.seen_within(PROBE_INTERVAL));
    }
}
