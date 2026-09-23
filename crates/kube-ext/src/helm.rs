//! Helm CLI plumbing shared by the Tauri commands and the agent tools:
//! argument validation, argv builders, the kill-on-timeout runner, output
//! summaries, the `helm search repo` cache, and chart-identity matching for
//! update detection.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ferrisscope_core::sync::LockExt;
use k8s_openapi::api::core::v1::ConfigMap;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::{json, Value};

pub const HELM_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Passed to helm as `--timeout` (hooks, `--wait`). Kept below
/// [`HELM_KILL_TIMEOUT`] so helm fails on its own terms and records the
/// release status before we'd kill it mid-operation.
pub const HELM_OP_TIMEOUT: Duration = Duration::from_mins(4);
const KILL_MARGIN: Duration = Duration::from_mins(1);
pub const HELM_KILL_TIMEOUT: Duration = kill_deadline_for(HELM_OP_TIMEOUT);

pub const fn kill_deadline_for(op_timeout: Duration) -> Duration {
    op_timeout.saturating_add(KILL_MARGIN)
}

const MAX_RELEASE_NAME_LEN: usize = 53;
const MAX_NAMESPACE_LEN: usize = 63;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HelmArgError {
    #[error(
        "invalid release name {0:?}: use lowercase letters, digits, '-' or '.', start and end \
         with a letter or digit, at most 53 characters"
    )]
    ReleaseName(String),
    #[error(
        "invalid namespace {0:?}: must be a DNS-1123 label (lowercase letters, digits, '-', \
         at most 63 characters)"
    )]
    Namespace(String),
    #[error("invalid chart reference {0:?}")]
    ChartRef(String),
    #[error("invalid chart version {0:?}")]
    Version(String),
    #[error("invalid repository name {0:?}")]
    Repo(String),
    #[error("invalid revision {0}: must be a positive integer")]
    Revision(i64),
}

fn is_dns_label(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= max
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
}

/// Helm's own rule (`chartutil.ValidateReleaseName`): dot-separated
/// DNS-1123 labels, at most 53 characters.
pub fn validate_release_name(name: &str) -> Result<(), HelmArgError> {
    if name.len() <= MAX_RELEASE_NAME_LEN && name.split('.').all(|l| is_dns_label(l, 63)) {
        Ok(())
    } else {
        Err(HelmArgError::ReleaseName(name.to_owned()))
    }
}

pub fn validate_namespace(ns: &str) -> Result<(), HelmArgError> {
    if is_dns_label(ns, MAX_NAMESPACE_LEN) {
        Ok(())
    } else {
        Err(HelmArgError::Namespace(ns.to_owned()))
    }
}

fn is_plain_token(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_control())
}

/// `<repo>/<chart>`, `oci://…`, or a local path. Anything goes except a
/// leading `-` (would parse as a flag) and control characters.
pub fn validate_chart_ref(chart: &str) -> Result<(), HelmArgError> {
    if is_plain_token(chart) {
        Ok(())
    } else {
        Err(HelmArgError::ChartRef(chart.to_owned()))
    }
}

pub fn validate_version(version: &str) -> Result<(), HelmArgError> {
    if is_plain_token(version) && !version.chars().any(char::is_whitespace) {
        Ok(())
    } else {
        Err(HelmArgError::Version(version.to_owned()))
    }
}

/// A single path segment: repo names and bare chart names.
pub fn validate_repo_name(repo: &str) -> Result<(), HelmArgError> {
    if is_plain_token(repo) && !repo.contains('/') && !repo.chars().any(char::is_whitespace) {
        Ok(())
    } else {
        Err(HelmArgError::Repo(repo.to_owned()))
    }
}

pub fn validate_revision(revision: i64) -> Result<(), HelmArgError> {
    if revision > 0 {
        Ok(())
    } else {
        Err(HelmArgError::Revision(revision))
    }
}

/// Which cluster the helm CLI talks to.
#[derive(Debug, Clone, Copy)]
pub struct KubeTarget<'a> {
    pub context: &'a str,
    pub kubeconfig: Option<&'a Path>,
}

