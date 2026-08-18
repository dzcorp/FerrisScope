//! "Which cloud identity is this context actually using?" — detection, an
//! actionable note for RBAC 403s, and (where the provider allows it) a pin.
//!
//! Every managed-Kubernetes provider has the same trap: the kubeconfig exec
//! entry can either **pin** an identity or **inherit** whichever one the cloud
//! CLI last selected. Inherited identities silently change under the operator —
//! they run one `gcloud config set account` / `export AWS_PROFILE` /
//! `az account set` for unrelated work, and the next connect authenticates as
//! somebody else. The apiserver's reply is a bare RBAC wall that names an
//! identity but explains nothing:
//!
//! ```text
//! namespaces is forbidden: User "ops@example.net" cannot list resource "namespaces"
//! ```
//!
//! The providers are **not** symmetric, and this module doesn't pretend they
//! are — see each submodule's docs:
//!
//! | | pins with | inherits from | shared token cache |
//! |---|---|---|---|
//! | [`gcloud`] | `--account` arg | `gcloud config set account` | one global file, **not** keyed by identity |
//! | [`aws`] | `AWS_PROFILE` exec env | `AWS_PROFILE` / `default` profile | none — every call mints fresh |
//! | [`azure`] | *nothing* | `az account set` | keyed by tenant/client/server, so it doesn't bleed |
//!
//! Only gcloud has the cache-staleness failure mode, only gcloud and AWS can be
//! pinned per-context, and Azure gets detection only. Nothing here is
//! speculative about the others' mechanics: where a provider has no equivalent,
//! this module says so rather than inventing one.
//!
//! **Fail closed.** Every classifier returns `None` when it can't place a
//! context confidently, and [`hint_for_context`] emits nothing on `None`. A
//! missed note is invisible; a wrong one sends the operator chasing an identity
//! problem they don't have.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{Error, Result};

pub mod aws;
pub mod azure;
pub mod gcloud;

/// Suffix for the backup taken before each pin edit of a kubeconfig. Refreshed
/// on every edit — see the rationale in [`edit_exec`].
const BACKUP_SUFFIX: &str = ".ferrisscope-backup";

/// Which cloud CLI's identity model a context is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Gcloud,
    Aws,
    Azure,
}

/// How a context's exec entry decides which cloud identity to authenticate as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    /// The exec entry names an identity, so it can't drift.
    Pinned { identity: String },
    /// Nothing is named: this context inherits whatever the cloud CLI has
    /// selected right now, and that changes under it.
    FollowsActive,
}

/// What a provider can offer to write, when the operator asks to pin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PinOffer {
    /// What the identity is called for this provider — "account", "profile".
    /// Drives the button label so the UI doesn't hardcode per-provider wording.
    pub noun: String,
    /// Everything the pin will do, one complete phrase per effect, rendered
    /// verbatim in the confirm step. Kept free of the chosen identity so the
    /// frontend doesn't have to interpolate into backend prose.
    pub effects: Vec<String>,
}

/// What an operator has to run to renew a lapsed cloud session.
///
/// Separate from [`PinOffer`] because there is nothing for the app to write: the
/// provider wants an identity challenge (usually a browser round trip), and a
/// GUI process spawning the plugin has no terminal to host one. The remedy is a
/// command the operator runs, after which the app's next connect succeeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReauthOffer {
    /// Verbatim command to run, complete with the account flag when the context
    /// pins one.
    pub command: String,
    /// Account whose session lapsed. `None` when the context is unpinned, in
    /// which case whichever account the CLI has active is the one to renew.
    pub account: Option<String>,
}

/// What clears an OS refusal to execute the credential plugin's helper
/// (macOS TCC or a quarantine xattr — "Operation not permitted").
///
/// Separate from [`ReauthOffer`] because no cloud command is involved: the
/// remedies are a per-app privacy grant (the deep link) or stripping the
/// quarantine flag (the command), both outside the provider's CLI entirely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnblockOffer {
    /// The binary the OS refused, when the plugin's stderr named it.
    pub path: Option<String>,
    /// Deep link to the System Settings pane holding the per-app folder
    /// grants. Rendered as a button; also copyable for operators on an OS
    /// where the scheme doesn't resolve.
    pub settings_url: String,
    /// Verbatim quarantine-strip command for the SDK root, when the blocked
    /// path was parseable. `None` leaves only the grant remedy.
    pub command: Option<String>,
}

/// An actionable note to render alongside a failed connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectHint {
    pub provider: Provider,
    /// Short headline for the note.
    pub title: String,
    /// One or two sentences explaining what happened and what to do.
    pub detail: String,
    /// Identity the apiserver reported, when the 403 carried one.
    pub authenticated_as: Option<String>,
    /// Identities configured on this machine — the choices offered by the pin.
    pub identities: Vec<String>,
    /// The identity an unpinned context currently authenticates as.
    pub active_identity: Option<String>,
    /// `None` when the provider has no per-context pin at all (Azure): the note
    /// then explains the CLI command to run instead.
    pub pin: Option<PinOffer>,
    /// Set instead of [`Self::pin`] when the failure was a lapsed cloud session
    /// rather than identity drift. Pinning cannot fix that — only an interactive
    /// login can — so the two are mutually exclusive in practice.
    pub reauth: Option<ReauthOffer>,
    /// Set when the OS refused to execute the plugin's helper. Mutually
    /// exclusive with both [`Self::pin`] and [`Self::reauth`] — neither a pin
    /// nor a login touches an exec refusal.
    pub unblock: Option<UnblockOffer>,
}

/// Pull the identity out of an apiserver RBAC denial (`User "x" cannot …`).
/// Longest plausible identity: an AWS profile name, a Google account, an Azure
/// UPN, or an assumed-role ARN. Generous by an order of magnitude, and shared
/// by [`validate_identity`] (what we're willing to *write*) and
/// [`forbidden_user`] (what we're willing to *believe* from an apiserver).
const MAX_LEN: usize = 256;

/// `None` when the message carries no such clause.
///
/// Provider-agnostic on purpose — GKE reports an email, EKS an IAM/STS ARN, AKS
/// an object id, but all three arrive in the same `User "…"` clause.
#[must_use]
pub fn forbidden_user(message: &str) -> Option<String> {
    // The message reaches us both raw and inside a Rust `Debug` rendering of
    // `Status`, where the quotes are backslash-escaped. Accept either.
    let marker = "User ";
    let mut rest = message;
    while let Some(idx) = rest.find(marker) {
        let after = &rest[idx + marker.len()..];
        let after = after.strip_prefix('\\').unwrap_or(after);
        // `find` returning None means an unterminated quote — keep scanning for
        // a later, well-formed clause rather than bailing out of the whole walk.
        if let Some(inner) = after.strip_prefix('"') {
            if let Some(end) = inner.find(['"', '\\']) {
                let user = &inner[..end];
                // Bounded because the apiserver writes this. The message is
                // whatever the cluster chose to return, and this string gets
                // rendered in the note that sits directly above a button which
                // rewrites the operator's kubeconfig. An unbounded clause is a
                // multi-megabyte allocation cloned through the hint, over IPC,
                // and into the DOM; control characters would let it forge line
                // breaks in that prose. Same reflex as `redact_and_truncate`
                // in `cluster.rs` for exec-plugin stderr.
                if !user.is_empty() && user.len() <= MAX_LEN && !user.chars().any(char::is_control)
                {
                    return Some(user.to_owned());
                }
            }
        }
        rest = &rest[idx + marker.len()..];
    }
    None
}

