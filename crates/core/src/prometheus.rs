//! Prometheus-API-compatible metrics backend integration — discovery +
//! read-only `PromQL` via apiserver proxy.
//!
//! We never deploy or write to a metrics backend; we only *consume* one the
//! operator already has running in-cluster (CLAUDE.md §2 forbids bundling
//! our own monitoring stack). The Prometheus HTTP API
//! (`/api/v1/query{,_range}`) is the lingua franca for in-cluster TSDBs —
//! Victoria Metrics, Thanos, Grafana Mimir, Cortex, M3, and Promscale all
//! serve the exact same JSON shape on the same paths. So while this module
//! is named `prometheus`, the code treats them all uniformly: discovery
//! finds any Service whose labels match a known TSDB convention, the
//! single `validate` probe (`up` query → `{status:"success"}`) is the
//! "speaks Prom API?" check, and queries flow through the apiserver
//! proxy regardless of which backend is on the other side.
//!
//! 1. [`discover`] lists Services that look like a Prom-API-compatible
//!    backend by label. Each detected target is tagged with [`PromBackend`]
//!    so the UI can show "VM" / "Thanos" / "Mimir" / etc. instead of a
//!    generic "Prom" badge. Result is a small list the UI shows in Settings
//!    so the operator can pick which one to use; selection is persisted in
//!    `prefs.prometheus_targets[cluster_id]`.
//!
//! 2. [`query_instant`] / [`query_range`] proxy through the apiserver
//!    (`/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy/api/v1/query{,_range}`)
//!    so we re-use the user's kubeconfig auth and don't need a port-forward.
//!    The trade-off: the apiserver enforces RBAC for `services/proxy`, which
//!    not every cluster grants. A 403 on the proxy path bubbles up as an
//!    error so the UI can suggest port-forwarding as a fallback.
//!
//! The `PromQL` response is passed through as untyped `serde_json::Value` —
//! it's a tiny number of well-known shapes (matrix / vector / scalar), and
//! the frontend already parses them.

use http::Request;
use k8s_openapi::api::core::v1::Service;
use kube::{
    api::{Api, ListParams},
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum PromError {
    #[error("kube error: {0}")]
    Kube(#[from] kube::Error),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("prometheus returned non-success status: {0}")]
    Status(String),
}

/// Which TSDB the Service appears to be running. Inferred from labels —
/// not authoritative. The probe (`up` query) is what proves API
/// compatibility; this enum is for display + diagnostics only. `Unknown`
/// covers cases where labels match nothing recognized but the Service
/// was still discovered (e.g. a CNAME that responds to `PromQL`).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PromBackend {
    #[default]
    Prometheus,
    VictoriaMetrics,
    Thanos,
    Mimir,
    Cortex,
    M3,
    Promscale,
    Unknown,
}

impl PromBackend {
    /// Short human label for the UI badge (`VM`, `Thanos`, `Prom`, ...).
    #[must_use]
    pub fn short_label(self) -> &'static str {
        match self {
            Self::Prometheus => "Prom",
            Self::VictoriaMetrics => "VM",
            Self::Thanos => "Thanos",
            Self::Mimir => "Mimir",
            Self::Cortex => "Cortex",
            Self::M3 => "M3",
            Self::Promscale => "Promscale",
            Self::Unknown => "TSDB",
        }
    }
}

/// One Prom-API-compatible Service the operator can pick. Only the fields
/// needed to build a proxy URL — the UI joins additional context (namespace
/// labels, pod-count) by calling its existing watchers if needed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PromTarget {
    pub namespace: String,
    pub service: String,
    pub port: u16,
    /// `http` or `https`. We pick this from the Service port name when it's
    /// suggestive (`web`, `http-web`, `https`) and default to `http`.
    /// The apiserver proxy syntax embeds the scheme as a port-name prefix:
    /// `services/<scheme>:<name>:<port>` — the URL writer in [`build_proxy_path`]
    /// handles that.
    pub scheme: String,
    /// Which TSDB this looks like (Prom / VM / Thanos / ...). Inferred from
    /// labels at discovery time; defaults to [`PromBackend::Prometheus`]
    /// for entries written by an earlier version of the cache.
    #[serde(default)]
    pub backend: PromBackend,
}

