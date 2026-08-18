//! Exec-credential preflight, and an app-owned token-cache slot for the gcloud
//! auth plugins.
//!
//! `gke-gcloud-auth-plugin` mints nothing itself: it shells out to
//! `gcloud config config-helper --format=json [--account=X]` and caches the
//! result in a file *next to the kubeconfig it resolves*, keyed on
//! `(current-context, extra_args, expiry)` — see `cred.go` upstream. Two
//! consequences drive this module.
//!
//! **One slot, N identities.** The cache path comes from
//! `filepath.Dir(clientcmd.NewDefaultPathOptions().GetDefaultFilename())`, so a
//! plain `~/.kube/config` setup gets exactly one slot for every account. A
//! machine with several gcloud accounts therefore evicts its own token on every
//! cluster switch, and each miss is a fresh `gcloud` spawn — multiplied by the
//! number of `Client`s built from one `Config`, because kube-rs mints a separate
//! `RefreshableToken` per `auth_layer()` call. Pointing the plugin at a
//! per-identity scratch kubeconfig (via a `KUBECONFIG` entry in the exec `env`
//! block, which kube-rs forwards to the child) moves the cache file into a
//! directory we own, one per identity, so the slots stop colliding.
//!
//! **The real error is invisible.** kube-rs inherits the plugin's stderr
//! whenever `interactiveMode` isn't `Never`, so an `AuthExecRun` error carries
//! an empty `stderr` and the actual cause — "Reauthentication failed. cannot
//! prompt during non-interactive execution." — goes to the app's own stderr.
//! Running the plugin ourselves once, with stderr piped, is the only way to
//! read it; a successful run also warms the slot the subsequent kube-rs spawns
//! will read, turning a spawn storm into cache hits.
//!
//! Deliberately scoped to the gcloud family: the semantics above are gcloud's,
//! and a `KUBECONFIG` we invented could change behaviour for a plugin that
//! reads it for other reasons.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use directories::ProjectDirs;
use kube::config::Kubeconfig;

use crate::cloud_identity::{command_basename, gcloud, Binding};
use crate::error::Error;

/// Wall-clock cap on our own plugin run. Sized to leave room for the apiserver
/// round trip inside the app's connect timeout: a cold `gcloud` (Python start +
/// token exchange) lands in the low seconds, and anything slower is better
/// handled by letting kube-rs try than by holding the connect open.
pub const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(8);

/// Directory holding one scratch kubeconfig per identity. The plugin writes its
/// token cache beside whichever kubeconfig it resolves, so a directory per
/// identity is a cache slot per identity.
const SLOTS_DIR: &str = "authcache";

/// One lock per cache slot, so concurrent connects sharing an identity take
/// turns at a cold slot instead of each spawning gcloud. Keyed by slot
/// directory; slotless invocations share one entry, which is the same
/// serialisation they'd want anyway (they contend on the plugin's default file).
static SLOT_LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn slot_lock(dir: Option<&Path>) -> Arc<tokio::sync::Mutex<()>> {
    let key = dir.map_or_else(|| PathBuf::from("<default>"), Path::to_path_buf);
    let table = SLOT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = match table.lock() {
        Ok(g) => g,
        // A poisoned table would only mean some earlier holder panicked; the
        // contents are still sound, and refusing to preflight over it would be
        // worse than serialising slightly wrong.
        Err(e) => e.into_inner(),
    };
    Arc::clone(guard.entry(key).or_default())
}

/// A context's exec plugin, resolved and ready to run, plus the cache slot we
/// pointed it at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedExec {
    pub command: String,
    pub args: Vec<String>,
    /// The exec `env` block as `(name, value)`, including the `KUBECONFIG` we
    /// injected when a slot was prepared.
    pub env: Vec<(String, String)>,
    /// The gcloud account this invocation authenticates as, when the context
    /// pins one. `None` means it follows `gcloud config set account`.
    pub identity: Option<String>,
    /// The exec entry's `apiVersion`, carried so our `KUBERNETES_EXEC_INFO`
    /// matches what kube-rs will send rather than a guess.
    pub api_version: Option<String>,
    /// Directory the plugin will read/write its token cache in. `None` when the
    /// slot could not be prepared — the plugin then falls back to its default
    /// location, which is exactly the pre-existing behaviour.
    pub cache_dir: Option<PathBuf>,
}

/// What one preflight run told us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreflightOutcome {
    /// Credentials produced; the cache slot now holds a live token.
    Warmed,
    /// The plugin ran and exited non-zero. `stderr` is already redacted and
    /// truncated.
    Failed { code: String, stderr: String },
    /// The binary isn't on the PATH the app sees.
    Missing,
    /// Spawn failed for some other reason, or the run outlived
    /// [`PREFLIGHT_TIMEOUT`]. Callers must treat this as "no information" and
    /// continue connecting — kube-rs gets its own attempt.
    Inconclusive(String),
}

/// Resolve `context_name`'s exec plugin, give it a private cache slot, and
/// return what a preflight needs. `None` when the context has no exec plugin or
/// the plugin isn't one of gcloud's.
///
/// Mutates `kubeconfig` in memory only: the injected `KUBECONFIG` env entry has
/// to be visible to kube-rs's own spawns, and the only channel for that is the
/// exec `env` block of the config we hand to `Config::from_custom_kubeconfig`.
/// Nothing is written back to the operator's file.
pub fn prepare(kubeconfig: &mut Kubeconfig, context_name: &str) -> Option<PreparedExec> {
    prepare_in(kubeconfig, context_name, slots_root().as_deref())
}