/// Does this error look like a cloud session that needs an interactive renewal?
///
/// Matches both ends of the same failure: the plugin's own stderr (which
/// [`crate::exec_auth`] captures and puts in the error) and our rendering of
/// [`crate::Error::ExecReauthRequired`], so the note survives whichever layer
/// formatted the string that reaches the frontend.
#[must_use]
pub fn looks_like_reauth(message: &str) -> bool {
    gcloud::classify_exec_failure(message) == gcloud::ExecFailure::ReauthRequired
        || message
            .to_ascii_lowercase()
            .contains("cloud session expired")
}

/// Does this error look like the OS refusing to execute the plugin's helper?
///
/// Matches both the plugin's stderr and our rendering of
/// [`crate::Error::ExecPluginBlocked`] — both carry "operation not permitted",
/// so one test covers whichever layer formatted the string.
#[must_use]
pub fn looks_like_exec_blocked(message: &str) -> bool {
    gcloud::classify_exec_failure(message) == gcloud::ExecFailure::ExecBlocked
}

/// Did the plugin run but fail to find its `gcloud` helper?
///
/// A guarded folder fails macOS's access check, and Go's `LookPath` renders
/// that as "not found" instead of a denial — so this failure carries no EPERM
/// to classify on, yet its remedy is the permission one (grant, then restart).
#[must_use]
pub fn looks_like_helper_hidden(message: &str) -> bool {
    gcloud::classify_exec_failure(message) == gcloud::ExecFailure::HelperHidden
}

/// Does this error string look like a genuine RBAC 403?
///
/// Kubernetes also embeds `Forbidden:` *inside* HTTP 422 validation messages to
/// mean "this field can't be changed", so the 422 shapes are excluded first —
/// the same ordering guard the frontend's `classifyDetailError` applies.
#[must_use]
pub fn is_forbidden(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    // The 422 test needs the same word boundaries as the 403 test below, and
    // for a sharper reason: a 403 message is *full* of long digit runs that can
    // contain "422" by chance — a 12-digit AWS account id in an assumed-role
    // ARN, a 21-digit GCP service-account id, a resourceVersion. A bare
    // `contains("422")` on any of those misfiles a real RBAC denial as a
    // validation error, which silently disables this whole feature for that
    // operator, permanently, and only for them.
    if m.contains("is invalid")
        || contains_word(&m, "422")
        || m.contains("may not change")
        || m.contains("immutable")
    {
        return false;
    }
    // Word boundaries, not bare substrings: `contains("403")` matches the port
    // in "connection refused (127.0.0.1:8403)". Kept in step with the
    // frontend's `isPermanentConnectFailure`, which gates auto-reconnect on the
    // same question.
    contains_word(&m, "forbidden") || contains_word(&m, "403")
}

/// `haystack` contains `needle` bounded by non-alphanumeric characters on both
/// sides. Hand-rolled so `core` doesn't take a regex dependency for two calls.
fn contains_word(haystack: &str, needle: &str) -> bool {
    // An empty needle matches at every position and would never advance `from`.
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        // Boundaries are tested per `char`, not per byte: a byte-wise
        // `is_ascii_alphanumeric` check reads any non-ASCII neighbour as a
        // boundary, so "фффforbidden" and "日本語403日本語" would both count as
        // whole-word hits. Apiserver messages are ASCII today, so this can't
        // misfire in practice — but a boundary test that only understands ASCII
        // is the kind of thing that silently starts lying the moment an error
        // string carries a localized prefix.
        let before_ok = haystack[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after_ok = haystack[end..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        // Resume past this occurrence. `end` is a char boundary because the
        // match started on one and `needle` is whole; `start + 1` would not be
        // for a multi-byte needle.
        from = end;
    }
    false
}

/// The basename of an exec command, minus any Windows `.exe`. Provider
/// detection keys on this so an absolute path
/// (`/opt/google-cloud-sdk/bin/gke-gcloud-auth-plugin`) still resolves.
#[must_use]
pub fn command_basename(command: &str) -> &str {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    base.strip_suffix(".exe").unwrap_or(base)
}

/// Value of `--flag=x` or `--flag x` in an arg list, whichever form is used.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let eq = format!("{flag}=");
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if let Some(value) = arg.strip_prefix(eq.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        } else if arg == flag {
            let value = it.next()?.trim();
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

/// Value of an exec-block env var, ignoring blank values.
fn exec_env(env: &[(String, String)], key: &str) -> Option<String> {
    env.iter()
        .find(|(k, v)| k == key && !v.trim().is_empty())
        .map(|(_, v)| v.trim().to_owned())
}

/// Classify a context against every provider we know, in turn.
///
/// `None` when no provider claims the command, or when the one that does can't
/// place this particular invocation (an unusual `kubelogin --login` mode, say).
/// Both cases mean "say nothing".
#[must_use]
pub fn classify(
    command: &str,
    args: &[String],
    env: &[(String, String)],
) -> Option<(Provider, Binding)> {
    let base = command_basename(command);
    gcloud::binding_for(base, args, env)
        .map(|b| (Provider::Gcloud, b))
        .or_else(|| aws::binding_for(base, args, env).map(|b| (Provider::Aws, b)))
        .or_else(|| azure::binding_for(base, args, env).map(|b| (Provider::Azure, b)))
}

/// Diagnose a failed connect for one context: read its exec entry off disk,
/// classify the identity binding, probe the local CLI config, and compose the
/// note — or `None` when this isn't an identity problem.
///
/// Runs only on a connect failure, so the disk reads never touch the happy path.
///
/// # Errors
///
/// Propagates kubeconfig read/parse failures. A context with no exec plugin, an
/// unrecognised provider, or no resolvable CLI config is `Ok(None)` — not an
/// error.
pub fn hint_for_context(
    context_name: &str,
    source_path: Option<&Path>,
    error: &str,
) -> Result<Option<ConnectHint>> {
    hint_for_context_with(
        context_name,
        source_path,
        error,
        &|provider| match provider {
            Provider::Gcloud => gcloud::probe().unwrap_or_default(),
            Provider::Aws => aws::probe(),
            Provider::Azure => azure::probe().unwrap_or_default(),
        },
    )
}

/// [`hint_for_context`] with the CLI-config probe injected.
///
/// Exists so the gates above can be tested without reading whatever gcloud/AWS
/// config the developer running the suite happens to have. The probe is only
/// consulted *after* every refusal, which is the property most worth pinning:
/// a test that had to stub a real config directory to reach those branches
/// wouldn't be testing them.
fn hint_for_context_with(
    context_name: &str,
    source_path: Option<&Path>,
    error: &str,
    probe: &dyn Fn(Provider) -> Identities,
) -> Result<Option<ConnectHint>> {
    // Three different failures reach here. A 403 means the connect
    // *authenticated* and was refused, which is where identity drift shows up.
    // A lapsed cloud session never gets that far — the exec plugin refuses to
    // produce a token at all — and an OS exec refusal never even runs the
    // helper. The last two need their own gates, and they must come first:
    // neither message is a 403 and both would otherwise be dropped below.
    let reauth = looks_like_reauth(error);
    let blocked = looks_like_exec_blocked(error);
    let helper_hidden = looks_like_helper_hidden(error);
    if !reauth && !blocked && !helper_hidden && !is_forbidden(error) {
        return Ok(None);
    }
    let Some(spec) = crate::cluster::exec_spec_for_context(context_name, source_path)? else {
        return Ok(None);
    };
    let Some((provider, binding)) = classify(&spec.command, &spec.args, &spec.env) else {
        return Ok(None);
    };
    if blocked {
        // Only gcloud: the classifier that produced `blocked` is gcloud's, and
        // the note's prose names the gcloud SDK layout. Another provider's
        // EPERM would get confident prose about the wrong SDK.
        if provider != Provider::Gcloud {
            return Ok(None);
        }
        return Ok(Some(gcloud::compose_blocked_hint(
            gcloud::blocked_path(error).as_deref(),
        )));
    }
    if helper_hidden {
        // Same restriction as `blocked`: the classifier and the note's prose are
        // both gcloud's, so another provider would get confident advice about an
        // SDK it does not use.
        if provider != Provider::Gcloud {
            return Ok(None);
        }
        return Ok(Some(gcloud::compose_hidden_helper_hint()));
    }
    if reauth {
        // Only gcloud is claimed here. AWS mints per call (no session to lapse),
        // and kubelogin's device/interactive modes fail differently — inventing
        // matching prose for either would be guessing.
        if provider != Provider::Gcloud {
            return Ok(None);
        }
        let account = match &binding {
            Binding::Pinned { identity } => Some(identity.clone()),
            Binding::FollowsActive => None,
        };
        let identities = probe(provider);
        return Ok(Some(gcloud::compose_reauth_hint(
            account.as_deref(),
            &identities,
        )));
    }
    // A pinned context can't be suffering identity drift, whatever the
    // provider — the 403 is a plain RBAC gap.
    if binding != Binding::FollowsActive {
        return Ok(None);
    }
    let identities = probe(provider);
    Ok(match provider {
        Provider::Gcloud => gcloud::compose_hint(error, &identities),
        Provider::Aws => aws::compose_hint(error, &identities),
        Provider::Azure => azure::compose_hint(error, &identities),
    })
}

/// The identities a provider's CLI has configured, plus the active one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Identities {
    /// Sorted and deduped.
    pub identities: Vec<String>,
    /// What an unpinned context authenticates as right now.
    pub active: Option<String>,
}

/// Write an identity pin into `context`'s exec entry, dispatching on whichever
/// provider owns the exec command.
///
/// # Errors
///
/// Refuses (rather than guessing) when the context or its user is absent from
/// *this* file — the multi-file `KUBECONFIG` case, where
/// [`crate::kubeconfig::default_kubeconfig_path`] only yields the first entry —
/// or when the provider has no per-context pin (Azure).
pub fn pin_identity(kubeconfig: &Path, context: &str, identity: &str) -> Result<()> {
    pin_identity_at(
        kubeconfig,
        context,
        identity,
        gcloud::plugin_cache_path().as_deref(),
        crate::exec_auth::slots_root().as_deref(),
    )
}

/// Reject identity values that have no business being written into a
/// kubeconfig exec entry.
///
/// In practice the value comes from a picker populated by our own scan of the
/// local CLI config, so it's well-formed. But it crosses a Tauri command
/// boundary as a free string and lands verbatim in an argv element or an env
/// value, so it gets checked at the boundary rather than trusted by provenance.
///
/// A newline in an env value or a control character in an argv element is never
/// legitimate here, and the length cap stops a pathological value from bloating
/// the file we're about to rewrite.
/// # Errors
///
/// [`Error::Invalid`] when the value is empty, over [`MAX_LEN`], or carries
/// control characters.
pub fn validate_identity(identity: &str) -> Result<()> {
    if identity.is_empty() {
        return Err(Error::Invalid("identity must not be empty".to_owned()));
    }
    if identity.len() > MAX_LEN {
        return Err(Error::Invalid(format!(
            "identity is {} bytes; the limit is {MAX_LEN}",
            identity.len()
        )));
    }
    if identity.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "identity must not contain control characters or newlines".to_owned(),
        ));
    }
    Ok(())
}

