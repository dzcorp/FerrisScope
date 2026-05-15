//! One-shot resource fetch via the dynamic API.
//!
//! Used by the YAML detail panel: given a kind id from the registry plus
//! optional namespace + name, return the live object as YAML. Uses
//! `kube::api::DynamicObject` so the same code path serves typed kinds and
//! (later) CRDs without per-kind plumbing.

use std::collections::HashMap;

use k8s_openapi::api::admissionregistration::v1::{
    MutatingWebhookConfiguration, ValidatingWebhookConfiguration,
};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::coordination::v1::Lease;
use k8s_openapi::api::core::v1::{
    ConfigMap, Endpoints, Event, LimitRange, Namespace, Node, PersistentVolume,
    PersistentVolumeClaim, Pod, ReplicationController, ResourceQuota, Secret, Service,
    ServiceAccount,
};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::scheduling::v1::PriorityClass;
use k8s_openapi::api::storage::v1::StorageClass;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use k8s_openapi::jiff;
use kube::{
    api::{
        Api, ApiResource, DeleteParams, DynamicObject, EvictParams, GroupVersionKind, ListParams,
        Patch, PatchParams,
    },
    discovery, Client,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    kinds::{
        cluster_role_bindings, cluster_roles, config_maps, cron_jobs, custom_resource_definitions,
        daemon_sets, deployments, endpoint_slices, endpoints, events, helm_releases,
        horizontal_pod_autoscalers, ingress_classes, ingresses, jobs, leases, limit_ranges,
        mutating_webhook_configurations, namespaces, network_policies, nodes,
        persistent_volume_claims, persistent_volumes, pod_disruption_budgets, pods,
        priority_classes, replica_sets, replication_controllers, resource_quotas, role_bindings,
        roles, secrets, service_accounts, services, stateful_sets, storage_classes,
        validating_webhook_configurations,
    },
    registry,
};

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("unknown kind: {0}")]
    UnknownKind(String),
    #[error("namespace required for namespaced kind {0}")]
    NamespaceRequired(String),
    #[error("kube error: {0}")]
    Kube(#[from] kube::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("{0} has no controller — use Delete to remove it")]
    NoController(String),
    #[error("{0} doesn't support rollout restart — use Delete to recreate")]
    UnsupportedRestart(String),
    #[error("{0}")]
    Conflict(String),
}

pub async fn get_resource_yaml(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<String, FetchError> {
    let entry =
        registry::lookup(kind_id).ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
    let meta = &entry.meta;

    let gvk = GroupVersionKind::gvk(meta.group, meta.version, meta.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, meta.plural);

    let api: Api<DynamicObject> = if meta.namespaced {
        let ns = namespace.ok_or_else(|| FetchError::NamespaceRequired(kind_id.to_owned()))?;
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let obj = api.get(name).await?;
    let yaml = serde_yaml::to_string(&obj)?;
    Ok(yaml)
}

/// One-shot typed fetch + projection for the pod detail panel. Returns the
/// rich label/value shape the UI's `PodSummary` consumes — keeps Pod-shape
/// knowledge in Rust so the renderer doesn't have to parse YAML.
pub async fn get_pod_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let pod = api.get(name).await?;
    Ok(pods::project_detail(&pod))
}

pub async fn get_deployment_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Deployment> = Api::namespaced(client, namespace);
    Ok(deployments::project_detail(&api.get(name).await?))
}

pub async fn get_replica_set_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ReplicaSet> = Api::namespaced(client, namespace);
    Ok(replica_sets::project_detail(&api.get(name).await?))
}

pub async fn get_stateful_set_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<StatefulSet> = Api::namespaced(client, namespace);
    Ok(stateful_sets::project_detail(&api.get(name).await?))
}

pub async fn get_daemon_set_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<DaemonSet> = Api::namespaced(client, namespace);
    Ok(daemon_sets::project_detail(&api.get(name).await?))
}

pub async fn get_job_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Job> = Api::namespaced(client, namespace);
    Ok(jobs::project_detail(&api.get(name).await?))
}

pub async fn get_cron_job_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<CronJob> = Api::namespaced(client, namespace);
    Ok(cron_jobs::project_detail(&api.get(name).await?))
}

pub async fn get_node_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<Node> = Api::all(client);
    Ok(nodes::project_detail(&api.get(name).await?))
}

pub async fn get_namespace_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<Namespace> = Api::all(client);
    Ok(namespaces::project_detail(&api.get(name).await?))
}

pub async fn get_event_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Event> = Api::namespaced(client, namespace);
    Ok(events::project_detail(&api.get(name).await?))
}

pub async fn get_service_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Service> = Api::namespaced(client, namespace);
    Ok(services::project_detail(&api.get(name).await?))
}

pub async fn get_endpoints_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Endpoints> = Api::namespaced(client, namespace);
    Ok(endpoints::project_detail(&api.get(name).await?))
}

pub async fn get_endpoint_slice_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<EndpointSlice> = Api::namespaced(client, namespace);
    Ok(endpoint_slices::project_detail(&api.get(name).await?))
}

pub async fn get_ingress_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Ingress> = Api::namespaced(client, namespace);
    Ok(ingresses::project_detail(&api.get(name).await?))
}

pub async fn get_ingress_class_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<IngressClass> = Api::all(client);
    Ok(ingress_classes::project_detail(&api.get(name).await?))
}

pub async fn get_network_policy_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<NetworkPolicy> = Api::namespaced(client, namespace);
    Ok(network_policies::project_detail(&api.get(name).await?))
}

pub async fn get_config_map_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ConfigMap> = Api::namespaced(client, namespace);
    Ok(config_maps::project_detail(&api.get(name).await?))
}

pub async fn get_secret_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    Ok(secrets::project_detail(&api.get(name).await?))
}

/// Light projection of every ConfigMap in a namespace — name + key list per
/// entry. Used by the env-ref picker; we don't ship the values (cheaper, and
/// the picker doesn't need them). Sorted by name for stable UI.
pub async fn list_config_maps_in_namespace(
    client: Client,
    namespace: &str,
) -> Result<Value, FetchError> {
    let api: Api<ConfigMap> = Api::namespaced(client, namespace);
    let lp = ListParams::default();
    let list = api.list(&lp).await?;
    let mut out: Vec<Value> = list
        .items
        .into_iter()
        .map(|cm| {
            let name = cm.metadata.name.unwrap_or_default();
            let mut keys: Vec<String> = cm
                .data
                .as_ref()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            if let Some(b) = cm.binary_data.as_ref() {
                keys.extend(b.keys().cloned());
            }
            keys.sort();
            keys.dedup();
            json!({ "name": name, "keys": keys })
        })
        .collect();
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(Value::Array(out))
}

