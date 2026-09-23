//! Helm releases — synthetic kind backed by Secrets of type
//! `helm.sh/release.v1`. One row per logical release (latest revision per
//! `(namespace, name)`); previous revisions surface in the detail panel as
//! a History section.
//!
//! Wire format: `data.release` = base64(gzip(json)) under the Secret's own
//! base64 (which kube-rs strips). Mirrors helm's
//! `pkg/storage/driver/util.go::decodeRelease`, including plain (non-gzip)
//! payloads. Unknown JSON falls through to `Null` so shape drift between
//! Helm versions doesn't crash the watcher.
//!
//! Upgrade path: SSA on the secret itself is wrong (templates wouldn't
//! re-render). We extract the embedded chart to a temp dir and shell out to
//! the `helm` CLI — see [`extract_chart_to_dir`] and
//! [`crate::fetch::helm_upgrade`].

use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::Secret;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use crate::helm::{ChartIdentity, HelmUpdateAvailable};
use crate::registry::{Category, ColumnDef, ColumnKind, ResourceKind};

pub const HELM_SECRET_TYPE: &str = "helm.sh/release.v1";

/// Decompressed JSON ceiling. Real releases are a few MiB at most (the
/// Secret itself is capped at 1 MiB compressed); this stops a gzip bomb.
pub const MAX_RELEASE_JSON_BYTES: u64 = 64 * 1024 * 1024;
const GZIP_MAGIC: [u8; 3] = [0x1f, 0x8b, 0x08];

/// One row per `(ns, name)` — the frontend dedupes on the row uid.
pub fn synthetic_uid(namespace: &str, name: &str) -> String {
    format!("helm:{namespace}:{name}")
}