/// [`pin_identity`] with both token cache locations injected: the plugin's
/// default file and the root of the slots we hand it ourselves.
///
/// Exists so tests can exercise the real code path — including the
/// gcloud-only cache clear — without reaching into the developer's `$HOME` and
/// deleting a cache file that other tools on the machine are using.
fn pin_identity_at(
    kubeconfig: &Path,
    context: &str,
    identity: &str,
    gcloud_cache: Option<&Path>,
    slots_root: Option<&Path>,
) -> Result<()> {
    let identity = identity.trim();
    validate_identity(identity)?;
    let mut pinned_provider = None;
    edit_exec(kubeconfig, context, |exec| {
        let command = exec
            .get("command")
            .and_then(serde_yaml::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match command_basename(&command) {
            b if gcloud::OWNS_COMMANDS.contains(&b) => {
                pinned_provider = Some(Provider::Gcloud);
                gcloud::write_pin(exec, identity)
            }
            b if aws::OWNS_COMMANDS.contains(&b) => {
                pinned_provider = Some(Provider::Aws);
                aws::write_pin(exec, identity)
            }
            b if azure::OWNS_COMMANDS.contains(&b) => Err(Error::Invalid(
                "kubelogin has no per-context account flag — switch with `az account set` instead"
                    .to_owned(),
            )),
            _ => Err(Error::Invalid(format!(
                "exec plugin '{command}' has no cloud identity to pin"
            ))),
        }
    })?;

    // Post-write cleanup, and the one place the providers genuinely diverge:
    // only gcloud keeps a global token cache that isn't keyed by identity, so
    // only gcloud can still be holding a token minted as somebody else. AWS
    // mints per call and kubelogin's cache is keyed by tenant/client/server —
    // clearing anything for them would be cargo-culting this fix.
    if pinned_provider == Some(Provider::Gcloud) {
        if let Some(cache) = gcloud_cache {
            gcloud::clear_plugin_cache_at(cache).map_err(|e| {
                Error::Invalid(format!(
                    "account pinned, but clearing the gcloud auth plugin token cache failed: {e}"
                ))
            })?;
        }
        // The default slot above isn't the only one: every slot
        // `crate::exec_auth` hands the plugin can hold a token minted under the
        // pre-pin identity too, and the newly pinned account reads a *different*
        // slot, so a stale one would sit there until it expired.
        if let Some(root) = slots_root {
            crate::exec_auth::clear_cache_slots_at(root).map_err(|e| {
                Error::Invalid(format!(
                    "account pinned, but clearing the app's auth token cache failed: {e}"
                ))
            })?;
        }
    }
    Ok(())
}

/// Read a kubeconfig, hand `f` the mutable exec mapping for `context`, then back
/// the file up (once) and write it back atomically.
///
/// Edits the YAML as a [`serde_yaml::Value`] rather than round-tripping through
/// the typed `Kubeconfig`: the typed form silently drops fields it doesn't model
/// and reorders everything, which is not an acceptable thing to do to an
/// operator's kubeconfig. Value-level editing preserves unknown keys and
/// document order; comments are lost either way, which is why the backup exists.
///
/// Nothing is written if `f` fails.
fn edit_exec<F>(kubeconfig: &Path, context: &str, f: F) -> Result<()>
where
    F: FnOnce(&mut serde_yaml::Mapping) -> Result<()>,
{
    // Follow symlinks before touching anything. The atomic replace renames a
    // tempfile over the target, and a rename replaces the *link* rather than
    // what it points at — so editing `~/.kube/config -> ~/dotfiles/kube/config`
    // would silently swap the operator's symlink for a regular file and leave
    // the real, still-authoritative file untouched. Editing the resolved path
    // keeps the indirection intact.
    //
    // `canonicalize` also resolves `..` and relative paths, so the backup lands
    // next to the real file rather than next to the link.
    let kubeconfig =
        &std::fs::canonicalize(kubeconfig).unwrap_or_else(|_| kubeconfig.to_path_buf());

    let original = std::fs::read_to_string(kubeconfig)?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&original)?;

    let user_name = context_user_name(&doc, context).ok_or_else(|| {
        Error::Invalid(format!(
            "context '{context}' is not in {} — if your KUBECONFIG lists several files, \
             the context lives in a different one and must be pinned there",
            kubeconfig.display()
        ))
    })?;

    // The pin edits the *user*, but the operator asked about a *context*. When
    // several contexts share one exec entry, changing it re-points all of them
    // — including ones that are working fine — and the operator was told this
    // would touch "this context's exec entry". Refuse rather than silently
    // widen the blast radius; the message names the siblings so they can split
    // the user by hand if that's really what they want.
    let sharing = contexts_using_user(&doc, &user_name);
    if sharing.len() > 1 {
        let others: Vec<&str> = sharing
            .iter()
            .map(String::as_str)
            .filter(|c| *c != context)
            .collect();
        return Err(Error::Invalid(format!(
            "user '{user_name}' is shared by {} contexts ({}), so pinning it here would also \
             re-point {} — nothing was written. Give '{context}' its own user entry first.",
            sharing.len(),
            sharing.join(", "),
            others.join(", ")
        )));
    }

    let exec = user_exec_mut(&mut doc, &user_name).ok_or_else(|| {
        Error::Invalid(format!(
            "user '{user_name}' in {} has no exec credential plugin to pin",
            kubeconfig.display()
        ))
    })?;

    f(exec)?;

    let serialized = serde_yaml::to_string(&doc)?;
    // Genuine no-op: re-pinning the identity a context already carries must not
    // touch the file at all. Without this the "nothing changed" case still
    // rewrites the kubeconfig and — worse — refreshes the backup, so a stray
    // second click would discard the pre-edit copy for no benefit.
    if serialized == original {
        return Ok(());
    }

    // Lost-update guard. Everything above works from the snapshot read at the
    // top of this function; between that read and the write below, `gcloud
    // container clusters get-credentials` (or another FerrisScope window, or a
    // hand edit) can rewrite the file. Writing our stale tree would silently
    // discard those changes. Re-read and compare instead: cheap, and refusing
    // is always better than losing an operator's contexts.
    //
    // This narrows the window rather than closing it — a writer landing between
    // this compare and the rename below still loses. Closing it properly needs
    // an advisory lock the other writers (gcloud, kubectl) don't take, so it
    // would buy nothing against the writer that actually matters.
    if std::fs::read_to_string(kubeconfig).is_ok_and(|now| now != original) {
        return Err(Error::Invalid(format!(
            "{} changed on disk while preparing the edit — nothing was written. \
             Reconnect and try again.",
            kubeconfig.display()
        )));
    }

    // Preserve the target's own mode across the atomic replace — the rename
    // swaps the inode, so without this a 0600 kubeconfig comes back 0644. The
    // backup inherits the same mode: a world-readable twin full of client certs
    // and bearer tokens sitting next to a 0600 original would defeat the point.
    let mode = crate::atomic_write::file_mode(kubeconfig);

    // Back up the file as it stands *right now*, overwriting any previous
    // backup, so the copy always means "the state immediately before the most
    // recent FerrisScope edit".
    //
    // The earlier design kept the first backup forever and never overwrote it.
    // That's the wrong semantic: what the backup protects against is *this*
    // edit reflowing the YAML and dropping comments. A pristine copy from six
    // months ago protects against nothing today, and restoring it would silently
    // discard every context `gcloud container clusters get-credentials` has
    // written since — a landmine wearing a safety net's label.
    //
    // Written from the `original` bytes already in memory rather than
    // `fs::copy`, which would be wrong three ways: it leaves a *truncated*
    // destination behind when it fails partway (so a full disk destroys the
    // good backup and leaves a plausible-looking short one), it follows a
    // symlink at the destination (a pre-planted `config.ferrisscope-backup ->`
    // anywhere redirects the credential body there), and it re-reads a file
    // that may already have changed. The atomic writer renames over the
    // destination, so it replaces a symlink instead of following it, and leaves
    // the previous backup untouched if anything fails.
    let backup = backup_path(kubeconfig);
    crate::atomic_write::atomic_write_sync_mode(&backup, original.as_bytes(), mode)?;

    crate::atomic_write::atomic_write_sync_mode(kubeconfig, serialized.as_bytes(), mode)?;
    Ok(())
}

