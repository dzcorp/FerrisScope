use k8s_openapi::api::autoscaling::v2::{
    CrossVersionObjectReference, HorizontalPodAutoscaler, MetricSpec, MetricStatus, MetricTarget,
    MetricValueStatus,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
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
                    id: "targets",
                    header: "Targets",
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
        // k8s-openapi 0.28 made `HorizontalPodAutoscaler.spec` non-optional; keep
        // the downstream Option-chaining intact by re-wrapping.
        let spec = Some(&hpa.spec);
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
        let targets = metric_rows(hpa)
            .iter()
            .map(|m| {
                format!(
                    "{}: {}/{}",
                    m.label,
                    m.current_display.as_deref().unwrap_or("<unknown>"),
                    m.target_display
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "namespace": meta.namespace.clone(),
            "reference": reference,
            "targets": targets,
            "min_replicas": min_replicas,
            "max_replicas": max_replicas,
            "current_replicas": current_replicas,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(hpa: &HorizontalPodAutoscaler) -> Value {
    let meta = project_meta(&hpa.metadata);
    // k8s-openapi 0.28 made `HorizontalPodAutoscaler.spec` non-optional; keep
    // the downstream Option-chaining intact by re-wrapping.
    let spec = Some(&hpa.spec);
    let status = hpa.status.as_ref();

    let scale_target = spec.map(|s| {
        json!({
            "api_version": s.scale_target_ref.api_version.clone(),
            "kind": s.scale_target_ref.kind.clone(),
            "name": s.scale_target_ref.name.clone(),
        })
    });

    let metrics: Vec<Value> = metric_rows(hpa)
        .into_iter()
        .map(|m| {
            json!({
                "type": m.type_,
                "name": m.label,
                "target": {
                    "type": m.target.type_.clone(),
                    "average_utilization": m.target.average_utilization,
                    "average_value": m.target.average_value.as_ref().map(|q| q.0.clone()),
                    "value": m.target.value.as_ref().map(|q| q.0.clone()),
                },
                "current": m.current.map(|c| json!({
                    "average_utilization": c.average_utilization,
                    "average_value": c.average_value.as_ref().map(|q| q.0.clone()),
                    "value": c.value.as_ref().map(|q| q.0.clone()),
                })),
                "target_display": m.target_display,
                "current_display": m.current_display,
                "ratio": m.ratio,
            })
        })
        .collect();

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
        "scaling": scaling_state(hpa),
    })
}

/// Headline state from the controller's conditions, most severe first. Words
/// map onto the UI's status buckets.
fn scaling_state(hpa: &HorizontalPodAutoscaler) -> Value {
    let status = hpa.status.as_ref();
    let conds = status
        .and_then(|s| s.conditions.as_deref())
        .unwrap_or_default();
    let find = |ty: &str, st: &str| conds.iter().find(|c| c.type_ == ty && c.status == st);
    let current = status.and_then(|s| s.current_replicas);
    let desired = status.map(|s| s.desired_replicas);
    let (word, cond) = if let Some(c) = find("ScalingActive", "False") {
        ("Inactive", Some(c))
    } else if let Some(c) = find("AbleToScale", "False") {
        ("Failed", Some(c))
    } else if current.is_some() && desired.is_some() && current != desired {
        ("Scaling", find("AbleToScale", "True"))
    } else if let Some(c) = find("ScalingLimited", "True") {
        ("Limited", Some(c))
    } else if let Some(c) = find("ScalingActive", "True") {
        ("Active", Some(c))
    } else {
        ("Unknown", None)
    };
    json!({
        "status": word,
        "reason": cond.and_then(|c| c.reason.clone()),
        "message": cond.and_then(|c| c.message.clone()),
    })
}

/// One spec metric joined with the controller's last observation of it.
struct MetricRow<'a> {
    type_: &'a str,
    label: String,
    target: &'a MetricTarget,
    current: Option<&'a MetricValueStatus>,
    target_display: String,
    current_display: Option<String>,
    /// current / target; > 1 means the HPA wants to scale up.
    ratio: Option<f64>,
}

fn object_label(obj: &CrossVersionObjectReference, metric: &str) -> String {
    format!("{}/{} {metric}", obj.kind, obj.name)
}

fn spec_parts(m: &MetricSpec) -> Option<(String, &MetricTarget)> {
    match m.type_.as_str() {
        "Resource" => m.resource.as_ref().map(|r| (r.name.clone(), &r.target)),
        "ContainerResource" => m
            .container_resource
            .as_ref()
            .map(|r| (format!("{}/{}", r.container, r.name), &r.target)),
        "Pods" => m.pods.as_ref().map(|p| (p.metric.name.clone(), &p.target)),
        "Object" => m
            .object
            .as_ref()
            .map(|o| (object_label(&o.described_object, &o.metric.name), &o.target)),
        "External" => m
            .external
            .as_ref()
            .map(|e| (e.metric.name.clone(), &e.target)),
        _ => None,
    }
}

fn status_parts(s: &MetricStatus) -> Option<(String, &MetricValueStatus)> {
    match s.type_.as_str() {
        "Resource" => s.resource.as_ref().map(|r| (r.name.clone(), &r.current)),
        "ContainerResource" => s
            .container_resource
            .as_ref()
            .map(|r| (format!("{}/{}", r.container, r.name), &r.current)),
        "Pods" => s.pods.as_ref().map(|p| (p.metric.name.clone(), &p.current)),
        "Object" => s.object.as_ref().map(|o| {
            (
                object_label(&o.described_object, &o.metric.name),
                &o.current,
            )
        }),
        "External" => s
            .external
            .as_ref()
            .map(|e| (e.metric.name.clone(), &e.current)),
        _ => None,
    }
}

/// Target and current rendered in the unit the target is expressed in, as
/// `kubectl get hpa` does; `ratio` is `None` when either side is missing,
/// unparseable, or the target is zero.
fn measure(
    target: &MetricTarget,
    current: Option<&MetricValueStatus>,
) -> (String, Option<String>, Option<f64>) {
    fn ratio(cur: f64, tgt: f64) -> Option<f64> {
        (tgt > 0.0 && cur.is_finite()).then(|| (cur / tgt * 1000.0).round() / 1000.0)
    }
    fn quantity(q: &str) -> Option<f64> {
        ferrisscope_core::quantity::parse_quantity(q)
    }
    match target.type_.as_str() {
        "Utilization" => {
            let tgt = target.average_utilization;
            let cur = current.and_then(|c| c.average_utilization);
            (
                tgt.map_or_else(|| "<unset>".into(), |v| format!("{v}%")),
                cur.map(|v| format!("{v}%")),
                cur.zip(tgt)
                    .and_then(|(c, t)| ratio(f64::from(c), f64::from(t))),
            )
        }
        kind => {
            fn pick<'q>(
                avg: bool,
                a: Option<&'q Quantity>,
                v: Option<&'q Quantity>,
            ) -> Option<&'q str> {
                if avg { a } else { v }.map(|q| q.0.as_str())
            }
            let avg = kind == "AverageValue";
            let tgt = pick(avg, target.average_value.as_ref(), target.value.as_ref());
            let cur = current.and_then(|c| pick(avg, c.average_value.as_ref(), c.value.as_ref()));
            let r = cur
                .and_then(quantity)
                .zip(tgt.and_then(quantity))
                .and_then(|(c, t)| ratio(c, t));
            (
                tgt.map_or_else(|| "<unset>".into(), str::to_owned),
                cur.map(str::to_owned),
                r,
            )
        }
    }
}