/// Light projection of every PersistentVolumeClaim in a namespace, used
/// by the volume picker. Carries `storage_class` + `requested_storage` so
/// the operator can disambiguate at a glance — claim names alone aren't
/// enough on clusters with many similarly-named PVCs.
pub async fn list_persistent_volume_claims_in_namespace(
    client: Client,
    namespace: &str,
) -> Result<Value, FetchError> {
    let api: Api<PersistentVolumeClaim> = Api::namespaced(client, namespace);
    let lp = ListParams::default();
    let list = api.list(&lp).await?;
    let mut out: Vec<Value> = list
        .items
        .into_iter()
        .map(|p| {
            let name = p.metadata.name.unwrap_or_default();
            let storage_class = p.spec.as_ref().and_then(|s| s.storage_class_name.clone());
            let requested_storage = p
                .spec
                .as_ref()
                .and_then(|s| s.resources.as_ref())
                .and_then(|r| r.requests.as_ref())
                .and_then(|m| m.get("storage"))
                .map(|q| q.0.clone());
            json!({
                "name": name,
                "storage_class": storage_class,
                "requested_storage": requested_storage,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(Value::Array(out))
}

/// Same as `list_config_maps_in_namespace`, against Secrets. Keys come from
/// `data` (base64) — `string_data` is write-only and never returned by GET.
pub async fn list_secrets_in_namespace(
    client: Client,
    namespace: &str,
) -> Result<Value, FetchError> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let lp = ListParams::default();
    let list = api.list(&lp).await?;
    let mut out: Vec<Value> = list
        .items
        .into_iter()
        .map(|s| {
            let name = s.metadata.name.unwrap_or_default();
            let mut keys: Vec<String> = s
                .data
                .as_ref()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            keys.sort();
            json!({
                "name": name,
                "keys": keys,
                "type": s.type_.unwrap_or_default(),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(Value::Array(out))
}

/// Helm release detail: list every revision secret for this release in the
/// namespace, decode each, and return the latest revision's projection
/// alongside a sorted history. We use the `owner=helm,name=<release>` label
/// selector that Helm itself sets on release secrets — the apiserver does
/// the filtering server-side, so this stays cheap on big clusters.
///
/// The projection includes `helm_available` so the frontend can disable
/// the upgrade-edit affordance when the host has no `helm` CLI installed.
/// [`helm_available`] re-probes `$PATH` on every call so the managed-helm
/// installer can flip the result mid-session without restarting the app.
pub async fn get_helm_release_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let list = api.list(&lp).await?;
    let mut releases: Vec<helm_releases::Release> = list
        .items
        .iter()
        .filter_map(|sec| helm_releases::decode_release(sec).ok())
        .collect();
    if releases.is_empty() {
        return Err(FetchError::UnknownKind(format!(
            "helm release {namespace}/{name}"
        )));
    }
    releases.sort_by(|a, b| b.version.cmp(&a.version));
    let latest = releases[0].clone();

    // Look up "update available" against the operator's local helm repo
    // cache. helm_search_repo is best-effort — empty list when helm
    // isn't installed or no repos are configured, in which case we just
    // omit the indicator. We don't run `helm repo update` here (slow,
    // network); the operator triggers that explicitly via the "Update
    // repos" button.
    let chart_name = latest.chart_meta_str("name");
    let chart_version = latest.chart_meta_str("version");
    let update_available = match (chart_name.as_deref(), chart_version.as_deref()) {
        (Some(name), Some(ver)) => {
            let repos = helm_search_repo().await;
            find_update_for_chart(name, ver, &repos)
        }
        _ => None,
    };

    let mut value = helm_releases::project_detail(&latest, &releases, helm_available());
    if let serde_json::Value::Object(ref mut map) = value {
        map.insert(
            "update_available".to_owned(),
            match update_available {
                Some(u) => serde_json::to_value(u).unwrap_or(Value::Null),
                None => Value::Null,
            },
        );
    }
    Ok(value)
}

/// `which helm` against the process `$PATH`. Re-probes on every call: the
/// in-app managed-helm installer (`crates/app/src/helm_install.rs`) can
/// install helm mid-session, and we want the helm-aware UI affordances to
/// pick that up immediately. The cost is one filesystem stat per PATH entry,
/// which is negligible compared to the network calls in
/// `get_helm_release_detail`.
pub fn helm_available() -> bool {
    which::which("helm").is_ok()
}

/// Captured stderr + timing from a failed `helm dependency update` —
/// shaped to map directly into `HelmUpgradeResult::Failed` /
/// `HelmInstallResult::Failed` so the caller can surface the message in
/// the same UI banner as a failed upgrade.
#[derive(Debug)]
pub struct HelmDepUpdateFailure {
    pub message: String,
    pub helm_stderr: String,
    pub elapsed_ms: u64,
}

/// Run `helm dependency update <chart_dir>` to fetch declared subcharts
/// into `<chart_dir>/charts/`. Helm release secrets serialize only the
/// parent chart — `dependencies []*Chart` is unexported on
/// `chart.Chart` (verified against helm v3.18 / v4.1) — so any chart
/// whose `Chart.yaml` has a `dependencies:` block needs this pass before
/// `helm upgrade <release> <chart_dir>` will accept it. Without it the
/// CLI rejects with "missing in charts/ directory".
///
/// `--dependency-update` on `helm upgrade` is *not* a substitute: it
/// fails to initialize the OCI registry client and errors with "missing
/// registry client" for OCI-hosted deps (e.g. Bitnami's
/// `oci://registry-1.docker.io/bitnamicharts/common`).
pub async fn helm_dependency_update(
    chart_dir: &std::path::Path,
) -> Result<(), HelmDepUpdateFailure> {
    use std::process::Stdio;
    let chart_dir = chart_dir.to_path_buf();
    let started = std::time::Instant::now();
    let output = match tokio::task::spawn_blocking(move || {
        std::process::Command::new("helm")
            .arg("dependency")
            .arg("update")
            .arg(&chart_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    })
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(HelmDepUpdateFailure {
                message: format!("spawn helm dependency update: {e}"),
                helm_stderr: String::new(),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
        Err(e) => {
            return Err(HelmDepUpdateFailure {
                message: format!("join helm dependency update: {e}"),
                helm_stderr: String::new(),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if output.status.success() {
        return Ok(());
    }
    Err(HelmDepUpdateFailure {
        message: format!(
            "helm dependency update exited with status {}",
            output.status
        ),
        helm_stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        elapsed_ms,
    })
}

/// Convention used in the chart catalog `source` axis. In-cluster charts
/// (those derived from existing helm release secrets) carry this constant;
/// repo charts carry the repo name itself (e.g. `bitnami`).
pub const HELM_CLUSTER_SOURCE: &str = "cluster";

/// One entry returned by `helm search repo -o json`. Helm names entries
/// in `<repo>/<chart>` form when the operator has multiple repos
/// configured; we pull the repo prefix off and surface it separately so
/// the frontend can render it as its own column.
#[derive(Debug, Clone)]
pub struct HelmRepoChart {
    pub repo: String,
    pub name: String,
    pub version: String,
    pub app_version: Option<String>,
    pub description: Option<String>,
}

/// Run `helm search repo -o json` and parse the result. Best-effort: if
/// helm isn't on PATH or the operator has no repos configured, we return
/// an empty list rather than surfacing a hard error — the catalog merely
/// won't include any repo charts.
///
/// We **don't** pass `--versions`. That flag returns every version of
/// every chart (often hundreds for popular charts) and would overwhelm
/// the catalog. Latest only is what `helm search repo` shows by default
/// and matches what an operator running the CLI sees.
pub async fn helm_search_repo() -> Vec<HelmRepoChart> {
    if !helm_available() {
        return Vec::new();
    }
    let output = match tokio::task::spawn_blocking(|| {
        std::process::Command::new("helm")
            .arg("search")
            .arg("repo")
            .arg("--output")
            .arg("json")
            .output()
    })
    .await
    {
        Ok(Ok(o)) => o,
        _ => return Vec::new(),
    };
    if !output.status.success() {
        // Common when no repos configured: helm exits with status 1 and
        // "Error: no repositories configured" on stderr. That's not a
        // failure of our app — just an empty catalog source.
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Vec<Value> = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    raw.into_iter()
        .filter_map(|entry| {
            // helm's `name` is `<repo>/<chart>`; split on the first '/'.
            let qualified = entry.get("name")?.as_str()?.to_owned();
            let slash = qualified.find('/')?;
            let repo = qualified[..slash].to_owned();
            let name = qualified[slash + 1..].to_owned();
            if repo.is_empty() || name.is_empty() {
                return None;
            }
            let version = entry.get("version")?.as_str()?.to_owned();
            let app_version = entry
                .get("app_version")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let description = entry
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            Some(HelmRepoChart {
                repo,
                name,
                version,
                app_version,
                description,
            })
        })
        .collect()
}

/// Run `helm show values <chart-ref> --version <version>` and return the
/// raw YAML text. Used when the operator opens a repo-chart's detail
/// panel: we don't have the chart files locally (no release secret to
/// extract from), so we ask helm directly. Returns empty string on
/// failure rather than erroring — operators can still install the chart
/// with no overrides.
pub async fn helm_show_values(chart_ref: &str, version: &str) -> String {
    if !helm_available() {
        return String::new();
    }
    let chart_ref = chart_ref.to_owned();
    let version = version.to_owned();
    let output = match tokio::task::spawn_blocking(move || {
        std::process::Command::new("helm")
            .arg("show")
            .arg("values")
            .arg(&chart_ref)
            .arg("--version")
            .arg(&version)
            .output()
    })
    .await
    {
        Ok(Ok(o)) => o,
        _ => return String::new(),
    };
    if !output.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Outcome of a successful `helm upgrade`. `revision` is the new revision
/// the apiserver assigned (one above the previous latest).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelmUpgradeResult {
    Upgraded {
        revision: i64,
        status: Option<String>,
        elapsed_ms: u64,
        helm_stdout: String,
    },
    Failed {
        message: String,
        helm_stderr: String,
        elapsed_ms: u64,
    },
    HelmMissing,
}

/// Run `helm upgrade <release> <chart-dir> -n <ns> --kube-context <ctx>
/// [--kubeconfig <path>] -f <values.yaml>`. The chart is materialised
/// from the existing release secret (so we don't need a repo) and
/// `values_yaml` is the operator's edited User values text. Returns
/// either a typed result or an error if we couldn't even reach the
/// shell-out stage.
///
/// Why `helm` (the CLI) and not a Rust reimplementation: Helm's template
/// engine, hook lifecycle, and storage driver are large — getting any of
/// them wrong means the upgrade succeeds in our app but produces a
/// drifted state in the cluster. The CLI is the source of truth for both
/// our app and `kubectl`-using operators.
pub async fn helm_upgrade(
    client: Client,
    context_name: &str,
    kubeconfig_path: Option<&std::path::Path>,
    namespace: &str,
    name: &str,
    values_yaml: &str,
    // Optional repo override. `None` keeps the existing chart unchanged
    // (extract from the latest release secret + apply new values).
    // `Some((source, version))` swaps in a different chart from a helm
    // repo — `helm upgrade <release> <source>/<chart-name> --version <v>`
    // — same as the chart-install path but for an existing release.
    chart_override: Option<(&str, &str)>,
) -> Result<HelmUpgradeResult, FetchError> {
    use std::process::Stdio;

    if !helm_available() {
        return Ok(HelmUpgradeResult::HelmMissing);
    }

    // Pull the latest revision so we can extract its chart (when no
    // override) or learn the chart name (when overriding to a repo
    // version). We avoid `client.clone()` past this point — helm CLI
    // talks to the apiserver itself via the kubeconfig.
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let list = api.list(&lp).await?;
    let mut releases: Vec<helm_releases::Release> = list
        .items
        .iter()
        .filter_map(|sec| helm_releases::decode_release(sec).ok())
        .collect();
    if releases.is_empty() {
        return Err(FetchError::UnknownKind(format!(
            "helm release {namespace}/{name}"
        )));
    }
    releases.sort_by(|a, b| b.version.cmp(&a.version));
    let latest = releases[0].clone();

    // Stage chart + values file in a temp dir. Drops at function exit;
    // helm has long since finished by then.
    let tmp = tempfile::Builder::new()
        .prefix("ferrisscope-helm-")
        .tempdir()
        .map_err(|e| FetchError::Conflict(format!("tempdir: {e}")))?;
    let values_path = tmp.path().join("values.yaml");
    std::fs::write(&values_path, values_yaml)
        .map_err(|e| FetchError::Conflict(format!("write values: {e}")))?;

    // Resolve which chart to upgrade to. Default = the chart files
    // already embedded in the release secret (preserve current chart,
    // change values). With an override = `<repo>/<chart-name>` — helm
    // pulls the new version from its repo cache.
    let chart_arg: std::ffi::OsString;
    let mut version_arg: Option<String> = None;
    if let Some((src, ver)) = chart_override {
        let chart_name = latest
            .chart_meta_str("name")
            .ok_or_else(|| FetchError::Conflict("release has no chart name".to_owned()))?;
        chart_arg = format!("{src}/{chart_name}").into();
        version_arg = Some(ver.to_owned());
    } else {
        let chart_dir = tmp.path().join("chart");
        helm_releases::extract_chart_to_dir(&latest, &chart_dir)
            .map_err(|e| FetchError::Conflict(format!("chart extract: {e}")))?;
        // Subcharts aren't bundled in the release secret — fetch them
        // from their declared repos before invoking `helm upgrade`.
        if helm_releases::chart_has_dependencies(&latest) {
            if let Err(fail) = helm_dependency_update(&chart_dir).await {
                return Ok(HelmUpgradeResult::Failed {
                    message: fail.message,
                    helm_stderr: fail.helm_stderr,
                    elapsed_ms: fail.elapsed_ms,
                });
            }
        }
        chart_arg = chart_dir.into_os_string();
    }

    let mut cmd = std::process::Command::new("helm");
    cmd.arg("upgrade")
        .arg(name)
        .arg(&chart_arg)
        .arg("--namespace")
        .arg(namespace)
        .arg("--kube-context")
        .arg(context_name)
        .arg("-f")
        .arg(&values_path)
        // No --reset-values: passing -f *replaces* user values for this
        // upgrade, which is what the operator just typed. Using
        // --reuse-values would re-merge the prior config and the edits
        // wouldn't fully apply.
        .arg("--output")
        .arg("json")
        // Operator-friendly safety net. Without --wait, helm returns as
        // soon as it's submitted the manifests; the operator immediately
        // sees stale data in the panel. With --wait we'd block too long
        // on slow rollouts, so leave it off and rely on the watcher's
        // delta to refresh the row.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(v) = &version_arg {
        cmd.arg("--version").arg(v);
    }
    if let Some(p) = kubeconfig_path {
        cmd.arg("--kubeconfig").arg(p);
    }

    let started = std::time::Instant::now();
    // `Command::output` is sync; spawn on the blocking pool so we don't
    // stall the Tokio runtime — helm install/upgrade can take many
    // seconds on slow charts.
    let output = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| FetchError::Conflict(format!("join: {e}")))?
        .map_err(|e| FetchError::Conflict(format!("spawn helm: {e}")))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Ok(HelmUpgradeResult::Failed {
            message: format!("helm exited with status {}", output.status),
            helm_stderr: stderr,
            elapsed_ms,
        });
    }

    // Parse helm's JSON output — it includes the new revision (`version`)
    // and the resulting status. We're tolerant of shape drift; if helm
    // changed its output schema we still report success, just without
    // the structured revision number.
    let parsed: Option<Value> = serde_json::from_str(&stdout).ok();
    let revision = parsed
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_i64())
        .unwrap_or(latest.version + 1);
    let status = parsed
        .as_ref()
        .and_then(|v| v.get("info"))
        .and_then(|i| i.get("status"))
        .and_then(|s| s.as_str())
        .map(str::to_owned);

    Ok(HelmUpgradeResult::Upgraded {
        revision,
        status,
        elapsed_ms,
        helm_stdout: stdout,
    })
}

/// Detail projection for a single chart. `source` switches the data
/// source:
///
/// * [`HELM_CLUSTER_SOURCE`] (`"cluster"`) — walk the cluster's helm
///   release secrets, find any release using this `(name, version)`,
///   project chart metadata + default values from the embedded chart
///   and list every release using it.
/// * `<repo-name>` — fetch metadata + default values from helm directly
///   via `helm search repo` + `helm show values`. `used_by` stays empty
///   since the chart is repo-side, not yet deployed (operators see what
///   they'd be installing).
pub async fn get_helm_chart_detail(
    client: Client,
    source: &str,
    chart_name: &str,
    chart_version: &str,
) -> Result<Value, FetchError> {
    if source == HELM_CLUSTER_SOURCE {
        return get_helm_chart_detail_cluster(client, chart_name, chart_version).await;
    }
    get_helm_chart_detail_repo(source, chart_name, chart_version).await
}

async fn get_helm_chart_detail_cluster(
    client: Client,
    chart_name: &str,
    chart_version: &str,
) -> Result<Value, FetchError> {
    let releases = list_all_helm_releases(client).await?;
    let matches: Vec<&helm_releases::Release> = releases
        .iter()
        .filter(|r| {
            r.chart_meta_str("name").as_deref() == Some(chart_name)
                && r.chart_meta_str("version").as_deref() == Some(chart_version)
        })
        .collect();
    let sample = matches.first().copied().ok_or_else(|| {
        FetchError::UnknownKind(format!(
            "no release uses chart {chart_name}@{chart_version}"
        ))
    })?;

    // Default values: serialize chart.values back to YAML so the editor
    // shows operators the same form they'd paste into `helm install -f`.
    let default_values_yaml = sample
        .chart_default_values()
        .as_ref()
        .filter(|v| !v.is_null())
        .map(|v| serde_yaml::to_string(v).unwrap_or_default())
        .unwrap_or_default();

    let used_by: Vec<Value> = matches
        .iter()
        .map(|r| {
            json!({
                "namespace": r.namespace.clone().unwrap_or_default(),
                "name": r.name.clone(),
                "revision": r.version,
                "status": r.info.status.clone(),
                "updated": r.info.last_deployed.clone(),
            })
        })
        .collect();

    Ok(json!({
        "source": HELM_CLUSTER_SOURCE,
        "chart_name": chart_name,
        "chart_version": chart_version,
        "app_version": sample.chart_meta_str("appVersion"),
        "description": sample.chart_meta_str("description"),
        "home": sample.chart_meta_str("home"),
        "icon": sample.chart_meta_str("icon"),
        "sources": sample.chart_meta_array("sources"),
        "keywords": sample.chart_meta_array("keywords"),
        "default_values_yaml": default_values_yaml,
        "used_by": used_by,
        "helm_available": helm_available(),
    }))
}

async fn get_helm_chart_detail_repo(
    repo: &str,
    chart_name: &str,
    chart_version: &str,
) -> Result<Value, FetchError> {
    if !helm_available() {
        return Err(FetchError::Conflict(
            "helm CLI not found on PATH".to_owned(),
        ));
    }
    let chart_ref = format!("{repo}/{chart_name}");
    let default_values_yaml = helm_show_values(&chart_ref, chart_version).await;
    // Re-running helm_search_repo gives us the description + app_version
    // for this entry. We avoid `helm show chart` (would be a third
    // helm process per detail open). Cheap because helm caches its repo
    // index.
    let entries = helm_search_repo().await;
    let entry = entries
        .iter()
        .find(|e| e.repo == repo && e.name == chart_name && e.version == chart_version);
    let (app_version, description) = entry
        .map(|e| (e.app_version.clone(), e.description.clone()))
        .unwrap_or((None, None));

    Ok(json!({
        "source": repo,
        "chart_name": chart_name,
        "chart_version": chart_version,
        "app_version": app_version,
        "description": description,
        "home": Value::Null,
        "icon": Value::Null,
        "sources": Vec::<String>::new(),
        "keywords": Vec::<String>::new(),
        "default_values_yaml": default_values_yaml,
        "used_by": Vec::<Value>::new(),
        "helm_available": helm_available(),
    }))
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelmInstallResult {
    Installed {
        revision: i64,
        namespace: String,
        release_name: String,
        status: Option<String>,
        elapsed_ms: u64,
        helm_stdout: String,
    },
    Failed {
        message: String,
        helm_stderr: String,
        elapsed_ms: u64,
    },
    HelmMissing,
}

/// Install a new release. `source` switches the chart resolution path:
///
/// * [`HELM_CLUSTER_SOURCE`] — list every helm release secret in the
///   cluster, find one matching `(chart_name, chart_version)`, extract
///   its embedded chart to a temp dir, then `helm install <release>
///   <tempdir> ...`.
/// * `<repo-name>` — pass `<repo>/<chart>` directly to helm; the binary
///   pulls from its own cache (no extraction needed).
///
/// Both paths use `--create-namespace` so the operator doesn't get a
/// confusing failure on a fresh namespace name.
pub async fn helm_install_chart(
    client: Client,
    context_name: &str,
    kubeconfig_path: Option<&std::path::Path>,
    source: &str,
    target_namespace: &str,
    target_release: &str,
    chart_name: &str,
    chart_version: &str,
    values_yaml: &str,
) -> Result<HelmInstallResult, FetchError> {
    if !helm_available() {
        return Ok(HelmInstallResult::HelmMissing);
    }

    // Stage values.yaml in a temp dir for both paths. Repo-source
    // installs only need this; cluster-source also stages the chart
    // alongside.
    let tmp = tempfile::Builder::new()
        .prefix("ferrisscope-helm-")
        .tempdir()
        .map_err(|e| FetchError::Conflict(format!("tempdir: {e}")))?;
    let values_path = tmp.path().join("values.yaml");
    std::fs::write(&values_path, values_yaml)
        .map_err(|e| FetchError::Conflict(format!("write values: {e}")))?;

    // Resolve the chart-ref helm should install from. For cluster
    // source, that's a path to the extracted chart; for repo source
    // it's `<repo>/<chart>` and helm handles the rest.
    let chart_arg: std::ffi::OsString;
    let mut version_arg: Option<String> = None;
    if source == HELM_CLUSTER_SOURCE {
        let releases = list_all_helm_releases(client).await?;
        let sample = releases
            .into_iter()
            .find(|r| {
                r.chart_meta_str("name").as_deref() == Some(chart_name)
                    && r.chart_meta_str("version").as_deref() == Some(chart_version)
            })
            .ok_or_else(|| {
                FetchError::UnknownKind(format!(
                    "no release uses chart {chart_name}@{chart_version}"
                ))
            })?;
        let chart_dir = tmp.path().join("chart");
        helm_releases::extract_chart_to_dir(&sample, &chart_dir)
            .map_err(|e| FetchError::Conflict(format!("chart extract: {e}")))?;
        // Subcharts aren't bundled in the release secret — fetch them
        // from their declared repos before invoking `helm install`.
        if helm_releases::chart_has_dependencies(&sample) {
            if let Err(fail) = helm_dependency_update(&chart_dir).await {
                return Ok(HelmInstallResult::Failed {
                    message: fail.message,
                    helm_stderr: fail.helm_stderr,
                    elapsed_ms: fail.elapsed_ms,
                });
            }
        }
        chart_arg = chart_dir.into_os_string();
    } else {
        chart_arg = format!("{source}/{chart_name}").into();
        version_arg = Some(chart_version.to_owned());
    }

    let mut cmd = std::process::Command::new("helm");
    cmd.arg("install")
        .arg(target_release)
        .arg(&chart_arg)
        .arg("--namespace")
        .arg(target_namespace)
        .arg("--create-namespace")
        .arg("--kube-context")
        .arg(context_name)
        .arg("-f")
        .arg(&values_path)
        .arg("--output")
        .arg("json");
    if let Some(v) = &version_arg {
        cmd.arg("--version").arg(v);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(p) = kubeconfig_path {
        cmd.arg("--kubeconfig").arg(p);
    }

    let started = std::time::Instant::now();
    let output = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| FetchError::Conflict(format!("join: {e}")))?
        .map_err(|e| FetchError::Conflict(format!("spawn helm: {e}")))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Ok(HelmInstallResult::Failed {
            message: format!("helm exited with status {}", output.status),
            helm_stderr: stderr,
            elapsed_ms,
        });
    }

    let parsed: Option<Value> = serde_json::from_str(&stdout).ok();
    let revision = parsed
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let status = parsed
        .as_ref()
        .and_then(|v| v.get("info"))
        .and_then(|i| i.get("status"))
        .and_then(|s| s.as_str())
        .map(str::to_owned);

    Ok(HelmInstallResult::Installed {
        revision,
        namespace: target_namespace.to_owned(),
        release_name: target_release.to_owned(),
        status,
        elapsed_ms,
        helm_stdout: stdout,
    })
}

/// Run `helm repo update`. Slow (network: hits every configured repo's
/// index.yaml). Best-effort: failures bubble up so the UI can show them
/// in a toast. Returns the elapsed time so the operator knows the
/// refresh actually happened.
pub async fn helm_repo_update() -> Result<u64, FetchError> {
    use std::process::Stdio;
    if !helm_available() {
        return Err(FetchError::Conflict(
            "helm CLI not found on PATH".to_owned(),
        ));
    }
    let started = std::time::Instant::now();
    let output = tokio::task::spawn_blocking(|| {
        std::process::Command::new("helm")
            .arg("repo")
            .arg("update")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    })
    .await
    .map_err(|e| FetchError::Conflict(format!("join: {e}")))?
    .map_err(|e| FetchError::Conflict(format!("spawn helm: {e}")))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(FetchError::Conflict(format!(
            "helm repo update failed: {}",
            stderr.trim()
        )));
    }
    Ok(elapsed_ms)
}

/// Find the highest semver-newer chart version in `repos` that matches
/// `chart_name`. Returns `None` when nothing newer (or no parse).
///
/// Why semver: helm chart versions follow it ("0.10.0 > 0.9.0", which a
/// string compare would get wrong). For non-semver tags (rare) we silently
/// skip — a non-parseable repo entry doesn't block detecting parseable
/// updates.
pub fn find_update_for_chart(
    chart_name: &str,
    current_version: &str,
    repos: &[HelmRepoChart],
) -> Option<HelmUpdateAvailable> {
    let current = semver::Version::parse(current_version).ok()?;
    let mut best: Option<(semver::Version, &HelmRepoChart)> = None;
    for entry in repos {
        if entry.name != chart_name {
            continue;
        }
        let Ok(v) = semver::Version::parse(&entry.version) else {
            continue;
        };
        if v <= current {
            continue;
        }
        match &best {
            Some((b, _)) if *b >= v => {}
            _ => best = Some((v.clone(), entry)),
        }
    }
    best.map(|(v, e)| HelmUpdateAvailable {
        source: e.repo.clone(),
        version: v.to_string(),
        app_version: e.app_version.clone(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct HelmUpdateAvailable {
    pub source: String,
    pub version: String,
    pub app_version: Option<String>,
}

/// Run `helm uninstall <release> -n <ns>`. Used by `delete_resource_cmd`
/// when the operator deletes a `helm_releases` row. Going through helm
/// (vs. trying to delete the release secret directly) is correct: helm
/// removes BOTH the rendered Kubernetes resources AND the release
/// secrets, in the right order, with hooks. Direct secret deletion would
/// just leak the deployed workloads.
pub async fn helm_uninstall(
    context_name: &str,
    kubeconfig_path: Option<&std::path::Path>,
    namespace: &str,
    release_name: &str,
) -> Result<(), FetchError> {
    use std::process::Stdio;
    if !helm_available() {
        return Err(FetchError::Conflict(
            "helm CLI not found on PATH — install helm to uninstall releases".to_owned(),
        ));
    }
    let mut cmd = std::process::Command::new("helm");
    cmd.arg("uninstall")
        .arg(release_name)
        .arg("--namespace")
        .arg(namespace)
        .arg("--kube-context")
        .arg(context_name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = kubeconfig_path {
        cmd.arg("--kubeconfig").arg(p);
    }
    let output = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| FetchError::Conflict(format!("join: {e}")))?
        .map_err(|e| FetchError::Conflict(format!("spawn helm: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(FetchError::Conflict(format!(
            "helm uninstall failed: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

/// List every helm release secret across the cluster, decoded. Used by
/// chart detail + install to find a chart's source release. Cheap: helm
/// release secrets are tiny in count even on large clusters, and the
/// apiserver does the type-filtering server-side.
async fn list_all_helm_releases(client: Client) -> Result<Vec<helm_releases::Release>, FetchError> {
    let api: Api<Secret> = Api::all(client);
    // Field selector matches what the watchers use, so server-side
    // filtering applies here too.
    let lp = ListParams::default().fields(&format!("type={}", helm_releases::HELM_SECRET_TYPE));
    let list = api.list(&lp).await?;
    Ok(list
        .items
        .iter()
        .filter_map(|sec| helm_releases::decode_release(sec).ok())
        .collect())
}

pub async fn get_resource_quota_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ResourceQuota> = Api::namespaced(client, namespace);
    Ok(resource_quotas::project_detail(&api.get(name).await?))
}

pub async fn get_limit_range_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<LimitRange> = Api::namespaced(client, namespace);
    Ok(limit_ranges::project_detail(&api.get(name).await?))
}

pub async fn get_persistent_volume_claim_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<PersistentVolumeClaim> = Api::namespaced(client, namespace);
    Ok(persistent_volume_claims::project_detail(
        &api.get(name).await?,
    ))
}

pub async fn get_persistent_volume_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<PersistentVolume> = Api::all(client);
    Ok(persistent_volumes::project_detail(&api.get(name).await?))
}

pub async fn get_storage_class_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<StorageClass> = Api::all(client);
    Ok(storage_classes::project_detail(&api.get(name).await?))
}

pub async fn get_custom_resource_definition_detail(
    client: Client,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<CustomResourceDefinition> = Api::all(client);
    Ok(custom_resource_definitions::project_detail(
        &api.get(name).await?,
    ))
}

/// Discover every CRD in the cluster and reduce each to a [`DiscoveredCrd`]
/// (storage version preferred, falling back to the first served version).
/// CRDs without any served versions are skipped — there's nothing to watch.
pub async fn discover_crds(
    client: Client,
) -> Result<Vec<crate::registry::DiscoveredCrd>, FetchError> {
    let api: Api<CustomResourceDefinition> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    let mut out = Vec::new();
    for crd in list.items {
        let spec = crd.spec;
        let storage = spec
            .versions
            .iter()
            .find(|v| v.storage && v.served)
            .or_else(|| spec.versions.iter().find(|v| v.served));
        let Some(v) = storage else {
            continue;
        };
        let printer_columns = v
            .additional_printer_columns
            .as_ref()
            .map(|cols| {
                cols.iter()
                    .map(|c| crate::registry::DiscoveredPrinterColumn {
                        name: c.name.clone(),
                        json_path: c.json_path.clone(),
                        type_: c.type_.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        out.push(crate::registry::DiscoveredCrd {
            group: spec.group.clone(),
            version: v.name.clone(),
            plural: spec.names.plural.clone(),
            kind: spec.names.kind.clone(),
            namespaced: spec.scope == "Namespaced",
            printer_columns,
        });
    }
    Ok(out)
}

/// Fetch a custom resource via the dynamic API plus the matching CRD's
/// schema metadata so the UI can render a generic field-by-field detail
/// view.
///
/// Returns:
/// ```json
/// {
///   "meta": { ... pod_template::project_meta shape ... },
///   "object": { ... live spec/status JSON of the CR ... },
///   "schema": null | { "spec": <openAPIV3Schema>, "status": <openAPIV3Schema> },
///   "printer_columns": [{ "name", "json_path", "type", "description" }],
///   "kind": "FooBar",
///   "group": "example.com",
///   "version": "v1",
///   "scope": "Namespaced" | "Cluster"
/// }
/// ```
///
/// Works for any kind in the registry that's backed by a dynamic CRD — both
/// the catch-all `crd:` ids and the `wkcrd:` overrides. For built-in kinds
/// the schema lookup fails (no matching CRD) and we return `null` for the
/// schema; the UI degrades to schema-less rendering, though built-in kinds
/// have hand-written summaries so this path isn't normally reached.
pub async fn get_custom_resource_detail(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<Value, FetchError> {
    let entry =
        registry::lookup(kind_id).ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
    let meta = &entry.meta;

    let gvk = GroupVersionKind::gvk(meta.group, meta.version, meta.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, meta.plural);

    let api: Api<DynamicObject> = if meta.namespaced {
        let ns = namespace.ok_or_else(|| FetchError::NamespaceRequired(kind_id.to_owned()))?;
        Api::namespaced_with(client.clone(), ns, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };
    let obj = api.get(name).await?;

    // CRD lookup is best-effort: built-in kinds have no CRD, and a user may
    // lack RBAC on apiextensions.k8s.io. Either way, we still return the
    // live object so the UI can render the meta + raw fields.
    let crd_name = if meta.group.is_empty() {
        meta.plural.to_owned()
    } else {
        format!("{}.{}", meta.plural, meta.group)
    };
    let crd_api: Api<CustomResourceDefinition> = Api::all(client);
    let crd = crd_api.get_opt(&crd_name).await.ok().flatten();

    let mut schema_value: Value = Value::Null;
    let mut printer_columns: Vec<Value> = Vec::new();
    if let Some(crd) = crd.as_ref() {
        let v = crd
            .spec
            .versions
            .iter()
            .find(|v| v.name == meta.version)
            .or_else(|| crd.spec.versions.iter().find(|v| v.served));
        if let Some(v) = v {
            if let Some(s) = v
                .schema
                .as_ref()
                .and_then(|s| s.open_api_v3_schema.as_ref())
            {
                let full = serde_json::to_value(s).unwrap_or(Value::Null);
                let spec_branch = full
                    .get("properties")
                    .and_then(|p| p.get("spec"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let status_branch = full
                    .get("properties")
                    .and_then(|p| p.get("status"))
                    .cloned()
                    .unwrap_or(Value::Null);
                schema_value = json!({
                    "spec": spec_branch,
                    "status": status_branch,
                });
            }
            if let Some(cols) = v.additional_printer_columns.as_ref() {
                printer_columns = cols
                    .iter()
                    .map(|c| {
                        json!({
                            "name": c.name.clone(),
                            "json_path": c.json_path.clone(),
                            "type": c.type_.clone(),
                            "description": c.description.clone(),
                        })
                    })
                    .collect();
            }
        }
    }

    let object = serde_json::to_value(&obj).unwrap_or(Value::Null);

    Ok(json!({
        "meta": crate::kinds::pod_template::project_meta(&obj.metadata),
        "object": object,
        "schema": schema_value,
        "printer_columns": printer_columns,
        "kind": meta.kind,
        "group": meta.group,
        "version": meta.version,
        "scope": if meta.namespaced { "Namespaced" } else { "Cluster" },
    }))
}

pub async fn get_service_account_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ServiceAccount> = Api::namespaced(client, namespace);
    Ok(service_accounts::project_detail(&api.get(name).await?))
}

pub async fn get_role_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Role> = Api::namespaced(client, namespace);
    Ok(roles::project_detail(&api.get(name).await?))
}

pub async fn get_role_binding_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<RoleBinding> = Api::namespaced(client, namespace);
    Ok(role_bindings::project_detail(&api.get(name).await?))
}

pub async fn get_cluster_role_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<ClusterRole> = Api::all(client);
    Ok(cluster_roles::project_detail(&api.get(name).await?))
}

pub async fn get_cluster_role_binding_detail(
    client: Client,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ClusterRoleBinding> = Api::all(client);
    Ok(cluster_role_bindings::project_detail(&api.get(name).await?))
}

pub async fn get_horizontal_pod_autoscaler_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, namespace);
    Ok(horizontal_pod_autoscalers::project_detail(
        &api.get(name).await?,
    ))
}

pub async fn get_pod_disruption_budget_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<PodDisruptionBudget> = Api::namespaced(client, namespace);
    Ok(pod_disruption_budgets::project_detail(
        &api.get(name).await?,
    ))
}

pub async fn get_priority_class_detail(client: Client, name: &str) -> Result<Value, FetchError> {
    let api: Api<PriorityClass> = Api::all(client);
    Ok(priority_classes::project_detail(&api.get(name).await?))
}

pub async fn get_replication_controller_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ReplicationController> = Api::namespaced(client, namespace);
    Ok(replication_controllers::project_detail(
        &api.get(name).await?,
    ))
}

pub async fn get_lease_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<Lease> = Api::namespaced(client, namespace);
    Ok(leases::project_detail(&api.get(name).await?))
}

pub async fn get_mutating_webhook_configuration_detail(
    client: Client,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<MutatingWebhookConfiguration> = Api::all(client);
    Ok(mutating_webhook_configurations::project_detail(
        &api.get(name).await?,
    ))
}

pub async fn get_validating_webhook_configuration_detail(
    client: Client,
    name: &str,
) -> Result<Value, FetchError> {
    let api: Api<ValidatingWebhookConfiguration> = Api::all(client);
    Ok(validating_webhook_configurations::project_detail(
        &api.get(name).await?,
    ))
}

/// On-demand detail fetch for any well-known dynamic kind. Resolves the
/// override by `kind_id` (the `wkcrd:` form), then issues a typed
/// `DynamicObject` GET against the embedded version+plural+scope and feeds
/// the result through the override's `project_detail` projection.
pub async fn get_well_known_detail(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<Value, FetchError> {
    let parsed = crate::well_known::parse_id(kind_id)
        .ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
    let wk = crate::well_known::lookup_by_short_id(&parsed.short_id)
        .ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;

    let gvk = GroupVersionKind::gvk(&parsed.group, &parsed.version, &parsed.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &parsed.plural);

    let api: Api<DynamicObject> = if parsed.namespaced {
        let ns = namespace.ok_or_else(|| FetchError::NamespaceRequired(kind_id.to_owned()))?;
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let obj = api.get(name).await?;
    Ok((wk.project_detail)(&obj))
}

/// Trigger a `kubectl rollout restart`-equivalent for the workload that owns
/// `pod`. Walks Pod → controller (and ReplicaSet → Deployment when applicable),
/// then patches the workload's `spec.template.metadata.annotations` with a
/// fresh `kubectl.kubernetes.io/restartedAt` value. The controller sees the
/// template hash change and rolls out new pods gracefully.
///
/// Returns the `(kind, name)` of the workload that was actually patched so the
/// UI can report what was restarted.
pub async fn restart_pod_owner(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<(String, String), FetchError> {
    let (owner_kind, owner_name) = resolve_pod_owner(&client, namespace, name).await?;
    let ts = jiff::Timestamp::now().to_string();
    patch_workload_template(&client, &owner_kind, namespace, &owner_name, &ts).await?;
    Ok((owner_kind, owner_name))
}

#[derive(Debug, Clone, Serialize)]
pub struct RestartedWorkload {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    /// Names of selected pods that map to this owner (post-dedup).
    pub pods: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestartFailure {
    pub namespace: String,
    pub pod: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestartPodsReport {
    pub patched: Vec<RestartedWorkload>,
    pub failures: Vec<RestartFailure>,
}

/// Trigger a `kubectl rollout restart`-equivalent on a workload identified by
/// its `kind` ("Deployment" / "StatefulSet" / "DaemonSet") and `(namespace,
/// name)`. Uses a JSON merge-patch to bump
/// `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`
/// — strategically distinct from SSA, which would interpret the unspecified
/// `selector` / `template.spec.containers` as a request to null those fields
/// (Deployment selectors are immutable, so the apiserver rejects with 422).
pub async fn restart_workload(
    client: Client,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<(), FetchError> {
    let ts = jiff::Timestamp::now().to_string();
    patch_workload_template(&client, kind, namespace, name, &ts).await
}

/// Bulk `kubectl rollout restart` for a set of pods. Walks each pod's owner,
/// dedupes by `(owner_kind, namespace, owner_name)`, and patches each unique
/// workload exactly once with a *single shared timestamp*. Three pods owned
/// by the same Deployment → one patch → one rollout.
///
/// Pods whose owner can't be resolved (bare pods, Job-owned, …) are reported
/// in `failures`; the remaining workloads are still patched.
pub async fn restart_pods_owners(
    client: Client,
    pods: Vec<(String, String)>,
) -> Result<RestartPodsReport, FetchError> {
    let ts = jiff::Timestamp::now().to_string();

    // Phase 1 — resolve every pod's owner; group pod names by owner.
    let mut owner_to_pods: HashMap<(String, String, String), Vec<String>> = HashMap::new();
    let mut failures: Vec<RestartFailure> = Vec::new();
    for (ns, pod_name) in pods {
        match resolve_pod_owner(&client, &ns, &pod_name).await {
            Ok((kind, owner_name)) => {
                owner_to_pods
                    .entry((kind, ns, owner_name))
                    .or_default()
                    .push(pod_name);
            }
            Err(e) => failures.push(RestartFailure {
                namespace: ns,
                pod: pod_name,
                error: e.to_string(),
            }),
        }
    }

    // Phase 2 — patch each unique owner once. Failure attaches to every pod
    // that mapped to that owner so the UI can report accurately.
    let mut patched: Vec<RestartedWorkload> = Vec::new();
    for ((kind, namespace, name), pod_names) in owner_to_pods {
        match patch_workload_template(&client, &kind, &namespace, &name, &ts).await {
            Ok(()) => patched.push(RestartedWorkload {
                kind,
                namespace,
                name,
                pods: pod_names,
            }),
            Err(e) => {
                let msg = e.to_string();
                for pn in pod_names {
                    failures.push(RestartFailure {
                        namespace: namespace.clone(),
                        pod: pn,
                        error: msg.clone(),
                    });
                }
            }
        }
    }

    Ok(RestartPodsReport { patched, failures })
}

async fn resolve_pod_owner(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<(String, String), FetchError> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = pods.get(name).await?;
    let controller = pod
        .metadata
        .owner_references
        .unwrap_or_default()
        .into_iter()
        .find(|o| o.controller == Some(true))
        .ok_or_else(|| FetchError::NoController(format!("Pod {name}")))?;

    if controller.kind == "ReplicaSet" {
        let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
        let rs = rs_api.get(&controller.name).await?;
        let rs_owner = rs
            .metadata
            .owner_references
            .unwrap_or_default()
            .into_iter()
            .find(|o| o.controller == Some(true))
            .ok_or_else(|| FetchError::NoController(format!("ReplicaSet {}", controller.name)))?;
        Ok((rs_owner.kind, rs_owner.name))
    } else {
        Ok((controller.kind, controller.name))
    }
}

async fn patch_workload_template(
    client: &Client,
    kind: &str,
    namespace: &str,
    name: &str,
    timestamp: &str,
) -> Result<(), FetchError> {
    let patch = json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": timestamp,
                    }
                }
            }
        }
    });
    let pp = PatchParams::default();
    match kind {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
            api.patch(name, &pp, &Patch::Merge(&patch)).await?;
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
            api.patch(name, &pp, &Patch::Merge(&patch)).await?;
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), namespace);
            api.patch(name, &pp, &Patch::Merge(&patch)).await?;
        }
        other => return Err(FetchError::UnsupportedRestart(other.to_owned())),
    }
    Ok(())
}

/// Delete a single resource via the dynamic API. `grace_period_seconds = Some(0)`
/// triggers a force delete (no graceful termination); `None` uses the kind's
/// default grace period.
pub async fn delete_resource(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
    grace_period_seconds: Option<u32>,
) -> Result<(), FetchError> {
    let entry =
        registry::lookup(kind_id).ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
    let meta = &entry.meta;

    let gvk = GroupVersionKind::gvk(meta.group, meta.version, meta.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, meta.plural);

    let api: Api<DynamicObject> = if meta.namespaced {
        let ns = namespace.ok_or_else(|| FetchError::NamespaceRequired(kind_id.to_owned()))?;
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let dp = DeleteParams {
        grace_period_seconds,
        ..Default::default()
    };
    api.delete(name, &dp).await?;
    Ok(())
}

// ── Server-Side Apply ──────────────────────────────────────────────────────

/// Field manager string the apiserver records as the owner of any field we
/// write via SSA. Stable across versions so subsequent edits from
/// ferrisscope merge cleanly with prior ones; conflicts only arise when a
/// *different* manager (kubectl, an operator, GitOps controller) owns the
/// same field.
pub const FIELD_MANAGER: &str = "ferrisscope";

#[derive(Debug, Clone, Serialize)]
pub struct ApplyConflict {
    /// True when the apiserver returned a 409 with a `metav1.StatusDetails`
    /// listing fields owned by another manager. The UI can surface a
    /// "force takeover?" prompt in that case.
    pub conflict: bool,
    /// Best-effort list of managers whose fields conflict, parsed from the
    /// status reply. Empty if we couldn't extract them.
    pub managers: Vec<String>,
    /// Best-effort list of conflicting field paths (e.g. `.spec.hard.cpu`).
    /// Empty if the apiserver didn't include them.
    pub fields: Vec<String>,
    /// Raw error message — always populated, useful when the conflict
    /// breakdown above is empty.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyOk {
    /// `metadata.resourceVersion` of the object after the apply lands. The
    /// UI can use this to know the watcher will eventually catch up; it's
    /// not currently required for optimistic concurrency since SSA handles
    /// that on the server.
    pub resource_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApplyResult {
    Applied(ApplyOk),
    Conflict(ApplyConflict),
}

/// Server-Side Apply against any kind in the registry. The caller passes a
/// partial object — SSA tracks per-field ownership keyed by `FIELD_MANAGER`
/// so subsequent applies merge cleanly with the existing object instead of
/// clobbering whole sub-trees.
///
/// `force` corresponds to the SSA `force` flag: false (default) makes
/// conflicts visible (returns `ApplyResult::Conflict`); true takes
/// ownership of the conflicting fields without asking. The UI surfaces a
/// confirm step before flipping to true.
///
/// The patch object must include `apiVersion` + `kind` + `metadata.name`
/// (the apiserver requires them for SSA) — the helper attaches them so the
/// caller only sends the field tree it actually wants to own.
pub async fn apply_resource(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
    fields: Value,
    force: bool,
) -> Result<ApplyResult, FetchError> {
    let entry =
        registry::lookup(kind_id).ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
    let meta = &entry.meta;

    let gvk = GroupVersionKind::gvk(meta.group, meta.version, meta.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, meta.plural);

    let api: Api<DynamicObject> = if meta.namespaced {
        let ns = namespace.ok_or_else(|| FetchError::NamespaceRequired(kind_id.to_owned()))?;
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    // Build the SSA payload. The required envelope (apiVersion / kind /
    // metadata.name) lives here so callers don't have to re-derive it.
    let api_version = if meta.group.is_empty() {
        meta.version.to_owned()
    } else {
        format!("{}/{}", meta.group, meta.version)
    };
    let mut patch = if fields.is_object() {
        fields
    } else {
        json!({})
    };
    {
        let obj = patch.as_object_mut().expect("ensured object above");
        obj.insert("apiVersion".to_owned(), Value::String(api_version));
        obj.insert("kind".to_owned(), Value::String(meta.kind.to_owned()));
        let metadata_entry = obj.entry("metadata").or_insert_with(|| json!({}));
        if !metadata_entry.is_object() {
            *metadata_entry = json!({});
        }
        let metadata = metadata_entry
            .as_object_mut()
            .expect("ensured object above");
        metadata.insert("name".to_owned(), Value::String(name.to_owned()));
        if let Some(ns) = namespace {
            metadata.insert("namespace".to_owned(), Value::String(ns.to_owned()));
        }
    }

    let mut pp = PatchParams::apply(FIELD_MANAGER);
    if force {
        pp = pp.force();
    }

    match api.patch(name, &pp, &Patch::Apply(&patch)).await {
        Ok(obj) => Ok(ApplyResult::Applied(ApplyOk {
            resource_version: obj.metadata.resource_version,
        })),
        Err(kube::Error::Api(status)) if status.code == 409 => {
            // The 409 Status payload lists conflicting fields under
            // `details.causes[*].field`. The conflict message itself names
            // the *other* manager — typical shape:
            //   `Apply failed with 1 conflict: conflict with "kubectl": .spec.hard.cpu`
            let mut managers: Vec<String> = Vec::new();
            let mut conflicting_fields: Vec<String> = Vec::new();
            if let Some(details) = status.details.as_ref() {
                for c in &details.causes {
                    if !c.field.is_empty() {
                        conflicting_fields.push(c.field.clone());
                    }
                    if let Some(m) = extract_manager(&c.message) {
                        if !managers.iter().any(|x| x == &m) {
                            managers.push(m);
                        }
                    }
                }
            }
            if managers.is_empty() {
                if let Some(m) = extract_manager(&status.message) {
                    managers.push(m);
                }
            }
            Ok(ApplyResult::Conflict(ApplyConflict {
                conflict: true,
                managers,
                fields: conflicting_fields,
                message: status.message.clone(),
            }))
        }
        Err(e) => Err(FetchError::Kube(e)),
    }
}

fn extract_manager(msg: &str) -> Option<String> {
    let start = msg.find('"')? + 1;
    let rest = &msg[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_owned())
}

// ── Node operations: cordon / uncordon / drain / pods-on-node ──────────────
//
// `cordon` / `uncordon` flip `spec.unschedulable` via Server-Side Apply with
// the same `ferrisscope` field manager every other edit uses, so subsequent
// toggles merge cleanly. `drain` cordons first, then evicts all pods on the
// node via the policy/v1 Eviction subresource. DaemonSet-controlled pods are
// skipped (kubectl drain default); pods with no controller are also skipped
// unless `force=true` (mirrors `kubectl drain --force`). Mirror pods (created
// by the kubelet) are always skipped — eviction can't remove them.

/// Set `spec.unschedulable` to `cordon`. SSA is used so two consecutive
/// cordon/uncordon calls don't fight over field ownership.
pub async fn set_node_cordon(client: Client, name: &str, cordon: bool) -> Result<(), FetchError> {
    let patch = json!({ "spec": { "unschedulable": cordon } });
    match apply_resource(client, "nodes", None, name, patch, false).await? {
        ApplyResult::Applied(_) => Ok(()),
        ApplyResult::Conflict(c) => Err(FetchError::Conflict(c.message)),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DrainSkipped {
    pub namespace: String,
    pub pod: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DrainFailure {
    pub namespace: String,
    pub pod: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DrainReport {
    pub evicted: Vec<String>,
    pub skipped: Vec<DrainSkipped>,
    pub failures: Vec<DrainFailure>,
}

/// Cordon the node, then evict every pod scheduled on it. DaemonSet-owned
/// pods and mirror pods are always skipped. Bare pods (no controller) are
/// skipped unless `force=true`. Eviction respects PDBs server-side; a PDB
/// blocking eviction surfaces as a per-pod failure rather than failing the
/// whole drain.
pub async fn drain_node(
    client: Client,
    name: &str,
    force: bool,
) -> Result<DrainReport, FetchError> {
    set_node_cordon(client.clone(), name, true).await?;

    let pods_all: Api<Pod> = Api::all(client.clone());
    let lp = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let list = pods_all.list(&lp).await?;

    let mut evicted: Vec<String> = Vec::new();
    let mut skipped: Vec<DrainSkipped> = Vec::new();
    let mut failures: Vec<DrainFailure> = Vec::new();

    for pod in list.items {
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let qualified = format!("{ns}/{pod_name}");

        let controller = pod
            .metadata
            .owner_references
            .as_ref()
            .and_then(|owners| owners.iter().find(|o| o.controller == Some(true)));

        if pod
            .metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get("kubernetes.io/config.mirror"))
            .is_some()
        {
            skipped.push(DrainSkipped {
                namespace: ns,
                pod: pod_name,
                reason: "mirror pod".to_owned(),
            });
            continue;
        }

        if let Some(c) = controller {
            if c.kind == "DaemonSet" {
                skipped.push(DrainSkipped {
                    namespace: ns,
                    pod: pod_name,
                    reason: "DaemonSet-managed".to_owned(),
                });
                continue;
            }
        } else if !force {
            skipped.push(DrainSkipped {
                namespace: ns,
                pod: pod_name,
                reason: "no controller (use force to evict)".to_owned(),
            });
            continue;
        }

        let pods_ns: Api<Pod> = Api::namespaced(client.clone(), &ns);
        let ep = EvictParams::default();
        match pods_ns.evict(&pod_name, &ep).await {
            Ok(_) => evicted.push(qualified),
            Err(e) => failures.push(DrainFailure {
                namespace: ns,
                pod: pod_name,
                error: e.to_string(),
            }),
        }
    }

    Ok(DrainReport {
        evicted,
        skipped,
        failures,
    })
}

/// Row-shaped projection of every pod scheduled on `node`. Same JSON shape as
/// the pod table watcher emits, so the frontend can render it with the
/// existing pod row component without a parallel projection.
pub async fn list_pods_on_node(client: Client, node: &str) -> Result<Vec<Value>, FetchError> {
    let pods_all: Api<Pod> = Api::all(client);
    let lp = ListParams::default().fields(&format!("spec.nodeName={node}"));
    let list = pods_all.list(&lp).await?;
    let rows: Vec<Value> = list
        .items
        .iter()
        .map(|pod| {
            let mut row = <crate::kinds::pods::PodSpec as crate::registry::KindSpec>::project(pod);
            // The watcher's delta path injects `uid` via `with_uid`; this list
            // path bypasses the watcher, so we have to add it here. Without
            // it the frontend's dedup map keys every row under `undefined`
            // and only the last pod survives.
            if let (Some(map), Some(uid)) = (row.as_object_mut(), pod.metadata.uid.as_ref()) {
                map.insert("uid".to_owned(), Value::String(uid.clone()));
            }
            row
        })
        .collect();
    Ok(rows)
}

// ── Multi-doc YAML apply (Create-from-YAML) ────────────────────────────────

/// Per-document outcome from `apply_yaml`. The frontend renders a list of
/// these so a multi-doc manifest can show partial success / per-doc conflict.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DocApplyResult {
    Applied {
        kind: String,
        api_version: String,
        name: String,
        namespace: Option<String>,
        resource_version: Option<String>,
        dry_run: bool,
    },
    Conflict {
        kind: String,
        api_version: String,
        name: String,
        namespace: Option<String>,
        managers: Vec<String>,
        fields: Vec<String>,
        message: String,
    },
    Error {
        /// May be empty for parse failures (no kind to attribute it to).
        kind: String,
        api_version: String,
        name: String,
        namespace: Option<String>,
        message: String,
    },
}

/// Apply every YAML document in `yaml`. Each doc is parsed, has its GVK
/// resolved via discovery (so CRDs work), and is sent through Server-Side
/// Apply with field manager [`FIELD_MANAGER`]. `dry_run` runs server-side
/// dry-run; `force` flips SSA force on conflicts.
///
/// The function never fails as a whole — per-doc errors are folded into the
/// returned vector so a partial success is visible to the operator.
pub async fn apply_yaml(
    client: Client,
    yaml: &str,
    dry_run: bool,
    force: bool,
) -> Vec<DocApplyResult> {
    let mut results = Vec::new();

    // Parse every document up front so the iterator's libyaml state (which
    // is `!Send`) is dropped before we hit any `.await`. The async loop then
    // drives apply over plain `serde_json::Value`s.
    let mut docs: Vec<Result<Value, serde_yaml::Error>> = Vec::new();
    for de in serde_yaml::Deserializer::from_str(yaml) {
        docs.push(Value::deserialize(de));
    }

    for parsed in docs {
        let value: Value = match parsed {
            Ok(v) => v,
            Err(e) => {
                results.push(DocApplyResult::Error {
                    kind: String::new(),
                    api_version: String::new(),
                    name: String::new(),
                    namespace: None,
                    message: format!("yaml parse: {e}"),
                });
                continue;
            }
        };
        // Skip empty docs (e.g. trailing `---` or blank separators).
        if value.is_null() || value.as_object().is_some_and(serde_json::Map::is_empty) {
            continue;
        }

        let api_version = value
            .get("apiVersion")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let name = value
            .get("metadata")
            .and_then(|m| m.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let namespace = value
            .get("metadata")
            .and_then(|m| m.get("namespace"))
            .and_then(Value::as_str)
            .map(str::to_owned);

        if api_version.is_empty() || kind.is_empty() || name.is_empty() {
            results.push(DocApplyResult::Error {
                kind: kind.clone(),
                api_version: api_version.clone(),
                name: name.clone(),
                namespace: namespace.clone(),
                message: "doc missing apiVersion / kind / metadata.name".to_owned(),
            });
            continue;
        }

        let (group, version) = match api_version.split_once('/') {
            Some((g, v)) => (g.to_owned(), v.to_owned()),
            // Core group: apiVersion is bare "v1".
            None => (String::new(), api_version.clone()),
        };
        let gvk = GroupVersionKind::gvk(&group, &version, &kind);

        let (ar, caps) = match discovery::pinned_kind(&client, &gvk).await {
            Ok(pair) => pair,
            Err(e) => {
                results.push(DocApplyResult::Error {
                    kind: kind.clone(),
                    api_version: api_version.clone(),
                    name: name.clone(),
                    namespace: namespace.clone(),
                    message: format!("discover gvk: {e}"),
                });
                continue;
            }
        };

        let api: Api<DynamicObject> = match caps.scope {
            kube::discovery::Scope::Namespaced => {
                let Some(ns) = namespace.as_deref() else {
                    results.push(DocApplyResult::Error {
                        kind: kind.clone(),
                        api_version: api_version.clone(),
                        name: name.clone(),
                        namespace: None,
                        message: "namespaced kind requires metadata.namespace".to_owned(),
                    });
                    continue;
                };
                Api::namespaced_with(client.clone(), ns, &ar)
            }
            kube::discovery::Scope::Cluster => Api::all_with(client.clone(), &ar),
        };

        let mut pp = PatchParams::apply(FIELD_MANAGER);
        if force {
            pp = pp.force();
        }
        if dry_run {
            pp = pp.dry_run();
        }

        match api.patch(&name, &pp, &Patch::Apply(&value)).await {
            Ok(obj) => results.push(DocApplyResult::Applied {
                kind: kind.clone(),
                api_version: api_version.clone(),
                name: name.clone(),
                namespace: namespace.clone(),
                resource_version: obj.metadata.resource_version,
                dry_run,
            }),
            Err(kube::Error::Api(status)) if status.code == 409 => {
                let mut managers: Vec<String> = Vec::new();
                let mut conflicting_fields: Vec<String> = Vec::new();
                if let Some(details) = status.details.as_ref() {
                    for c in &details.causes {
                        if !c.field.is_empty() {
                            conflicting_fields.push(c.field.clone());
                        }
                        if let Some(m) = extract_manager(&c.message) {
                            if !managers.iter().any(|x| x == &m) {
                                managers.push(m);
                            }
                        }
                    }
                }
                if managers.is_empty() {
                    if let Some(m) = extract_manager(&status.message) {
                        managers.push(m);
                    }
                }
                results.push(DocApplyResult::Conflict {
                    kind: kind.clone(),
                    api_version: api_version.clone(),
                    name: name.clone(),
                    namespace: namespace.clone(),
                    managers,
                    fields: conflicting_fields,
                    message: status.message.clone(),
                });
            }
            Err(e) => results.push(DocApplyResult::Error {
                kind: kind.clone(),
                api_version: api_version.clone(),
                name: name.clone(),
                namespace: namespace.clone(),
                message: e.to_string(),
            }),
        }
    }

    results
}