impl PromTarget {
    /// Stable, human-readable id used by the UI to dedupe + display.
    #[must_use]
    pub fn id(&self) -> String {
        format!("{}/{}:{}", self.namespace, self.service, self.port)
    }
}

// Service-label patterns that identify a Prom-API-compatible backend. We
// run each as a separate LIST in parallel and union the results — label
// selectors don't support OR across keys, so this is the simplest form
// that covers the ecosystem without writing one giant `in (...)` clause
// (the longest list of values supported is bounded, and `app` vs
// `app.kubernetes.io/name` are different keys anyway).
//
// When in doubt about whether something belongs here: the test is "does
// it serve `/api/v1/query` with the canonical Prometheus JSON shape?" If
// yes, add it; the probe + classify together will sort it out.
const DISCOVERY_SELECTORS: &[&str] = &[
    "app.kubernetes.io/name in (prometheus,prometheus-server)",
    "app in (prometheus,prometheus-server)",
    // Victoria Metrics — vmsingle is the all-in-one binary, vmselect is
    // the read path of the cluster topology. vmagent / vmauth / vminsert
    // also carry the label but don't serve PromQL — discovery picks them
    // up; the validate probe filters them back out.
    "app.kubernetes.io/name in (vmsingle,vmselect,victoria-metrics,victoriametrics)",
    "app in (vmsingle,vmselect,victoria-metrics,victoriametrics)",
    // Thanos — `thanos-query` (newer) and `thanos-querier` (older) are
    // the read-side; `thanos-receive` and others don't serve PromQL.
    "app.kubernetes.io/name in (thanos,thanos-query,thanos-querier)",
    "app in (thanos,thanos-query,thanos-querier)",
    // Grafana Mimir — `mimir` covers the all-in-one rollup; the
    // microservices topology surfaces `mimir-query-frontend`. Cortex is
    // Mimir's predecessor, same API.
    "app.kubernetes.io/name in (mimir,mimir-query-frontend,cortex,cortex-query-frontend)",
    "app in (mimir,mimir-query-frontend,cortex,cortex-query-frontend)",
    // M3 — `m3coordinator` is the gateway that exposes Prom API.
    "app.kubernetes.io/name in (m3coordinator,m3query)",
    "app in (m3coordinator,m3query)",
    // Promscale — the Prom-API-compatible front-end for TimescaleDB.
    "app.kubernetes.io/name in (promscale,promscale-connector)",
    "app in (promscale,promscale-connector)",
];

/// List Services that look like a Prometheus instance. Two selector queries
/// (covering the two most common chart conventions), unioned + deduped by
/// `(namespace, name)`. Empty list = none found, *not* an error — the UI
/// shows that as "no Prometheus detected, configure manually".
pub async fn discover(client: Client) -> Result<Vec<PromTarget>, PromError> {
    let api: Api<Service> = Api::all(client);
    // Run both label selectors concurrently — each is an independent
    // cluster-wide Service LIST and there's no reason to serialize them.
    let lists = futures::future::join_all(DISCOVERY_SELECTORS.iter().map(|selector| {
        let api = api.clone();
        async move {
            let lp = ListParams::default().labels(selector);
            (selector, api.list(&lp).await)
        }
    }))
    .await;

    let mut out: Vec<PromTarget> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    for (selector, res) in lists {
        let list = match res {
            Ok(l) => l,
            Err(e) => {
                // Forbidden on services list happens in tightly RBAC'd
                // clusters. Skip this selector but keep the other's results.
                tracing::debug!(selector = %selector, error = %e, "prometheus discovery list failed");
                continue;
            }
        };
        for svc in list.items {
            let Some(ns) = svc.metadata.namespace.clone() else {
                continue;
            };
            let Some(name) = svc.metadata.name.clone() else {
                continue;
            };
            let key = (ns.clone(), name.clone());
            if !seen.insert(key) {
                continue;
            }
            let backend = classify(svc.metadata.labels.as_ref());
            let (port, scheme) = pick_port(&svc, backend)
                .unwrap_or_else(|| (default_port(backend), "http".to_owned()));
            out.push(PromTarget {
                namespace: ns,
                service: name,
                port,
                scheme,
                backend,
            });
        }
    }
    // Sort for stable UI ordering.
    out.sort_by(|a, b| {
        (a.namespace.as_str(), a.service.as_str()).cmp(&(b.namespace.as_str(), b.service.as_str()))
    });
    Ok(out)
}