fn push_common(args: &mut Vec<OsString>, verb: &str, namespace: &str, target: KubeTarget<'_>) {
    args.push(verb.into());
    args.push("--namespace".into());
    args.push(namespace.into());
    args.push("--kube-context".into());
    args.push(target.context.into());
    if let Some(p) = target.kubeconfig {
        args.push("--kubeconfig".into());
        args.push(p.into());
    }
}

fn timeout_arg(d: Duration) -> OsString {
    format!("{}s", d.as_secs().max(1)).into()
}

#[derive(Debug, Clone, Copy)]
pub struct UpgradeSpec<'a> {
    pub release: &'a str,
    pub namespace: &'a str,
    pub chart: &'a OsStr,
    pub values_file: &'a Path,
    pub version: Option<&'a str>,
    /// `upgrade --install`.
    pub install: bool,
    pub create_namespace: bool,
    /// The values file is the complete intent; without this an empty file
    /// makes helm silently reuse the previous release's values.
    pub reset_values: bool,
    pub wait: bool,
    pub timeout: Duration,
}

/// Flags first, then `--`, then positionals, so neither a release name nor a
/// chart ref can be parsed as a flag.
pub fn upgrade_args(spec: &UpgradeSpec<'_>, target: KubeTarget<'_>) -> Vec<OsString> {
    let mut a = Vec::with_capacity(24);
    push_common(&mut a, "upgrade", spec.namespace, target);
    a.push("--values".into());
    a.push(spec.values_file.into());
    a.push("--output".into());
    a.push("json".into());
    a.push("--timeout".into());
    a.push(timeout_arg(spec.timeout));
    if spec.install {
        a.push("--install".into());
    }
    if spec.create_namespace {
        a.push("--create-namespace".into());
    }
    if spec.reset_values {
        a.push("--reset-values".into());
    }
    if spec.wait {
        a.push("--wait".into());
    }
    if let Some(v) = spec.version {
        a.push("--version".into());
        a.push(v.into());
    }
    a.push("--".into());
    a.push(spec.release.into());
    a.push(spec.chart.to_owned());
    a
}

pub fn install_args(
    release: &str,
    namespace: &str,
    chart: &OsStr,
    values_file: &Path,
    version: Option<&str>,
    target: KubeTarget<'_>,
) -> Vec<OsString> {
    let mut a = Vec::with_capacity(20);
    push_common(&mut a, "install", namespace, target);
    a.push("--create-namespace".into());
    a.push("--values".into());
    a.push(values_file.into());
    a.push("--output".into());
    a.push("json".into());
    a.push("--timeout".into());
    a.push(timeout_arg(HELM_OP_TIMEOUT));
    if let Some(v) = version {
        a.push("--version".into());
        a.push(v.into());
    }
    a.push("--".into());
    a.push(release.into());
    a.push(chart.to_owned());
    a
}

pub fn uninstall_args(release: &str, namespace: &str, target: KubeTarget<'_>) -> Vec<OsString> {
    let mut a = Vec::with_capacity(12);
    push_common(&mut a, "uninstall", namespace, target);
    a.push("--timeout".into());
    a.push(timeout_arg(HELM_OP_TIMEOUT));
    a.push("--".into());
    a.push(release.into());
    a
}

/// `revision = None` rolls back to the previous revision (helm's default).
pub fn rollback_args(
    release: &str,
    namespace: &str,
    revision: Option<i64>,
    target: KubeTarget<'_>,
) -> Vec<OsString> {
    let mut a = Vec::with_capacity(12);
    push_common(&mut a, "rollback", namespace, target);
    a.push("--timeout".into());
    a.push(timeout_arg(HELM_OP_TIMEOUT));
    a.push("--".into());
    a.push(release.into());
    if let Some(r) = revision {
        a.push(r.to_string().into());
    }
    a
}

pub fn dependency_args(verb: &str, chart_dir: &Path) -> Vec<OsString> {
    vec![
        "dependency".into(),
        verb.into(),
        "--".into(),
        chart_dir.into(),
    ]
}

pub fn helm_command<I, S>(args: I) -> std::process::Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = std::process::Command::new("helm");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

#[derive(Debug, thiserror::Error)]
pub enum HelmRunError {
    #[error("spawn helm: {0}")]
    Spawn(std::io::Error),
    #[error("helm timed out after {}s and was killed", .0.as_secs())]
    TimedOut(Duration),
}

