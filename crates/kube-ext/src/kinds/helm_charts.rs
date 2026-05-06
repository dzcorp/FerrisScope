//! Helm charts catalog. Two sources, both surfaced through one synthetic
//! kind:
//!
//!   * `cluster` — charts already deployed somewhere in this cluster
//!     (deduped from `helm_releases`' Secret watch by `(name, version)`).
//!     Install path: extract the chart from one of the existing release
//!     secrets to a tempdir, then `helm install`.
//!   * `<repo>` — charts available from the operator's locally-configured
//!     `helm repo list` (loaded once per subscribe via `helm search repo`).
//!     Install path: `helm install <release> <repo>/<chart> --version <v>`
//!     directly — helm pulls the chart from its own cache.
//!
//! The synthetic uid encodes all three components: source · name ·
//! version. The detail + install Tauri commands switch on `source` to
//! pick the right backend path.

use serde_json::{json, Value};

use crate::fetch::HelmRepoChart;
use crate::kinds::helm_releases::Release;
use crate::registry::{Category, ColumnDef, ColumnKind, ResourceKind};

/// Stable id used by the watcher to broadcast one row per logical chart.
///
/// `source` is either [`crate::fetch::HELM_CLUSTER_SOURCE`] (`"cluster"`)
/// for in-cluster charts or a repo name (e.g. `"bitnami"`) for
/// `helm repo list`-sourced charts.
pub fn synthetic_uid(source: &str, chart_name: &str, chart_version: &str) -> String {
    format!("helm:chart:{source}:{chart_name}:{chart_version}")
}

/// Columns: Name · Version · App Version · Repo · Description · Used by.
pub fn meta() -> ResourceKind {
    ResourceKind {
        id: "helm_charts",
        // Cluster-scoped synthetic kind — repo charts aren't even
        // cluster-bound at all; in-cluster charts come from many
        // namespaces' worth of releases. No single namespace fits.
        group: "",
        version: "v1",
        kind: "HelmChart",
        plural: "secrets",
        namespaced: false,
        category: Category::Apps,
        columns: vec![
            ColumnDef {
                id: "name",
                header: "Name",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "version",
                header: "Version",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "app_version",
                header: "App Version",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "repo",
                header: "Repo",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "description",
                header: "Description",
                kind: Some(ColumnKind::Text),
            },
            ColumnDef {
                id: "used_by",
                header: "Used By",
                kind: Some(ColumnKind::Number),
            },
        ],
    }
}

/// Project a chart row from a sample release plus the count of releases
/// using this `(name, version)`. Source is always `"cluster"` for these.
pub fn project_cluster_row(sample: &Release, used_by: usize) -> Value {
    json!({
        "name": sample.chart_meta_str("name").unwrap_or_else(|| "—".to_owned()),
        "version": sample.chart_meta_str("version").unwrap_or_else(|| "—".to_owned()),
        "app_version": sample.chart_meta_str("appVersion"),
        "repo": "in-cluster",
        "description": sample.chart_meta_str("description"),
        "used_by": used_by,
    })
}

/// Project a chart row from a `helm search repo` entry.
pub fn project_repo_row(rc: &HelmRepoChart) -> Value {
    json!({
        "name": rc.name.clone(),
        "version": rc.version.clone(),
        "app_version": rc.app_version.clone(),
        "repo": rc.repo.clone(),
        "description": rc.description.clone(),
        "used_by": 0,
    })
}
