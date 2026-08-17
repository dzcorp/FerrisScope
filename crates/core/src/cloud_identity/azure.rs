//! Azure: account discovery and the "wrong `az` account" diagnosis.
//!
//! **Detection only — there is no pin here, and that is not an oversight.**
//!
//! `kubelogin get-token --login azurecli` (what `az aks get-credentials
//! --format azure && kubelogin convert-kubeconfig` writes) resolves its identity
//! from `az`'s own state. kubelogin exposes `--tenant-id`, `--client-id` and
//! `--server-id`, but **none of them selects an account** — the only way to
//! change who it authenticates as is `az account set --subscription <x>`, which
//! is a global mutation, not a kubeconfig edit. So this module offers the
//! operator the command to run instead of a button that would quietly rewrite
//! the wrong thing.
//!
//! The other `--login` modes (`spn`, `msi`, `workloadidentity`, `devicecode`,
//! `interactive`) either carry their own credentials or prompt per-connect, so
//! ambient-account drift doesn't apply. Those are classified as "not our
//! problem" and produce no note at all.
//!
//! Unlike gcloud, kubelogin's token cache (`~/.kube/cache/kubelogin/*.json`) is
//! keyed by tenant / client / server id, so it does **not** bleed one account's
//! token into another context. No cache-clearing story here either.
//!
//! Untested against a live AKS cluster — the `azureProfile.json` parsing follows
//! the documented shape, and the classifier fails closed, so the worst case is a
//! missing note rather than a wrong one.

use std::path::PathBuf;

use super::{
    env_nonempty, exec_env, flag_value, home_dir, Binding, ConnectHint, Identities, Provider,
};

/// Exec commands this provider owns.
pub const OWNS_COMMANDS: &[&str] = &["kubelogin"];

/// The only `--login` mode that inherits an ambient account, and therefore the
/// only one that can drift under the operator.
const AZURECLI_LOGIN: &str = "azurecli";

/// `az`'s config directory: `AZURE_CONFIG_DIR`, else `~/.azure`.
#[must_use]
pub fn config_root() -> Option<PathBuf> {
    if let Some(explicit) = env_nonempty("AZURE_CONFIG_DIR") {
        return Some(PathBuf::from(explicit));
    }
    home_dir().map(|h| h.join(".azure"))
}

/// Signed-in accounts out of `azureProfile.json`.
///
/// Shape (trimmed):
///
/// ```json
/// { "subscriptions": [
///     { "name": "Prod", "isDefault": true, "user": { "name": "ops@example.net" } }
/// ] }
/// ```
///
/// One account signs in to many subscriptions, so the list is deduped by user
/// name; the active account is the one on the default subscription. Anything
/// that doesn't parse yields empty rather than an error — this only feeds a
/// diagnostic.
#[must_use]
pub fn accounts_from_profile(json: &str) -> Identities {
    // `az` writes this file with a UTF-8 BOM on some platforms, which
    // serde_json rejects outright.
    let json = json.trim_start_matches('\u{feff}');
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(json) else {
        return Identities::default();
    };
    let Some(subs) = doc.get("subscriptions").and_then(|s| s.as_array()) else {
        return Identities::default();
    };

    let user_of = |s: &serde_json::Value| -> Option<String> {
        let name = s.get("user")?.get("name")?.as_str()?.trim();
        (!name.is_empty()).then(|| name.to_owned())
    };

    let mut identities: Vec<String> = subs.iter().filter_map(user_of).collect();
    identities.sort();
    identities.dedup();

    let active = subs
        .iter()
        .find(|s| s.get("isDefault").and_then(serde_json::Value::as_bool) == Some(true))
        .and_then(user_of);

    Identities { identities, active }
}

/// [`accounts_from_profile`] against the real [`config_root`].
#[must_use]
pub fn probe() -> Option<Identities> {
    let path = config_root()?.join("azureProfile.json");
    let text = std::fs::read_to_string(path).ok()?;
    Some(accounts_from_profile(&text))
}

/// Classify a kubelogin exec entry.
///
/// `None` both when the command isn't ours **and** when it is ours but runs a
/// `--login` mode that carries its own credentials — neither can suffer ambient
/// account drift, so neither should produce a note.
#[must_use]
pub fn binding_for(basename: &str, args: &[String], env: &[(String, String)]) -> Option<Binding> {
    if !OWNS_COMMANDS.contains(&basename) {
        return None;
    }
    // kubelogin takes its login mode from `AAD_LOGIN_METHOD` as well as
    // `--login`/`-l`. An entry using the env form drifts under `az account set`
    // exactly like the flag form, so ignoring it would just silently withhold
    // the note.
    let mode = flag_value(args, "--login")
        .or_else(|| flag_value(args, "-l"))
        .or_else(|| exec_env(env, "AAD_LOGIN_METHOD"))?;
    // Only azurecli login follows `az account set`. Everything else is either
    // self-contained (spn/msi/workloadidentity) or prompts per connect
    // (devicecode/interactive).
    (mode == AZURECLI_LOGIN).then_some(Binding::FollowsActive)
}

