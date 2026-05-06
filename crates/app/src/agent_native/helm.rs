//! `fs_helm_list`, `fs_helm_release_get`, `fs_helm_history` — read-only views
//! over installed Helm releases.
//!
//! Helm releases are stored as Secrets of type `helm.sh/release.v1` in the
//! release's namespace. Listing skips over non-helm secrets via the
//! `type=…` field selector so this stays cheap on big clusters.

use std::collections::BTreeMap;
use std::path::PathBuf;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_core::kubeconfig;
use ferrisscope_kube_ext::get_helm_release_detail;
use ferrisscope_kube_ext::kinds::helm_releases::{decode_release, Release, HELM_SECRET_TYPE};
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct ListArgs {
    /// Empty / omitted = cluster-wide.
    #[serde(default)]
    namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GetArgs {
    namespace: String,
    name: String,
}

pub(crate) struct HelmList {
    app: AppHandle,
    cluster_id: String,
}

impl HelmList {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for HelmList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_list".to_string(),
            description:
                "List installed Helm releases. Returns one row per logical release (latest \
                revision per namespace+name) with status, chart, app version, and last-deployed \
                timestamp. Pass `namespace` to scope; omit for cluster-wide."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string", "description": "Optional namespace; omit for cluster-wide." }
                },
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: ListArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let api: Api<Secret> = match a.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
            _ => Api::all(client),
        };
        let lp = ListParams::default().fields(&format!("type={HELM_SECRET_TYPE}"));
        let list = api.list(&lp).await.map_err(kube_err)?;

        // Dedupe to one entry per (namespace, name), keeping the highest
        // revision. The revision lives in the parsed payload, not in the
        // secret name, so we have to decode every entry.
        let mut latest: BTreeMap<(String, String), Release> = BTreeMap::new();
        for sec in list.items {
            let rel = match decode_release(&sec) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let key = (rel.namespace.clone().unwrap_or_default(), rel.name.clone());
            match latest.get(&key) {
                Some(existing) if existing.version >= rel.version => {}
                _ => {
                    latest.insert(key, rel);
                }
            }
        }

        let releases: Vec<Value> = latest
            .into_values()
            .map(|r| {
                json!({
                    "name": r.name.clone(),
                    "namespace": r.namespace.clone().unwrap_or_default(),
                    "revision": r.version,
                    "status": r.info.status.clone(),
                    "chart": r.chart_meta_str("name"),
                    "chart_version": r.chart_meta_str("version"),
                    "app_version": r.chart_meta_str("appVersion"),
                    "last_deployed": r.info.last_deployed.clone(),
                    "description": r.info.description.clone(),
                })
            })
            .collect();
        Ok(json!({ "count": releases.len(), "releases": releases }))
    }
}

pub(crate) struct HelmReleaseGet {
    app: AppHandle,
    cluster_id: String,
}

impl HelmReleaseGet {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for HelmReleaseGet {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_release_get".to_string(),
            description:
                "Detail for one Helm release: latest revision metadata, current status, chart \
                info, user-supplied values, the rendered manifest, and the per-revision history. \
                Use this when the agent needs to reason about what a release deployed or whether \
                an upgrade rolled forward cleanly."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: GetArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        get_helm_release_detail(entry.cluster.client(), &a.namespace, &a.name)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))
    }
}

pub(crate) struct HelmHistory {
    app: AppHandle,
    cluster_id: String,
}

impl HelmHistory {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for HelmHistory {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_history".to_string(),
            description:
                "Per-revision history for one Helm release. Lighter than `fs_helm_release_get` \
                when you only need the upgrade timeline (revision, status, last-deployed, \
                chart/app version)."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: GetArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let api: Api<Secret> = Api::namespaced(client, &a.namespace);
        let lp = ListParams::default().labels(&format!("owner=helm,name={}", a.name));
        let list = api.list(&lp).await.map_err(kube_err)?;
        let mut releases: Vec<Release> = list
            .items
            .iter()
            .filter_map(|s| decode_release(s).ok())
            .collect();
        if releases.is_empty() {
            return Err(NativeToolError::msg(format!(
                "no helm release secrets found for {}/{}",
                a.namespace, a.name
            )));
        }
        releases.sort_by(|a, b| b.version.cmp(&a.version));
        let history: Vec<Value> = releases
            .iter()
            .map(|r| {
                json!({
                    "revision": r.version,
                    "status": r.info.status.clone(),
                    "last_deployed": r.info.last_deployed.clone(),
                    "description": r.info.description.clone(),
                    "chart": r.chart_meta_str("name"),
                    "chart_version": r.chart_meta_str("version"),
                    "app_version": r.chart_meta_str("appVersion"),
                })
            })
            .collect();

