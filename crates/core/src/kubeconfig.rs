//! Kubeconfig discovery and context enumeration across multiple sources.
//!
//! The "default" kubeconfig (KUBECONFIG env / ~/.kube/config) is read by
//! kube-rs's built-in resolver. User-added sources (files or folder scans)
//! are loaded individually and merged into the result. Every context is
//! tagged with the source it came from so we can re-load the right kubeconfig
//! file when connecting.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::sources::{KubeconfigSource, SourceKind, SourcesFile, SshSourceConfig};
use crate::Result;

/// Hard cap on how large a folder-scanned file can be before we skip it.
/// Real kubeconfigs are kilobytes; anything past this is almost certainly a
/// log, dump, or binary blob that just happens to share a folder with one.
const MAX_KUBECONFIG_BYTES: u64 = 1024 * 1024; // 1 MiB

/// Bytes to read for the header sniff. Genuine kubeconfigs put `apiVersion:`
/// near the top; this lets us reject random YAMLs and non-YAML files without
/// running `serde_yaml` across them.
const SNIFF_BYTES: usize = 512;

/// Stable identifier for the implicit default-kubeconfig source.
pub const DEFAULT_SOURCE_ID: &str = "default";
/// Display group for the default kubeconfig.
pub const DEFAULT_GROUP: &str = "Default";

#[derive(Debug, Clone, Serialize)]
pub struct ContextInfo {
    /// Stable opaque id used as the `cluster_id` in commands. Of the form
    /// `<source_id>::<context_name>` so the same context name in two sources
    /// stays distinct.
    pub id: String,
    pub name: String,
    pub cluster: String,
    pub user: Option<String>,
    pub namespace: Option<String>,
    pub is_current: bool,
    pub group: String,
    pub source_id: String,
    /// Path of the kubeconfig file this context came from. `None` for contexts
    /// loaded from the implicit default (which kube-rs resolves on its own).
    pub source_path: Option<PathBuf>,
}

/// Resolved descriptor for one source — the source we registered, plus the
/// final group name the UI should show. Used internally by `list_contexts`
/// and re-exposed for the watcher (so it knows what paths to watch).
#[derive(Debug, Clone)]
pub struct ResolvedSource {
    pub id: String,
    pub path: PathBuf,
    pub kind: SourceKind,
    pub group: String,
    pub enabled: bool,
    /// Populated only for `SourceKind::Ssh`. Carries the host / auth /
    /// remote-path details needed to fetch the kubeconfig over SSH.
    pub ssh: Option<SshSourceConfig>,
}

impl From<&KubeconfigSource> for ResolvedSource {
    fn from(s: &KubeconfigSource) -> Self {
        Self {
            id: s.id.clone(),
            path: s.path.clone(),
            kind: s.kind,
            group: s.effective_group(),
            enabled: s.enabled,
            ssh: s.ssh.clone(),
        }
    }
}

/// Read the default kubeconfig and every enabled user source, returning a
/// flat list of contexts tagged with their group + source.
///
/// Failures on a single source are swallowed (logged via tracing) — a broken
/// kubeconfig in one folder must not blank the whole fleet view.
pub fn list_contexts(file: &SourcesFile) -> Result<Vec<ContextInfo>> {
    let mut out: Vec<ContextInfo> = Vec::new();

    // 1. Default kubeconfig (unless the user disabled it).
    if !file.default_disabled {
        match kube::config::Kubeconfig::read() {
            Ok(kc) => append_contexts(&mut out, kc, DEFAULT_SOURCE_ID, DEFAULT_GROUP, None),
            Err(e) => tracing::warn!(error = %e, "default kubeconfig read failed"),
        }
    }

    // 2. User sources.
    for src in &file.sources {
        if !src.enabled {
            continue;
        }
        let resolved: ResolvedSource = src.into();
        match resolved.kind {
            SourceKind::File => {
                load_file_into(&mut out, &resolved.path, &resolved.id, &resolved.group);
            }
            SourceKind::Folder => {
                load_folder_into(&mut out, &resolved.path, &resolved.id, &resolved.group);
            }
            SourceKind::Ssh => {
                load_ssh_into(&mut out, src, &resolved.group);
            }
        }
    }

    // Dedup by composite id only. The id already encodes the source file
    // (`<source_id>::<context_name>`, with folder sources adding the
    // filename), so two files in the same folder that each define a context
    // named "default" are distinct ids and stay separate. A real id
    // collision means the same source got registered twice — log once at
    // debug level, don't spam warn for every benign folder duplicate.
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<ContextInfo> = Vec::with_capacity(out.len());
    for ctx in out {
        if let Some(&idx) = seen.get(&ctx.id) {
            tracing::debug!(id = %ctx.id, "duplicate context id — keeping first occurrence");
            if ctx.is_current {
                deduped[idx].is_current = true;
            }
            continue;
        }
        seen.insert(ctx.id.clone(), deduped.len());
        deduped.push(ctx);
    }

    Ok(deduped)
}