/// Run a prepared helm command with a hard deadline. `tokio::process` +
/// `kill_on_drop` so a timeout (or an aborted caller) actually kills helm.
pub async fn run_helm(
    cmd: std::process::Command,
    limit: Duration,
) -> Result<std::process::Output, HelmRunError> {
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    match tokio::time::timeout(limit, cmd.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(HelmRunError::Spawn(e)),
        Err(_) => Err(HelmRunError::TimedOut(limit)),
    }
}

/// Headline of a `helm … --output json` release document.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReleaseOutcome {
    pub revision: Option<i64>,
    pub status: Option<String>,
    /// Compact JSON (`name`, `namespace`, `revision`, `status`,
    /// `description`) — never the manifest, values or chart.
    pub summary: String,
}

const RAW_SUMMARY_LIMIT: usize = 2048;

pub fn summarize_release_output(stdout: &str) -> ReleaseOutcome {
    let Ok(v) = serde_json::from_str::<Value>(stdout) else {
        let mut end = stdout.len().min(RAW_SUMMARY_LIMIT);
        while !stdout.is_char_boundary(end) {
            end -= 1;
        }
        return ReleaseOutcome {
            summary: stdout[..end].to_owned(),
            ..ReleaseOutcome::default()
        };
    };
    let revision = v.get("version").and_then(Value::as_i64);
    let status = v
        .pointer("/info/status")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let summary = json!({
        "name": v.get("name"),
        "namespace": v.get("namespace"),
        "revision": revision,
        "status": status,
        "description": v.pointer("/info/description"),
    })
    .to_string();
    ReleaseOutcome {
        revision,
        status,
        summary,
    }
}

/// One entry of `helm search repo -o json`, repo prefix split off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelmRepoChart {
    pub repo: String,
    pub name: String,
    pub version: String,
    pub app_version: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelmUpdateAvailable {
    pub source: String,
    pub version: String,
    pub app_version: Option<String>,
}

pub fn parse_search_output(stdout: &str) -> Vec<HelmRepoChart> {
    let Ok(raw) = serde_json::from_str::<Vec<Value>>(stdout) else {
        return Vec::new();
    };
    raw.into_iter()
        .filter_map(|entry| {
            let (repo, name) = entry.get("name")?.as_str()?.split_once('/')?;
            if repo.is_empty() || name.is_empty() {
                return None;
            }
            let text = |k: &str| entry.get(k).and_then(Value::as_str).map(str::to_owned);
            Some(HelmRepoChart {
                repo: repo.to_owned(),
                name: name.to_owned(),
                version: text("version")?,
                app_version: text("app_version"),
                description: text("description"),
            })
        })
        .collect()
}

/// Same-name repo entries strictly newer (semver) than `current_version`,
/// newest first. Non-semver versions are skipped.
pub fn update_candidates<'a>(
    chart_name: &str,
    current_version: &str,
    repos: &'a [HelmRepoChart],
) -> Vec<(semver::Version, &'a HelmRepoChart)> {
    let Ok(current) = semver::Version::parse(current_version) else {
        return Vec::new();
    };
    let mut out: Vec<_> = repos
        .iter()
        .filter(|e| e.name == chart_name)
        .filter_map(|e| Some((semver::Version::parse(&e.version).ok()?, e)))
        .filter(|(v, _)| *v > current)
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.repo.cmp(&b.1.repo)));
    out
}

/// Who publishes a chart, from `Chart.yaml`'s `home` + `sources`. Name
/// alone is not identity: `bitnami/redis` and `dandydev/redis` collide.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChartIdentity {
    pub home: Option<String>,
    pub sources: Vec<String>,
}

fn normalize_url(url: &str) -> Option<String> {
    let mut s = url.trim().to_ascii_lowercase();
    for scheme in ["git+", "https://", "http://", "www."] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest.to_owned();
        }
    }
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s).trim_end_matches('/');
    (!s.is_empty()).then(|| s.to_owned())
}

