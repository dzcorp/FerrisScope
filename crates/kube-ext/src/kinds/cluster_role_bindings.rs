use k8s_openapi::api::rbac::v1::ClusterRoleBinding;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::kinds::role_bindings::{project_role_ref, project_subject};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ClusterRoleBindingSpec;

impl KindSpec for ClusterRoleBindingSpec {
    type K = ClusterRoleBinding;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "clusterrolebindings",
            group: "rbac.authorization.k8s.io",
            version: "v1",
            kind: "ClusterRoleBinding",
            plural: "clusterrolebindings",
            namespaced: false,
            category: Category::Access,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
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

    fn project(crb: &ClusterRoleBinding) -> Value {
        let meta = &crb.metadata;
        let role = format!("{}/{}", crb.role_ref.kind, crb.role_ref.name);
        let subjects = crb
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
            "name": meta.name.clone().unwrap_or_default(),
            "role": role,
            "subjects": subjects,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — same shape as RoleBinding (meta + roleRef + subjects).
pub fn project_detail(crb: &ClusterRoleBinding) -> Value {
    let meta = project_meta(&crb.metadata);
    let role_ref = project_role_ref(&crb.role_ref);
    let subjects: Vec<Value> = crb
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