/// Resolve every enabled source (default + user). Used by the file watcher
/// so it knows what paths to monitor. SSH sources are returned too — the
/// watcher itself filters by `kind` (it can't watch a remote file path).
pub fn resolved_sources(file: &SourcesFile) -> Vec<ResolvedSource> {
    let mut out = Vec::new();
    if !file.default_disabled {
        if let Some(p) = default_kubeconfig_path() {
            out.push(ResolvedSource {
                id: DEFAULT_SOURCE_ID.to_owned(),
                path: p,
                kind: SourceKind::File,
                group: DEFAULT_GROUP.to_owned(),
                enabled: true,
                ssh: None,
            });
        }
    }
    out.extend(file.sources.iter().filter(|s| s.enabled).map(Into::into));
    out
}

/// Best-effort guess of where the default kubeconfig lives. Honors the
/// KUBECONFIG env var (first colon-separated entry only — multi-file merging
/// is rare and we'd watch all of them only if the user adds them as sources).
pub fn default_kubeconfig_path() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("KUBECONFIG") {
        if !env.is_empty() {
            // Pick the first; the rest are best handled as explicit sources.
            let sep = if cfg!(windows) { ';' } else { ':' };
            return env
                .split(sep)
                .next()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from);
        }
    }
    directories::UserDirs::new()
        .and_then(|d| d.home_dir().to_path_buf().into())
        .map(|h: PathBuf| h.join(".kube").join("config"))
}

fn append_contexts(
    out: &mut Vec<ContextInfo>,
    kc: kube::config::Kubeconfig,
    source_id: &str,
    group: &str,
    source_path: Option<&Path>,
) {
    // "Current" only makes sense for the user's default kubeconfig — every
    // user-added file typically has its own current-context line, so honoring
    // those would paint every tile as "current".
    let is_default = source_id == DEFAULT_SOURCE_ID;
    let current = if is_default {
        kc.current_context.as_deref().map(str::to_owned)
    } else {
        None
    };
    for named in kc.contexts {
        let Some(ctx) = named.context else { continue };
        out.push(ContextInfo {
            id: format!("{source_id}::{}", named.name),
            is_current: current.as_deref() == Some(named.name.as_str()),
            name: named.name,
            cluster: ctx.cluster,
            user: ctx.user,
            namespace: ctx.namespace,
            group: group.to_owned(),
            source_id: source_id.to_owned(),
            source_path: source_path.map(Path::to_path_buf),
        });
    }
}

fn load_file_into(out: &mut Vec<ContextInfo>, path: &Path, source_id: &str, group: &str) {
    match kube::config::Kubeconfig::read_from(path) {
        Ok(kc) => append_contexts(out, kc, source_id, group, Some(path)),
        Err(e) => tracing::warn!(?path, error = %e, "kubeconfig file failed to parse"),
    }
}