/// Map Service labels → likely backend. Uses `app.kubernetes.io/name` if
/// present (modern convention) and falls back to `app` (older charts).
/// Substring matching keeps us tolerant to chart suffixes
/// (`vmsingle-server`, `thanos-query-frontend`, ...) without listing every
/// permutation. `Unknown` covers a Service that matched a selector but
/// whose name doesn't look like any of the known backends — still
/// dispatchable through the same probe + query path.
fn classify(labels: Option<&std::collections::BTreeMap<String, String>>) -> PromBackend {
    let n = labels
        .and_then(|m| {
            m.get("app.kubernetes.io/name")
                .or_else(|| m.get("app"))
                .map(String::as_str)
        })
        .unwrap_or("");
    let n = n.to_ascii_lowercase();
    if n.contains("victoria") || n == "vmsingle" || n == "vmselect" {
        PromBackend::VictoriaMetrics
    } else if n.contains("thanos") {
        PromBackend::Thanos
    } else if n.contains("mimir") {
        PromBackend::Mimir
    } else if n.contains("cortex") {
        PromBackend::Cortex
    } else if n.starts_with("m3coordinator") || n == "m3query" {
        PromBackend::M3
    } else if n.contains("promscale") {
        PromBackend::Promscale
    } else if n.contains("prometheus") {
        PromBackend::Prometheus
    } else {
        PromBackend::Unknown
    }
}

/// Per-backend default API port, used only when the Service has no port
/// spec at all (rare). Most real Services list at least one port and we
/// pick from there.
fn default_port(backend: PromBackend) -> u16 {
    match backend {
        PromBackend::Prometheus | PromBackend::Unknown => 9090,
        PromBackend::VictoriaMetrics => 8428,
        PromBackend::Thanos => 10902,
        PromBackend::Mimir | PromBackend::Cortex => 8080,
        PromBackend::M3 => 7201,
        PromBackend::Promscale => 9201,
    }
}

/// Pick the port we'll route through. Strategy:
/// 1. Try a backend-specific name first (`vmsingle`, `query` for Thanos,
///    `http-metrics` for Mimir, ...).
/// 2. Then the generic "looks like the API" names (`http`, `web`, `https`).
/// 3. Then the first port.
/// 4. Fall back to the backend's default port (handled at the call site).
fn pick_port(svc: &Service, backend: PromBackend) -> Option<(u16, String)> {
    let ports = svc.spec.as_ref()?.ports.as_ref()?;
    if ports.is_empty() {
        return None;
    }
    let backend_specific: &[&str] = match backend {
        PromBackend::VictoriaMetrics => &["vmsingle", "vmselect", "vmagent", "vminsert"],
        PromBackend::Thanos => &["query", "http", "grpc-http"],
        PromBackend::Mimir | PromBackend::Cortex => &["http-metrics", "http"],
        PromBackend::M3 => &["coordinator-http"],
        PromBackend::Promscale => &["http-api", "http"],
        PromBackend::Prometheus | PromBackend::Unknown => &["prometheus"],
    };
    let generic = [
        "web",
        "http-web",
        "https-web",
        "https",
        "http",
        "http-api",
        "api",
    ];
    for &want in backend_specific.iter().chain(generic.iter()) {
        for p in ports {
            if p.name.as_deref() == Some(want) {
                let scheme = if want.starts_with("https") {
                    "https"
                } else {
                    "http"
                };
                if let Ok(port) = u16::try_from(p.port) {
                    return Some((port, scheme.to_owned()));
                }
            }
        }
    }
    let p = &ports[0];
    let scheme = match p.name.as_deref() {
        Some(n) if n.starts_with("https") => "https",
        _ => "http",
    };
    let port = u16::try_from(p.port).ok()?;
    Some((port, scheme.to_owned()))
}

