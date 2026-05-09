//! `fs_can_i` — wrap SubjectAccessReview / SelfSubjectAccessReview.
//!
//! Answers "can <user> do <verb> on <resource>?" — the question that comes
//! up whenever a workload can't talk to the apiserver, an admission webhook
//! denies, or a CI pipeline gets a 403. The MCP server can list RBAC
//! objects, but reasoning over them by hand (Roles + ClusterRoles +
//! bindings + aggregation) is exactly what the apiserver's authz subsystem
//! is for.
//!
//! Two modes:
//!   - `user` omitted → SelfSubjectAccessReview ("as the agent's own
//!     credentials, can I?"). No special permissions needed.
//!   - `user` set → SubjectAccessReview ("as <that user>, can they?").
//!     Requires impersonation rights on the agent's own credentials,
//!     typically only granted to cluster-admin. The apiserver returns a
//!     `Forbidden` error if not — surfaced cleanly.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec, SubjectAccessReview,
    SubjectAccessReviewSpec,
};
use kube::api::{Api, PostParams};
use kube::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct Args {
    /// e.g. `get`, `list`, `create`, `update`, `patch`, `delete`, `watch`,
    /// `*`. Verb names are not validated client-side — the apiserver
    /// accepts any string and returns "no" for ones it doesn't recognise.
    verb: String,
    /// Plural resource name, e.g. `pods`, `deployments`, `customresources`.
    resource: String,
    /// Empty string for the core API group (`pods`, `services`, `configmaps`).
    /// `apps` for Deployments/StatefulSets, `rbac.authorization.k8s.io` for
    /// Roles, etc.
    #[serde(default)]
    group: Option<String>,
    /// Subresource, e.g. `log`, `exec`, `status`, `scale`.
    #[serde(default)]
    subresource: Option<String>,
    /// Namespace. Empty / omitted means cluster-scoped check.
    #[serde(default)]
    namespace: Option<String>,
    /// Specific object name; empty checks "any object of this kind".
    #[serde(default)]
    name: Option<String>,
    /// User to impersonate. Omit for self-check; set for SubjectAccessReview
    /// ("can <this SA> do X?").
    #[serde(default)]
    user: Option<String>,
    /// Groups to ascribe to `user`. Only used when `user` is set.
    #[serde(default)]
    groups: Option<Vec<String>>,
}

pub(crate) struct CanI {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl CanI {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for CanI {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_can_i".into(),
            description: "Authorisation check — wraps SubjectAccessReview. Returns \
                `{allowed, denied, reason, evaluation_error}`. Omit `user` for \
                self-check (the agent's own creds). Set `user` to ask about a \
                ServiceAccount or other identity (requires impersonation rights). \
                For SAs: `system:serviceaccount:<ns>:<sa-name>`."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "verb": { "type": "string", "description": "get / list / create / update / patch / delete / watch / *" },
                    "resource": { "type": "string", "description": "Plural, e.g. pods, deployments." },
                    "group": { "type": "string", "description": "API group; empty for core." },
                    "subresource": { "type": "string", "description": "e.g. log, exec, status, scale." },
                    "namespace": { "type": "string", "description": "Omit for cluster-scoped check." },
                    "name": { "type": "string" },
                    "user": { "type": "string", "description": "Impersonate. For SAs use `system:serviceaccount:<ns>:<sa>`." },
                    "groups": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["verb", "resource"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster).await?;
        let attrs = ResourceAttributes {
            verb: Some(a.verb.clone()),
            resource: Some(a.resource.clone()),
            group: a.group.clone(),
            subresource: a.subresource.clone(),
            namespace: a.namespace.clone(),
            name: a.name.clone(),
            ..Default::default()
        };

        if let Some(user) = a.user.as_ref() {
            // SubjectAccessReview path — apiserver evaluates RBAC as if the
            // call came from `user` (+ optional groups). Requires cluster-
            // admin-ish impersonation rights on the agent's creds.
            let api: Api<SubjectAccessReview> = Api::all(client);
            let body = SubjectAccessReview {
                spec: SubjectAccessReviewSpec {
                    user: Some(user.clone()),
                    groups: a.groups.clone(),
                    resource_attributes: Some(attrs),
                    ..Default::default()
                },
                ..Default::default()
            };
            let resp = api
                .create(&PostParams::default(), &body)
                .await
                .map_err(|e| NativeToolError::msg(format!("subjectaccessreview: {e}")))?;
            // The apiserver should always populate `status` on a successful
            // create — we still treat it as Option to match the wire shape
            // and bail with a clear error rather than panic on the rare
            // occasion something upstream returns an empty body.
            let st = resp
                .status
                .ok_or_else(|| NativeToolError::msg("apiserver returned no status"))?;
            Ok(json!({
                "mode": "subject",
                "user": user,
                "allowed": st.allowed,
                "denied": st.denied.unwrap_or(false),
                "reason": st.reason,
                "evaluation_error": st.evaluation_error,
            }))
        } else {
            let api: Api<SelfSubjectAccessReview> = Api::all(client);
            let body = SelfSubjectAccessReview {
                spec: SelfSubjectAccessReviewSpec {
                    resource_attributes: Some(attrs),
                    ..Default::default()
                },
                ..Default::default()
            };
            let resp = api
                .create(&PostParams::default(), &body)
                .await
                .map_err(|e| NativeToolError::msg(format!("selfsubjectaccessreview: {e}")))?;
            let st = resp
                .status
                .ok_or_else(|| NativeToolError::msg("apiserver returned no status"))?;
            Ok(json!({
                "mode": "self",
                "allowed": st.allowed,
                "denied": st.denied.unwrap_or(false),
                "reason": st.reason,
                "evaluation_error": st.evaluation_error,
            }))
        }
    }
}

async fn client_for(app: &AppHandle, cluster: &ChatClusterRef) -> Result<Client, NativeToolError> {
    let id = cluster.active().await;
    let state = app.state::<AppState>();
    let entry = state
        .entry(&id)
        .await
        .map_err(|e| NativeToolError::msg(format!("connect cluster: {e}")))?;
    Ok(entry.cluster.client())
}