/// Spec metrics joined to `status.currentMetrics` by (type, identity) rather
/// than index: the controller leaves zero-valued entries for metrics it
/// failed to fetch, and older controllers omit them outright.
fn metric_rows(hpa: &HorizontalPodAutoscaler) -> Vec<MetricRow<'_>> {
    let statuses: Vec<(&str, String, &MetricValueStatus)> = hpa
        .status
        .as_ref()
        .and_then(|s| s.current_metrics.as_deref())
        .unwrap_or_default()
        .iter()
        .filter_map(|s| status_parts(s).map(|(l, c)| (s.type_.as_str(), l, c)))
        .collect();
    hpa.spec
        .metrics
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let (label, target) = spec_parts(m)?;
            let current = statuses
                .iter()
                .find(|(t, l, _)| *t == m.type_ && *l == label)
                .map(|(_, _, c)| *c);
            let (target_display, current_display, ratio) = measure(target, current);
            Some(MetricRow {
                type_: m.type_.as_str(),
                label,
                target,
                current,
                target_display,
                current_display,
                ratio,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hpa(metrics: Value, current: Value) -> HorizontalPodAutoscaler {
        serde_json::from_value(json!({
            "metadata": { "name": "web", "namespace": "default" },
            "spec": {
                "scaleTargetRef": { "kind": "Deployment", "name": "web" },
                "maxReplicas": 10,
                "metrics": metrics,
            },
            "status": { "desiredReplicas": 1, "currentMetrics": current },
        }))
        .expect("valid hpa")
    }

    #[test]
    fn joins_current_by_identity_not_index() {
        let h = hpa(
            json!([
                { "type": "Resource", "resource": { "name": "cpu", "target": { "type": "Utilization", "averageUtilization": 80 } } },
                { "type": "Resource", "resource": { "name": "memory", "target": { "type": "AverageValue", "averageValue": "512Mi" } } },
            ]),
            json!([
                { "type": "Resource", "resource": { "name": "memory", "current": { "averageValue": "256Mi" } } },
                { "type": "Resource", "resource": { "name": "cpu", "current": { "averageUtilization": 120 } } },
            ]),
        );
        let rows = metric_rows(&h);
        assert_eq!(rows[0].current_display.as_deref(), Some("120%"));
        assert_eq!(rows[0].ratio, Some(1.5));
        assert_eq!(rows[1].current_display.as_deref(), Some("256Mi"));
        assert_eq!(rows[1].ratio, Some(0.5));
        assert_eq!(
            HorizontalPodAutoscalerSpec::project(&h)["targets"],
            "cpu: 120%/80%, memory: 256Mi/512Mi"
        );
    }

    #[test]
    fn missing_current_is_unknown() {
        let h = hpa(
            json!([{ "type": "Resource", "resource": { "name": "cpu", "target": { "type": "Utilization", "averageUtilization": 80 } } }]),
            json!([{ "type": "" }]),
        );
        let rows = metric_rows(&h);
        assert_eq!(rows[0].current_display, None);
        assert_eq!(rows[0].ratio, None);
        assert_eq!(
            HorizontalPodAutoscalerSpec::project(&h)["targets"],
            "cpu: <unknown>/80%"
        );
    }

    #[test]
    fn covers_every_source_type() {
        let h = hpa(
            json!([
                { "type": "ContainerResource", "containerResource": { "container": "app", "name": "cpu", "target": { "type": "Utilization", "averageUtilization": 50 } } },
                { "type": "Pods", "pods": { "metric": { "name": "rps" }, "target": { "type": "AverageValue", "averageValue": "100" } } },
                { "type": "Object", "object": { "describedObject": { "kind": "Ingress", "name": "main" }, "metric": { "name": "hits" }, "target": { "type": "Value", "value": "2k" } } },
                { "type": "External", "external": { "metric": { "name": "queue" }, "target": { "type": "Value", "value": "0" } } },
            ]),
            json!([
                { "type": "ContainerResource", "containerResource": { "container": "app", "name": "cpu", "current": { "averageUtilization": 25 } } },
                { "type": "Pods", "pods": { "metric": { "name": "rps" }, "current": { "averageValue": "150" } } },
                { "type": "Object", "object": { "describedObject": { "kind": "Ingress", "name": "main" }, "metric": { "name": "hits" }, "current": { "value": "500" } } },
                { "type": "External", "external": { "metric": { "name": "queue" }, "current": { "value": "7" } } },
            ]),
        );
        let got: Vec<_> = metric_rows(&h)
            .iter()
            .map(|m| (m.label.clone(), m.current_display.clone(), m.ratio))
            .collect();
        assert_eq!(
            got,
            vec![
                ("app/cpu".into(), Some("25%".into()), Some(0.5)),
                ("rps".into(), Some("150".into()), Some(1.5)),
                ("Ingress/main hits".into(), Some("500".into()), Some(0.25)),
                // Zero target: no meaningful ratio.
                ("queue".into(), Some("7".into()), None),
            ]
        );
    }

    fn with_status(status: Value) -> HorizontalPodAutoscaler {
        serde_json::from_value(json!({
            "metadata": { "name": "web" },
            "spec": { "scaleTargetRef": { "kind": "Deployment", "name": "web" }, "maxReplicas": 10 },
            "status": status,
        }))
        .expect("valid hpa")
    }

    fn cond(ty: &str, st: &str, reason: &str) -> Value {
        json!({ "type": ty, "status": st, "reason": reason, "message": reason })
    }

    #[test]
    fn scaling_state_precedence() {
        let cases = [
            (json!({ "desiredReplicas": 1 }), "Unknown"),
            (
                json!({ "currentReplicas": 3, "desiredReplicas": 3, "conditions": [
                    cond("AbleToScale", "True", "ReadyForNewScale"),
                    cond("ScalingActive", "True", "ValidMetricFound"),
                ]}),
                "Active",
            ),
            (
                json!({ "currentReplicas": 10, "desiredReplicas": 10, "conditions": [
                    cond("ScalingActive", "True", "ValidMetricFound"),
                    cond("ScalingLimited", "True", "TooManyReplicas"),
                ]}),
                "Limited",
            ),
            (
                json!({ "currentReplicas": 3, "desiredReplicas": 6, "conditions": [
                    cond("AbleToScale", "True", "SucceededRescale"),
                    cond("ScalingLimited", "True", "TooManyReplicas"),
                ]}),
                "Scaling",
            ),
            (
                json!({ "currentReplicas": 3, "desiredReplicas": 6, "conditions": [
                    cond("AbleToScale", "False", "FailedGetScale"),
                ]}),
                "Failed",
            ),
            (
                json!({ "currentReplicas": 3, "desiredReplicas": 3, "conditions": [
                    cond("AbleToScale", "False", "FailedGetScale"),
                    cond("ScalingActive", "False", "FailedGetResourceMetric"),
                ]}),
                "Inactive",
            ),
        ];
        for (status, want) in cases {
            let got = scaling_state(&with_status(status));
            assert_eq!(got["status"], want, "{got}");
        }
        let got = scaling_state(&with_status(
            json!({ "currentReplicas": 1, "desiredReplicas": 1, "conditions": [
                cond("ScalingActive", "False", "FailedGetResourceMetric"),
            ]}),
        ));
        assert_eq!(got["reason"], "FailedGetResourceMetric");
    }

    #[test]
    fn no_metrics_projects_empty() {
        let h = hpa(Value::Null, Value::Null);
        assert!(metric_rows(&h).is_empty());
        assert_eq!(HorizontalPodAutoscalerSpec::project(&h)["targets"], "");
    }
}