/// Columns mirror `helm list -A`.
pub fn meta() -> ResourceKind {
    ResourceKind {
        id: "helm_releases",
        // Mirrors the backing Secrets. Generic object paths refuse this id
        // (see `fetch::reject_synthetic_kind`) so it never touches a Secret.
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

/// Full release payload. `chart` stays raw `Value` so
/// [`extract_chart_to_dir`] can re-emit it without dropping fields.
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub name: String,
    pub namespace: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub info: ReleaseInfo,
    #[serde(default)]
    pub chart: Option<Value>,
    #[serde(default)]
    pub config: Option<Value>,
    #[serde(default)]
    pub manifest: Option<String>,
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

#[derive(Debug, Clone, Default, Deserialize)]
struct ChartHead {
    #[serde(default)]
    metadata: Option<Value>,
}

/// Cheap view of a release: serde skips templates, files, values, manifest
/// and hooks while parsing, so nothing large is allocated.
#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseSummary {
    pub name: String,
    pub namespace: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub info: ReleaseInfo,
    #[serde(default)]
    chart: Option<ChartHead>,
}

fn meta_str(meta: Option<&Value>, key: &str) -> Option<String> {
    meta.and_then(|m| m.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn meta_array(meta: Option<&Value>, key: &str) -> Vec<String> {
    meta.and_then(|m| m.get(key))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn chart_label(meta: Option<&Value>) -> String {
    match (meta_str(meta, "name"), meta_str(meta, "version")) {
        (Some(n), Some(v)) => format!("{n}-{v}"),
        (Some(n), None) => n,
        _ => "—".to_owned(),
    }
}

impl Release {
    fn chart_metadata(&self) -> Option<&Value> {
        self.chart.as_ref().and_then(|c| c.get("metadata"))
    }
    pub fn chart_meta_str(&self, key: &str) -> Option<String> {
        meta_str(self.chart_metadata(), key)
    }
    pub fn chart_meta_array(&self, key: &str) -> Vec<String> {
        meta_array(self.chart_metadata(), key)
    }
    pub fn chart_default_values(&self) -> Option<Value> {
        self.chart.as_ref().and_then(|c| c.get("values").cloned())
    }
    pub fn chart_identity(&self) -> ChartIdentity {
        self.chart_metadata()
            .map(ChartIdentity::from_metadata)
            .unwrap_or_default()
    }
    pub fn summary(&self) -> ReleaseSummary {
        ReleaseSummary {
            name: self.name.clone(),
            namespace: self.namespace.clone(),
            version: self.version,
            info: self.info.clone(),
            chart: Some(ChartHead {
                metadata: self.chart_metadata().cloned(),
            }),
        }
    }
}

impl ReleaseSummary {
    fn chart_metadata(&self) -> Option<&Value> {
        self.chart.as_ref().and_then(|c| c.metadata.as_ref())
    }
    pub fn chart_meta_str(&self, key: &str) -> Option<String> {
        meta_str(self.chart_metadata(), key)
    }
    pub fn chart_ref(&self) -> Option<ChartRef> {
        Some(ChartRef {
            name: self.chart_meta_str("name")?,
            version: self.chart_meta_str("version")?,
            app_version: self.chart_meta_str("appVersion"),
            description: self.chart_meta_str("description"),
        })
    }
    pub fn key(&self) -> ReleaseKey {
        (
            self.namespace.clone().unwrap_or_default(),
            self.name.clone(),
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("secret is missing data.release")]
    MissingRelease,
    #[error("base64 decode failed: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("gzip decode failed: {0}")]
    Gzip(std::io::Error),
    #[error("release payload exceeds {} MiB decompressed", MAX_RELEASE_JSON_BYTES >> 20)]
    TooLarge,
    #[error("json decode failed: {0}")]
    Json(#[from] serde_json::Error),
}

/// Helm's inner base64 → optional gunzip (by magic bytes) → JSON bytes,
/// capped at [`MAX_RELEASE_JSON_BYTES`].
pub fn release_json_bytes(helm_b64: &[u8]) -> Result<Vec<u8>, DecodeError> {
    let raw = base64::engine::general_purpose::STANDARD.decode(helm_b64)?;
    if raw.len() > GZIP_MAGIC.len() && raw[..GZIP_MAGIC.len()] == GZIP_MAGIC {
        let cap = MAX_RELEASE_JSON_BYTES as usize;
        let mut out = Vec::with_capacity(raw.len().saturating_mul(4).min(cap));
        GzDecoder::new(&raw[..])
            .take(MAX_RELEASE_JSON_BYTES + 1)
            .read_to_end(&mut out)
            .map_err(DecodeError::Gzip)?;
        if out.len() as u64 > MAX_RELEASE_JSON_BYTES {
            return Err(DecodeError::TooLarge);
        }
        Ok(out)
    } else if raw.len() as u64 > MAX_RELEASE_JSON_BYTES {
        Err(DecodeError::TooLarge)
    } else {
        Ok(raw)
    }
}

fn secret_payload(sec: &Secret) -> Result<Vec<u8>, DecodeError> {
    let bytes = sec
        .data
        .as_ref()
        .and_then(|m| m.get("release"))
        .ok_or(DecodeError::MissingRelease)?;
    release_json_bytes(&bytes.0)
}

/// The Secret's namespace is authoritative for where the release lives.
fn secret_namespace(sec: &Secret, payload: Option<String>) -> Option<String> {
    sec.metadata.namespace.clone().or(payload)
}

pub fn decode_release(sec: &Secret) -> Result<Release, DecodeError> {
    let mut rel: Release = serde_json::from_slice(&secret_payload(sec)?)?;
    rel.namespace = secret_namespace(sec, rel.namespace.take());
    Ok(rel)
}

pub fn decode_release_summary(sec: &Secret) -> Result<ReleaseSummary, DecodeError> {
    let mut rel: ReleaseSummary = serde_json::from_slice(&secret_payload(sec)?)?;
    rel.namespace = secret_namespace(sec, rel.namespace.take());
    Ok(rel)
}

/// Revision number from helm's `version` label, else the
/// `sh.helm.release.v1.<name>.v<N>` secret name. No decode needed.
pub fn secret_revision(sec: &Secret) -> Option<i64> {
    sec.metadata
        .labels
        .as_ref()
        .and_then(|l| l.get("version"))
        .and_then(|v| v.parse().ok())
        .or_else(|| {
            sec.metadata
                .name
                .as_deref()?
                .rsplit_once(".v")?
                .1
                .parse()
                .ok()
        })
}

/// Project a release into the table-row shape declared by [`meta`].
pub fn project_row(rel: &ReleaseSummary) -> Value {
    let meta = rel.chart_metadata();
    json!({
        "name": rel.name.clone(),
        "namespace": rel.namespace.clone().unwrap_or_default(),
        "revision": rel.version,
        "status": rel.info.status.clone().unwrap_or_else(|| "unknown".to_owned()),
        "chart": chart_label(meta),
        "app_version": meta_str(meta, "appVersion"),
        "updated": rel.info.last_deployed.clone(),
    })
}

/// Kinds that are never namespaced, so a manifest doc without
/// `metadata.namespace` isn't defaulted into the release namespace.
const CLUSTER_SCOPED_KINDS: &[&str] = &[
    "Namespace",
    "ClusterRole",
    "ClusterRoleBinding",
    "CustomResourceDefinition",
    "PersistentVolume",
    "StorageClass",
    "PriorityClass",
    "ValidatingWebhookConfiguration",
    "MutatingWebhookConfiguration",
    "APIService",
    "IngressClass",
    "RuntimeClass",
    "CSIDriver",
    "VolumeSnapshotClass",
];

/// Split a multi-document YAML stream on `---` separator lines without a
/// parser, so one malformed document can't hide the rest.
fn yaml_documents(stream: &str) -> impl Iterator<Item = &str> {
    let mut docs = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    for line in stream.split_inclusive('\n') {
        let t = line.trim_end();
        if t == "---" || t.starts_with("--- ") {
            docs.push(&stream[start..offset]);
            start = offset + line.len();
        }
        offset += line.len();
    }
    docs.push(&stream[start..]);
    docs.into_iter().filter(|d| !d.trim().is_empty())
}

#[derive(Deserialize)]
struct DocHead {
    #[serde(rename = "apiVersion", default)]
    api_version: Option<String>,
    kind: String,
    metadata: DocMeta,
}

#[derive(Deserialize)]
struct DocMeta {
    name: String,
    #[serde(default)]
    namespace: Option<String>,
}

fn manifest_object(doc: &str, release_ns: &str, message: Option<&str>) -> Option<Value> {
    let head: DocHead = serde_yaml::from_str(doc).ok()?;
    let kind = head.kind.as_str();
    let name = head.metadata.name.as_str();
    let group = head
        .api_version
        .as_deref()
        .and_then(|a| a.rsplit_once('/'))
        .map_or("", |(g, _)| g);
    let namespace = match head.metadata.namespace.as_deref() {
        Some(ns) if !ns.is_empty() => Some(ns),
        _ if CLUSTER_SCOPED_KINDS.contains(&kind) => None,
        _ => Some(release_ns),
    };
    Some(json!({
        "group": group,
        "kind": kind,
        "namespace": namespace,
        "name": name,
        "local": true,
        "sync": null,
        "health": null,
        "message": message,
        "prune": false,
    }))
}

/// `GitOpsResource`-shaped entries for every object in a rendered manifest.
pub fn manifest_resources(manifest: &str, release_ns: &str) -> Vec<Value> {
    yaml_documents(manifest)
        .filter_map(|d| manifest_object(d, release_ns, None))
        .collect()
}

/// Hook objects, with `"<events> · <last phase>"` in `message`.
pub fn hook_resources(hooks: &[Value], release_ns: &str) -> Vec<Value> {
    hooks
        .iter()
        .flat_map(|h| {
            let events = h
                .get("events")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            let phase = h
                .pointer("/last_run/phase")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty());
            let message = match (events.is_empty(), phase) {
                (false, Some(p)) => Some(format!("{events} · {p}")),
                (false, None) => Some(events),
                (true, Some(p)) => Some(p.to_owned()),
                (true, None) => None,
            };
            let manifest = h.get("manifest").and_then(Value::as_str).unwrap_or("");
            let mut objs: Vec<Value> = yaml_documents(manifest)
                .filter_map(|d| manifest_object(d, release_ns, message.as_deref()))
                .collect();
            if objs.is_empty() {
                if let (Some(kind), Some(name)) = (
                    h.get("kind").and_then(Value::as_str),
                    h.get("name").and_then(Value::as_str),
                ) {
                    let ns = (!CLUSTER_SCOPED_KINDS.contains(&kind)).then_some(release_ns);
                    objs.push(json!({
                        "group": "",
                        "kind": kind,
                        "namespace": ns,
                        "name": name,
                        "local": true,
                        "sync": null,
                        "health": null,
                        "message": message,
                        "prune": false,
                    }));
                }
            }
            objs
        })
        .collect()
}

fn card(
    label: &str,
    status: Option<String>,
    value: Option<String>,
    caption: Option<String>,
    at: Option<String>,
) -> Value {
    json!({ "label": label, "status": status, "value": value, "caption": caption, "at": at })
}

fn release_cards(
    latest: &Release,
    history_len: usize,
    update: Option<&HelmUpdateAvailable>,
) -> Vec<Value> {
    let chart_value = match (
        latest.chart_meta_str("name"),
        latest.chart_meta_str("version"),
    ) {
        (Some(n), Some(v)) => Some(format!("{n}@{v}")),
        (n, _) => n,
    };
    let revisions = if history_len == 1 {
        "1 revision in history".to_owned()
    } else {
        format!("{history_len} revisions in history")
    };
    let mut cards = vec![
        card(
            "Status",
            latest.info.status.clone(),
            None,
            latest.info.description.clone(),
            None,
        ),
        card(
            "Revision",
            None,
            Some(format!("#{}", latest.version)),
            Some(revisions),
            latest.info.last_deployed.clone(),
        ),
        card(
            "Chart",
            None,
            chart_value,
            latest
                .chart_meta_str("appVersion")
                .map(|a| format!("app {a}")),
            None,
        ),
    ];
    if let Some(u) = update {
        cards.push(card(
            "Update",
            None,
            Some(u.version.clone()),
            Some(u.source.clone()),
            None,
        ));
    }
    cards
}

/// Detail projection. `history` holds every revision present (any order;
/// emitted newest-first). `helm_available` gates the upgrade affordance.
pub fn project_detail(
    latest: &Release,
    history: &[ReleaseSummary],
    helm_available: bool,
    update: Option<&HelmUpdateAvailable>,
) -> Value {
    let mut ordered: Vec<&ReleaseSummary> = history.iter().collect();
    ordered.sort_by_key(|r| std::cmp::Reverse(r.version));
    let history_rows: Vec<Value> = ordered
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
    let ns = latest.namespace.clone().unwrap_or_default();
    let hooks = latest.hooks.clone().unwrap_or_default();

    json!({
        "name": latest.name.clone(),
        "namespace": ns,
        "revision": latest.version,
        "status": latest.info.status.clone(),
        "description": latest.info.description.clone(),
        "first_deployed": latest.info.first_deployed.clone(),
        "last_deployed": latest.info.last_deployed.clone(),
        "deleted": latest.info.deleted.clone(),
        "notes": latest.info.notes.clone(),
        "chart": chart_label(latest.chart_metadata()),
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
        "resources": manifest_resources(latest.manifest.as_deref().unwrap_or(""), &ns),
        "hooks_resources": hook_resources(&hooks, &ns),
        "hooks": hooks,
        "cards": release_cards(latest, history_rows.len().max(1), update),
        "history": history_rows,
        "helm_available": helm_available,
        "update_available": update,
    })
}

pub type ReleaseKey = (String, String);

/// How a release's latest revision moved after an index mutation.
#[derive(Debug, Clone, PartialEq)]
pub enum LatestChange<T> {
    Upsert {
        key: ReleaseKey,
        prev: Option<T>,
        latest: T,
    },
    Delete {
        key: ReleaseKey,
        prev: T,
    },
}

#[derive(Debug)]
struct Revision<T> {
    version: i64,
    resource_version: Option<String>,
    payload: T,
}

/// Per-secret revision index for the helm watchers. Holds only a small
/// payload per revision (a projected row, a chart ref) — never a decoded
/// release — and remembers each secret's resourceVersion so an unchanged
/// secret isn't decoded twice.
#[derive(Debug)]
pub struct ReleaseIndex<T> {
    owner: HashMap<String, ReleaseKey>,
    releases: BTreeMap<ReleaseKey, HashMap<String, Revision<T>>>,
}

impl<T> Default for ReleaseIndex<T> {
    fn default() -> Self {
        Self {
            owner: HashMap::new(),
            releases: BTreeMap::new(),
        }
    }
}

fn latest_of<T>(revs: &HashMap<String, Revision<T>>) -> Option<&Revision<T>> {
    revs.iter()
        .max_by(|a, b| a.1.version.cmp(&b.1.version).then_with(|| a.0.cmp(b.0)))
        .map(|(_, r)| r)
}

impl<T: Clone + PartialEq> ReleaseIndex<T> {
    pub fn is_current(&self, secret_uid: &str, resource_version: Option<&str>) -> bool {
        resource_version.is_some()
            && self
                .owner
                .get(secret_uid)
                .and_then(|k| self.releases.get(k))
                .and_then(|revs| revs.get(secret_uid))
                .is_some_and(|r| r.resource_version.as_deref() == resource_version)
    }

    pub fn latest(&self, key: &ReleaseKey) -> Option<&T> {
        self.releases
            .get(key)
            .and_then(latest_of)
            .map(|r| &r.payload)
    }

    pub fn iter_latest(&self) -> impl Iterator<Item = (&ReleaseKey, &T)> {
        self.releases
            .iter()
            .filter_map(|(k, revs)| Some((k, &latest_of(revs)?.payload)))
    }

    pub fn release_count(&self) -> usize {
        self.releases.len()
    }

    pub fn upsert(
        &mut self,
        secret_uid: String,
        key: ReleaseKey,
        version: i64,
        resource_version: Option<String>,
        payload: T,
    ) -> Vec<LatestChange<T>> {
        let mut out = Vec::new();
        if self.owner.get(&secret_uid).is_some_and(|k| *k != key) {
            out.extend(self.remove(&secret_uid));
        }
        let prev = self.latest(&key).cloned();
        self.releases.entry(key.clone()).or_default().insert(
            secret_uid.clone(),
            Revision {
                version,
                resource_version,
                payload,
            },
        );
        self.owner.insert(secret_uid, key.clone());
        if let Some(latest) = self.latest(&key).cloned() {
            if prev.as_ref() != Some(&latest) {
                out.push(LatestChange::Upsert { key, prev, latest });
            }
        }
        out
    }

    pub fn remove(&mut self, secret_uid: &str) -> Option<LatestChange<T>> {
        let key = self.owner.remove(secret_uid)?;
        let revs = self.releases.get_mut(&key)?;
        let prev = latest_of(revs)?.payload.clone();
        revs.remove(secret_uid);
        match latest_of(revs).map(|r| r.payload.clone()) {
            None => {
                self.releases.remove(&key);
                Some(LatestChange::Delete { key, prev })
            }
            Some(latest) if latest != prev => Some(LatestChange::Upsert {
                key,
                prev: Some(prev),
                latest,
            }),
            Some(_) => None,
        }
    }

    /// Drop every secret not replayed by a relist (deletes missed while
    /// disconnected).
    pub fn retain_seen(&mut self, seen: &HashSet<String>) -> Vec<LatestChange<T>> {
        let stale: Vec<String> = self
            .owner
            .keys()
            .filter(|u| !seen.contains(u.as_str()))
            .cloned()
            .collect();
        stale.iter().filter_map(|u| self.remove(u)).collect()
    }
}

/// Chart identity carried per release for the chart catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartRef {
    pub name: String,
    pub version: String,
    pub app_version: Option<String>,
    pub description: Option<String>,
}

pub type ChartKey = (String, String);

/// `(chart, version)` → releases whose **latest** revision uses it.
#[derive(Debug, Default)]
pub struct ChartUsage {
    charts: BTreeMap<ChartKey, (ChartRef, usize)>,
}

impl ChartUsage {
    /// Apply a latest-revision change; returns chart keys whose row changed.
    pub fn apply(&mut self, change: &LatestChange<Option<ChartRef>>) -> Vec<ChartKey> {
        let (prev, next) = match change {
            LatestChange::Upsert { prev, latest, .. } => (prev.clone().flatten(), latest.clone()),
            LatestChange::Delete { prev, .. } => (prev.clone(), None),
        };
        let mut touched = Vec::with_capacity(2);
        if let Some(p) = prev {
            let key = (p.name, p.version);
            if let Some(entry) = self.charts.get_mut(&key) {
                entry.1 = entry.1.saturating_sub(1);
                if entry.1 == 0 {
                    self.charts.remove(&key);
                }
            }
            touched.push(key);
        }
        if let Some(n) = next {
            let key = (n.name.clone(), n.version.clone());
            self.charts.entry(key.clone()).or_insert((n, 0)).1 += 1;
            if !touched.contains(&key) {
                touched.push(key);
            }
        }
        touched
    }

    pub fn get(&self, key: &ChartKey) -> Option<(&ChartRef, usize)> {
        self.charts.get(key).map(|(r, n)| (r, *n))
    }

    pub fn iter(&self) -> impl Iterator<Item = (&ChartKey, &ChartRef, usize)> {
        self.charts.iter().map(|(k, (r, n))| (k, r, *n))
    }
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

/// Materialise the embedded chart into `dir` for `helm upgrade <rel> <dir>`.
///
/// Writes `Chart.yaml` (from `chart.metadata`), `values.yaml` (chart
/// defaults), `values.schema.json`, the lock file (`Chart.lock`, or
/// `requirements.lock` for apiVersion v1 charts) from `chart.lock`, and every
/// `chart.templates` / `chart.files` entry at its own chart-relative `name`.
///
/// Subcharts are not bundled: helm serialises only the parent chart
/// (`dependencies []*Chart` is unexported), so charts with dependencies
/// need [`crate::fetch::helm_dependency_fetch`] afterwards. The lock lets
/// that be a pinned `helm dependency build`.
///
/// Paths that could escape `dir` are rejected — they come from a
/// cluster-resident secret.
pub fn extract_chart_to_dir(release: &Release, dir: &Path) -> Result<(), ChartExtractError> {
    let chart = release
        .chart
        .as_ref()
        .ok_or(ChartExtractError::MissingChart)?;
    let metadata = chart
        .get("metadata")
        .filter(|v| v.is_object())
        .ok_or(ChartExtractError::MissingMetadata)?;

    fs::create_dir_all(dir)?;
    fs::write(dir.join("Chart.yaml"), serde_yaml::to_string(metadata)?)?;

    if let Some(values) = chart.get("values").filter(|v| !v.is_null()) {
        fs::write(dir.join("values.yaml"), serde_yaml::to_string(values)?)?;
    }

    if let Some(schema_b64) = chart.get("schema").and_then(|v| v.as_str()) {
        let schema = base64::engine::general_purpose::STANDARD
            .decode(schema_b64)
            .map_err(|e| ChartExtractError::Base64("values.schema.json".to_owned(), e))?;
        fs::write(dir.join("values.schema.json"), schema)?;
    }

    if let Some(lock) = chart.get("lock").filter(|v| v.is_object()) {
        let lock_name = if metadata.get("apiVersion").and_then(Value::as_str) == Some("v1") {
            "requirements.lock"
        } else {
            "Chart.lock"
        };
        fs::write(dir.join(lock_name), serde_yaml::to_string(lock)?)?;
    }

    write_chart_files(chart.get("templates"), dir)?;
    write_chart_files(chart.get("files"), dir)?;

    Ok(())
}

pub fn chart_has_dependencies(release: &Release) -> bool {
    release
        .chart
        .as_ref()
        .and_then(|c| c.get("metadata"))
        .and_then(|m| m.get("dependencies"))
        .and_then(|d| d.as_array())
        .is_some_and(|arr| !arr.is_empty())
}

/// Every component must be a plain in-tree segment: rejects `..`, `/`,
/// drive prefixes and `.` on whichever platform we're writing to.
fn is_safe_chart_path(name: &str) -> bool {
    !name.is_empty()
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
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
        if !is_safe_chart_path(name) {
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
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use k8s_openapi::ByteString;
    use serde_json::json;
    use std::io::Write;

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

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(bytes).expect("gzip write");
        enc.finish().expect("gzip finish")
    }

    fn b64(bytes: &[u8]) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into_bytes()
    }

    fn secret(ns: Option<&str>, payload: &[u8]) -> Secret {
        let mut s = Secret::default();
        s.metadata.namespace = ns.map(str::to_owned);
        s.data = Some(BTreeMap::from([(
            "release".to_owned(),
            ByteString(payload.to_vec()),
        )]));
        s
    }

    const JSON: &str = r#"{"name":"web","namespace":"payload-ns","version":3,
        "info":{"status":"deployed"},
        "chart":{"metadata":{"name":"nginx","version":"1.2.3","appVersion":"1.25"},
                 "templates":[{"name":"templates/a.yaml","data":"eA=="}]}}"#;

    #[test]
    fn decode_accepts_gzip_and_plain_payloads() {
        let gz = release_json_bytes(&b64(&gzip(JSON.as_bytes()))).expect("gzip");
        let plain = release_json_bytes(&b64(JSON.as_bytes())).expect("plain");
        assert_eq!(gz, plain);
        assert_eq!(gz, JSON.as_bytes());
    }

    #[test]
    fn decode_rejects_corrupt_payloads() {
        assert!(matches!(
            release_json_bytes(b"not base64!!"),
            Err(DecodeError::Base64(_))
        ));
        let mut truncated = gzip(JSON.as_bytes());
        truncated.truncate(truncated.len() / 2);
        assert!(matches!(
            release_json_bytes(&b64(&truncated)),
            Err(DecodeError::Gzip(_))
        ));
        let s = secret(Some("ns"), &b64(b"{not json"));
        assert!(matches!(decode_release(&s), Err(DecodeError::Json(_))));
        assert!(matches!(
            decode_release(&Secret::default()),
            Err(DecodeError::MissingRelease)
        ));
    }

    #[test]
    fn decode_caps_decompressed_size() {
        let bomb = vec![b' '; MAX_RELEASE_JSON_BYTES as usize + 1];
        let payload = b64(&gzip(&bomb));
        assert!(payload.len() < 1024 * 1024, "compresses small");
        assert!(matches!(
            release_json_bytes(&payload),
            Err(DecodeError::TooLarge)
        ));
        let exact = vec![b' '; MAX_RELEASE_JSON_BYTES as usize];
        assert_eq!(
            release_json_bytes(&b64(&gzip(&exact)))
                .expect("at cap")
                .len(),
            exact.len()
        );
    }

    #[test]
    fn secret_namespace_wins_over_payload() {
        let s = secret(Some("real-ns"), &b64(&gzip(JSON.as_bytes())));
        assert_eq!(
            decode_release(&s).expect("full").namespace.as_deref(),
            Some("real-ns")
        );
        let sum = decode_release_summary(&s).expect("summary");
        assert_eq!(sum.key(), ("real-ns".to_owned(), "web".to_owned()));
        assert_eq!(project_row(&sum)["namespace"], "real-ns");
        assert_eq!(project_row(&sum)["chart"], "nginx-1.2.3");

        let no_meta_ns = secret(None, &b64(JSON.as_bytes()));
        assert_eq!(
            decode_release_summary(&no_meta_ns)
                .expect("summary")
                .namespace
                .as_deref(),
            Some("payload-ns")
        );
    }

    #[test]
    fn secret_revision_prefers_label_then_name() {
        let mut s = Secret::default();
        s.metadata.name = Some("sh.helm.release.v1.web.v12".to_owned());
        assert_eq!(secret_revision(&s), Some(12));
        s.metadata.labels = Some(BTreeMap::from([("version".to_owned(), "13".to_owned())]));
        assert_eq!(secret_revision(&s), Some(13));
        assert_eq!(secret_revision(&Secret::default()), None);
    }

    #[test]
    fn manifest_resources_tolerate_garbage_and_default_namespace() {
        let manifest = "---\n# Source: a/templates/sa.yaml\napiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: sa\n---\n: : garbage [\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: other\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: cr\n--- \napiVersion: v1\nkind: ConfigMap\n---\n";
        let got = manifest_resources(manifest, "rel-ns");
        assert_eq!(
            got,
            vec![
                json!({"group": "", "kind": "ServiceAccount", "namespace": "rel-ns", "name": "sa", "local": true, "sync": null, "health": null, "message": null, "prune": false}),
                json!({"group": "apps", "kind": "Deployment", "namespace": "other", "name": "web", "local": true, "sync": null, "health": null, "message": null, "prune": false}),
                json!({"group": "rbac.authorization.k8s.io", "kind": "ClusterRole", "namespace": null, "name": "cr", "local": true, "sync": null, "health": null, "message": null, "prune": false}),
            ]
        );
        assert!(manifest_resources("", "ns").is_empty());
    }

    #[test]
    fn hook_resources_carry_events_and_phase() {
        let hooks = vec![
            json!({
                "name": "migrate", "kind": "Job",
                "events": ["pre-install", "post-upgrade"],
                "last_run": { "phase": "Succeeded" },
                "manifest": "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: migrate\n",
            }),
            json!({ "name": "t", "kind": "Pod", "events": ["test"], "last_run": { "phase": "" }, "manifest": "garbage: [" }),
        ];
        let got = hook_resources(&hooks, "ns");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["group"], "batch");
        assert_eq!(got[0]["message"], "pre-install,post-upgrade · Succeeded");
        assert_eq!(got[1]["kind"], "Pod");
        assert_eq!(got[1]["namespace"], "ns");
        assert_eq!(got[1]["message"], "test");
    }

    fn summary(version: i64, status: &str, chart_version: &str) -> ReleaseSummary {
        serde_json::from_value(json!({
            "name": "web", "namespace": "ns", "version": version,
            "info": { "status": status, "last_deployed": format!("t{version}") },
            "chart": { "metadata": { "name": "nginx", "version": chart_version } },
        }))
        .expect("summary")
    }

    #[test]
    fn detail_sorts_history_and_builds_cards() {
        let mut latest = release_with_chart(json!({
            "metadata": { "name": "nginx", "version": "1.2.3", "appVersion": "1.25" },
        }));
        latest.version = 10;
        latest.info.status = Some("deployed".into());
        latest.info.description = Some("Upgrade complete".into());
        latest.info.last_deployed = Some("2026-01-01T00:00:00Z".into());
        latest.manifest = Some("apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n".into());
        let history = vec![
            summary(2, "superseded", "1.0.0"),
            summary(10, "deployed", "1.2.3"),
            summary(9, "superseded", "1.2.0"),
        ];
        let update = HelmUpdateAvailable {
            source: "bitnami".into(),
            version: "1.3.0".into(),
            app_version: None,
        };
        let d = project_detail(&latest, &history, true, Some(&update));
        let revs: Vec<i64> = d["history"]
            .as_array()
            .expect("history")
            .iter()
            .map(|h| h["revision"].as_i64().expect("rev"))
            .collect();
        assert_eq!(revs, [10, 9, 2], "numeric, newest first");
        assert_eq!(d["history"][1]["chart_version"], "1.2.0");
        assert_eq!(
            d["cards"],
            json!([
                { "label": "Status", "status": "deployed", "value": null, "caption": "Upgrade complete", "at": null },
                { "label": "Revision", "status": null, "value": "#10", "caption": "3 revisions in history", "at": "2026-01-01T00:00:00Z" },
                { "label": "Chart", "status": null, "value": "nginx@1.2.3", "caption": "app 1.25", "at": null },
                { "label": "Update", "status": null, "value": "1.3.0", "caption": "bitnami", "at": null },
            ])
        );
        assert_eq!(d["resources"][0]["kind"], "Service");
        assert_eq!(d["resources"][0]["namespace"], "ns");
        assert_eq!(d["hooks_resources"], json!([]));
        assert_eq!(d["update_available"]["version"], "1.3.0");

        let no_update = project_detail(&latest, &history[1..2], false, None);
        assert_eq!(no_update["cards"].as_array().map(Vec::len), Some(3));
        assert_eq!(no_update["cards"][1]["caption"], "1 revision in history");
        assert!(no_update["update_available"].is_null());
    }

    fn key(name: &str) -> ReleaseKey {
        ("ns".to_owned(), name.to_owned())
    }

    #[test]
    fn index_tracks_latest_and_demotes_on_delete() {
        let mut idx: ReleaseIndex<i64> = ReleaseIndex::default();
        assert_eq!(
            idx.upsert("u1".into(), key("a"), 1, Some("r1".into()), 1),
            vec![LatestChange::Upsert {
                key: key("a"),
                prev: None,
                latest: 1
            }]
        );
        assert_eq!(
            idx.upsert("u2".into(), key("a"), 2, Some("r2".into()), 2),
            vec![LatestChange::Upsert {
                key: key("a"),
                prev: Some(1),
                latest: 2
            }]
        );
        assert!(
            idx.upsert("u1".into(), key("a"), 1, Some("r1b".into()), 1)
                .is_empty(),
            "older revision update leaves latest alone"
        );
        assert!(idx.is_current("u1", Some("r1b")));
        assert!(!idx.is_current("u1", Some("r1")));
        assert!(!idx.is_current("u1", None));
        assert_eq!(
            idx.remove("u2"),
            Some(LatestChange::Upsert {
                key: key("a"),
                prev: Some(2),
                latest: 1
            })
        );
        assert_eq!(
            idx.remove("u1"),
            Some(LatestChange::Delete {
                key: key("a"),
                prev: 1
            })
        );
        assert_eq!(idx.remove("u1"), None);
        assert_eq!(idx.release_count(), 0);
    }

    #[test]
    fn index_retain_seen_reconciles_missed_deletes() {
        let mut idx: ReleaseIndex<i64> = ReleaseIndex::default();
        idx.upsert("a1".into(), key("a"), 1, None, 1);
        idx.upsert("a2".into(), key("a"), 2, None, 2);
        idx.upsert("b1".into(), key("b"), 1, None, 1);
        let seen: HashSet<String> = ["a1".to_owned()].into();
        let mut changes = idx.retain_seen(&seen);
        changes.sort_by_key(|c| format!("{c:?}"));
        assert_eq!(
            changes,
            vec![
                LatestChange::Delete {
                    key: key("b"),
                    prev: 1
                },
                LatestChange::Upsert {
                    key: key("a"),
                    prev: Some(2),
                    latest: 1
                },
            ]
        );
        assert_eq!(idx.iter_latest().collect::<Vec<_>>(), [(&key("a"), &1)]);
    }

    fn chart(version: &str) -> Option<ChartRef> {
        Some(ChartRef {
            name: "nginx".into(),
            version: version.into(),
            app_version: None,
            description: None,
        })
    }

    fn apply(
        usage: &mut ChartUsage,
        changes: impl IntoIterator<Item = LatestChange<Option<ChartRef>>>,
    ) -> Vec<ChartKey> {
        changes.into_iter().flat_map(|c| usage.apply(&c)).collect()
    }

    #[test]
    fn chart_usage_counts_latest_revisions_only() {
        let mut idx: ReleaseIndex<Option<ChartRef>> = ReleaseIndex::default();
        let mut usage = ChartUsage::default();
        let v1 = ("nginx".to_owned(), "1".to_owned());
        let v2 = ("nginx".to_owned(), "2".to_owned());
        let u = &mut usage;
        assert_eq!(
            apply(u, idx.upsert("a1".into(), key("a"), 1, None, chart("1"))),
            vec![v1.clone()]
        );
        assert!(
            apply(u, idx.upsert("a2".into(), key("a"), 2, None, chart("1"))).is_empty(),
            "same chart, new revision: no count change"
        );
        assert_eq!(
            apply(u, idx.upsert("b1".into(), key("b"), 1, None, chart("1"))),
            vec![v1.clone()]
        );
        assert_eq!(
            apply(u, idx.upsert("a3".into(), key("a"), 3, None, chart("2"))),
            vec![v1.clone(), v2.clone()]
        );
        assert_eq!(usage.get(&v1).map(|(_, n)| n), Some(1), "only b's latest");
        assert_eq!(usage.get(&v2).map(|(_, n)| n), Some(1));

        assert_eq!(
            apply(&mut usage, idx.remove("a3")),
            vec![v2.clone(), v1.clone()]
        );
        assert_eq!(apply(&mut usage, idx.remove("b1")), vec![v1.clone()]);
        assert_eq!(usage.get(&v1).map(|(_, n)| n), Some(1));
        assert!(usage.get(&v2).is_none());

        assert!(apply(&mut usage, idx.remove("a2")).is_empty());
        assert_eq!(apply(&mut usage, idx.remove("a1")), vec![v1]);
        assert_eq!(usage.iter().count(), 0);
    }

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
        let none = release_with_chart(json!({ "metadata": { "name": "plain" } }));
        assert!(!chart_has_dependencies(&none));
    }

    #[test]
    fn is_safe_chart_path_accepts_in_tree_and_rejects_escapes() {
        assert!(is_safe_chart_path("Chart.yaml"));
        assert!(is_safe_chart_path("templates/deployment.yaml"));
        assert!(is_safe_chart_path("charts/common/values.yaml"));
        assert!(!is_safe_chart_path(""), "empty name");
        assert!(!is_safe_chart_path("../escape"), "parent ref");
        assert!(
            !is_safe_chart_path("a/b/../../../etc/passwd"),
            "nested parent ref"
        );
        assert!(!is_safe_chart_path("/etc/cron.d/evil"), "unix absolute");
        assert!(!is_safe_chart_path("./foo"), "current-dir prefix");
        #[cfg(windows)]
        assert!(
            !is_safe_chart_path(r"C:\windows\evil"),
            "windows drive absolute"
        );
    }

    #[test]
    fn write_chart_files_rejects_path_traversal() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let malicious = json!([{
            "name": "../escape.txt",
            "data": base64::engine::general_purpose::STANDARD.encode(b"pwned"),
        }]);
        let err = write_chart_files(Some(&malicious), tmp.path());
        assert!(matches!(err, Err(ChartExtractError::BadFileEntry)));
        assert!(!tmp.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn extract_writes_chart_yaml_values_and_lock() {
        let release = release_with_chart(json!({
            "metadata": { "apiVersion": "v2", "name": "plain", "version": "1.0.0" },
            "values": { "key": "value" },
            "lock": { "digest": "sha256:abc", "dependencies": [{ "name": "common", "version": "2.0.0" }] },
            "files": [{ "name": "config/app.json", "data": "e30=" }],
        }));
        let tmp = tempfile::tempdir().expect("tempdir");
        extract_chart_to_dir(&release, tmp.path()).expect("extract");
        assert!(tmp.path().join("Chart.yaml").exists());
        assert!(tmp.path().join("values.yaml").exists());
        assert!(tmp.path().join("config/app.json").exists());
        let lock = fs::read_to_string(tmp.path().join("Chart.lock")).expect("lock");
        assert!(lock.contains("sha256:abc"));
        assert!(!tmp.path().join("charts").exists());

        let v1 = release_with_chart(json!({
            "metadata": { "apiVersion": "v1", "name": "old" },
            "lock": { "digest": "d" },
        }));
        let tmp = tempfile::tempdir().expect("tempdir");
        extract_chart_to_dir(&v1, tmp.path()).expect("extract");
        assert!(tmp.path().join("requirements.lock").exists());
        assert!(!tmp.path().join("Chart.lock").exists());
    }
}
