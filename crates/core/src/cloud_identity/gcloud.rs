//! Google Cloud: account discovery, the "wrong gcloud account" diagnosis, and
//! the `--account` pin.
//!
//! A kubeconfig context whose exec entry is `gke-gcloud-auth-plugin` **without**
//! `--account=<x>` authenticates as whatever `gcloud config set account` last
//! selected. On top of that, the plugin keeps a single global token cache at
//! `~/.kube/gke_gcloud_auth_plugin_cache`:
//!
//! ```json
//! { "current_context": "...", "access_token": "...", "token_expiry": "...", "extra_args": "" }
//! ```
//!
//! It is keyed only on `extra_args`, not on the identity the token was minted
//! for. So a token issued while account A was active keeps being served to every
//! *unpinned* context after the operator switches to account B, until it
//! expires. **This staleness is unique to gcloud** — AWS mints fresh on every
//! call, and kubelogin's cache is keyed by tenant/client/server. Only this
//! module's wording claims a stale cache, and only this module clears one.
//!
//! Nothing in this app caches those credentials: [`crate::cluster::Cluster::connect`]
//! rebuilds `Config` on every reconnect, so the exec plugin is re-run each time.
//! The fix is therefore not to change the auth path but to *explain* what
//! happened and let the operator pin the account.
//!
//! Filesystem-only — no subprocess. Spawning `gcloud` would be self-defeating:
//! "the binary isn't on the PATH the app sees" is the exact class of bug the
//! diagnostics surfaces exist to explain.

use std::path::{Path, PathBuf};

use super::{
    env_nonempty, exec_args, exec_env, flag_value, home_dir, ini_value, set_exec_args, Binding,
    ConnectHint, Identities, PinOffer, Provider,
};
use crate::Result;

/// Exec commands this provider owns.
pub const OWNS_COMMANDS: &[&str] = &["gke-gcloud-auth-plugin", "gcloud"];

/// Directory under the gcloud config root holding one directory per account
/// that has credentials on this machine.
const LEGACY_CREDENTIALS_DIR: &str = "legacy_credentials";

/// File under the gcloud config root naming the active configuration. Written
/// without a trailing newline by gcloud, but trimmed defensively.
const ACTIVE_CONFIG_FILE: &str = "active_config";

/// Directory holding one INI file per configuration, named `config_<name>`.
const CONFIGURATIONS_DIR: &str = "configurations";

/// Configuration gcloud falls back to when [`ACTIVE_CONFIG_FILE`] is absent.
const DEFAULT_CONFIG_NAME: &str = "default";

/// The `gke-gcloud-auth-plugin` token cache. Regenerated on the next plugin
/// run, which is what makes deleting it a safe recovery step.
///
/// The plugin writes it beside the kubeconfig it resolves — `filepath.Dir` of
/// client-go's `GetDefaultFilename()`, i.e. the first existing `KUBECONFIG`
/// entry, else `~/.kube/config`. So this name appears both in the default
/// location ([`plugin_cache_path`], shared with kubectl) and in each slot
/// [`crate::exec_auth`] hands the plugin.
pub(crate) const PLUGIN_CACHE_FILE: &str = "gke_gcloud_auth_plugin_cache";

/// gcloud's config directory: `CLOUDSDK_CONFIG` when set, else the per-platform
/// default. `None` when neither the override nor a home directory is resolvable.
#[must_use]
pub fn config_root() -> Option<PathBuf> {
    if let Some(explicit) = env_nonempty("CLOUDSDK_CONFIG") {
        return Some(PathBuf::from(explicit));
    }
    #[cfg(windows)]
    {
        // gcloud on Windows uses %APPDATA%\gcloud, not the unix-style dotdir.
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("gcloud"))
    }
    #[cfg(not(windows))]
    {
        home_dir().map(|h| h.join(".config").join("gcloud"))
    }
}

/// Read accounts and the active account out of an explicit gcloud config root.
/// Purely filesystem-driven — the env overrides live in [`probe`] so this stays
/// testable against a tempdir.
///
/// Every read is best-effort: a missing or unreadable file yields an empty list
/// / `None` rather than an error, because this only ever feeds a diagnostic.
#[must_use]
pub fn read_accounts(root: &Path) -> Identities {
    let mut identities: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root.join(LEGACY_CREDENTIALS_DIR)) {
        for entry in entries.flatten() {
            // Account directories only; gcloud writes nothing else here, but a
            // stray file shouldn't show up as an "account".
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                identities.push(name.to_owned());
            }
        }
    }
    identities.sort();
    identities.dedup();

    let config_name = std::fs::read_to_string(root.join(ACTIVE_CONFIG_FILE))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CONFIG_NAME.to_owned());
    let active = account_in_configuration(root, &config_name);

    Identities { identities, active }
}

