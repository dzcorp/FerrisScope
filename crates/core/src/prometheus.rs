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

/// List Services that look like a Prometheus instance. Two-pass:
///
/// 1. **Label selectors** (cheap, high-signal). Concurrent cluster-wide
///    LISTs — one per entry in [`DISCOVERY_SELECTORS`] — unioned + deduped
///    by `(namespace, name)`. This catches the vast majority of installs
///    where the chart sets `app.kubernetes.io/name=prometheus` (or
///    equivalent) on the queryable Service.
///
/// 2. **Name fallback** (only paid when pass 1 returned nothing). One
///    cluster-wide LIST without a label filter, client-side filtered to
///    Services whose name contains a known backend keyword AND that are
///    not on the [`NAME_FALLBACK_BLOCKLIST`] AND that expose at least
///    one Prom-shaped port. Catches charts that set non-canonical label
///    values (e.g. `app.kubernetes.io/name=kube-prometheus-stack-prometheus`)
///    or omit the standard label entirely. Capped at
///    [`NAME_FALLBACK_MAX_CANDIDATES`] to bound worst-case probe budget.
///
/// Empty list = none found, *not* an error — the UI shows that as
/// "no Prometheus detected, configure manually". The validate probe is
/// always the source of truth; this function just supplies candidates.
pub async fn discover(client: Client) -> Result<Vec<PromTarget>, PromError> {
    let api: Api<Service> = Api::all(client);
    // Run all selectors concurrently — each is an independent cluster-wide
    // Service LIST and there's no reason to serialize them.
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
            push_label_candidate(&mut out, &mut seen, svc);
        }
    }

    // Pass 2 — name-based fallback. Only paid when label discovery turned
    // up nothing, so the happy path stays a single round-trip per
    // selector and the fallback's broader LIST is amortised against the
    // case it actually helps.
    if out.is_empty() {
        match api.list(&ListParams::default()).await {
            Ok(list) => {
                tracing::debug!(
                    total = list.items.len(),
                    "prometheus label discovery empty; running name fallback"
                );
                let mut added = 0usize;
                for svc in list.items {
                    if added >= NAME_FALLBACK_MAX_CANDIDATES {
                        tracing::debug!(
                            cap = NAME_FALLBACK_MAX_CANDIDATES,
                            "prometheus name fallback hit candidate cap; truncating"
                        );
                        break;
                    }
                    if push_name_fallback_candidate(&mut out, &mut seen, svc) {
                        added += 1;
                    }
                }
            }
            Err(e) => {
                tracing::debug!(error = %e, "prometheus name fallback list failed");
            }
        }
    }

    // Sort for stable UI ordering.
    out.sort_by(|a, b| {
        (a.namespace.as_str(), a.service.as_str()).cmp(&(b.namespace.as_str(), b.service.as_str()))
    });
    Ok(out)
}

/// Push a Service that came back from a label-selected LIST. The selector
/// already proved monitoring-adjacent intent, so we accept anything —
/// classify is allowed to return `Unknown` (still dispatchable via the
/// proxy + probe path).
fn push_label_candidate(
    out: &mut Vec<PromTarget>,
    seen: &mut std::collections::HashSet<(String, String)>,
    svc: Service,
) {
    let Some(ns) = svc.metadata.namespace.clone() else {
        return;
    };
    let Some(name) = svc.metadata.name.clone() else {
        return;
    };
    if !seen.insert((ns.clone(), name.clone())) {
        return;
    }
    let backend = classify(svc.metadata.labels.as_ref());
    let (port, scheme) =
        pick_port(&svc, backend).unwrap_or_else(|| (default_port(backend), "http".to_owned()));
    out.push(PromTarget {
        namespace: ns,
        service: name,
        port,
        scheme,
        backend,
    });
}

