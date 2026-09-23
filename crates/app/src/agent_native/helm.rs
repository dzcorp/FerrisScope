//! Helm tools: `fs_helm_list` / `fs_helm_release_get` / `fs_helm_history`
//! (read) and `fs_helm_install` / `fs_helm_uninstall` / `fs_helm_rollback`
//! (write, via the `helm` CLI).
//!
//! Releases are Secrets of type `helm.sh/release.v1`; the `type=` field
//! selector keeps listing cheap. Mutations resolve the kubeconfig exactly
//! like the UI commands (SSH clusters get a tunnelled scratch file).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_kube_ext::helm::{self as helm_cli, KubeTarget, UpgradeSpec};
use ferrisscope_kube_ext::kinds::helm_releases::{
    decode_release_summary, ReleaseKey, ReleaseSummary, HELM_SECRET_TYPE,
};
use ferrisscope_kube_ext::{get_helm_release_detail, HelmRollbackResult};
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::commands::{cleanup_scratch_paths, resolve_kubeconfig_for};
use crate::state::AppState;

const LIST_PAGE: u32 = 25;
const INSTALL_TOOL_TIMEOUT: Duration = Duration::from_mins(10);
/// Largest `--timeout` handed to helm; with the kill margin it stays
/// under [`INSTALL_TOOL_TIMEOUT`].
const MAX_HELM_TIMEOUT_SECS: u64 = 480;
const MUTATE_TOOL_TIMEOUT: Duration = Duration::from_mins(6);

#[derive(Debug, Deserialize)]
struct ListArgs {
    #[serde(default)]
    namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GetArgs {
    namespace: String,
    name: String,
}

fn invalid(e: impl std::fmt::Display) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}

/// Latest revision per `(namespace, name)`, first-seen wins on ties.
fn latest_per_release(summaries: Vec<ReleaseSummary>) -> BTreeMap<ReleaseKey, ReleaseSummary> {
    let mut latest: BTreeMap<ReleaseKey, ReleaseSummary> = BTreeMap::new();
    for rel in summaries {
        match latest.get(&rel.key()) {
            Some(existing) if existing.version >= rel.version => {}
            _ => {
                latest.insert(rel.key(), rel);
            }
        }
    }
    latest
}

async fn list_summaries(
    api: &Api<Secret>,
    mut lp: ListParams,
) -> Result<Vec<ReleaseSummary>, NativeToolError> {
    lp = lp.limit(LIST_PAGE);
    let mut out = Vec::new();
    loop {
        let page = api.list(&lp).await.map_err(kube_err)?;
        out.extend(
            page.items
                .iter()
                .filter_map(|s| decode_release_summary(s).ok()),
        );
        match page.metadata.continue_ {
            Some(token) if !token.is_empty() => lp = lp.continue_token(&token),
            _ => break,
        }
    }
    Ok(out)
}

fn history_row(r: &ReleaseSummary) -> Value {
    json!({
        "revision": r.version,
        "status": r.info.status.clone(),
        "last_deployed": r.info.last_deployed.clone(),
        "description": r.info.description.clone(),
        "chart": r.chart_meta_str("name"),
        "chart_version": r.chart_meta_str("version"),
        "app_version": r.chart_meta_str("appVersion"),
    })
}

pub(crate) struct HelmList {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl HelmList {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
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
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let api: Api<Secret> = match a.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
            _ => Api::all(client),
        };
        let lp = ListParams::default().fields(&format!("type={HELM_SECRET_TYPE}"));
        let releases: Vec<Value> = latest_per_release(list_summaries(&api, lp).await?)
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
    cluster: ChatClusterRef,
}

impl HelmReleaseGet {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for HelmReleaseGet {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_release_get".to_string(),
            description:
                "Detail for one Helm release: latest revision metadata, current status, chart \
                info, user-supplied values, the rendered manifest, managed resources, hooks, and \
                the per-revision history. Use this when the agent needs to reason about what a \
                release deployed or whether an upgrade rolled forward cleanly."
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
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        get_helm_release_detail(entry.cluster.client(), &a.namespace, &a.name)
            .await
            .map_err(invalid)
    }
}