/// `[core] account` of one named configuration.
fn account_in_configuration(root: &Path, config_name: &str) -> Option<String> {
    std::fs::read_to_string(
        root.join(CONFIGURATIONS_DIR)
            .join(format!("config_{config_name}")),
    )
    .ok()
    .and_then(|ini| ini_value(&ini, "core", "account"))
}

/// [`read_accounts`] against the real [`config_root`], with the environment
/// overrides gcloud itself honours layered on top. `None` when there is no
/// resolvable config root at all.
#[must_use]
pub fn probe() -> Option<Identities> {
    let root = config_root()?;
    let mut out = read_accounts(&root);
    // `CLOUDSDK_ACTIVE_CONFIG_NAME` wins over the `active_config` file, so
    // re-resolve the active account from the named configuration.
    if let Some(name) = env_nonempty("CLOUDSDK_ACTIVE_CONFIG_NAME") {
        out.active = account_in_configuration(&root, &name);
    }
    // `CLOUDSDK_CORE_ACCOUNT` wins over everything.
    if let Some(account) = env_nonempty("CLOUDSDK_CORE_ACCOUNT") {
        out.active = Some(account);
    }
    Some(out)
}

/// Classify a gcloud-family exec entry. `None` when the command isn't ours.
#[must_use]
pub fn binding_for(basename: &str, args: &[String], env: &[(String, String)]) -> Option<Binding> {
    if !OWNS_COMMANDS.contains(&basename) {
        return None;
    }
    // The exec `env` block is applied to the plugin process, so a
    // CLOUDSDK_CORE_ACCOUNT there pins the identity just as firmly as the flag.
    let pinned = flag_value(args, "--account").or_else(|| exec_env(env, "CLOUDSDK_CORE_ACCOUNT"));
    Some(match pinned {
        Some(identity) => Binding::Pinned { identity },
        None => Binding::FollowsActive,
    })
}

/// Build the "wrong Google account" note, or `None` when this isn't that
/// problem. Callers have already established a 403 and an unpinned binding.
///
/// The remaining gate is "more than one account", because a single-account
/// machine can still hit a 403 — it's a plain RBAC gap there, and this note
/// would be noise.
#[must_use]
pub fn compose_hint(error: &str, accounts: &Identities) -> Option<ConnectHint> {
    if accounts.identities.len() < 2 {
        return None;
    }

    let authenticated_as = super::forbidden_user(error);
    let active = accounts.active.clone();
    // The strongest signal we can offer: the apiserver named an identity that
    // is *not* the one gcloud would hand out today. That mismatch can only come
    // from the plugin's global token cache, so say so and name the file.
    let stale = match (authenticated_as.as_deref(), active.as_deref()) {
        (Some(user), Some(current)) => user != current,
        _ => false,
    };

    let detail = if stale {
        let user = authenticated_as.clone().unwrap_or_default();
        let current = active.clone().unwrap_or_default();
        format!(
            "This context has no --account, so it authenticates as your active gcloud account. \
             The apiserver saw {user}, but your active account is now {current} — a stale token \
             from ~/.kube/gke_gcloud_auth_plugin_cache (one global cache shared by every unpinned \
             context). Pin an account below to give this context its own credentials."
        )
    } else {
        let current = active
            .clone()
            .unwrap_or_else(|| "your active gcloud account".to_owned());
        format!(
            "This context has no --account, so it authenticates as {current} and shares one token \
             cache with every other unpinned context. With {} accounts on this machine, switching \
             accounts elsewhere silently changes who this cluster connects as. Pin an account \
             below to give this context its own credentials.",
            accounts.identities.len()
        )
    };

    Some(ConnectHint {
        provider: Provider::Gcloud,
        title: "Unpinned Google account".to_owned(),
        detail,
        authenticated_as,
        identities: accounts.identities.clone(),
        active_identity: active,
        pin: Some(PinOffer {
            noun: "account".to_owned(),
            effects: vec![
                "add --account to this context's exec entry in your kubeconfig".to_owned(),
                "keep a .ferrisscope-backup copy next to the kubeconfig it edits — if yours \
                 is a symlink, that is the real file's directory, not the link's"
                    .to_owned(),
                "rewrite the file through a YAML parser, which drops comments and \
                 expands any anchors/aliases — the backup holds the file as it was \
                 immediately before this edit, so comments an earlier pin already \
                 removed are not in it either"
                    .to_owned(),
                "delete ~/.kube/gke_gcloud_auth_plugin_cache, which every gcloud-authenticated \
                 tool regenerates on its next run"
                    .to_owned(),
            ],
        }),
        reauth: None,
        unblock: None,
    })
}