/// [`prepare`] against an explicit slots root, so tests never write into the
/// developer's real config directory. `None` disables the private slot.
pub fn prepare_in(
    kubeconfig: &mut Kubeconfig,
    context_name: &str,
    slots_root: Option<&Path>,
) -> Option<PreparedExec> {
    let user = kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == context_name)
        .and_then(|c| c.context.as_ref())
        .and_then(|ctx| ctx.user.clone())?;
    let exec = kubeconfig
        .auth_infos
        .iter_mut()
        .find(|a| a.name == user)
        .and_then(|a| a.auth_info.as_mut())
        .and_then(|ai| ai.exec.as_mut())?;

    let command = exec.command.clone()?;
    if !gcloud::OWNS_COMMANDS.contains(&command_basename(&command)) {
        return None;
    }
    let args = exec.args.clone().unwrap_or_default();
    let api_version = exec.api_version.clone();
    let mut env = exec_env_pairs(exec.env.as_ref());

    let identity = match gcloud::binding_for(command_basename(&command), &args, &env) {
        Some(Binding::Pinned { identity }) => Some(identity),
        _ => None,
    };

    // A failure here costs us the private slot, not the connect: the plugin
    // simply keeps using its default cache location.
    let cache_dir = match prepare_slot(slots_root, identity.as_deref()) {
        Ok(slot) => {
            set_env(exec, "KUBECONFIG", &slot.kubeconfig.to_string_lossy());
            env.retain(|(k, _)| k != "KUBECONFIG");
            env.push((
                "KUBECONFIG".to_owned(),
                slot.kubeconfig.to_string_lossy().into_owned(),
            ));
            Some(slot.dir)
        }
        Err(e) => {
            tracing::debug!(
                target: "ferrisscope::auth",
                "exec cache slot unavailable, falling back to the plugin default ({e})"
            );
            None
        }
    };

    Some(PreparedExec {
        command,
        args,
        env,
        identity,
        api_version,
        cache_dir,
    })
}

/// Run the plugin once, with stdin closed and stderr captured.
///
/// Stdin is `null` rather than inherited: a GUI process has nothing useful
/// there, and an inherited-but-dead stdin is what makes gcloud believe it may
/// prompt and then fail with a message no one sees.
pub async fn preflight(prepared: &PreparedExec) -> PreflightOutcome {
    preflight_with_budget(prepared, PREFLIGHT_TIMEOUT).await
}

/// [`preflight`] with the wall-clock cap injected, so the timeout arm is
/// testable without a multi-second test.
pub async fn preflight_with_budget(prepared: &PreparedExec, budget: Duration) -> PreflightOutcome {
    // One run per slot at a time. Connecting a fleet (or several tabs) fires
    // parallel connects, and without this each one misses the same cold slot and
    // spawns its own `gcloud` — the storm this module exists to remove. The
    // waiters still run the plugin, but by then the slot is warm, so they hit the
    // cache instead of gcloud (measured ~3ms vs ~1.2s) and the plugin itself
    // decides whether the token is still good — no expiry parsing here.
    let lock = slot_lock(prepared.cache_dir.as_deref());
    let _guard = lock.lock().await;

    #[cfg(target_os = "macos")]
    nudge_tcc_consent(prepared).await;

    let mut cmd = tokio::process::Command::new(&prepared.command);
    cmd.args(&prepared.args)
        .envs(prepared.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .env(
            "KUBERNETES_EXEC_INFO",
            exec_info(prepared.api_version.as_deref()),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    match tokio::time::timeout(budget, cmd.output()).await {
        Err(_) => {
            PreflightOutcome::Inconclusive(format!("timed out after {}ms", budget.as_millis()))
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => PreflightOutcome::Missing,
        Ok(Err(e)) => PreflightOutcome::Inconclusive(e.to_string()),
        Ok(Ok(out)) if out.status.success() => PreflightOutcome::Warmed,
        Ok(Ok(out)) => {
            let raw = if out.stderr.is_empty() {
                String::from_utf8_lossy(&out.stdout)
            } else {
                String::from_utf8_lossy(&out.stderr)
            };
            PreflightOutcome::Failed {
                code: out
                    .status
                    .code()
                    .map_or_else(|| out.status.to_string(), |c| c.to_string()),
                stderr: redact_and_truncate(&raw),
            }
        }
    }
}

/// How long the consent read may hold up a preflight. The read blocks for as
/// long as the dialog is on screen, and an unanswered dialog must not hang the
/// connect forever — on timeout the spawn proceeds, fails, and the
/// blocked-plugin note carries the remedies instead.
#[cfg(target_os = "macos")]
const CONSENT_PROMPT_TIMEOUT: Duration = Duration::from_mins(1);

/// Resolve a command the way the spawn will: paths as given, bare names
/// through `path_var`. Canonicalized, so a symlink into a protected folder is
/// judged by where it points, not where it sits.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn resolve_command(command: &str, path_var: Option<&str>) -> Option<PathBuf> {
    let p = Path::new(command);
    if p.components().count() > 1 {
        return p.canonicalize().ok();
    }
    std::env::split_paths(path_var?)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| {
            dir.join(command)
                .canonicalize()
                .ok()
                .filter(|c| c.is_file())
        })
}

/// Directories a consent-nudging read should touch before this preflight: the
/// parent of every candidate binary the spawn will involve. Candidates are
/// the plugin itself and `gcloud`, which the plugin shells out to — either
/// alone can be the one inside a protected folder.
///
/// Deliberately *not* filtered against a list of protected locations: TCC's
/// coverage is per-OS-release and wider than the well-known trio (Downloads /
/// Desktop / Documents also come as iCloud mirrors, network shares, removable
/// volumes). Reading an unprotected directory is a no-op costing microseconds,
/// so the OS itself gets to be the judge of whether a prompt is due.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn consent_read_targets(prepared: &PreparedExec) -> Vec<PathBuf> {
    // The spawn sees the exec block's env layered over ours, so a PATH there
    // wins for resolution too.
    let path_var = prepared
        .env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var("PATH").ok());
    let mut targets: Vec<PathBuf> = [prepared.command.as_str(), "gcloud"]
        .iter()
        .filter_map(|cmd| resolve_command(cmd, path_var.as_deref()))
        .filter_map(|bin| bin.parent().map(Path::to_path_buf))
        .collect();
    targets.dedup();
    targets
}

