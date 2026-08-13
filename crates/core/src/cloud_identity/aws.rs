//! AWS: profile discovery, the "wrong profile" diagnosis, and the `AWS_PROFILE`
//! pin.
//!
//! An EKS context whose exec entry names no profile authenticates as whatever
//! `AWS_PROFILE` / `AWS_DEFAULT_PROFILE` says, falling back to `default`. That
//! is the same drift trap as [`super::gcloud`] — a profile exported for
//! unrelated work in the app's environment silently changes who this cluster
//! connects as.
//!
//! **Two things are deliberately different from gcloud:**
//!
//! * **No stale token cache.** `aws eks get-token` mints a presigned STS URL on
//!   every call, so an unpinned context at least uses the profile that is
//!   active *right now*. The note must not claim a cache, and there is no cache
//!   for the pin to clear. (An expired SSO session is a different failure: the
//!   plugin exits non-zero, which surfaces as `Error::ExecPluginFailed`, not a
//!   403.)
//! * **The pin writes `AWS_PROFILE` into the exec `env` block, not
//!   `--profile`.** `aws-iam-authenticator` has no `--profile` flag but honours
//!   the environment variable, and `aws eks get-token` honours both — so one
//!   mechanism covers both binaries instead of forking per command.
//!
//! Filesystem-only: profiles come from the shared config/credentials INI files,
//! never from `aws configure list-profiles`.
//!
//! Untested against a live EKS cluster — the parsing follows the documented
//! file formats, and every classifier fails closed, so the worst case is a
//! missing note rather than a wrong one.

use std::path::PathBuf;

use super::{
    env_nonempty, exec_env, flag_value, home_dir, ini_sections, set_exec_env, Binding, ConnectHint,
    Identities, PinOffer, Provider,
};
use crate::Result;

/// Exec commands this provider owns.
pub const OWNS_COMMANDS: &[&str] = &["aws", "aws-iam-authenticator"];

/// Profile every AWS tool falls back to when nothing selects one.
const DEFAULT_PROFILE: &str = "default";

/// Shared config file: `AWS_CONFIG_FILE`, else `~/.aws/config`. Sections are
/// `[profile foo]`, except the default profile which is bare `[default]`.
#[must_use]
pub fn config_file() -> Option<PathBuf> {
    if let Some(explicit) = env_nonempty("AWS_CONFIG_FILE") {
        return Some(PathBuf::from(explicit));
    }
    home_dir().map(|h| h.join(".aws").join("config"))
}

/// Shared credentials file: `AWS_SHARED_CREDENTIALS_FILE`, else
/// `~/.aws/credentials`. Sections are bare profile names — no `profile ` prefix.
#[must_use]
pub fn credentials_file() -> Option<PathBuf> {
    if let Some(explicit) = env_nonempty("AWS_SHARED_CREDENTIALS_FILE") {
        return Some(PathBuf::from(explicit));
    }
    home_dir().map(|h| h.join(".aws").join("credentials"))
}

/// Profile names out of a `~/.aws/config`-shaped INI.
///
/// The prefix rule is asymmetric and easy to get wrong: `[profile dev]` means
/// the profile `dev`, but the default profile is written bare as `[default]`,
/// *not* `[profile default]`. Non-profile sections (`[sso-session x]`,
/// `[services x]`) are skipped.
#[must_use]
pub fn profiles_from_config(ini: &str) -> Vec<String> {
    ini_sections(ini)
        .into_iter()
        .filter_map(|s| {
            if s == DEFAULT_PROFILE {
                return Some(DEFAULT_PROFILE.to_owned());
            }
            let rest = s.strip_prefix("profile ")?.trim().to_owned();
            (!rest.is_empty()).then_some(rest)
        })
        .collect()
}

/// Profile names out of a `~/.aws/credentials`-shaped INI, where every section
/// is a bare profile name.
#[must_use]
pub fn profiles_from_credentials(ini: &str) -> Vec<String> {
    ini_sections(ini)
}

/// Every configured profile plus the one an unpinned context uses right now.
///
/// The active profile is `AWS_PROFILE`, else `AWS_DEFAULT_PROFILE`, else
/// `default` — reported only when a profile by that name actually exists, so we
/// never claim an active profile the operator hasn't configured.
#[must_use]
pub fn probe() -> Identities {
    let mut identities: Vec<String> = Vec::new();
    if let Some(text) = config_file().and_then(|p| std::fs::read_to_string(p).ok()) {
        identities.extend(profiles_from_config(&text));
    }
    if let Some(text) = credentials_file().and_then(|p| std::fs::read_to_string(p).ok()) {
        identities.extend(profiles_from_credentials(&text));
    }
    identities.sort();
    identities.dedup();

    let named = env_nonempty("AWS_PROFILE")
        .or_else(|| env_nonempty("AWS_DEFAULT_PROFILE"))
        .unwrap_or_else(|| DEFAULT_PROFILE.to_owned());
    let active = identities.contains(&named).then_some(named);

    Identities { identities, active }
}