/// Build the "your Google session expired" note.
///
/// Unlike [`compose_hint`] this has no gates to pass: the plugin's own stderr
/// already told us exactly what happened, so there is nothing to infer and no
/// risk of a confident guess about the wrong problem. `account` is the pinned
/// account when the context has one; an unpinned context renews whichever
/// account gcloud has active.
///
/// Offers no pin. Pinning writes an `--account` flag, and the account was never
/// the problem here — its session lapsed. Pinning would leave the operator with
/// the same failure and an edited kubeconfig.
#[must_use]
pub fn compose_reauth_hint(account: Option<&str>, accounts: &Identities) -> ConnectHint {
    let whose = account
        .map(|a| format!("The Google session for {a}"))
        .unwrap_or_else(|| {
            accounts.active.as_ref().map_or_else(
                || "Your active Google session".to_owned(),
                |a| format!("The Google session for {a} (this context's active account)"),
            )
        });
    let command = account.map_or_else(
        || "gcloud auth login".to_owned(),
        |a| format!("gcloud auth login --account={a}"),
    );
    ConnectHint {
        provider: Provider::Gcloud,
        title: "Google session expired".to_owned(),
        detail: format!(
            "{whose} has expired, so gke-gcloud-auth-plugin could not mint a token. Renewing it \
             needs an identity challenge — usually a browser — which the app cannot show you: it \
             runs the plugin without a terminal, and gcloud refuses to prompt there \
             (\"cannot prompt during non-interactive execution\"). Run the command below in a \
             terminal, then reconnect. Your credentials are intact; only the session lapsed, and \
             an org session-length policy will lapse it again on its own schedule."
        ),
        authenticated_as: None,
        identities: accounts.identities.clone(),
        active_identity: accounts.active.clone(),
        pin: None,
        reauth: Some(super::ReauthOffer {
            command,
            account: account.map(str::to_owned),
        }),
        unblock: None,
    }
}

/// Why a gcloud-family exec plugin exited non-zero, to the extent its stderr
/// says. Drives which remedy we offer, and the remedies have nothing in common.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecFailure {
    /// The refresh token is intact but the org's session policy wants a fresh
    /// identity challenge, which needs a terminal (usually a browser) the app
    /// cannot offer. Cured only by an interactive `gcloud auth login`.
    ReauthRequired,
    /// No usable credentials for that account at all — never logged in, or the
    /// grant was revoked.
    CredentialsInvalid,
    /// The OS refused to execute the plugin or its gcloud helper ("Operation
    /// not permitted"): macOS TCC guarding a Downloads/Desktop/Documents
    /// install, or a quarantine xattr. No gcloud command cures this.
    ExecBlocked,
    /// Anything else: a broken plugin, a bad `--account`, gcloud not installed.
    Other,
}

/// Classify a plugin's stderr.
///
/// Reauth is tested first and wins: gcloud prints the same "Please run: $ gcloud
/// auth login" footer for a lapsed session as for absent credentials, so the
/// footer distinguishes nothing while the reauth sentence does. The blocked
/// test comes last for the same kind of reason — its phrase is the OS's
/// generic EPERM string, so a message carrying both a reauth sentence and an
/// EPERM must resolve to the remedy that is actually actionable (login).
#[must_use]
pub fn classify_exec_failure(stderr: &str) -> ExecFailure {
    let m = stderr.to_ascii_lowercase();
    if m.contains("reauthentication failed")
        || m.contains("reauthentication required")
        || m.contains("reauth")
        || (m.contains("cannot prompt") && m.contains("non-interactive"))
    {
        return ExecFailure::ReauthRequired;
    }
    if m.contains("invalid_grant")
        || m.contains("does not have valid credentials")
        || m.contains("do not have valid credentials")
        || m.contains("no credentialed accounts")
        || m.contains("was not found in credentialed accounts")
    {
        return ExecFailure::CredentialsInvalid;
    }
    // "Operation not permitted" alone is any EPERM — a macOS firewall refusing
    // an outbound connect produces the same words, and this classifier also
    // runs over whole connect-error strings via `looks_like_exec_blocked`.
    // Require a marker tying the refusal to the exec plugin: the plugin's own
    // wrapper ("failure while executing gcloud" / its `cred.go` log prefix),
    // the shell's can't-exec report, exit 126, or our own error renderings
    // ("exec credential plugin …").
    if m.contains("operation not permitted")
        && (m.contains("credential plugin")
            || m.contains("while executing")
            || m.contains("cred.go")
            || m.contains("/bin/sh:")
            || m.contains("exit status 126"))
    {
        return ExecFailure::ExecBlocked;
    }
    ExecFailure::Other
}

