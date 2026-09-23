//! Parameterised GitOps operations (Argo CD sync / rollback / auto-sync /
//! cascade delete, Flux reconcile with source / force / reset). Patches are
//! built from the live object here, never on the frontend.

use std::time::Duration;

use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, Patch, PatchParams};
use kube::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use super::gitops::{array, text};
use crate::fetch::{delete_resource, merge_patch_resource, Cascade, FetchError, MergePatchResult};

const INITIATOR: &str = "ferrisscope";
const FINALIZER: &str = "resources-finalizer.argocd.argoproj.io";
const FINALIZER_FOREGROUND: &str = "resources-finalizer.argocd.argoproj.io/foreground";
const FINALIZER_BACKGROUND: &str = "resources-finalizer.argocd.argoproj.io/background";
const SOURCE_WAIT: Duration = Duration::from_mins(1);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SyncResource {
    #[serde(default)]
    pub group: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SyncRequest {
    /// Single-source override; `None` keeps the spec's target revision.
    pub revision: Option<String>,
    /// Multi-source overrides, one per source in spec order.
    pub revisions: Option<Vec<String>>,
    pub prune: bool,
    pub dry_run: bool,
    pub force: bool,
    /// Skip hooks (`syncStrategy.apply`).
    pub apply_only: bool,
    pub sync_options: Vec<String>,
    /// Empty = the whole application.
    pub resources: Vec<SyncResource>,
    /// Raw Argo `RetryStrategy`; `None` = no retry.
    pub retry: Option<Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppCascade {
    Foreground,
    Background,
    NonCascading,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ObjectRef {
    pub kind_id: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GitOpsRequest {
    /// A fixed action from the detail projection, rebuilt from the live object.
    Action {
        id: String,
    },
    Sync(SyncRequest),
    Rollback {
        id: i64,
        #[serde(default)]
        prune: bool,
        #[serde(default)]
        dry_run: bool,
    },
    SetAutoSync {
        enabled: bool,
        #[serde(default)]
        prune: bool,
        #[serde(default)]
        self_heal: bool,
    },
    DeleteApp {
        cascade: AppCascade,
    },
    Reconcile {
        #[serde(default)]
        force: bool,
        #[serde(default)]
        reset: bool,
        /// Reconcile this source first and wait until Flux handled it.
        #[serde(default)]
        with_source: Option<ObjectRef>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum OpError {
    #[error("{0}")]
    Blocked(String),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error(transparent)]
    Kube(#[from] kube::Error),
}

fn blocked(msg: impl Into<String>) -> OpError {
    OpError::Blocked(msg.into())
}

pub fn auto_sync_enabled(spec: &Value) -> bool {
    spec.pointer("/syncPolicy/automated")
        .is_some_and(|a| a.is_object() && a["enabled"].as_bool() != Some(false))
}

pub fn operation_busy(d: &Value) -> bool {
    d.get("operation").is_some_and(|o| !o.is_null())
        || matches!(
            text(d, "/status/operationState/phase").as_deref(),
            Some("Running" | "Terminating")
        )
}

fn operation(sync: Value, retry: Option<Value>) -> Value {
    let mut op = json!({ "initiatedBy": { "username": INITIATOR }, "sync": sync });
    if let Some(retry) = retry.filter(Value::is_object) {
        op["retry"] = retry;
    }
    json!({ "operation": op })
}

pub fn sync_patch(d: &Value, req: &SyncRequest) -> Result<Value, OpError> {
    if d["metadata"]["deletionTimestamp"].is_string() {
        return Err(blocked("Application is being deleted."));
    }
    if operation_busy(d) {
        return Err(blocked("A sync operation is already in progress."));
    }
    let spec = &d["spec"];
    let target = |s: &Value| {
        s["targetRevision"]
            .as_str()
            .filter(|r| !r.is_empty())
            .unwrap_or("HEAD")
            .to_owned()
    };
    let non_empty = |r: &String| !r.trim().is_empty();
    let auto_guard = |requested: &str, target: &str| {
        if auto_sync_enabled(spec) && !req.dry_run && requested != target {
            Err(blocked("Auto-sync is on, so a sync to another revision would be reverted. Disable auto-sync or use Dry run."))
        } else {
            Ok(())
        }
    };
    let mut sync = json!({ "prune": req.prune });
    let sources = array(spec, "/sources");
    if !sources.is_empty() {
        let revisions = match &req.revisions {
            Some(r) if r.len() != sources.len() => {
                return Err(blocked(format!(
                    "Expected {} revisions, one per source.",
                    sources.len()
                )))
            }
            Some(r) => r
                .iter()
                .zip(sources)
                .map(|(r, s)| {
                    if non_empty(r) {
                        auto_guard(r.trim(), &target(s))?;
                        Ok(r.trim().to_owned())
                    } else {
                        Ok(target(s))
                    }
                })
                .collect::<Result<Vec<_>, OpError>>()?,
            None => sources.iter().map(target).collect::<Vec<_>>(),
        };
        sync["revisions"] = json!(revisions);
    } else if spec["source"].is_object() {
        let default = target(&spec["source"]);
        let revision = req
            .revision
            .as_ref()
            .filter(|r| non_empty(r))
            .map_or_else(|| default.clone(), |r| r.trim().to_owned());
        auto_guard(&revision, &default)?;
        sync["revision"] = json!(revision);
    } else {
        return Err(blocked("No source is configured."));
    }
    if req.dry_run {
        sync["dryRun"] = json!(true);
    }
    if req.apply_only {
        sync["syncStrategy"] = json!({ "apply": { "force": req.force } });
    } else if req.force {
        sync["syncStrategy"] = json!({ "hook": { "force": true } });
    }
    if !req.sync_options.is_empty() {
        sync["syncOptions"] = json!(req.sync_options);
    }
    if !req.resources.is_empty() {
        sync["resources"] = req
            .resources
            .iter()
            .map(|r| {
                let mut v = json!({ "group": r.group, "kind": r.kind, "name": r.name });
                if let Some(ns) = r.namespace.as_ref().filter(|n| !n.is_empty()) {
                    v["namespace"] = json!(ns);
                }
                v
            })
            .collect();
    }
    Ok(operation(sync, req.retry.clone()))
}

/// Mirrors the Argo CD API server's Rollback: a sync to a history entry's
/// source and revision(s), refused while auto-sync would undo it.
pub fn rollback_patch(d: &Value, id: i64, prune: bool, dry_run: bool) -> Result<Value, OpError> {
    if d["metadata"]["deletionTimestamp"].is_string() {
        return Err(blocked("Application is being deleted."));
    }
    if auto_sync_enabled(&d["spec"]) {
        return Err(blocked("Disable auto-sync before rolling back; it would sync straight back to the target revision."));
    }
    if operation_busy(d) {
        return Err(blocked("A sync operation is already in progress."));
    }
    let entry = array(d, "/status/history")
        .iter()
        .find(|h| h["id"].as_i64() == Some(id))
        .ok_or_else(|| blocked(format!("No deployment with id {id} in history.")))?;
    let source = entry
        .get("source")
        .filter(|s| s.as_object().is_some_and(|o| !o.is_empty()));
    let sources = entry
        .get("sources")
        .filter(|s| s.as_array().is_some_and(|a| !a.is_empty()));
    if source.is_none() && sources.is_none() {
        return Err(blocked(
            "This deployment predates source tracking; sync to its revision instead.",
        ));
    }
    let mut sync = json!({
        "prune": prune,
        "syncStrategy": { "apply": {} },
    });
    if dry_run {
        sync["dryRun"] = json!(true);
    }
    if let Some(s) = sources {
        sync["sources"] = s.clone();
        sync["revisions"] = entry["revisions"].clone();
    } else if let Some(s) = source {
        sync["source"] = s.clone();
        sync["revision"] = entry["revision"].clone();
    }
    if let Some(opts) = d
        .pointer("/spec/syncPolicy/syncOptions")
        .filter(|o| o.is_array())
    {
        sync["syncOptions"] = opts.clone();
    }
    Ok(operation(sync, None))
}

pub fn auto_sync_patch(enabled: bool, prune: bool, self_heal: bool) -> Value {
    if enabled {
        // `enabled: null` clears an explicit `false` left by newer Argo CD.
        json!({"spec":{"syncPolicy":{"automated":{"prune":prune,"selfHeal":self_heal,"enabled":null}}}})
    } else {
        json!({"spec":{"syncPolicy":{"automated":null}}})
    }
}

/// Finalizer list for the chosen cascade, or `None` when unchanged. Same
/// rules as the Argo CD API server's Delete.
pub fn cascade_finalizers(d: &Value, cascade: AppCascade) -> Option<Vec<String>> {
    let current: Vec<String> = array(d, "/metadata/finalizers")
        .iter()
        .filter_map(|f| f.as_str().map(str::to_owned))
        .collect();
    let is_policy = |f: &str| matches!(f, FINALIZER | FINALIZER_FOREGROUND | FINALIZER_BACKGROUND);
    let wanted = match cascade {
        AppCascade::Foreground => Some(FINALIZER_FOREGROUND),
        AppCascade::Background => Some(FINALIZER_BACKGROUND),
        AppCascade::NonCascading => None,
    };
    match wanted {
        // An existing policy finalizer already cascades; Argo keeps it.
        Some(_) if current.iter().any(|c| is_policy(c)) => None,
        Some(f) => {
            let mut next = current;
            next.push(f.to_owned());
            Some(next)
        }
        None if current.iter().any(|c| is_policy(c)) => {
            Some(current.into_iter().filter(|c| !is_policy(c)).collect())
        }
        None => None,
    }
}

/// Kubernetes forbids adding finalizers to a deleting object; removal (keep
/// resources on a stuck cascade) is still allowed, as in Argo's server.
pub fn finalizer_change(d: &Value, cascade: AppCascade, deleting: bool) -> Option<Vec<String>> {
    let before = array(d, "/metadata/finalizers").len();
    cascade_finalizers(d, cascade).filter(|next| !deleting || next.len() < before)
}

pub fn reconcile_patch(token: &str, force: bool, reset: bool) -> Value {
    let mut annotations = json!({ "reconcile.fluxcd.io/requestedAt": token });
    // Flux only honours force/reset when they equal requestedAt.
    if force {
        annotations["reconcile.fluxcd.io/forceAt"] = json!(token);
    }
    if reset {
        annotations["reconcile.fluxcd.io/resetAt"] = json!(token);
    }
    json!({ "metadata": { "annotations": annotations } })
}

fn api_for(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
) -> Result<Api<DynamicObject>, FetchError> {
    let parsed =
        super::parse_id(kind_id).ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
    let gvk = GroupVersionKind::gvk(&parsed.group, &parsed.version, &parsed.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &parsed.plural);
    Ok(if parsed.namespaced {
        let ns = namespace.ok_or_else(|| FetchError::NamespaceRequired(kind_id.to_owned()))?;
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    })
}

fn as_value(obj: &DynamicObject) -> Value {
    serde_json::to_value(obj).unwrap_or(Value::Null)
}

/// Runs `req` against the live object. Staleness is judged on
/// `metadata.generation` (spec intent), not resourceVersion: controllers
/// rewrite status constantly and Application has no status subresource. The
/// write itself still carries the freshly read resourceVersion.
pub async fn run(
    client: Client,
    kind_id: &str,
    namespace: Option<&str>,
    name: &str,
    req: GitOpsRequest,
    expected_generation: Option<i64>,
) -> Result<MergePatchResult, OpError> {
    let api = api_for(client.clone(), kind_id, namespace)?;
    let obj = api.get(name).await?;
    if expected_generation.is_some() && expected_generation != obj.metadata.generation {
        return Ok(MergePatchResult::Stale {
            message: "The object's spec changed since it was loaded.".into(),
        });
    }
    let live_rv = obj.metadata.resource_version.clone();
    let d = as_value(&obj);
    let patch = |p: Value, rv: Option<String>| {
        let client = client.clone();
        async move { merge_patch_resource(client, kind_id, namespace, name, p, rv.as_deref()).await }
    };
    match req {
        GitOpsRequest::Action { id } => {
            let parsed = super::parse_id(kind_id)
                .ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
            let wk = super::lookup_by_short_id(&parsed.short_id)
                .ok_or_else(|| FetchError::UnknownKind(kind_id.to_owned()))?;
            let detail = (wk.project_detail)(&obj);
            let action = detail["actions"]
                .as_array()
                .and_then(|a| a.iter().find(|a| a["id"] == id.as_str()))
                .ok_or_else(|| blocked(format!("Action {id} is not available for this object.")))?;
            if let Some(reason) = action["disabled_reason"].as_str() {
                return Err(blocked(reason));
            }
            Ok(patch(action["patch"].clone(), live_rv.clone()).await?)
        }
        GitOpsRequest::Sync(s) => Ok(patch(sync_patch(&d, &s)?, live_rv.clone()).await?),
        GitOpsRequest::Rollback { id, prune, dry_run } => {
            Ok(patch(rollback_patch(&d, id, prune, dry_run)?, live_rv.clone()).await?)
        }
        GitOpsRequest::SetAutoSync {
            enabled,
            prune,
            self_heal,
        } => Ok(patch(auto_sync_patch(enabled, prune, self_heal), live_rv.clone()).await?),
        GitOpsRequest::DeleteApp { cascade } => {
            let original = obj.metadata.finalizers.clone().unwrap_or_default();
            let mut changed = false;
            if let Some(next) =
                finalizer_change(&d, cascade, obj.metadata.deletion_timestamp.is_some())
            {
                if let MergePatchResult::Stale { message } =
                    patch(json!({"metadata":{"finalizers":next}}), live_rv.clone()).await?
                {
                    return Ok(MergePatchResult::Stale { message });
                }
                changed = true;
            }
            if let Err(e) = delete_resource(
                client.clone(),
                kind_id,
                namespace,
                name,
                None,
                Some(Cascade::Background),
            )
            .await
            {
                if changed {
                    // Best-effort: don't leave a changed cascade policy behind
                    // for a later plain delete.
                    let restore = patch(json!({"metadata":{"finalizers":original}}), None).await;
                    if restore.is_err() {
                        return Err(blocked(format!(
                            "Delete failed ({e}) and the original finalizers could not be restored; check metadata.finalizers before deleting again."
                        )));
                    }
                }
                return Err(e.into());
            }
            Ok(MergePatchResult::Applied {
                resource_version: None,
            })
        }
        GitOpsRequest::Reconcile {
            force,
            reset,
            with_source,
        } => {
            if obj.data.pointer("/spec/suspend").and_then(Value::as_bool) == Some(true) {
                return Err(blocked("Resume before requesting reconciliation."));
            }
            let token = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            if let Some(src) = with_source {
                reconcile_source(client.clone(), &src, &token).await?;
                // Controllers write status while we wait; the annotation is
                // idempotent, so don't turn that churn into a conflict.
                return Ok(patch(reconcile_patch(&token, force, reset), None).await?);
            }
            Ok(patch(reconcile_patch(&token, force, reset), live_rv.clone()).await?)
        }
    }
}

/// Whether a source will ever acknowledge a reconcile request.
pub fn source_wait_plan(src: &Value) -> Result<bool, OpError> {
    if src.pointer("/spec/suspend").and_then(Value::as_bool) == Some(true) {
        return Err(blocked(format!(
            "Source {} is suspended; resume it first.",
            text(src, "/metadata/name").unwrap_or_default()
        )));
    }
    // A static OCI HelmRepository never reconciles, so there is nothing to wait for.
    let static_oci = src["kind"] == "HelmRepository"
        && src.pointer("/spec/type").and_then(Value::as_str) == Some("oci");
    Ok(!static_oci)
}

async fn reconcile_source(client: Client, src: &ObjectRef, token: &str) -> Result<(), OpError> {
    let api = api_for(client.clone(), &src.kind_id, src.namespace.as_deref())?;
    let current = api.get(&src.name).await?;
    if !source_wait_plan(&as_value(&current))? {
        return Ok(());
    }
    let body = reconcile_patch(token, false, false);
    api.patch(&src.name, &PatchParams::default(), &Patch::Merge(&body))
        .await?;
    let deadline = tokio::time::Instant::now() + SOURCE_WAIT;
    loop {
        let live = api.get(&src.name).await?;
        if live
            .data
            .pointer("/status/lastHandledReconcileAt")
            .and_then(Value::as_str)
            == Some(token)
        {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(blocked(format!(
                "Source {} did not finish reconciling within {}s.",
                src.name,
                SOURCE_WAIT.as_secs()
            )));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(extra: Value) -> Value {
        let mut v = json!({"metadata":{"name":"a","finalizers":[]},"spec":{"project":"default","source":{"repoURL":"r","targetRevision":"main"},"syncPolicy":{"syncOptions":["CreateNamespace=true"]}},"status":{}});
        if let (Some(v), Some(extra)) = (v.as_object_mut(), extra.as_object()) {
            for (k, e) in extra {
                v.insert(k.clone(), e.clone());
            }
        }
        v
    }

    #[test]
    fn sync_request_maps_every_option() {
        let req = SyncRequest {
            revision: Some(" v2 ".into()),
            prune: true,
            dry_run: true,
            force: true,
            apply_only: true,
            sync_options: vec!["ServerSideApply=true".into()],
            resources: vec![SyncResource {
                group: "apps".into(),
                kind: "Deployment".into(),
                name: "web".into(),
                namespace: Some("prod".into()),
            }],
            retry: Some(json!({"limit":2})),
            ..SyncRequest::default()
        };
        let p = sync_patch(&app(json!({})), &req).unwrap();
        let op = &p["operation"];
        assert_eq!(op["sync"]["revision"], "v2");
        assert_eq!(op["sync"]["prune"], true);
        assert_eq!(op["sync"]["dryRun"], true);
        assert_eq!(op["sync"]["syncStrategy"], json!({"apply":{"force":true}}));
        assert_eq!(op["sync"]["syncOptions"], json!(["ServerSideApply=true"]));
        assert_eq!(
            op["sync"]["resources"],
            json!([{"group":"apps","kind":"Deployment","name":"web","namespace":"prod"}])
        );
        assert_eq!(op["retry"], json!({"limit":2}));
        assert_eq!(op["initiatedBy"]["username"], INITIATOR);
    }

    #[test]
    fn sync_defaults_are_minimal_and_force_uses_hook_strategy() {
        let p = sync_patch(&app(json!({})), &SyncRequest::default()).unwrap();
        assert_eq!(
            p["operation"]["sync"],
            json!({"prune":false,"revision":"main"})
        );
        assert!(p["operation"].get("retry").is_none());
        let f = sync_patch(
            &app(json!({})),
            &SyncRequest {
                force: true,
                ..SyncRequest::default()
            },
        )
        .unwrap();
        assert_eq!(
            f["operation"]["sync"]["syncStrategy"],
            json!({"hook":{"force":true}})
        );
    }

    #[test]
    fn multi_source_revisions_must_cover_every_source() {
        let multi = app(
            json!({"spec":{"sources":[{"repoURL":"a"},{"repoURL":"b","targetRevision":"v1"}]}}),
        );
        let p = sync_patch(&multi, &SyncRequest::default()).unwrap();
        assert_eq!(p["operation"]["sync"]["revisions"], json!(["HEAD", "v1"]));
        let over = SyncRequest {
            revisions: Some(vec![String::new(), "v9".into()]),
            ..SyncRequest::default()
        };
        assert_eq!(
            sync_patch(&multi, &over).unwrap()["operation"]["sync"]["revisions"],
            json!(["HEAD", "v9"])
        );
        let short = SyncRequest {
            revisions: Some(vec!["x".into()]),
            ..SyncRequest::default()
        };
        assert!(matches!(
            sync_patch(&multi, &short),
            Err(OpError::Blocked(_))
        ));
    }

    #[test]
    fn sync_is_refused_while_busy_deleting_or_sourceless() {
        for d in [
            app(json!({"operation":{"sync":{}}})),
            app(json!({"status":{"operationState":{"phase":"Terminating"}}})),
            app(json!({"metadata":{"deletionTimestamp":"2026-01-01T00:00:00Z"}})),
            app(json!({"spec":{"project":"p"}})),
        ] {
            assert!(matches!(
                sync_patch(&d, &SyncRequest::default()),
                Err(OpError::Blocked(_))
            ));
        }
    }

    #[test]
    fn rollback_mirrors_the_api_server() {
        let d = app(
            json!({"status":{"history":[{"id":3,"revision":"abc","source":{"repoURL":"r","targetRevision":"main"}}]}}),
        );
        let p = rollback_patch(&d, 3, true, false).unwrap();
        let sync = &p["operation"]["sync"];
        assert_eq!(sync["revision"], "abc");
        assert_eq!(sync["source"]["repoURL"], "r");
        assert_eq!(sync["prune"], true);
        assert_eq!(sync["syncStrategy"], json!({"apply":{}}));
        assert_eq!(sync["syncOptions"], json!(["CreateNamespace=true"]));
        assert!(matches!(
            rollback_patch(&d, 9, false, false),
            Err(OpError::Blocked(_))
        ));
        let mut auto = d.clone();
        auto["spec"]["syncPolicy"]["automated"] = json!({});
        assert!(matches!(
            rollback_patch(&auto, 3, false, false),
            Err(OpError::Blocked(_))
        ));
        let legacy = app(json!({"status":{"history":[{"id":1,"revision":"x"}]}}));
        assert!(matches!(
            rollback_patch(&legacy, 1, false, false),
            Err(OpError::Blocked(_))
        ));
        let multi = app(
            json!({"status":{"history":[{"id":4,"revisions":["a","b"],"sources":[{"repoURL":"x"},{"repoURL":"y"}]}]}}),
        );
        let p = rollback_patch(&multi, 4, false, true).unwrap();
        assert_eq!(p["operation"]["sync"]["revisions"], json!(["a", "b"]));
        assert_eq!(p["operation"]["sync"]["dryRun"], true);
    }

    #[test]
    fn auto_sync_toggle_and_detection() {
        assert_eq!(
            auto_sync_patch(false, true, true),
            json!({"spec":{"syncPolicy":{"automated":null}}})
        );
        let on = auto_sync_patch(true, true, false);
        assert_eq!(on["spec"]["syncPolicy"]["automated"]["selfHeal"], false);
        assert!(on["spec"]["syncPolicy"]["automated"]["enabled"].is_null());
        assert!(auto_sync_enabled(&json!({"syncPolicy":{"automated":{}}})));
        assert!(!auto_sync_enabled(
            &json!({"syncPolicy":{"automated":{"enabled":false}}})
        ));
        assert!(!auto_sync_enabled(&json!({"syncPolicy":{}})));
    }

    #[test]
    fn cascade_follows_argo_finalizer_rules() {
        let none = app(json!({}));
        assert_eq!(
            cascade_finalizers(&none, AppCascade::Foreground),
            Some(vec![FINALIZER_FOREGROUND.to_owned()])
        );
        assert_eq!(
            cascade_finalizers(&none, AppCascade::Background),
            Some(vec![FINALIZER_BACKGROUND.to_owned()])
        );
        assert_eq!(cascade_finalizers(&none, AppCascade::NonCascading), None);
        let with = app(json!({"metadata":{"finalizers":[FINALIZER, "other"]}}));
        assert_eq!(cascade_finalizers(&with, AppCascade::Foreground), None);
        assert_eq!(
            cascade_finalizers(&with, AppCascade::NonCascading),
            Some(vec!["other".to_owned()])
        );
    }

    #[test]
    fn revision_override_is_refused_under_auto_sync_unless_dry_run() {
        let mut d = app(json!({}));
        d["spec"]["syncPolicy"]["automated"] = json!({});
        let over = SyncRequest {
            revision: Some("v9".into()),
            ..SyncRequest::default()
        };
        assert!(matches!(sync_patch(&d, &over), Err(OpError::Blocked(_))));
        let same = SyncRequest {
            revision: Some("main".into()),
            ..SyncRequest::default()
        };
        assert!(sync_patch(&d, &same).is_ok());
        let dry = SyncRequest {
            revision: Some("v9".into()),
            dry_run: true,
            ..SyncRequest::default()
        };
        assert!(sync_patch(&d, &dry).is_ok());
    }

    #[test]
    fn source_wait_plan_rejects_suspended_and_skips_static_oci() {
        assert!(matches!(
            source_wait_plan(&json!({"metadata":{"name":"s"},"spec":{"suspend":true}})),
            Err(OpError::Blocked(_))
        ));
        assert!(
            !source_wait_plan(&json!({"kind":"HelmRepository","spec":{"type":"oci"}})).unwrap()
        );
        assert!(source_wait_plan(&json!({"kind":"GitRepository","spec":{}})).unwrap());
    }

    #[test]
    fn deleting_apps_can_drop_but_not_add_cascade_finalizers() {
        let bare = app(json!({}));
        assert!(finalizer_change(&bare, AppCascade::Foreground, true).is_none());
        assert!(finalizer_change(&bare, AppCascade::Foreground, false).is_some());
        let stuck = app(json!({"metadata":{"finalizers":[FINALIZER_FOREGROUND]}}));
        assert_eq!(
            finalizer_change(&stuck, AppCascade::NonCascading, true),
            Some(vec![])
        );
    }

    #[test]
    fn reconcile_force_and_reset_share_the_request_token() {
        let p = reconcile_patch("t1", true, true);
        let a = &p["metadata"]["annotations"];
        assert_eq!(a["reconcile.fluxcd.io/requestedAt"], "t1");
        assert_eq!(a["reconcile.fluxcd.io/forceAt"], "t1");
        assert_eq!(a["reconcile.fluxcd.io/resetAt"], "t1");
        assert!(
            reconcile_patch("t2", false, false)["metadata"]["annotations"]
                .get("reconcile.fluxcd.io/forceAt")
                .is_none()
        );
    }

    #[test]
    fn requests_deserialize_from_the_frontend_shape() {
        let r: GitOpsRequest = serde_json::from_value(
            json!({"type":"sync","prune":true,"resources":[{"kind":"Service","name":"s"}]}),
        )
        .unwrap();
        assert!(matches!(
            r,
            GitOpsRequest::Sync(SyncRequest { prune: true, .. })
        ));
        let r: GitOpsRequest =
            serde_json::from_value(json!({"type":"delete_app","cascade":"non_cascading"})).unwrap();
        assert!(matches!(
            r,
            GitOpsRequest::DeleteApp {
                cascade: AppCascade::NonCascading
            }
        ));
        let r: GitOpsRequest = serde_json::from_value(json!({"type":"reconcile","force":true,"with_source":{"kind_id":"k","namespace":"n","name":"s"}})).unwrap();
        assert!(matches!(
            r,
            GitOpsRequest::Reconcile {
                force: true,
                with_source: Some(_),
                ..
            }
        ));
    }
}