/// Push a Service from the unfiltered fallback LIST. Returns `true` if a
/// candidate was actually pushed, so the caller can apply the cap. We
/// require:
///
/// * Service name contains a known backend keyword (`classify_keyword`).
/// * Service name does not contain anything on [`NAME_FALLBACK_BLOCKLIST`].
/// * Service exposes at least one Prom-shaped port.
///
/// Anything that clears all three is handed to the same `validate()` probe
/// as label-discovered candidates — false positives die there at most one
/// 5s timeout each, bounded by [`NAME_FALLBACK_MAX_CANDIDATES`].
fn push_name_fallback_candidate(
    out: &mut Vec<PromTarget>,
    seen: &mut std::collections::HashSet<(String, String)>,
    svc: Service,
) -> bool {
    let Some(ns) = svc.metadata.namespace.clone() else {
        return false;
    };
    let Some(name) = svc.metadata.name.clone() else {
        return false;
    };
    if name_is_blocklisted(&name) {
        return false;
    }
    let Some(backend) = classify_keyword(&name) else {
        return false;
    };
    if !has_prom_shaped_port(&svc) {
        return false;
    }
    if !seen.insert((ns.clone(), name.clone())) {
        return false;
    }
    let (port, scheme) =
        pick_port(&svc, backend).unwrap_or_else(|| (default_port(backend), "http".to_owned()));
    out.push(PromTarget {
        namespace: ns,
        service: name,
        port,
        scheme,
        backend,
    });
    true
}

/// Map a candidate string (a label value or a Service name) to a likely
/// backend by substring. `None` = nothing recognised — the caller decides
/// whether that means "skip" (name-based fallback pass) or "keep as
/// Unknown" (label-based pass, where the selector already proved
/// monitoring-adjacent intent).
fn classify_keyword(s: &str) -> Option<PromBackend> {
    let n = s.to_ascii_lowercase();
    // Order: most specific first. `prometheus` is last because compound
    // names like `victoria-metrics` etc. don't contain it but several
    // VM/Thanos/Mimir Service names do contain `prom-…` prefixes from
    // umbrella charts.
    if n.contains("victoria") || n.contains("vmsingle") || n.contains("vmselect") {
        Some(PromBackend::VictoriaMetrics)
    } else if n.contains("thanos") {
        Some(PromBackend::Thanos)
    } else if n.contains("mimir") {
        Some(PromBackend::Mimir)
    } else if n.contains("cortex") {
        Some(PromBackend::Cortex)
    } else if n.contains("m3coordinator") || n.contains("m3query") {
        Some(PromBackend::M3)
    } else if n.contains("promscale") {
        Some(PromBackend::Promscale)
    } else if n.contains("prometheus") {
        Some(PromBackend::Prometheus)
    } else {
        None
    }
}

/// Map Service labels → likely backend. Uses `app.kubernetes.io/name` if
/// present (modern convention) and falls back to `app` (older charts).
/// `Unknown` covers a Service that matched a selector but whose label
/// value doesn't look like any of the known backends — still dispatchable
/// through the same probe + query path.
fn classify(labels: Option<&std::collections::BTreeMap<String, String>>) -> PromBackend {
    let n = labels
        .and_then(|m| {
            m.get("app.kubernetes.io/name")
                .or_else(|| m.get("app"))
                .map(String::as_str)
        })
        .unwrap_or("");
    classify_keyword(n).unwrap_or(PromBackend::Unknown)
}

/// Service-name substrings that are common Prometheus *neighbors* but do
/// NOT serve `/api/v1/query`. Without this guard, the name-based fallback
/// pass would candidate every cluster's `prometheus-node-exporter`, the
/// headless `prometheus-operated`, alertmanager, pushgateway, etc., and
/// burn 5s on each one in `validate()`. Match is substring on the
/// lowercased Service name.
const NAME_FALLBACK_BLOCKLIST: &[&str] = &[
    "exporter",   // prometheus-node-exporter, blackbox-exporter, ...
    "kube-state", // kube-state-metrics
    "operator",   // prometheus-operator (controller, no PromQL)
    "operated",   // prometheus-operated (headless, used by the operator)
    "alertmanager",
    "pushgateway",
    "adapter", // prometheus-adapter (custom-metrics, different API)
    "blackbox",
    "snmp",
    "config-reloader",
    "vmagent", // VM write path; no PromQL endpoint
    "vminsert",
    "vmstorage",
    "thanos-receive",
    "thanos-store",
    "thanos-compact",
    "thanos-ruler",
    "thanos-sidecar", // exposes PromQL only on a different proxy path
];