/// Per-process cache for folder scans. Keyed by absolute file path; entries
/// are invalidated when the file's (mtime, len) pair changes. We also cache
/// negative results (`kc = None`) so a folder full of non-kubeconfigs only
/// pays the read+sniff cost once per file. Entries for files no longer in
/// the folder are pruned at the end of each scan.
#[derive(Clone)]
struct ScanEntry {
    mtime: SystemTime,
    len: u64,
    /// `Some(kc)` for valid kubeconfigs; `None` means we already determined
    /// this file isn't one (failed sniff or parse) and should be skipped.
    kc: Option<kube::config::Kubeconfig>,
}

fn folder_cache() -> &'static Mutex<HashMap<PathBuf, ScanEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, ScanEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_folder_into(
    out: &mut Vec<ContextInfo>,
    folder: &Path,
    source_id_prefix: &str,
    group: &str,
) {
    let entries = match std::fs::read_dir(folder) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(?folder, error = %e, "kubeconfig folder unreadable");
            return;
        }
    };

    let mut seen: HashSet<PathBuf> = HashSet::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        // Cheap pre-filters — applied in order of cost (cheapest first) so a
        // folder of thousands of unrelated files exits each iteration fast.
        if !filename_is_candidate(&path) {
            continue;
        }
        if md.len() == 0 || md.len() > MAX_KUBECONFIG_BYTES {
            continue;
        }
        let mtime = md.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let len = md.len();

        seen.insert(path.clone());

        // Cache hit (positive or negative) when (mtime, len) match — this is
        // what makes a re-scan after an unrelated file change near-free, and
        // why we don't need to filter watcher events to "kubeconfig only":
        // re-running `list_contexts` on every fs tick is now cheap because
        // unchanged files reuse their cached parse.
        let cached = folder_cache()
            .lock()
            .expect("scan cache lock")
            .get(&path)
            .cloned();
        let kc = match cached {
            Some(e) if e.mtime == mtime && e.len == len => e.kc,
            _ => {
                let kc = if header_looks_like_kubeconfig(&path) {
                    match kube::config::Kubeconfig::read_from(&path) {
                        Ok(kc) => Some(kc),
                        Err(e) => {
                            tracing::debug!(?path, error = %e, "skipped non-kubeconfig file in folder");
                            None
                        }
                    }
                } else {
                    None
                };
                folder_cache().lock().expect("scan cache lock").insert(
                    path.clone(),
                    ScanEntry {
                        mtime,
                        len,
                        kc: kc.clone(),
                    },
                );
                kc
            }
        };

        let Some(kc) = kc else { continue };
        // Each file in a folder gets a child id keyed by file name; this
        // disambiguates duplicate context names *across files within the
        // same folder* via the eventual `id` (`source_id::context`).
        let stem = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_owned();
        let child_source_id = format!("{source_id_prefix}/{stem}");
        append_contexts(out, kc, &child_source_id, group, Some(&path));
    }

    // Prune entries for files that have disappeared from this folder. Other
    // folders' entries (different parent path) are untouched.
    let mut cache = folder_cache().lock().expect("scan cache lock");
    cache.retain(|p, _| !p.starts_with(folder) || seen.contains(p));
}

/// Cheap filename gate. Accepts:
///   - the literal `config` (the conventional kubeconfig name),
///   - any file ending in `.yaml`, `.yml`, `.conf`, `.kubeconfig`,
///   - any file with no extension at all (lots of cloud-vendor exports).
///
/// Rejects dotfiles (`.git`, `.DS_Store`) and obvious binary/text junk.
fn filename_is_candidate(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with('.') {
        return false;
    }
    if name.eq_ignore_ascii_case("config") {
        return true;
    }
    match path.extension().and_then(|e| e.to_str()) {
        None => true,
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "yaml" | "yml" | "conf" | "kubeconfig"
        ),
    }
}