/// Names of every context whose `context.user` is `user_name`.
///
/// Used to refuse a pin that would silently re-point sibling contexts sharing
/// one exec entry.
fn contexts_using_user(doc: &serde_yaml::Value, user_name: &str) -> Vec<String> {
    doc.get("contexts")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|contexts| {
            contexts
                .iter()
                .filter(|entry| {
                    entry
                        .get("context")
                        .and_then(|c| c.get("user"))
                        .and_then(serde_yaml::Value::as_str)
                        == Some(user_name)
                })
                .filter_map(|entry| {
                    entry
                        .get("name")
                        .and_then(serde_yaml::Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Where a pin stashes the copy of a kubeconfig taken immediately before the
/// most recent edit. Sits next to the kubeconfig itself so the operator finds it
/// where they'd look; the `.ferrisscope-backup` suffix keeps it out of
/// FerrisScope's own folder-source scan (`kubeconfig::filename_is_candidate`
/// only admits `config`, `*.yaml`, `*.yml`, `*.conf`, `*.kubeconfig` and
/// extensionless names), so a backup can never reappear as a duplicate set of
/// contexts.
#[must_use]
pub fn backup_path(kubeconfig: &Path) -> PathBuf {
    let mut name = kubeconfig.as_os_str().to_owned();
    name.push(BACKUP_SUFFIX);
    PathBuf::from(name)
}

/// The user name a context points at.
fn context_user_name(doc: &serde_yaml::Value, context: &str) -> Option<String> {
    doc.get("contexts")?
        .as_sequence()?
        .iter()
        .find(|c| c.get("name").and_then(serde_yaml::Value::as_str) == Some(context))?
        .get("context")?
        .get("user")?
        .as_str()
        .map(str::to_owned)
}

/// Mutable handle on `users[name].user.exec`.
fn user_exec_mut<'a>(
    doc: &'a mut serde_yaml::Value,
    user_name: &str,
) -> Option<&'a mut serde_yaml::Mapping> {
    doc.get_mut("users")?
        .as_sequence_mut()?
        .iter_mut()
        .find(|u| u.get("name").and_then(serde_yaml::Value::as_str) == Some(user_name))?
        .get_mut("user")?
        .get_mut("exec")?
        .as_mapping_mut()
}

/// Read the exec `args` list as strings.
fn exec_args(exec: &serde_yaml::Mapping) -> Vec<String> {
    exec.get("args")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Replace the exec `args` list.
fn set_exec_args(exec: &mut serde_yaml::Mapping, args: Vec<String>) {
    exec.insert(
        serde_yaml::Value::String("args".to_owned()),
        serde_yaml::Value::Sequence(args.into_iter().map(serde_yaml::Value::String).collect()),
    );
}

/// Upsert `key=value` in the exec `env` block, preserving every other entry and
/// their order. Creates the block when absent.
fn set_exec_env(exec: &mut serde_yaml::Mapping, key: &str, value: &str) {
    let mut entries: Vec<serde_yaml::Value> = exec
        .get("env")
        .and_then(serde_yaml::Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let mut replaced = false;
    for entry in &mut entries {
        if entry.get("name").and_then(serde_yaml::Value::as_str) == Some(key) {
            if let Some(map) = entry.as_mapping_mut() {
                map.insert(
                    serde_yaml::Value::String("value".to_owned()),
                    serde_yaml::Value::String(value.to_owned()),
                );
                replaced = true;
            }
        }
    }
    if !replaced {
        let mut map = serde_yaml::Mapping::new();
        map.insert(
            serde_yaml::Value::String("name".to_owned()),
            serde_yaml::Value::String(key.to_owned()),
        );
        map.insert(
            serde_yaml::Value::String("value".to_owned()),
            serde_yaml::Value::String(value.to_owned()),
        );
        entries.push(serde_yaml::Value::Mapping(map));
    }
    exec.insert(
        serde_yaml::Value::String("env".to_owned()),
        serde_yaml::Value::Sequence(entries),
    );
}

/// Names of every `[section]` in an INI file, in order of appearance.
///
/// Shared by gcloud (one `[core]` section per configuration) and AWS (one
/// section per profile). Hand-rolled to avoid an INI dependency for what is a
/// dozen lines of parsing.
fn ini_sections(ini: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in ini.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(section) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let section = section.trim();
            if !section.is_empty() {
                out.push(section.to_owned());
            }
        }
    }
    out
}

/// Value of `key` inside `[section]`. Section-aware so a same-named key in
/// another section can't be mistaken for it.
fn ini_value(ini: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for line in ini.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_section = name.trim().eq_ignore_ascii_case(section);
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim().eq_ignore_ascii_case(key) {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_owned());
                }
            }
        }
    }
    None
}