pub(crate) struct HelmHistory {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl HelmHistory {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for HelmHistory {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_history".to_string(),
            description: "Per-revision history for one Helm release, newest first. Lighter than \
                `fs_helm_release_get` when you only need the upgrade timeline (revision, status, \
                last-deployed, chart/app version)."
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
        helm_cli::validate_namespace(&a.namespace).map_err(invalid)?;
        helm_cli::validate_release_name(&a.name).map_err(invalid)?;
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;

        let api: Api<Secret> = Api::namespaced(entry.cluster.client(), &a.namespace);
        let lp = ListParams::default().labels(&format!("owner=helm,name={}", a.name));
        let mut releases = list_summaries(&api, lp).await?;
        if releases.is_empty() {
            return Err(NativeToolError::msg(format!(
                "no helm release secrets found for {}/{}",
                a.namespace, a.name
            )));
        }
        releases.sort_by_key(|r| std::cmp::Reverse(r.version));
        let history: Vec<Value> = releases.iter().map(history_row).collect();
        Ok(json!({
            "namespace": a.namespace,
            "name": a.name,
            "history": history,
        }))
    }
}

/// Kubeconfig + context for helm; deletes an SSH scratch file on drop.
struct ResolvedTarget {
    context: String,
    kubeconfig: PathBuf,
    scratch: Vec<PathBuf>,
}

impl ResolvedTarget {
    fn target(&self) -> KubeTarget<'_> {
        KubeTarget {
            context: &self.context,
            kubeconfig: Some(&self.kubeconfig),
        }
    }
}

impl Drop for ResolvedTarget {
    fn drop(&mut self) {
        cleanup_scratch_paths(&self.scratch);
    }
}

async fn resolve_target(
    app: &AppHandle,
    cluster: &ChatClusterRef,
) -> Result<ResolvedTarget, NativeToolError> {
    let cluster_id = cluster.active().await;
    let state = app.state::<AppState>();
    let (kubeconfig, context, scratch) = resolve_kubeconfig_for(state.inner(), &cluster_id, "helm")
        .await
        .map_err(NativeToolError::msg)?;
    Ok(ResolvedTarget {
        context,
        kubeconfig,
        scratch,
    })
}

fn check_helm_available() -> Result<(), NativeToolError> {
    if helm_cli::helm_available() {
        Ok(())
    } else {
        Err(NativeToolError::msg(
            "helm CLI not found on $PATH — install helm to use the fs_helm_* write tools",
        ))
    }
}

#[derive(Debug, Deserialize)]
struct InstallArgs {
    chart: String,
    #[serde(default)]
    chart_version: Option<String>,
    name: String,
    namespace: String,
    #[serde(default)]
    values: Option<Value>,
    #[serde(default = "true_default")]
    create_namespace: bool,
    #[serde(default = "true_default")]
    wait: bool,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

fn true_default() -> bool {
    true
}

impl InstallArgs {
    fn validate(&self) -> Result<(), NativeToolError> {
        helm_cli::validate_release_name(&self.name).map_err(invalid)?;
        helm_cli::validate_namespace(&self.namespace).map_err(invalid)?;
        helm_cli::validate_chart_ref(&self.chart).map_err(invalid)?;
        if let Some(v) = &self.chart_version {
            helm_cli::validate_version(v).map_err(invalid)?;
        }
        Ok(())
    }

