//! Helm releases — synthetic kind backed by Secrets of type
//! `helm.sh/release.v1`. One row per logical release (latest revision per
//! `(namespace, name)`); previous revisions surface in the detail panel as
//! a History section.
//!
//! Wire format (Helm 3): the secret carries `data.release` =
//! `base64(gzip(base64(json)))` — a release object is double-encoded. We
//! decode both layers, parse the relevant fields, and project a flat row.
//! Anything we don't recognise on the JSON side falls through to `Null` so
//! shape drift between Helm releases doesn't crash the watcher.
//!
//! See <https://github.com/helm/helm/blob/main/pkg/storage/driver/secrets.go>
//! for the storage driver shape.
//!
//! Upgrade path: SSA on the secret itself is wrong (templates wouldn't
//! re-render). Instead we extract the chart embedded in the release secret
//! to a temp dir and shell out to the `helm` CLI — see
//! [`extract_chart_to_dir`] and [`crate::fetch::helm_upgrade`].

use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::Secret;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::registry::{Category, ColumnDef, ColumnKind, ResourceKind};

/// Helm release secret type — used both for the watcher field selector and
/// to skip non-helm secrets if they slip through.
pub const HELM_SECRET_TYPE: &str = "helm.sh/release.v1";

/// Stable id used by the watcher to broadcast one row per logical release.
/// Synthetic — Helm secrets each have their own real `metadata.uid`, but the
/// frontend dedupes on the row uid and we want one row per `(ns, name)`.
pub fn synthetic_uid(namespace: &str, name: &str) -> String {
    format!("helm:{namespace}:{name}")
}

/// Columns mirror `helm list -A`.
pub fn meta() -> ResourceKind {
    ResourceKind {
        id: "helm_releases",
        // Synthetic — kept consistent with what the apiserver would say
        // about the underlying objects (Secrets, core/v1) so the YAML tab
        // and other generic paths can resolve the right resource.
        group: "",
        version: "v1",
        kind: "HelmRelease",
        plural: "secrets",
        namespaced: true,
        category: Category::Apps,
        columns: vec![
            ColumnDef {
                id: "name",
                header: "Name",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "namespace",
                header: "Namespace",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "revision",
                header: "Revision",
                kind: Some(ColumnKind::Number),
            },
            ColumnDef {
                id: "status",
                header: "Status",
                kind: Some(ColumnKind::Phase),
            },
            ColumnDef {
                id: "chart",
                header: "Chart",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "app_version",
                header: "App Version",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "updated",
                header: "Updated",
                kind: Some(ColumnKind::Age),
            },
        ],
    }
}

/// Parsed shape of the JSON payload we lift out of `data.release`. Helm's
/// release struct has many more fields — only the ones the table + detail
/// panel render are pulled in. The chart sub-tree is kept as raw `Value`
/// for round-trip fidelity (so `extract_chart_to_dir` can re-emit a
/// `Chart.yaml` that doesn't silently drop fields like `type: library` or
/// `dependencies`).
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub name: String,
    pub namespace: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub info: ReleaseInfo,
    /// Full chart object (metadata + templates + files + values + schema).
    /// Raw because we need to serialize it back to disk for `helm upgrade`,
    /// and re-typing every Helm chart field would lose round-trip fidelity.
    /// Use [`Release::chart_meta_str`] / [`Release::chart_meta_array`] for
    /// typed access in projections.
    #[serde(default)]
    pub chart: Option<Value>,
    /// Operator-supplied values from the last install/upgrade.
    #[serde(default)]
    pub config: Option<Value>,
    /// Rendered Kubernetes manifest YAML.
    #[serde(default)]
    pub manifest: Option<String>,
    /// Per-hook objects (pre-install, post-upgrade, …).
    #[serde(default)]
    pub hooks: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReleaseInfo {
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    pub deleted: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub notes: Option<String>,
}