/// Fire the TCC consent prompt for a gated SDK location, bounded by
/// [`CONSENT_PROMPT_TIMEOUT`]. Executing a binary inside a TCC-protected
/// folder from a GUI app fails with EPERM *without* showing the prompt, while
/// a plain directory read from the app process *does* show it — so read the
/// directories the spawn will involve first. Unprotected paths return
/// instantly and prompt nothing. Best-effort by design: every failure mode
/// ends in "the spawn proceeds and its own error is handled".
#[cfg(target_os = "macos")]
async fn nudge_tcc_consent(prepared: &PreparedExec) {
    let targets = consent_read_targets(prepared);
    if targets.is_empty() {
        return;
    }
    tracing::debug!(
        target: "ferrisscope::auth",
        ?targets,
        "touching the auth plugin's directories so a TCC consent prompt can fire"
    );
    let read = tokio::task::spawn_blocking(move || {
        for dir in targets {
            // Consume one entry: opening the directory alone may not count as
            // an access for TCC's purposes.
            let _ = std::fs::read_dir(&dir).map(|mut it| it.next());
        }
    });
    if tokio::time::timeout(CONSENT_PROMPT_TIMEOUT, read)
        .await
        .is_err()
    {
        tracing::info!(
            target: "ferrisscope::auth",
            "consent prompt unanswered after {}s — continuing without it",
            CONSENT_PROMPT_TIMEOUT.as_secs()
        );
    }
}

/// Turn a [`PreflightOutcome::Failed`] into the most specific error we can
/// justify. A lapsed cloud session is its own variant because the remedy
/// (interactive login) is nothing like the remedy for a broken plugin.
#[must_use]
pub fn failure_error(prepared: &PreparedExec, code: String, stderr: String) -> Error {
    match gcloud::classify_exec_failure(&stderr) {
        gcloud::ExecFailure::ReauthRequired => Error::ExecReauthRequired {
            command: prepared.command.clone(),
            account: prepared.identity.clone(),
            message: stderr,
        },
        gcloud::ExecFailure::ExecBlocked => Error::ExecPluginBlocked {
            command: prepared.command.clone(),
            path: gcloud::blocked_path(&stderr),
            message: stderr,
        },
        _ => Error::ExecPluginFailed {
            command: prepared.command.clone(),
            code,
            stderr,
        },
    }
}

/// Every token cache file we own. Callers that invalidate credentials (an
/// identity pin) must clear these too: they are as capable of holding a token
/// minted under the previous identity as the plugin's default slot is.
///
/// # Errors
///
/// Propagates I/O errors other than a missing file or missing root.
pub fn clear_cache_slots() -> std::io::Result<()> {
    let Some(root) = slots_root() else {
        return Ok(());
    };
    clear_cache_slots_at(&root)
}

/// [`clear_cache_slots`] against an explicit root.
///
/// # Errors
///
/// Propagates I/O errors other than a missing file or missing root.
pub fn clear_cache_slots_at(root: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let cache = entry.path().join(gcloud::PLUGIN_CACHE_FILE);
        match std::fs::remove_file(&cache) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// `<config>/authcache`. `None` when no config directory resolves.
#[must_use]
pub fn slots_root() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope").map(|p| p.config_dir().join(SLOTS_DIR))
}

struct Slot {
    dir: PathBuf,
    kubeconfig: PathBuf,
}

/// Create the identity's slot directory and (re)write its scratch kubeconfig.
///
/// The file exists for two properties the plugin reads out of it: the directory
/// it lives in (where the token cache lands) and its `current-context` (part of
/// the cache key). It carries no cluster, user, or credential material, so
/// there is nothing here to keep in sync with the operator's kubeconfig.
fn prepare_slot(root: Option<&Path>, identity: Option<&str>) -> std::io::Result<Slot> {
    let root = root.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no config directory for this platform",
        )
    })?;
    let dir = root.join(slot_name(identity));
    // The plugin drops a live access token in here, so the directory is as
    // sensitive as the file: created 0700 rather than left at whatever the
    // process umask says.
    create_private_dir(root)?;
    create_private_dir(&dir)?;
    let kubeconfig = dir.join("config");
    crate::atomic_write::atomic_write_sync_mode(
        &kubeconfig,
        scratch_kubeconfig().as_bytes(),
        Some(0o600),
    )?;
    Ok(Slot { dir, kubeconfig })
}

