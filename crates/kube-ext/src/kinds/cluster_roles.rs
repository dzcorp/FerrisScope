use k8s_openapi::api::rbac::v1::ClusterRole;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::kinds::roles::project_rule;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ClusterRoleSpec;

impl KindSpec for ClusterRoleSpec {
    type K = ClusterRole;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "clusterroles",
            group: "rbac.authorization.k8s.io",
            version: "v1",
            kind: "ClusterRole",
            plural: "clusterroles",
            namespaced: false,
            category: Category::Access,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
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

    fn project(cr: &ClusterRole) -> Value {
        let meta = &cr.metadata;
        let rules = cr.rules.as_ref().map_or(0, std::vec::Vec::len);

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "rules": rules,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Detail projection — meta header + rules array (same shape as Role) +
/// optional aggregationRule. ClusterRoles built via aggregation have no
/// rules of their own; the rules row in the UI degrades to "(aggregated
/// from N roles)" when that's the case.
pub fn project_detail(cr: &ClusterRole) -> Value {
    let meta = project_meta(&cr.metadata);
    let rules: Vec<Value> = cr
        .rules
        .as_ref()
        .map(|rs| rs.iter().map(project_rule).collect())
        .unwrap_or_default();
    let aggregation_selector_labels: Vec<Value> = cr
        .aggregation_rule
        .as_ref()
        .and_then(|a| a.cluster_role_selectors.as_ref())
        .map(|sels| {
            // Each selector contributes its matchLabels — flattened keeps
            // the UI shape simple.
            let mut out: Vec<Value> = Vec::new();
            for sel in sels {
                if let Some(m) = sel.match_labels.as_ref() {
                    for (k, v) in m {
                        out.push(json!([k, v]));
                    }
                }
            }
            out
        })
        .unwrap_or_default();
    let aggregation_selector_count = cr
        .aggregation_rule
        .as_ref()
        .and_then(|a| a.cluster_role_selectors.as_ref())
        .map_or(0, std::vec::Vec::len);

    json!({
        "meta": meta,
        "rules": rules,
        "aggregation_rule": cr.aggregation_rule.as_ref().map(|_| json!({
            "selector_count": aggregation_selector_count,
            "match_labels": aggregation_selector_labels,
        })),
    })
}