/// Build the "wrong Azure account" note, or `None` when this isn't that
/// problem. Callers have already established a 403 and an azurecli binding.
///
/// Always returns `pin: None` — see the module docs. The remedy goes in the
/// prose instead, as the exact command to run.
#[must_use]
pub fn compose_hint(error: &str, accounts: &Identities) -> Option<ConnectHint> {
    if accounts.identities.len() < 2 {
        return None;
    }

    let authenticated_as = super::forbidden_user(error);
    let active = accounts.active.clone();
    let current = active
        .clone()
        .unwrap_or_else(|| "your default subscription's account".to_owned());
    let seen = authenticated_as
        .as_ref()
        .map_or_else(String::new, |u| format!(" The apiserver saw {u}."));
    let detail = format!(
        "This context uses kubelogin --login azurecli, so it authenticates as {current} — \
         whichever account owns your default `az` subscription.{seen} With {} accounts signed \
         in, `az account set` run for unrelated work silently changes who this cluster connects \
         as. kubelogin has no per-context account flag, so switch with \
         `az account set --subscription <id>` and reconnect.",
        accounts.identities.len()
    );

    Some(ConnectHint {
        provider: Provider::Azure,
        title: "Ambient Azure account".to_owned(),
        detail,
        authenticated_as,
        identities: accounts.identities.clone(),
        active_identity: active,
        // No per-context pin exists for kubelogin. Offering one would mean
        // mutating global `az` state behind a button that looks like a
        // kubeconfig edit.
        pin: None,
        reauth: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILE_JSON: &str = r#"{
      "installationId": "x",
      "subscriptions": [
        { "id": "1", "name": "Prod", "isDefault": true,
          "user": { "name": "ops@example.net", "type": "user" } },
        { "id": "2", "name": "Dev", "isDefault": false,
          "user": { "name": "ops@example.net", "type": "user" } },
        { "id": "3", "name": "Partner", "isDefault": false,
          "user": { "name": "guest@example.com", "type": "user" } }
      ]
    }"#;

    #[test]
    fn accounts_from_profile_dedupes_by_user_and_finds_the_default() {
        let got = accounts_from_profile(PROFILE_JSON);
        // Two subscriptions share one account — it must appear once.
        assert_eq!(got.identities, vec!["guest@example.com", "ops@example.net"]);
        assert_eq!(got.active.as_deref(), Some("ops@example.net"));
    }

    #[test]
    fn accounts_from_profile_survives_a_bom_and_junk() {
        let with_bom = format!("\u{feff}{PROFILE_JSON}");
        assert_eq!(
            accounts_from_profile(&with_bom).active.as_deref(),
            Some("ops@example.net")
        );
        assert_eq!(accounts_from_profile("not json"), Identities::default());
        assert_eq!(accounts_from_profile("{}"), Identities::default());
        // Subscription with no user block is skipped, not fatal.
        assert_eq!(
            accounts_from_profile(r#"{"subscriptions":[{"id":"1"}]}"#),
            Identities::default()
        );
    }

    #[test]
    fn binding_for_reads_the_login_mode_from_the_env_too() {
        // kubelogin accepts AAD_LOGIN_METHOD as well as --login. An entry using
        // the env form drifts under `az account set` exactly like the flag
        // form, so ignoring it silently withholds the note from the operators
        // who need it.
        assert_eq!(
            binding_for(
                "kubelogin",
                &["get-token".to_owned()],
                &[("AAD_LOGIN_METHOD".to_owned(), "azurecli".to_owned())]
            ),
            Some(Binding::FollowsActive)
        );
        // The self-contained modes stay silent through the env form as well.
        assert_eq!(
            binding_for(
                "kubelogin",
                &["get-token".to_owned()],
                &[("AAD_LOGIN_METHOD".to_owned(), "workloadidentity".to_owned())]
            ),
            None
        );
    }

    #[test]
    fn binding_for_claims_only_azurecli_login() {
        assert_eq!(
            binding_for(
                "kubelogin",
                &[
                    "get-token".to_owned(),
                    "--login".to_owned(),
                    "azurecli".to_owned()
                ],
                &[]
            ),
            Some(Binding::FollowsActive)
        );
        assert_eq!(
            binding_for("kubelogin", &["-l".to_owned(), "azurecli".to_owned()], &[]),
            Some(Binding::FollowsActive)
        );
        // Self-contained / per-connect modes can't drift — no note.
        for mode in [
            "spn",
            "msi",
            "workloadidentity",
            "devicecode",
            "interactive",
        ] {
            assert_eq!(
                binding_for("kubelogin", &["--login".to_owned(), mode.to_owned()], &[]),
                None,
                "{mode}"
            );
        }
        // No --login at all: we can't tell, so we say nothing.
        assert_eq!(
            binding_for("kubelogin", &["get-token".to_owned()], &[]),
            None
        );
        assert_eq!(binding_for("aws", &[], &[]), None);
    }

    #[test]
    fn compose_hint_offers_the_az_command_instead_of_a_pin() {
        let accounts = accounts_from_profile(PROFILE_JSON);
        let hint = compose_hint(
            r#"User "ops@example.net" cannot list resource "namespaces": Forbidden"#,
            &accounts,
        )
        .expect("hint expected");
        assert_eq!(hint.provider, Provider::Azure);
        // The whole point: no button, and the remedy is spelled out instead.
        assert!(hint.pin.is_none());
        assert!(hint.detail.contains("az account set"));
        assert!(hint.detail.contains("no per-context account flag"));
        assert_eq!(hint.active_identity.as_deref(), Some("ops@example.net"));
    }

    #[test]
    fn compose_hint_is_silent_on_a_single_account_machine() {
        let single = Identities {
            identities: vec!["ops@example.net".to_owned()],
            active: Some("ops@example.net".to_owned()),
        };
        assert_eq!(compose_hint("403 Forbidden", &single), None);
    }
}