impl ChartIdentity {
    pub fn from_metadata(meta: &Value) -> Self {
        Self {
            home: meta
                .get("home")
                .and_then(Value::as_str)
                .and_then(normalize_url),
            sources: meta
                .get("sources")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .filter_map(normalize_url)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub fn from_chart_yaml(yaml: &str) -> Option<Self> {
        let v: Value = serde_yaml::from_str(yaml).ok()?;
        Some(Self::from_metadata(&v))
    }

    /// Positive evidence only: equal `home`, or at least one shared source.
    /// Missing metadata on either side is not a match.
    pub fn matches(&self, other: &Self) -> bool {
        if let (Some(a), Some(b)) = (&self.home, &other.home) {
            if a == b {
                return true;
            }
        }
        self.sources.iter().any(|s| other.sources.contains(s))
    }
}

/// Process-wide memo with a generation counter: a fill that started before
/// [`TtlCache::invalidate`] can't overwrite the fresh state.
type CacheSlot<T> = Option<(Instant, Arc<T>)>;

pub struct TtlCache<T> {
    state: Mutex<(u64, CacheSlot<T>)>,
}

impl<T> Default for TtlCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> TtlCache<T> {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new((0, None)),
        }
    }

    /// `Ok(value)` on a fresh hit, `Err(generation)` to pass to [`Self::put`].
    pub fn get(&self, now: Instant, ttl: Duration) -> Result<Arc<T>, u64> {
        let g = self.state.lock_recover();
        match &g.1 {
            Some((at, v)) if now.saturating_duration_since(*at) < ttl => Ok(v.clone()),
            _ => Err(g.0),
        }
    }

    pub fn put(&self, generation: u64, now: Instant, value: Arc<T>) -> bool {
        let mut g = self.state.lock_recover();
        if g.0 != generation {
            return false;
        }
        g.1 = Some((now, value));
        true
    }

    pub fn invalidate(&self) {
        let mut g = self.state.lock_recover();
        g.0 = g.0.wrapping_add(1);
        g.1 = None;
    }
}

const SEARCH_TTL: Duration = Duration::from_mins(10);
static SEARCH_CACHE: TtlCache<Vec<HelmRepoChart>> = TtlCache::new();
static SEARCH_FILL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

type IdentityKey = (String, String, String);
const IDENTITY_CACHE_CAP: usize = 512;
static IDENTITY_CACHE: Mutex<Option<HashMap<IdentityKey, Option<ChartIdentity>>>> =
    Mutex::new(None);

pub fn helm_available() -> bool {
    which::which("helm").is_ok()
}

async fn search_repo_uncached() -> Vec<HelmRepoChart> {
    let cmd = helm_command(["search", "repo", "--output", "json"]);
    match run_helm(cmd, HELM_READ_TIMEOUT).await {
        // Non-zero is the normal "no repositories configured" case.
        Ok(o) if o.status.success() => parse_search_output(&String::from_utf8_lossy(&o.stdout)),
        Ok(_) => Vec::new(),
        Err(e) => {
            tracing::warn!("helm search repo: {e}");
            Vec::new()
        }
    }
}

/// `helm search repo`, memoised process-wide (the repo cache is host-local,
/// not per cluster) until [`invalidate_repo_caches`] or the TTL.
pub async fn search_repo_cached() -> Arc<Vec<HelmRepoChart>> {
    if !helm_available() {
        return Arc::new(Vec::new());
    }
    if let Ok(v) = SEARCH_CACHE.get(Instant::now(), SEARCH_TTL) {
        return v;
    }
    let _fill = SEARCH_FILL.lock().await;
    let generation = match SEARCH_CACHE.get(Instant::now(), SEARCH_TTL) {
        Ok(v) => return v,
        Err(g) => g,
    };
    let fresh = Arc::new(search_repo_uncached().await);
    SEARCH_CACHE.put(generation, Instant::now(), fresh.clone());
    fresh
}

pub fn invalidate_repo_caches() {
    SEARCH_CACHE.invalidate();
    *IDENTITY_CACHE.lock_recover() = None;
}