/// Per-fallback cap on the number of name-matched candidates we hand to
/// the validate loop. Defends against pathologically-shaped clusters
/// (dozens of Helm releases all using "prometheus" in the Service name)
/// where every probe is a 5s timeout. In normal clusters the real
/// candidate count after blocklist is 1–3.
const NAME_FALLBACK_MAX_CANDIDATES: usize = 10;

/// Does the Service expose a port that *could* be a Prom HTTP endpoint?
/// Used as a second gate in the name-based fallback to avoid probing
/// random services whose only ports are e.g. gRPC, AMQP, JDBC. The
/// known-port list intentionally errs on the side of inclusive — the
/// `validate()` probe is the source of truth, this just trims obvious
/// non-candidates before we spend round-trip budget.
fn has_prom_shaped_port(svc: &Service) -> bool {
    const KNOWN_PORTS: &[i32] = &[
        9090,  // prometheus
        9091,  // pushgateway (caught by name blocklist; listed defensively)
        9095,  // prometheus HTTPS (legacy)
        8428,  // vmsingle
        8481,  // vmselect HTTPS
        10902, // thanos http
        9201,  // promscale
        7201,  // m3coordinator
        8080,  // mimir / cortex (very common; only admitted with name match)
    ];
    const KNOWN_NAMES: &[&str] = &[
        "http",
        "https",
        "web",
        "http-web",
        "https-web",
        "api",
        "http-api",
        "query",
        "http-metrics",
        "vmsingle",
        "vmselect",
        "thanos-http",
        "coordinator-http",
    ];
    let Some(ports) = svc.spec.as_ref().and_then(|s| s.ports.as_ref()) else {
        return false;
    };
    ports.iter().any(|p| {
        KNOWN_PORTS.contains(&p.port)
            || matches!(p.name.as_deref(), Some(n) if KNOWN_NAMES.contains(&n))
    })
}