    fn helm_timeout(&self) -> Duration {
        self.timeout_seconds.map_or(helm_cli::HELM_OP_TIMEOUT, |s| {
            Duration::from_secs(s.clamp(30, MAX_HELM_TIMEOUT_SECS))
        })
    }
}

pub(crate) struct HelmInstall {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl HelmInstall {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for HelmInstall {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_install".to_string(),
            description: format!(
                "Install or upgrade a Helm release (`helm upgrade --install`, so repeat calls \
                with the same args are idempotent). Chart can be `<repo>/<chart>` (e.g. \
                `bitnami/redis`), `oci://<registry>/<chart>`, or a local path. `values` is the \
                COMPLETE values object for the release (passed with `--reset-values`): values \
                from a previous revision are not kept, so include everything you need. Defaults: \
                `create_namespace=true`, `wait=true`, `timeout_seconds=240`; `timeout_seconds` \
                is capped at {MAX_HELM_TIMEOUT_SECS}. Requires the `helm` CLI on the operator's \
                `$PATH`."
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "chart": { "type": "string", "description": "e.g. `bitnami/redis`, `oci://ghcr.io/foo/bar`, `./chart-dir`." },
                    "chart_version": { "type": "string" },
                    "name": { "type": "string", "description": "Release name: lowercase DNS name, at most 53 characters." },
                    "namespace": { "type": "string" },
                    "values": { "type": "object", "description": "Complete Helm values; emitted as YAML via `--values`." },
                    "create_namespace": { "type": "boolean", "default": true },
                    "wait": { "type": "boolean", "default": true },
                    "timeout_seconds": { "type": "integer", "minimum": 30, "maximum": MAX_HELM_TIMEOUT_SECS }
                },
                "required": ["chart", "name", "namespace"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn timeout(&self) -> Option<Duration> {
        Some(INSTALL_TOOL_TIMEOUT)
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: InstallArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        a.validate()?;
        check_helm_available()?;
        let target = resolve_target(&self.app, &self.cluster).await?;

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

        let helm_timeout = a.helm_timeout();
        let argv = helm_cli::upgrade_args(
            &UpgradeSpec {
                release: &a.name,
                namespace: &a.namespace,
                chart: a.chart.as_ref(),
                values_file: &values_path,
                version: a.chart_version.as_deref(),
                install: true,
                create_namespace: a.create_namespace,
                reset_values: true,
                wait: a.wait,
                timeout: helm_timeout,
            },
            target.target(),
        );
        let output = helm_cli::run_helm(
            helm_cli::helm_command(&argv),
            helm_cli::kill_deadline_for(helm_timeout),
        )
        .await
        .map_err(invalid)?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            return Ok(json!({
                "ok": false,
                "release": a.name,
                "namespace": a.namespace,
                "exit_status": output.status.to_string(),
                "stderr": String::from_utf8_lossy(&output.stderr),
            }));
        }
        let out = helm_cli::summarize_release_output(&stdout);
        Ok(json!({
            "ok": true,
            "release": a.name,
            "namespace": a.namespace,
            "chart": a.chart,
            "chart_version": a.chart_version,
            "revision": out.revision,
            "status": out.status,
            "summary": out.summary,
        }))
    }
}

#[derive(Debug, Deserialize)]
struct UninstallArgs {
    name: String,
    namespace: String,
}

pub(crate) struct HelmUninstall {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl HelmUninstall {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
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