/// Classify an AWS-family exec entry. `None` when the command isn't ours.
#[must_use]
pub fn binding_for(basename: &str, args: &[String], env: &[(String, String)]) -> Option<Binding> {
    if !OWNS_COMMANDS.contains(&basename) {
        return None;
    }
    // `--profile` only exists on the `aws` CLI; `AWS_PROFILE` in the exec env
    // pins either binary. Check both regardless — a `--profile` on
    // aws-iam-authenticator would be inert, but treating it as unpinned would
    // be a worse guess than treating it as intent.
    // `AWS_DEFAULT_PROFILE` is checked too, and *first*: botocore resolves the
    // profile from the ordered list `['AWS_DEFAULT_PROFILE', 'AWS_PROFILE']`,
    // first match wins. Omitting it here would classify a context pinned via
    // that variable as unpinned, then offer a pin that writes `AWS_PROFILE` —
    // which the pre-existing `AWS_DEFAULT_PROFILE` would keep overriding. The
    // file would change, the operator would reconnect, and nothing would.
    let pinned = flag_value(args, "--profile")
        .or_else(|| exec_env(env, "AWS_DEFAULT_PROFILE"))
        .or_else(|| exec_env(env, "AWS_PROFILE"));
    Some(match pinned {
        Some(identity) => Binding::Pinned { identity },
        None => Binding::FollowsActive,
    })
}

/// Build the "unpinned AWS profile" note, or `None` when this isn't that
/// problem. Callers have already established a 403 and an unpinned binding.
///
/// Gated on more than one profile: with a single profile there is nothing to
/// drift between, and the 403 is a plain RBAC / access-entry gap.
#[must_use]
pub fn compose_hint(error: &str, profiles: &Identities) -> Option<ConnectHint> {
    if profiles.identities.len() < 2 {
        return None;
    }

    let authenticated_as = super::forbidden_user(error);
    let active = profiles.active.clone();
    let current = active
        .clone()
        .unwrap_or_else(|| format!("the {DEFAULT_PROFILE} profile"));
    // Note the wording: no claim of a stale cache. `aws eks get-token` mints
    // fresh every call, so whatever the apiserver saw *is* what this profile
    // resolves to today — the surprise is which profile, not which token.
    let seen = authenticated_as
        .as_ref()
        .map_or_else(String::new, |u| format!(" The apiserver saw {u}."));
    let detail = format!(
        "This context names no profile, so it authenticates as {current} — whatever \
         AWS_PROFILE happens to be set to when the app launches, falling back to \
         {DEFAULT_PROFILE}.{seen} With {} profiles configured, exporting a different one for \
         unrelated work silently changes who this cluster connects as. Pin a profile below to \
         give this context its own credentials.",
        profiles.identities.len()
    );

    Some(ConnectHint {
        provider: Provider::Aws,
        title: "Unpinned AWS profile".to_owned(),
        detail,
        authenticated_as,
        identities: profiles.identities.clone(),
        active_identity: active,
        pin: Some(PinOffer {
            noun: "profile".to_owned(),
            effects: vec![
                "set AWS_PROFILE in this context's exec env block in your kubeconfig".to_owned(),
                "keep a .ferrisscope-backup copy next to the kubeconfig it edits — if yours \
                 is a symlink, that is the real file's directory, not the link's"
                    .to_owned(),
                "rewrite the file through a YAML parser, which drops comments and \
                 expands any anchors/aliases — the backup holds the file as it was \
                 immediately before this edit, so comments an earlier pin already \
                 removed are not in it either"
                    .to_owned(),
            ],
        }),
    })
}