/// Read the first ~512 bytes and check for the markers that every kubeconfig
/// has near the top. This avoids running `serde_yaml` against unrelated YAMLs
/// (helm values, k8s manifests, ansible playbooks) that happen to share a
/// folder. False positives are caught by the subsequent full parse.
fn header_looks_like_kubeconfig(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; SNIFF_BYTES];
    let n = match f.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let head = match std::str::from_utf8(&buf[..n]) {
        Ok(s) => s,
        Err(_) => return false, // binary
    };
    // Require apiVersion AND one of the kubeconfig-specific top-level keys.
    // `kind: Config` is the strongest signal but only present in some files;
    // `clusters:` / `contexts:` cover the rest.
    head.contains("apiVersion")
        && (head.contains("kind: Config")
            || head.contains("clusters:")
            || head.contains("contexts:"))
}

/// Look up a context by its composite `id` and return the kubeconfig path it
/// came from. `None` for default-source contexts (kube-rs resolves them) and
/// for SSH-source contexts (the kubeconfig is on the remote — see
/// [`ssh_for`]).
#[must_use]
pub fn source_path_for(id: &str, file: &SourcesFile) -> Option<PathBuf> {
    let (source_id, _) = id.split_once("::")?;
    if source_id == DEFAULT_SOURCE_ID {
        return None;
    }
    // Folder sources get child ids "<src_id>/<filename>"; strip the suffix to
    // find the real source, then re-derive the file path.
    if let Some((parent_id, child_name)) = source_id.split_once('/') {
        let src = file.sources.iter().find(|s| s.id == parent_id)?;
        return Some(src.path.join(child_name));
    }
    let src = file.sources.iter().find(|s| s.id == source_id)?;
    // SSH sources have a synthetic "label path" (`user@host:port`) that's not
    // a real filesystem path; refuse to hand it to file-watching / kubeconfig
    // edit code.
    if src.kind == SourceKind::Ssh {
        return None;
    }
    Some(src.path.clone())
}

/// Look up the SSH source backing an `id`, if any. Returns `(source_id,
/// SshSourceConfig)` so the caller can plumb both into `SshSession::connect`
/// (which keys keychain reads off the source id).
#[must_use]
pub fn ssh_for(id: &str, file: &SourcesFile) -> Option<(String, SshSourceConfig)> {
    let (source_id, _) = id.split_once("::")?;
    let src = file.sources.iter().find(|s| s.id == source_id)?;
    let cfg = src.ssh.as_ref()?;
    Some((src.id.clone(), cfg.clone()))
}

/// Decompose an `id` back into the context name only.
#[must_use]
pub fn context_name_from_id(id: &str) -> &str {
    id.split_once("::").map_or(id, |(_, n)| n)
}

/// Resolve the on-disk kubeconfig path for a context id. Falls back to the
/// system default when the context comes from the implicit default source
/// (where `source_path_for` returns `None`).
pub fn resolve_path_for(id: &str, file: &SourcesFile) -> Option<PathBuf> {
    source_path_for(id, file).or_else(|| {
        if id.starts_with(&format!("{DEFAULT_SOURCE_ID}::")) {
            default_kubeconfig_path()
        } else {
            None
        }
    })
}

