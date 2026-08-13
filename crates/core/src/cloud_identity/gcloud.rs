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

/// The `gke-gcloud-auth-plugin` global token cache. Shared by every tool on the
/// machine (kubectl included) and regenerated on the next plugin run, which is
/// what makes deleting it a safe recovery step.
const PLUGIN_CACHE_FILE: &str = "gke_gcloud_auth_plugin_cache";

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
    })
}

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

/// `~/.kube/gke_gcloud_auth_plugin_cache`. Deliberately *not* derived from
/// `KUBECONFIG` — the plugin always writes it next to the default kube home,
/// regardless of which kubeconfig is in play.
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