/// The absolute path the OS refused to execute, when the stderr names one.
///
/// The plugin wraps the shell's report — `… (err: /bin/sh:
/// /path/to/gcloud: Operation not permitted` — so the path is the `": "`-token
/// immediately before the marker. `None` unless that token is an absolute Unix
/// path of sane length: a relative token is the shell's own name or prose, and
/// this string ends up rendered in the hint.
#[must_use]
pub fn blocked_path(stderr: &str) -> Option<String> {
    // Last occurrence: our own `Error::ExecPluginBlocked` rendering repeats
    // the phrase in its header, and only the embedded stderr's occurrence has
    // the path in front of it.
    let lower = stderr.to_ascii_lowercase();
    let at = lower.rfind("operation not permitted")?;
    let before = stderr[..at].trim_end().trim_end_matches(':');
    let candidate = before.rsplit(": ").next()?.trim();
    (candidate.starts_with('/') && candidate.len() <= 512 && !candidate.contains(['\n', '\r']))
        .then(|| candidate.to_owned())
}

/// Build the "the OS blocked the plugin" note.
///
/// Like [`compose_reauth_hint`] there are no gates: the stderr said exactly
/// what happened. Offers no pin and no reauth — neither touches the cause. The
/// [`super::UnblockOffer`] carries the two real remedies: a macOS privacy
/// grant (Settings deep link) and a quarantine strip (copyable `xattr`).
#[must_use]
pub fn compose_blocked_hint(path: Option<&str>) -> ConnectHint {
    let what = path.map_or_else(|| "the gcloud SDK".to_owned(), |p| format!("`{p}`"));
    // `<sdk>/bin/gcloud` → strip the quarantine off the whole SDK, not one
    // file — gcloud is a launcher that execs siblings, each quarantined too.
    let quarantine_target = path.map(|p| {
        let pb = std::path::Path::new(p);
        pb.parent()
            .filter(|bin| bin.file_name().is_some_and(|n| n == "bin"))
            .and_then(std::path::Path::parent)
            .filter(|root| !root.as_os_str().is_empty())
            .map_or_else(|| p.to_owned(), |root| root.to_string_lossy().into_owned())
    });
    ConnectHint {
        provider: Provider::Gcloud,
        title: "macOS blocked the auth plugin".to_owned(),
        detail: format!(
            "The OS refused to run {what} (\"Operation not permitted\"), so no token could be \
             minted. Two common causes: the SDK sits in a location macOS guards per-app \
             (Downloads, Desktop, Documents, iCloud Drive, network or removable volumes) and \
             this app has no grant for it, or the SDK still carries the quarantine flag from \
             being downloaded as an archive. Grant access in System Settings → Privacy & \
             Security → Files and Folders, or clear the quarantine with the command below — \
             moving the SDK to an unguarded location fixes it for every app at once."
        ),
        authenticated_as: None,
        identities: Vec::new(),
        active_identity: None,
        pin: None,
        reauth: None,
        unblock: Some(super::UnblockOffer {
            path: path.map(str::to_owned),
            settings_url: MACOS_PRIVACY_SETTINGS_URL.to_owned(),
            command: quarantine_target.map(|t| {
                format!(
                    "xattr -r -d com.apple.quarantine '{}'",
                    t.replace('\'', "'\\''")
                )
            }),
        }),
    }
}

/// Deep link to the pane holding the per-app folder grants. The legacy pane id
/// still resolves on Ventura+ System Settings.
pub const MACOS_PRIVACY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

/// Write `--account=<identity>` into an exec mapping, replacing any prior form.
///
/// # Errors
///
/// Never — the signature matches the other providers' so the dispatcher can
/// treat them uniformly.
pub fn write_pin(exec: &mut serde_yaml::Mapping, identity: &str) -> Result<()> {
    let args = set_account_arg(&exec_args(exec), identity);
    set_exec_args(exec, args);
    Ok(())
}

/// Replace or append `--account=<account>`, dropping any prior form.
fn set_account_arg(args: &[String], account: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len() + 1);
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg.starts_with("--account=") {
            continue;
        }
        if arg == "--account" {
            // Drop the flag and its detached value.
            skip_next = true;
            continue;
        }
        out.push(arg.clone());
    }
    out.push(format!("--account={account}"));
    out
}

/// Delete the `gke-gcloud-auth-plugin` global token cache.
///
/// The file is a cache: every tool that needs it (kubectl included) re-mints on
/// the next plugin run, so removing it costs one extra token exchange and
/// nothing else. Removing it is what actually clears a token minted under the
/// wrong identity. A missing file is success.
///
/// # Errors
///
/// Propagates any I/O error other than `NotFound`.
pub fn clear_plugin_cache() -> std::io::Result<()> {
    let Some(path) = plugin_cache_path() else {
        return Ok(());
    };
    clear_plugin_cache_at(&path)
}