/// Remove a single context (and its referenced cluster + user when no other
/// context still points at them) from a kubeconfig file. The file is rewritten
/// atomically — comments and unrelated formatting are not preserved (the YAML
/// is round-tripped through `serde_yaml::Value`).
///
/// Errors with `Invalid` if the file would end up with zero contexts; the
/// caller is expected to offer a "delete the file" path instead.
pub fn delete_context_in_file(path: &Path, context_name: &str) -> crate::Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&raw)?;

    let mapping = doc
        .as_mapping_mut()
        .ok_or_else(|| crate::Error::Invalid("kubeconfig is not a YAML mapping".to_owned()))?;

    let contexts_key = serde_yaml::Value::String("contexts".to_owned());
    let mut removed_cluster: Option<String> = None;
    let mut removed_user: Option<String> = None;

    let contexts = mapping
        .get_mut(&contexts_key)
        .and_then(serde_yaml::Value::as_sequence_mut)
        .ok_or_else(|| crate::Error::ContextNotFound(context_name.to_owned()))?;

    let before = contexts.len();
    contexts.retain(|entry| {
        let Some(name) = entry.get("name").and_then(serde_yaml::Value::as_str) else {
            return true;
        };
        if name != context_name {
            return true;
        }
        if let Some(ctx) = entry.get("context") {
            removed_cluster = ctx
                .get("cluster")
                .and_then(serde_yaml::Value::as_str)
                .map(str::to_owned);
            removed_user = ctx
                .get("user")
                .and_then(serde_yaml::Value::as_str)
                .map(str::to_owned);
        }
        false
    });
    if contexts.len() == before {
        return Err(crate::Error::ContextNotFound(context_name.to_owned()));
    }
    if contexts.is_empty() {
        return Err(crate::Error::Invalid(
            "removing this context would empty the kubeconfig — delete the file instead".to_owned(),
        ));
    }

    // Drop the cluster / user entries iff no remaining context references them.
    if let Some(cluster) = removed_cluster.as_deref() {
        if !context_field_still_used(mapping, "cluster", cluster) {
            prune_named(mapping, "clusters", cluster);
        }
    }
    if let Some(user) = removed_user.as_deref() {
        if !context_field_still_used(mapping, "user", user) {
            prune_named(mapping, "users", user);
        }
    }

    // Clear current-context if it pointed at the removed one.
    let current_key = serde_yaml::Value::String("current-context".to_owned());
    if mapping
        .get(&current_key)
        .and_then(serde_yaml::Value::as_str)
        == Some(context_name)
    {
        mapping.insert(current_key, serde_yaml::Value::String(String::new()));
    }

    write_yaml_atomic(path, &doc)
}

/// Set `current-context: <name>` in the kubeconfig at `path`. Errors when the
/// named context isn't present.
pub fn set_current_context_in_file(path: &Path, context_name: &str) -> crate::Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&raw)?;
    let mapping = doc
        .as_mapping_mut()
        .ok_or_else(|| crate::Error::Invalid("kubeconfig is not a YAML mapping".to_owned()))?;

    let exists = mapping
        .get(serde_yaml::Value::String("contexts".to_owned()))
        .and_then(serde_yaml::Value::as_sequence)
        .is_some_and(|seq| {
            seq.iter()
                .any(|e| e.get("name").and_then(serde_yaml::Value::as_str) == Some(context_name))
        });
    if !exists {
        return Err(crate::Error::ContextNotFound(context_name.to_owned()));
    }

    mapping.insert(
        serde_yaml::Value::String("current-context".to_owned()),
        serde_yaml::Value::String(context_name.to_owned()),
    );
    write_yaml_atomic(path, &doc)
}

fn context_field_still_used(mapping: &serde_yaml::Mapping, kind: &str, name: &str) -> bool {
    mapping
        .get(serde_yaml::Value::String("contexts".to_owned()))
        .and_then(serde_yaml::Value::as_sequence)
        .is_some_and(|seq| {
            seq.iter().any(|e| {
                e.get("context")
                    .and_then(|c| c.get(kind))
                    .and_then(serde_yaml::Value::as_str)
                    == Some(name)
            })
        })
}

fn prune_named(mapping: &mut serde_yaml::Mapping, list_key: &str, name: &str) {
    let key = serde_yaml::Value::String(list_key.to_owned());
    if let Some(seq) = mapping
        .get_mut(&key)
        .and_then(serde_yaml::Value::as_sequence_mut)
    {
        seq.retain(|e| e.get("name").and_then(serde_yaml::Value::as_str) != Some(name));
    }
}