/// Build the apiserver-proxy URL for a Prometheus query path. The
/// `scheme:name:port` form tells the proxy which port + protocol to use
/// when forwarding — this is what `kubectl proxy` does internally.
fn build_proxy_path(target: &PromTarget, prom_path: &str, query_string: &str) -> String {
    // `prom_path` is the Prometheus-relative path, e.g. "/api/v1/query".
    // Don't include a leading slash twice — strip-then-prefix.
    let p = prom_path.trim_start_matches('/');
    let q = if query_string.is_empty() {
        String::new()
    } else {
        format!("?{query_string}")
    };
    format!(
        "/api/v1/namespaces/{ns}/services/{scheme}:{svc}:{port}/proxy/{p}{q}",
        ns = target.namespace,
        svc = target.service,
        scheme = target.scheme,
        port = target.port,
    )
}

/// Cheap reachability check: run `up` with a 5s timeout. Returns Ok if the
/// proxy round-trip succeeded *and* Prometheus answered with `success`. Used
/// by the on-connect detection flow to decide whether a cached target is
/// still good — anything else (404 from apiserver proxy, RBAC denial,
/// unreachable Prometheus, malformed response) is treated as unhealthy.
pub async fn validate(client: Client, target: &PromTarget) -> Result<(), PromError> {
    use std::time::Duration;
    use tokio::time::timeout;
    match timeout(Duration::from_secs(5), query_instant(client, target, "up")).await {
        Ok(r) => r.map(|_| ()),
        Err(_) => Err(PromError::Status("validation timed out".to_owned())),
    }
}

/// Run a `PromQL` instant query. Returns the parsed `data` field of the
/// Prometheus response shape `{ status, data, errorType?, error? }`. A
/// non-`success` status surfaces as [`PromError::Status`] so the UI can
/// distinguish "Prometheus reachable but query bad" from network errors.
pub async fn query_instant(
    client: Client,
    target: &PromTarget,
    query: &str,
) -> Result<Value, PromError> {
    let qs = format!("query={}", urlencode(query));
    proxy_get(client, target, "/api/v1/query", &qs).await
}

/// Run a `PromQL` range query. `start` / `end` are RFC 3339 or unix seconds;
/// `step` is a Prometheus duration (e.g. `15s`, `1m`). The frontend supplies
/// already-formatted strings — we don't second-guess what units it picked.
pub async fn query_range(
    client: Client,
    target: &PromTarget,
    query: &str,
    start: &str,
    end: &str,
    step: &str,
) -> Result<Value, PromError> {
    let qs = format!(
        "query={q}&start={s}&end={e}&step={step}",
        q = urlencode(query),
        s = urlencode(start),
        e = urlencode(end),
        step = urlencode(step),
    );
    proxy_get(client, target, "/api/v1/query_range", &qs).await
}

async fn proxy_get(
    client: Client,
    target: &PromTarget,
    prom_path: &str,
    qs: &str,
) -> Result<Value, PromError> {
    let path = build_proxy_path(target, prom_path, qs);
    let req = Request::builder()
        .method("GET")
        .uri(&path)
        .header("accept", "application/json")
        .body(Vec::new())
        .map_err(|e| PromError::InvalidRequest(e.to_string()))?;
    let resp: Value = client.request(req).await?;
    let status = resp.get("status").and_then(Value::as_str).unwrap_or("");
    if status != "success" {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(PromError::Status(err.to_owned()));
    }
    Ok(resp.get("data").cloned().unwrap_or(Value::Null))
}

