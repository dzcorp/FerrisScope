use k8s_openapi::api::core::v1::ServiceAccount;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ServiceAccountSpec;

impl KindSpec for ServiceAccountSpec {
    type K = ServiceAccount;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "serviceaccounts",
            group: "",
            version: "v1",
            kind: "ServiceAccount",
            plural: "serviceaccounts",
            namespaced: true,
            category: Category::Access,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "namespace",
                    header: "Namespace",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "secrets",
                    header: "Secrets",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(sa: &ServiceAccount) -> Value {
        let meta = &sa.metadata;
        let secrets = sa.secrets.as_ref().map_or(0, std::vec::Vec::len);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "secrets": secrets,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + automountServiceAccountToken,
/// secrets list, and imagePullSecrets list. Each secret entry carries the
/// referenced kind / name / namespace so the UI can wire `LinkValue`s for
/// cross-kind navigation. Token controllers pre-populate the `secrets`
/// list pre-1.24 and rotate it via projected volumes 1.24+.
pub fn project_detail(sa: &ServiceAccount) -> Value {
    let meta = project_meta(&sa.metadata);
    let namespace = sa.metadata.namespace.clone();

    let secrets: Vec<Value> = sa
        .secrets
        .as_ref()
        .map(|ss| {
            ss.iter()
                .map(|r| {
                    json!({
                        "kind": r.kind.clone().unwrap_or_else(|| "Secret".to_owned()),
                        "name": r.name.clone().unwrap_or_default(),
                        // ObjectReference's namespace is sometimes blank; fall
                        // back to the SA's own namespace so the UI can still
                        // navigate without guessing.
                        "namespace": r.namespace.clone().or_else(|| namespace.clone()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let image_pull_secrets: Vec<String> = sa
        .image_pull_secrets
        .as_ref()
        .map(|v| v.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();

    json!({
        "meta": meta,
        "automount_service_account_token": sa.automount_service_account_token,
        "secrets": secrets,
        "image_pull_secrets": image_pull_secrets,
    })
}