/// `mkdir -p` with owner-only permissions on unix. Idempotent, and tightens an
/// existing directory that was created before this rule.
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Filesystem-safe directory name for an identity. Unpinned contexts share one
/// slot ("active"), which matches what they share upstream: a single cache entry
/// keyed on an empty `extra_args`.
fn slot_name(identity: Option<&str>) -> String {
    let Some(identity) = identity else {
        return "active".to_owned();
    };
    let cleaned: String = identity
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.');
    if trimmed.is_empty() {
        "active".to_owned()
    } else {
        // Long identities (assumed-role ARNs elsewhere in this family) must not
        // blow past a filesystem's per-component limit.
        trimmed.chars().take(80).collect()
    }
}

/// Context name written into every slot's scratch kubeconfig.
///
/// **Constant on purpose.** The plugin's cache is only valid while the
/// `current-context` it recorded still equals the one it resolves now, and it
/// compares them for equality — the value itself is never used for anything
/// else. Writing the *target* context here would therefore invalidate the slot
/// on every switch between two clusters on the same account, which is the
/// common case and exactly the gcloud spawn this module exists to avoid. A
/// gcloud access token is account-scoped, not cluster-scoped, so one warm token
/// per identity is not just cheaper but correct.
const SLOT_CONTEXT: &str = "ferrisscope-auth-slot";

/// The minimum client-go will load: `GetStartingConfig` only needs the document
/// to parse for `current-context` to come back set.
fn scratch_kubeconfig() -> String {
    let doc = serde_json::json!({
        "apiVersion": "v1",
        "kind": "Config",
        "preferences": {},
        "clusters": [],
        "contexts": [],
        "users": [],
        "current-context": SLOT_CONTEXT,
    });
    serde_yaml::to_string(&doc).unwrap_or_else(|_| {
        // `Value` serialization cannot fail, but a panic here would take a
        // connect down for a cache optimisation.
        format!("apiVersion: v1\nkind: Config\ncurrent-context: {SLOT_CONTEXT}\n")
    })
}

/// The `KUBERNETES_EXEC_INFO` client-go would pass. `interactive: false` is the
/// honest value — we closed stdin.
fn exec_info(api_version: Option<&str>) -> String {
    let api_version = api_version.unwrap_or("client.authentication.k8s.io/v1beta1");
    serde_json::json!({
        "kind": "ExecCredential",
        "apiVersion": api_version,
        "spec": { "interactive": false },
    })
    .to_string()
}

fn exec_env_pairs(env: Option<&Vec<HashMap<String, String>>>) -> Vec<(String, String)> {
    env.map(|entries| {
        entries
            .iter()
            .filter_map(|e| Some((e.get("name")?.clone(), e.get("value")?.clone())))
            .collect()
    })
    .unwrap_or_default()
}

/// Set (or replace) one `{name, value}` entry in an exec `env` block.
fn set_env(exec: &mut kube::config::ExecConfig, name: &str, value: &str) {
    let entries = exec.env.get_or_insert_with(Vec::new);
    entries.retain(|e| e.get("name").map(String::as_str) != Some(name));
    let mut entry = HashMap::new();
    entry.insert("name".to_owned(), name.to_owned());
    entry.insert("value".to_owned(), value.to_owned());
    entries.push(entry);
}

/// Make a plugin's raw stderr safe and compact for display: drop lines that
/// look like they carry a credential (token JSON, JWT/base64 runs, Bearer
/// headers), strip blank lines, and cap total length. Conservative on what it
/// flags as secret so genuine error text ("reauth required", "invalid
/// credentials") survives.
#[must_use]
pub fn redact_and_truncate(s: &str) -> String {
    const MAX: usize = 1500;
    let mut lines: Vec<&str> = Vec::new();
    let mut redacted_any = false;
    for line in s.lines() {
        let t = line.trim_end();
        if t.is_empty() {
            continue;
        }
        if looks_secretish(t) {
            redacted_any = true;
            continue;
        }
        lines.push(t);
    }
    let mut out = lines.join("\n");
    if redacted_any {
        out.push_str("\n[credential material redacted]");
    }
    let out = out.trim().to_string();
    let mut out = if out.len() > MAX {
        let mut end = MAX;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        let mut truncated = out[..end].to_string();
        truncated.push_str(" … (truncated)");
        truncated
    } else {
        out
    };
    if out.is_empty() {
        out = "(plugin produced no output)".to_string();
    }
    out
}

/// Heuristic: does this line likely contain a secret value (not merely the word
/// "credentials")? Catches token JSON fields, `Bearer` headers, and long
/// base64url/JWT runs. Excludes `/` and `.` from the run alphabet so file paths
/// and dotted hostnames don't trip it.
fn looks_secretish(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if lower.contains("\"token\"")
        || lower.contains("token=")
        || lower.contains("bearer ")
        || lower.contains("id_token")
        || lower.contains("access_token")
        || lower.contains("\"password\"")
        || lower.contains("client-secret")
    {
        return true;
    }
    let mut run = 0usize;
    let mut max_run = 0usize;
    for c in line.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '_' | '-' | '=') {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 0;
        }
    }
    max_run >= 40
}

#[cfg(test)]
mod tests {
    use super::*;

    const KUBECONFIG: &str = r"
apiVersion: v1
kind: Config
current-context: gke_p_r_c
clusters:
- name: c
  cluster:
    server: https://example.invalid
contexts:
- name: gke_p_r_c
  context:
    cluster: c
    user: u
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      args: ['--account=a@example.com']
      interactiveMode: IfAvailable
      provideClusterInfo: true
";