/// `$HOME` (or `%USERPROFILE%` on Windows) as a path.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// A non-empty, trimmed env var.
fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) const FORBIDDEN_403: &str = r#"apiserver liveness probe failed: ApiError: namespaces is forbidden: User "ops@example.net" cannot list resource "namespaces" in API group "" at the cluster scope: Forbidden (Status { status: Some(Failure), code: 403, message: "namespaces is forbidden: User \"ops@example.net\" cannot list resource \"namespaces\"" })"#;

    #[test]
    fn forbidden_user_parses_every_provider_shape() {
        assert_eq!(
            forbidden_user(FORBIDDEN_403).as_deref(),
            Some("ops@example.net")
        );
        // EKS reports an STS ARN rather than an email.
        assert_eq!(
            forbidden_user(
                r#"User "arn:aws:sts::111122223333:assumed-role/Dev/session" cannot list resource "pods""#
            )
            .as_deref(),
            Some("arn:aws:sts::111122223333:assumed-role/Dev/session")
        );
        // Escaped-quote form (Debug rendering of Status) on its own.
        assert_eq!(
            forbidden_user(r#"pods is forbidden: User \"a@b.io\" cannot list"#).as_deref(),
            Some("a@b.io")
        );
        assert_eq!(forbidden_user("connection refused"), None);
        assert_eq!(forbidden_user("User without quotes"), None);
    }

    #[test]
    fn is_forbidden_excludes_422_validation_messages() {
        assert!(is_forbidden(FORBIDDEN_403));
        assert!(is_forbidden("403 Forbidden"));
        // 422 with an embedded "Forbidden:" is a field-immutability error.
        assert!(!is_forbidden(
            "Pod \"x\" is invalid: spec: Forbidden: pod updates may not change fields other than image"
        ));
        assert!(!is_forbidden("field is immutable"));
        assert!(!is_forbidden("connection refused"));
        // A port that merely contains 403 is not an authorization failure.
        assert!(!is_forbidden(
            "tcp connect error: 127.0.0.1:8403: Connection refused"
        ));
        assert!(!is_forbidden("dial tcp 10.40.3.7:6443: i/o timeout"));
    }

    /// A probe that fails the test if it is ever consulted. Every refusal gate
    /// in `hint_for_context` must fire *before* any CLI config is read.
    fn no_probe(_: Provider) -> Identities {
        panic!("the probe must not run once a gate has refused");
    }

    fn two_accounts(_: Provider) -> Identities {
        Identities {
            identities: vec!["a@example.com".to_owned(), "b@example.com".to_owned()],
            active: Some("b@example.com".to_owned()),
        }
    }

    #[test]
    fn hint_refuses_before_probing_anything() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let hint = |ctx: &str, err: &str, probe: &dyn Fn(Provider) -> Identities| {
            hint_for_context_with(ctx, Some(&path), err, probe)
        };

        // Not a 403 at all — the overwhelmingly common case, and the reason the
        // gate is first: it keeps the disk reads off every ordinary timeout.
        assert_eq!(
            hint("gke", "timed out after 15s", &no_probe).expect("hint"),
            None
        );
        // A 422 whose message embeds "Forbidden:" is a field-validation error.
        assert_eq!(
            hint(
                "gke",
                r#"Pod "x" is invalid: spec: Forbidden: may not change (code: 422)"#,
                &no_probe
            )
            .expect("hint"),
            None
        );
        // No exec plugin: token auth can't drift under a CLI.
        assert_eq!(hint("plain", FORBIDDEN_403, &no_probe).expect("hint"), None);
        // Absent context — the multi-file KUBECONFIG shape.
        assert_eq!(hint("nope", FORBIDDEN_403, &no_probe).expect("hint"), None);
    }

    /// Verbatim from `Error::ExecReauthRequired`'s rendering of a real plugin
    /// failure — the string the frontend actually hands back to `connect_hint`.
    const REAUTH_ERROR: &str = "cloud session expired for a@example.com — run \
         `gcloud auth login --account=a@example.com` in a terminal (ERROR: \
         (gcloud.config.config-helper) There was a problem refreshing your current auth tokens: \
         Reauthentication failed. cannot prompt during non-interactive execution.)";

    #[test]
    fn a_lapsed_session_gets_a_reauth_note_not_a_pin() {
        // This failure never reaches the apiserver, so it carries no 403 and
        // the drift gates would drop it. It also must not offer a pin: the
        // account is fine, its session isn't, and pinning would edit the
        // operator's kubeconfig for nothing.
        let tmp = tempfile::tempdir().expect("tempdir");
        let pinned = KUBECONFIG_YAML.replace(
            "      command: gke-gcloud-auth-plugin",
            "      command: gke-gcloud-auth-plugin\n      args: [\"--account=a@example.com\"]",
        );
        let path = kubeconfig_fixture(tmp.path(), &pinned);
        let hint = hint_for_context_with("gke", Some(&path), REAUTH_ERROR, &two_accounts)
            .expect("hint")
            .expect("a reauth note");

        assert_eq!(hint.provider, Provider::Gcloud);
        assert_eq!(hint.pin, None);
        let offer = hint.reauth.expect("reauth offer");
        assert_eq!(offer.account.as_deref(), Some("a@example.com"));
        assert_eq!(offer.command, "gcloud auth login --account=a@example.com");
        assert!(hint.detail.contains("terminal"));
    }

    /// Verbatim from `Error::ExecPluginBlocked`'s rendering — the string the
    /// frontend hands back to `connect_hint` after a TCC-blocked preflight.
    const BLOCKED_ERROR: &str = "the OS blocked the exec credential plugin \
         'gke-gcloud-auth-plugin' — operation not permitted executing \
         /Users/u/Downloads/google-cloud-sdk/bin/gcloud (print credential failed with error: \
         Failed to retrieve access token:: failure while executing gcloud: exit status 126 \
         (err: /bin/sh: /Users/u/Downloads/google-cloud-sdk/bin/gcloud: Operation not permitted))";

    #[test]
    fn a_blocked_plugin_gets_an_unblock_note_without_probing() {
        // Never reaches the apiserver (no 403) and never ran gcloud (no reauth
        // wording) — only the blocked gate can admit it. The probe must stay
        // unconsulted: no account list changes the remedy for an OS refusal.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let hint = hint_for_context_with("gke", Some(&path), BLOCKED_ERROR, &no_probe)
            .expect("hint")
            .expect("an unblock note");

        assert_eq!(hint.provider, Provider::Gcloud);
        assert_eq!(hint.pin, None);
        assert_eq!(hint.reauth, None);
        let offer = hint.unblock.expect("unblock offer");
        assert_eq!(
            offer.path.as_deref(),
            Some("/Users/u/Downloads/google-cloud-sdk/bin/gcloud")
        );
        assert_eq!(offer.settings_url, gcloud::MACOS_PRIVACY_SETTINGS_URL);
        // A context with no exec plugin can't have had its plugin blocked.
        assert_eq!(
            hint_for_context_with("plain", Some(&path), BLOCKED_ERROR, &no_probe).expect("hint"),
            None
        );
    }

    #[test]
    fn a_lapsed_session_on_an_unpinned_context_renews_the_active_account() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let hint = hint_for_context_with(
            "gke",
            Some(&path),
            "Reauthentication failed. cannot prompt during non-interactive execution.",
            &two_accounts,
        )
        .expect("hint")
        .expect("a reauth note");

        let offer = hint.reauth.expect("reauth offer");
        assert_eq!(
            offer.account, None,
            "an unpinned context has no account of its own to name"
        );
        assert_eq!(
            offer.command, "gcloud auth login",
            "so the command must not invent one either"
        );
        // The note still says which account gcloud would renew.
        assert!(hint.detail.contains("b@example.com"));
    }

    #[test]
    fn the_reauth_gate_stays_inside_gcloud() {
        // AWS mints a token per call, so there is no session to lapse; kubelogin
        // fails differently. Matching prose for either would be invention.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        for ctx in ["eks", "aks"] {
            assert_eq!(
                hint_for_context_with(ctx, Some(&path), REAUTH_ERROR, &two_accounts).expect("hint"),
                None,
                "{ctx} must not be handed gcloud's reauth wording"
            );
        }
        // Nor does a context with no exec plugin at all.
        assert_eq!(
            hint_for_context_with("plain", Some(&path), REAUTH_ERROR, &no_probe).expect("hint"),
            None
        );
    }

    #[test]
    fn an_ordinary_403_is_still_drift_not_reauth() {
        // The two gates must not bleed: a plain RBAC denial keeps offering the
        // pin, with no reauth offer attached.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let hint = hint_for_context_with("gke", Some(&path), FORBIDDEN_403, &two_accounts)
            .expect("hint")
            .expect("a drift note");
        assert!(hint.pin.is_some());
        assert_eq!(hint.reauth, None);
    }

    #[test]
    fn hint_refuses_a_context_that_already_names_an_identity() {
        // The gate that stops the note firing on a correctly-pinned context.
        // Without it, a genuine RBAC gap on a pinned context is misdiagnosed as
        // identity drift and the operator is offered a re-pin of what is
        // already pinned.
        let tmp = tempfile::tempdir().expect("tempdir");
        let pinned = KUBECONFIG_YAML.replace(
            "      command: gke-gcloud-auth-plugin",
            "      command: gke-gcloud-auth-plugin\n      args: [\"--account=a@example.com\"]",
        );
        let path = kubeconfig_fixture(tmp.path(), &pinned);
        assert_eq!(
            hint_for_context_with("gke", Some(&path), FORBIDDEN_403, &no_probe).expect("hint"),
            None
        );
    }

    #[test]
    fn hint_routes_each_provider_to_its_own_composer() {
        // The dispatch is three near-identical arms, so a swapped pair compiles
        // and passes anything that only checks "some hint came back". Assert
        // the provider tag and the provider-specific noun instead.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let hint = |ctx: &str| {
            hint_for_context_with(ctx, Some(&path), FORBIDDEN_403, &two_accounts)
                .expect("hint")
                .expect("a hint for an unpinned context")
        };

        let g = hint("gke");
        assert_eq!(g.provider, Provider::Gcloud);
        assert_eq!(g.pin.as_ref().map(|p| p.noun.as_str()), Some("account"));

        let a = hint("eks");
        assert_eq!(a.provider, Provider::Aws);
        assert_eq!(a.pin.as_ref().map(|p| p.noun.as_str()), Some("profile"));

        // Azure is detect-only: a hint, but deliberately no pin to offer.
        let z = hint("aks");
        assert_eq!(z.provider, Provider::Azure);
        assert!(z.pin.is_none());
    }

    #[test]
    fn is_forbidden_survives_digit_runs_that_merely_contain_422() {
        // A real RBAC denial names the principal, and those names carry long
        // digit runs: a 12-digit AWS account id, a 21-digit GCP service-account
        // id, a resourceVersion. A bare `contains("422")` reads any of them as
        // a validation error and silently switches the whole feature off — for
        // that one operator, forever, in a way that never reproduces elsewhere.
        assert!(is_forbidden(
            r#"pods is forbidden: User "arn:aws:sts::422019876543:assumed-role/Dev/sess" cannot list resource "pods": Forbidden"#
        ));
        assert!(is_forbidden(
            r#"namespaces is forbidden: User "422098765432-compute@developer.gserviceaccount.com" cannot list: Forbidden"#
        ));
        assert!(is_forbidden(
            r#"namespaces is forbidden: User "ops@example.net" cannot list (resourceVersion 4221903): Forbidden"#
        ));
        // A genuine 422 still has to be excluded — that's what the guard is for.
        assert!(!is_forbidden(
            r#"Pod "x" is invalid: spec: Forbidden: pod updates may not change fields (Status { code: 422 })"#
        ));
    }

    #[test]
    fn forbidden_user_refuses_what_a_hostile_apiserver_could_send() {
        // The message is written by whatever cluster the operator pointed at,
        // and this value is rendered directly above a button that rewrites
        // their kubeconfig. Length and control characters are the two levers a
        // remote party has on that prose.
        let huge = format!(
            r#"forbidden: User "{}" cannot list"#,
            "a".repeat(MAX_LEN + 1)
        );
        assert_eq!(forbidden_user(&huge), None);
        let exact = format!(r#"forbidden: User "{}" cannot list"#, "a".repeat(MAX_LEN));
        assert_eq!(forbidden_user(&exact).map(|u| u.len()), Some(MAX_LEN));
        assert_eq!(
            forbidden_user("forbidden: User \"ops@example.net\nAccess was revoked in error; pin below.\" cannot list"),
            None,
            "a newline would let the apiserver forge extra lines of our own prose"
        );
        // The ordinary case still parses.
        assert_eq!(
            forbidden_user(r#"forbidden: User "ops@example.net" cannot list"#).as_deref(),
            Some("ops@example.net")
        );
    }

    #[test]
    fn contains_word_respects_non_ascii_boundaries() {
        // Byte-wise boundary tests read every non-ASCII neighbour as a
        // boundary, so these would all be false positives.
        assert!(!contains_word("фффforbidden", "forbidden"));
        assert!(!contains_word("日本語403日本語", "403"));
        assert!(!contains_word("forbiddenфф", "forbidden"));
        // Genuine boundaries, ASCII and not.
        assert!(contains_word("кластер forbidden ошибка", "forbidden"));
        assert!(contains_word("код: 403, причина", "403"));
        assert!(contains_word("forbidden", "forbidden"));
        assert!(contains_word("(403)", "403"));
        // A non-bounded first occurrence must not mask a bounded later one.
        assert!(contains_word("x403 403", "403"));
        assert!(!contains_word("x403x", "403"));
        assert!(!contains_word("", "403"));
        assert!(!contains_word("anything", ""));
    }

    #[test]
    fn command_basename_strips_paths_and_exe() {
        assert_eq!(
            command_basename("/opt/google-cloud-sdk/bin/gke-gcloud-auth-plugin"),
            "gke-gcloud-auth-plugin"
        );
        assert_eq!(command_basename(r"C:\tools\kubelogin.exe"), "kubelogin");
        assert_eq!(command_basename("aws"), "aws");
    }

    #[test]
    fn flag_value_handles_both_forms() {
        let joined = ["--profile=dev".to_owned()];
        let split = ["--profile".to_owned(), "dev".to_owned()];
        assert_eq!(flag_value(&joined, "--profile").as_deref(), Some("dev"));
        assert_eq!(flag_value(&split, "--profile").as_deref(), Some("dev"));
        // A dangling flag with no value is not a pin.
        assert_eq!(flag_value(&["--profile".to_owned()], "--profile"), None);
        assert_eq!(flag_value(&joined, "--account"), None);
    }

    #[test]
    fn ini_helpers_are_section_scoped() {
        let ini = "[compute]\naccount = wrong@example.com\n\n[core]\naccount = right@example.com\n";
        assert_eq!(
            ini_value(ini, "core", "account").as_deref(),
            Some("right@example.com")
        );
        assert_eq!(ini_value(ini, "core", "project"), None);
        assert_eq!(ini_value("[core]\naccount =\n", "core", "account"), None);
        assert_eq!(ini_sections(ini), vec!["compute", "core"]);
        assert_eq!(ini_sections("# [commented]\n[real]\n"), vec!["real"]);
    }

    #[test]
    fn classify_routes_each_provider_and_fails_closed() {
        assert_eq!(
            classify("gke-gcloud-auth-plugin", &[], &[]),
            Some((Provider::Gcloud, Binding::FollowsActive))
        );
        assert_eq!(
            classify("aws", &["eks".to_owned(), "get-token".to_owned()], &[]),
            Some((Provider::Aws, Binding::FollowsActive))
        );
        assert_eq!(
            classify(
                "kubelogin",
                &["--login".to_owned(), "azurecli".to_owned()],
                &[]
            ),
            Some((Provider::Azure, Binding::FollowsActive))
        );
        // Unknown plugin → no provider, hence no note.
        assert_eq!(classify("oidc-login", &[], &[]), None);
        // A kubelogin mode with no ambient-identity story → also no note.
        assert_eq!(
            classify(
                "kubelogin",
                &["--login".to_owned(), "workloadidentity".to_owned()],
                &[]
            ),
            None
        );
    }

    // --- shared kubeconfig editing ---------------------------------------

    pub(super) const KUBECONFIG_YAML: &str = r#"
apiVersion: v1
kind: Config
current-context: gke
preferences:
  colors: true
clusters:
- name: c
  cluster:
    server: https://1.2.3.4
contexts:
- name: gke
  context:
    cluster: c
    user: gke-user
- name: eks
  context:
    cluster: c
    user: eks-user
- name: aks
  context:
    cluster: c
    user: aks-user
- name: plain
  context:
    cluster: c
    user: token-user
users:
- name: gke-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      provideClusterInfo: true
- name: eks-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["--region", "us-east-1", "eks", "get-token", "--cluster-name", "prod"]
      env:
      - name: AWS_REGION
        value: us-east-1
- name: aks-user
  user:
    exec:
      command: kubelogin
      args: ["get-token", "--login", "azurecli"]
- name: token-user
  user:
    token: abc
"#;

    pub(super) fn kubeconfig_fixture(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("config");
        std::fs::write(&path, body).expect("write kubeconfig");
        path
    }

    pub(super) fn read_exec(path: &Path, user: &str) -> serde_yaml::Value {
        let doc: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
        doc.get("users")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("users")
            .iter()
            .find(|u| u.get("name").and_then(serde_yaml::Value::as_str) == Some(user))
            .and_then(|u| u.get("user"))
            .and_then(|u| u.get("exec"))
            .cloned()
            .unwrap_or(serde_yaml::Value::Null)
    }

    pub(super) fn read_args(path: &Path, user: &str) -> Vec<String> {
        read_exec(path, user)
            .get("args")
            .and_then(serde_yaml::Value::as_sequence)
            .map(|s| {
                s.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn read_env(path: &Path, user: &str) -> Vec<(String, String)> {
        read_exec(path, user)
            .get("env")
            .and_then(serde_yaml::Value::as_sequence)
            .map(|s| {
                s.iter()
                    .filter_map(|e| {
                        Some((
                            e.get("name")?.as_str()?.to_owned(),
                            e.get("value")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every pin test goes through `pin_identity_at` with a tempdir cache so
    /// the gcloud-only cache clear runs for real without touching the
    /// developer's `~/.kube`.
    pub(super) fn pin(path: &Path, ctx: &str, identity: &str) -> Result<()> {
        pin_identity_at(
            path,
            ctx,
            identity,
            Some(&path.with_extension("cache")),
            Some(&path.with_extension("slots")),
        )
    }

    #[test]
    fn pin_refuses_when_several_contexts_share_one_exec_user() {
        // The operator is told the pin touches "this context's exec entry", but
        // the edit lands on the *user*. Two contexts sharing one aws entry —
        // ordinary in an SSO setup — means pinning the failing one silently
        // re-points the working one to a different profile on its next connect.
        let tmp = tempfile::tempdir().expect("tempdir");
        let shared = KUBECONFIG_YAML.replace(
            "- name: aks\n  context:\n    cluster: c\n    user: aks-user",
            "- name: eks-stage\n  context:\n    cluster: c\n    user: eks-user",
        );
        let path = kubeconfig_fixture(tmp.path(), &shared);
        let before = std::fs::read_to_string(&path).expect("read");

        let err = pin(&path, "eks-stage", "stage").expect_err("must refuse a shared user");
        let msg = err.to_string();
        assert!(msg.contains("eks-user"), "{msg}");
        assert!(msg.contains("eks-stage") && msg.contains("eks"), "{msg}");
        assert!(msg.contains("nothing was written"), "{msg}");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            before,
            "a refused pin must not touch the file"
        );
        assert!(
            !backup_path(&path).exists(),
            "a refused pin must not leave a backup"
        );
    }

    #[test]
    fn re_pinning_the_same_identity_is_a_true_no_op() {
        // Without the short-circuit, a second click rewrites the file with
        // byte-identical content *and* refreshes the backup — discarding the
        // pre-edit copy the operator was told they could fall back on, in
        // exchange for nothing.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let backup = backup_path(&path);

        pin(&path, "gke", "a@example.com").expect("first pin");
        let after_first = std::fs::read_to_string(&path).expect("read");
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read backup"),
            KUBECONFIG_YAML,
            "the first pin backs up the original"
        );

        pin(&path, "gke", "a@example.com").expect("second pin");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), after_first);
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read backup"),
            KUBECONFIG_YAML,
            "a no-op pin must leave the backup holding the original"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_backup_replaces_a_symlink_rather_than_writing_through_it() {
        // `fs::copy` opens the destination O_TRUNC and *follows* symlinks, so a
        // pre-planted `config.ferrisscope-backup -> somewhere` would redirect
        // the kubeconfig body (certs, bearer tokens) to `somewhere`, and one
        // pointed back at the kubeconfig itself would truncate the source. The
        // atomic writer renames over the destination, which replaces the link.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let decoy = tmp.path().join("decoy");
        std::fs::write(&decoy, b"untouched").expect("write decoy");
        let backup = backup_path(&path);
        std::os::unix::fs::symlink(&decoy, &backup).expect("symlink");

        pin(&path, "gke", "a@example.com").expect("pin");

        assert_eq!(
            std::fs::read(&decoy).expect("read decoy"),
            b"untouched",
            "the credential body was written through the symlink"
        );
        assert!(
            !std::fs::symlink_metadata(&backup)
                .expect("stat backup")
                .file_type()
                .is_symlink(),
            "the symlink survived; the backup was written through it"
        );
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read backup"),
            KUBECONFIG_YAML
        );
    }

    #[test]
    fn pin_identity_preserves_unmodelled_fields_and_refreshes_the_backup() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);

        pin(&path, "gke", "a@example.com").expect("pin");
        let backup = backup_path(&path);
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read backup"),
            KUBECONFIG_YAML
        );

        // A second pin re-backs-up the CURRENT file, not the original. The
        // backup means "undo the last edit"; a months-old copy would silently
        // discard every context written since.
        let before_second = std::fs::read_to_string(&path).expect("read");
        pin(&path, "eks", "dev").expect("pin");
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read backup"),
            before_second
        );
        assert_ne!(before_second, KUBECONFIG_YAML);

        let doc: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parse");
        // A key the typed Kubeconfig round-trip would have dropped.
        assert_eq!(
            doc.get("preferences").and_then(|p| p.get("colors")),
            Some(&serde_yaml::Value::Bool(true))
        );
        assert_eq!(
            doc.get("current-context")
                .and_then(serde_yaml::Value::as_str),
            Some("gke")
        );
        // Untouched users stay untouched.
        assert_eq!(read_exec(&path, "token-user"), serde_yaml::Value::Null);
    }

    #[test]
    fn pin_identity_refuses_what_it_cannot_safely_edit() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);

        // Context in another KUBECONFIG file.
        let err = pin(&path, "elsewhere", "a@example.com").expect_err("must refuse");
        assert!(err.to_string().contains("elsewhere"), "{err}");
        // Non-exec user.
        let err = pin(&path, "plain", "a@example.com").expect_err("must refuse");
        assert!(err.to_string().contains("exec"), "{err}");
        // Azure has no per-context pin at all.
        let err = pin(&path, "aks", "a@example.com").expect_err("must refuse");
        assert!(err.to_string().contains("az account set"), "{err}");
        // Empty identity.
        assert!(pin(&path, "gke", "  ").is_err());

        // Nothing was written on any refusal.
        assert!(!backup_path(&path).exists());
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            KUBECONFIG_YAML
        );
    }

    #[cfg(unix)]
    #[test]
    fn pin_identity_does_not_loosen_kubeconfig_permissions() {
        use std::os::unix::fs::PermissionsExt as _;

        // A kubeconfig holds client certs and bearer tokens; operators lock it
        // to 0600. The atomic write renames a fresh tempfile over the target,
        // which swaps the inode — so without explicit care the file comes back
        // 0644 and the backup lands 0644 too. Editing an unrelated field must
        // never widen who can read the credentials.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        pin(&path, "gke", "a@example.com").expect("pin");

        let mode = |p: &Path| std::fs::metadata(p).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600, "kubeconfig mode must survive the edit");
        assert_eq!(
            mode(&backup_path(&path)),
            0o600,
            "backup must not be more readable than the file it copies"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pin_identity_follows_a_symlinked_kubeconfig() {
        // `~/.kube/config -> ~/dotfiles/kube/config` is a common dotfiles
        // setup. The atomic replace renames over the path it's given, and a
        // rename replaces the *link*, not its target — so without canonicalising
        // first, pinning would swap the operator's symlink for a regular file
        // and leave the real, still-authoritative config untouched.
        let tmp = tempfile::tempdir().expect("tempdir");
        let real_dir = tmp.path().join("dotfiles");
        std::fs::create_dir_all(&real_dir).expect("mkdir");
        let real = real_dir.join("config");
        std::fs::write(&real, KUBECONFIG_YAML).expect("write");
        let link = tmp.path().join("config");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        pin(&link, "gke", "a@example.com").expect("pin");

        assert!(
            std::fs::symlink_metadata(&link)
                .expect("stat")
                .file_type()
                .is_symlink(),
            "the symlink must survive the edit"
        );
        // The edit landed in the real file, and the backup sits beside it.
        assert_eq!(
            read_args(&real, "gke-user"),
            vec!["--account=a@example.com"]
        );
        assert!(backup_path(&real).exists());
    }

    #[test]
    fn edit_exec_refuses_when_the_file_changed_under_it() {
        // `gcloud container clusters get-credentials` (or another window) can
        // rewrite the kubeconfig between our snapshot read and our write.
        // Writing the stale tree would silently discard those contexts. The
        // closure stands in for that external writer — it runs inside the exact
        // window the guard protects.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let external = format!("{KUBECONFIG_YAML}# written by another tool\n");

        let err = edit_exec(&path, "gke", |exec| {
            std::fs::write(&path, &external).expect("external write");
            gcloud::write_pin(exec, "a@example.com")
        })
        .expect_err("must refuse");
        assert!(err.to_string().contains("changed on disk"), "{err}");

        // The external write survives untouched, and no backup was taken.
        assert_eq!(std::fs::read_to_string(&path).expect("read"), external);
        assert!(!backup_path(&path).exists());
    }

    #[test]
    fn edit_exec_writes_when_the_file_is_untouched() {
        // Control for the guard above: the normal path must still write.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        edit_exec(&path, "gke", |exec| {
            gcloud::write_pin(exec, "a@example.com")
        })
        .expect("edit");
        assert_eq!(
            read_args(&path, "gke-user"),
            vec!["--account=a@example.com"]
        );
    }

    #[test]
    fn validate_identity_rejects_what_must_never_reach_a_kubeconfig() {
        assert!(validate_identity("dev@example.com").is_ok());
        assert!(validate_identity("").is_err());
        // A newline in an env value or argv element is never legitimate.
        assert!(validate_identity("dev\nAWS_SECRET=x").is_err());
        assert!(validate_identity("dev\u{0}").is_err());
        assert!(validate_identity(&"a".repeat(257)).is_err());
        assert!(validate_identity(&"a".repeat(256)).is_ok());
    }

    #[test]
    fn only_the_gcloud_pin_clears_the_token_cache() {
        // The single most important provider difference. gcloud's cache is one
        // global file that isn't keyed by identity, so a pin must drop it or the
        // context keeps presenting the old account's token. AWS mints per call
        // and kubelogin keys its cache properly — deleting anything for them
        // would be cargo-culting.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        let cache = path.with_extension("cache");

        std::fs::write(&cache, "{}").expect("seed cache");
        pin(&path, "gke", "a@example.com").expect("pin gcloud");
        assert!(!cache.exists(), "gcloud pin must clear the token cache");

        std::fs::write(&cache, "{}").expect("re-seed cache");
        pin(&path, "eks", "dev").expect("pin aws");
        assert!(cache.exists(), "aws pin must leave the gcloud cache alone");
    }

    #[test]
    fn gcloud_pin_succeeds_when_there_is_no_cache_to_clear() {
        // A machine that has never run the plugin has no cache file; a missing
        // file is success, not an error the operator has to interpret.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);
        assert!(!path.with_extension("cache").exists());
        pin(&path, "gke", "a@example.com").expect("pin");
    }

    #[test]
    fn set_exec_env_upserts_without_disturbing_neighbours() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = kubeconfig_fixture(tmp.path(), KUBECONFIG_YAML);

        pin(&path, "eks", "dev").expect("pin");
        assert_eq!(
            read_env(&path, "eks-user"),
            vec![
                ("AWS_REGION".to_owned(), "us-east-1".to_owned()),
                ("AWS_PROFILE".to_owned(), "dev".to_owned()),
            ]
        );

        // Re-pin replaces in place rather than appending a second entry.
        pin(&path, "eks", "prod").expect("re-pin");
        assert_eq!(
            read_env(&path, "eks-user"),
            vec![
                ("AWS_REGION".to_owned(), "us-east-1".to_owned()),
                ("AWS_PROFILE".to_owned(), "prod".to_owned()),
            ]
        );
    }
}
