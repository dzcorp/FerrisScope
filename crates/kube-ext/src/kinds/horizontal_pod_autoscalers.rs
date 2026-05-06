use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct HorizontalPodAutoscalerSpec;

impl KindSpec for HorizontalPodAutoscalerSpec {
    type K = HorizontalPodAutoscaler;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "horizontalpodautoscalers",
            group: "autoscaling",
            version: "v2",
            kind: "HorizontalPodAutoscaler",
            plural: "horizontalpodautoscalers",
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
                    id: "reference",
                    header: "Reference",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "min_replicas",
                    header: "Min",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "max_replicas",
                    header: "Max",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "current_replicas",
                    header: "Replicas",
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

    fn project(hpa: &HorizontalPodAutoscaler) -> Value {
        let meta = &hpa.metadata;
        let spec = hpa.spec.as_ref();
        let status = hpa.status.as_ref();

        let reference = spec
            .map(|s| {
                let kind = s.scale_target_ref.kind.clone();
                let name = s.scale_target_ref.name.clone();
                format!("{kind}/{name}")
            })
            .unwrap_or_default();
        let min_replicas = spec.and_then(|s| s.min_replicas).unwrap_or(0);
        let max_replicas = spec.map(|s| s.max_replicas).unwrap_or(0);
        let current_replicas = status.map(|s| s.current_replicas.unwrap_or(0)).unwrap_or(0);

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "namespace": meta.namespace.clone(),
            "reference": reference,
            "min_replicas": min_replicas,
            "max_replicas": max_replicas,
            "current_replicas": current_replicas,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(hpa: &HorizontalPodAutoscaler) -> Value {
    let meta = project_meta(&hpa.metadata);
    let spec = hpa.spec.as_ref();
    let status = hpa.status.as_ref();

    let scale_target = spec.map(|s| {
        json!({
            "api_version": s.scale_target_ref.api_version.clone(),
            "kind": s.scale_target_ref.kind.clone(),
            "name": s.scale_target_ref.name.clone(),
        })
    });

    let metrics: Vec<Value> = spec
        .and_then(|s| s.metrics.as_ref())
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    let mut entry = serde_json::Map::new();
                    entry.insert("type".into(), Value::String(m.type_.clone()));
                    if let Some(r) = m.resource.as_ref() {
                        entry.insert("name".into(), Value::String(r.name.clone()));
                        entry.insert(
                            "target".into(),
                            json!({
                                "type": r.target.type_.clone(),
                                "average_utilization": r.target.average_utilization,
                                "average_value": r.target.average_value.as_ref().map(|q| q.0.clone()),
                                "value": r.target.value.as_ref().map(|q| q.0.clone()),
                            }),
                        );
                    }
                    if let Some(p) = m.pods.as_ref() {
                        entry.insert("metric_name".into(), Value::String(p.metric.name.clone()));
                    }
                    if let Some(ext) = m.external.as_ref() {
                        entry.insert("metric_name".into(), Value::String(ext.metric.name.clone()));
                    }
                    Value::Object(entry)
                })
                .collect()
        })
        .unwrap_or_default();

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

    json!({
        "meta": meta,
        "scale_target_ref": scale_target,
        "min_replicas": spec.and_then(|s| s.min_replicas),
        "max_replicas": spec.map(|s| s.max_replicas).unwrap_or(0),
        "current_replicas": status.and_then(|s| s.current_replicas),
        "desired_replicas": status.map(|s| s.desired_replicas),
        "last_scale_time": status
            .and_then(|s| s.last_scale_time.as_ref())
            .map(|t| t.0.to_string()),
        "metrics": metrics,
        "conditions": conditions,
    })
}