    fn kc(yaml: &str) -> Kubeconfig {
        serde_yaml::from_str(yaml).expect("parse kubeconfig")
    }

    fn injected_kubeconfig(kubeconfig: &Kubeconfig) -> Option<String> {
        let exec = kubeconfig.auth_infos[0].auth_info.as_ref()?.exec.as_ref()?;
        exec.env.as_ref()?.iter().find_map(|e| {
            (e.get("name").map(String::as_str) == Some("KUBECONFIG")).then(|| e["value"].clone())
        })
    }

    /// A slots root inside a tempdir: `prepare` writes files, and a test that
    /// wrote into the developer's real config directory would be a bug.
    fn root() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn prepare_pins_the_identity_and_injects_a_private_slot() {
        let root = root();
        let mut kubeconfig = kc(KUBECONFIG);
        let prepared =
            prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path())).expect("prepared");

        assert_eq!(prepared.command, "gke-gcloud-auth-plugin");
        assert_eq!(prepared.identity.as_deref(), Some("a@example.com"));

        // The env the child gets must agree with the env written into the
        // kubeconfig kube-rs will spawn from — they are the same cache slot.
        let injected = injected_kubeconfig(&kubeconfig).expect("KUBECONFIG injected");
        let from_pairs = prepared
            .env
            .iter()
            .find(|(k, _)| k == "KUBECONFIG")
            .map(|(_, v)| v.clone())
            .expect("KUBECONFIG in pairs");
        assert_eq!(injected, from_pairs);

        let dir = prepared.cache_dir.expect("cache dir");
        assert_eq!(Path::new(&injected).parent(), Some(dir.as_path()));
        assert!(dir.ends_with("a@example.com"), "slot per identity: {dir:?}");
    }

    #[test]
    fn the_scratch_kubeconfig_parses_and_names_a_context() {
        let body = scratch_kubeconfig();
        let parsed: Kubeconfig = serde_yaml::from_str(&body).expect("scratch parses");
        assert_eq!(parsed.current_context.as_deref(), Some(SLOT_CONTEXT));
        assert!(parsed.clusters.is_empty());
        assert!(parsed.auth_infos.is_empty());
    }

    #[test]
    fn every_cluster_on_one_account_shares_the_same_warm_token() {
        // Measured: a slot whose `current-context` changes costs a full gcloud
        // spawn (~1.2s) on every switch, because that field is half the plugin's
        // cache key. Two contexts on one account must therefore produce byte
        // identical slots — otherwise each switch invalidates the other's token
        // and this module makes things slower, not faster.
        let root = root();
        let mut a = kc(KUBECONFIG);
        let mut b = kc(&KUBECONFIG.replace("gke_p_r_c", "gke_p_r_other"));
        let sa = prepare_in(&mut a, "gke_p_r_c", Some(root.path())).expect("prepared");
        let sb = prepare_in(&mut b, "gke_p_r_other", Some(root.path())).expect("prepared");

        assert_eq!(sa.cache_dir, sb.cache_dir, "same account, same slot");
        let path = sa.cache_dir.expect("cache dir").join("config");
        let body = std::fs::read_to_string(&path).expect("read scratch");
        assert!(
            !body.contains("gke_p_r_c") && !body.contains("gke_p_r_other"),
            "no target context may reach the cache key: {body}"
        );
    }

    #[test]
    fn unpinned_contexts_share_one_slot() {
        let yaml = KUBECONFIG.replace("      args: ['--account=a@example.com']\n", "");
        let root = root();
        let mut kubeconfig = kc(&yaml);
        let prepared =
            prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path())).expect("prepared");
        assert_eq!(prepared.identity, None);
        assert!(prepared.args.is_empty());
        assert!(
            prepared.cache_dir.expect("cache dir").ends_with("active"),
            "an unpinned context has no identity to key a slot on"
        );
    }

    #[test]
    fn non_gcloud_plugins_are_left_completely_alone() {
        let yaml = KUBECONFIG.replace("gke-gcloud-auth-plugin", "aws-iam-authenticator");
        let root = root();
        let mut kubeconfig = kc(&yaml);
        assert_eq!(
            prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path())),
            None
        );
        assert_eq!(
            injected_kubeconfig(&kubeconfig),
            None,
            "a foreign plugin's env must not gain a KUBECONFIG we invented"
        );
    }

    #[test]
    fn contexts_without_an_exec_block_are_skipped() {
        let yaml = KUBECONFIG
            .split("    exec:")
            .next()
            .expect("split")
            .to_owned()
            + "    token: abc\n";
        let root = root();
        let mut kubeconfig = kc(&yaml);
        assert_eq!(
            prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path())),
            None
        );
    }

    #[test]
    fn a_prepared_slot_replaces_a_kubeconfig_supplied_kubeconfig_var() {
        let yaml = KUBECONFIG.replace(
            "      interactiveMode: IfAvailable\n",
            "      interactiveMode: IfAvailable\n      env:\n      - name: KUBECONFIG\n        value: /somewhere/else\n",
        );
        let root = root();
        let mut kubeconfig = kc(&yaml);
        let prepared =
            prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path())).expect("prepared");
        let count = prepared
            .env
            .iter()
            .filter(|(k, _)| k == "KUBECONFIG")
            .count();
        assert_eq!(count, 1, "exactly one KUBECONFIG wins");
        assert_ne!(
            prepared
                .env
                .iter()
                .find(|(k, _)| k == "KUBECONFIG")
                .map(|(_, v)| v.as_str()),
            Some("/somewhere/else")
        );
    }

    #[test]
    fn a_context_still_connects_when_no_slot_can_be_prepared() {
        let mut kubeconfig = kc(KUBECONFIG);
        let prepared = prepare_in(&mut kubeconfig, "gke_p_r_c", None).expect("prepared");
        assert_eq!(prepared.cache_dir, None);
        assert_eq!(
            injected_kubeconfig(&kubeconfig),
            None,
            "with no slot there is nothing to point the plugin at"
        );
        // The plugin is still runnable — it just uses its own default cache.
        assert_eq!(prepared.command, "gke-gcloud-auth-plugin");
    }

    #[test]
    fn clearing_slots_drops_every_cached_token_and_keeps_the_slots() {
        let root = root();
        let mut kubeconfig = kc(KUBECONFIG);
        let a = prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path()))
            .expect("prepared")
            .cache_dir
            .expect("cache dir");
        let cache = a.join(gcloud::PLUGIN_CACHE_FILE);
        std::fs::write(&cache, "{}").expect("write cache");
        let scratch = a.join("config");

        clear_cache_slots_at(root.path()).expect("clear");

        assert!(
            !cache.exists(),
            "a token minted as the old identity must go"
        );
        assert!(
            scratch.exists(),
            "the scratch kubeconfig is not a credential — dropping it would just \
             force a rewrite"
        );
    }

    #[test]
    fn clearing_slots_is_fine_when_there_is_nothing_to_clear() {
        let root = root();
        clear_cache_slots_at(root.path()).expect("empty root");
        clear_cache_slots_at(&root.path().join("never-created")).expect("missing root");
    }

    #[cfg(unix)]
    #[test]
    fn slot_directories_are_owner_only() {
        // The plugin writes a live access token into this directory, so the
        // directory is as sensitive as the file inside it.
        use std::os::unix::fs::PermissionsExt;
        let root = root();
        let mut kubeconfig = kc(KUBECONFIG);
        let dir = prepare_in(&mut kubeconfig, "gke_p_r_c", Some(root.path()))
            .expect("prepared")
            .cache_dir
            .expect("cache dir");
        for path in [root.path(), dir.as_path()] {
            let mode = std::fs::metadata(path).expect("stat").permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{path:?} is group/world accessible");
        }
        let file = std::fs::metadata(dir.join("config")).expect("stat");
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn slot_names_stay_filesystem_safe() {
        assert_eq!(slot_name(None), "active");
        assert_eq!(slot_name(Some("a@example.com")), "a@example.com");
        assert_eq!(slot_name(Some("../../etc/passwd")), "_.._etc_passwd");
        assert_eq!(slot_name(Some("..")), "active");
        assert_eq!(slot_name(Some("a/b\\c:d")), "a_b_c_d");
        assert_eq!(slot_name(Some(&"x".repeat(200))).len(), 80);
    }

    #[test]
    fn exec_info_declares_a_non_interactive_run() {
        let v: serde_json::Value =
            serde_json::from_str(&exec_info(Some("client.authentication.k8s.io/v1")))
                .expect("json");
        assert_eq!(v["apiVersion"], "client.authentication.k8s.io/v1");
        assert_eq!(v["spec"]["interactive"], false);
    }

    #[test]
    fn redact_and_truncate_keeps_error_text_drops_secrets() {
        let raw = "ERROR: (gcloud.auth) reauth required\n\
                   invalid credentials for project foo\n\
                   token=eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1Njc4OTABCDEFGH\n";
        let out = redact_and_truncate(raw);
        // Human-readable diagnostics survive…
        assert!(out.contains("reauth required"));
        // …including a line that merely mentions "credentials" (no secret value).
        assert!(out.contains("invalid credentials for project foo"));
        // …but the token line is gone, replaced by a marker.
        assert!(!out.contains("eyJhbGci"));
        assert!(!out.contains("token="));
        assert!(out.contains("[credential material redacted]"));
    }

    #[test]
    fn redact_and_truncate_caps_length_and_handles_empty() {
        // Long but non-secret text (spaces break the base64-run heuristic).
        let long = "err line ".repeat(1000);
        let out = redact_and_truncate(&long);
        assert!(out.len() <= 1500 + 32);
        assert!(out.ends_with("… (truncated)"));
        assert_eq!(
            redact_and_truncate("   \n  \n"),
            "(plugin produced no output)"
        );
    }

    #[test]
    fn looks_secretish_flags_tokens_not_paths() {
        assert!(looks_secretish("\"token\": \"abc\""));
        assert!(looks_secretish("Authorization: Bearer abc123"));
        assert!(looks_secretish(&format!("blob {}", "A".repeat(45))));
        // File paths and dotted hostnames must NOT be flagged.
        assert!(!looks_secretish(
            "/Users/me/.config/gcloud/application_default_credentials.json"
        ));
        assert!(!looks_secretish(
            "could not reach oauth2.googleapis.com:443"
        ));
        assert!(!looks_secretish("invalid credentials"));
    }

    #[cfg(unix)]
    mod consent {
        use super::*;

        #[test]
        fn resolve_follows_path_and_symlinks() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let real = tmp.path().join("home/Downloads/sdk/bin");
            std::fs::create_dir_all(&real).expect("mkdir");
            std::fs::write(real.join("gcloud"), "#!/bin/sh\n").expect("write");
            let elsewhere = tmp.path().join("usr-local-bin");
            std::fs::create_dir_all(&elsewhere).expect("mkdir");
            #[cfg(unix)]
            std::os::unix::fs::symlink(real.join("gcloud"), elsewhere.join("gcloud"))
                .expect("symlink");

            let path_var = elsewhere.to_string_lossy().into_owned();
            // A bare name resolves through PATH, and the symlink is judged by
            // where it points — the client's `/usr/local/bin` → Downloads case.
            #[cfg(unix)]
            {
                let resolved = resolve_command("gcloud", Some(&path_var)).expect("resolved");
                let canon_home = tmp.path().join("home").canonicalize().expect("canon");
                assert!(resolved.starts_with(canon_home.join("Downloads")));
            }
            assert_eq!(resolve_command("gcloud", None), None);
            assert_eq!(resolve_command("not-there", Some(&path_var)), None);
        }

        #[test]
        fn targets_are_the_dirs_of_every_binary_the_spawn_involves() {
            let tmp = tempfile::tempdir().expect("tempdir");
            // Plugin and gcloud in *different* directories — both matter: the
            // plugin can sit somewhere sane while the gcloud it shells out to
            // is the one inside a gated folder (the client's case, inverted).
            let plugin_bin = tmp.path().join("Downloads/google-cloud-sdk/bin");
            std::fs::create_dir_all(&plugin_bin).expect("mkdir");
            std::fs::write(plugin_bin.join("gke-gcloud-auth-plugin"), "").expect("write");
            let gcloud_bin = tmp.path().join("iCloud/sdk/bin");
            std::fs::create_dir_all(&gcloud_bin).expect("mkdir");
            std::fs::write(gcloud_bin.join("gcloud"), "").expect("write");

            let p = PreparedExec {
                command: plugin_bin
                    .join("gke-gcloud-auth-plugin")
                    .to_string_lossy()
                    .into_owned(),
                args: Vec::new(),
                // `gcloud` resolves through the exec env's PATH, which wins
                // over the process's own.
                env: vec![("PATH".to_owned(), gcloud_bin.to_string_lossy().into_owned())],
                identity: None,
                api_version: None,
                cache_dir: None,
            };
            let targets = consent_read_targets(&p);
            assert_eq!(
                targets,
                vec![
                    plugin_bin.canonicalize().expect("canon plugin bin"),
                    gcloud_bin.canonicalize().expect("canon gcloud bin"),
                ]
            );

            // Both in one directory → one read, not two. No protected-folder
            // list is consulted: the OS judges, a plain dir read is free.
            let p2 = PreparedExec {
                command: gcloud_bin.join("gcloud").to_string_lossy().into_owned(),
                ..p
            };
            assert_eq!(
                consent_read_targets(&p2),
                vec![gcloud_bin.canonicalize().expect("canon gcloud bin")]
            );
        }
    }

    mod spawned {
        use super::*;

        /// A stand-in plugin, expressed as `sh -c <body>` rather than a script
        /// we chmod and exec: writing an executable and immediately exec'ing it
        /// races other threads' `fork`/`exec` (an inherited write fd makes the
        /// exec fail with ETXTBSY), which is a flake in a test, not a behaviour
        /// worth exercising.
        fn plugin(body: &str) -> PreparedExec {
            PreparedExec {
                command: "/bin/sh".to_owned(),
                args: vec!["-c".to_owned(), body.to_owned()],
                env: Vec::new(),
                identity: Some("a@example.com".to_owned()),
                api_version: Some("client.authentication.k8s.io/v1beta1".to_owned()),
                cache_dir: None,
            }
        }

        #[tokio::test]
        async fn success_is_warmed() {
            let p = plugin("echo '{\"kind\":\"ExecCredential\"}'");
            assert_eq!(preflight(&p).await, PreflightOutcome::Warmed);
        }

        #[tokio::test]
        async fn reauth_stderr_survives_to_the_error() {
            let p = plugin(
                "echo 'ERROR: (gcloud.config.config-helper) There was a problem refreshing your \
                 current auth tokens: Reauthentication failed. cannot prompt during \
                 non-interactive execution.' 1>&2; exit 1",
            );
            let out = preflight(&p).await;
            let PreflightOutcome::Failed { code, stderr } = out else {
                panic!("expected Failed, got {out:?}");
            };
            assert_eq!(code, "1");
            match failure_error(&p, code, stderr) {
                Error::ExecReauthRequired {
                    account, message, ..
                } => {
                    assert_eq!(account.as_deref(), Some("a@example.com"));
                    assert!(message.contains("Reauthentication failed"));
                }
                other => panic!("expected ExecReauthRequired, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn a_tcc_blocked_helper_maps_to_the_blocked_error() {
            // The client-reported macOS shape: the plugin runs, its gcloud
            // helper is refused by the OS, and the plugin wraps the shell's
            // report. Must not fall into the generic bucket — the note built
            // from this variant is the one carrying the remedies.
            let p = plugin(
                "echo 'print credential failed with error: Failed to retrieve access token:: \
                 failure while executing gcloud: exit status 126 (err: /bin/sh: \
                 /Users/u/Downloads/google-cloud-sdk/bin/gcloud: Operation not permitted' 1>&2; \
                 exit 1",
            );
            let out = preflight(&p).await;
            let PreflightOutcome::Failed { code, stderr } = out else {
                panic!("expected Failed, got {out:?}");
            };
            match failure_error(&p, code, stderr) {
                Error::ExecPluginBlocked { path, message, .. } => {
                    assert_eq!(
                        path.as_deref(),
                        Some("/Users/u/Downloads/google-cloud-sdk/bin/gcloud")
                    );
                    assert!(message.contains("Operation not permitted"));
                }
                other => panic!("expected ExecPluginBlocked, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn other_failures_stay_generic() {
            let p = plugin("echo 'boom: bad config' 1>&2; exit 3");
            let out = preflight(&p).await;
            let PreflightOutcome::Failed { code, stderr } = out else {
                panic!("expected Failed, got {out:?}");
            };
            assert_eq!(code, "3");
            assert!(matches!(
                failure_error(&p, code, stderr),
                Error::ExecPluginFailed { .. }
            ));
        }

        #[tokio::test]
        async fn a_missing_binary_is_reported_as_missing() {
            let dir = tempfile::tempdir().expect("tempdir");
            let mut p = plugin("true");
            p.command = dir
                .path()
                .join("not-installed")
                .to_string_lossy()
                .into_owned();
            p.args.clear();
            assert_eq!(preflight(&p).await, PreflightOutcome::Missing);
        }

        #[tokio::test]
        async fn stdout_is_used_when_the_plugin_writes_its_error_there() {
            let p = plugin("echo 'failed on stdout'; exit 1");
            let out = preflight(&p).await;
            let PreflightOutcome::Failed { stderr, .. } = out else {
                panic!("expected Failed, got {out:?}");
            };
            assert!(stderr.contains("failed on stdout"));
        }

        /// The whole point of the slot: whatever `prepare` injected has to be
        /// what the child actually resolves its cache path from.
        #[tokio::test]
        async fn the_injected_kubeconfig_reaches_the_child() {
            let mut p = plugin("echo \"$KUBECONFIG\" 1>&2; exit 1");
            p.env = vec![("KUBECONFIG".to_owned(), "/slot/config".to_owned())];
            let out = preflight(&p).await;
            let PreflightOutcome::Failed { stderr, .. } = out else {
                panic!("expected Failed, got {out:?}");
            };
            assert_eq!(stderr, "/slot/config");
        }

        /// `KUBERNETES_EXEC_INFO` is what client-go passes; a plugin that reads
        /// it must see a well-formed document from us too.
        #[tokio::test]
        async fn exec_info_is_passed_to_the_child() {
            let p = plugin("echo \"$KUBERNETES_EXEC_INFO\" 1>&2; exit 1");
            let out = preflight(&p).await;
            let PreflightOutcome::Failed { stderr, .. } = out else {
                panic!("expected Failed, got {out:?}");
            };
            let v: serde_json::Value = serde_json::from_str(&stderr).expect("valid exec info");
            assert_eq!(v["kind"], "ExecCredential");
            assert_eq!(v["spec"]["interactive"], false);
        }

        /// The invariant that keeps a working cluster reachable: a plugin
        /// slower than the budget must report "no information", never a failure
        /// the connect aborts on.
        #[tokio::test]
        async fn an_overrunning_plugin_is_inconclusive_not_fatal() {
            let p = plugin("sleep 30");
            let out = preflight_with_budget(&p, Duration::from_millis(150)).await;
            match out {
                PreflightOutcome::Inconclusive(why) => assert!(
                    why.contains("timed out"),
                    "the reason must say what happened: {why}"
                ),
                other => panic!("a hung plugin must not abort a connect, got {other:?}"),
            }
        }

        /// Concurrent connects sharing an identity (a fleet, or several tabs)
        /// must take turns at the slot instead of each spawning gcloud.
        #[tokio::test]
        async fn concurrent_preflights_on_one_slot_are_serialised() {
            let dir = tempfile::tempdir().expect("tempdir");
            let log = dir.path().join("overlaps");
            // Each run claims its own marker, then counts how many exist. Under
            // the lock the answer is always 1. Counting (rather than testing for
            // one shared marker) makes the detection deterministic: without the
            // lock every run holds its marker for the whole sleep, so any
            // overlapping pair sees at least two.
            let mut p = plugin(&format!(
                "d={d}; : > $d/mark.$$; n=$(ls $d/mark.* | wc -l); \
                 [ \"$n\" -gt 1 ] && echo overlap >> {l}; sleep 0.15; rm -f $d/mark.$$; exit 0",
                d = dir.path().display(),
                l = log.display()
            ));
            p.cache_dir = Some(dir.path().to_path_buf());

            let runs = futures::future::join_all((0..4).map(|_| preflight(&p))).await;
            assert!(
                runs.iter().all(|r| *r == PreflightOutcome::Warmed),
                "every run should succeed: {runs:?}"
            );
            assert!(
                !log.exists(),
                "two plugin runs overlapped on one slot: {:?}",
                std::fs::read_to_string(&log)
            );
        }

        /// Different identities must not serialise against each other — they
        /// own different slots and can mint in parallel.
        #[tokio::test]
        async fn different_slots_do_not_block_each_other() {
            let a = tempfile::tempdir().expect("tempdir");
            let b = tempfile::tempdir().expect("tempdir");
            let mut pa = plugin("sleep 0.3");
            pa.cache_dir = Some(a.path().to_path_buf());
            let mut pb = plugin("sleep 0.3");
            pb.cache_dir = Some(b.path().to_path_buf());

            let started = tokio::time::Instant::now();
            let _ = tokio::join!(preflight(&pa), preflight(&pb));
            assert!(
                started.elapsed() < Duration::from_millis(550),
                "two identities ran back to back instead of together: {:?}",
                started.elapsed()
            );
        }
    }
}
