use k8s_openapi::api::apps::v1::Deployment;
use serde_json::{json, Value};

use crate::kinds::pod_template::{
    project_label_selector, project_meta, project_pod_template_summary,
};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct DeploymentSpec;

impl KindSpec for DeploymentSpec {
    type K = Deployment;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "deployments",
            group: "apps",
            version: "v1",
            kind: "Deployment",
            plural: "deployments",
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
                    id: "ready",
                    header: "Ready",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "up_to_date",
                    header: "Up-to-date",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "available",
                    header: "Available",
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

    fn project(dep: &Deployment) -> Value {
        let meta = &dep.metadata;
        let spec = dep.spec.as_ref();
        let status = dep.status.as_ref();
        let desired = spec.and_then(|s| s.replicas).unwrap_or(0);
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
        let up_to_date = status.and_then(|s| s.updated_replicas).unwrap_or(0);
        let available = status.and_then(|s| s.available_replicas).unwrap_or(0);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "ready": format!("{ready}/{desired}"),
            "up_to_date": up_to_date,
            "available": available,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

/// Rich projection used by the detail panel — fetched on-demand via
/// `get_deployment_detail`. Mirrors the on-disk shape of the Deployment but
/// flattened so the renderer doesn't have to walk Option chains.
pub fn project_detail(dep: &Deployment) -> Value {
    let meta = project_meta(&dep.metadata);
    let spec = dep.spec.as_ref();
    let status = dep.status.as_ref();

    let desired = spec.and_then(|s| s.replicas).unwrap_or(0);
    let strategy = spec.and_then(|s| s.strategy.as_ref()).map(|st| {
        let ru = st.rolling_update.as_ref();
        json!({
            "type": st.type_.clone().unwrap_or_else(|| "RollingUpdate".to_owned()),
            "max_surge": ru.and_then(|r| r.max_surge.as_ref()).map(intorstring_to_string),
            "max_unavailable": ru
                .and_then(|r| r.max_unavailable.as_ref())
                .map(intorstring_to_string),
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
                        "last_transition_time": c.last_transition_time.as_ref().map(|t| t.0.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let pod_template = spec.map(|s| project_pod_template_summary(&s.template));

    json!({
        "meta": meta,
        "selector": project_label_selector(spec.map(|s| &s.selector)),
        "replicas": {
            "desired": desired,
            "ready": status.and_then(|s| s.ready_replicas).unwrap_or(0),
            "available": status.and_then(|s| s.available_replicas).unwrap_or(0),
            "updated": status.and_then(|s| s.updated_replicas).unwrap_or(0),
            "unavailable": status.and_then(|s| s.unavailable_replicas).unwrap_or(0),
            "current": status.and_then(|s| s.replicas).unwrap_or(0),
        },
        "strategy": strategy,
        "min_ready_seconds": spec.and_then(|s| s.min_ready_seconds),
        "progress_deadline_seconds": spec.and_then(|s| s.progress_deadline_seconds),
        "revision_history_limit": spec.and_then(|s| s.revision_history_limit),
        "paused": spec.and_then(|s| s.paused).unwrap_or(false),
        "observed_generation": status.and_then(|s| s.observed_generation),
        "conditions": conditions,
        "pod_template": pod_template,
    })
}

fn intorstring_to_string(v: &k8s_openapi::apimachinery::pkg::util::intstr::IntOrString) -> String {
    match v {
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
    }
}