        Ok(json!({
            "namespace": a.namespace,
            "name": a.name,
            "history": history,
        }))
    }
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

// ─── fs_helm_install ────────────────────────────────────────────────────────
//
// Shells out to the operator's `helm` binary (same approach as the existing
// install/uninstall paths in `kube-ext`). We use `helm upgrade --install`
// so the tool is idempotent — running it twice with the same chart + values
// upgrades cleanly instead of failing on "release already exists". Chart
// resolution is whatever helm itself supports: `<repo>/<chart>` for repo
// charts, `oci://<registry>/<chart>` for OCI, an absolute path for local
// chart dirs / .tgz files.

#[derive(Debug, Deserialize)]
struct InstallArgs {
    /// Chart reference. `<repo>/<chart>`, `oci://...`, or local path.
    chart: String,
    /// Optional explicit version. helm picks latest when omitted.
    #[serde(default)]
    chart_version: Option<String>,
    /// Release name. Required — helm needs one for `upgrade --install`.
    name: String,
    namespace: String,
    /// Free-form values object — encoded to YAML and passed via `-f`.
    #[serde(default)]
    values: Option<Value>,
    /// `--create-namespace`. Defaults to true so missing namespaces don't
    /// surprise the agent with an "namespace not found" failure.
    #[serde(default = "true_default")]
    create_namespace: bool,
    /// `--wait`. Operator-facing tools usually want to know the release
    /// settled before reporting back; default true.
    #[serde(default = "true_default")]
    wait: bool,
    /// `--timeout` for `--wait`. Default 5m.
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

fn true_default() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct UninstallArgs {
    name: String,
    namespace: String,
}

pub(crate) struct HelmInstall {
    app: AppHandle,
    cluster_id: String,
}

impl HelmInstall {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for HelmInstall {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_install".to_string(),
            description: "Install or upgrade a Helm release (uses `helm upgrade --install` so \
                repeat calls with the same args are idempotent). Chart can be `<repo>/<chart>` \
                (e.g. `bitnami/redis`), `oci://<registry>/<chart>`, or a local path. `values` is \
                a free-form object — passed to helm as `-f values.yaml`. Defaults: \
                `create_namespace=true`, `wait=true`, `timeout=5m`. Requires the `helm` CLI on \
                the operator's `$PATH`."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "chart": { "type": "string", "description": "e.g. `bitnami/redis`, `oci://ghcr.io/foo/bar`, `./chart-dir`." },
                    "chart_version": { "type": "string" },
                    "name": { "type": "string", "description": "Release name (must be unique within the namespace)." },
                    "namespace": { "type": "string" },
                    "values": { "type": "object", "description": "Helm values; emitted as YAML via `-f`." },
                    "create_namespace": { "type": "boolean", "default": true },
                    "wait": { "type": "boolean", "default": true },
                    "timeout_seconds": { "type": "integer", "minimum": 30 }
                },
                "required": ["chart", "name", "namespace"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn timeout(&self) -> Option<std::time::Duration> {
        // Allow up to 10 minutes — install --wait can legitimately take
        // a long time for charts that bring up databases / migrations.
        Some(std::time::Duration::from_secs(600))
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: InstallArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        check_helm_available()?;
        let (context_name, kubeconfig_path) =
            resolve_kube_target(&self.app, &self.cluster_id).await;

        // Stage values.yaml in a tempdir so we can pass `-f` even when the
        // values are large. Empty values still go through the same path —
        // helm tolerates an empty file.
        let tmp = tempfile::Builder::new()
            .prefix("ferrisscope-helm-")
            .tempdir()
            .map_err(|e| NativeToolError::msg(format!("tempdir: {e}")))?;
        let values_path = tmp.path().join("values.yaml");
        let values_yaml = match &a.values {
            Some(v) => serde_yaml::to_string(v)
                .map_err(|e| NativeToolError::msg(format!("encode values: {e}")))?,
            None => String::new(),
        };
        std::fs::write(&values_path, &values_yaml)
            .map_err(|e| NativeToolError::msg(format!("write values: {e}")))?;

        let mut cmd = std::process::Command::new("helm");
        cmd.arg("upgrade")
            .arg(&a.name)
            .arg(&a.chart)
            .arg("--install")
            .arg("--namespace")
            .arg(&a.namespace)
            .arg("--kube-context")
            .arg(&context_name)
            .arg("-f")
            .arg(&values_path)
            .arg("--output")
            .arg("json");
        if a.create_namespace {
            cmd.arg("--create-namespace");
        }
        if a.wait {
            cmd.arg("--wait");
        }
        if let Some(secs) = a.timeout_seconds {
            cmd.arg("--timeout").arg(format!("{secs}s"));
        }
        if let Some(v) = &a.chart_version {
            cmd.arg("--version").arg(v);
        }
        if let Some(p) = &kubeconfig_path {
            cmd.arg("--kubeconfig").arg(p);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let output = tokio::task::spawn_blocking(move || cmd.output())
            .await
            .map_err(|e| NativeToolError::msg(format!("join: {e}")))?
            .map_err(|e| NativeToolError::msg(format!("spawn helm: {e}")))?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        if !output.status.success() {
            return Ok(json!({
                "ok": false,
                "release": a.name,
                "namespace": a.namespace,
                "exit_status": output.status.to_string(),
                "stderr": stderr,
                "stdout": stdout,
            }));
        }
        // helm --output=json returns the same shape as `helm get all`.
        // Project the headline fields so the LLM doesn't have to wade through
        // the whole rendered manifest; `helm_stdout` carries the raw payload
        // for follow-up inspection if needed.
        let parsed: Option<Value> = serde_json::from_str(&stdout).ok();
        let revision = parsed
            .as_ref()
            .and_then(|v| v.get("version"))
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let status = parsed
            .as_ref()
            .and_then(|v| v.get("info"))
            .and_then(|i| i.get("status"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(json!({
            "ok": true,
            "release": a.name,
            "namespace": a.namespace,
            "chart": a.chart,
            "chart_version": a.chart_version,
            "revision": revision,
            "status": status,
            "helm_stdout": stdout,
        }))
    }
}

// ─── fs_helm_uninstall ──────────────────────────────────────────────────────

pub(crate) struct HelmUninstall {
    app: AppHandle,
    cluster_id: String,
}

impl HelmUninstall {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for HelmUninstall {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_uninstall".to_string(),
            description: "Uninstall a Helm release. Removes both the rendered Kubernetes \
                resources and the release-tracking secrets, in helm's correct order, with \
                pre/post-delete hooks. Going through helm — vs. deleting resources directly — \
                is the only way to clean up a release without leaking workloads."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Release name." },
                    "namespace": { "type": "string" }
                },
                "required": ["name", "namespace"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs(300))
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: UninstallArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        check_helm_available()?;
        let (context_name, kubeconfig_path) =
            resolve_kube_target(&self.app, &self.cluster_id).await;

        ferrisscope_kube_ext::helm_uninstall(
            &context_name,
            kubeconfig_path.as_deref(),
            &a.namespace,
            &a.name,
        )
        .await
        .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(json!({
            "ok": true,
            "release": a.name,
            "namespace": a.namespace,
            "uninstalled": true,
        }))
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn check_helm_available() -> Result<(), NativeToolError> {
    if ferrisscope_kube_ext::helm_available() {
        Ok(())
    } else {
        Err(NativeToolError::msg(
            "helm CLI not found on $PATH — install helm to use fs_helm_install / fs_helm_uninstall",
        ))
    }
}

/// Pull (context_name, kubeconfig_path) for the chat's bound cluster.
/// SSH-backed sources have no local kubeconfig path — helm just gets
/// `--kube-context` and trusts the operator's `KUBECONFIG`. Path is `None`
/// for those.
async fn resolve_kube_target(app: &AppHandle, cluster_id: &str) -> (String, Option<PathBuf>) {
    let context_name = kubeconfig::context_name_from_id(cluster_id).to_owned();
    let app_state = app.state::<AppState>();
    let path = {
        let sources = app_state.sources.lock().await;
        kubeconfig::resolve_path_for(cluster_id, &sources)
    };
    (context_name, path)
}