/// Write `AWS_PROFILE=<identity>` into an exec mapping's `env` block.
///
/// Env rather than `--profile` on purpose — see the module docs.
///
/// # Errors
///
/// Never — the signature matches the other providers' so the dispatcher can
/// treat them uniformly.
pub fn write_pin(exec: &mut serde_yaml::Mapping, identity: &str) -> Result<()> {
    set_exec_env(exec, "AWS_PROFILE", identity);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_identity::tests::FORBIDDEN_403;

    const EKS_403: &str = r#"ApiError: namespaces is forbidden: User "arn:aws:sts::111122223333:assumed-role/Dev/session" cannot list resource "namespaces" in API group "" at the cluster scope: Forbidden"#;

    #[test]
    fn profiles_from_config_handles_the_asymmetric_default_section() {
        let ini = "\
[default]
region = us-east-1

[profile dev]
region = us-west-2

[profile  prod ]
region = eu-west-1

[sso-session corp]
sso_region = us-east-1

[services shared]
";
        // `[default]` is bare while every other profile carries the prefix;
        // non-profile sections are skipped entirely.
        assert_eq!(profiles_from_config(ini), vec!["default", "dev", "prod"]);
    }

    #[test]
    fn profiles_from_credentials_uses_bare_sections() {
        assert_eq!(
            profiles_from_credentials("[default]\n[dev]\n"),
            vec!["default", "dev"]
        );
    }

    #[test]
    fn binding_for_honours_aws_default_profile() {
        // `probe` already treats AWS_DEFAULT_PROFILE as selecting the profile;
        // the classifier has to agree. If it doesn't, a context pinned via that
        // variable is reported as unpinned, and the pin we then offer writes
        // AWS_PROFILE — which botocore resolves *second*, so the pre-existing
        // AWS_DEFAULT_PROFILE keeps winning. The file changes and nothing else
        // does, which is the worst possible outcome for a trust-building
        // feature.
        assert_eq!(
            binding_for(
                "aws",
                &[],
                &[("AWS_DEFAULT_PROFILE".to_owned(), "prod".to_owned())]
            ),
            Some(Binding::Pinned {
                identity: "prod".to_owned()
            })
        );
        // Resolution order matches botocore's: AWS_DEFAULT_PROFILE first.
        assert_eq!(
            binding_for(
                "aws",
                &[],
                &[
                    ("AWS_PROFILE".to_owned(), "second".to_owned()),
                    ("AWS_DEFAULT_PROFILE".to_owned(), "first".to_owned()),
                ]
            ),
            Some(Binding::Pinned {
                identity: "first".to_owned()
            })
        );
    }

    #[test]
    fn binding_for_detects_both_pinning_forms() {
        assert_eq!(
            binding_for("aws", &["--profile=dev".to_owned()], &[]),
            Some(Binding::Pinned {
                identity: "dev".to_owned()
            })
        );
        assert_eq!(
            binding_for(
                "aws",
                &[
                    "eks".to_owned(),
                    "get-token".to_owned(),
                    "--profile".to_owned(),
                    "dev".to_owned()
                ],
                &[]
            ),
            Some(Binding::Pinned {
                identity: "dev".to_owned()
            })
        );
        // aws-iam-authenticator has no --profile flag, so the env is the pin.
        assert_eq!(
            binding_for(
                "aws-iam-authenticator",
                &["token".to_owned(), "-i".to_owned(), "prod".to_owned()],
                &[("AWS_PROFILE".to_owned(), "dev".to_owned())]
            ),
            Some(Binding::Pinned {
                identity: "dev".to_owned()
            })
        );
        assert_eq!(
            binding_for("aws", &["eks".to_owned(), "get-token".to_owned()], &[]),
            Some(Binding::FollowsActive)
        );
        // An unrelated env var doesn't count as a pin.
        assert_eq!(
            binding_for(
                "aws",
                &[],
                &[("AWS_REGION".to_owned(), "us-east-1".to_owned())]
            ),
            Some(Binding::FollowsActive)
        );
        assert_eq!(binding_for("gke-gcloud-auth-plugin", &[], &[]), None);
    }

    fn two_profiles() -> Identities {
        Identities {
            identities: vec!["default".to_owned(), "dev".to_owned()],
            active: Some("dev".to_owned()),
        }
    }

    #[test]
    fn compose_hint_names_the_profile_and_never_claims_a_stale_cache() {
        let hint = compose_hint(EKS_403, &two_profiles()).expect("hint expected");
        assert_eq!(hint.provider, Provider::Aws);
        assert_eq!(
            hint.authenticated_as.as_deref(),
            Some("arn:aws:sts::111122223333:assumed-role/Dev/session")
        );
        assert!(hint.detail.contains("dev"));
        assert!(hint.detail.contains("AWS_PROFILE"));
        // The gcloud-only failure mode must not leak into AWS wording: there is
        // no shared token cache here, and nothing for a pin to clear.
        assert!(!hint.detail.to_lowercase().contains("cache"));
        assert!(!hint.detail.contains("stale"));
        let pin = hint.pin.expect("aws can pin");
        assert_eq!(pin.noun, "profile");
        assert!(pin.effects.iter().any(|e| e.contains("AWS_PROFILE")));
        assert!(!pin.effects.iter().any(|e| e.contains("cache")));
    }

    #[test]
    fn compose_hint_tolerates_an_unparseable_identity_and_unknown_active() {
        let unknown_active = Identities {
            identities: vec!["default".to_owned(), "dev".to_owned()],
            // AWS_PROFILE pointed at a profile that isn't configured, so we
            // decline to name one rather than assert something false.
            active: None,
        };
        let hint = compose_hint(FORBIDDEN_403, &unknown_active).expect("hint expected");
        assert!(hint.detail.contains("the default profile"));
        assert_eq!(hint.active_identity, None);
    }

    #[test]
    fn compose_hint_is_silent_on_a_single_profile_machine() {
        let single = Identities {
            identities: vec!["default".to_owned()],
            active: Some("default".to_owned()),
        };
        assert_eq!(compose_hint(EKS_403, &single), None);
    }
}