/// [`clear_plugin_cache`] against an explicit path, so callers (and tests) can
/// aim it somewhere other than the real `$HOME`.
///
/// # Errors
///
/// Propagates any I/O error other than `NotFound`.
pub fn clear_plugin_cache_at(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// `~/.kube/gke_gcloud_auth_plugin_cache` — the slot the plugin uses when no
/// `KUBECONFIG` steers it elsewhere, and therefore the one it shares with the
/// operator's kubectl.
///
/// Not the only slot: the path is `filepath.Dir` of client-go's
/// `GetDefaultFilename()`, so a set `KUBECONFIG` moves the cache next to its
/// first existing entry. [`crate::exec_auth::clear_cache_slots`] covers the
/// ones we create.
#[must_use]
pub fn plugin_cache_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".kube").join(PLUGIN_CACHE_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_identity::tests::{
        kubeconfig_fixture, read_args, FORBIDDEN_403, KUBECONFIG_YAML,
    };
    use crate::cloud_identity::{backup_path, tests::pin};

    /// Verbatim stderr from `gke-gcloud-auth-plugin` when the org's Cloud
    /// session length has lapsed. Captured from a real GKE context, account
    /// name replaced — the exact wording is what the classifier keys on, so a
    /// paraphrase here would test nothing.
    const REAUTH_STDERR: &str = "print credential failed with error: Failed to retrieve access \
         token:: failure while executing gcloud, with args [config config-helper --format=json \
         --account=a@example.com]: exit status 1 (err: ERROR: \
         (gcloud.config.config-helper) There was a problem refreshing your current auth tokens: \
         Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n \
         $ gcloud auth login\n\nto obtain new credentials.\n)";

    #[test]
    fn a_lapsed_session_is_classified_as_reauth() {
        assert_eq!(
            classify_exec_failure(REAUTH_STDERR),
            ExecFailure::ReauthRequired
        );
        // The bare sentence, without the plugin's wrapper.
        assert_eq!(
            classify_exec_failure(
                "Reauthentication failed. cannot prompt during non-interactive execution."
            ),
            ExecFailure::ReauthRequired
        );
        // Older gcloud phrasing.
        assert_eq!(
            classify_exec_failure("ERROR: (gcloud.auth) reauth required"),
            ExecFailure::ReauthRequired
        );
    }

    #[test]
    fn absent_credentials_are_not_a_reauth() {
        // Both shapes end with the same "Please run: $ gcloud auth login"
        // footer as a lapsed session, so the footer must not be what decides.
        assert_eq!(
            classify_exec_failure(
                "ERROR: (gcloud.config.config-helper) There was a problem refreshing your current \
                 auth tokens: ('invalid_grant: Bad Request', ...)\nPlease run:\n\n  $ gcloud auth \
                 login\n"
            ),
            ExecFailure::CredentialsInvalid
        );
        assert_eq!(
            classify_exec_failure(
                "ERROR: (gcloud.config.config-helper) You do not currently have an active account \
                 selected.\nERROR: no credentialed accounts."
            ),
            ExecFailure::CredentialsInvalid
        );
    }

    #[test]
    fn unrelated_plugin_failures_stay_other() {
        assert_eq!(
            classify_exec_failure("exec: \"gcloud\": executable file not found in $PATH"),
            ExecFailure::Other
        );
        assert_eq!(
            classify_exec_failure("cannot construct google default token source"),
            ExecFailure::Other
        );
        assert_eq!(classify_exec_failure(""), ExecFailure::Other);
        // "credentials" on its own is not a verdict either way.
        assert_eq!(
            classify_exec_failure("invalid credentials for project foo"),
            ExecFailure::Other
        );
    }

    /// Verbatim stderr from a macOS install where the SDK sits in ~/Downloads
    /// and TCC denies the exec (client report, account/user preserved in
    /// shape). The exact wording is what the classifier and path parser key
    /// on, so a paraphrase would test nothing.
    const BLOCKED_STDERR: &str = "print credential failed with error: Failed to retrieve access \
         token:: failure while executing gcloud, with args [config config-helper --format=json \
         --account=a@example.com]: exit status 126 (err: /bin/sh: \
         /Users/u/Downloads/google-cloud-sdk/bin/gcloud: Operation not permitted\n)";

    /// Verbatim stderr captured on a macOS box reproducing the client report:
    /// the whole SDK downloaded into ~/Downloads, TCC denying this app. Differs
    /// from [`BLOCKED_STDERR`] in two ways that the parser must tolerate — no
    /// `--account=` (the context pins no identity, so the plugin omits the
    /// flag) and the lower-cased single-colon "failed to retrieve access
    /// token:" wording emitted by this plugin build.
    const BLOCKED_STDERR_NO_ACCOUNT: &str = "print credential failed with error: failed to \
         retrieve access token: failure while executing gcloud, with args [config config-helper \
         --format=json]: exit status 126 (err: /bin/sh: \
         /Users/u/Downloads/google-cloud-sdk/bin/gcloud: Operation not permitted\n)";

    #[test]
    fn blocked_without_a_pinned_account_still_classifies_and_offers_the_sdk_root() {
        assert_eq!(
            classify_exec_failure(BLOCKED_STDERR_NO_ACCOUNT),
            ExecFailure::ExecBlocked
        );
        let path = blocked_path(BLOCKED_STDERR_NO_ACCOUNT);
        assert_eq!(
            path.as_deref(),
            Some("/Users/u/Downloads/google-cloud-sdk/bin/gcloud")
        );
        // The remedy must target the SDK root, not the single refused file:
        // gcloud is a launcher that execs its siblings, each equally guarded.
        let hint = compose_blocked_hint(path.as_deref());
        assert_eq!(
            hint.unblock.and_then(|u| u.command).as_deref(),
            Some("xattr -r -d com.apple.quarantine '/Users/u/Downloads/google-cloud-sdk'")
        );
    }

    /// TCC guards far more than the well-known trio, and its coverage shifts
    /// per OS release: iCloud mirrors, network shares, removable volumes, and
    /// (with Full Disk Access withheld) plenty besides. Nothing in the blocked
    /// path may key on a location allowlist — the OS already decided by the
    /// time this stderr exists, so every guarded prefix must classify and yield
    /// its own SDK root.
    #[test]
    fn any_guarded_location_classifies_not_just_downloads() {
        for root in [
            "/Users/u/Downloads/google-cloud-sdk",
            "/Users/u/Desktop/google-cloud-sdk",
            "/Users/u/Documents/google-cloud-sdk",
            "/Users/u/Library/Mobile Documents/com~apple~CloudDocs/google-cloud-sdk",
            "/Volumes/Backup SSD/sdks/google-cloud-sdk",
            "/Users/u/some/entirely/unexpected/place/google-cloud-sdk",
        ] {
            let stderr = format!(
                "print credential failed with error: failed to retrieve access token: failure \
                 while executing gcloud, with args [config config-helper --format=json]: exit \
                 status 126 (err: /bin/sh: {root}/bin/gcloud: Operation not permitted\n)"
            );
            assert_eq!(
                classify_exec_failure(&stderr),
                ExecFailure::ExecBlocked,
                "should classify under {root}"
            );
            let path = blocked_path(&stderr);
            assert_eq!(path.as_deref(), Some(format!("{root}/bin/gcloud").as_str()));
            assert_eq!(
                compose_blocked_hint(path.as_deref())
                    .unblock
                    .and_then(|u| u.command)
                    .as_deref(),
                Some(format!("xattr -r -d com.apple.quarantine '{root}'").as_str()),
                "quarantine target should be the SDK root under {root}"
            );
        }
    }

    #[test]
    fn an_os_exec_refusal_is_classified_as_blocked() {
        assert_eq!(
            classify_exec_failure(BLOCKED_STDERR),
            ExecFailure::ExecBlocked
        );
        // The bare shell report, without the plugin's wrapper.
        assert_eq!(
            classify_exec_failure(
                "/bin/sh: /Users/u/Downloads/sdk/bin/gcloud: Operation not permitted"
            ),
            ExecFailure::ExecBlocked
        );
        // Reauth wording wins when both could match — its remedy is cheaper
        // and its sentence is the more specific signal.
        assert_eq!(
            classify_exec_failure(
                "Reauthentication failed. cannot prompt during non-interactive execution. \
                 Operation not permitted"
            ),
            ExecFailure::ReauthRequired
        );
        // A bare EPERM with no exec-plugin marker is any OS refusal — a macOS
        // firewall blocking an outbound connect says the same words. This
        // classifier also runs over whole connect-error strings, so the phrase
        // alone must not claim the SDK is blocked.
        assert_eq!(
            classify_exec_failure("dial tcp 10.0.0.1:443: connect: operation not permitted"),
            ExecFailure::Other
        );
        assert_eq!(
            classify_exec_failure("Operation not permitted"),
            ExecFailure::Other
        );
        // Our own `ExecPluginFailed` rendering of a kube-rs-spawned failure
        // carries the marker, so the enriched path still classifies.
        assert_eq!(
            classify_exec_failure(
                "exec credential plugin 'gke-gcloud-auth-plugin' failed (exit 1) — \
                 gcloud: Operation not permitted"
            ),
            ExecFailure::ExecBlocked
        );
    }

    #[test]
    fn blocked_path_extracts_the_refused_binary() {
        assert_eq!(
            blocked_path(BLOCKED_STDERR).as_deref(),
            Some("/Users/u/Downloads/google-cloud-sdk/bin/gcloud")
        );
        // No path named — e.g. a kernel-level EPERM without the shell wrapper.
        assert_eq!(blocked_path("gcloud: Operation not permitted"), None);
        assert_eq!(blocked_path("Operation not permitted"), None);
        // A relative token is the shell's own name, not a path.
        assert_eq!(blocked_path("sh: gcloud: Operation not permitted"), None);
    }

    #[test]
    fn the_blocked_note_offers_a_grant_and_a_quarantine_strip() {
        let hint = compose_blocked_hint(Some("/Users/u/Downloads/google-cloud-sdk/bin/gcloud"));
        assert_eq!(hint.provider, Provider::Gcloud);
        // Neither a pin nor a login touches an OS exec refusal.
        assert_eq!(hint.pin, None);
        assert_eq!(hint.reauth, None);
        let offer = hint.unblock.expect("unblock offer");
        assert_eq!(offer.settings_url, MACOS_PRIVACY_SETTINGS_URL);
        assert_eq!(
            offer.path.as_deref(),
            Some("/Users/u/Downloads/google-cloud-sdk/bin/gcloud")
        );
        // The strip targets the SDK root, not one file — gcloud execs
        // quarantined siblings.
        assert_eq!(
            offer.command.as_deref(),
            Some("xattr -r -d com.apple.quarantine '/Users/u/Downloads/google-cloud-sdk'")
        );
        assert!(hint.detail.contains("Operation not permitted"));
    }

    #[test]
    fn the_blocked_note_survives_an_unparsed_path() {
        let hint = compose_blocked_hint(None);
        let offer = hint.unblock.expect("unblock offer");
        assert_eq!(offer.path, None);
        // No path → no quarantine target to name; only the grant remedy.
        assert_eq!(offer.command, None);
        assert_eq!(offer.settings_url, MACOS_PRIVACY_SETTINGS_URL);
    }

    #[test]
    fn the_quarantine_target_falls_back_to_the_file_outside_a_bin_layout() {
        let hint = compose_blocked_hint(Some("/opt/gcloud"));
        let offer = hint.unblock.expect("unblock offer");
        assert_eq!(
            offer.command.as_deref(),
            Some("xattr -r -d com.apple.quarantine '/opt/gcloud'")
        );
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, body).expect("write");
    }

    fn fake_root(dir: &Path, active_config: &str, accounts: &[&str]) {
        // No trailing newline — that's how gcloud writes it.
        std::fs::write(dir.join(ACTIVE_CONFIG_FILE), active_config).expect("active_config");
        for a in accounts {
            std::fs::create_dir_all(dir.join(LEGACY_CREDENTIALS_DIR).join(a)).expect("account dir");
        }
    }

    #[test]
    fn read_accounts_collects_accounts_and_active() {
        let tmp = tempfile::tempdir().expect("tempdir");
        fake_root(tmp.path(), "work", &["ops@example.net", "dev@example.com"]);
        write(
            &tmp.path().join(CONFIGURATIONS_DIR).join("config_work"),
            "[core]\naccount = dev@example.com\nproject = infra-1\n",
        );

        let got = read_accounts(tmp.path());
        // Sorted, so the assertion doesn't depend on readdir order.
        assert_eq!(got.identities, vec!["dev@example.com", "ops@example.net"]);
        assert_eq!(got.active.as_deref(), Some("dev@example.com"));
    }

    #[test]
    fn read_accounts_falls_back_to_default_configuration() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // No active_config file at all → gcloud uses `default`.
        std::fs::create_dir_all(
            tmp.path()
                .join(LEGACY_CREDENTIALS_DIR)
                .join("a@example.com"),
        )
        .expect("account dir");
        write(
            &tmp.path().join(CONFIGURATIONS_DIR).join("config_default"),
            "[core]\naccount = a@example.com\n",
        );

        assert_eq!(
            read_accounts(tmp.path()).active.as_deref(),
            Some("a@example.com")
        );
    }

    #[test]
    fn read_accounts_tolerates_a_missing_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            read_accounts(&tmp.path().join("nope")),
            Identities::default()
        );
    }

    #[test]
    fn read_accounts_ignores_stray_files_in_legacy_credentials() {
        let tmp = tempfile::tempdir().expect("tempdir");
        fake_root(tmp.path(), "default", &["a@example.com"]);
        write(
            &tmp.path().join(LEGACY_CREDENTIALS_DIR).join("README"),
            "not an account",
        );
        assert_eq!(read_accounts(tmp.path()).identities, vec!["a@example.com"]);
    }

    #[test]
    fn binding_for_detects_every_pinning_form() {
        assert_eq!(
            binding_for(
                "gke-gcloud-auth-plugin",
                &["--account=a@example.com".to_owned()],
                &[]
            ),
            Some(Binding::Pinned {
                identity: "a@example.com".to_owned()
            })
        );
        assert_eq!(
            binding_for(
                "gke-gcloud-auth-plugin",
                &["--account".to_owned(), "a@example.com".to_owned()],
                &[]
            ),
            Some(Binding::Pinned {
                identity: "a@example.com".to_owned()
            })
        );
        assert_eq!(
            binding_for(
                "gcloud",
                &[],
                &[(
                    "CLOUDSDK_CORE_ACCOUNT".to_owned(),
                    "a@example.com".to_owned()
                )]
            ),
            Some(Binding::Pinned {
                identity: "a@example.com".to_owned()
            })
        );
        assert_eq!(
            binding_for("gke-gcloud-auth-plugin", &[], &[]),
            Some(Binding::FollowsActive)
        );
        // A dangling `--account` with no value is not a pin.
        assert_eq!(
            binding_for("gke-gcloud-auth-plugin", &["--account".to_owned()], &[]),
            Some(Binding::FollowsActive)
        );
        assert_eq!(binding_for("aws-iam-authenticator", &[], &[]), None);
    }

    fn two_accounts() -> Identities {
        Identities {
            identities: vec!["ops@example.net".to_owned(), "dev@example.com".to_owned()],
            active: Some("dev@example.com".to_owned()),
        }
    }

    #[test]
    fn compose_hint_flags_the_stale_cache_mismatch() {
        let hint = compose_hint(FORBIDDEN_403, &two_accounts()).expect("hint expected");
        assert_eq!(hint.provider, Provider::Gcloud);
        assert_eq!(hint.authenticated_as.as_deref(), Some("ops@example.net"));
        assert_eq!(hint.active_identity.as_deref(), Some("dev@example.com"));
        // Names both identities and the cache file, so the operator can act
        // without reading the source.
        assert!(hint.detail.contains("ops@example.net"));
        assert!(hint.detail.contains("dev@example.com"));
        assert!(hint.detail.contains("gke_gcloud_auth_plugin_cache"));
        let pin = hint.pin.expect("gcloud can pin");
        assert_eq!(pin.noun, "account");
        // The cache deletion is disclosed up front, not buried.
        assert!(pin
            .effects
            .iter()
            .any(|e| e.contains("gke_gcloud_auth_plugin_cache")));
    }

    #[test]
    fn compose_hint_still_fires_without_a_parseable_identity() {
        let hint = compose_hint("403 Forbidden", &two_accounts()).expect("hint expected");
        assert_eq!(hint.authenticated_as, None);
        assert!(hint.detail.contains("dev@example.com"));
    }

    #[test]
    fn compose_hint_is_silent_on_a_single_account_machine() {
        // A 403 here is a plain RBAC gap, not an identity mixup.
        let single = Identities {
            identities: vec!["dev@example.com".to_owned()],
            active: Some("dev@example.com".to_owned()),
        };
        assert_eq!(compose_hint(FORBIDDEN_403, &single), None);
    }

    #[test]
    fn set_account_arg_replaces_every_prior_form() {
        assert_eq!(set_account_arg(&[], "a@b.io"), vec!["--account=a@b.io"]);
        assert_eq!(
            set_account_arg(&["--account=old@b.io".to_owned()], "a@b.io"),
            vec!["--account=a@b.io"]
        );
        assert_eq!(
            set_account_arg(&["--account".to_owned(), "old@b.io".to_owned()], "a@b.io"),
            vec!["--account=a@b.io"]
        );
        // Unrelated args survive, in order.
        assert_eq!(
            set_account_arg(
                &[
                    "--verbosity=debug".to_owned(),
                    "--account=old@b.io".to_owned(),
                    "--quiet".to_owned()
                ],
                "a@b.io"
            ),
            vec!["--verbosity=debug", "--quiet", "--account=a@b.io"]
        );
    }

    #[test]
    fn pin_writes_the_account_flag_and_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);

        pin(&path, "gke", "a@example.com").expect("pin");
        assert_eq!(
            read_args(&path, "gke-user"),
            vec!["--account=a@example.com"]
        );

        pin(&path, "gke", "b@example.com").expect("re-pin");
        assert_eq!(
            read_args(&path, "gke-user"),
            vec!["--account=b@example.com"]
        );
        assert!(backup_path(&path).exists());
    }
}