/// `helm show chart <repo>/<name> --version <v>` → identity, memoised.
/// `None` when helm can't resolve it.
pub async fn repo_chart_identity(repo: &str, name: &str, version: &str) -> Option<ChartIdentity> {
    let key = (repo.to_owned(), name.to_owned(), version.to_owned());
    if let Some(hit) = IDENTITY_CACHE
        .lock_recover()
        .as_ref()
        .and_then(|m| m.get(&key))
    {
        return hit.clone();
    }
    let chart_ref = format!("{repo}/{name}");
    let cmd = helm_command([
        "show",
        "chart",
        "--version",
        version,
        "--",
        chart_ref.as_str(),
    ]);
    let ident = match run_helm(cmd, HELM_READ_TIMEOUT).await {
        Ok(o) if o.status.success() => {
            ChartIdentity::from_chart_yaml(&String::from_utf8_lossy(&o.stdout))
        }
        Ok(o) => {
            tracing::debug!(
                chart = %chart_ref,
                stderr = %String::from_utf8_lossy(&o.stderr).trim(),
                "helm show chart failed"
            );
            None
        }
        Err(e) => {
            tracing::warn!(chart = %chart_ref, "helm show chart: {e}");
            None
        }
    };
    let mut g = IDENTITY_CACHE.lock_recover();
    let map = g.get_or_insert_with(HashMap::new);
    if map.len() >= IDENTITY_CACHE_CAP {
        map.clear();
    }
    map.insert(key, ident.clone());
    ident
}

const MAX_IDENTITY_PROBES: usize = 4;

/// Highest newer version of this chart, from a repo whose chart metadata
/// proves it's the same chart (see [`ChartIdentity::matches`]).
pub async fn find_chart_update(
    chart_name: &str,
    current_version: &str,
    current: &ChartIdentity,
) -> Option<HelmUpdateAvailable> {
    let repos = search_repo_cached().await;
    for (v, entry) in update_candidates(chart_name, current_version, &repos)
        .into_iter()
        .take(MAX_IDENTITY_PROBES)
    {
        let Some(ident) = repo_chart_identity(&entry.repo, &entry.name, &entry.version).await
        else {
            continue;
        };
        if current.matches(&ident) {
            return Some(HelmUpdateAvailable {
                source: entry.repo.clone(),
                version: v.to_string(),
                app_version: entry.app_version.clone(),
            });
        }
    }
    None
}