/// Minimal application/x-www-form-urlencoded escaping for query strings.
/// Avoids a new dep — the input here is small (a `PromQL` string + a few
/// timestamps) so we don't need a full crate.
fn urlencode(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_path_well_formed() {
        let t = PromTarget {
            namespace: "monitoring".into(),
            service: "kube-prom-stack-prometheus".into(),
            port: 9090,
            scheme: "http".into(),
            backend: PromBackend::Prometheus,
        };
        let p = build_proxy_path(&t, "/api/v1/query", "query=up");
        assert_eq!(
            p,
            "/api/v1/namespaces/monitoring/services/http:kube-prom-stack-prometheus:9090/proxy/api/v1/query?query=up"
        );
    }

    #[test]
    fn urlencode_basic() {
        assert_eq!(urlencode("up"), "up");
        assert_eq!(
            urlencode("rate(http_requests[5m])"),
            "rate%28http_requests%5B5m%5D%29"
        );
    }

    fn labels(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn classify_recognizes_common_backends() {
        let cases: &[(&[(&str, &str)], PromBackend)] = &[
            (
                &[("app.kubernetes.io/name", "prometheus")],
                PromBackend::Prometheus,
            ),
            (&[("app", "prometheus-server")], PromBackend::Prometheus),
            (
                &[("app.kubernetes.io/name", "vmsingle")],
                PromBackend::VictoriaMetrics,
            ),
            (&[("app", "victoria-metrics")], PromBackend::VictoriaMetrics),
            (
                &[("app.kubernetes.io/name", "thanos-query")],
                PromBackend::Thanos,
            ),
            (
                &[("app.kubernetes.io/name", "mimir-query-frontend")],
                PromBackend::Mimir,
            ),
            (&[("app", "cortex")], PromBackend::Cortex),
            (
                &[("app.kubernetes.io/name", "m3coordinator")],
                PromBackend::M3,
            ),
            (&[("app", "promscale-connector")], PromBackend::Promscale),
            (&[("app", "something-else")], PromBackend::Unknown),
            (&[], PromBackend::Unknown),
        ];
        for (lbls, want) in cases {
            let got = classify(Some(&labels(lbls)));
            assert_eq!(got, *want, "labels {lbls:?}");
        }
    }

    fn svc_with_ports(ports: &[(&str, i32)]) -> Service {
        use k8s_openapi::api::core::v1::{ServicePort, ServiceSpec};
        Service {
            spec: Some(ServiceSpec {
                ports: Some(
                    ports
                        .iter()
                        .map(|(n, p)| ServicePort {
                            name: Some((*n).to_owned()),
                            port: *p,
                            ..Default::default()
                        })
                        .collect(),
                ),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn pick_port_prefers_backend_specific_name() {
        let svc = svc_with_ports(&[("metrics", 9100), ("vmsingle", 8428), ("http", 80)]);
        let (port, scheme) = pick_port(&svc, PromBackend::VictoriaMetrics).unwrap();
        assert_eq!(port, 8428);
        assert_eq!(scheme, "http");
    }

    #[test]
    fn pick_port_falls_back_to_generic_http_then_first() {
        let svc = svc_with_ports(&[("metrics", 9100), ("http", 9090)]);
        let (port, _) = pick_port(&svc, PromBackend::Prometheus).unwrap();
        assert_eq!(port, 9090);

        let svc = svc_with_ports(&[("only", 12345)]);
        let (port, _) = pick_port(&svc, PromBackend::Prometheus).unwrap();
        assert_eq!(port, 12345, "no recognised name → first port");
    }

    #[test]
    fn pick_port_detects_https_scheme() {
        let svc = svc_with_ports(&[("https-web", 443), ("http", 80)]);
        let (port, scheme) = pick_port(&svc, PromBackend::Prometheus).unwrap();
        assert_eq!(port, 443);
        assert_eq!(scheme, "https");
    }

    #[test]
    fn pick_port_returns_none_for_empty_spec() {
        use k8s_openapi::api::core::v1::ServiceSpec;
        let svc = Service {
            spec: Some(ServiceSpec {
                ports: Some(vec![]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(pick_port(&svc, PromBackend::Prometheus).is_none());
    }

    #[test]
    fn target_id_is_stable() {
        let t = PromTarget {
            namespace: "monitoring".into(),
            service: "prom".into(),
            port: 9090,
            scheme: "http".into(),
            backend: PromBackend::Prometheus,
        };
        assert_eq!(t.id(), "monitoring/prom:9090");
    }

    #[test]
    fn proxy_path_with_https_scheme_and_special_chars() {
        let t = PromTarget {
            namespace: "monitoring".into(),
            service: "vmselect".into(),
            port: 8481,
            scheme: "https".into(),
            backend: PromBackend::VictoriaMetrics,
        };
        let p = build_proxy_path(&t, "/api/v1/query", "query=rate%28http_requests%5B5m%5D%29");
        assert_eq!(
            p,
            "/api/v1/namespaces/monitoring/services/https:vmselect:8481/proxy/api/v1/query?query=rate%28http_requests%5B5m%5D%29"
        );
    }
}