    fn timeout(&self) -> Option<Duration> {
        Some(MUTATE_TOOL_TIMEOUT)
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: UninstallArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        helm_cli::validate_release_name(&a.name).map_err(invalid)?;
        helm_cli::validate_namespace(&a.namespace).map_err(invalid)?;
        check_helm_available()?;
        let target = resolve_target(&self.app, &self.cluster).await?;
        ferrisscope_kube_ext::helm_uninstall(
            &target.context,
            Some(&target.kubeconfig),
            &a.namespace,
            &a.name,
        )
        .await
        .map_err(invalid)?;
        Ok(json!({
            "ok": true,
            "release": a.name,
            "namespace": a.namespace,
            "uninstalled": true,
        }))
    }
}

#[derive(Debug, Deserialize)]
struct RollbackArgs {
    name: String,
    namespace: String,
    #[serde(default)]
    revision: Option<i64>,
}

pub(crate) struct HelmRollback {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl HelmRollback {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

fn rollback_json(name: &str, namespace: &str, result: HelmRollbackResult) -> Value {
    match result {
        HelmRollbackResult::RolledBack {
            revision,
            elapsed_ms,
            helm_stdout,
        } => json!({
            "ok": true, "release": name, "namespace": namespace,
            "revision": revision, "elapsed_ms": elapsed_ms, "output": helm_stdout,
        }),
        HelmRollbackResult::Failed {
            message,
            helm_stderr,
            elapsed_ms,
        } => json!({
            "ok": false, "release": name, "namespace": namespace,
            "message": message, "stderr": helm_stderr, "elapsed_ms": elapsed_ms,
        }),
        HelmRollbackResult::HelmMissing => json!({
            "ok": false, "release": name, "namespace": namespace,
            "message": "helm CLI not found on $PATH",
        }),
    }
}

#[async_trait]
impl NativeTool for HelmRollback {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_helm_rollback".to_string(),
            description: "Roll a Helm release back to an earlier revision (`helm rollback`). \
                Omit `revision` to go back to the previous one; use `fs_helm_history` to pick a \
                revision. The rollback is recorded as a new revision. Helm waits up to 240s for \
                hooks."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Release name." },
                    "namespace": { "type": "string" },
                    "revision": { "type": "integer", "minimum": 1, "description": "Target revision; omit for the previous revision." }
                },
                "required": ["name", "namespace"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn timeout(&self) -> Option<Duration> {
        Some(MUTATE_TOOL_TIMEOUT)
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: RollbackArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        helm_cli::validate_release_name(&a.name).map_err(invalid)?;
        helm_cli::validate_namespace(&a.namespace).map_err(invalid)?;
        if let Some(r) = a.revision {
            helm_cli::validate_revision(r).map_err(invalid)?;
        }
        check_helm_available()?;
        let cluster_id = self.cluster.active().await;
        let entry = self
            .app
            .state::<AppState>()
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let target = resolve_target(&self.app, &self.cluster).await?;
        let result = ferrisscope_kube_ext::helm_rollback(
            entry.cluster.client(),
            &target.context,
            Some(&target.kubeconfig),
            &a.namespace,
            &a.name,
            a.revision,
        )
        .await
        .map_err(invalid)?;
        Ok(rollback_json(&a.name, &a.namespace, result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_args(v: Value) -> InstallArgs {
        serde_json::from_value(v).expect("args")
    }

    #[test]
    fn install_timeout_is_capped_below_tool_timeout() {
        let base = json!({ "chart": "bitnami/redis", "name": "r", "namespace": "ns" });
        let mut huge = base.clone();
        huge["timeout_seconds"] = json!(100_000);
        let capped = install_args(huge).helm_timeout();
        assert_eq!(capped, Duration::from_secs(MAX_HELM_TIMEOUT_SECS));
        assert!(helm_cli::kill_deadline_for(capped) < INSTALL_TOOL_TIMEOUT);
        assert_eq!(install_args(base).helm_timeout(), helm_cli::HELM_OP_TIMEOUT);
        assert!(helm_cli::HELM_KILL_TIMEOUT < MUTATE_TOOL_TIMEOUT);
    }

    #[test]
    fn install_rejects_flag_injection() {
        for bad in [
            json!({ "chart": "--post-renderer=/bin/sh", "name": "r", "namespace": "ns" }),
            json!({ "chart": "a/b", "name": "--dry-run", "namespace": "ns" }),
            json!({ "chart": "a/b", "name": "r", "namespace": "-n" }),
            json!({ "chart": "a/b", "name": "r", "namespace": "ns", "chart_version": "--devel" }),
        ] {
            assert!(install_args(bad).validate().is_err());
        }
        assert!(install_args(
            json!({ "chart": "oci://ghcr.io/a/b", "name": "r", "namespace": "ns" })
        )
        .validate()
        .is_ok());
    }

    #[test]
    fn list_keeps_latest_revision_per_release() {
        let s = |ns: &str, name: &str, v: i64| -> ReleaseSummary {
            serde_json::from_value(json!({ "name": name, "namespace": ns, "version": v }))
                .expect("summary")
        };
        let latest = latest_per_release(vec![
            s("a", "web", 2),
            s("a", "web", 10),
            s("b", "web", 1),
            s("a", "web", 9),
        ]);
        let got: Vec<(String, String, i64)> = latest
            .into_values()
            .map(|r| (r.namespace.unwrap_or_default(), r.name, r.version))
            .collect();
        assert_eq!(
            got,
            [
                ("a".to_owned(), "web".to_owned(), 10),
                ("b".to_owned(), "web".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn rollback_result_shapes() {
        let ok = rollback_json(
            "r",
            "ns",
            HelmRollbackResult::RolledBack {
                revision: Some(4),
                elapsed_ms: 1,
                helm_stdout: "Rollback was a success!".into(),
            },
        );
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["revision"], 4);
        let failed = rollback_json(
            "r",
            "ns",
            HelmRollbackResult::Failed {
                message: "m".into(),
                helm_stderr: "e".into(),
                elapsed_ms: 1,
            },
        );
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["stderr"], "e");
        assert_eq!(
            rollback_json("r", "ns", HelmRollbackResult::HelmMissing)["ok"],
            false
        );
    }
}
