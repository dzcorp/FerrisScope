use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct PodDisruptionBudgetSpec;

impl KindSpec for PodDisruptionBudgetSpec {
    type K = PodDisruptionBudget;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "poddisruptionbudgets",
            group: "policy",
            version: "v1",
            kind: "PodDisruptionBudget",
            plural: "poddisruptionbudgets",
            namespaced: true,
            category: Category::Workloads,
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
                    id: "min_available",
                    header: "Min Avail",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "max_unavailable",
                    header: "Max Unavail",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "current_healthy",
                    header: "Healthy",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "desired_healthy",
                    header: "Desired",
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

    fn project(pdb: &PodDisruptionBudget) -> Value {
        let meta = &pdb.metadata;
        let spec = pdb.spec.as_ref();
        let status = pdb.status.as_ref();

        let min_available = spec
            .and_then(|s| s.min_available.as_ref())
            .map(intstr_to_string)
            .unwrap_or_default();
        let max_unavailable = spec
            .and_then(|s| s.max_unavailable.as_ref())
            .map(intstr_to_string)
            .unwrap_or_default();

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "namespace": meta.namespace.clone(),
            "min_available": min_available,
            "max_unavailable": max_unavailable,
            "current_healthy": status.map(|s| s.current_healthy).unwrap_or(0),
            "desired_healthy": status.map(|s| s.desired_healthy).unwrap_or(0),
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(pdb: &PodDisruptionBudget) -> Value {
    let meta = project_meta(&pdb.metadata);
    let spec = pdb.spec.as_ref();
    let status = pdb.status.as_ref();

    let selector = spec.and_then(|s| s.selector.as_ref()).map(|sel| {
        let match_labels: Vec<Value> = sel
            .match_labels
            .as_ref()
            .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
            .unwrap_or_default();
        let match_expressions = sel.match_expressions.as_ref().map(Vec::len).unwrap_or(0);
        json!({
            "match_labels": match_labels,
            "match_expressions": match_expressions,
        })
    });

    let conditions: Vec<Value> = status
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    json!({
                        "type": c.type_.clone(),
                        "status": c.status.clone(),
                        "reason": c.reason.clone(),
                        "message": c.message.clone(),
                        "last_transition_time": c.last_transition_time.0.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "meta": meta,
        "min_available": spec
            .and_then(|s| s.min_available.as_ref())
            .map(intstr_to_string),
        "max_unavailable": spec
            .and_then(|s| s.max_unavailable.as_ref())
            .map(intstr_to_string),
        "unhealthy_pod_eviction_policy": spec.and_then(|s| s.unhealthy_pod_eviction_policy.clone()),
        "selector": selector,
        "current_healthy": status.map(|s| s.current_healthy).unwrap_or(0),
        "desired_healthy": status.map(|s| s.desired_healthy).unwrap_or(0),
        "expected_pods": status.map(|s| s.expected_pods).unwrap_or(0),
        "disruptions_allowed": status.map(|s| s.disruptions_allowed).unwrap_or(0),
        "conditions": conditions,
    })
}

fn intstr_to_string(v: &k8s_openapi::apimachinery::pkg::util::intstr::IntOrString) -> String {
    match v {
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
    }
}
