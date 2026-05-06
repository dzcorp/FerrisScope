use k8s_openapi::api::rbac::v1::{PolicyRule, Role};
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct RoleSpec;

impl KindSpec for RoleSpec {
    type K = Role;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "roles",
            group: "rbac.authorization.k8s.io",
            version: "v1",
            kind: "Role",
            plural: "roles",
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
                    id: "rules",
                    header: "Rules",
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

    fn project(r: &Role) -> Value {
        let meta = &r.metadata;
        let rules = r.rules.as_ref().map_or(0, std::vec::Vec::len);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "rules": rules,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + the policy rules array. Rule shape is
/// kept identical between Role and ClusterRole so a single frontend
/// component can render either; the only difference is whether
/// non-resource URLs are populated (cluster-scoped only).
pub fn project_detail(r: &Role) -> Value {
    let meta = project_meta(&r.metadata);
    let rules: Vec<Value> = r
        .rules
        .as_ref()
        .map(|rs| rs.iter().map(project_rule).collect())
        .unwrap_or_default();
    json!({
        "meta": meta,
        "rules": rules,
    })
}

/// Reused by ClusterRole's projection — same rule shape.
pub fn project_rule(r: &PolicyRule) -> Value {
    json!({
        "api_groups": r.api_groups.clone().unwrap_or_default(),
        "resources": r.resources.clone().unwrap_or_default(),
        "resource_names": r.resource_names.clone().unwrap_or_default(),
        "verbs": r.verbs.clone(),
        "non_resource_urls": r.non_resource_urls.clone().unwrap_or_default(),
    })
}
