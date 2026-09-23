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
        ObjectMeta, Patch, PatchParams, PostParams,
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
    #[error("{0} has no usable pod selector — can't list its pods")]
    NoSelector(String),
    #[error("{0} doesn't support rollout restart — use Delete to recreate")]
    UnsupportedRestart(String),
    #[error("{0} has no usable job template")]
    NoJobTemplate(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Timeout(String),
    #[error("{0}")]
    InvalidArgument(String),
}

impl From<crate::helm::HelmArgError> for FetchError {
    fn from(e: crate::helm::HelmArgError) -> Self {
        Self::InvalidArgument(e.to_string())
    }
}

/// Synthetic helm kinds register `core/v1 secrets` as their GVK; the generic
/// object paths must not resolve them, or they'd act on a same-named Secret.
fn reject_synthetic_kind(kind_id: &str) -> Result<(), FetchError> {
    if matches!(kind_id, "helm_releases" | "helm_charts") {
        return Err(FetchError::UnknownKind(format!(
            "{kind_id} is a synthetic helm view, not an API object"
        )));
    }
    Ok(())
}

pub async fn get_resource_yaml(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<String, FetchError> {
    reject_synthetic_kind(kind_id)?;
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

const OBJECT_EVENTS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Fetch only Events attached to one concrete Kubernetes object. The UID field
/// selector is evaluated by the apiserver, avoiding the detail panel's former
/// cluster-wide Event reflector and client-side filtering.
pub async fn list_object_events(
    client: Client,
    namespace: Option<&str>,
    uid: &str,
) -> Result<Vec<Value>, FetchError> {
    let api: Api<Event> = match namespace.filter(|ns| !ns.is_empty()) {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };
    let params = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
    let list = tokio::time::timeout(OBJECT_EVENTS_TIMEOUT, api.list(&params))
        .await
        .map_err(|_| {
            FetchError::Timeout("listing object events timed out after 15s".to_owned())
        })??;

    Ok(list.items.iter().filter_map(events::project_row).collect())
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

/// Namespace names in the cluster, sorted. Backs the namespace picker in the
/// new-port-forward form. One-shot list per call — fresh each time the form
/// opens, no caching (mirrors the env-ref / volume pickers).
pub async fn list_namespace_names(client: Client) -> Result<Vec<String>, FetchError> {
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    let mut names: Vec<String> = list
        .items
        .into_iter()
        .filter_map(|ns| ns.metadata.name)
        .collect();
    names.sort();
    Ok(names)
}

/// Light projection of every Service in a namespace — name + its ports — used
/// by the port-forward form's Service picker. Carries `ports` so the form can
/// offer a remote-port dropdown without a second `get_service_detail` round
/// trip. Sorted by name for stable UI.
pub async fn list_services_in_namespace(
    client: Client,
    namespace: &str,
) -> Result<Value, FetchError> {
    let api: Api<Service> = Api::namespaced(client, namespace);
    let list = api.list(&ListParams::default()).await?;
    let mut out: Vec<Value> = list
        .items
        .into_iter()
        .map(|svc| {
            let name = svc.metadata.name.unwrap_or_default();
            let ports: Vec<Value> = svc
                .spec
                .as_ref()
                .and_then(|s| s.ports.as_ref())
                .map(|ports| {
                    ports
                        .iter()
                        .filter_map(|p| {
                            // Only ports that fit a u16 are forwardable.
                            u16::try_from(p.port).ok().map(|port| {
                                json!({
                                    "port": port,
                                    "name": p.name,
                                    "protocol": p.protocol.clone().unwrap_or_else(|| "TCP".into()),
                                })
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({ "name": name, "ports": ports })
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

pub use crate::helm::{helm_available, HelmRepoChart, HelmUpdateAvailable};
use crate::helm::{
    helm_command, run_helm, HelmRunError, KubeTarget, HELM_KILL_TIMEOUT, HELM_OP_TIMEOUT,
    HELM_READ_TIMEOUT,
};

/// Helm release detail: the latest revision fully decoded plus a summary of
/// every revision. `helm_available` is re-probed per call so the managed
/// installer can flip it mid-session.
pub async fn get_helm_release_detail(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Value, FetchError> {
    let secrets = list_release_secrets(client, namespace, name).await?;
    let (latest_idx, latest) = decode_latest_release(namespace, name, &secrets)?;
    let mut history: Vec<helm_releases::ReleaseSummary> = secrets
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != latest_idx)
        .filter_map(|(_, s)| match helm_releases::decode_release_summary(s) {
            Ok(r) => Some(r),
            Err(e) => {
                tracing::debug!(error = %e, "helm history: skipping undecodable revision");
                None
            }
        })
        .collect();
    history.push(latest.summary());

    let helm = helm_available();
    let update = match (
        helm,
        latest.chart_meta_str("name"),
        latest.chart_meta_str("version"),
    ) {
        (true, Some(n), Some(v)) => {
            crate::helm::find_chart_update(&n, &v, &latest.chart_identity()).await
        }
        _ => None,
    };
    Ok(helm_releases::project_detail(
        &latest,
        &history,
        helm,
        update.as_ref(),
    ))
}

/// Every revision secret of one release (`owner=helm,name=<release>`).
async fn list_release_secrets(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<Vec<Secret>, FetchError> {
    crate::helm::validate_namespace(namespace)?;
    crate::helm::validate_release_name(name)?;
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let secrets: Vec<Secret> = api
        .list(&lp)
        .await?
        .items
        .into_iter()
        .filter(|s| s.type_.as_deref() == Some(helm_releases::HELM_SECRET_TYPE))
        .collect();
    if secrets.is_empty() {
        return Err(FetchError::UnknownKind(format!(
            "helm release {namespace}/{name}"
        )));
    }
    Ok(secrets)
}

/// The highest revision is picked from secret labels, then decoded; a
/// corrupt latest is an error rather than a silent fall back to an older
/// revision.
fn decode_latest_release(
    namespace: &str,
    name: &str,
    secrets: &[Secret],
) -> Result<(usize, helm_releases::Release), FetchError> {
    let (idx, sec) = secrets
        .iter()
        .enumerate()
        .max_by_key(|(_, s)| {
            helm_releases::secret_revision(s)
                .or_else(|| {
                    helm_releases::decode_release_summary(s)
                        .ok()
                        .map(|r| r.version)
                })
                .unwrap_or(i64::MIN)
        })
        .ok_or_else(|| FetchError::UnknownKind(format!("helm release {namespace}/{name}")))?;
    let rel = helm_releases::decode_release(sec).map_err(|e| {
        FetchError::Conflict(format!(
            "helm release {namespace}/{name}: latest revision secret {} can't be decoded: {e}",
            sec.metadata.name.as_deref().unwrap_or("?")
        ))
    })?;
    Ok((idx, rel))
}

/// Helm keeps an `uninstalled` release's history only with `--keep-history`;
/// `helm upgrade` can't move it forward.
fn ensure_upgradable(rel: &helm_releases::Release) -> Result<(), FetchError> {
    if rel.info.status.as_deref() == Some("uninstalled") {
        return Err(FetchError::Conflict(format!(
            "helm release {}/{} is uninstalled (history kept); install it again instead of upgrading",
            rel.namespace.as_deref().unwrap_or(""),
            rel.name
        )));
    }
    Ok(())
}

/// Mapped straight into the `Failed` variant of the upgrade / install /
/// rollback results so every banner looks the same.
#[derive(Debug)]
pub struct HelmDepUpdateFailure {
    pub message: String,
    pub helm_stderr: String,
    pub elapsed_ms: u64,
}

async fn run_dependency(
    verb: &str,
    chart_dir: &std::path::Path,
    started: std::time::Instant,
) -> Result<(), HelmDepUpdateFailure> {
    let cmd = helm_command(crate::helm::dependency_args(verb, chart_dir));
    let output = run_helm(cmd, HELM_KILL_TIMEOUT)
        .await
        .map_err(|e| HelmDepUpdateFailure {
            message: format!("helm dependency {verb}: {e}"),
            helm_stderr: String::new(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(HelmDepUpdateFailure {
        message: format!(
            "helm dependency {verb} exited with status {}",
            output.status
        ),
        helm_stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Fetch declared subcharts into `<chart_dir>/charts/` (release secrets
/// never carry them). `dependency build` pins to the extracted lock file;
/// only a lock that no longer matches `Chart.yaml` falls back to
/// `dependency update`. `upgrade --dependency-update` is no substitute: it
/// lacks a registry client for OCI-hosted deps.
pub async fn helm_dependency_fetch(
    chart_dir: &std::path::Path,
) -> Result<(), HelmDepUpdateFailure> {
    let started = std::time::Instant::now();
    match run_dependency("build", chart_dir, started).await {
        Err(fail) if fail.helm_stderr.contains("out of sync") => {
            tracing::info!("helm dependency build: lock out of sync, falling back to update");
            run_dependency("update", chart_dir, started).await
        }
        other => other,
    }
}

enum HelmRun {
    Done { stdout: String, elapsed_ms: u64 },
    Failed(HelmDepUpdateFailure),
}

async fn run_helm_mutation(args: Vec<std::ffi::OsString>) -> Result<HelmRun, FetchError> {
    let started = std::time::Instant::now();
    let output = match run_helm(helm_command(&args), HELM_KILL_TIMEOUT).await {
        Ok(o) => o,
        Err(e @ HelmRunError::TimedOut(_)) => {
            return Ok(HelmRun::Failed(HelmDepUpdateFailure {
                message: e.to_string(),
                helm_stderr: String::new(),
                elapsed_ms: started.elapsed().as_millis() as u64,
            }));
        }
        Err(e) => return Err(FetchError::Conflict(e.to_string())),
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if !output.status.success() {
        return Ok(HelmRun::Failed(HelmDepUpdateFailure {
            message: format!("helm exited with status {}", output.status),
            helm_stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            elapsed_ms,
        }));
    }
    Ok(HelmRun::Done {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        elapsed_ms,
    })
}

/// Convention used in the chart catalog `source` axis. In-cluster charts
/// (those derived from existing helm release secrets) carry this constant;
/// repo charts carry the repo name itself (e.g. `bitnami`).
pub const HELM_CLUSTER_SOURCE: &str = "cluster";

/// `helm search repo` (latest version per chart), served from the
/// process-wide cache that [`helm_repo_update`] invalidates.
pub async fn helm_search_repo() -> Vec<HelmRepoChart> {
    crate::helm::search_repo_cached().await.as_ref().clone()
}

/// `helm show values <chart-ref> --version <version>` for a repo chart's
/// detail panel. Empty on failure — the chart can still be installed
/// without overrides.
pub async fn helm_show_values(chart_ref: &str, version: &str) -> String {
    if !helm_available()
        || crate::helm::validate_chart_ref(chart_ref).is_err()
        || crate::helm::validate_version(version).is_err()
    {
        return String::new();
    }
    let cmd = helm_command(["show", "values", "--version", version, "--", chart_ref]);
    let output = match run_helm(cmd, HELM_READ_TIMEOUT).await {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("helm show values {chart_ref}@{version}: {e}");
            return String::new();
        }
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

fn helm_tempdir() -> Result<tempfile::TempDir, FetchError> {
    tempfile::Builder::new()
        .prefix("ferrisscope-helm-")
        .tempdir()
        .map_err(|e| FetchError::Conflict(format!("tempdir: {e}")))
}

fn write_values_file(
    dir: &std::path::Path,
    values_yaml: &str,
) -> Result<std::path::PathBuf, FetchError> {
    let path = dir.join("values.yaml");
    std::fs::write(&path, values_yaml)
        .map_err(|e| FetchError::Conflict(format!("write values: {e}")))?;
    Ok(path)
}

/// Extract the release's embedded chart into `<tmp>/chart` and fetch its
/// subcharts. `Ok(Err(failure))` = dependency fetch failed (banner-worthy).
async fn stage_release_chart(
    release: &helm_releases::Release,
    tmp: &std::path::Path,
) -> Result<Result<std::path::PathBuf, HelmDepUpdateFailure>, FetchError> {
    let chart_dir = tmp.join("chart");
    helm_releases::extract_chart_to_dir(release, &chart_dir)
        .map_err(|e| FetchError::Conflict(format!("chart extract: {e}")))?;
    if helm_releases::chart_has_dependencies(release) {
        if let Err(fail) = helm_dependency_fetch(&chart_dir).await {
            return Ok(Err(fail));
        }
    }
    Ok(Ok(chart_dir))
}

/// `helm upgrade` an existing release. `values_yaml` is the operator's
/// complete user-values intent (`--reset-values`, so an empty buffer means
/// chart defaults). The chart comes from the latest release secret, or
/// with `chart_override = Some((repo, version))` from `<repo>/<chart>`.
///
/// Shells out to the CLI: templates, hooks and the storage driver must
/// behave exactly as for `helm`-using operators.
pub async fn helm_upgrade(
    client: Client,
    context_name: &str,
    kubeconfig_path: Option<&std::path::Path>,
    namespace: &str,
    name: &str,
    values_yaml: &str,
    chart_override: Option<(&str, &str)>,
) -> Result<HelmUpgradeResult, FetchError> {
    if let Some((src, ver)) = chart_override {
        crate::helm::validate_repo_name(src)?;
        crate::helm::validate_version(ver)?;
    }
    if !helm_available() {
        return Ok(HelmUpgradeResult::HelmMissing);
    }
    let secrets = list_release_secrets(client, namespace, name).await?;
    let (_, latest) = decode_latest_release(namespace, name, &secrets)?;
    drop(secrets);
    ensure_upgradable(&latest)?;

    let tmp = helm_tempdir()?;
    let values_path = write_values_file(tmp.path(), values_yaml)?;
    let (chart_arg, version): (std::ffi::OsString, Option<&str>) = match chart_override {
        Some((src, ver)) => {
            let chart_name = latest
                .chart_meta_str("name")
                .ok_or_else(|| FetchError::Conflict("release has no chart name".to_owned()))?;
            crate::helm::validate_repo_name(&chart_name)?;
            (format!("{src}/{chart_name}").into(), Some(ver))
        }
        None => match stage_release_chart(&latest, tmp.path()).await? {
            Ok(dir) => (dir.into_os_string(), None),
            Err(fail) => {
                return Ok(HelmUpgradeResult::Failed {
                    message: fail.message,
                    helm_stderr: fail.helm_stderr,
                    elapsed_ms: fail.elapsed_ms,
                })
            }
        },
    };

    let args = crate::helm::upgrade_args(
        &crate::helm::UpgradeSpec {
            release: name,
            namespace,
            chart: &chart_arg,
            values_file: &values_path,
            version,
            install: false,
            create_namespace: false,
            reset_values: true,
            wait: false,
            timeout: HELM_OP_TIMEOUT,
        },
        KubeTarget {
            context: context_name,
            kubeconfig: kubeconfig_path,
        },
    );
    Ok(match run_helm_mutation(args).await? {
        HelmRun::Failed(f) => HelmUpgradeResult::Failed {
            message: f.message,
            helm_stderr: f.helm_stderr,
            elapsed_ms: f.elapsed_ms,
        },
        HelmRun::Done { stdout, elapsed_ms } => {
            let out = crate::helm::summarize_release_output(&stdout);
            HelmUpgradeResult::Upgraded {
                revision: out.revision.unwrap_or(latest.version + 1),
                status: out.status,
                elapsed_ms,
                helm_stdout: out.summary,
            }
        }
    })
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelmRollbackResult {
    RolledBack {
        /// The new revision helm wrote (a rollback is a new revision).
        revision: Option<i64>,
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

/// `helm rollback <release> [revision]`; `None` = previous revision.
pub async fn helm_rollback(
    client: Client,
    context_name: &str,
    kubeconfig_path: Option<&std::path::Path>,
    namespace: &str,
    name: &str,
    revision: Option<i64>,
) -> Result<HelmRollbackResult, FetchError> {
    crate::helm::validate_namespace(namespace)?;
    crate::helm::validate_release_name(name)?;
    if let Some(r) = revision {
        crate::helm::validate_revision(r)?;
    }
    if !helm_available() {
        return Ok(HelmRollbackResult::HelmMissing);
    }
    let args = crate::helm::rollback_args(
        name,
        namespace,
        revision,
        KubeTarget {
            context: context_name,
            kubeconfig: kubeconfig_path,
        },
    );
    Ok(match run_helm_mutation(args).await? {
        HelmRun::Failed(f) => HelmRollbackResult::Failed {
            message: f.message,
            helm_stderr: f.helm_stderr,
            elapsed_ms: f.elapsed_ms,
        },
        HelmRun::Done { stdout, elapsed_ms } => {
            // Metadata-only list: the `version` label is enough.
            let api: Api<Secret> = Api::namespaced(client, namespace);
            let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
            let revision = match api.list_metadata(&lp).await {
                Ok(list) => list
                    .items
                    .iter()
                    .filter_map(|m| m.metadata.labels.as_ref()?.get("version")?.parse().ok())
                    .max(),
                Err(e) => {
                    tracing::debug!(error = %e, "helm rollback: revision lookup failed");
                    None
                }
            };
            let mut end = stdout.len().min(2048);
            while !stdout.is_char_boundary(end) {
                end -= 1;
            }
            HelmRollbackResult::RolledBack {
                revision,
                elapsed_ms,
                helm_stdout: stdout[..end].trim().to_owned(),
            }
        }
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

/// Where a revision secret lives, so the one full decode can re-fetch it.
#[derive(Debug, Clone)]
struct RevisionRef {
    secret_namespace: String,
    secret_name: String,
    summary: helm_releases::ReleaseSummary,
}

impl RevisionRef {
    fn uses_chart(&self, chart_name: &str, chart_version: &str) -> bool {
        self.summary.chart_meta_str("name").as_deref() == Some(chart_name)
            && self.summary.chart_meta_str("version").as_deref() == Some(chart_version)
    }
}

/// Summaries of every helm release secret in the cluster, listed in small
/// pages (each secret can carry ~1 MiB of chart).
async fn list_helm_revisions(client: Client) -> Result<Vec<RevisionRef>, FetchError> {
    let api: Api<Secret> = Api::all(client);
    let mut lp = ListParams::default()
        .fields(&format!("type={}", helm_releases::HELM_SECRET_TYPE))
        .limit(HELM_LIST_PAGE);
    let mut out = Vec::new();
    loop {
        let page = api.list(&lp).await?;
        for sec in &page.items {
            let (Some(ns), Some(name)) = (&sec.metadata.namespace, &sec.metadata.name) else {
                continue;
            };
            match helm_releases::decode_release_summary(sec) {
                Ok(summary) => out.push(RevisionRef {
                    secret_namespace: ns.clone(),
                    secret_name: name.clone(),
                    summary,
                }),
                Err(e) => {
                    tracing::debug!(error = %e, secret = %name, "helm: skipping undecodable secret");
                }
            }
        }
        match page.metadata.continue_ {
            Some(token) if !token.is_empty() => lp = lp.continue_token(&token),
            _ => break,
        }
    }
    Ok(out)
}

const HELM_LIST_PAGE: u32 = 25;

/// Latest revision per `(namespace, release)`.
fn latest_revisions(revisions: Vec<RevisionRef>) -> Vec<RevisionRef> {
    let mut latest: std::collections::BTreeMap<helm_releases::ReleaseKey, RevisionRef> =
        std::collections::BTreeMap::new();
    for r in revisions {
        match latest.get(&r.summary.key()) {
            Some(cur) if cur.summary.version >= r.summary.version => {}
            _ => {
                latest.insert(r.summary.key(), r);
            }
        }
    }
    latest.into_values().collect()
}

async fn fetch_full_release(
    client: Client,
    r: &RevisionRef,
) -> Result<helm_releases::Release, FetchError> {
    let api: Api<Secret> = Api::namespaced(client, &r.secret_namespace);
    let sec = api.get(&r.secret_name).await?;
    helm_releases::decode_release(&sec).map_err(|e| {
        FetchError::Conflict(format!(
            "helm release secret {}/{} can't be decoded: {e}",
            r.secret_namespace, r.secret_name
        ))
    })
}

async fn get_helm_chart_detail_cluster(
    client: Client,
    chart_name: &str,
    chart_version: &str,
) -> Result<Value, FetchError> {
    let matches: Vec<RevisionRef> = latest_revisions(list_helm_revisions(client.clone()).await?)
        .into_iter()
        .filter(|r| r.uses_chart(chart_name, chart_version))
        .collect();
    let first = matches.first().ok_or_else(|| {
        FetchError::UnknownKind(format!(
            "no release uses chart {chart_name}@{chart_version}"
        ))
    })?;
    let sample = fetch_full_release(client, first).await?;

    let default_values_yaml = sample
        .chart_default_values()
        .as_ref()
        .filter(|v| !v.is_null())
        .map(|v| serde_yaml::to_string(v).unwrap_or_default())
        .unwrap_or_default();

    let used_by: Vec<Value> = matches
        .iter()
        .map(|r| {
            let s = &r.summary;
            json!({
                "namespace": s.namespace.clone().unwrap_or_default(),
                "name": s.name.clone(),
                "revision": s.version,
                "status": s.info.status.clone(),
                "updated": s.info.last_deployed.clone(),
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
    crate::helm::validate_repo_name(repo)?;
    crate::helm::validate_repo_name(chart_name)?;
    crate::helm::validate_version(chart_version)?;
    if !helm_available() {
        return Err(FetchError::Conflict(
            "helm CLI not found on PATH".to_owned(),
        ));
    }
    let chart_ref = format!("{repo}/{chart_name}");
    let default_values_yaml = helm_show_values(&chart_ref, chart_version).await;
    let entries = crate::helm::search_repo_cached().await;
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
    crate::helm::validate_namespace(target_namespace)?;
    crate::helm::validate_release_name(target_release)?;
    if source != HELM_CLUSTER_SOURCE {
        crate::helm::validate_repo_name(source)?;
        crate::helm::validate_repo_name(chart_name)?;
        crate::helm::validate_version(chart_version)?;
    }
    if !helm_available() {
        return Ok(HelmInstallResult::HelmMissing);
    }

    let tmp = helm_tempdir()?;
    let values_path = write_values_file(tmp.path(), values_yaml)?;
    let (chart_arg, version): (std::ffi::OsString, Option<&str>) = if source == HELM_CLUSTER_SOURCE
    {
        let hit = list_helm_revisions(client.clone())
            .await?
            .into_iter()
            .find(|r| r.uses_chart(chart_name, chart_version))
            .ok_or_else(|| {
                FetchError::UnknownKind(format!(
                    "no release uses chart {chart_name}@{chart_version}"
                ))
            })?;
        let sample = fetch_full_release(client, &hit).await?;
        match stage_release_chart(&sample, tmp.path()).await? {
            Ok(dir) => (dir.into_os_string(), None),
            Err(fail) => {
                return Ok(HelmInstallResult::Failed {
                    message: fail.message,
                    helm_stderr: fail.helm_stderr,
                    elapsed_ms: fail.elapsed_ms,
                })
            }
        }
    } else {
        (format!("{source}/{chart_name}").into(), Some(chart_version))
    };

    let args = crate::helm::install_args(
        target_release,
        target_namespace,
        &chart_arg,
        &values_path,
        version,
        KubeTarget {
            context: context_name,
            kubeconfig: kubeconfig_path,
        },
    );
    Ok(match run_helm_mutation(args).await? {
        HelmRun::Failed(f) => HelmInstallResult::Failed {
            message: f.message,
            helm_stderr: f.helm_stderr,
            elapsed_ms: f.elapsed_ms,
        },
        HelmRun::Done { stdout, elapsed_ms } => {
            let out = crate::helm::summarize_release_output(&stdout);
            HelmInstallResult::Installed {
                revision: out.revision.unwrap_or(1),
                namespace: target_namespace.to_owned(),
                release_name: target_release.to_owned(),
                status: out.status,
                elapsed_ms,
                helm_stdout: out.summary,
            }
        }
    })
}

/// `helm repo update` (slow, network). Invalidates the search / chart
/// identity caches so update indicators pick up new versions.
pub async fn helm_repo_update() -> Result<u64, FetchError> {
    if !helm_available() {
        return Err(FetchError::Conflict(
            "helm CLI not found on PATH".to_owned(),
        ));
    }
    let started = std::time::Instant::now();
    let result = run_helm(helm_command(["repo", "update"]), HELM_KILL_TIMEOUT).await;
    crate::helm::invalidate_repo_caches();
    let output = result.map_err(|e| match e {
        HelmRunError::TimedOut(_) => FetchError::Timeout(format!("helm repo update: {e}")),
        e => FetchError::Conflict(e.to_string()),
    })?;
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

/// `helm uninstall` — the only correct delete for a release: it removes the
/// rendered resources and the release secrets in order, with hooks.
pub async fn helm_uninstall(
    context_name: &str,
    kubeconfig_path: Option<&std::path::Path>,
    namespace: &str,
    release_name: &str,
) -> Result<(), FetchError> {
    crate::helm::validate_namespace(namespace)?;
    crate::helm::validate_release_name(release_name)?;
    if !helm_available() {
        return Err(FetchError::Conflict(
            "helm CLI not found on PATH — install helm to uninstall releases".to_owned(),
        ));
    }
    let cmd = helm_command(crate::helm::uninstall_args(
        release_name,
        namespace,
        KubeTarget {
            context: context_name,
            kubeconfig: kubeconfig_path,
        },
    ));
    let output = run_helm(cmd, HELM_KILL_TIMEOUT)
        .await
        .map_err(|e| match e {
            HelmRunError::TimedOut(_) => {
                FetchError::Timeout(format!("helm uninstall {namespace}/{release_name}: {e}"))
            }
            e => FetchError::Conflict(e.to_string()),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(FetchError::Conflict(format!(
            "helm uninstall failed: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

pub async fn helm_storage_probe(client: Client) -> Result<bool, FetchError> {
    Ok(crate::helm::helm_storage_probe(client).await?)
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
/// How the apiserver should treat a deleted object's dependents.
///
/// Mirrors `kubectl delete --cascade`. It exists as our own enum rather than
/// re-exporting `kube::api::PropagationPolicy` so it can cross the Tauri
/// bridge as a plain snake_case string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Cascade {
    /// Delete the owner immediately; the garbage collector removes dependents
    /// in the background. What `kubectl delete` does.
    #[default]
    Background,
    /// Keep the owner (marked deleting) until every dependent is gone.
    Foreground,
    /// Leave dependents running, stripped of their owner reference.
    Orphan,
}

impl From<Cascade> for kube::api::PropagationPolicy {
    fn from(c: Cascade) -> Self {
        match c {
            Cascade::Background => Self::Background,
            Cascade::Foreground => Self::Foreground,
            Cascade::Orphan => Self::Orphan,
        }
    }
}

/// Delete one object.
///
/// `cascade` defaults to [`Cascade::Background`] — the propagation policy is
/// always sent explicitly, never left to the apiserver's per-resource default.
/// That default is a trap: `batch/v1` Job and CronJob still answer
/// `OrphanDependents` for backwards compatibility, so an empty `DeleteOptions`
/// deletes the Job and leaves its pods running with their owner reference
/// stripped — invisible, unreferenced, still consuming the cluster. kubectl
/// dodges this by always sending `--cascade=background`; so do we.
pub async fn delete_resource(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
    grace_period_seconds: Option<u32>,
    cascade: Option<Cascade>,
) -> Result<(), FetchError> {
    reject_synthetic_kind(kind_id)?;
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
        propagation_policy: Some(cascade.unwrap_or_default().into()),
        ..Default::default()
    };
    api.delete(name, &dp).await?;
    Ok(())
}

// ── Job / CronJob operations ───────────────────────────────────────────────

/// Labels the Job controller stamps onto a Job's pod template and selector.
/// They key the controller's ownership of the pods, so a Job cloned for a
/// re-run must not carry them — the clone would adopt the original's pods.
const CONTROLLER_LABELS: [&str; 4] = [
    "controller-uid",
    "job-name",
    "batch.kubernetes.io/controller-uid",
    "batch.kubernetes.io/job-name",
];

/// Longest name the apiserver accepts for a Job (DNS-1123 subdomain rules
/// apply, but the Job controller also needs room for the pod-name suffix it
/// appends).
const MAX_JOB_NAME_LEN: usize = 52;

/// Build `<base>-<suffix>`, truncating `base` so the result stays within
/// [`MAX_JOB_NAME_LEN`] and never ends on a separator (a trailing `-` is not a
/// valid DNS-1123 name).
fn derived_name(base: &str, suffix: &str) -> String {
    let budget = MAX_JOB_NAME_LEN.saturating_sub(suffix.len() + 1);
    let stem = base
        .chars()
        .take(budget)
        .collect::<String>()
        .trim_end_matches(['-', '.'])
        .to_owned();
    if stem.is_empty() {
        suffix.to_owned()
    } else {
        format!("{stem}-{suffix}")
    }
}

/// Name for a manual run of `cronjob`, mirroring the `<name>-<timestamp>`
/// shape the CronJob controller itself uses for scheduled runs.
#[must_use]
pub fn manual_job_name(cronjob: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    derived_name(cronjob, &format!("manual-{}", now.timestamp()))
}

/// Name for a re-run of `job`. The suffix keeps re-runs of re-runs from
/// colliding, since the base name is reused verbatim.
#[must_use]
pub fn rerun_job_name(job: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    derived_name(job, &format!("rerun-{}", now.timestamp()))
}

/// Create a Job from a CronJob's `jobTemplate` — `kubectl create job X
/// --from=cronjob/Y`.
///
/// The owner reference is the point of the exercise: with `controller: true`
/// the CronJob's `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` reap
/// the manual run like any scheduled one, and deleting the CronJob takes it
/// along. Without it the Job would outlive its parent forever.
///
/// Suspended CronJobs are still triggerable — that is precisely when an
/// operator wants a one-off run — and it is what kubectl allows.
pub async fn trigger_cron_job(
    client: Client,
    namespace: &str,
    name: &str,
    job_name: &str,
) -> Result<String, FetchError> {
    let cron_api: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let cj = cron_api.get(name).await?;

    let job_spec = cj
        .spec
        .job_template
        .spec
        .clone()
        .ok_or_else(|| FetchError::NoJobTemplate(name.to_owned()))?;
    let uid = cj
        .metadata
        .uid
        .clone()
        .ok_or_else(|| FetchError::NoJobTemplate(name.to_owned()))?;

    let template_meta = cj.spec.job_template.metadata.unwrap_or_default();
    let mut annotations = template_meta.annotations.unwrap_or_default();
    // The marker kubectl sets; the CronJob controller and anything reading
    // job provenance keys off it to tell manual runs from scheduled ones.
    annotations.insert(
        "cronjob.kubernetes.io/instantiate".to_owned(),
        "manual".to_owned(),
    );

    let job = Job {
        metadata: ObjectMeta {
            name: Some(job_name.to_owned()),
            namespace: Some(namespace.to_owned()),
            annotations: Some(annotations),
            labels: template_meta.labels,
            owner_references: Some(vec![
                k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
                    api_version: "batch/v1".to_owned(),
                    kind: "CronJob".to_owned(),
                    name: name.to_owned(),
                    uid,
                    controller: Some(true),
                    block_owner_deletion: None,
                },
            ]),
            ..Default::default()
        },
        spec: Some(job_spec),
        status: None,
    };

    let jobs_api: Api<Job> = Api::namespaced(client, namespace);
    let created = jobs_api.create(&PostParams::default(), &job).await?;
    Ok(created.metadata.name.unwrap_or_else(|| job_name.to_owned()))
}

/// Re-run a finished Job by creating a fresh copy of it.
///
/// A Job's spec is immutable once created, so "run it again" can only mean
/// "create another one". Three things have to be stripped or the apiserver
/// rejects the copy, or worse, accepts it and lets the clone fight the
/// original over the same pods:
///
/// * `spec.selector` and `spec.manualSelector` — generated by the controller
///   from the original's uid.
/// * The `controller-uid` / `job-name` labels on the pod template, for the
///   same reason.
/// * `spec.suspend` — a re-run is a request to run, not to stage.
///
/// Owner references are deliberately *kept*: a Job owned by a CronJob stays
/// owned by it, so history limits keep reaping it.
pub async fn rerun_job(
    client: Client,
    namespace: &str,
    name: &str,
    new_name: &str,
) -> Result<String, FetchError> {
    let api: Api<Job> = Api::namespaced(client, namespace);
    let source = api.get(name).await?;

    let mut spec = source
        .spec
        .clone()
        .ok_or_else(|| FetchError::NoJobTemplate(name.to_owned()))?;
    spec.selector = None;
    spec.manual_selector = None;
    spec.suspend = None;
    if let Some(labels) = spec
        .template
        .metadata
        .as_mut()
        .and_then(|m| m.labels.as_mut())
    {
        for key in CONTROLLER_LABELS {
            labels.remove(key);
        }
    }

    let mut annotations = source.metadata.annotations.clone().unwrap_or_default();
    // Points at what this was cloned from; the last-applied blob would
    // describe the *original* object and mislead a later `kubectl apply`.
    annotations.remove("kubectl.kubernetes.io/last-applied-configuration");
    annotations.insert("ferrisscope.dev/rerun-of".to_owned(), name.to_owned());

    let mut labels = source.metadata.labels.clone().unwrap_or_default();
    for key in CONTROLLER_LABELS {
        labels.remove(key);
    }

    let job = Job {
        metadata: ObjectMeta {
            name: Some(new_name.to_owned()),
            namespace: Some(namespace.to_owned()),
            annotations: Some(annotations),
            labels: Some(labels),
            owner_references: source.metadata.owner_references.clone(),
            ..Default::default()
        },
        spec: Some(spec),
        status: None,
    };

    let created = api.create(&PostParams::default(), &job).await?;
    Ok(created.metadata.name.unwrap_or_else(|| new_name.to_owned()))
}

/// Newest-first cap on the job history we return for a CronJob. History
/// limits default to 3 succeeded + 1 failed, but operators raise them; this
/// keeps a pathological limit from shipping hundreds of rows over the bridge.
const MAX_CRON_JOB_HISTORY: usize = 50;

/// Page size for the namespace scan behind the history list.
const HISTORY_PAGE_SIZE: u32 = 200;

/// Hardest bound on that scan. Ownership can only be tested client-side (the
/// apiserver has no owner-reference selector), so the whole namespace has to
/// be walked — and a CI namespace can hold tens of thousands of Jobs. Stop
/// after this many objects rather than deserialise all of them; the loop
/// works newest-key-last through etcd order, so an early stop can only miss
/// runs, never invent them.
const MAX_CRON_JOB_HISTORY_SCAN: usize = 20 * HISTORY_PAGE_SIZE as usize;

/// Hard cap on *pages*, independent of how many objects they carry. The
/// object-count bound alone is not enough: an apiserver page can come back
/// empty while still handing out a continue token, which would leave the
/// count-based check never advancing and the command spinning forever.
const MAX_CRON_JOB_HISTORY_PAGES: usize = 40;

/// The two bounds have to stay coherent: a scan cap below the page size would
/// fetch exactly one page and stop, and a cap below the returned-row cap would
/// make the cap unreachable.
const _: () = {
    assert!(MAX_CRON_JOB_HISTORY_SCAN >= HISTORY_PAGE_SIZE as usize);
    assert!(MAX_CRON_JOB_HISTORY_SCAN >= MAX_CRON_JOB_HISTORY);
};

/// Jobs owned by `name`, newest first — the CronJob's run history.
///
/// Ownership, not label match: the CronJob's `jobTemplate.metadata.labels` are
/// operator-supplied and routinely shared with unrelated workloads, so a
/// selector query would fold in Jobs this CronJob never created. Filtering on
/// the controller owner reference is exact.
/// Result of [`list_jobs_for_cron_job`].
///
/// `truncated` must reach the UI. Ownership can only be tested client-side —
/// the apiserver has no owner-reference selector — so the whole namespace has
/// to be walked, and any of the bounds (pages, objects, returned rows) can cut
/// the walk short. etcd paginates by key, not by time, so an early stop can
/// miss *every* run of a CronJob whose name sorts late. A UI reporting an
/// empty list as "runs older than the history limits were deleted" would be
/// stating a retention fact it cannot know.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CronJobHistory {
    pub runs: Vec<Value>,
    pub truncated: bool,
}

pub async fn list_jobs_for_cron_job(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<CronJobHistory, FetchError> {
    let cron_api: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let uid = cron_api
        .get(name)
        .await?
        .metadata
        .uid
        .ok_or_else(|| FetchError::NoJobTemplate(name.to_owned()))?;

    let jobs_api: Api<Job> = Api::namespaced(client, namespace);
    let mut owned: Vec<Job> = Vec::new();
    let mut scanned = 0usize;
    let mut cursor: Option<String> = None;
    let mut truncated = false;

    for page_no in 0..MAX_CRON_JOB_HISTORY_PAGES {
        let mut lp = ListParams::default().limit(HISTORY_PAGE_SIZE);
        if let Some(token) = cursor.take() {
            lp = lp.continue_token(&token);
        }
        let page = jobs_api.list(&lp).await?;
        scanned += page.items.len();
        owned.extend(page.items.into_iter().filter(|j| {
            j.metadata
                .owner_references
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|o| o.uid == uid && o.controller.unwrap_or(false))
        }));

        cursor = page.metadata.continue_.filter(|c| !c.is_empty());
        if cursor.is_none() {
            break;
        }
        if scanned >= MAX_CRON_JOB_HISTORY_SCAN || page_no + 1 == MAX_CRON_JOB_HISTORY_PAGES {
            tracing::warn!(
                namespace,
                cronjob = name,
                scanned,
                pages = page_no + 1,
                "cronjob history: namespace scan hit its cap; older runs may be missing"
            );
            truncated = true;
            break;
        }
    }

    // Sort key is start time, falling back to creation: a Job the controller
    // has not started yet still has to sort above one that ran yesterday.
    owned.sort_by(|a, b| {
        job_sort_key(b)
            .cmp(&job_sort_key(a))
            .then_with(|| b.metadata.name.cmp(&a.metadata.name))
    });
    if owned.len() > MAX_CRON_JOB_HISTORY {
        truncated = true;
        owned.truncate(MAX_CRON_JOB_HISTORY);
    }

    Ok(CronJobHistory {
        runs: owned.iter().map(jobs::project_history_row).collect(),
        truncated,
    })
}

fn job_sort_key(job: &Job) -> Option<String> {
    job.status
        .as_ref()
        .and_then(|s| s.start_time.as_ref())
        .or(job.metadata.creation_timestamp.as_ref())
        .map(|t| t.0.to_string())
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
    reject_synthetic_kind(kind_id)?;
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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MergePatchResult {
    /// Patch landed. Carries the new `resourceVersion` so the UI knows the
    /// watcher will catch up.
    Applied { resource_version: Option<String> },
    /// The object changed on the server since the operator opened it — the
    /// `resourceVersion` they edited from is stale. The UI offers reload or
    /// apply-anyway. This is the only conflict mode of the merge-patch path
    /// (unlike SSA, there is no per-field ownership conflict).
    Stale { message: String },
}

/// Build the JSON merge-patch body that actually goes on the wire. Injects
/// `metadata.resourceVersion` when the caller supplies one so the apiserver
/// enforces optimistic concurrency (rejecting the PATCH with a 409 if the
/// object moved on). Pulled out as a pure function so the envelope handling
/// is unit-testable without a cluster.
fn build_merge_patch_body(patch: Value, resource_version: Option<&str>) -> Value {
    let mut body = if patch.is_object() { patch } else { json!({}) };
    if let Some(rv) = resource_version {
        let obj = body.as_object_mut().expect("ensured object above");
        let metadata_entry = obj.entry("metadata").or_insert_with(|| json!({}));
        if !metadata_entry.is_object() {
            *metadata_entry = json!({});
        }
        metadata_entry
            .as_object_mut()
            .expect("ensured object above")
            .insert("resourceVersion".to_owned(), Value::String(rv.to_owned()));
    }
    body
}

/// `kubectl edit`-style save for the YAML manifest tab. Applies an RFC 7386
/// JSON merge patch (adds + edits + `null` deletions) against any kind in the
/// registry. This is deliberately *not* Server-Side Apply: a free-form
/// manifest editor wants last-write-wins with explicit deletions, not
/// per-field ownership tracking (which is what the structured editors use via
/// [`apply_resource`]).
///
/// `resource_version` carries optimistic concurrency: `Some(rv)` makes the
/// apiserver reject the patch with a 409 if the object changed since the
/// operator opened it (surfaced as [`MergePatchResult::Stale`]); `None` skips
/// the check (the UI's explicit "apply anyway" overwrite).
pub async fn merge_patch_resource(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
    patch: Value,
    resource_version: Option<&str>,
) -> Result<MergePatchResult, FetchError> {
    reject_synthetic_kind(kind_id)?;
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

    let body = build_merge_patch_body(patch, resource_version);

    match api
        .patch(name, &PatchParams::default(), &Patch::Merge(&body))
        .await
    {
        Ok(obj) => Ok(MergePatchResult::Applied {
            resource_version: obj.metadata.resource_version,
        }),
        // A resourceVersion mismatch comes back as 409 Conflict with a
        // message like "the object has been modified; please apply your
        // changes to the latest version and try again".
        Err(kube::Error::Api(status))
            if is_stale_conflict(status.code, resource_version.is_some()) =>
        {
            Ok(MergePatchResult::Stale {
                message: status.message.clone(),
            })
        }
        Err(e) => Err(FetchError::Kube(e)),
    }
}

/// Whether a 409 from a merge-patch should surface as [`MergePatchResult::Stale`]
/// (the optimistic-concurrency "object changed, reload?" path) versus a hard
/// error. Only a patch that *carried* a resourceVersion can get a genuine
/// resourceVersion conflict; for the unconditional "apply anyway" overwrite
/// (`resource_version: None`) the apiserver runs no concurrency check, so a 409
/// there is something else entirely (admission webhook, `AlreadyExists` race)
/// and must not masquerade as staleness — which would loop the operator
/// through a pointless reload that can never resolve it.
fn is_stale_conflict(status_code: u16, had_resource_version: bool) -> bool {
    status_code == 409 && had_resource_version
}

#[cfg(test)]
mod run_helm_tests {
    use super::{run_helm, HelmRunError};
    use std::time::Duration;

    #[tokio::test]
    async fn kills_and_reports_on_timeout() {
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("5");
        let started = std::time::Instant::now();
        let err = run_helm(cmd, Duration::from_millis(100)).await.unwrap_err();
        assert!(matches!(err, HelmRunError::TimedOut(_)), "got {err:?}");
        // The call must return at the deadline, not when sleep finishes.
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn passes_through_success_output() {
        let mut cmd = std::process::Command::new("echo");
        cmd.arg("hi");
        let out = run_helm(cmd, Duration::from_secs(5)).await.unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[tokio::test]
    async fn surfaces_spawn_failure_for_missing_binary() {
        let cmd = std::process::Command::new("ferrisscope-no-such-binary");
        let err = run_helm(cmd, Duration::from_secs(1)).await.unwrap_err();
        assert!(matches!(err, HelmRunError::Spawn(_)), "got {err:?}");
    }
}

#[cfg(test)]
mod helm_fetch_tests {
    use super::*;
    use base64::Engine;
    use k8s_openapi::ByteString;
    use std::collections::BTreeMap;

    #[test]
    fn generic_paths_refuse_synthetic_helm_kinds() {
        for id in ["helm_releases", "helm_charts"] {
            assert!(matches!(
                reject_synthetic_kind(id),
                Err(FetchError::UnknownKind(_))
            ));
        }
        assert!(reject_synthetic_kind("secrets").is_ok());
        assert!(reject_synthetic_kind("pods").is_ok());
    }

    fn release_secret(name: &str, version: Option<i64>, payload: &str) -> Secret {
        let mut s = Secret::default();
        s.metadata.name = Some(name.to_owned());
        s.metadata.namespace = Some("ns".to_owned());
        s.metadata.labels =
            version.map(|v| BTreeMap::from([("version".to_owned(), v.to_string())]));
        s.data = Some(BTreeMap::from([(
            "release".to_owned(),
            ByteString(
                base64::engine::general_purpose::STANDARD
                    .encode(payload)
                    .into_bytes(),
            ),
        )]));
        s
    }

    fn payload(version: i64, status: &str) -> String {
        json!({ "name": "web", "namespace": "ns", "version": version, "info": { "status": status } })
            .to_string()
    }

    #[test]
    fn latest_is_chosen_numerically_and_must_decode() {
        let secrets = vec![
            release_secret(
                "sh.helm.release.v1.web.v9",
                Some(9),
                &payload(9, "superseded"),
            ),
            release_secret(
                "sh.helm.release.v1.web.v10",
                Some(10),
                &payload(10, "deployed"),
            ),
            release_secret("sh.helm.release.v1.web.v2", None, &payload(2, "superseded")),
        ];
        let (idx, rel) = decode_latest_release("ns", "web", &secrets).expect("latest");
        assert_eq!(
            (idx, rel.version),
            (1, 10),
            "10 > 9 numerically, not lexically"
        );

        let corrupt = vec![
            release_secret(
                "sh.helm.release.v1.web.v1",
                Some(1),
                &payload(1, "superseded"),
            ),
            release_secret("sh.helm.release.v1.web.v2", Some(2), "{broken"),
        ];
        let err = decode_latest_release("ns", "web", &corrupt).expect_err("no silent fallback");
        assert!(err.to_string().contains("v2"), "{err}");
    }

    #[test]
    fn uninstalled_release_is_not_upgradable() {
        let rel = |status: &str| {
            let v: helm_releases::Release =
                serde_json::from_str(&payload(3, status)).expect("release");
            v
        };
        assert!(ensure_upgradable(&rel("deployed")).is_ok());
        assert!(ensure_upgradable(&rel("failed")).is_ok());
        let err = ensure_upgradable(&rel("uninstalled")).expect_err("uninstalled");
        assert!(err.to_string().contains("uninstalled"), "{err}");
    }

    fn revision(ns: &str, name: &str, version: i64, chart_version: &str) -> RevisionRef {
        RevisionRef {
            secret_namespace: ns.to_owned(),
            secret_name: format!("sh.helm.release.v1.{name}.v{version}"),
            summary: serde_json::from_value(json!({
                "name": name, "namespace": ns, "version": version,
                "chart": { "metadata": { "name": "nginx", "version": chart_version } },
            }))
            .expect("summary"),
        }
    }

    #[test]
    fn chart_used_by_counts_latest_revisions_only() {
        let revs = vec![
            revision("a", "web", 1, "1.0.0"),
            revision("a", "web", 2, "2.0.0"),
            revision("b", "web", 5, "1.0.0"),
            revision("b", "api", 1, "1.0.0"),
            revision("b", "api", 3, "1.0.0"),
        ];
        let used: Vec<(String, String, i64)> = latest_revisions(revs)
            .into_iter()
            .filter(|r| r.uses_chart("nginx", "1.0.0"))
            .map(|r| (r.secret_namespace, r.summary.name, r.summary.version))
            .collect();
        assert_eq!(
            used,
            [
                ("b".to_owned(), "api".to_owned(), 3),
                ("b".to_owned(), "web".to_owned(), 5),
            ],
            "a/web moved to 2.0.0; b/api counted once"
        );
    }
}

#[cfg(test)]
mod merge_patch_tests {
    use super::build_merge_patch_body;
    use serde_json::json;

    #[test]
    fn injects_resource_version_into_existing_metadata() {
        let patch = json!({ "metadata": { "labels": { "a": "b" } }, "data": { "k": "v" } });
        let body = build_merge_patch_body(patch, Some("42"));
        assert_eq!(body["metadata"]["resourceVersion"], json!("42"));
        // existing fields survive
        assert_eq!(body["metadata"]["labels"]["a"], json!("b"));
        assert_eq!(body["data"]["k"], json!("v"));
    }

    #[test]
    fn creates_metadata_when_absent() {
        let patch = json!({ "spec": { "replicas": 3 } });
        let body = build_merge_patch_body(patch, Some("7"));
        assert_eq!(body["metadata"]["resourceVersion"], json!("7"));
        assert_eq!(body["spec"]["replicas"], json!(3));
    }

    #[test]
    fn preserves_null_deletions_in_the_patch() {
        // The merge-patch's whole point: a removed key arrives as null and
        // must stay null through envelope assembly.
        let patch = json!({ "data": { "gone": null, "kept": "x" } });
        let body = build_merge_patch_body(patch, None);
        assert!(body["data"].as_object().unwrap().contains_key("gone"));
        assert_eq!(body["data"]["gone"], json!(null));
        assert_eq!(body["data"]["kept"], json!("x"));
        // No resourceVersion requested → no metadata injected.
        assert!(body.get("metadata").is_none());
    }

    #[test]
    fn non_object_patch_becomes_empty_object() {
        let body = build_merge_patch_body(json!("oops"), Some("1"));
        assert_eq!(body["metadata"]["resourceVersion"], json!("1"));
    }

    #[test]
    fn stale_conflict_only_when_resource_version_was_sent() {
        use super::is_stale_conflict;
        // Conditional save (rv sent) + 409 → optimistic-concurrency stale.
        assert!(is_stale_conflict(409, true));
        // Unconditional "apply anyway" (no rv) + 409 → NOT stale; it's a real
        // error (webhook / AlreadyExists), surfaced as such instead of looping
        // the operator through a reload that can't resolve it.
        assert!(!is_stale_conflict(409, false));
        // Non-409 statuses are never stale, regardless of rv.
        assert!(!is_stale_conflict(422, true));
        assert!(!is_stale_conflict(404, true));
    }
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

/// Result of [`list_pods_for_workload`]: the rows plus whether the apiserver
/// had more to give. `truncated` must reach the UI — see the note on
/// `list_pods_for_workload` for why a silently short list is worse than an
/// obviously short one.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkloadPods {
    pub rows: Vec<Value>,
    pub truncated: bool,
}

/// Row-shaped projection of the pods a workload's label selector matches,
/// using the same resolution the log surface uses
/// (`log_pods::workload_selector`), so the two never disagree.
///
/// A label selector is *not* ownership — a bare pod, or a second controller
/// sharing `app=x` in the namespace, matches too. That is what `kubectl get
/// pods -l` shows and what the log and port-forward surfaces already act on;
/// callers must not present the result as "owned by" without checking
/// ownerReferences.
///
/// Selection is server-side: the apiserver applies the selector, we never ship
/// a namespace of pods just to drop most of them. For a Deployment this
/// deliberately spans *every* ReplicaSet it owns, including a rollout's
/// outgoing one — those surge pods are its pods.
///
/// Capped at [`log_pods::MAX_RESOLVED_PODS`]; a DaemonSet on a large cluster
/// would otherwise deserialise thousands of Pods and ship them all over the
/// IPC bridge. Overflow truncates rather than failing — the caller sees a
/// usable prefix — but it is REPORTED, never silent. A truncated list is not
/// merely incomplete on screen: the frontend seeds its delta filter from these
/// uids, so under a selector it cannot evaluate client-side (matchExpressions)
/// every pod past the cap is refused from the live stream too, and would stay
/// invisible with no signal at all.
///
/// `kind_id` must be a selector-owning workload; `cronjobs` is rejected with
/// `UnknownKind` because a CronJob reaches its pods through its child Jobs.
pub async fn list_pods_for_workload(
    client: Client,
    kind_id: &str,
    namespace: &str,
    name: &str,
) -> Result<WorkloadPods, FetchError> {
    let selector = crate::log_pods::workload_selector(client.clone(), kind_id, namespace, name)
        .await?
        .ok_or_else(|| FetchError::NoSelector(name.to_owned()))?;
    let query = crate::log_pods::selector_query(&selector)
        // An empty selector would match the whole namespace — surface it
        // rather than showing the operator pods the workload doesn't own.
        .ok_or_else(|| FetchError::NoSelector(name.to_owned()))?;

    let pods: Api<Pod> = Api::namespaced(client, namespace);
    let lp = ListParams::default()
        .labels(&query)
        // Bound server-side so the apiserver stops rather than us deserialising
        // thousands of Pods and discarding them.
        .limit(u32::try_from(crate::log_pods::MAX_RESOLVED_PODS).unwrap_or(u32::MAX));
    let list = pods.list(&lp).await?;
    let rows: Vec<Value> = list
        .items
        .iter()
        .map(|pod| {
            let mut row = <crate::kinds::pods::PodSpec as crate::registry::KindSpec>::project(pod);
            // Same reason as `list_pods_on_node`: the watcher's delta path
            // injects `uid` via `with_uid`, this list path bypasses it, and
            // without a uid the frontend's dedup map collapses every row onto
            // `undefined` so only the last pod survives.
            if let (Some(map), Some(uid)) = (row.as_object_mut(), pod.metadata.uid.as_ref()) {
                map.insert("uid".to_owned(), Value::String(uid.clone()));
            }
            row
        })
        .collect();
    // `continue_` is the apiserver's own "there is more" token; a full page
    // without one is exactly `MAX_RESOLVED_PODS` pods and nothing omitted.
    let truncated = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|c| !c.is_empty());
    if truncated {
        tracing::warn!(
            kind_id,
            namespace,
            name,
            cap = crate::log_pods::MAX_RESOLVED_PODS,
            "workload pod list truncated"
        );
    }
    Ok(WorkloadPods { rows, truncated })
}

/// Evict a single pod via the policy/v1 Eviction subresource. Unlike a plain
/// DELETE this is graceful *and* PDB-aware: the apiserver refuses with 429 if
/// the eviction would violate a PodDisruptionBudget, which we surface as a
/// `Conflict` carrying the apiserver's own reason rather than a bare kube
/// string. The pod's owning controller (if any) reschedules a replacement;
/// a bare pod is simply gone — same as `kubectl drain` treats it, but here the
/// caller has already chosen the pod explicitly so we don't gate on `force`.
pub async fn evict_pod(client: Client, namespace: &str, name: &str) -> Result<(), FetchError> {
    let pods: Api<Pod> = Api::namespaced(client, namespace);
    let ep = EvictParams::default();
    match pods.evict(name, &ep).await {
        Ok(_) => Ok(()),
        // 404 == the pod is already gone (raced our list, or someone else
        // deleted it). Eviction is idempotent from the operator's intent —
        // the goal is "this pod off the node" and it already is. Report
        // success rather than a scary NotFound.
        Err(kube::Error::Api(status)) if status.code == 404 => Ok(()),
        // 429 TooManyRequests == the eviction would breach a PDB. Surface the
        // apiserver's explanation ("Cannot evict pod as it would violate the
        // pod's disruption budget.") so the operator knows to retry later or
        // scale up first, instead of an opaque error code.
        Err(kube::Error::Api(status)) if status.code == 429 => {
            Err(FetchError::Conflict(status.message))
        }
        Err(e) => Err(FetchError::Kube(e)),
    }
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

#[cfg(test)]
mod batch_tests {
    use super::*;

    fn now() -> chrono::DateTime<chrono::Utc> {
        "2026-08-27T10:00:00Z"
            .parse()
            .expect("valid fixture instant")
    }

    #[test]
    fn derived_names_carry_the_source_name() {
        assert_eq!(
            manual_job_name("nightly-report", now()),
            format!("nightly-report-manual-{}", now().timestamp())
        );
        assert_eq!(
            rerun_job_name("migrate", now()),
            format!("migrate-rerun-{}", now().timestamp())
        );
    }

    /// A long CronJob name must not push the derived name past what the
    /// apiserver accepts — the Job would be rejected at create time, after the
    /// operator already clicked Trigger.
    #[test]
    fn derived_names_stay_within_the_length_budget() {
        let long = "a".repeat(200);
        for name in [manual_job_name(&long, now()), rerun_job_name(&long, now())] {
            assert!(
                name.len() <= MAX_JOB_NAME_LEN,
                "{name} is {} chars",
                name.len()
            );
        }
    }

    /// Truncation must not leave a trailing separator — `foo--manual-1` is
    /// fine but `foo-` as a stem would produce a double dash, and a name
    /// ending in `-` is not a valid DNS-1123 label.
    #[test]
    fn truncation_never_leaves_a_trailing_separator() {
        // Budget lands exactly on the dash of "release-" for this suffix.
        let base = format!("{}-", "r".repeat(60));
        let name = derived_name(&base, "manual-1756288800");
        assert!(!name.contains("--"), "{name}");
        assert!(name.starts_with("rrr"), "{name}");
    }

    /// A name made entirely of separators leaves no stem; the result still has
    /// to be a usable name rather than an empty string or a bare dash.
    #[test]
    fn degenerate_base_falls_back_to_the_suffix() {
        assert_eq!(derived_name("---", "manual-7"), "manual-7");
    }

    /// The whole point of the `Cascade` type: `None` must resolve to
    /// Background, never to "let the apiserver decide" (which orphans Job
    /// pods).
    #[test]
    fn cascade_defaults_to_background() {
        assert_eq!(Cascade::default(), Cascade::Background);
        assert!(matches!(
            kube::api::PropagationPolicy::from(Cascade::default()),
            kube::api::PropagationPolicy::Background
        ));
    }

    #[test]
    fn cascade_round_trips_as_snake_case() {
        assert_eq!(
            serde_json::to_value(Cascade::Foreground).expect("serializable"),
            json!("foreground")
        );
        assert_eq!(
            serde_json::from_value::<Cascade>(json!("orphan")).expect("deserializable"),
            Cascade::Orphan
        );
    }

    fn job_with_owner(name: &str, uid: &str, controller: bool, start: &str) -> Job {
        serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": name,
                "namespace": "default",
                "ownerReferences": [{
                    "apiVersion": "batch/v1",
                    "kind": "CronJob",
                    "name": "nightly",
                    "uid": uid,
                    "controller": controller,
                }],
            },
            "spec": { "completions": 1 },
            "status": { "startTime": start, "succeeded": 1, "completionTime": start },
        }))
        .expect("valid Job fixture")
    }

    /// History sorts newest-first on start time. A stable order matters more
    /// than it looks: the UI shows a fixed-height list, so a wrong sort hides
    /// the run the operator came to look at.
    #[test]
    fn history_sort_key_orders_newest_first() {
        let old = job_with_owner("a", "u", true, "2026-08-01T00:00:00Z");
        let new = job_with_owner("b", "u", true, "2026-08-27T00:00:00Z");
        let mut jobs = [&old, &new];
        jobs.sort_by_key(|j| std::cmp::Reverse(job_sort_key(j)));
        assert_eq!(jobs[0].metadata.name.as_deref(), Some("b"));
    }

    /// A Job with no status at all still has to sort — the CronJob controller
    /// creates the object before it sets `startTime`, so a freshly triggered
    /// run passes through this path.
    #[test]
    fn history_sort_key_falls_back_to_creation_timestamp() {
        let job: Job = serde_json::from_value(json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "fresh", "creationTimestamp": "2026-08-27T09:00:00Z" },
            "spec": {},
        }))
        .expect("valid Job fixture");
        assert!(job_sort_key(&job).is_some());
    }
}