fn name_is_blocklisted(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    NAME_FALLBACK_BLOCKLIST.iter().any(|kw| n.contains(kw))
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
    fn classify_keyword_recognises_compound_helm_names() {
        // The whole point of the name-based fallback: catch Service names
        // where the chart prefixed/suffixed the keyword with its release
        // name. Each of these would slip through the label `in (...)`
        // selectors if the chart also set a non-canonical label value.
        let cases: &[(&str, PromBackend)] = &[
            ("prometheus", PromBackend::Prometheus),
            ("prometheus-prometheus", PromBackend::Prometheus),
            ("prometheus-server", PromBackend::Prometheus),
            ("kube-prometheus-stack-prometheus", PromBackend::Prometheus),
            ("monitoring-prometheus", PromBackend::Prometheus),
            ("vmsingle-cluster", PromBackend::VictoriaMetrics),
            ("victoria-metrics-single", PromBackend::VictoriaMetrics),
            ("thanos-query-frontend", PromBackend::Thanos),
            ("mimir-query-frontend", PromBackend::Mimir),
            ("cortex-query-frontend", PromBackend::Cortex),
            ("m3coordinator-headless", PromBackend::M3),
            ("m3query-frontend", PromBackend::M3),
            ("promscale-connector", PromBackend::Promscale),
        ];
        for (name, want) in cases {
            assert_eq!(
                classify_keyword(name),
                Some(*want),
                "name {name:?} should classify as {want:?}"
            );
        }
        // And a few that shouldn't classify at all — they need the label
        // pass to bring them in (or stay out).
        for unrelated in &["nginx", "kafka", "grafana", "redis"] {
            assert_eq!(
                classify_keyword(unrelated),
                None,
                "{unrelated} unexpected hit"
            );
        }
    }

    #[test]
    fn name_blocklist_rejects_prometheus_neighbors() {
        // Catch the canonical false positives that share the
        // "prometheus-…" naming convention but don't serve PromQL.
        // Any failure here means the fallback would burn validate-probe
        // budget on something that's never going to answer.
        let blocked = &[
            "prometheus-node-exporter",
            "node-exporter",
            "kube-state-metrics",
            "prometheus-operator",
            "prometheus-operated",
            "alertmanager-main",
            "kube-prometheus-stack-alertmanager",
            "prometheus-pushgateway",
            "prometheus-adapter",
            "blackbox-exporter",
            "snmp-exporter",
            "vmagent",
            "vminsert",
            "thanos-store",
            "thanos-receive",
            "thanos-compact",
            "thanos-ruler",
            "thanos-sidecar",
        ];
        for name in blocked {
            assert!(name_is_blocklisted(name), "{name} should be blocklisted");
        }
        let allowed = &[
            "prometheus",
            "prometheus-prometheus",
            "kube-prometheus-stack-prometheus",
            "vmsingle-cluster",
            "thanos-query",
            "thanos-query-frontend",
            "mimir-query-frontend",
        ];
        for name in allowed {
            assert!(
                !name_is_blocklisted(name),
                "{name} should NOT be blocklisted"
            );
        }
    }

    #[test]
    fn has_prom_shaped_port_accepts_known_ports_and_names() {
        // Numbered ports we recognise.
        assert!(has_prom_shaped_port(&svc_with_ports(&[("metrics", 9090)])));
        assert!(has_prom_shaped_port(&svc_with_ports(&[("metrics", 8428)])));
        assert!(has_prom_shaped_port(&svc_with_ports(&[("metrics", 10902)])));
        // Named ports we recognise (number unrelated).
        assert!(has_prom_shaped_port(&svc_with_ports(&[("http", 12345)])));
        assert!(has_prom_shaped_port(&svc_with_ports(&[("web", 9090)])));
        assert!(has_prom_shaped_port(&svc_with_ports(&[(
            "http-metrics",
            9095
        )])));
        // Service whose only port is gRPC / proprietary should be rejected.
        assert!(!has_prom_shaped_port(&svc_with_ports(&[("grpc", 9092)])));
        assert!(!has_prom_shaped_port(&svc_with_ports(&[("amqp", 5672)])));
    }

    #[test]
    fn fallback_push_accepts_misnamed_helm_release() {
        // Real-world shape: chart named the queryable Service
        // `prometheus-prometheus` and forgot the canonical
        // `app.kubernetes.io/name=prometheus` label, so the label pass
        // missed it. Fallback should pick it up.
        let mut svc = svc_with_ports(&[("web", 9090)]);
        svc.metadata.namespace = Some("monitoring".into());
        svc.metadata.name = Some("prometheus-prometheus".into());

        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let pushed = push_name_fallback_candidate(&mut out, &mut seen, svc);
        assert!(pushed);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].service, "prometheus-prometheus");
        assert_eq!(out[0].namespace, "monitoring");
        assert_eq!(out[0].backend, PromBackend::Prometheus);
        assert_eq!(out[0].port, 9090);
    }

    #[test]
    fn fallback_push_rejects_blocklisted_and_non_matching() {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();

        // Headless prometheus-operated: name matches "prometheus" but
        // is on the blocklist (it doesn't serve PromQL).
        let mut svc = svc_with_ports(&[("web", 9090)]);
        svc.metadata.namespace = Some("monitoring".into());
        svc.metadata.name = Some("prometheus-operated".into());
        assert!(!push_name_fallback_candidate(&mut out, &mut seen, svc));

        // Node-exporter: classic false positive.
        let mut svc = svc_with_ports(&[("metrics", 9100)]);
        svc.metadata.namespace = Some("monitoring".into());
        svc.metadata.name = Some("prometheus-node-exporter".into());
        assert!(!push_name_fallback_candidate(&mut out, &mut seen, svc));

        // Random unrelated service.
        let mut svc = svc_with_ports(&[("http", 80)]);
        svc.metadata.namespace = Some("default".into());
        svc.metadata.name = Some("nginx".into());
        assert!(!push_name_fallback_candidate(&mut out, &mut seen, svc));

        // Prometheus-named service but without any HTTP-ish port.
        let mut svc = svc_with_ports(&[("grpc", 9092)]);
        svc.metadata.namespace = Some("monitoring".into());
        svc.metadata.name = Some("prometheus-grpc-only".into());
        assert!(!push_name_fallback_candidate(&mut out, &mut seen, svc));

        assert!(out.is_empty());
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
