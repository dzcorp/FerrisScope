use k8s_openapi::api::rbac::v1::{RoleBinding, RoleRef, Subject};
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct RoleBindingSpec;

impl KindSpec for RoleBindingSpec {
    type K = RoleBinding;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "rolebindings",
            group: "rbac.authorization.k8s.io",
            version: "v1",
            kind: "RoleBinding",
            plural: "rolebindings",
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
                    id: "role",
                    header: "Role",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "subjects",
                    header: "Subjects",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(rb: &RoleBinding) -> Value {
        let meta = &rb.metadata;
        let role = format!("{}/{}", rb.role_ref.kind, rb.role_ref.name);
        let subjects = rb
            .subjects
            .as_ref()
            .map(|ss| {
                ss.iter()
                    .map(|s| format!("{}/{}", s.kind, s.name))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "role": role,
            "subjects": subjects,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + roleRef (kind/name/apiGroup) + subjects
/// list. Subject shape is identical between RoleBinding and ClusterRoleBinding
/// so a single frontend component can render either.
pub fn project_detail(rb: &RoleBinding) -> Value {
    let meta = project_meta(&rb.metadata);
    let role_ref = project_role_ref(&rb.role_ref);
    let subjects: Vec<Value> = rb
        .subjects
        .as_ref()
        .map(|ss| ss.iter().map(project_subject).collect())
        .unwrap_or_default();
    json!({
        "meta": meta,
        "role_ref": role_ref,
        "subjects": subjects,
    })
}

/// Reused by ClusterRoleBinding's projection.
pub fn project_role_ref(r: &RoleRef) -> Value {
    json!({
        "kind": r.kind.clone(),
        "name": r.name.clone(),
        "api_group": r.api_group.clone(),
    })
}

/// Reused by ClusterRoleBinding's projection.
pub fn project_subject(s: &Subject) -> Value {
    json!({
        "kind": s.kind.clone(),
        "name": s.name.clone(),
        "namespace": s.namespace.clone(),
        "api_group": s.api_group.clone(),
    })
}