// ─── SSH source listing ────────────────────────────────────────────────────
//
// Pulling the kubeconfig over SSH is async + slow (TCP + KEX + auth + read,
// dominated by network RTT). `list_contexts` is sync and called from a
// Tauri command on the operator's hot path — we can't block on a fresh SSH
// fetch every time the UI asks.
//
// The shape: a process-wide cache keyed by `source_id` holding the parsed
// kubeconfig + a freshness timestamp. On `load_ssh_into`:
//
//   * cache hit, fresh → append immediately, no SSH I/O.
//   * cache hit, stale → append immediately *and* kick off a background
//     refresh task that updates the cache + asks the watcher to refire.
//   * cache miss        → kick off the same background task, return nothing
//     this call. The next list (post-refresh) sees the contexts.
//
// "Stale" is `SSH_LIST_TTL`. The fleet probe runs hourly so we stay well
// under that on a normal workflow; the operator Settings page also calls
// `test_ssh_kubeconfig_source` which writes the cache directly.

/// Time-to-live for an SSH-cached kubeconfig before we refetch on the next
/// `list_contexts`. Long enough that browsing the fleet doesn't re-SSH
/// constantly, short enough that an operator who fixed something on the
/// remote sees the change within a sensible window.
const SSH_LIST_TTL: Duration = Duration::from_secs(60 * 5);

#[derive(Clone)]
struct SshCacheEntry {
    fetched_at: SystemTime,
    kubeconfig: Option<kube::config::Kubeconfig>,
    /// Last error string from a fetch attempt, if any. Logged from
    /// `list_contexts` so the operator's tracing dump shows what's wrong;
    /// surfaced more directly via the test-connection command.
    last_error: Option<String>,
}

fn ssh_cache() -> &'static Mutex<HashMap<String, SshCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SshCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// In-flight refresh tasks, keyed by source id. Prevents N concurrent SSH
/// fetches against the same host if the UI calls `list_contexts` repeatedly
/// while a refresh is already running.
fn ssh_in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Optional callback the app installs to refire the kubeconfig watcher after
/// a background SSH refresh completes. Stays a no-op in libcore tests.
type SshRefreshNotifier = Box<dyn Fn() + Send + Sync + 'static>;
fn ssh_notifier() -> &'static Mutex<Option<SshRefreshNotifier>> {
    static N: OnceLock<Mutex<Option<SshRefreshNotifier>>> = OnceLock::new();
    N.get_or_init(|| Mutex::new(None))
}

/// Install a callback that fires after every successful background SSH
/// kubeconfig refresh. The app wires this to the same "kubeconfig://changed"
/// event the file watcher uses, so SSH refreshes update the fleet exactly
/// like a local-file save would.
pub fn set_ssh_refresh_notifier<F>(f: F)
where
    F: Fn() + Send + Sync + 'static,
{
    *ssh_notifier().lock().expect("ssh notifier lock") = Some(Box::new(f));
}

fn fire_ssh_refresh_notifier() {
    if let Some(f) = ssh_notifier().lock().expect("ssh notifier lock").as_ref() {
        f();
    }
}

/// Directly seed the SSH cache (used by the "test connection" flow so a
/// successful test populates the fleet without a second round-trip).
pub fn cache_ssh_kubeconfig(source_id: &str, kc: kube::config::Kubeconfig) {
    let mut cache = ssh_cache().lock().expect("ssh cache lock");
    cache.insert(
        source_id.to_owned(),
        SshCacheEntry {
            fetched_at: SystemTime::now(),
            kubeconfig: Some(kc),
            last_error: None,
        },
    );
}

/// Drop a cache entry — called from `remove_kubeconfig_source` so a stale
/// kubeconfig doesn't keep showing up after the operator deletes the source.
pub fn forget_ssh_cache(source_id: &str) {
    ssh_cache()
        .lock()
        .expect("ssh cache lock")
        .remove(source_id);
}