impl Release {
    fn chart_metadata(&self) -> Option<&Value> {
        self.chart.as_ref().and_then(|c| c.get("metadata"))
    }
    /// Pull a string field out of `chart.metadata`. Returns `None` if the
    /// field is missing or not a string.
    pub fn chart_meta_str(&self, key: &str) -> Option<String> {
        self.chart_metadata()
            .and_then(|m| m.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    }
    /// Pull an array-of-strings field out of `chart.metadata`. Empty when
    /// missing or shape-mismatched.
    pub fn chart_meta_array(&self, key: &str) -> Vec<String> {
        self.chart_metadata()
            .and_then(|m| m.get(key))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
    /// Default values shipped with the chart (`Chart`'s `values` field).
    pub fn chart_default_values(&self) -> Option<Value> {
        self.chart.as_ref().and_then(|c| c.get("values").cloned())
    }
    /// `<name>-<version>` label, or just `<name>`, or "—".
    fn chart_label(&self) -> String {
        match (self.chart_meta_str("name"), self.chart_meta_str("version")) {
            (Some(n), Some(v)) => format!("{n}-{v}"),
            (Some(n), None) => n,
            _ => "—".to_owned(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("secret is missing data.release")]
    MissingRelease,
    #[error("data.release is not utf8")]
    NotUtf8,
    #[error("base64 decode failed: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("gzip decode failed: {0}")]
    Gzip(std::io::Error),
    #[error("json decode failed: {0}")]
    Json(#[from] serde_json::Error),
}

/// Decode a Helm release secret into the parsed `Release` payload.
///
/// Helm 3 stores: `data.release` is base64(gzip(base64(json))). The outer
/// base64 is k8s's secret encoding (kube-rs already strips it for us by
/// exposing `ByteString` raw bytes), the inner base64 is Helm's, and gzip
/// sits between. So our pipeline is: bytes → utf8 → base64-decode → gunzip
/// → json.
pub fn decode_release(sec: &Secret) -> Result<Release, DecodeError> {
    let bytes = sec
        .data
        .as_ref()
        .and_then(|m| m.get("release"))
        .ok_or(DecodeError::MissingRelease)?;
    let helm_b64 = std::str::from_utf8(&bytes.0).map_err(|_| DecodeError::NotUtf8)?;
    let gzipped = base64::engine::general_purpose::STANDARD.decode(helm_b64.as_bytes())?;
    let mut gz = GzDecoder::new(&gzipped[..]);
    let mut json_bytes = Vec::with_capacity(gzipped.len() * 4);
    gz.read_to_end(&mut json_bytes).map_err(DecodeError::Gzip)?;
    let release: Release = serde_json::from_slice(&json_bytes)?;
    Ok(release)
}

/// Project a release into the table-row shape declared by [`meta`].
pub fn project_row(rel: &Release) -> Value {
    json!({
        "name": rel.name.clone(),
        "namespace": rel.namespace.clone().unwrap_or_default(),
        "revision": rel.version,
        "status": rel.info.status.clone().unwrap_or_else(|| "unknown".to_owned()),
        "chart": rel.chart_label(),
        "app_version": rel.chart_meta_str("appVersion"),
        "updated": rel.info.last_deployed.clone(),
    })
}

/// Detail projection — what the right-side panel renders. Includes every
/// revision currently present as `history[]`, sorted newest-first.
/// `helm_available` reflects whether the host has a usable `helm` CLI on
/// PATH; the frontend uses it to gate the upgrade-edit affordance.
pub fn project_detail(latest: &Release, history: &[Release], helm_available: bool) -> Value {
    let history_rows: Vec<Value> = history
        .iter()
        .map(|r| {
            json!({
                "revision": r.version,
                "status": r.info.status.clone(),
                "updated": r.info.last_deployed.clone(),
                "description": r.info.description.clone(),
                "chart": r.chart_meta_str("name"),
                "chart_version": r.chart_meta_str("version"),
                "app_version": r.chart_meta_str("appVersion"),
            })
        })
        .collect();

    json!({
        "name": latest.name.clone(),
        "namespace": latest.namespace.clone().unwrap_or_default(),
        "revision": latest.version,
        "status": latest.info.status.clone(),
        "description": latest.info.description.clone(),
        "first_deployed": latest.info.first_deployed.clone(),
        "last_deployed": latest.info.last_deployed.clone(),
        "deleted": latest.info.deleted.clone(),
        "notes": latest.info.notes.clone(),
        "chart": latest.chart_label(),
        "chart_name": latest.chart_meta_str("name"),
        "chart_version": latest.chart_meta_str("version"),
        "app_version": latest.chart_meta_str("appVersion"),
        "chart_description": latest.chart_meta_str("description"),
        "chart_home": latest.chart_meta_str("home"),
        "chart_icon": latest.chart_meta_str("icon"),
        "chart_sources": latest.chart_meta_array("sources"),
        "chart_keywords": latest.chart_meta_array("keywords"),
        "values_user": latest.config.clone(),
        "values_chart_defaults": latest.chart_default_values(),
        "manifest": latest.manifest.clone(),
        "hooks": latest.hooks.clone().unwrap_or_default(),
        "history": history_rows,
        "helm_available": helm_available,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum ChartExtractError {
    #[error("release has no chart payload")]
    MissingChart,
    #[error("release.chart.metadata is missing or not an object")]
    MissingMetadata,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("base64 decode of file `{0}` failed: {1}")]
    Base64(String, base64::DecodeError),
    #[error("file entry missing `name` or `data` fields")]
    BadFileEntry,
}

/// Materialise the chart embedded in this release into `dir` so it can be
/// fed to `helm upgrade <release> <dir> ...`.
///
/// Layout written:
/// - `Chart.yaml` — serialised from `release.chart.metadata`.
/// - `values.yaml` — from `release.chart.values` (chart defaults). Only
///   written when present and non-null.
/// - `templates/<name>` — every entry in `release.chart.templates`.
/// - `files/<name>` — every entry in `release.chart.files` whose path
///   doesn't already start with `templates/`.
/// - `<schema_filename>` — `release.chart.schema` if present (rare).
///
/// **Subcharts are not bundled.** Helm 3/4 declare `dependencies []*Chart`
/// as an unexported field on `chart.Chart`, so the JSON in the release
/// secret never carries subchart sources — only `metadata.dependencies`
/// (the declarations from `Chart.yaml`) survives. Charts that declare
/// dependencies need a `helm dependency update` pass against the extracted
/// dir before `helm upgrade`, otherwise helm rejects with "missing in
/// charts/ directory". See [`crate::fetch::helm_dependency_update`].
///
/// Helm chart files store paths relative to the chart root in their
/// `name` field (e.g. `templates/deployment.yaml`, `files/config.json`).
/// We honour that — *no* path normalisation that would re-route a file —
/// but reject paths containing `..` so a malicious chart can't escape
/// the temp dir we just made.
pub fn extract_chart_to_dir(release: &Release, dir: &Path) -> Result<(), ChartExtractError> {
    let chart = release
        .chart
        .as_ref()
        .ok_or(ChartExtractError::MissingChart)?;
    let metadata = chart
        .get("metadata")
        .filter(|v| v.is_object())
        .ok_or(ChartExtractError::MissingMetadata)?;

    // Chart.yaml. We re-emit YAML from the parsed JSON value to keep all
    // metadata fields the chart originally declared (type, dependencies,
    // annotations, kubeVersion, …). serde_yaml handles JSON Values
    // transparently.
    fs::create_dir_all(dir)?;
    let chart_yaml = serde_yaml::to_string(metadata)?;
    fs::write(dir.join("Chart.yaml"), chart_yaml)?;

    // Default values.yaml from chart.values. Kept separate from the
    // operator-supplied values that the caller will pass via `-f`.
    if let Some(values) = chart.get("values").filter(|v| !v.is_null()) {
        let values_yaml = serde_yaml::to_string(values)?;
        fs::write(dir.join("values.yaml"), values_yaml)?;
    }

    // JSON schema (optional). Stored as base64 in the release; Helm
    // expects `values.schema.json` in the chart root.
    if let Some(schema_b64) = chart.get("schema").and_then(|v| v.as_str()) {
        let schema = base64::engine::general_purpose::STANDARD
            .decode(schema_b64)
            .map_err(|e| ChartExtractError::Base64("values.schema.json".to_owned(), e))?;
        fs::write(dir.join("values.schema.json"), schema)?;
    }

    write_chart_files(chart.get("templates"), dir)?;
    write_chart_files(chart.get("files"), dir)?;

    Ok(())
}

/// Return true if the parsed chart metadata declares any dependencies.
/// Used by the upgrade/install path to decide whether a `helm dependency
/// update` pass is needed before invoking `helm upgrade` (subcharts are
/// not bundled in the release secret — see [`extract_chart_to_dir`]).
pub fn chart_has_dependencies(release: &Release) -> bool {
    release
        .chart
        .as_ref()
        .and_then(|c| c.get("metadata"))
        .and_then(|m| m.get("dependencies"))
        .and_then(|d| d.as_array())
        .is_some_and(|arr| !arr.is_empty())
}

fn write_chart_files(list: Option<&Value>, root: &Path) -> Result<(), ChartExtractError> {
    let Some(arr) = list.and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for entry in arr {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or(ChartExtractError::BadFileEntry)?;
        let data_b64 = entry
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or(ChartExtractError::BadFileEntry)?;
        // Reject paths that would escape the chart root. Helm itself
        // enforces this on chart load; we mirror that defensively.
        if name
            .split('/')
            .any(|seg| seg == ".." || seg.is_empty() && !name.is_empty())
        {
            return Err(ChartExtractError::BadFileEntry);
        }
        let target = root.join(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| ChartExtractError::Base64(name.to_owned(), e))?;
        fs::write(target, bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release_with_chart(chart: Value) -> Release {
        Release {
            name: "test".to_owned(),
            namespace: Some("ns".to_owned()),
            version: 1,
            info: ReleaseInfo::default(),
            chart: Some(chart),
            config: None,
            manifest: None,
            hooks: None,
        }
    }

    /// Regression: charts that declare `dependencies:` in `Chart.yaml`
    /// (e.g. every Bitnami chart depending on `common`) need a `helm
    /// dependency update` pass before `helm upgrade` because the release
    /// secret never carries subchart sources. `chart_has_dependencies`
    /// is what gates that pass — verify it sees the metadata array.
    #[test]
    fn chart_has_dependencies_detects_metadata_array() {
        let with = release_with_chart(json!({
            "metadata": {
                "name": "mariadb",
                "version": "11.5.7",
                "dependencies": [{ "name": "common", "version": "2.x.x" }],
            },
        }));
        assert!(chart_has_dependencies(&with));

        let empty = release_with_chart(json!({
            "metadata": { "name": "mariadb", "dependencies": [] },
        }));
        assert!(!chart_has_dependencies(&empty));

        let none = release_with_chart(json!({
            "metadata": { "name": "plain" },
        }));
        assert!(!chart_has_dependencies(&none));
    }

    #[test]
    fn extract_writes_chart_yaml_and_values() {
        let release = release_with_chart(json!({
            "metadata": { "name": "plain", "version": "1.0.0" },
            "values": { "key": "value" },
        }));
        let tmp = tempfile::tempdir().expect("tempdir");
        extract_chart_to_dir(&release, tmp.path()).expect("extract");
        assert!(tmp.path().join("Chart.yaml").exists());
        assert!(tmp.path().join("values.yaml").exists());
        assert!(!tmp.path().join("charts").exists());
    }
}