/// True when any release is stored with helm's ConfigMap driver
/// (`HELM_DRIVER=configmap`), which the Secret-backed views can't see.
pub async fn helm_storage_probe(client: Client) -> Result<bool, kube::Error> {
    let api: Api<ConfigMap> = Api::all(client);
    let lp = ListParams::default().labels("owner=helm").limit(1);
    Ok(!api.list_metadata(&lp).await?.items.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn strs(v: &[OsString]) -> Vec<String> {
        v.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    fn target(kc: Option<&Path>) -> KubeTarget<'_> {
        KubeTarget {
            context: "kind-a",
            kubeconfig: kc,
        }
    }

    #[test]
    fn release_name_follows_helm_rule() {
        for ok in ["a", "my-rel", "rel.v2", "0abc", &"a".repeat(53)] {
            assert!(validate_release_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-rf",
            "--set=x",
            "Upper",
            "a_b",
            "a..b",
            "rel-",
            ".rel",
            "a b",
            &"a".repeat(54),
        ] {
            assert!(validate_release_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn namespace_is_dns_label() {
        assert!(validate_namespace("kube-system").is_ok());
        assert!(validate_namespace(&"n".repeat(63)).is_ok());
        for bad in ["", "-n", "a.b", "A", &"n".repeat(64), "ns-"] {
            assert!(validate_namespace(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn chart_version_repo_reject_flags() {
        assert!(validate_chart_ref("bitnami/redis").is_ok());
        assert!(validate_chart_ref("oci://ghcr.io/x/y").is_ok());
        assert!(validate_chart_ref("/tmp/my chart").is_ok());
        assert!(validate_chart_ref("--post-renderer=/bin/sh").is_err());
        assert!(validate_chart_ref("").is_err());
        assert!(validate_chart_ref("a\nb").is_err());
        assert!(validate_version("1.2.3").is_ok());
        assert!(validate_version("^1.0").is_ok());
        assert!(validate_version("-1").is_err());
        assert!(validate_version("1 2").is_err());
        assert!(validate_repo_name("bitnami").is_ok());
        assert!(validate_repo_name("a/b").is_err());
        assert!(validate_repo_name("-x").is_err());
        assert!(validate_revision(1).is_ok());
        assert!(validate_revision(0).is_err());
        assert!(validate_revision(-3).is_err());
    }

    #[test]
    fn upgrade_argv_resets_values_and_ends_with_positionals() {
        let values = PathBuf::from("/tmp/v.yaml");
        let kc = PathBuf::from("/tmp/kc");
        let spec = UpgradeSpec {
            release: "rel",
            namespace: "ns",
            chart: OsStr::new("/tmp/chart"),
            values_file: &values,
            version: Some("1.2.3"),
            install: false,
            create_namespace: false,
            reset_values: true,
            wait: false,
            timeout: HELM_OP_TIMEOUT,
        };
        let a = strs(&upgrade_args(&spec, target(Some(&kc))));
        assert_eq!(
            a,
            [
                "upgrade",
                "--namespace",
                "ns",
                "--kube-context",
                "kind-a",
                "--kubeconfig",
                "/tmp/kc",
                "--values",
                "/tmp/v.yaml",
                "--output",
                "json",
                "--timeout",
                "240s",
                "--reset-values",
                "--version",
                "1.2.3",
                "--",
                "rel",
                "/tmp/chart",
            ]
        );
    }

    #[test]
    fn helm_timeout_is_below_kill_deadline() {
        assert!(HELM_OP_TIMEOUT < HELM_KILL_TIMEOUT);
        assert_eq!(HELM_KILL_TIMEOUT, Duration::from_mins(5));
        let values = PathBuf::from("/v");
        let install = strs(&install_args(
            "r",
            "ns",
            OsStr::new("repo/c"),
            &values,
            None,
            target(None),
        ));
        let rollback = strs(&rollback_args("r", "ns", Some(3), target(None)));
        let uninstall = strs(&uninstall_args("r", "ns", target(None)));
        for argv in [&install, &rollback, &uninstall] {
            let i = argv.iter().position(|s| s == "--timeout").expect("timeout");
            assert_eq!(argv[i + 1], "240s");
        }
        assert_eq!(&install[install.len() - 3..], ["--", "r", "repo/c"]);
        assert!(install.contains(&"--create-namespace".to_owned()));
        assert!(!install.contains(&"--reset-values".to_owned()));
        assert_eq!(&rollback[rollback.len() - 3..], ["--", "r", "3"]);
        assert_eq!(
            &strs(&rollback_args("r", "ns", None, target(None)))[..1],
            ["rollback"]
        );
        assert_eq!(
            strs(&rollback_args("r", "ns", None, target(None)))
                .last()
                .map(String::as_str),
            Some("r")
        );
        assert_eq!(&uninstall[uninstall.len() - 2..], ["--", "r"]);
    }

    #[test]
    fn upgrade_install_argv_flags() {
        let values = PathBuf::from("/v");
        let spec = UpgradeSpec {
            release: "r",
            namespace: "ns",
            chart: OsStr::new("bitnami/redis"),
            values_file: &values,
            version: None,
            install: true,
            create_namespace: true,
            reset_values: true,
            wait: true,
            timeout: Duration::from_secs(90),
        };
        let a = strs(&upgrade_args(&spec, target(None)));
        for f in [
            "--install",
            "--create-namespace",
            "--wait",
            "--reset-values",
        ] {
            assert!(a.contains(&f.to_owned()), "{f}");
        }
        assert!(!a.contains(&"--kubeconfig".to_owned()));
        assert!(a.contains(&"90s".to_owned()));
        assert_eq!(&a[a.len() - 3..], ["--", "r", "bitnami/redis"]);
    }

    #[test]
    fn summary_drops_manifest_and_values() {
        let stdout = json!({
            "name": "r", "namespace": "ns", "version": 7,
            "info": { "status": "deployed", "description": "Upgrade complete", "notes": "n" },
            "manifest": "x".repeat(10_000),
            "config": { "secret": "hunter2" },
            "chart": { "templates": [] },
        })
        .to_string();
        let o = summarize_release_output(&stdout);
        assert_eq!(o.revision, Some(7));
        assert_eq!(o.status.as_deref(), Some("deployed"));
        assert!(o.summary.len() < 200, "{}", o.summary);
        assert!(!o.summary.contains("hunter2"));

        let raw = summarize_release_output(&"é".repeat(5000));
        assert!(raw.summary.len() <= RAW_SUMMARY_LIMIT);
        assert_eq!(raw.revision, None);
    }

    fn rc(repo: &str, name: &str, version: &str) -> HelmRepoChart {
        HelmRepoChart {
            repo: repo.into(),
            name: name.into(),
            version: version.into(),
            app_version: None,
            description: None,
        }
    }

    #[test]
    fn update_candidates_use_semver_order() {
        let repos = vec![
            rc("a", "redis", "0.9.0"),
            rc("a", "redis", "0.10.0"),
            rc("b", "redis", "0.11.0-rc.1"),
            rc("c", "redis", "not-semver"),
            rc("d", "nginx", "99.0.0"),
            rc("e", "redis", "0.2.0"),
        ];
        let got: Vec<_> = update_candidates("redis", "0.9.0", &repos)
            .into_iter()
            .map(|(v, e)| (v.to_string(), e.repo.clone()))
            .collect();
        assert_eq!(
            got,
            [
                ("0.11.0-rc.1".to_owned(), "b".to_owned()),
                ("0.10.0".to_owned(), "a".to_owned()),
            ]
        );
        assert!(update_candidates("redis", "garbage", &repos).is_empty());
    }

    #[test]
    fn identity_requires_positive_evidence() {
        let bitnami = ChartIdentity::from_metadata(&json!({
            "home": "https://bitnami.com/",
            "sources": ["https://github.com/bitnami/charts.git"],
        }));
        let bitnami_new = ChartIdentity::from_metadata(&json!({
            "home": "https://bitnami.com",
            "sources": ["https://github.com/bitnami/containers", "http://github.com/bitnami/charts"],
        }));
        let other = ChartIdentity::from_metadata(&json!({
            "home": "https://github.com/DandyDeveloper/charts",
            "sources": ["https://github.com/DandyDeveloper/charts"],
        }));
        let sources_only = ChartIdentity::from_metadata(&json!({
            "sources": ["https://github.com/bitnami/charts"],
        }));
        assert!(bitnami.matches(&bitnami_new));
        assert!(bitnami.matches(&sources_only));
        assert!(!bitnami.matches(&other));
        assert!(!bitnami.matches(&ChartIdentity::default()));
        assert!(!ChartIdentity::default().matches(&ChartIdentity::default()));
        let yaml = "apiVersion: v2\nname: redis\nhome: https://bitnami.com\n";
        assert!(ChartIdentity::from_chart_yaml(yaml)
            .expect("yaml")
            .matches(&bitnami));
    }

    #[test]
    fn search_output_parses_and_skips_malformed() {
        let out = r#"[
            {"name":"bitnami/redis","version":"1.0.0","app_version":"7","description":"d"},
            {"name":"noslash","version":"1"},
            {"name":"x/y"}
        ]"#;
        assert_eq!(
            parse_search_output(out),
            vec![HelmRepoChart {
                repo: "bitnami".into(),
                name: "redis".into(),
                version: "1.0.0".into(),
                app_version: Some("7".into()),
                description: Some("d".into()),
            }]
        );
        assert!(parse_search_output("Error: no repositories").is_empty());
    }

    #[test]
    fn ttl_cache_hits_expires_and_invalidates() {
        let cache: TtlCache<u32> = TtlCache::new();
        let t0 = Instant::now();
        let ttl = Duration::from_secs(10);
        let generation = cache.get(t0, ttl).expect_err("empty");
        assert!(cache.put(generation, t0, Arc::new(1)));
        assert_eq!(*cache.get(t0, ttl).expect("hit"), 1);
        assert!(cache.get(t0 + ttl, ttl).is_err(), "expired");

        let stale_generation = cache.get(t0 + ttl, ttl).expect_err("miss");
        cache.invalidate();
        assert!(cache.get(t0, ttl).is_err(), "invalidated");
        assert!(
            !cache.put(stale_generation, t0, Arc::new(2)),
            "fill started before invalidate must not land"
        );
        let fresh = cache.get(t0, ttl).expect_err("still empty");
        assert!(cache.put(fresh, t0, Arc::new(3)));
        assert_eq!(*cache.get(t0, ttl).expect("hit"), 3);
    }
}