fn load_ssh_into(out: &mut Vec<ContextInfo>, src: &KubeconfigSource, group: &str) {
    let Some(cfg) = src.ssh.as_ref() else {
        tracing::warn!(source_id = %src.id, "ssh source missing config — skipping");
        return;
    };
    let cached = ssh_cache()
        .lock()
        .expect("ssh cache lock")
        .get(&src.id)
        .cloned();

    let needs_refresh = match &cached {
        None => true,
        Some(entry) => entry
            .fetched_at
            .elapsed()
            .map_or(true, |age| age > SSH_LIST_TTL),
    };

    if needs_refresh {
        spawn_ssh_refresh(src.id.clone(), cfg.clone());
    }

    if let Some(SshCacheEntry {
        kubeconfig: Some(kc),
        ..
    }) = cached
    {
        // Each SSH source has exactly one kubeconfig (no folder fan-out), so
        // the source_id is used as-is — no `/<filename>` child segment.
        append_contexts(out, kc, &src.id, group, None);
    } else if let Some(SshCacheEntry {
        last_error: Some(err),
        ..
    }) = ssh_cache().lock().expect("ssh cache lock").get(&src.id)
    {
        tracing::warn!(source_id = %src.id, host = %cfg.host, error = %err, "ssh kubeconfig fetch failed");
    }
}

fn spawn_ssh_refresh(source_id: String, cfg: SshSourceConfig) {
    {
        let mut in_flight = ssh_in_flight().lock().expect("ssh in_flight lock");
        if !in_flight.insert(source_id.clone()) {
            // A refresh is already running for this source.
            return;
        }
    }

    tokio::spawn(async move {
        let result = fetch_ssh_kubeconfig(&source_id, &cfg).await;
        let entry = match result {
            Ok(kc) => SshCacheEntry {
                fetched_at: SystemTime::now(),
                kubeconfig: Some(kc),
                last_error: None,
            },
            Err(e) => {
                tracing::warn!(source_id = %source_id, host = %cfg.host, error = %e, "ssh refresh failed");
                // Preserve the last successful kubeconfig if we had one — a
                // transient connect failure shouldn't blank the fleet.
                let prior = ssh_cache()
                    .lock()
                    .expect("ssh cache lock")
                    .get(&source_id)
                    .and_then(|e| e.kubeconfig.clone());
                SshCacheEntry {
                    fetched_at: SystemTime::now(),
                    kubeconfig: prior,
                    last_error: Some(e.to_string()),
                }
            }
        };
        ssh_cache()
            .lock()
            .expect("ssh cache lock")
            .insert(source_id.clone(), entry);
        ssh_in_flight()
            .lock()
            .expect("ssh in_flight lock")
            .remove(&source_id);
        fire_ssh_refresh_notifier();
    });
}

/// SSH in, fetch the kubeconfig (auto-detect path or use override), parse it
/// out as `kube::config::Kubeconfig`. Used by the cache refresh task and by
/// the explicit "test connection" command.
pub async fn fetch_ssh_kubeconfig(
    source_id: &str,
    cfg: &SshSourceConfig,
) -> Result<kube::config::Kubeconfig> {
    let session = crate::ssh::SshSession::connect(cfg, source_id).await?;
    let path = match cfg.remote_kubeconfig.as_deref() {
        Some(p) if !p.trim().is_empty() => p.trim().to_owned(),
        _ => session.detect_kubeconfig_path().await?,
    };
    let bytes = session.read_file(&path).await?;
    session.disconnect().await;
    let kc: kube::config::Kubeconfig = serde_yaml::from_slice(&bytes)?;
    tracing::debug!(source_id, host = %cfg.host, %path, contexts = kc.contexts.len(), "ssh: fetched kubeconfig");
    Ok(kc)
}

fn write_yaml_atomic(path: &Path, doc: &serde_yaml::Value) -> crate::Result<()> {
    let serialized = serde_yaml::to_string(doc)?;
    let parent = path
        .parent()
        .ok_or_else(|| crate::Error::Invalid(format!("path has no parent: {}", path.display())))?;
    // Sibling tempfile so the rename stays on the same filesystem.
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let tmp = parent.join(format!(".{stem}.ferrisscope.tmp"));
    std::fs::write(&tmp, serialized)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
