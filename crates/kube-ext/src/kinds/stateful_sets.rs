use k8s_openapi::api::apps::v1::StatefulSet;
use serde_json::{json, Value};

use crate::kinds::pod_template::{
    project_label_selector, project_meta, project_pod_template_summary,
};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct StatefulSetSpec;

impl KindSpec for StatefulSetSpec {
    type K = StatefulSet;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "statefulsets",
            group: "apps",
            version: "v1",
            kind: "StatefulSet",
            plural: "statefulsets",
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
                    id: "service",
                    header: "Service",
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

    fn project(ss: &StatefulSet) -> Value {
        let meta = &ss.metadata;
        let spec = ss.spec.as_ref();
        let status = ss.status.as_ref();
        let desired = spec.and_then(|s| s.replicas).unwrap_or(0);
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
        let service = spec.map(|s| s.service_name.clone()).unwrap_or_default();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "ready": format!("{ready}/{desired}"),
            "service": service,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(ss: &StatefulSet) -> Value {
    let meta = project_meta(&ss.metadata);
    let spec = ss.spec.as_ref();
    let status = ss.status.as_ref();

    let strategy = spec.and_then(|s| s.update_strategy.as_ref()).map(|st| {
        let ru = st.rolling_update.as_ref();
        json!({
            "type": st.type_.clone().unwrap_or_else(|| "RollingUpdate".to_owned()),
            "partition": ru.and_then(|r| r.partition),
            "max_unavailable": ru
                .and_then(|r| r.max_unavailable.as_ref())
                .map(|v| match v {
                    k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
                    k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
                }),
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

    // Compact summary of volumeClaimTemplates: name + storage request + access
    // modes. Operators read this when wondering "how big are my PVCs going to
    // be" — full PVC inspection lives in the actual PVC's detail panel.
    let volume_claim_templates: Vec<Value> = spec
        .and_then(|s| s.volume_claim_templates.as_ref())
        .map(|vcts| {
            vcts.iter()
                .map(|p| {
                    let pvc_spec = p.spec.as_ref();
                    let storage = pvc_spec
                        .and_then(|sp| sp.resources.as_ref())
                        .and_then(|r| r.requests.as_ref())
                        .and_then(|m| m.get("storage").map(|q| q.0.clone()));
                    let access_modes = pvc_spec
                        .and_then(|sp| sp.access_modes.clone())
                        .unwrap_or_default();
                    let storage_class = pvc_spec.and_then(|sp| sp.storage_class_name.clone());
                    json!({
                        "name": p.metadata.name.clone().unwrap_or_default(),
                        "storage": storage,
                        "access_modes": access_modes,
                        "storage_class": storage_class,
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
            "desired": spec.and_then(|s| s.replicas).unwrap_or(0),
            "ready": status.and_then(|s| s.ready_replicas).unwrap_or(0),
            "available": status.and_then(|s| s.available_replicas).unwrap_or(0),
            "current": status.and_then(|s| s.current_replicas).unwrap_or(0),
            "updated": status.and_then(|s| s.updated_replicas).unwrap_or(0),
        },
        "service_name": spec.map(|s| s.service_name.clone()),
        "pod_management_policy": spec.and_then(|s| s.pod_management_policy.clone()),
        "update_strategy": strategy,
        "revision_history_limit": spec.and_then(|s| s.revision_history_limit),
        "min_ready_seconds": spec.and_then(|s| s.min_ready_seconds),
        "current_revision": status.and_then(|s| s.current_revision.clone()),
        "update_revision": status.and_then(|s| s.update_revision.clone()),
        "observed_generation": status.and_then(|s| s.observed_generation),
        "conditions": conditions,
        "volume_claim_templates": volume_claim_templates,
        "pod_template": pod_template,
    })
}
